#!/usr/bin/env python3
"""P0.2 probe: does `list_events`' metadata filter work without `indexedKeys`?

Phase 3 Stage C stores GameMaster's accumulated knowledge notes as AgentCore
Memory *short-term events*, then reads them back with a metadata filter. The
whole design rests on that filter working, and on it needing no prior key
declaration — `indexedKeys` exists only on the L1 `CfnMemory`, so needing it
would push the Memory resource off the stable L2 construct.

The probe is decisive rather than suggestive: it writes one tagged event and one
untagged control, then checks that the filtered query returns the first and
excludes the second. A filter that is silently ignored returns both.

Usage:
    MEMORY_ID=<id> AWS_PROFILE=cancercare-game-mvp \\
        agents/game-master/.venv/bin/python scripts/memory-event-probe.py
"""

from __future__ import annotations

import os
import sys
import uuid

from bedrock_agentcore.memory import MemoryClient
from bedrock_agentcore.memory.models.filters import OperatorType, StringValue

REGION = os.environ.get("AWS_REGION", "us-east-1")
TAGGED_KEY = "noteKind"
TAGGED_VALUE = "knowledge"

results: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((label, ok, detail))
    print(f"  [{'OK' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if detail else ""))


def equals_filter(key: str, value: str) -> dict:
    return {
        "left": {"metadataKey": key},
        # `.value`, not the enum member: botocore validates this field as a plain
        # string and rejects the OperatorType enum outright.
        "operator": OperatorType.EQUALS_TO.value,
        "right": {"metadataValue": StringValue.build(value)},
    }


def payloads(events: list[dict]) -> list[str]:
    """Pull the user/assistant text out of each event, for readable assertions."""
    out = []
    for event in events:
        texts = []
        for item in (event.get("payload") or []):
            conversation = item.get("conversational") or {}
            text = conversation.get("content", {}).get("text")
            if text:
                texts.append(text)
        out.append(" | ".join(texts))
    return out


def main() -> int:
    memory_id = os.environ.get("MEMORY_ID")
    if not memory_id:
        print("MEMORY_ID is required (see the Agent stack outputs)")
        return 2

    # Unique actor and session so a probe run never mixes with real sessions or
    # with a previous probe run.
    actor = f"probe-actor-{uuid.uuid4().hex[:8]}"
    session = f"probe-session-{uuid.uuid4().hex[:8]}"
    print(f"memory={memory_id} actor={actor} session={session}")

    client = MemoryClient(region_name=REGION)

    print("\n-- writing --")
    client.create_event(
        memory_id=memory_id,
        actor_id=actor,
        session_id=session,
        messages=[("知识笔记", "USER"), ("TAGGED-NOTE: 低剂量螺旋 CT 用于高危人群筛查", "ASSISTANT")],
        metadata={TAGGED_KEY: StringValue.build(TAGGED_VALUE)},
        # Nothing here should ever be extracted into long-term memory: these are
        # derived notes, not player preferences.
        extraction_mode="SKIP",
    )
    client.create_event(
        memory_id=memory_id,
        actor_id=actor,
        session_id=session,
        messages=[("普通对话", "USER"), ("UNTAGGED-CONTROL: 这条没有打标签", "ASSISTANT")],
        extraction_mode="SKIP",
    )
    print("  wrote 1 tagged event, 1 untagged control")

    print("\n-- reading --")
    unfiltered = payloads(
        client.list_events(memory_id=memory_id, actor_id=actor, session_id=session, max_results=100)
    )
    check(
        "unfiltered list_events sees both events",
        any("TAGGED-NOTE" in p for p in unfiltered) and any("UNTAGGED-CONTROL" in p for p in unfiltered),
        f"{len(unfiltered)} event(s)",
    )

    matching = payloads(
        client.list_events(
            memory_id=memory_id,
            actor_id=actor,
            session_id=session,
            event_metadata=[equals_filter(TAGGED_KEY, TAGGED_VALUE)],
            max_results=100,
        )
    )
    check("filter EQUALS_TO returns the tagged event", any("TAGGED-NOTE" in p for p in matching))
    check(
        "filter EQUALS_TO EXCLUDES the untagged control",
        not any("UNTAGGED-CONTROL" in p for p in matching),
        f"{len(matching)} event(s) matched",
    )

    absent = payloads(
        client.list_events(
            memory_id=memory_id,
            actor_id=actor,
            session_id=session,
            event_metadata=[equals_filter(TAGGED_KEY, "no-such-kind")],
            max_results=100,
        )
    )
    check("filter on an absent value returns nothing", absent == [], f"{len(absent)} event(s)")

    print("\n-- summary --")
    failed = [label for label, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        print("VERDICT: the metadata filter does NOT work as assumed:")
        for label in failed:
            print(f"  - {label}")
        print("  -> fall back to retrieve_memories + metadata_filters (needs L1 CfnMemory)")
        return 1
    print("VERDICT: list_events metadata filtering works with no indexedKeys declaration.")
    print("  -> the short-term-events design stands.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
