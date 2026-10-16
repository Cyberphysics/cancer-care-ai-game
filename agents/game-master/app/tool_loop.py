"""A deliberately rigid tool loop.

Not a general ReAct loop, and that is the design rather than a shortcut. The
shape is fixed at two model calls: the first is *forced* onto a named tool, the
second is forced off tools so it must answer in text.

Why fixed:

- Forcing a named tool removes two failure modes outright — "the model never
  calls a tool" and "the model answers from memory without grounding".
- A bounded number of calls is what makes the latency budget provable. The chain
  above this process is API Gateway (~30 s, hard) > game API Lambda (29 s), so
  the agent has to finish on a known schedule.

Measured 2026-10-16 (direct to DeepSeek, see the plan's P0 section):

- A named `tool_choice` **is** honoured, which is what makes the fixed shape
  work. If it were not, the first call would return text and we would fail with
  `UngroundedAnswer` rather than quietly serve an uncited medical answer.
- `parallel_tool_calls: false` is **ignored** — two calls routinely come back in
  one turn. So multiple calls per turn is the normal case here, not an edge
  case, and every call id must be answered or the next request is rejected.
- A model call takes 1-4 s, so two calls are nowhere near the budget. The
  deadline below exists mainly to absorb a Runtime cold start.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from .provider import ChatMessage, ModelProvider, ProviderError, ToolCall, ToolSpec

logger = logging.getLogger("game-master.tool-loop")

#: Total wall-clock budget for the whole loop. Sits under the game API Lambda's
#: 29 s, which in turn sits under API Gateway's 30 s hard cap.
AGENT_DEADLINE_SECONDS = 24.0
#: Never start a model call with less than this left — a call that cannot finish
#: is worse than an honest deadline error.
MIN_CALL_SECONDS = 6.0
#: Per-call ceiling handed to the provider.
CALL_TIMEOUT_CEILING = 12.0
#: Executed per turn. The remainder still get a result — an unanswered call id
#: makes the next request fail outright.
MAX_TOOL_CALLS_PER_TURN = 2
#: One decision call plus one answer call.
MAX_MODEL_CALLS = 2


class ToolLoopError(Exception):
    """A loop failure the caller must surface rather than paper over.

    `error_type` is what the game API maps to a 502, mirroring how narration
    failures are reported.
    """

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type


class Deadline:
    """A wall-clock budget.

    Enforced here rather than left to the provider because `urllib`'s timeout
    bounds socket inactivity, not total duration — a trickling response can run
    past it. The clock is injectable so tests never sleep.
    """

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._seconds = seconds
        self._clock = clock
        self._started_at = clock()

    def remaining(self) -> float:
        return self._seconds - (self._clock() - self._started_at)


@dataclass(frozen=True)
class ToolExecution:
    """One tool call and whatever it produced (or failed with)."""

    call: ToolCall
    result: dict[str, Any]

    @property
    def failed(self) -> bool:
        return "error" in self.result


@dataclass(frozen=True)
class LoopOutcome:
    text: str
    executions: tuple[ToolExecution, ...]
    model_calls: int


def _unknown_tool_result(name: str, known: Sequence[str]) -> dict[str, Any]:
    available = "、".join(known) if known else "（无）"
    return {
        "error": "unknown_tool",
        "message": f'工具 "{name}" 不存在。可用工具：{available}。',
    }


def _malformed_arguments(call: ToolCall) -> str | None:
    """Detect arguments the model emitted as invalid JSON.

    Exact rather than heuristic: the provider keeps the raw text, so re-parsing
    it here distinguishes "malformed" from a legitimate empty argument object.
    Repair is deliberately not attempted — a silently fixed medical query is
    worse than a retry.
    """
    raw = call.raw_arguments.strip()
    if not raw:
        return None
    try:
        json.loads(raw)
    except json.JSONDecodeError:
        return '参数不是合法 JSON。请用合法 JSON 对象重新调用，例如 {"question": "..."}。'
    return None


def _dedupe_key(call: ToolCall) -> tuple[str, str]:
    try:
        canonical = json.dumps(call.arguments, sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        canonical = call.raw_arguments
    return (call.name, canonical)


def _with_ids(calls: Sequence[ToolCall]) -> tuple[ToolCall, ...]:
    """Guarantee every call carries an id.

    An empty id is legal on the wire and useless for correlating a result; both
    the assistant echo and the tool result must agree on the same substitute.
    """
    fixed: list[ToolCall] = []
    for index, call in enumerate(calls):
        if call.id:
            fixed.append(call)
        else:
            fixed.append(
                ToolCall(
                    id=f"call_{index}",
                    name=call.name,
                    arguments=call.arguments,
                    raw_arguments=call.raw_arguments,
                )
            )
    return tuple(fixed)


def _execute(
    calls: Sequence[ToolCall],
    handlers: Mapping[str, Callable[[dict[str, Any]], dict[str, Any]]],
) -> tuple[ToolExecution, ...]:
    """Run every call, answering each id exactly once."""
    executions: list[ToolExecution] = []
    seen: dict[tuple[str, str], dict[str, Any]] = {}

    for index, call in enumerate(calls):
        if index >= MAX_TOOL_CALLS_PER_TURN:
            # Still answered. Leaving an id dangling fails the *next* request,
            # which would turn a budget guard into a hard error.
            executions.append(
                ToolExecution(
                    call=call,
                    result={
                        "error": "too_many_tool_calls",
                        "message": f"本轮工具调用过多，最多处理 {MAX_TOOL_CALLS_PER_TURN} 个。",
                    },
                )
            )
            continue

        key = _dedupe_key(call)
        if key in seen:
            executions.append(ToolExecution(call=call, result=dict(seen[key], duplicate=True)))
            continue

        handler = handlers.get(call.name)
        if handler is None:
            result = _unknown_tool_result(call.name, list(handlers))
        else:
            malformed = _malformed_arguments(call)
            if malformed is not None:
                result = {"error": "bad_arguments", "message": malformed}
            else:
                try:
                    result = handler(call.arguments)
                except Exception as err:  # noqa: BLE001 - fed back to the model
                    # Truncated and kept terse: this text travels back to the
                    # model and can be paraphrased into player-visible output.
                    logger.warning("tool %s failed: %s", call.name, err)
                    result = {"error": "tool_failed", "message": str(err)[:120]}

        seen[key] = result
        executions.append(ToolExecution(call=call, result=result))

    return tuple(executions)


def _tool_turns(executions: Sequence[ToolExecution]) -> list[ChatMessage]:
    return [
        ChatMessage(
            role="tool",
            tool_call_id=execution.call.id,
            content=json.dumps(execution.result, ensure_ascii=False),
        )
        for execution in executions
    ]


def run_tool_loop(
    provider: ModelProvider,
    system: str,
    messages: Sequence[ChatMessage],
    tools: Sequence[ToolSpec],
    handlers: Mapping[str, Callable[[dict[str, Any]], dict[str, Any]]],
    deadline: Deadline,
    forced_tool: str,
    *,
    require_tool_call: bool = True,
    max_tokens: int | None = None,
) -> LoopOutcome:
    """Run the two-call loop and return the grounded answer.

    `require_tool_call=False` relaxes the first call for roles where producing no
    tool call is a legitimate outcome rather than an ungrounded answer.
    """
    if forced_tool not in handlers:
        raise ValueError(f"forced_tool {forced_tool!r} is not one of {sorted(handlers)}")

    def call(conversation: Sequence[ChatMessage], tool_choice: str) -> Any:
        remaining = deadline.remaining()
        if remaining < MIN_CALL_SECONDS:
            raise ToolLoopError(
                "DeadlineExceeded",
                f"剩余时间 {remaining:.1f}s 不足以完成模型调用（下限 {MIN_CALL_SECONDS:.0f}s）",
            )
        return provider.chat(
            system,
            conversation,
            tools=tools,
            tool_choice=tool_choice,
            max_tokens=max_tokens,
            timeout=int(min(CALL_TIMEOUT_CEILING, remaining)),
        )

    # ---- call 1: the model must ask for grounding -------------------------
    try:
        decision = call(messages, forced_tool)
    except ProviderError as err:
        raise ToolLoopError("ProviderError", str(err)) from err

    if not decision.tool_calls:
        if not require_tool_call:
            text = decision.text.strip()
            if not text:
                raise ToolLoopError("UngroundedAnswer", f"模型既没有调用工具，也没有给出文本")
            return LoopOutcome(text=text, executions=(), model_calls=1)
        # The forced tool_choice was ignored. Serving `decision.text` here would
        # hand the player an uncited medical answer — a broken product promise
        # dressed up as a degraded success.
        raise ToolLoopError(
            "UngroundedAnswer",
            f"模型未调用 {forced_tool}（tool_choice 被忽略），拒绝返回未标注出处的答案",
        )

    if decision.truncated:
        logger.warning("tool decision turn hit the token budget")

    calls = _with_ids(decision.tool_calls)
    executions = _execute(calls, handlers)

    # ---- call 2: answer, tools off ----------------------------------------
    follow_up = [
        *messages,
        ChatMessage(role="assistant", content=decision.text, tool_calls=calls),
        *_tool_turns(executions),
    ]

    try:
        answer = call(follow_up, "none")
    except ProviderError as err:
        raise ToolLoopError("ProviderError", str(err)) from err

    if answer.tool_calls:
        # The provider ignored `tool_choice="none"`. Without a bounded retry the
        # honest outcome is failure, not another round of guessing.
        raise ToolLoopError(
            "LoopExhausted",
            f"模型在禁用工具后仍请求调用（{len(answer.tool_calls)} 个），已到 {MAX_MODEL_CALLS} 次调用上限",
        )

    text = answer.text.strip()
    if not text:
        raise ToolLoopError("UngroundedAnswer", "模型未给出答案文本")

    if answer.truncated:
        # A truncated answer ends mid-sentence. Measured 2026-10-16: a Chinese
        # answer cut at max_tokens=300 still runs ~550 characters, so length
        # alone hides it — finish_reason is the only reliable signal.
        raise ToolLoopError("TruncatedAnswer", "答案被 token 预算截断，不是完整回答")

    return LoopOutcome(text=text, executions=executions, model_calls=2)
