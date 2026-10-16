"""Output guard for generated health content.

The system prompt asks the model to stay inside the health-education boundary.
This module is what happens when it does not. Prompt instructions are a request,
not a constraint — anything the player reads has to be checked after generation
as well, which is why the guard lives in code and runs on every completion.

The distinction that matters: **concepts are allowed, prescriptions are not.**
GDD §4 itself teaches "什么是靶向治疗", so banning the phrase would defeat the
game's purpose. What is banned is telling *this* patient to do something.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Rule:
    pattern: re.Pattern[str]
    label: str


RULES: tuple[Rule, ...] = (
    # Survival / prognosis figures — GDD §16 forbids these outright.
    Rule(re.compile(r"\d+(?:\.\d+)?\s*%"), "百分比数字（可能是生存率或治愈率）"),
    Rule(re.compile(r"生存率|存活率|治愈率|五年生存|预期寿命|还能活"), "生存期或治愈率表述"),
    # Prescriptive language aimed at this patient.
    Rule(re.compile(r"建议(服用|使用|注射|口服)|推荐(服用|使用|注射)|应当(服用|使用)"), "药物或治疗推荐"),
    Rule(re.compile(r"\d+\s*(?:mg|毫克|微克|μg|ug)\b"), "药物剂量"),
    Rule(re.compile(r"每日\s*(服用|注射)\s*\d+"), "用药频次"),
    # Asserting a diagnosis rather than describing a concept.
    Rule(re.compile(r"确诊为|您患(?:有|了)|你的病是|你得了"), "诊断断言"),
    # A small set of common agents. Not exhaustive by design — the goal is to
    # catch the obvious leak, not to build a pharmacology database.
    Rule(
        re.compile(r"顺铂|培美曲塞|吉西他滨|紫杉醇|奥希替尼|厄洛替尼|帕博利珠|纳武利尤|贝伐珠单抗"),
        "具体药物名称",
    ),
)

#: Used when generation fails the guard twice. Deliberately generic: it must be
#: true regardless of what the player did, and must not pretend to be analysis.
SAFE_FALLBACK = (
    "本局照护记录已保存。你的选择会影响患者的生活质量与情绪状态——"
    "重点是持续关注、及时就医、把资料整理清楚，并在需要时寻求专业医生的意见。"
    "本内容仅用于健康教育，不构成任何诊断或治疗建议。"
)


#: Used when an answer fails the guard. `SAFE_FALLBACK` above closes out a game
#: session, which would be a non-answer for someone who asked about a concept;
#: this one says plainly what happened and what they can do instead.
QUESTION_FALLBACK = (
    "抱歉，这个问题的回答没有通过内容安全检查，所以我没有把它给你。"
    "可以换个说法再问一次，或者把这个疑问记下来，就诊时请医生解答。"
    "本内容仅用于健康教育，不构成任何诊断或治疗建议。"
)


def find_violations(text: str) -> list[str]:
    """Return the labels of every rule the text breaks. Empty means clean."""
    return [rule.label for rule in RULES if rule.pattern.search(text)]


def is_safe(text: str) -> bool:
    return not find_violations(text)


def describe(violations: list[str]) -> str:
    return "、".join(violations)
