#!/usr/bin/env python3
"""Decide whether `extraction_mode="SKIP"` is actually honoured.

The question matters because the failure is silent: if SKIP is ignored, the
knowledge notes GameMaster writes get extracted into `/players/{actorId}`, and
`recall_preferences` starts returning medical terms as the player's own
preferences. Nothing errors; the answers just quietly get worse.

Comparing note terms against long-term records does **not** answer it — both are
derived from the same events, so they share vocabulary by construction (that
false positive is exactly what the first version of `memory-dump.py` reported).

So this writes two events that differ in one respect only:

  - a **control** event with no `extraction_mode`, carrying one marker
  - a **probe** event with `extraction_mode="SKIP"`, carrying another

The control proves extraction ran at all — without it, an absent probe marker
would be indistinguishable from "the extractor has not caught up yet".

    MEMORY_ID=<id> AWS_PROFILE=cancercare-game-mvp \\
        python3 scripts/memory-skip-probe.py [--timeout 900]

Extraction is asynchronous; the default gives it 15 minutes.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import uuid

from bedrock_agentcore.memory import MemoryClient

REGION = os.environ.get("AWS_REGION", "us-east-1")
NAMESPACE_PREFIX = "/players"

#: Distinctive, and phrased as a fact about the player — the kind of thing the
#: USER_PREFERENCE strategy is built to extract. A bare token might be
#: paraphrased away by the extractor, which would make the control useless.
CONTROL_MARKER = "斑鸠"
CONTROL_TEXT = "顺便一提，这位玩家说自己养了一只叫「斑鸠」的猫。"
PROBE_MARKER = "雪貂"
PROBE_TEXT = "顺便一提，这位玩家说自己养了一只叫「雪貂」的蜥蜴。"


def records_for(api: MemoryClient, memory_id: str, actor_id: str) -> list[str]:
    try:
        response = api.list_memory_records(
            memory_id=memory_id, namespace_path=f"{NAMESPACE_PREFIX}/{actor_id}"
        )
    except Exception as err:  # noqa: BLE001
        print(f"    list_memory_records failed: {str(err)[:140]}")
        return []
    texts = []
    for record in response.get("memoryRecordSummaries", []):
        content = record.get("content")
        if isinstance(content, dict):
            texts.append(str(content.get("text", "")))
        elif content:
            texts.append(str(content))
    return texts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, default=900, help="seconds to wait for extraction")
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()

    memory_id = os.environ.get("MEMORY_ID")
    if not memory_id:
        print("MEMORY_ID is required (see the Agent stack outputs)")
        return 2

    api = MemoryClient(region_name=REGION)
    actor = f"skipprobe-{uuid.uuid4().hex[:8]}"
    session = f"skipprobe-{uuid.uuid4().hex[:8]}"
    print(f"memory={memory_id}\nactor={actor} session={session}")
    print(f"control marker={CONTROL_MARKER}  probe marker={PROBE_MARKER}\n")

    api.create_event(
        memory_id=memory_id,
        actor_id=actor,
        session_id=session,
        messages=[("顺便聊点别的", "USER"), (CONTROL_TEXT, "ASSISTANT")],
        # No extraction_mode: this one is *supposed* to be extracted.
    )
    api.create_event(
        memory_id=memory_id,
        actor_id=actor,
        session_id=session,
        messages=[("顺便聊点别的", "USER"), (PROBE_TEXT, "ASSISTANT")],
        extraction_mode="SKIP",
    )
    print("两条事件已写入，等待异步抽取...\n")

    deadline = time.monotonic() + args.timeout
    saw_control = False
    while time.monotonic() < deadline:
        texts = records_for(api, memory_id, actor)
        joined = " ".join(texts)
        saw_control = CONTROL_MARKER in joined
        saw_probe = PROBE_MARKER in joined
        remaining = int(deadline - time.monotonic())
        print(
            f"  t+{args.timeout - remaining:>4}s  记录 {len(texts)} 条"
            f"  对照({'有' if saw_control else '无'}) 探针({'有' if saw_probe else '无'})"
        )
        if saw_probe:
            print("\nVERDICT: SKIP 未生效——带 SKIP 的事件也被抽进了长期记忆。")
            print("  偏好召回会混入这些内容，需要在 recall_preferences 侧加过滤。")
            return 1
        if saw_control:
            print("\nVERDICT: SKIP 生效。")
            print("  对照组被抽取、探针组没有 => extraction_mode=SKIP 确实被服务端兑现。")
            return 0
        time.sleep(args.interval)

    print(f"\n超时：{args.timeout}s 内对照组也没有出现，说明抽取尚未完成。")
    print("  cannot conclude either way — 提高 --timeout 再跑一次。")
    return 3


if __name__ == "__main__":
    sys.exit(main())
