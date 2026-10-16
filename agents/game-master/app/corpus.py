"""The bundled medical-education corpus.

This is the floor the Medical Education role stands on: curated, sourced
concepts shipped inside the agent zip. GameMaster's session-derived knowledge
notes are layered on top at runtime (see `app/memory.py`), so an answer can draw
on both what is generally true and what this particular player actually met.

Retrieval is keyword scoring rather than embeddings. The corpus is small and
hand-curated, and being able to say *why* a passage matched is worth more here
than a marginal recall gain — and the tool contract is what lets a vector store
replace this later without the agent noticing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

CORPUS_PATH = Path(__file__).parent / "knowledge" / "corpus.json"

#: Mirrors the game's stage keys (docs/GAME-RULES.md §2).
STAGE_ORDER = ("prevention", "screening", "diagnosis", "treatment", "recovery")

DEFAULT_TOP_K = 3
#: Deliberately small: enough to break a near-tie in favour of the current
#: stage, not enough to outrank a strong keyword match.
STAGE_MATCH_BONUS = 5


class CorpusError(RuntimeError):
    """The corpus file is missing or malformed.

    Raised loudly and never swallowed. An empty corpus would let the agent
    answer from the model's own memory while every other test stayed green —
    the failure would be invisible until a player noticed the citations were
    missing.
    """


@dataclass(frozen=True)
class KnowledgeEntry:
    id: str
    title: str
    body: str
    keywords: tuple[str, ...]
    stages: tuple[str, ...]
    source: str
    source_url: str | None = None

    @property
    def citable_text(self) -> str:
        """Everything the safety guard must scan for this entry.

        The source title is included on purpose: it becomes player-visible in
        the rendered citation list, so it is held to the same standard as the
        body.
        """
        return " ".join((self.title, self.body, self.source, *self.keywords))


def _required(entry: dict[str, Any], field_name: str, index: int) -> Any:
    value = entry.get(field_name)
    if value in (None, "", [], ()):
        raise CorpusError(f"corpus entry #{index} is missing {field_name!r}")
    return value


def load_corpus(corpus_path: Path | None = None) -> tuple[KnowledgeEntry, ...]:
    source_path = corpus_path or CORPUS_PATH

    try:
        document = json.loads(source_path.read_text(encoding="utf-8"))
    except FileNotFoundError as err:
        raise CorpusError(f"corpus file not found: {source_path}") from err
    except json.JSONDecodeError as err:
        raise CorpusError(f"corpus is not valid JSON ({source_path}): {err}") from err

    raw_entries = document.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise CorpusError(f"corpus has no entries: {source_path}")

    entries: list[KnowledgeEntry] = []
    seen: set[str] = set()

    for index, raw in enumerate(raw_entries):
        if not isinstance(raw, dict):
            raise CorpusError(f"corpus entry #{index} is not an object")

        entry_id = str(_required(raw, "id", index))
        if entry_id in seen:
            raise CorpusError(f"duplicate corpus id: {entry_id}")
        seen.add(entry_id)

        stages = tuple(raw.get("stages") or ())
        unknown = [stage for stage in stages if stage not in STAGE_ORDER]
        if unknown:
            raise CorpusError(f"corpus entry {entry_id} has unknown stage(s): {unknown}")

        entries.append(
            KnowledgeEntry(
                id=entry_id,
                title=str(_required(raw, "title", index)),
                body=str(_required(raw, "body", index)),
                keywords=tuple(str(keyword) for keyword in _required(raw, "keywords", index)),
                stages=stages,
                source=str(_required(raw, "source", index)),
                source_url=raw.get("sourceUrl"),
            )
        )

    return tuple(entries)


def _normalise(text: str) -> str:
    """Lowercase, and drop all whitespace.

    Chinese has no word delimiters, so a space between 螺旋 and CT is a typing
    habit rather than a token boundary — "低剂量螺旋 CT" and "低剂量螺旋CT" have
    to match the same keyword. Without this the most natural way a player types
    the term misses it entirely (caught by the corpus test).
    """
    return "".join(text.lower().split())


def search(
    entries: Sequence[KnowledgeEntry],
    question: str,
    stage: str | None = None,
    top_k: int = DEFAULT_TOP_K,
) -> tuple[KnowledgeEntry, ...]:
    """Rank corpus entries against a free-text question.

    Longer keyword matches score higher because they are more specific — a hit
    on 低剂量螺旋CT says more than a hit on 筛查.

    `stage` is a boost, not a filter. Hard filtering would drop a good answer
    whenever a player asks about something from an earlier stage, which is
    routine in a five-stage game and would look like a retrieval bug.
    """
    haystack = _normalise(question)
    if not haystack:
        return ()

    scored: list[tuple[int, KnowledgeEntry]] = []
    for entry in entries:
        score = sum(
            len(_normalise(keyword))
            for keyword in entry.keywords
            if _normalise(keyword) in haystack
        )
        if _normalise(entry.title) in haystack:
            score += len(_normalise(entry.title))
        if score == 0:
            continue
        if stage and stage in entry.stages:
            score += STAGE_MATCH_BONUS
        scored.append((score, entry))

    # Ties break on id so results are stable across runs.
    scored.sort(key=lambda pair: (-pair[0], pair[1].id))
    return tuple(entry for _, entry in scored[:top_k])
