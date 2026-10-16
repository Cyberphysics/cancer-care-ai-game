#!/usr/bin/env python3
"""Show what the game actually stored in AgentCore Memory.

Answers two questions that are otherwise guesswork:

  1. **What does a session look like inside Memory?** The GameMaster role writes
     one tagged short-term event per knowledge note, so the notes are readable
     back long before the asynchronous extractor has done anything.
  2. **Did `extraction_mode="SKIP"` actually hold?** If it did not, knowledge
     notes drift into `/players/{actorId}` and `recall_preferences` starts
     returning medical terms as the player's own preferences — silently. An empty
     `/players/{actor}` namespace after a session that produced notes is the
     evidence that it held.

Requires four read-only memory actions on the dev identity
(`ListActors`, `ListSessions`, `ListMemoryRecords`, `RetrieveMemoryRecords`) in
addition to the short-term three — see docs/DEPLOYMENT.md.

Usage:
    MEMORY_ID=<id> AWS_PROFILE=cancercare-game-mvp \\
        python3 scripts/memory-dump.py [actor-id]

Note on the two client conventions, which cost an hour to learn: `list_events`
is an explicit `MemoryClient` method and takes **snake_case**; the listing
methods do not exist on the class and are forwarded to boto3, where
`accept_snake_case_kwargs` converts for you. Their *response keys* are the
service's camelCase, and differ per call.
"""

from __future__ import annotations

import json
import os
import sys

from bedrock_agentcore.memory import MemoryClient

REGION = os.environ.get("AWS_REGION", "us-east-1")
NOTE_METADATA_VALUE = "knowledge"
NAMESPACE_PREFIX = "/players"


def client() -> MemoryClient:
    return MemoryClient(region_name=REGION)


def event_texts(event: dict) -> list[str]:
    texts: list[str] = []
    for item in event.get("payload") or []:
        conversation = item.get("conversational") or {}
        text = (conversation.get("content") or {}).get("text")
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return texts


def event_metadata(event: dict) -> dict:
    """`metadata` comes back as a mapping of key -> {"stringValue": ...}."""
    raw = event.get("metadata") or {}
    if not isinstance(raw, dict):
        return {}
    return {
        key: (value.get("stringValue") if isinstance(value, dict) else value)
        for key, value in raw.items()
    }


def note_term(texts: list[str]) -> str | None:
    """A knowledge note is stored as [prompt, json]; pull the term back out."""
    for text in texts:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed.get("term"):
            return str(parsed["term"])
    return None


def main() -> int:
    memory_id = os.environ.get("MEMORY_ID")
    if not memory_id:
        print("MEMORY_ID is required (see the Agent stack outputs)")
        return 2
    only_actor = sys.argv[1] if len(sys.argv) > 1 else None
    api = client()

    print(f"memory = {memory_id}")

    try:
        actors = api.list_actors(memory_id=memory_id).get("actorSummaries", [])
    except Exception as err:  # noqa: BLE001
        print(f"list_actors failed: {err}")
        return 1

    actor_ids = [a.get("actorId") for a in actors if a.get("actorId")]
    if only_actor:
        actor_ids = [a for a in actor_ids if a == only_actor]
    print(f"actor 共 {len(actor_ids)} 个")

    terms_by_actor: dict[str, set[str]] = {}
    total_notes = 0

    for actor_id in actor_ids:
        try:
            sessions = api.list_sessions(memory_id=memory_id, actor_id=actor_id).get(
                "sessionSummaries", []
            )
        except Exception as err:  # noqa: BLE001
            print(f"\n== actor {actor_id} ==\n  list_sessions failed: {err}")
            continue

        terms: set[str] = set()
        lines: list[str] = []
        for summary in sessions:
            session_id = summary.get("sessionId")
            if not session_id:
                continue
            try:
                events = api.list_events(
                    memory_id=memory_id, actor_id=actor_id, session_id=session_id
                )
            except Exception as err:  # noqa: BLE001
                lines.append(f"    events failed: {err}")
                continue

            notes, other = [], 0
            for event in events:
                metadata = event_metadata(event)
                if metadata.get("noteKind") == NOTE_METADATA_VALUE:
                    term = note_term(event_texts(event))
                    if term:
                        notes.append((term, metadata.get("stage")))
                else:
                    other += 1
            lines.append(
                f"    session {session_id}: {len(events)} 条事件"
                f"（知识笔记 {len(notes)}，其它 {other}）"
            )
            for term, stage in notes:
                lines.append(f"        [{stage}] {term}")
                terms.add(term)

        total_notes += len(terms)
        terms_by_actor[actor_id] = terms
        print(f"\n== actor {actor_id} ==  笔记术语 {len(terms)} 个")
        for line in lines:
            print(line)

    print("\n== 长期记忆记录（由策略异步抽取）==")
    records_total = 0
    leaked: list[str] = []
    for actor_id, terms in terms_by_actor.items():
        namespace = f"{NAMESPACE_PREFIX}/{actor_id}"
        try:
            response = api.list_memory_records(memory_id=memory_id, namespace_path=namespace)
        except Exception as err:  # noqa: BLE001
            print(f"  {namespace}: 读取失败 {err}")
            continue
        records = response.get("memoryRecordSummaries", [])
        records_total += len(records)
        if records:
            print(f"  {namespace}: {len(records)} 条")
            for record in records:
                text = str(record.get("content") or record.get("memoryRecordId") or "")
                print(f"      {text[:110]}")
                for term in terms:
                    if term and term in text:
                        leaked.append(f"{term} <- {namespace}")

    print("\n== 术语重叠（仅供参考，不是 SKIP 的判据）==")
    print(f"  短期事件里的知识笔记术语共 {total_notes} 个")
    print(f"  长期记录共 {records_total} 条")
    if leaked:
        # Deliberately NOT a verdict. Long-term records are extracted from the
        # session summary, which describes the same events the notes do — so the
        # same words showing up is expected, not evidence of a leak. Judging SKIP
        # needs a distinctive marker only a SKIP event carries; see
        # scripts/memory-skip-probe.py.
        print(f"  含术语字样的记录：{leaked}")
        print("  注意：这**不能**说明 SKIP 失效——摘要与笔记描述同一段剧情，用词本就会重叠。")
    else:
        print("  无明显重叠。")
    print("  要判定 SKIP，请跑 scripts/memory-skip-probe.py（写入带标记的事件再回查）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
