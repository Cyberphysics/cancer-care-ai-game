"""Content guard tests.

The distinction these lock in: **concepts are allowed, prescriptions are not.**
The game's own teaching material covers targeted therapy and pathology, so a
guard that rejected those words would defeat the product. What must never reach
a player is advice aimed at them personally.
"""

from app.safety import find_violations, is_safe


class TestAllowed:
    def test_educational_concepts_pass(self):
        text = (
            "低剂量螺旋 CT 是常用的肺癌筛查手段。病理检查用于明确病变性质。"
            "靶向治疗和免疫治疗是近年来发展的治疗方向，是否适用需由医生结合具体病情判断。"
        )
        assert is_safe(text), find_violations(text)

    def test_encouraging_medical_consultation_passes(self):
        assert is_safe("建议尽快咨询专业医生，由医生评估后决定下一步检查。")

    def test_quantities_that_are_not_survival_rates_pass(self):
        # A count is not a percentage — "5 年" on its own is a duration, not a
        # prognosis, and the dosage rule must not swallow it.
        assert is_safe("治疗通常按周期进行，一个周期可能是 21 天。")


class TestRejected:
    def test_percentage_figures(self):
        assert "百分比数字（可能是生存率或治愈率）" in find_violations("五年生存率约为 32%")

    def test_survival_language_without_a_number(self):
        assert find_violations("这种情况的生存率并不乐观")

    def test_drug_names_and_dosage(self):
        assert find_violations("可以服用奥希替尼")
        assert find_violations("每日服用 80 毫克")
        assert find_violations("剂量为 500mg")

    def test_treatment_recommendation(self):
        assert find_violations("建议使用靶向治疗")
        assert find_violations("推荐服用中药调理")

    def test_diagnosis_assertion(self):
        assert find_violations("您患有早期肺癌")
        assert find_violations("确诊为肺腺癌")


class TestMultipleViolations:
    def test_all_violations_are_reported(self):
        violations = find_violations("您患有肺癌，生存率约 30%，建议服用奥希替尼")
        # Naming every broken rule is what makes the corrective retry useful —
        # a single generic "try again" fixes far less.
        assert len(violations) >= 3, violations
