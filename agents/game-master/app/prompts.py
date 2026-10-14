"""Prompt construction for the GameMaster agent.

Kept separate from the provider so the wording can be iterated and unit-tested
without touching transport code.
"""

from __future__ import annotations

from typing import Any

SAFETY_RULES = """\
你必须遵守以下边界，任何情况下都不得违反：
1. 只做健康教育，不做医疗诊断、不推荐具体治疗方案、不推荐药物、不预测生存期。
2. 不得出现任何百分比数字（如生存率、治愈率）。不得出现药物名称或剂量。
3. 不得使用「确诊为」「您患有」这类断言句式；只描述概念与一般性知识。
4. 可以解释医学概念（例如低剂量螺旋 CT、病理检查、靶向治疗的含义），但不得建议这位患者采用某种治疗。
5. 涉及具体病情判断时，引导咨询专业医生。
6. 所有病例均为合成案例，不是真实患者。"""

SYSTEM_PROMPT = f"""你是一个健康教育游戏中的游戏导演（GameMaster Agent）。

游戏名为「生命守护者」。玩家扮演**家庭健康守护者**（不是医生），陪伴一位虚拟的肺癌患者
走完「预防 → 筛查 → 诊断 → 治疗 → 康复」五个阶段。玩家的目标是提升患者的**生活质量（QoL）**，
而不是提高治愈率。

你的职责是**解读玩家的选择**，帮助玩家理解这个照护决策背后的健康教育意义。
你不是医生，也不做任何临床判断。

{SAFETY_RULES}

写作要求：
- 使用简体中文，语气温和、专业、有同理心，不要说教。
- 长度控制在 150–300 字。
- 直接输出正文，不要加标题、不要用 Markdown 标记、不要分点罗列（总结任务除外）。
- 不要复述玩家的选择，直接讲这个选择的意义。"""


def _patient_line(patient: dict[str, Any]) -> str:
    risks = "、".join(patient.get("riskFactors") or []) or "无明确记录"
    return (
        f"患者：{patient.get('displayName', '患者')}，"
        f"{patient.get('age', '?')} 岁，{patient.get('gender', '')}，"
        f"职业：{patient.get('occupation', '未知')}；"
        f"已知风险因素：{risks}"
    )


def _health_line(health: dict[str, Any]) -> str:
    return (
        f"生活质量 {health.get('qualityOfLife', '?')}/100、"
        f"精力 {health.get('energy', '?')}/100、"
        f"压力 {health.get('stress', '?')}/100、"
        f"营养 {health.get('nutrition', '?')}/100"
    )


def _preferences_block(preferences: list[str] | None) -> str:
    if not preferences:
        return ""
    lines = "\n".join(f"- {item}" for item in preferences)
    return (
        "\n\n【关于这位玩家你记得的事】\n"
        f"{lines}\n"
        "请在措辞中适度照顾这些偏好，但不要直接写「我记得你……」这样的句子。"
    )


def build_choice_prompt(context: dict[str, Any]) -> str:
    """Explain a single decision the player just made."""
    focus = context.get("focusEvent") or {}
    session = context.get("session") or {}

    chosen_id = focus.get("chosenChoiceId") or ""
    chosen_text = next(
        (c.get("text", "") for c in focus.get("choices", []) if c.get("id") == chosen_id),
        "(未记录)",
    )
    impact = focus.get("impact") or {}
    impact_line = "、".join(f"{k} {v:+d}" for k, v in impact.items() if v) or "无明显变化"

    return f"""【当前情境】
{_patient_line(context.get("patient") or {})}
当前阶段：{session.get('stage', '?')}（第 {session.get('stageIndex', 0) + 1} / 5 阶段）
患者状态：{_health_line(context.get('health') or {})}
累计得分：{session.get('score', 0)}

【刚发生的事件】
{focus.get('title', '')}
{focus.get('description', '')}

【玩家的选择】
{chosen_text}

【这个选择带来的状态变化】
{impact_line}

{rules_block(context)}

请写一段解读，帮助玩家理解这个照护选择的意义：为什么它可能改善或加重患者的处境，
家属在这类情境中可以注意什么。不要评价玩家做得好或不好，只讲清背后的道理。{_preferences_block(context.get('preferences'))}"""


def build_summary_prompt(context: dict[str, Any]) -> str:
    """Produce the end-of-session care-strategy summary (GDD §15 step 6)."""
    events = context.get("events") or []
    session = context.get("session") or {}

    timeline = "\n".join(
        f"{i + 1}. [{e.get('stage', '?')}] {e.get('title', '')} → 选择了「{e.get('chosenChoiceText', '')}」"
        for i, e in enumerate(events)
    )

    return f"""【玩家完成了一次完整的五阶段照护模拟】

{_patient_line(context.get('patient') or {})}
最终状态：{_health_line(context.get('health') or {})}
最终生活质量：{session.get('qualityOfLife', '?')}/100
累计得分：{session.get('score', 0)}
会话状态：{session.get('status', '?')}

【完整决策时间线】
{timeline or '(无记录)'}

{rules_block(context)}

请输出一份「照护策略总结」，分三段，每段一个自然段，段首用「优势：」「不足：」「健康教育建议：」开头：
1. 优势 —— 这位玩家在照护过程中体现出的好做法
2. 不足 —— 值得改进的地方
3. 健康教育建议 —— 针对不足给出的、可操作的健康教育提示

再次强调：不得出现百分比数字、药物名称或剂量、生存期表述，也不要给出具体治疗方案。{_preferences_block(context.get('preferences'))}"""


def rules_block(context: dict[str, Any]) -> str:
    """Reminder inserted close to the generation point, where instructions drift most."""
    return (
        "\n【再次确认边界】只做健康教育；不诊断、不推荐治疗或药物、不预测生存期；"
        "不出现百分比数字、药物名称或剂量。"
    )
