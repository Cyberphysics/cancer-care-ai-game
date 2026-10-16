"""AgentCore Memory: long-term player preferences.

**Memory is not the game's source of truth.** DynamoDB owns every fact about the
game — patient state, event history, progress, score. Memory holds only soft,
personalisation signals ("this player like detailed explanations", "they keep
coming back to nutrition") keyed by actor.

That split is deliberate. Memory extraction is asynchronous and eventually
consistent, so driving game logic from it would be wrong; personalising wording
with it is exactly what it is for. See docs/ARCHITECTURE.md §5.3.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .config import Settings

logger = logging.getLogger(__name__)

#: Namespace prefix, mirroring the `namespaces` configured on the CDK
#: `memoryStrategies`. The service substitutes `{actorId}` at write time, so a
#: reader supplies the concrete value. This must match `agent-stack.ts` — the
#: built-in default layout (`/strategies/{memoryStrategyId}/actors/{actorId}`) is
#: deliberately not used because `{memoryStrategyId}` is not knowable by a reader.
PLAYER_NAMESPACE_PREFIX = "/players"


def _client(settings: Settings):
    from bedrock_agentcore.memory import MemoryClient

    # Region must be passed explicitly: the client defaults to us-west-2 when the
    # session has no region, which would silently address the wrong region.
    return MemoryClient(region_name=settings.region)


def recall_preferences(settings: Settings, player_id: str, query: str) -> list[str]:
    """Retrieve remembered preferences for a player.

    Returns an empty list on any failure. Memory is a personalisation nicety —
    a memory outage should degrade the wording, never break the game.
    """
    if not settings.memory_configured:
        return []

    try:
        client = _client(settings)
        records = client.retrieve_memories(
            memory_id=settings.memory_id,
            namespace_path=f"{PLAYER_NAMESPACE_PREFIX}/{player_id}",
            query=query,
            top_k=5,
        )
    except Exception as err:  # noqa: BLE001 - degradation is the point
        logger.warning("memory recall failed for actor=%s: %s", player_id, err)
        return []

    return [_record_text(record) for record in records if _record_text(record)]


def remember_session(
    settings: Settings,
    player_id: str,
    session_id: str,
    summary_text: str,
) -> None:
    """Record a session outcome as an event, which the service turns into long-term memory.

    Written as a user/assistant exchange so the extraction model has something
    conversational to work from, rather than a bare blob of text.
    """
    if not settings.memory_configured:
        return

    try:
        client = _client(settings)
        client.create_event(
            memory_id=settings.memory_id,
            actor_id=player_id,
            session_id=session_id,
            messages=[
                ("请总结我这次照护模拟中的表现与偏好。", "USER"),
                (summary_text, "ASSISTANT"),
            ],
        )
    except Exception as err:  # noqa: BLE001
        logger.warning("memory write failed for actor=%s: %s", player_id, err)


# --------------------------------------------------------------------------- #
# Knowledge notes
#
# GameMaster accumulates them while narrating; the Medical Education role reads
# them back to answer with something contextual ("you met this in screening")
# rather than only generic. Stored as **short-term events**, not long-term
# memory records — see the SKIP note below.
# --------------------------------------------------------------------------- #

#: Metadata key/value used to tag and later filter knowledge notes.
NOTE_METADATA_KEY = "noteKind"
NOTE_METADATA_VALUE = "knowledge"


def _string_value(value: str) -> dict[str, str]:
    """MetadataValue is string-only (`bedrockagentcore.memory.models.filters`).

    Built inline rather than imported so this module stays importable without the
    SDK present, matching the lazy `_client` import above.
    """
    return {"stringValue": value}


def write_knowledge_notes(
    settings: Settings,
    player_id: str,
    session_id: str,
    stage: str,
    notes: list[dict[str, Any]],
) -> int:
    """Persist curated knowledge notes, one event each. Returns how many landed.

    `extraction_mode="SKIP"` is the load-bearing part. Without it the memory
    strategies would extract these events into `/players/{actorId}`, and
    `recall_preferences` would later return medical terms as if they were the
    player's own preferences. The failure would be silent, and this stack has no
    third strategy to route them elsewhere on purpose.
    """
    if not settings.memory_configured or not notes:
        return 0

    written = 0
    for note in notes:
        try:
            client = _client(settings)
            client.create_event(
                memory_id=settings.memory_id,
                actor_id=player_id,
                session_id=session_id,
                messages=[
                    ("知识笔记", "USER"),
                    (json.dumps(note, ensure_ascii=False), "ASSISTANT"),
                ],
                metadata={
                    NOTE_METADATA_KEY: _string_value(NOTE_METADATA_VALUE),
                    "stage": _string_value(stage),
                },
                extraction_mode="SKIP",
            )
            written += 1
        except Exception as err:  # noqa: BLE001 - a note that fails to persist is not fatal
            logger.warning("knowledge note write failed for actor=%s: %s", player_id, err)
    return written


def read_knowledge_notes(settings: Settings, player_id: str, session_id: str) -> list[dict[str, Any]]:
    """Read back this session's knowledge notes.

    Returns an empty list on any failure: the Medical Education role falls back to
    the bundled corpus, which is a worse answer rather than no answer.

    Read via `list_events` with a metadata filter rather than
    `retrieve_memories`, because the latter is served by asynchronous extraction
    and would not see a note written moments ago. Filtering by metadata needs no
    `indexedKeys` declaration (verified by scripts/memory-event-probe.py).
    """
    if not settings.memory_configured:
        return []

    try:
        client = _client(settings)
        events = client.list_events(
            memory_id=settings.memory_id,
            actor_id=player_id,
            session_id=session_id,
            event_metadata=[
                {
                    "left": {"metadataKey": NOTE_METADATA_KEY},
                    # Plain string, not the OperatorType enum: botocore validates
                    # this field as a str and rejects the enum.
                    "operator": "EQUALS_TO",
                    "right": {"metadataValue": _string_value(NOTE_METADATA_VALUE)},
                }
            ],
            max_results=100,
        )
    except Exception as err:  # noqa: BLE001 - corpus-only is an acceptable degradation
        logger.warning("knowledge note read failed for actor=%s: %s", player_id, err)
        return []

    notes: list[dict[str, Any]] = []
    for event in events:
        for text in _event_texts(event):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and parsed.get("term"):
                notes.append(parsed)
    return notes


def _event_texts(event: dict[str, Any]) -> list[str]:
    """Pull the conversational text out of an event's payload.

    The nesting is the service's, not ours, and a bare `payload` entry is skipped
    rather than assumed.
    """
    texts: list[str] = []
    for item in event.get("payload") or []:
        conversation = item.get("conversational") or {}
        text = (conversation.get("content") or {}).get("text")
        if isinstance(text, str) and text.strip():
            texts.append(text)
    return texts


def _record_text(record: dict[str, Any]) -> str:
    """Pull the human-readable content out of a memory record.

    The record shape varies by strategy, so this probes the documented field
    names rather than assuming one layout.
    """
    content = record.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str):
            return text.strip()
    for key in ("memoryRecordId", "text", "value"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""
