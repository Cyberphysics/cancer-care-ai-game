"""Test doubles for the provider boundary.

Kept out of `test_invoke.py`, whose `FakeProvider` implements only `complete` —
that stub is the narration contract's proof and should not grow tool-calling
responsibilities.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from app.provider import ChatMessage, ChatResult, ToolSpec


@dataclass
class ScriptedProvider:
    """Returns pre-scripted results, one per call.

    A script entry is either a `ChatResult` or an exception to raise, so failure
    modes are as easy to script as successes.
    """

    script: list[Any]
    name: str = "scripted"
    model_id: str = "scripted-1"
    calls: list[dict[str, Any]] = field(default_factory=list)

    def chat(
        self,
        system: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec] | None = None,
        tool_choice: str | None = None,
        max_tokens: int | None = None,
        timeout: int | None = None,
    ) -> ChatResult:
        self.calls.append(
            {
                "system": system,
                "messages": list(messages),
                "tools": list(tools or ()),
                "tool_choice": tool_choice,
                "max_tokens": max_tokens,
                "timeout": timeout,
            }
        )
        if not self.script:
            raise AssertionError("ScriptedProvider ran out of scripted responses")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def complete(self, system: str, user: str) -> str:
        return self.chat(system, [ChatMessage(role="user", content=user)]).text


class FakeClock:
    """A clock tests advance by hand, so deadline behaviour is deterministic."""

    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds
