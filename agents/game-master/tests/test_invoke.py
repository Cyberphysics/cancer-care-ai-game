"""Entrypoint tests: the contract the game API depends on.

The game API tells the player *something* from whatever this returns, so the
handler must always return a structured dict — including on failure — rather
than raising and surfacing as an opaque 5xx.
"""

import main as agent_main
from app.provider import ProviderError
from app.safety import SAFE_FALLBACK

CONTEXT = {
    "kind": "choice",
    "playerId": "plr_1",
    "sessionId": "ses_1",
    "patient": {"displayName": "王先生", "age": 55, "gender": "male", "riskFactors": ["长期吸烟"]},
    "session": {"stage": "prevention", "stageIndex": 0, "score": 20, "status": "active", "qualityOfLife": 75},
    "health": {"qualityOfLife": 75, "energy": 59, "stress": 36, "nutrition": 65},
    "focusEvent": {
        "title": "持续咳嗽两个月",
        "description": "王先生最近持续咳嗽。",
        "chosenChoiceId": "B",
        "choices": [{"id": "A", "text": "继续观察"}, {"id": "B", "text": "预约检查"}],
        "impact": {"qualityOfLife": 5, "stress": 8},
    },
    "events": [],
}


class FakeProvider:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def complete(self, system, user):
        self.calls.append((system, user))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def patch_provider(monkeypatch, responses):
    fake = FakeProvider(responses)
    monkeypatch.setattr(agent_main, "build_provider", lambda settings: fake)
    return fake


class TestBadRequests:
    def test_non_object_payload(self):
        result = agent_main.invoke("not an object")
        assert result["ok"] is False
        assert result["errorType"] == "BadRequest"

    def test_invalid_json_string(self):
        result = agent_main.invoke("{not json")
        assert result["ok"] is False
        assert result["errorType"] == "BadRequest"

    def test_unknown_kind(self):
        result = agent_main.invoke({"kind": "freeform"})
        assert result["ok"] is False
        assert result["errorType"] == "BadRequest"
        assert "kind" in result["error"]

    def test_missing_kind(self):
        assert agent_main.invoke({})["ok"] is False


class TestSuccess:
    def test_returns_generated_text_and_metadata(self, monkeypatch):
        patch_provider(monkeypatch, ["这是一段解释。"])
        result = agent_main.invoke(CONTEXT)

        assert result["ok"] is True
        assert result["text"] == "这是一段解释。"
        assert result["kind"] == "choice"
        assert result["degraded"] is False
        assert result["provider"] and result["modelId"]
        assert result["generatedAt"].endswith("Z")

    def test_accepts_a_json_string_payload(self, monkeypatch):
        import json

        patch_provider(monkeypatch, ["可以。"])
        assert agent_main.invoke(json.dumps(CONTEXT))["ok"] is True


class TestSafetyRetry:
    def test_a_violating_first_draft_is_retried_and_replaced(self, monkeypatch):
        fake = patch_provider(monkeypatch, ["您患有肺癌，五年生存率约 30%。", "更稳妥的说法。"])
        result = agent_main.invoke(CONTEXT)

        assert result["ok"] is True
        assert result["degraded"] is False
        assert result["text"] == "更稳妥的说法。"
        # The retry must name what was wrong, not just ask again.
        assert len(fake.calls) == 2
        assert "违反项" in fake.calls[1][1]
        assert "%" not in result["text"]

    def test_persistent_violation_falls_back_and_flags_degraded(self, monkeypatch):
        patch_provider(monkeypatch, ["生存率约 30%。", "还是 30% 左右。"])
        result = agent_main.invoke(CONTEXT)

        assert result["ok"] is True
        # Flagged rather than passed off as generated analysis.
        assert result["degraded"] is True
        assert result["text"] == SAFE_FALLBACK

    def test_fallback_text_itself_passes_the_guard(self):
        # If the fallback tripped the guard, a guard failure would loop.
        from app.safety import is_safe

        assert is_safe(SAFE_FALLBACK)


class TestProviderFailure:
    def test_provider_error_is_reported_not_raised(self, monkeypatch):
        patch_provider(monkeypatch, [ProviderError("HTTP 401 from api.deepseek.com: bad key")])
        result = agent_main.invoke(CONTEXT)

        assert result["ok"] is False
        assert result["errorType"] == "ProviderError"
        assert "401" in result["error"]

    def test_unexpected_error_is_reported_not_raised(self, monkeypatch):
        patch_provider(monkeypatch, [RuntimeError("boom")])
        result = agent_main.invoke(CONTEXT)

        assert result["ok"] is False
        assert result["errorType"] == "InternalError"
