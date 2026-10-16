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
from typing import Any, Callable

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
        "把剧情中出现的医学术语、关键选择或常见问答归纳成知识笔记并保存，"
        "供后续的医学教育环节查阅。"
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


def split_notes(notes: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split proposed notes into (accepted, rejected) by the content guard.

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


def note_handlers(write_notes: NoteWriter) -> dict[str, Handler]:
    """Handlers for the GameMaster extraction role."""

    def save(arguments: dict[str, Any]) -> dict[str, Any]:
        accepted, rejected = split_notes(arguments.get("notes"))
        if rejected:
            # Feedback the model can act on in a later turn. The two-call loop
            # has no such turn, so a rejected note is simply dropped here — said
            # plainly rather than hidden.
            logger.warning("guard rejected %d knowledge note(s): %s", len(rejected), rejected)
        stored = write_notes(accepted) if accepted else 0
        result: dict[str, Any] = {"stored": stored, "accepted": len(accepted)}
        if rejected:
            result["rejected"] = rejected
        return result

    return {NOTE_TOOL.name: save}
