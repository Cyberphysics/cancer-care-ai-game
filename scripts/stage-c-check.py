#!/usr/bin/env python3
"""End-to-end check of the Stage C agent roles, through the deployed API.

The unit tests cover the handlers and the tool loop separately, and
`tool-loop-check.py` drives the agent's entrypoint directly. **Neither covers the
HTTP layer**: route wiring, the Lambda's envelope, and the 502 semantics the game
relies on when the agent is unavailable. This does.

    python3 scripts/stage-c-check.py <api-base-url>

Exits non-zero if any check fails. Prints one line per check.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Colour only to a real terminal, and never when NO_COLOR is set. Markers stay
# ASCII: dingbats and box-drawing characters have no glyph in many terminal
# fonts and render as mojibake, which makes a passing test look broken.
_COLOUR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
GREEN = "\033[32m" if _COLOUR else ""
RED = "\033[31m" if _COLOUR else ""
RESET = "\033[0m" if _COLOUR else ""

results: list[tuple[str, bool, str]] = []


def check(label: str, passed: bool, detail: str = "") -> bool:
    results.append((label, passed, detail))
    mark = f"{GREEN}[ OK ]{RESET}" if passed else f"{RED}[FAIL]{RESET}"
    print(f"  {mark} {label:<46}{'' if passed else '  ' + detail}")
    return passed


def call(api: str, method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        api + path,
        data=data,
        method=method,
        headers={"content-type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, raw
    except Exception as err:  # noqa: BLE001 - reported as a failed check
        return 0, str(err)


def play_to_first_stage_end(api: str, session_id: str) -> tuple[str, int]:
    """Answer every event in the opening stage. Returns (stage, answered)."""
    stage = ""
    answered = 0
    for _ in range(10):
        status, current = call(api, "GET", f"/sessions/{session_id}")
        if status != 200 or not isinstance(current, dict):
            break
        stage = current.get("currentStage", stage)
        event = current.get("activeEvent")
        if not event:
            break
        status, _ = call(
            api,
            "POST",
            f"/sessions/{session_id}/choices",
            {"eventId": event["eventId"], "choiceId": event["choices"][0]["id"]},
        )
        if status != 200:
            break
        answered += 1
    return stage, answered


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("api", help="API base URL, e.g. https://abc123.execute-api.us-east-1.amazonaws.com")
    args = parser.parse_args()
    api = args.api.rstrip("/") + "/api/v1"

    print("\n== 建会话并走完第一个阶段 ==")
    status, player = call(api, "POST", "/players", {"nickname": "Stage C 检查"})
    if status != 201:
        check("POST /players -> 201", False, f"{status} {player}")
        return report()
    player_id = player["playerId"]

    status, session = call(api, "POST", "/sessions", {"playerId": player_id})
    if status != 201:
        check("POST /sessions -> 201", False, f"{status} {session}")
        return report()
    session_id = session["sessionId"]

    stage, answered = play_to_first_stage_end(api, session_id)
    check(f"第一阶段（{stage}）答完 {answered} 题", answered >= 1)
    status, _ = call(api, "POST", f"/sessions/{session_id}/advance")
    check("POST /advance -> 200", status == 200, str(status))

    print("\n== knowledge：GameMaster 沉淀笔记 ==")
    status, extract = call(api, "POST", f"/sessions/{session_id}/knowledge", {"stage": stage})
    if not check("POST /knowledge -> 200", status == 200, f"{status} {extract}"):
        return report()

    stored = extract.get("stored", 0)
    check("写入了知识笔记", stored >= 1, f"stored={stored}")
    check("memoryConfigured 为真", extract.get("memoryConfigured") is True)

    _, again = call(api, "POST", f"/sessions/{session_id}/knowledge", {"stage": stage})
    check("重复调用不再写入（幂等）", again.get("stored") == 0, f"stored={again.get('stored')}")

    status, _ = call(api, "POST", f"/sessions/{session_id}/knowledge", {"stage": "不是阶段"})
    check("非法 stage -> 400", status == 400, str(status))

    print("\n== questions：Medical Education 作答 ==")
    question = "持续咳嗽两个月，为什么值得重视？"
    status, answer = call(api, "POST", f"/sessions/{session_id}/questions", {"question": question})
    if not check("POST /questions -> 200", status == 200, f"{status} {answer}"):
        return report()

    text = answer.get("text") or ""
    citations = answer.get("citations") or []
    check("答案非空", bool(text.strip()))
    check("答案标注了出处", len(citations) >= 1, f"{len(citations)} 条")
    check("每条出处都写明了来源", all(c.get("source") for c in citations))
    check("答案未降级", answer.get("degraded") is False)

    print(f"\n  问题：{question}")
    print(f"  回答：{text}\n")
    for citation in citations:
        print(f"    [{citation['label']}] {citation['title']} -- {citation['source']}")

    status, _ = call(api, "POST", f"/sessions/{session_id}/questions", {"question": "   "})
    check("空问题 -> 400", status == 400, str(status))

    status, _ = call(api, "POST", "/sessions/ses_does_not_exist/questions", {"question": "x"})
    check("不存在的会话 -> 404", status == 404, str(status))

    return report()


def report() -> int:
    print("\n== 汇总 ==")
    failed = [label for label, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} 通过")
    for label in failed:
        print(f"  FAIL: {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
