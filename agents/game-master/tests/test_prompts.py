"""Prompt construction tests.

These assert that the model actually receives the facts it is supposed to
reason about. A prompt that silently drops the health snapshot produces
plausible-sounding text about nothing in particular — the failure mode is
quality, not an exception, so nothing else catches it.
"""

from app.prompts import SYSTEM_PROMPT, build_choice_prompt, build_summary_prompt

CONTEXT = {
    "patient": {
        "displayName": "王先生",
        "age": 55,
        "gender": "male",
        "occupation": "办公室职员",
        "riskFactors": ["长期吸烟", "缺少运动"],
    },
    "session": {"stage": "screening", "stageIndex": 1, "score": 45, "status": "active", "qualityOfLife": 71},
    "health": {"qualityOfLife": 71, "energy": 58, "stress": 42, "nutrition": 66},
    "focusEvent": {
        "title": "体检发现肺部异常影像",
        "description": "报告提示肺部有异常影像。",
        "chosenChoiceId": "B",
        "choices": [{"id": "A", "text": "先观察半年"}, {"id": "B", "text": "预约低剂量螺旋 CT"}],
        "impact": {"qualityOfLife": 3, "stress": 10},
    },
    "events": [
        {"stage": "prevention", "title": "持续咳嗽", "chosenChoiceText": "预约检查"},
        {"stage": "screening", "title": "异常影像", "chosenChoiceText": "预约低剂量螺旋 CT"},
    ],
}


class TestSystemPrompt:
    def test_states_the_safety_boundary_explicitly(self):
        for phrase in ["不推荐药物", "不预测生存期", "健康教育", "咨询专业医生"]:
            assert phrase in SYSTEM_PROMPT

    def test_sets_the_players_role(self):
        # The player is a family caregiver, not a clinician — that framing is
        # what keeps the game out of medical-advice territory.
        assert "家庭健康守护者" in SYSTEM_PROMPT
        assert "不是医生" in SYSTEM_PROMPT


class TestChoicePrompt:
    def test_includes_the_patient_profile(self):
        prompt = build_choice_prompt(CONTEXT)
        assert "王先生" in prompt
        assert "55 岁" in prompt
        assert "长期吸烟" in prompt

    def test_includes_the_health_snapshot(self):
        prompt = build_choice_prompt(CONTEXT)
        assert "71/100" in prompt  # quality of life
        assert "42/100" in prompt  # stress

    def test_resolves_the_chosen_option_to_its_text(self):
        # The model needs what the player *did*, not just an opaque id.
        prompt = build_choice_prompt(CONTEXT)
        assert "预约低剂量螺旋 CT" in prompt
        assert "先观察半年" not in prompt.split("玩家的选择")[1].split("这个选择带来")[0]

    def test_includes_the_impact(self):
        prompt = build_choice_prompt(CONTEXT)
        assert "qualityOfLife +3" in prompt
        assert "stress +10" in prompt

    def test_repeats_the_boundary_near_the_generation_point(self):
        assert "再次确认边界" in build_choice_prompt(CONTEXT)


class TestSummaryPrompt:
    def test_asks_for_the_three_sections(self):
        prompt = build_summary_prompt(CONTEXT)
        for section in ["优势：", "不足：", "健康教育建议："]:
            assert section in prompt

    def test_includes_the_whole_timeline_in_order(self):
        prompt = build_summary_prompt(CONTEXT)
        assert prompt.index("持续咳嗽") < prompt.index("异常影像")

    def test_handles_an_empty_timeline(self):
        prompt = build_summary_prompt({**CONTEXT, "events": []})
        assert "(无记录)" in prompt


class TestPreferences:
    def test_absent_preferences_add_nothing(self):
        assert "你记得的事" not in build_choice_prompt(CONTEXT)

    def test_present_preferences_are_included_with_a_usage_instruction(self):
        prompt = build_choice_prompt({**CONTEXT, "preferences": ["偏好详细解释"]})
        assert "偏好详细解释" in prompt
        assert "不要直接写「我记得你" in prompt
