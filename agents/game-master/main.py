"""GameMaster agent — the narrative layer of CancerCare AI Game.

Runs on Amazon Bedrock AgentCore Runtime.

Scope, stated plainly: this agent generates **text**. It does not decide game
mechanics, does not mutate game state, and has no database credentials. The rule
engine in the game API owns all of that — see docs/GAME-RULES.md and
docs/ARCHITECTURE.md §5.6. If this agent is unavailable, the game is still fully
playable; only the narration is missing.

Handler contract: AgentCore Runtime serves this on 0.0.0.0:8080, receiving
`POST /invocations` and answering `GET /ping`.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp, PingStatus

from app.config import load_settings
from app.memory import recall_preferences, remember_session
from app.prompts import SYSTEM_PROMPT, build_choice_prompt, build_summary_prompt
from app.provider import ProviderError, build_provider
from app.safety import SAFE_FALLBACK, describe, find_violations

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("game-master")

app = BedrockAgentCoreApp()
settings = load_settings()

VALID_KINDS = ("choice", "summary")

#: Appended on a guard violation. Naming the specific rule the retry must avoid
#: works far better than repeating "follow the rules".
CORRECTION_TEMPLATE = """

【上一次生成违反了以下约束，必须重写】
违反项：{violations}

请重新生成，严格避免上述内容：不出现任何百分比数字、药物名称或剂量、生存期表述，
也不要有「确诊为」「您患有」这类断言句式。其余要求不变。"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _coerce_payload(payload: Any) -> dict[str, Any]:
    """Accept a dict, or a JSON string, or fail with something readable."""
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, (str, bytes)):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as err:
            raise ValueError(f"payload is not valid JSON: {err}") from err
        if isinstance(parsed, dict):
            return parsed
    raise ValueError(f"payload must be a JSON object, got {type(payload).__name__}")


def _generate(kind: str, context: dict[str, Any]) -> tuple[str, bool]:
    """Generate narration, verifying it against the content guard.

    Returns `(text, degraded)`. `degraded` is True when the model could not
    produce compliant output and the safe fallback was substituted — the caller
    surfaces this rather than passing off generic text as generated analysis.

    One corrective retry: a single guard violation is usually a phrasing slip
    that an explicit correction fixes, and one extra call is cheaper than
    degrading the whole response.
    """
    provider = build_provider(settings)
    user_prompt = (
        build_choice_prompt(context) if kind == "choice" else build_summary_prompt(context)
    )

    text = provider.complete(SYSTEM_PROMPT, user_prompt)
    violations = find_violations(text)

    if not violations:
        return text, False

    logger.warning("guard violation (attempt 1): %s", violations)
    retry_prompt = user_prompt + CORRECTION_TEMPLATE.format(violations=describe(violations))
    retried = provider.complete(SYSTEM_PROMPT, retry_prompt)
    remaining = find_violations(retried)

    if not remaining:
        return retried, False

    logger.error("guard violation persisted after retry: %s", remaining)
    return SAFE_FALLBACK, True


@app.entrypoint
def invoke(payload: Any, context: Any = None) -> dict[str, Any]:
    """Entry point for every invocation.

    Always returns a JSON-serialisable dict, including on failure. Raising would
    turn a model problem into an opaque 5xx at the caller, and the caller (the
    game API) needs to tell the player something useful.
    """
    try:
        body = _coerce_payload(payload)
    except ValueError as err:
        return {"ok": False, "error": str(err), "errorType": "BadRequest"}

    kind = body.get("kind")
    if kind not in VALID_KINDS:
        return {
            "ok": False,
            "error": f"kind must be one of {list(VALID_KINDS)}, got {kind!r}",
            "errorType": "BadRequest",
        }

    player_id = body.get("playerId") or ""
    session_id = body.get("sessionId") or ""

    # Preferences are a personalisation nicety: recalled on a best-effort basis
    # and never allowed to fail the request.
    context_payload = dict(body)
    if player_id:
        context_payload["preferences"] = recall_preferences(
            settings, player_id, query=body.get("preferenceQuery") or "这位玩家的偏好与关注点"
        )

    try:
        text, degraded = _generate(kind, context_payload)
    except ProviderError as err:
        logger.error("provider failure: %s", err)
        return {"ok": False, "error": str(err), "errorType": "ProviderError"}
    except Exception as err:  # noqa: BLE001 - the caller needs a readable answer
        logger.exception("unexpected failure")
        return {"ok": False, "error": str(err), "errorType": "InternalError"}

    if kind == "summary" and player_id and session_id and not degraded:
        remember_session(settings, player_id, session_id, text)

    return {
        "ok": True,
        "text": text,
        "kind": kind,
        "provider": settings.provider,
        "modelId": settings.model_id,
        "degraded": degraded,
        "generatedAt": _now_iso(),
    }


@app.ping
def ping() -> PingStatus:
    """Health signal.

    Must return a `PingStatus` — the runtime stores whatever this returns and
    serves it on `GET /ping`, so a dict here produces a malformed health
    response rather than an error you would notice locally. Provider
    configuration is logged at startup instead.
    """
    return PingStatus.HEALTHY


logger.info(
    "game-master starting: provider=%s model=%s memory=%s",
    settings.provider,
    settings.model_id,
    "configured" if settings.memory_configured else "absent",
)


if __name__ == "__main__":
    app.run()
