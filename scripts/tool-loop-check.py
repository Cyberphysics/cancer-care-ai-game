#!/usr/bin/env python3
"""Live check of the Stage C tool loop against the real model.

The unit tests stub the provider, so they cannot answer the questions that
actually matter here: does the model pick the right tool, does the passage we
retrieved get used, does the answer cite a source that exists, and does a note
written to AgentCore Memory come back out.

Two scenarios:

  1. question  - Medical Education answers from the bundled corpus, and every
                 citation it emits must name a source the tool actually returned.
  2. extract   - GameMaster pulls terms out of a stage's events, writes them to
                 AgentCore Memory as tagged short-term events, and we read them
                 back with the metadata filter.

Usage:
    AWS_PROFILE=cancercare-game-mvp \\
        agents/game-master/.venv/bin/python scripts/tool-loop-check.py

    # scenario 2 additionally needs the Memory resource:
    MEMORY_ID=<id> ... scripts/tool-loop-check.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AGENT_DIR = REPO / "agents" / "game-master"
sys.path.insert(0, str(AGENT_DIR))

from app.corpus import load_corpus, search  # noqa: E402
from app.provider import ChatMessage, DeepSeekProvider, ToolSpec  # noqa: E402
from app.safety import find_violations  # noqa: E402
from app.tool_loop import Deadline, ToolLoopError, run_tool_loop  # noqa: E402

REGION = os.environ.get("AWS_REGION", "us-east-1")
KEY_PARAMETER = "/cancercare-game-mvp/deepseek-api-key"
CITED = re.compile(r"\[(S\d+)\]")

results: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((label, ok, detail))
    print(f"  [{'OK' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if detail else ""))


def api_key() -> str:
    import boto3

    return boto3.client("ssm", region_name=REGION).get_parameter(
        Name=KEY_PARAMETER, WithDecryption=True
    )["Parameter"]["Value"]


def provider() -> DeepSeekProvider:
    return DeepSeekProvider(api_key=api_key(), model_id="deepseek-chat", max_tokens=900, temperature=0.7)


# --------------------------------------------------------------------------- #
# scenario 1: answer a question from the corpus
# --------------------------------------------------------------------------- #

KNOWLEDGE_TOOL = ToolSpec(
    name="query_medical_knowledge",
    description="检索医学概念的解释与出处。回答玩家提问前必须先调用它取得依据。",
    parameters={
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "要查询的医学概念或问题"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
)

QUESTION_SYSTEM = """你是照护模拟游戏「生命守护者」中的医学教育助手。

在回答之前，你必须先调用 query_medical_knowledge 取得依据，不要凭自己的记忆作答。

回答要求：
- 只用工具返回的材料作答，不要补充工具没有提供的内容。
- 每个论断后面标注它来自哪一段，格式为 [S1]、[S2]（对应工具返回的 label）。
- 用简体中文，语气温和专业，控制在 200 字以内。
- 只解释概念，不做诊断、不推荐治疗方案、不推荐药物、不预测生存期。
- 结尾提醒咨询专业医生。"""


def knowledge_handler(entries, stage: str | None):
    def handler(arguments: dict) -> dict:
        hits = search(entries, str(arguments.get("question", "")), stage=stage)
        if not hits:
            return {"passages": [], "note": "语料中没有匹配这个概念的材料。"}
        passages, sources = [], []
        for index, entry in enumerate(hits, start=1):
            label = f"S{index}"
            passages.append({"label": label, "title": entry.title, "body": entry.body})
            sources.append(
                {
                    "label": label,
                    "title": entry.title,
                    "source": entry.source,
                    "url": entry.source_url,
                }
            )
        return {"passages": passages, "sources": sources}

    return handler


def scenario_question(question: str, stage: str = "screening") -> None:
    print(f"\n== 场景 1：问答 ==")
    print(f"   问题：{question}   （阶段 {stage}）")

    entries = load_corpus()
    handler = knowledge_handler(entries, stage)
    started = time.monotonic()

    try:
        outcome = run_tool_loop(
            provider(),
            QUESTION_SYSTEM,
            [ChatMessage(role="user", content=question)],
            [KNOWLEDGE_TOOL],
            {KNOWLEDGE_TOOL.name: handler},
            Deadline(60.0),  # local run: not the agent's 24 s production budget
            forced_tool=KNOWLEDGE_TOOL.name,
        )
    except ToolLoopError as err:
        check("loop completes", False, f"{err.error_type}: {err}")
        return
    elapsed = time.monotonic() - started

    check("loop completes", True, f"{outcome.model_calls} 次模型调用，{elapsed:.1f}s")

    for execution in outcome.executions:
        print(f"   工具调用 {execution.call.name}({json.dumps(execution.call.arguments, ensure_ascii=False)})")
    check("模型确实调用了检索工具", bool(outcome.executions))

    returned_labels = set()
    for execution in outcome.executions:
        for source in execution.result.get("sources") or []:
            returned_labels.add(source["label"])
    check("工具返回了材料", bool(returned_labels), f"label={sorted(returned_labels)}")

    print(f"\n   回答：\n   {outcome.text}\n")

    cited = set(CITED.findall(outcome.text))
    check("回答引用了出处", bool(cited), f"引用 {sorted(cited)}")
    check("所有引用都指向真实返回的来源", cited <= returned_labels, f"越界引用 {sorted(cited - returned_labels)}")

    # The production path runs the guard on the final text. An answer that trips
    # it would be replaced by the generic fallback at runtime, wasting the call
    # and serving the player nothing about the concept they asked about.
    violations = find_violations(outcome.text)
    check("回答未触发安全护栏", not violations, f"违反项 {violations}" if violations else "")


# --------------------------------------------------------------------------- #
# scenario 2: extract notes, write them to Memory, read them back
# --------------------------------------------------------------------------- #

NOTE_TOOL = ToolSpec(
    name="save_knowledge_notes",
    description="把剧情里出现的医学术语、关键选择或常见问答归纳成知识笔记并保存。",
    parameters={
        "type": "object",
        "properties": {
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "term": {"type": "string", "description": "术语或问题"},
                        "explanation": {"type": "string", "description": "面向家属的解释，不超过 120 字"},
                    },
                    "required": ["term", "explanation"],
                },
            }
        },
        "required": ["notes"],
        "additionalProperties": False,
    },
)

EXTRACT_SYSTEM = """你是照护模拟游戏「生命守护者」的游戏导演，正在为「医学教育」环节整理素材。

根据给出的本阶段事件，调用 save_knowledge_notes 保存 2 到 3 条知识笔记，
覆盖玩家可能想进一步了解的医学术语或关键概念。

要求：
- 只归纳事件里真实出现过的概念，不要引入无关内容。
- 每条解释用简体中文，面向家属，只讲概念不做建议。
- 不出现任何百分比数字、具体药物名称或生存期表述。"""

STAGE_EVENTS = """本阶段（筛查）玩家经历的事件：

1. 体检发现肺部异常影像 —— 玩家选择「按建议预约低剂量螺旋 CT 进一步评估」
2. 医生建议做活检以明确病变性质 —— 玩家选择「先向医生了解流程和注意事项，再安排时间」
3. 资料开始变多了 —— 玩家选择「按时间顺序建一个资料档案」"""


def scenario_extract(memory_id: str | None) -> None:
    print("\n== 场景 2：知识抽取 ==")

    saved: list[dict] = []

    def handler(arguments: dict) -> dict:
        notes = arguments.get("notes") or []
        saved.extend(note for note in notes if isinstance(note, dict))
        return {"saved": len(saved)}

    try:
        outcome = run_tool_loop(
            provider(),
            EXTRACT_SYSTEM,
            [ChatMessage(role="user", content=STAGE_EVENTS)],
            [NOTE_TOOL],
            {NOTE_TOOL.name: handler},
            Deadline(60.0),
            forced_tool=NOTE_TOOL.name,
        )
    except ToolLoopError as err:
        check("抽取循环完成", False, f"{err.error_type}: {err}")
        return

    check("模型产出了知识笔记", bool(saved), f"{len(saved)} 条")
    for note in saved:
        print(f"   - {note.get('term')}：{str(note.get('explanation'))[:60]}...")

    # Notes are written to Memory, so they must clear the same guard the answers
    # do — otherwise a violating note is persisted and later cited verbatim.
    note_violations = {
        note.get("term"): find_violations(f"{note.get('term')} {note.get('explanation')}")
        for note in saved
        if find_violations(f"{note.get('term')} {note.get('explanation')}")
    }
    check("知识笔记未触发安全护栏", not note_violations, f"违反项 {note_violations}" if note_violations else "")

    if outcome.executions:
        print(f"   工具调用参数：{json.dumps(outcome.executions[0].call.arguments, ensure_ascii=False)[:300]}")

    if not memory_id:
        print("\n   （未提供 MEMORY_ID，跳过 Memory 往返）")
        return

    from bedrock_agentcore.memory import MemoryClient
    from bedrock_agentcore.memory.models.filters import OperatorType, StringValue

    actor = f"probe-actor-{uuid.uuid4().hex[:8]}"
    session = f"probe-session-{uuid.uuid4().hex[:8]}"
    client = MemoryClient(region_name=REGION)

    for note in saved:
        client.create_event(
            memory_id=memory_id,
            actor_id=actor,
            session_id=session,
            messages=[
                ("知识笔记", "USER"),
                (json.dumps(note, ensure_ascii=False), "ASSISTANT"),
            ],
            metadata={"noteKind": StringValue.build("knowledge"), "stage": StringValue.build("screening")},
            extraction_mode="SKIP",
        )
    print(f"\n   写入 Memory：{len(saved)} 条（actor={actor}）")

    events = client.list_events(
        memory_id=memory_id,
        actor_id=actor,
        session_id=session,
        event_metadata=[
            {
                "left": {"metadataKey": "noteKind"},
                "operator": OperatorType.EQUALS_TO.value,
                "right": {"metadataValue": StringValue.build("knowledge")},
            }
        ],
        max_results=100,
    )
    check("按标签读回的条数与写入一致", len(events) == len(saved), f"写入 {len(saved)} / 读回 {len(events)}")


def main() -> int:
    print(f"region={REGION}  memory={'set' if os.environ.get('MEMORY_ID') else 'unset'}")

    scenario_question("低剂量螺旋 CT 是什么？为什么高危人群要做它？")
    scenario_question("为什么需要做活检？", stage="screening")
    scenario_extract(os.environ.get("MEMORY_ID"))

    print("\n== 汇总 ==")
    failed = [label for label, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} 通过")
    for label in failed:
        print(f"  FAIL: {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
