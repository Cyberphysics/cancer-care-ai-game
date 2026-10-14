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
