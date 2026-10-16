"""The tool loop's control flow, one test per failure mode.

No real clock and no sleeping: `FakeClock` drives the deadline so the exhaustion
path is deterministic rather than timing-dependent.
"""

from __future__ import annotations

import json

import pytest

from app.provider import ChatMessage, ChatResult, ProviderError, ToolCall, ToolSpec
from app.tool_loop import (
    CALL_TIMEOUT_CEILING,
    Deadline,
    MAX_TOOL_CALLS_PER_TURN,
    ToolLoopError,
    run_tool_loop,
)
from providers import FakeClock, ScriptedProvider

TOOL = ToolSpec(
    name="query_medical_knowledge",
    description="检索医学概念的解释与出处",
    parameters={"type": "object", "properties": {"question": {"type": "string"}}},
)

MESSAGES = [ChatMessage(role="user", content="什么是低剂量螺旋 CT？")]


def call(id_: str, question: str = "低剂量螺旋 CT", **extra) -> ToolCall:
    arguments = {"question": question, **extra}
    return ToolCall(id=id_, name=TOOL.name, arguments=arguments, raw_arguments=json.dumps(arguments))


def decision(*calls: ToolCall, text: str = "", finish_reason: str = "tool_calls") -> ChatResult:
    return ChatResult(text=text, tool_calls=calls, finish_reason=finish_reason)


def answer(text: str = "低剂量螺旋 CT 是一种……[S1]", finish_reason: str = "stop") -> ChatResult:
    return ChatResult(text=text, finish_reason=finish_reason)


def run(provider, handlers=None, **kwargs):
    return run_tool_loop(
        provider,
        "系统提示词",
        MESSAGES,
        [TOOL],
        handlers if handlers is not None else {TOOL.name: lambda args: {"passages": ["…"]}},
        kwargs.pop("deadline", Deadline(24, clock=FakeClock())),
        forced_tool=kwargs.pop("forced_tool", TOOL.name),
        **kwargs,
    )


# --------------------------------------------------------------------------- #
# happy path
# --------------------------------------------------------------------------- #


def test_two_calls_and_the_answer_is_grounded():
    provider = ScriptedProvider([decision(call("c1")), answer()])
    outcome = run(provider)

    assert outcome.text == "低剂量螺旋 CT 是一种……[S1]"
    assert outcome.model_calls == 2
    assert [e.call.id for e in outcome.executions] == ["c1"]
    assert not outcome.executions[0].failed

    # First call is forced onto the tool, second is forced off it.
    assert provider.calls[0]["tool_choice"] == TOOL.name
    assert provider.calls[1]["tool_choice"] == "none"


def test_the_tool_result_reaches_the_answering_turn():
    provider = ScriptedProvider([decision(call("c1")), answer()])
    run(provider)

    follow_up = provider.calls[1]["messages"]
    assert [m.role for m in follow_up] == ["user", "assistant", "tool"]
    assert follow_up[1].tool_calls[0].id == "c1"
    assert follow_up[2].tool_call_id == "c1"
    assert json.loads(follow_up[2].content) == {"passages": ["…"]}


def test_per_call_timeout_is_capped_by_the_remaining_budget():
    clock = FakeClock()
    provider = ScriptedProvider([decision(call("c1")), answer()])
    run(provider, deadline=Deadline(8, clock=clock))

    # min(CALL_TIMEOUT_CEILING, remaining)
    assert provider.calls[0]["timeout"] == int(min(CALL_TIMEOUT_CEILING, 8))


# --------------------------------------------------------------------------- #
# the failure modes the loop has to answer rather than swallow
# --------------------------------------------------------------------------- #


def test_unknown_tool_name_is_fed_back_and_every_id_is_answered():
    bogus = ToolCall(id="c1", name="does_not_exist", arguments={}, raw_arguments="{}")
    provider = ScriptedProvider([decision(bogus), answer()])
    outcome = run(provider)

    assert outcome.executions[0].failed
    assert outcome.executions[0].result["error"] == "unknown_tool"
    assert "query_medical_knowledge" in outcome.executions[0].result["message"]
    # The model still gets an answer turn — an unanswered id would fail the call.
    assert outcome.text


def test_malformed_arguments_are_reported_not_repaired():
    broken = ToolCall(
        id="c1",
        name=TOOL.name,
        arguments={},
        raw_arguments="{'question': '低剂量螺旋 CT'}",  # single quotes: not JSON
    )
    provider = ScriptedProvider([decision(broken), answer()])
    outcome = run(provider)

    assert outcome.executions[0].result["error"] == "bad_arguments"
    assert "JSON" in outcome.executions[0].result["message"]


def test_legitimate_empty_arguments_are_not_mistaken_for_malformed():
    bare = ToolCall(id="c1", name=TOOL.name, arguments={}, raw_arguments="{}")
    provider = ScriptedProvider([decision(bare), answer()])
    outcome = run(provider, handlers={TOOL.name: lambda args: {"ok": True}})

    assert not outcome.executions[0].failed


def test_a_raising_handler_becomes_a_tool_error_not_a_crash():
    def boom(_args):
        raise RuntimeError("memory backend unavailable" + "x" * 300)

    provider = ScriptedProvider([decision(call("c1")), answer()])
    outcome = run(provider, handlers={TOOL.name: boom})

    result = outcome.executions[0].result
    assert result["error"] == "tool_failed"
    assert len(result["message"]) <= 120
    assert outcome.text  # the loop still completes


def test_multiple_calls_in_one_turn_are_all_answered():
    # Measured 2026-10-16: DeepSeek ignores parallel_tool_calls=false and
    # routinely returns two calls, so this is the normal case rather than an
    # edge case.
    provider = ScriptedProvider([decision(call("c1", "甲"), call("c2", "乙")), answer()])
    outcome = run(provider)

    assert [e.call.id for e in outcome.executions] == ["c1", "c2"]
    follow_up = provider.calls[1]["messages"]
    answered = {m.tool_call_id for m in follow_up if m.role == "tool"}
    assert answered == {"c1", "c2"}


def test_calls_beyond_the_per_turn_cap_still_get_a_result():
    calls = [call(f"c{i}", f"问题{i}") for i in range(MAX_TOOL_CALLS_PER_TURN + 2)]
    provider = ScriptedProvider([decision(*calls), answer()])
    outcome = run(provider)

    assert len(outcome.executions) == len(calls)
    excess = outcome.executions[MAX_TOOL_CALLS_PER_TURN:]
    assert all(e.result["error"] == "too_many_tool_calls" for e in excess)


def test_duplicate_calls_reuse_one_result():
    seen: list[str] = []

    def handler(args):
        seen.append(args["question"])
        return {"passages": ["…"]}

    provider = ScriptedProvider([decision(call("c1", "同一个问题"), call("c2", "同一个问题")), answer()])
    outcome = run(provider, handlers={TOOL.name: handler})

    assert seen == ["同一个问题"]  # executed once
    assert len(outcome.executions) == 2
    assert outcome.executions[1].result.get("duplicate") is True


def test_empty_ids_are_synthesised_and_shared_with_the_assistant_turn():
    nameless = ToolCall(id="", name=TOOL.name, arguments={"question": "x"}, raw_arguments='{"question": "x"}')
    provider = ScriptedProvider([decision(nameless), answer()])
    outcome = run(provider)

    synthetic = outcome.executions[0].call.id
    assert synthetic
    follow_up = provider.calls[1]["messages"]
    assert follow_up[1].tool_calls[0].id == synthetic
    assert follow_up[2].tool_call_id == synthetic


def test_text_alongside_tool_calls_never_becomes_the_answer():
    provider = ScriptedProvider(
        [decision(call("c1"), text="I'll look up the definition..."), answer("正式答案")],
    )
    outcome = run(provider)

    assert outcome.text == "正式答案"
    # The model's own chatter is preserved in the transcript, not served.
    assert provider.calls[1]["messages"][1].content == "I'll look up the definition..."


# --------------------------------------------------------------------------- #
# refusing to answer badly
# --------------------------------------------------------------------------- #


def test_ignored_tool_choice_is_refused_rather_than_answered_ungrounded():
    provider = ScriptedProvider([ChatResult(text="凭记忆作答", finish_reason="stop")])

    with pytest.raises(ToolLoopError) as err:
        run(provider)

    assert err.value.error_type == "UngroundedAnswer"


def test_no_tool_call_is_acceptable_when_grounding_is_not_required():
    provider = ScriptedProvider([ChatResult(text="这一阶段没有可提取的术语。", finish_reason="stop")])
    outcome = run(provider, require_tool_call=False)

    assert outcome.text == "这一阶段没有可提取的术语。"
    assert outcome.model_calls == 1
    assert outcome.executions == ()


def test_truncated_answer_is_reported_not_served():
    # A truncated Chinese answer still returns hundreds of characters, so length
    # cannot be the signal — finish_reason is.
    provider = ScriptedProvider([decision(call("c1")), answer("答案写到一半就", finish_reason="length")])

    with pytest.raises(ToolLoopError) as err:
        run(provider)

    assert err.value.error_type == "TruncatedAnswer"


def test_provider_ignoring_tool_choice_none_exhausts_rather_than_loops():
    provider = ScriptedProvider([decision(call("c1")), decision(call("c2"))])

    with pytest.raises(ToolLoopError) as err:
        run(provider)

    assert err.value.error_type == "LoopExhausted"
    assert len(provider.calls) == 2  # bounded, did not keep going


def test_deadline_is_checked_before_the_call_not_after():
    clock = FakeClock()
    provider = ScriptedProvider([decision(call("c1")), answer()])

    with pytest.raises(ToolLoopError) as err:
        run(provider, deadline=Deadline(5, clock=clock))  # below MIN_CALL_SECONDS

    assert err.value.error_type == "DeadlineExceeded"
    assert provider.calls == []  # no call was started that could not finish


def test_the_deadline_stops_a_second_call_that_would_overrun():
    clock = FakeClock()
    provider = ScriptedProvider([decision(call("c1")), answer()])
    deadline = Deadline(24, clock=clock)

    original_chat = provider.chat

    def chat(*args, **kwargs):
        result = original_chat(*args, **kwargs)
        clock.advance(23)  # the first call ate the budget
        return result

    provider.chat = chat

    with pytest.raises(ToolLoopError) as err:
        run(provider, deadline=deadline)

    assert err.value.error_type == "DeadlineExceeded"
    assert len(provider.calls) == 1


def test_provider_failure_surfaces_as_a_provider_error():
    provider = ScriptedProvider([ProviderError("HTTP 429 from api.deepseek.com")])

    with pytest.raises(ToolLoopError) as err:
        run(provider)

    assert err.value.error_type == "ProviderError"


def test_unknown_forced_tool_is_a_programming_error():
    provider = ScriptedProvider([answer()])

    with pytest.raises(ValueError):
        run(provider, forced_tool="not_a_real_tool")
