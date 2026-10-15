#!/usr/bin/env python3
"""End-to-end check of the AgentCore narration path.

Exercises the one endpoint that talks to the agent runtime, and asserts the
caching contract a caller has to rely on:

    * the first request for a `(session, kind)` pair generates (slow, uncached);
    * the second returns the same text from cache (fast);
    * `summary` is a different cache entry from `choice`, not a cache hit;
    * `choice` is refused before any choice has been made.

    python3 scripts/narration-check.py <api-base-url> [--profile P]

Exits non-zero if any check fails. Prints one line per check.

The first uncached call starts an AgentCore Runtime microVM and waits on a model
generation — measured at roughly 10 seconds, and longer on a cold start. The
per-request timeout here is therefore far above the API's own 30s integration
budget: a request that exceeds that budget returns 504 rather than hanging, and
the check should report that as a failure, not as a client-side timeout.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# Colour only to a real terminal, and never when NO_COLOR is set. Markers stay
# ASCII: many terminal fonts have no glyph for dingbats and box-drawing
# characters, so they render as mojibake and make a passing test look broken.
_COLOUR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
GREEN = "\033[32m" if _COLOUR else ""
RED = "\033[31m" if _COLOUR else ""
RESET = "\033[0m" if _COLOUR else ""

REQUEST_TIMEOUT_SECONDS = 75

results: list[tuple[str, bool, str]] = []


def check(label: str, passed: bool, detail: str = "") -> bool:
    results.append((label, passed, detail))
    mark = f"{GREEN}[ OK ]{RESET}" if passed else f"{RED}[FAIL]{RESET}"
    print(f"  {mark} {label:<44}{'' if passed else '  ' + detail}")
    return passed


def call(api: str, method: str, path: str, body: dict | None = None):
    """Return (status, parsed-body, elapsed-seconds)."""
    req = urllib.request.Request(
        api + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"} if body is not None else {},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return response.status, json.load(response), time.monotonic() - started
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw), time.monotonic() - started
        except Exception:
            return err.code, {"raw": raw}, time.monotonic() - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("api", help="API base URL, e.g. https://abc.execute-api.us-east-1.amazonaws.com")
    parser.add_argument("--profile", default="cancercare-game-mvp", help="accepted for symmetry with the smoke script")
    args = parser.parse_args()
    api = args.api.rstrip("/") + "/api/v1"

    status, player, _ = call(api, "POST", "/players", {"nickname": "叙事检查"})
    if status != 201:
        check("POST /players -> 201", False, f"{status} {player}")
        report()
        return 1
    player_id = player["playerId"]

    status, session, _ = call(api, "POST", "/sessions", {"playerId": player_id})
    if status != 201:
        check("POST /sessions -> 201", False, f"{status} {session}")
        report()
        return 1
    session_id = session["sessionId"]

    # --- choice narration before any choice is made ---------------------------

    status, body, _ = call(api, "POST", f"/sessions/{session_id}/narration", {"kind": "choice"})
    check(
        "未作答时请求 choice 点评 -> 409",
        status == 409,
        f"{status} {json.dumps(body, ensure_ascii=False)[:120]}",
    )

    # --- answer one event -----------------------------------------------------

    active = session.get("activeEvent") or {}
    status, _, _ = call(
        api,
        "POST",
        f"/sessions/{session_id}/choices",
        {"eventId": active["eventId"], "choiceId": active["choices"][0]["id"]},
    )
    check("先作答一个事件（作为点评的输入）", status == 200, str(status))

    # --- first (uncached) generation ------------------------------------------

    status, first, elapsed = call(
        api, "POST", f"/sessions/{session_id}/narration", {"kind": "choice"}
    )
    check("首次 choice 点评 -> 200", status == 200, f"{status} {json.dumps(first, ensure_ascii=False)[:160]}")
    if status != 200:
        report()
        return 1

    check("首次未命中缓存", first.get("cached") is False, str(first.get("cached")))
    check("返回了非空文本", isinstance(first.get("text"), str) and len(first["text"]) > 0,
          f"{len(first.get('text') or '')} 字")
    check("报告了 provider", bool(first.get("provider")), str(first.get("provider")))
    check("报告了 modelId", bool(first.get("modelId")), str(first.get("modelId")))
    check("degraded 是布尔值", isinstance(first.get("degraded"), bool), str(first.get("degraded")))
    # The content guard substitutes a generic text when the model goes out of
    # bounds. That is a *successful* outcome for this endpoint, so the check is
    # that the flag is present and the text is still usable — not that the model
    # behaved. Asserting `degraded is False` would make the suite flaky on a
    # model that occasionally phrases something as a recommendation.
    check("首次生成耗时在合理区间", 0.5 < elapsed < REQUEST_TIMEOUT_SECONDS, f"{elapsed:.1f}s")
    print(f"       首次耗时 {elapsed:.1f}s；开头：{first['text'][:60]}")

    # --- second call is served from cache -------------------------------------

    status, second, cached_elapsed = call(
        api, "POST", f"/sessions/{session_id}/narration", {"kind": "choice"}
    )
    check("二次 choice 点评 -> 200", status == 200, str(status))
    check("二次命中缓存", second.get("cached") is True, str(second.get("cached")))
    check("缓存返回同一段文本", second.get("text") == first.get("text"))
    check("缓存返回同一 generatedAt", second.get("generatedAt") == first.get("generatedAt"))
    check("命中缓存明显更快", cached_elapsed < elapsed, f"{cached_elapsed:.2f}s vs {elapsed:.1f}s")
    print(f"       缓存耗时 {cached_elapsed:.2f}s")

    # --- summary is a separate cache entry ------------------------------------

    status, summary, _ = call(
        api, "POST", f"/sessions/{session_id}/narration", {"kind": "summary"}
    )
    check("summary 点评 -> 200", status == 200, str(status))
    check("summary 与 choice 是不同缓存条目", summary.get("cached") is False, str(summary.get("cached")))
    check("summary 文本与 choice 不同", summary.get("text") != first.get("text"))

    # --- unknown kind is rejected ---------------------------------------------

    status, _, _ = call(api, "POST", f"/sessions/{session_id}/narration", {"kind": "essay"})
    check("非法 kind -> 400", status == 400, str(status))

    return report()


def report() -> int:
    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"NARRATION_RESULT pass={passed} fail={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
