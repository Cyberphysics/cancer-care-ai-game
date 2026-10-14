"""Pluggable model providers.

The agent does not care which model answers it. That indirection is not
decorative here: Bedrock is blocked at the account level in this environment
(see docs/ARCHITECTURE.md §6.3), so the working path is DeepSeek's own API while
the Bedrock path stays available for when the allowlisting case clears.

Only the standard library is used for HTTP. `bedrock-agentcore` already pulls in
boto3 and a web stack, and every extra dependency is another chance for the
ARM64 cross-build to fail.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from .config import Settings, get_secure_parameter


class ProviderError(RuntimeError):
    """Raised when the upstream model call fails."""


class ModelProvider(Protocol):
    name: str
    model_id: str

    def complete(self, system: str, user: str) -> str: ...


#: Kept below the caller's budget (API Gateway allows ~30 s for an integration,
#: so the game API Lambda runs at 29 s). A provider timeout here surfaces as a
#: readable "provider timed out" instead of an opaque gateway 504.
DEFAULT_TIMEOUT_SECONDS = 20


def _post_json(url: str, payload: dict, headers: dict, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")[:400]
        raise ProviderError(f"HTTP {err.code} from {url}: {body}") from err
    except urllib.error.URLError as err:
        raise ProviderError(f"Could not reach {url}: {err.reason}") from err
    except json.JSONDecodeError as err:
        raise ProviderError(f"Non-JSON response from {url}") from err


@dataclass
class DeepSeekProvider:
    """DeepSeek's OpenAI-compatible chat completions endpoint."""

    api_key: str
    model_id: str
    max_tokens: int
    temperature: float
    name: str = "deepseek"
    base_url: str = "https://api.deepseek.com"

    def complete(self, system: str, user: str) -> str:
        body = _post_json(
            f"{self.base_url}/chat/completions",
            {
                "model": self.model_id,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "max_tokens": self.max_tokens,
                "temperature": self.temperature,
                "stream": False,
            },
            {"authorization": f"Bearer {self.api_key}"},
        )

        choices = body.get("choices") or []
        if not choices:
            raise ProviderError(f"DeepSeek returned no choices: {json.dumps(body)[:300]}")

        content = (choices[0].get("message") or {}).get("content") or ""
        if not content.strip():
            raise ProviderError("DeepSeek returned an empty completion")
        return content.strip()


@dataclass
class BedrockProvider:
    """Bedrock-hosted DeepSeek. Kept for when account allowlisting clears.

    Not exercised in this environment — the account is blocked before the model
    is ever reached (docs/ARCHITECTURE.md §6.3).
    """

    model_id: str
    max_tokens: int
    temperature: float
    region: str
    name: str = "bedrock"

    def complete(self, system: str, user: str) -> str:
        import boto3  # imported lazily so the DeepSeek path never needs it

        client = boto3.client("bedrock-runtime", region_name=self.region)
        try:
            response = client.converse(
                modelId=self.model_id,
                messages=[{"role": "user", "content": [{"text": user}]}],
                system=[{"text": system}],
                inferenceConfig={
                    "maxTokens": self.max_tokens,
                    "temperature": self.temperature,
                },
            )
        except Exception as err:  # botocore exceptions vary by failure mode
            raise ProviderError(f"Bedrock call failed: {err}") from err

        blocks = response.get("output", {}).get("message", {}).get("content", [])
        text = "".join(block.get("text", "") for block in blocks)
        if not text.strip():
            raise ProviderError("Bedrock returned an empty completion")
        return text.strip()


def build_provider(settings: Settings) -> ModelProvider:
    """Instantiate the configured provider.

    Read lazily rather than at import time so a misconfigured provider surfaces
    as a readable error on the first request instead of a container that never
    starts.
    """
    if settings.provider == "bedrock":
        return BedrockProvider(
            model_id=settings.model_id,
            max_tokens=settings.max_tokens,
            temperature=settings.temperature,
            region=settings.region,
        )

    if settings.provider != "deepseek":
        raise ProviderError(f"Unknown MODEL_PROVIDER: {settings.provider!r}")

    return DeepSeekProvider(
        api_key=get_secure_parameter(settings.api_key_parameter, settings.region),
        model_id=settings.model_id,
        max_tokens=settings.max_tokens,
        temperature=settings.temperature,
    )
