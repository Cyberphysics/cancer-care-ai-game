"""Tool handlers, tested through the pure cores they are built from.

Memory is injected as a plain callable in every case, so none of this needs a
credential or a network.
"""

from __future__ import annotations

from app.corpus import load_corpus
from app.tools import (
    KNOWLEDGE_TOOL,
    MAX_SESSION_NOTES,
    NOTE_TOOL,
    SESSION_NOTE_SOURCE,
    fold,
    knowledge_handlers,
    matching_session_notes,
    note_handlers,
    query_medical_knowledge,
    split_notes,
)

CORPUS = load_corpus()


def note(term: str, explanation: str = "一条解释") -> dict:
    return {"term": term, "explanation": explanation}


# --------------------------------------------------------------------------- #
# retrieval
# --------------------------------------------------------------------------- #


def test_corpus_hits_are_labelled_and_citable():
    result = query_medical_knowledge(CORPUS, "什么是低剂量螺旋 CT", stage="screening", notes=[])

    assert result["passages"]
    labels = [passage["label"] for passage in result["passages"]]
    assert labels == [f"S{i}" for i in range(1, len(labels) + 1)]

    source_labels = [source["label"] for source in result["sources"]]
    assert source_labels == labels  # every passage is citable
    assert all(source["source"] for source in result["sources"])


def test_every_passage_has_exactly_one_source():
    result = query_medical_knowledge(CORPUS, "活检是什么", stage=None, notes=[])
    assert len(result["passages"]) == len(result["sources"])


def test_session_notes_are_appended_after_corpus_hits_and_sourced_honestly():
    notes = [note("低剂量螺旋 CT", "你在筛查阶段遇到过它。")]
    result = query_medical_knowledge(CORPUS, "低剂量螺旋 CT 是什么", stage="screening", notes=notes)

    body_texts = [passage["body"] for passage in result["passages"]]
    assert "你在筛查阶段遇到过它。" in body_texts

    session_source = [s for s in result["sources"] if s["source"] == SESSION_NOTE_SOURCE]
    assert len(session_source) == 1
    # The session's own note is not dressed up as a clinical guideline.
    assert session_source[0]["url"] is None


def test_an_unmatched_question_says_so_rather_than_returning_junk():
    result = query_medical_knowledge(CORPUS, "今天天气怎么样", stage=None, notes=[])
    assert result["passages"] == []
    assert result["sources"] == []
    assert "没有匹配" in result["note"]


def test_stage_influences_ordering_without_narrowing_results():
    with_stage = query_medical_knowledge(CORPUS, "治疗期间的营养", stage="treatment", notes=[])
    without = query_medical_knowledge(CORPUS, "治疗期间的营养", stage=None, notes=[])
    assert len(with_stage["passages"]) >= len(without["passages"]) - 1


def test_top_k_is_respected():
    result = query_medical_knowledge(CORPUS, "低剂量螺旋 CT 与活检", stage=None, notes=[], top_k=1)
    assert len(result["passages"]) == 1


# --------------------------------------------------------------------------- #
# session-note matching
# --------------------------------------------------------------------------- #


def test_a_notes_term_matches_despite_spacing_differences():
    # Same normalisation the corpus uses: 低剂量螺旋 CT vs 低剂量螺旋CT.
    notes = [note("低剂量螺旋 CT", "x")]
    assert matching_session_notes(notes, "低剂量螺旋CT是什么") == notes


def test_notes_without_a_matching_term_are_left_out():
    notes = [note("靶向治疗", "x")]
    assert matching_session_notes(notes, "低剂量螺旋 CT 是什么") == []


def test_session_notes_are_capped():
    notes = [note("低剂量螺旋 CT", f"第{i}条") for i in range(MAX_SESSION_NOTES + 3)]
    assert len(matching_session_notes(notes, "低剂量螺旋 CT")) == MAX_SESSION_NOTES


def test_an_empty_question_matches_no_notes():
    assert matching_session_notes([note("活检", "x")], "   ") == []


# --------------------------------------------------------------------------- #
# the note guard
# --------------------------------------------------------------------------- #


def test_clean_notes_are_accepted():
    accepted, rejected = split_notes([note("活检", "取一小块组织做病理检查。")])
    assert accepted == [{"term": "活检", "explanation": "取一小块组织做病理检查。"}]
    assert rejected == []


def test_a_note_quoting_a_survival_figure_is_rejected():
    accepted, rejected = split_notes([note("预后", "五年生存率大约是多少，医生会讲。")])
    assert accepted == []
    assert rejected and "生存期或治愈率表述" in rejected[0]["violations"]


def test_a_note_naming_a_drug_is_rejected():
    accepted, rejected = split_notes([note("化疗", "可能会用到顺铂这类药物。")])
    assert accepted == []
    assert rejected


def test_malformed_notes_are_skipped_without_crashing():
    accepted, rejected = split_notes(
        [
            note(""),  # no term
            {"term": "只有术语"},  # no explanation
            {"explanation": "只有解释"},  # no term
            "不是对象",
            42,
            None,
        ]
    )
    assert accepted == []
    assert rejected == []


def test_a_non_list_argument_is_handled():
    assert split_notes(None) == ([], [])
    assert split_notes({"term": "活检"}) == ([], [])


# --------------------------------------------------------------------------- #
# "that is not a concept, that is what happened"
# --------------------------------------------------------------------------- #


def test_a_term_that_is_the_event_title_is_rejected():
    accepted, rejected = split_notes(
        [note("持续咳嗽两个月")],
        event_texts=["持续咳嗽两个月", "预约医院做进一步检查"],
    )
    assert accepted == []
    assert rejected[0]["reason"] == "not_a_concept"


def test_a_term_that_is_a_choice_verbatim_is_rejected():
    # Measured on the deployed agent: it stored this choice's own wording as a
    # knowledge note. Nothing can explain it as a concept.
    accepted, rejected = split_notes(
        [note("戒烟与活动计划，分阶段执行")],
        event_texts=["戒烟与活动计划，分阶段执行"],
    )
    assert accepted == []
    assert rejected[0]["reason"] == "not_a_concept"


def test_spacing_and_punctuation_do_not_defeat_the_echo_check():
    accepted, rejected = split_notes(
        [note("戒烟与活动计划（分阶段执行）")],
        event_texts=["戒烟与活动计划，分阶段执行"],
    )
    assert accepted == []
    assert rejected[0]["reason"] == "not_a_concept"


def test_a_concept_mentioned_inside_a_longer_choice_survives():
    # 低剂量螺旋 CT is a real concept that also appears inside a choice's text.
    # Rejecting by containment would discard the one entry worth keeping.
    accepted, rejected = split_notes(
        [note("低剂量螺旋 CT", "一种胸部检查方式。")],
        event_texts=["按建议预约低剂量螺旋 CT 进一步评估"],
    )
    assert [entry["term"] for entry in accepted] == ["低剂量螺旋 CT"]
    assert rejected == []


def test_without_event_texts_the_echo_gate_is_inert():
    accepted, _ = split_notes([note("持续咳嗽两个月")])
    assert [entry["term"] for entry in accepted] == ["持续咳嗽两个月"]


def test_the_note_handler_receives_the_event_texts():
    stored: list[dict] = []
    handlers = note_handlers(lambda notes: (stored.extend(notes), len(notes))[1], ["一起调整生活习惯"])

    result = handlers[NOTE_TOOL.name]({"notes": [note("一起调整生活习惯")]})

    assert result["stored"] == 0
    assert stored == []


# --------------------------------------------------------------------------- #
# near-duplicate collapse
# --------------------------------------------------------------------------- #


def test_punctuation_variants_of_one_concept_collapse():
    accepted, rejected = split_notes(
        [note("戒烟与活动计划，分阶段执行"), note("戒烟与活动计划（分阶段执行）")]
    )
    assert len(accepted) == 1
    assert rejected[0]["reason"] == "duplicate"


def test_a_longer_form_of_the_same_concept_collapses():
    accepted, _ = split_notes([note("营养支持"), note("治疗期间的营养支持")])
    assert len(accepted) == 1


def test_two_short_distinct_concepts_are_not_collapsed():
    # 化疗 and 化疗与放疗 are different things, and a two-character containment is
    # too weak a signal to silently drop one.
    accepted, rejected = split_notes([note("化疗"), note("化疗与放疗")])
    assert len(accepted) == 2
    assert rejected == []


def test_fold_strips_what_carries_no_meaning():
    assert fold("低剂量螺旋 CT，") == fold("低剂量螺旋ct")
    assert fold("活检") == fold(" 活检 ")


# --------------------------------------------------------------------------- #
# bound handlers
# --------------------------------------------------------------------------- #


def test_the_knowledge_handler_answers_from_the_corpus_with_no_notes():
    handlers = knowledge_handlers(CORPUS, "screening", lambda: [])
    result = handlers[KNOWLEDGE_TOOL.name]({"question": "低剂量螺旋 CT 是什么"})
    assert result["passages"]


def test_the_knowledge_handler_degrades_to_corpus_only_when_memory_returns_nothing():
    # The reader's contract is "return [] on failure", so this is the outage path.
    handlers = knowledge_handlers(CORPUS, "screening", lambda: [])
    with_notes = knowledge_handlers(CORPUS, "screening", lambda: [note("低剂量螺旋 CT", "剧情笔记")])

    plain = handlers[KNOWLEDGE_TOOL.name]({"question": "低剂量螺旋 CT 是什么"})
    enriched = with_notes[KNOWLEDGE_TOOL.name]({"question": "低剂量螺旋 CT 是什么"})

    assert plain["passages"]  # still answers
    assert len(enriched["passages"]) > len(plain["passages"])


def test_the_knowledge_handler_rejects_an_empty_question():
    handlers = knowledge_handlers(CORPUS, None, lambda: [])
    result = handlers[KNOWLEDGE_TOOL.name]({"question": "   "})
    assert result["error"] == "bad_question"


def test_the_note_handler_stores_only_accepted_notes():
    stored: list[dict] = []

    def writer(notes):
        stored.extend(notes)
        return len(notes)

    handlers = note_handlers(writer)
    result = handlers[NOTE_TOOL.name](
        {"notes": [note("活检", "取组织做病理检查。"), note("用药", "五年生存率如何。")]}
    )

    assert result["stored"] == 1
    assert result["accepted"] == 1
    assert len(result["rejected"]) == 1
    assert [n["term"] for n in stored] == ["活检"]


def test_the_note_handler_survives_a_missing_notes_array():
    handlers = note_handlers(lambda notes: len(notes))
    assert handlers[NOTE_TOOL.name]({}) == {"stored": 0, "accepted": 0}


def test_the_note_handler_reports_no_write_when_everything_is_rejected():
    called: list[int] = []

    def writer(notes):
        called.append(len(notes))
        return len(notes)

    handlers = note_handlers(writer)
    result = handlers[NOTE_TOOL.name]({"notes": [note("用药", "每日服用 3 次，每次 20 毫克。")]})

    assert result["stored"] == 0
    assert called == []  # the writer is never called with an empty list
