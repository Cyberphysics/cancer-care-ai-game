"""Guard the knowledge corpus the same way the event catalog is guarded.

`infra/cdk/test/lambda/engine.test.ts` regex-scans every event rationale for
content-rule violations. The corpus needs the mirror of that test, and for a
sharper reason: the agent's own output guard runs on the *answer*, so an entry
whose text trips the guard would make the role unable to answer about that
concept at all — and it would fail at runtime, in front of a player, rather than
at build time.
"""

from __future__ import annotations

import json

import pytest

from app.corpus import (
    CORPUS_PATH,
    STAGE_ORDER,
    CorpusError,
    load_corpus,
    search,
)
from app.safety import find_violations, is_safe

CORPUS = load_corpus()


# --------------------------------------------------------------------------- #
# the guard itself
# --------------------------------------------------------------------------- #


def test_every_entry_passes_the_agents_own_safety_guard():
    # Title, body, source AND keywords — the source title becomes player-visible
    # in the rendered citation list, so it is held to the same standard.
    failures = {
        entry.id: find_violations(entry.citable_text)
        for entry in CORPUS
        if not is_safe(entry.citable_text)
    }
    assert not failures, f"corpus entries violate the safety guard: {failures}"


def test_corpus_is_not_silently_empty():
    # A silently-empty corpus makes the agent answer ungrounded while every other
    # test stays green, so the floor is asserted rather than assumed.
    assert len(CORPUS) >= 12


# --------------------------------------------------------------------------- #
# structural invariants
# --------------------------------------------------------------------------- #


def test_every_entry_can_be_cited():
    # "MUST cite a source" is unsatisfiable without one.
    for entry in CORPUS:
        assert entry.source.strip(), f"{entry.id} has no source"


def test_keywords_are_present_and_specific():
    for entry in CORPUS:
        assert entry.keywords, f"{entry.id} has no keywords"
        # A one-character keyword would match almost any question.
        assert all(len(keyword) >= 2 for keyword in entry.keywords), f"{entry.id} has a too-short keyword"


def test_stages_are_real_game_stages():
    for entry in CORPUS:
        for stage in entry.stages:
            assert stage in STAGE_ORDER, f"{entry.id} names unknown stage {stage}"


def test_ids_are_unique():
    ids = [entry.id for entry in CORPUS]
    assert len(ids) == len(set(ids))


# --------------------------------------------------------------------------- #
# the loader must fail loudly
# --------------------------------------------------------------------------- #


def write(tmp_path, document) -> object:
    path = tmp_path / "corpus.json"
    path.write_text(
        document if isinstance(document, str) else json.dumps(document, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def test_missing_file_is_an_error(tmp_path):
    with pytest.raises(CorpusError):
        load_corpus(tmp_path / "nope.json")


def test_invalid_json_is_an_error(tmp_path):
    with pytest.raises(CorpusError):
        load_corpus(write(tmp_path, "{ not json"))


def test_empty_entry_list_is_an_error(tmp_path):
    with pytest.raises(CorpusError):
        load_corpus(write(tmp_path, {"entries": []}))


def test_entry_missing_a_source_is_an_error(tmp_path):
    document = {
        "entries": [
            {"id": "x", "title": "t", "body": "b", "keywords": ["kw"], "stages": []},
        ]
    }
    with pytest.raises(CorpusError) as err:
        load_corpus(write(tmp_path, document))
    assert "source" in str(err.value)


def test_duplicate_ids_are_an_error(tmp_path):
    entry = {"id": "dup", "title": "t", "body": "b", "keywords": ["kw"], "source": "s"}
    with pytest.raises(CorpusError):
        load_corpus(write(tmp_path, {"entries": [entry, dict(entry)]}))


def test_unknown_stage_is_an_error(tmp_path):
    entry = {
        "id": "x",
        "title": "t",
        "body": "b",
        "keywords": ["kw"],
        "source": "s",
        "stages": ["not_a_stage"],
    }
    with pytest.raises(CorpusError):
        load_corpus(write(tmp_path, {"entries": [entry]}))


# --------------------------------------------------------------------------- #
# retrieval
# --------------------------------------------------------------------------- #


def test_a_question_about_ldct_finds_the_ldct_entry():
    hits = search(CORPUS, "什么是低剂量螺旋 CT？为什么高危人群要做它？")
    assert hits
    assert hits[0].id == "ldct"


def test_a_question_about_biopsy_finds_the_biopsy_entry():
    hits = search(CORPUS, "为什么需要做活检？")
    assert hits
    assert hits[0].id == "biopsy"


def test_an_unrelated_question_returns_nothing_rather_than_a_bad_match():
    assert search(CORPUS, "今天天气怎么样") == ()


def test_an_empty_question_returns_nothing():
    assert search(CORPUS, "   ") == ()


def test_stage_boosts_a_tie_but_never_filters_a_good_answer():
    # 营养 is claimed by both the treatment- and recovery-stage entries; naming a
    # stage should order them, not remove the other.
    treatment = search(CORPUS, "治疗期间的营养应该注意什么", stage="treatment")
    recovery = search(CORPUS, "治疗期间的营养应该注意什么", stage="recovery")

    assert treatment and recovery
    assert treatment[0].id == "nutrition-during-treatment"
    assert recovery[0].id == "nutrition-during-treatment"  # same entry, both stages

    # A question about an earlier-stage concept still retrieves it while the
    # player is deep in a later stage.
    late = search(CORPUS, "低剂量螺旋 CT 是什么", stage="recovery")
    assert late and late[0].id == "ldct"


def test_results_are_deterministic_and_capped():
    hits = search(CORPUS, "低剂量螺旋 CT 与活检有什么区别", top_k=2)
    assert len(hits) <= 2
    assert hits == search(CORPUS, "低剂量螺旋 CT 与活检有什么区别", top_k=2)


def test_the_shipped_corpus_file_is_the_one_loaded():
    assert CORPUS_PATH.exists()
