"""Runtime configuration for the GameMaster agent.

Everything here is read once per container and cached: the microVM is reused
across invocations, so a per-request SSM call would add latency for no benefit.
"""

from __future__ import annotations

import functools
import os
from dataclasses import dataclass

import boto3

DEFAULT_MODEL_ID = "deepseek-chat"
DEFAULT_PROVIDER = "deepseek"
DEFAULT_PARAMETER_NAME = "/cancercare-game-mvp/deepseek-api-key"


@dataclass(frozen=True)
class Settings:
    provider: str
    model_id: str
    region: str
    api_key_parameter: str
    memory_id: str
    max_tokens: int
    temperature: float

    @property
    def memory_configured(self) -> bool:
        return bool(self.memory_id)


def load_settings() -> Settings:
    """Read settings from the environment injected by CDK."""
    return Settings(
        provider=os.environ.get("MODEL_PROVIDER", DEFAULT_PROVIDER),
        model_id=os.environ.get("MODEL_ID", DEFAULT_MODEL_ID),
        region=os.environ.get("AWS_REGION", "us-east-1"),
        api_key_parameter=os.environ.get("API_KEY_PARAMETER", DEFAULT_PARAMETER_NAME),
        memory_id=os.environ.get("MEMORY_ID", ""),
        max_tokens=int(os.environ.get("MAX_TOKENS", "900")),
        temperature=float(os.environ.get("TEMPERATURE", "0.7")),
    )


@functools.lru_cache(maxsize=4)
def get_secure_parameter(name: str, region: str) -> str:
    """Fetch a SecureString from SSM Parameter Store.

    The DeepSeek key deliberately lives in Parameter Store rather than in a
    Lambda-style environment variable: environment variables on a runtime version
    are readable by anyone with control-plane read access, and they show up in
    the console. This keeps the secret out of the deployment surface entirely.

    Cached for the life of the microVM.
    """
    client = boto3.client("ssm", region_name=region)
    response = client.get_parameter(Name=name, WithDecryption=True)
    value = response.get("Parameter", {}).get("Value")
    if not value:
        raise RuntimeError(f"SSM parameter {name} is empty")
    return value
