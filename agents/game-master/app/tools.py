"""The two tools the Stage C roles expose.

Split deliberately into a pure core and a thin closure:

- `query_medical_knowledge` and `split_notes` take everything they need as
  arguments, so the retrieval and guard logic is testable with no Memory and no
  network.
- `knowledge_handlers` / `note_handlers` bind the session, the corpus and the
  Memory functions, and are what the tool loop actually calls.

That split is also the seam the deferred AgentCore Gateway (Stage B) would plug
into: exposing these over MCP means re-declaring the same `ToolSpec`s, not
rewriting the handlers.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Sequence

from .corpus import DEFAULT_TOP_K, KnowledgeEntry, normalise, search
from .provider import ToolSpec
from .safety import find_violations

logger = logging.getLogger(__name__)

#: A tool handler as the loop calls it: arguments in, JSON-serialisable result out.
Handler = Callable[[dict[str, Any]], dict[str, Any]]
#: Fetches this session's accumulated notes. Injected so tests need no Memory.
#: Must not raise — return `[]` instead, so a Memory outage degrades the answer
#: to corpus-only rather than failing it.
NoteReader = Callable[[], list[dict[str, Any]]]
#: Persists accepted notes for this session. Injected for the same reason.
NoteWriter = Callable[[list[dict[str, Any]]], int]

#: Cap on session notes pulled into one answer. They are contextual extras; the
#: corpus is the grounding, and an unbounded list would crowd the prompt.
MAX_SESSION_NOTES = 5

#: A session note's provenance is the game itself, not a clinical source. Saying
#: so plainly is better than dressing it up as a guideline.
SESSION_NOTE_SOURCE = "本会话剧情中的知识笔记（由游戏导演归纳）"


# --------------------------------------------------------------------------- #
# Tool declarations
#
# `stage` is deliberately absent from the question tool's schema. Measured
# 2026-10-16: given a free-text `stage` field the model filled it with prose
# ("用户提问概念解释"). The backend already knows the stage, so it is injected
# instead of asked for.
# --------------------------------------------------------------------------- #

KNOWLEDGE_TOOL = ToolSpec(
    name="query_medical_knowledge",
    description=(
        "检索医学概念的解释与出处。回答玩家关于医学概念的提问前必须先调用它取得依据，"
        "不要凭自己的记忆作答。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "要查询的医学概念或问题"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
)

NOTE_TOOL = ToolSpec(
    name="save_knowledge_notes",
    description=(
        "把剧情中出现的**医学或健康概念**归纳成知识笔记并保存，供后续的医学教育环节查阅。"
        "保存的应当是一个能回答「这是什么」的概念，而不是剧情的标题或玩家的选项原文。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "notes": {
                "type": "array",
                "description": "本次要保存的知识笔记",
                "items": {
                    "type": "object",
                    "properties": {
                        "term": {"type": "string", "description": "术语或问题"},
                        "explanation": {
                            "type": "string",
                            "description": "面向家属的解释，不超过 120 字",
                        },
                    },
                    "required": ["term", "explanation"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["notes"],
        "additionalProperties": False,
    },
)


# --------------------------------------------------------------------------- #
# Pure cores
# --------------------------------------------------------------------------- #


def matching_session_notes(notes: list[dict[str, Any]], question: str) -> list[dict[str, Any]]:
    """Session notes whose term appears in the question.

    Substring matching on the normalised term. Coarse on purpose — the notes are
    few and each is about something the player actually met, so a miss costs a
    little context and never a wrong answer. A question phrased entirely without
    the term ("那个 CT 检查是干嘛的") will miss; the corpus still answers it.
    """
    needle = normalise(question)
    if not needle:
        return []
    matched = [note for note in notes if normalise(str(note.get("term", ""))) in needle]
    return matched[:MAX_SESSION_NOTES]


def query_medical_knowledge(
    entries: tuple[KnowledgeEntry, ...],
    question: str,
    stage: str | None,
    notes: list[dict[str, Any]],
    top_k: int = DEFAULT_TOP_K,
) -> dict[str, Any]:
    """Assemble cited passages from the bundled corpus plus this session's notes."""
    hits = search(entries, question, stage=stage, top_k=top_k)
    session_notes = matching_session_notes(notes, question)

    passages: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    label_index = 0

    for entry in hits:
        label_index += 1
        label = f"S{label_index}"
        passages.append({"label": label, "title": entry.title, "body": entry.body})
        sources.append(
            {
                "label": label,
                "title": entry.title,
                "source": entry.source,
                "url": entry.source_url,
            }
        )

    for note in session_notes:
        label_index += 1
        label = f"S{label_index}"
        title = str(note.get("term", ""))
        passages.append(
            {"label": label, "title": title, "body": str(note.get("explanation", ""))}
        )
        sources.append(
            {"label": label, "title": title, "source": SESSION_NOTE_SOURCE, "url": None}
        )

    if not passages:
        return {
            "passages": [],
            "sources": [],
            "note": "语料中没有匹配这个概念的材料。请如实说明你无法就此提供解释。",
        }

    return {"passages": passages, "sources": sources}


#: Characters that carry no meaning when comparing two terms. Chinese has no
#: spaces, and the model varies punctuation freely between turns.
_FOLD_DROP = re.compile(r"[\s，。、（）()「」【】:：;；·\-—_/,.]")


def fold(text: str) -> str:
    """Normalise a term for comparison."""
    return _FOLD_DROP.sub("", text.strip().lower())


#: Below this length a substring match is too weak to act on — 化疗 vs 化疗与放疗
#: are two concepts, and collapsing them would silently drop one.
MIN_CONTAINMENT_LENGTH = 3


def echoes_event_text(term: str, event_texts: Sequence[str]) -> bool:
    """True when a "term" is just an event title or a choice the player made.

    Measured against the deployed agent: without this the model happily stored
    「戒烟与活动计划，分阶段执行」 — a choice's own wording — as a knowledge note.
    Those are not concepts anything can explain, and they dilute the pool a
    citation is later drawn from.

    Equality only, not containment: 「低剂量螺旋 CT」 is a real concept that also
    appears inside a longer choice text, and rejecting it would be wrong.
    """
    folded = fold(term)
    if not folded:
        return False
    return any(folded == fold(text) for text in event_texts if text)


def is_near_duplicate(term: str, accepted: Sequence[str]) -> bool:
    """True when this term repeats one already accepted in the same call.

    One live stage produced four phrasings of the same idea (戒烟与活动计划，
    分阶段执行 / 戒烟与活动计划（分阶段执行） / 和家人一起制定计划 / 和家人一起
    制定健康计划). They are one concept, and the near-variants differ only in
    punctuation or wording.
    """
    folded = fold(term)
    if not folded:
        return True
    for other in accepted:
        other_folded = fold(other)
        if not other_folded:
            continue
        if folded == other_folded:
            return True
        shorter, longer = sorted((folded, other_folded), key=len)
        if len(shorter) >= MIN_CONTAINMENT_LENGTH and shorter in longer:
            return True
    return False


def split_notes(
    notes: Any,
    event_texts: Sequence[str] = (),
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split proposed notes into (accepted, rejected).

    Three gates, in order: the content guard, the "that is not a concept" check
    against the stage's own event text, and a near-duplicate collapse.

    Notes are persisted and later cited verbatim, so they are held to the same
    standard as an answer. Rejecting rather than repairing: this repo's guards
    never rewrite model output, because a silently "fixed" medical claim is worse
    than one that was refused.
    """
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    if not isinstance(notes, list):
        return accepted, rejected

    for raw in notes:
        if not isinstance(raw, dict):
            continue
        term = str(raw.get("term", "")).strip()
        explanation = str(raw.get("explanation", "")).strip()
        if not term or not explanation:
            continue
        violations = find_violations(f"{term} {explanation}")
        if violations:
            rejected.append({"term": term, "violations": violations})
            continue
        if echoes_event_text(term, event_texts):
            rejected.append({"term": term, "reason": "not_a_concept"})
            continue
        if is_near_duplicate(term, [note["term"] for note in accepted]):
            rejected.append({"term": term, "reason": "duplicate"})
            continue
        accepted.append({"term": term, "explanation": explanation})

    return accepted, rejected


# --------------------------------------------------------------------------- #
# Bindings the loop calls
# --------------------------------------------------------------------------- #


def knowledge_handlers(
    entries: tuple[KnowledgeEntry, ...],
    stage: str | None,
    read_notes: NoteReader,
) -> dict[str, Handler]:
    """Handlers for the Medical Education role."""

    def query(arguments: dict[str, Any]) -> dict[str, Any]:
        question = str(arguments.get("question", "")).strip()
        if not question:
            return {"error": "bad_question", "message": "question 不能为空。"}
        # A Memory outage degrades to corpus-only rather than failing the answer.
        return query_medical_knowledge(entries, question, stage, read_notes())

    return {KNOWLEDGE_TOOL.name: query}


def note_handlers(
    write_notes: NoteWriter,
    event_texts: Sequence[str] = (),
) -> dict[str, Handler]:
    """Handlers for the GameMaster extraction role.

    `event_texts` are the stage's own event titles and chosen options. They are
    the reference for "this is not a concept, it is what happened".
    """

    def save(arguments: dict[str, Any]) -> dict[str, Any]:
        accepted, rejected = split_notes(arguments.get("notes"), event_texts)
        if rejected:
            # Feedback the model can act on in a later turn. The two-call loop
            # has no such turn, so a rejected note is simply dropped here — said
            # plainly rather than hidden.
            logger.warning("rejected %d knowledge note(s): %s", len(rejected), rejected)
        stored = write_notes(accepted) if accepted else 0
        result: dict[str, Any] = {"stored": stored, "accepted": len(accepted)}
        if rejected:
            result["rejected"] = rejected
        return result

    return {NOTE_TOOL.name: save}
