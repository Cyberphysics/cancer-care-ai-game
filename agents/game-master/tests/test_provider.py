"""Provider tests. No network: every HTTP call is stubbed onto `_post_json`."""

import pytest

from app import provider as provider_module
from app.config import Settings
from app.provider import BedrockProvider, DeepSeekProvider, ProviderError, build_provider


def make_settings(**overrides) -> Settings:
    defaults = dict(
        provider="deepseek",
        model_id="deepseek-chat",
        region="us-east-1",
        api_key_parameter="/test/key",
        memory_id="",
        max_tokens=500,
        temperature=0.7,
    )
    defaults.update(overrides)
    return Settings(**defaults)


class TestDeepSeekProvider:
    def test_parses_the_openai_compatible_response(self, monkeypatch):
        captured = {}

        def fake_post(url, payload, headers, timeout=60):
            captured["url"] = url
            captured["payload"] = payload
            captured["headers"] = headers
            return {"choices": [{"message": {"content": "  一段解释  "}}]}

        monkeypatch.setattr(provider_module, "_post_json", fake_post)

        provider = DeepSeekProvider("sk-test", "deepseek-chat", 500, 0.7)
        assert provider.complete("system", "user") == "一段解释"

        assert captured["url"] == "https://api.deepseek.com/chat/completions"
        assert captured["payload"]["model"] == "deepseek-chat"
        assert captured["payload"]["messages"][0]["role"] == "system"
        assert captured["headers"]["authorization"] == "Bearer sk-test"

    def test_empty_completion_is_an_error_not_an_empty_string(self, monkeypatch):
        monkeypatch.setattr(
            provider_module, "_post_json", lambda *a, **k: {"choices": [{"message": {"content": "  "}}]}
        )
        with pytest.raises(ProviderError, match="empty completion"):
            DeepSeekProvider("k", "m", 10, 0.7).complete("s", "u")

    def test_missing_choices_is_reported(self, monkeypatch):
        monkeypatch.setattr(provider_module, "_post_json", lambda *a, **k: {"error": "nope"})
        with pytest.raises(ProviderError, match="no choices"):
            DeepSeekProvider("k", "m", 10, 0.7).complete("s", "u")


class TestBuildProvider:
    def test_defaults_to_deepseek_and_reads_the_key_from_ssm(self, monkeypatch):
        monkeypatch.setattr(provider_module, "get_secure_parameter", lambda name, region: "sk-from-ssm")
        built = build_provider(make_settings())
        assert isinstance(built, DeepSeekProvider)
        assert built.api_key == "sk-from-ssm"

    def test_bedrock_selection_does_not_touch_ssm(self, monkeypatch):
        def explode(*_args):
            raise AssertionError("Bedrock must not read the DeepSeek key")

        monkeypatch.setattr(provider_module, "get_secure_parameter", explode)
        built = build_provider(make_settings(provider="bedrock", model_id="deepseek.v3.2"))
        assert isinstance(built, BedrockProvider)

    def test_unknown_provider_fails_loudly(self):
        # Silently falling back to a default would mean the thing you configured
        # is not the thing that runs.
        with pytest.raises(ProviderError, match="Unknown MODEL_PROVIDER"):
            build_provider(make_settings(provider="gpt-5"))
