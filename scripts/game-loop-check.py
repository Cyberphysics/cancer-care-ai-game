#!/usr/bin/env python3
"""End-to-end check of the deployed game loop.

Exercises the API the way a client would, then inspects the items the API wrote
to confirm the storage layer did what the response claimed.

    python3 scripts/game-loop-check.py <api-base-url> [--profile P] [--full]

Exits non-zero if any check fails. Prints one line per check.
"""

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request

GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"

results: list[tuple[str, bool, str]] = []


def check(label: str, passed: bool, detail: str = "") -> bool:
    results.append((label, passed, detail))
    mark = f"{GREEN}✓{RESET}" if passed else f"{RED}✗{RESET}"
    print(f"  {mark} {label:<46}{'' if passed else '  ' + detail}")
    return passed


def call(api: str, method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        api + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw)
        except Exception:
            return err.code, {"raw": raw}


def aws_json(profile: str, *args: str):
    """Run the AWS CLI and parse its JSON output."""
    completed = subprocess.run(
        ["aws", *args, "--profile", profile, "--output", "json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return json.loads(completed.stdout or "null")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("api", help="API base URL, e.g. https://x.execute-api.us-east-1.amazonaws.com")
    parser.add_argument("--profile", default="cancercare-game-mvp")
    parser.add_argument("--full", action="store_true", help="play a session to completion")
    args = parser.parse_args()

    api = args.api.rstrip("/") + "/api/v1"

    # --- health ------------------------------------------------------------
    status, health = call(api, "GET", "/health")
    check("GET /health → 200", status == 200, str(status))
    table = health.get("tableName", "")
    check("health 报告 event catalog", health.get("catalogEvents", 0) >= 5,
          str(health.get("catalogEvents")))

    # --- players -----------------------------------------------------------
    status, player = call(api, "POST", "/players", {"nickname": "冒烟测试守护者"})
    check("POST /players → 201", status == 201, str(status))
    player_id = player.get("playerId", "")
    check("响应含 playerId", bool(player_id))

    status, fetched = call(api, "GET", f"/players/{player_id}")
    check("GET /players/{id} → 200", status == 200, str(status))
    check("昵称往返一致", fetched.get("nickname") == "冒烟测试守护者",
          repr(fetched.get("nickname")))

    status, _ = call(api, "GET", "/players/plr_does_not_exist")
    check("未知玩家 → 404", status == 404, str(status))

    # --- session -----------------------------------------------------------
    status, session = call(api, "POST", "/sessions", {"playerId": player_id})
    check("POST /sessions → 201", status == 201, str(status))
    session_id = session.get("sessionId", "")
    event = session.get("activeEvent") or {}

    check("会话起始于 prevention", session.get("currentStage") == "prevention",
          str(session.get("currentStage")))
    check("会话带首个事件", bool(event.get("title")))
    # 未作答的事件绝不能把影响值发给客户端，否则等于泄露答案。
    check("未作答事件不泄露 impact/score",
          "impact" not in event and "score" not in event)
    check("选项文本可见", len(event.get("choices", [])) >= 2)

    # --- submit a choice ---------------------------------------------------
    choice_id = event["choices"][0]["id"]
    status, result = call(api, "POST", f"/sessions/{session_id}/choices",
                          {"eventId": event.get("eventId"), "choiceId": choice_id})
    check("POST /choices → 200", status == 200, str(status))
    check("返回 impact 与 rationale",
          bool(result.get("appliedImpact")) and bool(result.get("rationale")))
    check("健康值限制在 0-100",
          all(0 <= v <= 100 for v in (result.get("health") or {}).values()))
    # 第一个事件之后阶段内应仍有事件（预防阶段有多个事件）。
    check("首答后未跳过整个阶段",
          result.get("awaitingAdvance") is False or result.get("nextEvent") is not None,
          f"awaitingAdvance={result.get('awaitingAdvance')}")

    # --- idempotency / optimistic locking ----------------------------------
    status, _ = call(api, "POST", f"/sessions/{session_id}/choices",
                     {"eventId": event.get("eventId"), "choiceId": choice_id})
    check("重复提交同一选择 → 409（幂等保护）", status == 409, str(status))

    status, _ = call(api, "POST", f"/sessions/{session_id}/choices",
                     {"eventId": "evt_stale", "choiceId": choice_id})
    check("过期 eventId → 409", status == 409, str(status))

    if not result.get("awaitingAdvance"):
        status, _ = call(api, "POST", f"/sessions/{session_id}/advance")
        check("事件未答完时推进 → 409（阶段边界受保护）", status == 409, str(status))

    # --- timeline ----------------------------------------------------------
    status, events = call(api, "GET", f"/sessions/{session_id}/events")
    check("GET /events → 200", status == 200, str(status))
    check("时间线含已作答事件",
          any(e.get("chosenChoiceId") for e in events.get("events", [])))

    # --- storage-level assertions -----------------------------------------
    # 稀疏索引的写入正确性无法由 synth 或类型系统保证，只能查真实条目。
    if table and player_id:
        item = aws_json(args.profile, "dynamodb", "get-item", "--table-name", table,
                        "--key", json.dumps({"PK": {"S": f"PLAYER#{player_id}"},
                                             "SK": {"S": "PROFILE"}}))
        attrs = (item or {}).get("Item", {})
        check("Player 条目落库", bool(attrs))
        check("Player 条目不含 GSI1 属性（稀疏索引）",
              not any(k.startswith("GSI1") for k in attrs), str(sorted(attrs)))
        check("Player 条目写入 expiresAt（TTL 生效）", "expiresAt" in attrs)

    if table and session_id:
        item = aws_json(args.profile, "dynamodb", "get-item", "--table-name", table,
                        "--key", json.dumps({"PK": {"S": f"SESSION#{session_id}"},
                                             "SK": {"S": "META"}}))
        attrs = (item or {}).get("Item", {})
        check("GameSession 条目带 GSI1PK/GSI1SK",
              "GSI1PK" in attrs and "GSI1SK" in attrs)
        check("GameSession 记录 version（乐观锁）", "version" in attrs)

    # --- optional full playthrough ----------------------------------------
    if args.full:
        stages_seen: list[str] = []
        for _ in range(40):
            status, current = call(api, "GET", f"/sessions/{session_id}")
            if current.get("status") == "completed":
                break
            active = current.get("activeEvent")
            if not active:
                break
            stages_seen.append(current["currentStage"])
            status, _ = call(api, "POST", f"/sessions/{session_id}/choices",
                             {"eventId": active.get("eventId"),
                              "choiceId": active["choices"][0]["id"]})
            if status != 200:
                break
            _, after = call(api, "GET", f"/sessions/{session_id}")
            if after.get("awaitingAdvance") and after.get("status") != "completed":
                call(api, "POST", f"/sessions/{session_id}/advance")

        status, final = call(api, "GET", f"/sessions/{session_id}")
        check("完整通关：会话已完成", final.get("status") == "completed",
              str(final.get("status")))
        check("完整通关：五个阶段都走到",
              set(stages_seen) == {"prevention", "screening", "diagnosis", "treatment", "recovery"},
              str(sorted(set(stages_seen))))
        check("完整通关：所有事件均已作答",
              all(e.get("chosenChoiceId")
                  for e in call(api, "GET", f"/sessions/{session_id}/events")[1].get("events", [])))

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"GAME_LOOP_RESULT pass={passed} fail={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
