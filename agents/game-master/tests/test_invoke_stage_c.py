"""Entrypoint contract for the Stage C roles.

These go through `main.invoke`, so they cover the wiring the unit tests for the
loop, the tools and the corpus each stop short of: which handler a `kind`
reaches, what the response envelope looks like, and what happens when the
provider misbehaves.
"""

from __future__ import annotations

import json

import pytest

import main as agent_main
from app.provider import ChatResult, ProviderError, ToolCall
from app.safety import QUESTION_FALLBACK, is_safe
from providers import ScriptedProvider

QUESTION = "低剂量螺旋 CT 是什么"


def knowledge_call(id_: str = "c1", question: str = QUESTION) -> ToolCall:
    arguments = {"question": question}
    return ToolCall(
        id=id_,
        name="query_medical_knowledge",
        arguments=arguments,
        raw_arguments=json.dumps(arguments, ensure_ascii=False),
    )


def tool_then_answer(tool: ToolCall, text: str = "低剂量螺旋 CT 是一种胸部检查方式 [S1]。") -> list:
    return [
        ChatResult(text="", tool_calls=(tool,), finish_reason="tool_calls"),
        ChatResult(text=text, finish_reason="stop"),
    ]


def invoke(monkeypatch, script: list, body: dict) -> dict:
    provider = ScriptedProvider(script)
    monkeypatch.setattr(agent_main, "build_provider", lambda _settings: provider)
    # No Memory in tests: reads degrade to corpus-only, writes are no-ops.
    monkeypatch.setattr(agent_main, "read_knowledge_notes", lambda *a, **k: [])
    return agent_main.invoke({"playerId": "p1", "sessionId": "s1", **body})


# --------------------------------------------------------------------------- #
# kind dispatch
# --------------------------------------------------------------------------- #


def test_the_four_kinds_are_the_contract(monkeypatch):
    # This tuple is duplicated in the game API's TypeScript. Nothing shares a
    # schema across the two languages, so pinning it here and there is what stops
    # a silent drift.
    assert agent_main.VALID_KINDS == ("choice", "summary", "question", "extract")


def test_an_unknown_kind_is_still_rejected(monkeypatch):
    from providers import ScriptedProvider as _  # noqa: F401

    result = agent_main.invoke({"kind": "freeform"})
    assert result["ok"] is False
    assert result["errorType"] == "BadRequest"


# --------------------------------------------------------------------------- #
# question
# --------------------------------------------------------------------------- #


def test_a_question_is_answered_with_citations(monkeypatch):
    result = invoke(monkeypatch, tool_then_answer(knowledge_call()), {"kind": "question", "question": QUESTION})

    assert result["ok"] is True
    assert result["kind"] == "question"
    assert result["citations"]
    assert result["citations"][0]["source"]  # every citation can name its source
    assert result["degraded"] is False


def test_an_empty_question_is_a_bad_request(monkeypatch):
    result = agent_main.invoke({"kind": "question", "question": "   "})
    assert result["ok"] is False
    assert result["errorType"] == "BadRequest"


def test_a_hallucinated_citation_is_dropped_rather_than_shown(monkeypatch):
    script = tool_then_answer(
        knowledge_call(),
        text="低剂量螺旋 CT 是一种胸部检查方式 [S1]，筛查间隔见 [S9]。",
    )
    result = invoke(monkeypatch, script, {"kind": "question", "question": QUESTION})

    labels = [citation["label"] for citation in result["citations"]]
    assert labels == ["S1"]  # S9 was never returned by the tool


def test_an_answer_without_citations_is_not_marked_degraded(monkeypatch):
    # `degraded` means "this text is a fallback". A real answer that simply
    # failed to cite is a different, visible state: citations is empty.
    script = tool_then_answer(knowledge_call(), text="低剂量螺旋 CT 是一种胸部检查方式。")
    result = invoke(monkeypatch, script, {"kind": "question", "question": QUESTION})

    assert result["ok"] is True
    assert result["citations"] == []
    assert result["degraded"] is False


def test_an_answer_that_fails_the_guard_is_replaced(monkeypatch):
    script = tool_then_answer(knowledge_call(), text="这类情况的五年生存率是这样的 [S1]。")
    result = invoke(monkeypatch, script, {"kind": "question", "question": QUESTION})

    assert result["ok"] is True
    assert result["degraded"] is True
    assert result["text"] == QUESTION_FALLBACK
    assert result["citations"] == []


def test_the_fallback_text_itself_passes_the_guard():
    # A fallback that tripped the guard would trap the agent in permanent
    # degradation.
    assert is_safe(QUESTION_FALLBACK)


def test_an_ungrounded_answer_is_refused_not_served(monkeypatch):
    provider = ScriptedProvider([ChatResult(text="凭记忆作答", finish_reason="stop")])
    monkeypatch.setattr(agent_main, "build_provider", lambda _settings: provider)

    result = agent_main.invoke({"kind": "question", "question": QUESTION, "playerId": "p1", "sessionId": "s1"})

    assert result["ok"] is False
    assert result["errorType"] == "UngroundedAnswer"


def test_a_provider_failure_is_reported_and_never_raised(monkeypatch):
    provider = ScriptedProvider([ProviderError("HTTP 429 from api.deepseek.com")])
    monkeypatch.setattr(agent_main, "build_provider", lambda _settings: provider)

    result = agent_main.invoke({"kind": "question", "question": QUESTION, "playerId": "p1", "sessionId": "s1"})

    assert result["ok"] is False
    assert result["errorType"] == "ProviderError"


def test_the_question_role_uses_the_public_corpus_when_memory_is_empty(monkeypatch):
    result = invoke(monkeypatch, tool_then_answer(knowledge_call()), {"kind": "question", "question": QUESTION})
    assert result["ok"] is True  # answered from the bundled corpus alone


# --------------------------------------------------------------------------- #
# extract
# --------------------------------------------------------------------------- #


def extract_script(notes: list[dict]) -> list:
    arguments = {"notes": notes}
    call = ToolCall(
        id="n1", name="save_knowledge_notes", arguments=arguments, raw_arguments=json.dumps(arguments, ensure_ascii=False)
    )
    return [
        ChatResult(text="", tool_calls=(call,), finish_reason="tool_calls"),
        ChatResult(text="已保存。", finish_reason="stop"),
    ]


def test_extract_without_a_memory_reports_zero_stored_not_an_error(monkeypatch):
    # Local dev has MEMORY_ID unset; a no-op must not look like a failure.
    notes = [{"term": "活检", "explanation": "取一小块组织做病理检查。"}]
    result = invoke(monkeypatch, extract_script(notes), {"kind": "extract", "stage": "screening"})

    assert result["ok"] is True
    assert result["stored"] == 0
    assert result["memoryConfigured"] is False
    assert result["stage"] == "screening"


def test_extract_counts_only_the_notes_that_pass_the_guard(monkeypatch):
    recorded: list[list[dict]] = []

    def fake_write(_settings, _player, _session, _stage, notes):
        recorded.append(notes)
        return len(notes)

    monkeypatch.setattr(agent_main, "write_knowledge_notes", fake_write)
    monkeypatch.setattr(agent_main, "read_knowledge_notes", lambda *a, **k: [])
    monkeypatch.setattr(
        agent_main,
        "build_provider",
        lambda _settings: ScriptedProvider(
            extract_script(
                [
                    {"term": "活检", "explanation": "取一小块组织做病理检查。"},
                    {"term": "用药", "explanation": "这类情况五年生存率大概是多少。"},
                ]
            )
        ),
    )

    result = agent_main.invoke({"kind": "extract", "stage": "diagnosis", "playerId": "p1", "sessionId": "s1"})

    assert result["ok"] is True
    assert result["stored"] == 1
    assert [note["term"] for note in recorded[0]] == ["活检"]


def test_extract_reports_the_terms_it_noted(monkeypatch):
    # The UI shows these. Without them the extraction is invisible: the player
    # advances a stage, nothing appears, and the agent looks uninvolved.
    monkeypatch.setattr(
        agent_main, "write_knowledge_notes", lambda _s, _p, _se, _st, notes: len(notes)
    )
    monkeypatch.setattr(agent_main, "read_knowledge_notes", lambda *a, **k: [])
    monkeypatch.setattr(
        agent_main,
        "build_provider",
        lambda _settings: ScriptedProvider(
            extract_script(
                [
                    {"term": "低剂量螺旋 CT", "explanation": "一种胸部检查方式。"},
                    {"term": "活检", "explanation": "取组织做病理检查。"},
                ]
            )
        ),
    )

    result = agent_main.invoke(
        {"kind": "extract", "stage": "screening", "playerId": "p1", "sessionId": "s1"}
    )

    assert result["terms"] == ["低剂量螺旋 CT", "活检"]


def test_a_skipped_extraction_reports_no_terms(monkeypatch):
    monkeypatch.setattr(agent_main, "read_knowledge_notes", lambda *a, **k: [{"term": "已有"}])
    result = agent_main.invoke(
        {"kind": "extract", "stage": "screening", "playerId": "p1", "sessionId": "s1"}
    )
    assert result["terms"] == []


def test_extract_without_a_stage_is_a_bad_request(monkeypatch):
    result = agent_main.invoke({"kind": "extract"})
    assert result["ok"] is False
    assert result["errorType"] == "BadRequest"


def test_extract_tolerates_a_stage_with_nothing_to_note(monkeypatch):
    # require_tool_call=False for this role: an empty stage is not a failure.
    provider = ScriptedProvider([ChatResult(text="本阶段没有可提取的术语。", finish_reason="stop")])
    monkeypatch.setattr(agent_main, "build_provider", lambda _settings: provider)

    result = agent_main.invoke({"kind": "extract", "stage": "recovery", "playerId": "p1", "sessionId": "s1"})

    assert result["ok"] is True
    assert result["stored"] == 0


def test_extract_is_safe_to_run_twice_for_the_same_stage(monkeypatch):
    # Memory's create_event only appends, and a client retry after a timeout is a
    # realistic duplicate. Without dedup a second call duplicates every note.
    written: list[list[dict]] = []
    on_record: list[dict] = []

    def fake_write(_settings, _player, _session, _stage, notes):
        written.append(notes)
        on_record.extend(notes)
        return len(notes)

    monkeypatch.setattr(agent_main, "write_knowledge_notes", fake_write)
    monkeypatch.setattr(agent_main, "read_knowledge_notes", lambda *a, **k: list(on_record))
    monkeypatch.setattr(
        agent_main,
        "build_provider",
        lambda _settings: ScriptedProvider(
            extract_script([{"term": "活检", "explanation": "取一小块组织做病理检查。"}])
        ),
    )

    body = {"kind": "extract", "stage": "screening", "playerId": "p1", "sessionId": "s1"}
    first = agent_main.invoke(dict(body))
    second = agent_main.invoke(dict(body))

    assert first["stored"] == 1
    assert second["stored"] == 0  # nothing new to add
    assert flattened(written) == ["活检"]


def test_extract_skips_a_stage_that_already_has_notes(monkeypatch):
    # Term-level dedup cannot survive a non-deterministic model: asked twice it
    # phrases notes differently, so every "new" term gets written (measured
    # against the deployed API). The question that actually holds is whether the
    # stage has been extracted at all.
    written: list[list[dict]] = []

    def fake_write(_settings, _player, _session, _stage, notes):
        written.append(notes)
        return len(notes)

    monkeypatch.setattr(agent_main, "write_knowledge_notes", fake_write)
    monkeypatch.setattr(
        agent_main,
        "read_knowledge_notes",
        lambda *a, **k: [{"term": "活检", "explanation": "已有。"}],
    )
    provider_used: list[int] = []
    monkeypatch.setattr(
        agent_main,
        "build_provider",
        lambda _settings: (
            provider_used.append(1),
            ScriptedProvider(
                extract_script([{"term": "低剂量螺旋 CT", "explanation": "措辞不同的新术语。"}])
            ),
        )[1],
    )

    result = agent_main.invoke(
        {"kind": "extract", "stage": "screening", "playerId": "p1", "sessionId": "s1"}
    )

    assert result["ok"] is True
    assert result["stored"] == 0
    assert result["skipped"] is True
    assert written == []
    assert provider_used == []  # no model call at all


def test_extract_still_runs_for_a_different_stage(monkeypatch):
    written: list[list[dict]] = []

    def fake_write(_settings, _player, _session, _stage, notes):
        written.append(notes)
        return len(notes)

    monkeypatch.setattr(agent_main, "write_knowledge_notes", fake_write)
    # Notes exist, but not for the stage being extracted.
    monkeypatch.setattr(
        agent_main,
        "read_knowledge_notes",
        lambda _s, _p, _sess, stage=None: [] if stage == "treatment" else [{"term": "已有"}],
    )
    monkeypatch.setattr(
        agent_main,
        "build_provider",
        lambda _settings: ScriptedProvider(
            extract_script([{"term": "营养", "explanation": "治疗期间的营养重点。"}])
        ),
    )

    result = agent_main.invoke(
        {"kind": "extract", "stage": "treatment", "playerId": "p1", "sessionId": "s1"}
    )

    assert result["stored"] == 1
    assert result.get("skipped") is None


def flattened(batches: list[list[dict]]) -> list[str]:
    return [note["term"] for batch in batches for note in batch]


@pytest.mark.parametrize("kind", ["question", "extract"])
def test_the_stage_c_roles_always_return_json_serialisable_dicts(monkeypatch, kind):
    body = {"kind": kind, "stage": "screening", "question": QUESTION, "playerId": "p1", "sessionId": "s1"}
    script = tool_then_answer(knowledge_call()) if kind == "question" else extract_script([])
    result = invoke(monkeypatch, script, body)

    assert isinstance(result, dict)
    json.dumps(result)  # must not raise
