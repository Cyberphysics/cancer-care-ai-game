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
import re
from datetime import datetime, timezone
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp, PingStatus

from app.config import load_settings
from app.corpus import load_corpus, normalise
from app.memory import (
    read_knowledge_notes,
    recall_preferences,
    remember_session,
    write_knowledge_notes,
)
from app.prompts import (
    EDUCATION_SYSTEM,
    EXTRACT_SYSTEM,
    SYSTEM_PROMPT,
    build_choice_prompt,
    build_extract_prompt,
    build_question_prompt,
    build_summary_prompt,
)
from app.provider import ChatMessage, ProviderError, build_provider
from app.safety import QUESTION_FALLBACK, SAFE_FALLBACK, describe, find_violations
from app.tool_loop import AGENT_DEADLINE_SECONDS, Deadline, ToolLoopError, run_tool_loop
from app.tools import KNOWLEDGE_TOOL, NOTE_TOOL, knowledge_handlers, note_handlers

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("game-master")

app = BedrockAgentCoreApp()
settings = load_settings()

#: `choice`/`summary` are the original narration roles and use `complete`.
#: `question`/`extract` are the Stage C roles and run the tool loop.
VALID_KINDS = ("choice", "summary", "question", "extract")

#: Labels the Medical Education role is told to cite, e.g. `[S1]`.
CITATION_PATTERN = re.compile(r"\[(S\d+)\]")

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

    # Stage C roles own their own flow (tool loop, citations, Memory notes), so
    # they are dispatched before the narration path builds its context.
    if kind == "question":
        return _answer_question(body, player_id, session_id)
    if kind == "extract":
        return _extract_notes(body, player_id, session_id)

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


def _citations_from(outcome: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Split the model's citations into real ones and invented ones.

    A label the tool never returned is dropped rather than shown: an invented
    citation is a grounding failure, not a display detail.
    """
    returned: dict[str, dict[str, Any]] = {}
    for execution in outcome.executions:
        for source in execution.result.get("sources") or []:
            label = source.get("label")
            if label and label not in returned:
                returned[label] = source

    cited = list(dict.fromkeys(CITATION_PATTERN.findall(outcome.text)))
    used = [returned[label] for label in cited if label in returned]
    unknown = [label for label in cited if label not in returned]
    return used, unknown


def _answer_question(body: dict[str, Any], player_id: str, session_id: str) -> dict[str, Any]:
    """The Medical Education role: answer a player's question, grounded and cited."""
    question = str(body.get("question") or "").strip()
    if not question:
        return {"ok": False, "error": "question 不能为空", "errorType": "BadRequest"}

    stage = str(body.get("stage") or "").strip() or None

    try:
        handlers = knowledge_handlers(
            load_corpus(),
            stage,
            # The reader's contract is to return [] rather than raise, so a
            # Memory outage costs context, not the answer.
            lambda: read_knowledge_notes(settings, player_id, session_id),
        )
        outcome = run_tool_loop(
            build_provider(settings),
            EDUCATION_SYSTEM,
            [ChatMessage(role="user", content=build_question_prompt({**body, "question": question}))],
            [KNOWLEDGE_TOOL],
            handlers,
            Deadline(AGENT_DEADLINE_SECONDS),
            forced_tool=KNOWLEDGE_TOOL.name,
        )
    except ToolLoopError as err:
        # DeadlineExceeded / UngroundedAnswer / TruncatedAnswer / LoopExhausted /
        # ProviderError — reported like a narration failure, so the caller can
        # tell the player something useful. The game itself is unaffected.
        logger.warning("question failed (%s): %s", err.error_type, err)
        return {"ok": False, "error": str(err), "errorType": err.error_type}
    except Exception as err:  # noqa: BLE001 - the caller needs a readable answer
        logger.exception("unexpected failure answering a question")
        return {"ok": False, "error": str(err), "errorType": "InternalError"}

    citations, unknown = _citations_from(outcome)
    if unknown:
        logger.warning("answer cited labels the tool never returned: %s", unknown)

    violations = find_violations(outcome.text)
    if violations:
        # Degrade rather than retry: the loop's two calls *are* the budget, and
        # adding a third would break the latency reasoning the deadline rests on.
        logger.warning("answer failed the guard: %s", violations)
        return {
            "ok": True,
            "kind": "question",
            "text": QUESTION_FALLBACK,
            "citations": [],
            "degraded": True,
            "provider": settings.provider,
            "modelId": settings.model_id,
            "generatedAt": _now_iso(),
        }

    if not citations:
        # Retrieval happened but nothing was cited, so the answer is not
        # traceable. Surfaced as an empty `citations` list rather than folding it
        # into `degraded`, which means "the text you are reading is a fallback".
        logger.warning("answer carried no citation markers")

    return {
        "ok": True,
        "kind": "question",
        "text": outcome.text,
        "citations": citations,
        "degraded": False,
        "provider": settings.provider,
        "modelId": settings.model_id,
        "generatedAt": _now_iso(),
    }


def _extract_notes(body: dict[str, Any], player_id: str, session_id: str) -> dict[str, Any]:
    """The GameMaster extraction role: derive a stage's knowledge notes."""
    stage = str(body.get("stage") or "").strip()
    if not stage:
        return {"ok": False, "error": "stage 不能为空", "errorType": "BadRequest"}

    stored = 0
    on_record = {
        normalise(str(note.get("term", "")))
        for note in read_knowledge_notes(settings, player_id, session_id)
    }

    def writer(notes: list[dict[str, Any]]) -> int:
        nonlocal stored
        # Memory's create_event only appends, so a second extraction for the same
        # stage would duplicate every note. Re-running is a realistic client bug
        # (a retry after a timeout, a double tap), so dedupe by term here — that
        # is what makes the route safe to call twice, rather than intent alone.
        fresh = [
            note for note in notes if normalise(str(note.get("term", ""))) not in on_record
        ]
        written = write_knowledge_notes(settings, player_id, session_id, stage, fresh)
        stored += written
        on_record.update(normalise(str(note.get("term", ""))) for note in fresh)
        return stored

    try:
        outcome = run_tool_loop(
            build_provider(settings),
            EXTRACT_SYSTEM,
            [ChatMessage(role="user", content=build_extract_prompt(body))],
            [NOTE_TOOL],
            note_handlers(writer),
            Deadline(AGENT_DEADLINE_SECONDS),
            forced_tool=NOTE_TOOL.name,
            # A stage with nothing new in it legitimately yields no notes, unlike
            # a direct question, which must be grounded.
            require_tool_call=False,
        )
    except ToolLoopError as err:
        logger.warning("extract failed (%s): %s", err.error_type, err)
        return {"ok": False, "error": str(err), "errorType": err.error_type}
    except Exception as err:  # noqa: BLE001
        logger.exception("unexpected failure extracting knowledge notes")
        return {"ok": False, "error": str(err), "errorType": "InternalError"}

    return {
        "ok": True,
        "kind": "extract",
        "stage": stage,
        "stored": stored,
        # With no Memory configured (local dev) nothing persists. That is a
        # no-op the caller can see, not a failure.
        "memoryConfigured": settings.memory_configured,
        "text": outcome.text,
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
