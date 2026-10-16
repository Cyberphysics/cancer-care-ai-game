"""Wire format for the tool-calling path. No network: HTTP is stubbed.

This is the only guard on the adapters' request and response shapes, and it is
where a mistake is most likely. Two in particular:

- `function.arguments` is a JSON **string**, not an object.
- A pure tool-call turn carries `content: ""` (measured) or `null` (legal), and
  neither is an "empty completion" — that error belongs to `complete()`, which
  must keep raising it.
"""

from __future__ import annotations

import json

import boto3
import pytest

from app import provider as provider_module
from app.provider import (
    BedrockProvider,
    ChatMessage,
    DeepSeekProvider,
    ProviderError,
    ToolCall,
    ToolSpec,
)

TOOL = ToolSpec(
    name="query_medical_knowledge",
    description="检索医学概念的解释与出处",
    parameters={"type": "object", "properties": {"question": {"type": "string"}}},
)


def deepseek(**kwargs) -> DeepSeekProvider:
    return DeepSeekProvider(api_key="sk-test", model_id="deepseek-chat", max_tokens=900, temperature=0.7)


def stub_post(monkeypatch, response: dict) -> dict:
    captured: dict = {}

    def fake_post(url, payload, headers, timeout=provider_module.DEFAULT_TIMEOUT_SECONDS):
        captured.update(url=url, payload=payload, headers=headers, timeout=timeout)
        return response

    monkeypatch.setattr(provider_module, "_post_json", fake_post)
    return captured


def tool_call_response(arguments: str | None = '{"question": "活检"}', content=None, finish="tool_calls"):
    function = {"name": "query_medical_knowledge"}
    if arguments is not None:
        function["arguments"] = arguments
    return {
        "choices": [
            {
                "message": {"content": content, "tool_calls": [{"id": "c1", "function": function}]},
                "finish_reason": finish,
            }
        ]
    }


# --------------------------------------------------------------------------- #
# request shape
# --------------------------------------------------------------------------- #


def test_a_named_tool_choice_is_translated_to_the_wire_format(monkeypatch):
    captured = stub_post(monkeypatch, tool_call_response())
    deepseek().chat(
        "system",
        [ChatMessage(role="user", content="什么是活检")],
        tools=[TOOL],
        tool_choice="query_medical_knowledge",
        max_tokens=400,
        timeout=9,
    )

    body = captured["payload"]
    assert body["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "query_medical_knowledge",
                "description": "检索医学概念的解释与出处",
                "parameters": TOOL.parameters,
            },
        }
    ]
    assert body["tool_choice"] == {
        "type": "function",
        "function": {"name": "query_medical_knowledge"},
    }
    assert body["max_tokens"] == 400
    assert captured["timeout"] == 9


def test_parallel_tool_calls_is_not_sent(monkeypatch):
    # Measured 2026-10-16: DeepSeek accepts the flag and ignores it. Config that
    # reads as a guarantee while doing nothing is worse than absent config.
    captured = stub_post(monkeypatch, tool_call_response())
    deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL], tool_choice="auto")
    assert "parallel_tool_calls" not in captured["payload"]


def test_the_none_choice_passes_through_as_a_string(monkeypatch):
    captured = stub_post(monkeypatch, tool_call_response(arguments=None, content="答案", finish="stop"))
    deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL], tool_choice="none")
    assert captured["payload"]["tool_choice"] == "none"
    # Tools stay declared: the second call of the loop forbids *using* them, it
    # does not hide them.
    assert "tools" in captured["payload"]


def test_tools_are_absent_when_none_are_passed(monkeypatch):
    captured = stub_post(monkeypatch, {"choices": [{"message": {"content": "x"}, "finish_reason": "stop"}]})
    deepseek().complete("s", "u")
    assert "tools" not in captured["payload"]
    assert "tool_choice" not in captured["payload"]


def test_prior_turns_are_echoed_with_arguments_as_a_string(monkeypatch):
    captured = stub_post(monkeypatch, {"choices": [{"message": {"content": "x"}, "finish_reason": "stop"}]})
    call = ToolCall(id="c1", name="t", arguments={"question": "活检"}, raw_arguments='{"question": "活检"}')

    deepseek().chat(
        "s",
        [
            ChatMessage(role="user", content="什么是活检"),
            ChatMessage(role="assistant", content="", tool_calls=(call,)),
            ChatMessage(role="tool", tool_call_id="c1", content='{"hits": []}'),
        ],
    )

    messages = captured["payload"]["messages"]
    assistant = messages[2]
    assert assistant["content"] is None  # present but null, not omitted
    assert isinstance(assistant["tool_calls"][0]["function"]["arguments"], str)
    assert messages[3] == {"role": "tool", "tool_call_id": "c1", "content": '{"hits": []}'}


def test_an_unparseable_arguments_string_is_echoed_verbatim_not_rewritten(monkeypatch):
    captured = stub_post(monkeypatch, {"choices": [{"message": {"content": "x"}, "finish_reason": "stop"}]})
    broken = ToolCall(id="c1", name="t", arguments={}, raw_arguments="{'question': 'x'}")

    deepseek().chat("s", [ChatMessage(role="assistant", tool_calls=(broken,))])

    echoed = captured["payload"]["messages"][1]["tool_calls"][0]["function"]["arguments"]
    assert echoed == "{'question': 'x'}"  # not re-serialised to "{}"


# --------------------------------------------------------------------------- #
# response shape
# --------------------------------------------------------------------------- #


def test_a_tool_turn_with_empty_string_content_is_not_an_empty_completion(monkeypatch):
    stub_post(monkeypatch, tool_call_response(content=""))
    result = deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL])

    assert result.text == ""
    assert len(result.tool_calls) == 1
    assert result.finish_reason == "tool_calls"


def test_a_tool_turn_with_null_content_is_accepted(monkeypatch):
    stub_post(monkeypatch, tool_call_response(content=None))
    result = deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL])

    assert result.text == ""
    assert result.tool_calls[0].name == "query_medical_knowledge"


def test_arguments_arrive_as_a_json_string_and_are_parsed(monkeypatch):
    stub_post(monkeypatch, tool_call_response(arguments='{"question": "活检", "stage": "diagnosis"}'))
    result = deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL])

    assert result.tool_calls[0].arguments == {"question": "活检", "stage": "diagnosis"}


def test_malformed_arguments_keep_the_raw_text_and_an_empty_mapping(monkeypatch):
    stub_post(monkeypatch, tool_call_response(arguments="{'question': '活检'}"))
    result = deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL])

    call = result.tool_calls[0]
    assert call.arguments == {}
    assert call.raw_arguments == "{'question': '活检'}"


def test_non_object_arguments_are_rejected_as_a_mapping(monkeypatch):
    stub_post(monkeypatch, tool_call_response(arguments='["not", "an", "object"]'))
    result = deepseek().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL])
    assert result.tool_calls[0].arguments == {}


def test_length_finish_reason_marks_a_truncated_answer(monkeypatch):
    stub_post(monkeypatch, {"choices": [{"message": {"content": "写到一半"}, "finish_reason": "length"}]})
    result = deepseek().chat("s", [ChatMessage(role="user", content="q")])

    assert result.truncated is True
    assert result.text == "写到一半"  # long enough to look complete, hence the flag


def test_stop_finish_reason_is_not_truncated(monkeypatch):
    stub_post(monkeypatch, {"choices": [{"message": {"content": "完整"}, "finish_reason": "stop"}]})
    assert deepseek().chat("s", [ChatMessage(role="user", content="q")]).truncated is False


def test_complete_still_refuses_an_empty_completion(monkeypatch):
    # The original contract, preserved: only chat() tolerates a textless turn.
    monkeypatch.setattr(
        provider_module, "_post_json", lambda *a, **k: {"choices": [{"message": {"content": "  "}}]}
    )
    with pytest.raises(ProviderError, match="empty completion"):
        deepseek().complete("s", "u")


def test_complete_refuses_a_tool_call_rather_than_returning_nothing(monkeypatch):
    # A provider that ignored `tools=None` would otherwise hand narration a
    # silent empty string.
    stub_post(monkeypatch, tool_call_response())
    with pytest.raises(ProviderError, match="tool calls"):
        deepseek().complete("s", "u")


# --------------------------------------------------------------------------- #
# Bedrock, which nothing else exercises
# --------------------------------------------------------------------------- #


class FakeConverseClient:
    def __init__(self, response):
        self.response = response
        self.requests: list[dict] = []

    def converse(self, **kwargs):
        self.requests.append(kwargs)
        return self.response


def stub_bedrock(monkeypatch, response) -> FakeConverseClient:
    client = FakeConverseClient(response)
    monkeypatch.setattr(boto3, "client", lambda *a, **k: client)
    return client


def bedrock() -> BedrockProvider:
    return BedrockProvider(model_id="deepseek.v3.2", max_tokens=900, temperature=0.7, region="us-east-1")


def test_bedrock_tool_config_shape(monkeypatch):
    client = stub_bedrock(
        monkeypatch, {"output": {"message": {"content": [{"text": "答案"}]}}, "stopReason": "end_turn"}
    )
    bedrock().chat(
        "system",
        [ChatMessage(role="user", content="什么是活检")],
        tools=[TOOL],
        tool_choice="query_medical_knowledge",
    )

    tool_config = client.requests[0]["toolConfig"]
    assert tool_config["tools"][0]["toolSpec"]["inputSchema"] == {"json": TOOL.parameters}
    assert tool_config["toolChoice"] == {"tool": {"name": "query_medical_knowledge"}}


def test_bedrock_none_choice_omits_tool_choice(monkeypatch):
    client = stub_bedrock(
        monkeypatch, {"output": {"message": {"content": [{"text": "答案"}]}}, "stopReason": "end_turn"}
    )
    bedrock().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL], tool_choice="none")

    assert "toolChoice" not in client.requests[0]["toolConfig"]


def test_bedrock_tool_use_is_parsed(monkeypatch):
    stub_bedrock(
        monkeypatch,
        {
            "output": {
                "message": {
                    "content": [
                        {"toolUse": {"toolUseId": "tu1", "name": "query_medical_knowledge", "input": {"question": "活检"}}}
                    ]
                }
            },
            "stopReason": "tool_use",
        },
    )
    result = bedrock().chat("s", [ChatMessage(role="user", content="q")], tools=[TOOL])

    assert result.tool_calls[0].id == "tu1"
    assert result.tool_calls[0].arguments == {"question": "活检"}  # already a mapping here
    assert result.finish_reason == "tool_calls"
    assert result.truncated is False


def test_bedrock_merges_consecutive_tool_results_into_one_user_turn(monkeypatch):
    # Bedrock requires every toolUseId from an assistant turn to be answered in
    # the single following user turn; the loop emits one result per call.
    client = stub_bedrock(
        monkeypatch, {"output": {"message": {"content": [{"text": "答案"}]}}, "stopReason": "end_turn"}
    )
    calls = (
        ToolCall(id="tu1", name="t", arguments={"a": 1}),
        ToolCall(id="tu2", name="t", arguments={"b": 2}),
    )
    bedrock().chat(
        "s",
        [
            ChatMessage(role="assistant", tool_calls=calls),
            ChatMessage(role="tool", tool_call_id="tu1", content="r1"),
            ChatMessage(role="tool", tool_call_id="tu2", content="r2"),
        ],
    )

    messages = client.requests[0]["messages"]
    assert [m["role"] for m in messages] == ["assistant", "user"]
    results = messages[1]["content"]
    assert [block["toolResult"]["toolUseId"] for block in results] == ["tu1", "tu2"]


def test_bedrock_max_tokens_maps_to_a_truncated_answer(monkeypatch):
    stub_bedrock(
        monkeypatch, {"output": {"message": {"content": [{"text": "半句"}]}}, "stopReason": "max_tokens"}
    )
    assert bedrock().chat("s", [ChatMessage(role="user", content="q")]).truncated is True


def test_bedrock_failures_surface_as_provider_errors(monkeypatch):
    class Boom:
        def converse(self, **kwargs):
            raise RuntimeError("AccessDenied")

    monkeypatch.setattr(boto3, "client", lambda *a, **k: Boom())
    with pytest.raises(ProviderError, match="Bedrock call failed"):
        bedrock().chat("s", [ChatMessage(role="user", content="q")])


def test_bedrock_complete_uses_the_same_contract(monkeypatch):
    stub_bedrock(
        monkeypatch, {"output": {"message": {"content": [{"text": "  解释  "}]}}, "stopReason": "end_turn"}
    )
    assert bedrock().complete("s", "u") == "解释"


def test_json_string_round_trip_is_symmetric():
    # Documents the asymmetry the adapters own: DeepSeek speaks JSON strings for
    # arguments, Bedrock speaks mappings.
    raw = json.dumps({"question": "活检"}, ensure_ascii=False)
    assert json.loads(raw) == {"question": "活检"}
