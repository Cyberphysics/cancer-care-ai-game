"""Pluggable model providers.

The agent does not care which model answers it. That indirection is not
decorative here: Bedrock is blocked at the account level in this environment
(see docs/ARCHITECTURE.md §6.3), so the working path is DeepSeek's own API while
the Bedrock path stays available for when the allowlisting case clears.

Only the standard library is used for HTTP. `bedrock-agentcore` already pulls in
boto3 and a web stack, and every extra dependency is another chance for the
ARM64 cross-build to fail.

Two entry points:

- `complete(system, user) -> str` — the narration path. Unchanged, and the only
  thing the GameMaster's `choice`/`summary` roles use.
- `chat(system, messages, tools, ...) -> ChatResult` — the tool-calling path
  used by the `extract` and `question` roles.

Both are on the Protocol because narration and the tool loop are dispatched from
the same entrypoint and tests stub the provider object as a whole.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol, Sequence

from .config import Settings, get_secure_parameter


class ProviderError(RuntimeError):
    """Raised when the upstream model call fails."""


@dataclass(frozen=True)
class ToolCall:
    """One tool invocation requested by the model."""

    id: str
    name: str
    arguments: dict[str, Any]
    #: The arguments exactly as the model emitted them. Kept so a turn can be
    #: echoed back verbatim — re-serialising something we failed to parse would
    #: silently rewrite the model's own request.
    raw_arguments: str = ""


@dataclass(frozen=True)
class ChatMessage:
    """A provider-agnostic conversation turn."""

    role: str  # "user" | "assistant" | "tool"
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    #: Required when `role == "tool"`: the id of the call being answered.
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ChatResult:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()
    #: Normalised across providers: "stop" | "tool_calls" | "length".
    finish_reason: str = ""

    @property
    def truncated(self) -> bool:
        """True when the model was cut off by the token budget.

        Measured 2026-10-16: a Chinese answer truncated at `max_tokens=300`
        still returns ~550 characters, so length alone says nothing about
        completeness. The caller must check this rather than eyeball the text.
        """
        return self.finish_reason == "length"


@dataclass(frozen=True)
class ToolSpec:
    """Declaration of a tool, in JSON Schema. Adapters translate the wrapper."""

    name: str
    description: str
    parameters: dict[str, Any]


class ModelProvider(Protocol):
    name: str
    model_id: str

    def complete(self, system: str, user: str) -> str: ...

    def chat(
        self,
        system: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec] | None = None,
        #: `"auto"`, `"none"`, or the *name* of a tool to force. Adapters map
        #: this onto their own wire format.
        tool_choice: str | None = None,
        max_tokens: int | None = None,
        timeout: int | None = None,
    ) -> ChatResult: ...


#: Kept below the caller's budget (API Gateway allows ~30 s for an integration,
#: so the game API Lambda runs at 29 s). A provider timeout here surfaces as a
#: readable "provider timed out" instead of an opaque gateway 504.
#:
#: Note this is `urllib`'s timeout, which bounds *socket inactivity*, not total
#: duration — a slowly trickling response can exceed it. Callers that need a
#: wall-clock budget must enforce it themselves; see `tool_loop.py`.
DEFAULT_TIMEOUT_SECONDS = 20


def _post_json(
    url: str,
    payload: dict,
    headers: dict,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
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


def _text_only(result: ChatResult, label: str) -> str:
    """Reduce a chat result to plain text, or fail loudly.

    A tool-call turn legitimately carries no text — DeepSeek returns `""` when
    forced onto a tool, and `null` is equally legal. Treating either as an empty
    completion would report a mis-dispatched tool call as a model failure.
    """
    if result.tool_calls:
        names = ", ".join(call.name or "<unnamed>" for call in result.tool_calls)
        raise ProviderError(f"{label} returned tool calls ({names}) where text was expected")
    if not result.text.strip():
        raise ProviderError(f"{label} returned an empty completion")
    return result.text.strip()


def _parse_openai_tool_calls(raw: Any) -> tuple[ToolCall, ...]:
    """Parse OpenAI-style `tool_calls`, tolerating malformed arguments.

    `function.arguments` is a JSON *string*, not an object — the single most
    common adapter mistake.

    Unparseable arguments are deliberately NOT repaired: a silently "fixed"
    medical query is worse than a retry, and the loop feeds the raw text back to
    the model so it can correct itself.
    """
    calls: list[ToolCall] = []
    for entry in raw or []:
        function = entry.get("function") or {}
        raw_arguments = function.get("arguments") or ""
        arguments: dict[str, Any] = {}
        if raw_arguments:
            try:
                parsed = json.loads(raw_arguments)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                arguments = parsed
        calls.append(
            ToolCall(
                # An empty id is legal on the wire but useless for correlating a
                # result; the loop substitutes a synthetic one.
                id=entry.get("id") or "",
                name=function.get("name") or "",
                arguments=arguments,
                raw_arguments=raw_arguments,
            )
        )
    return tuple(calls)


# --------------------------------------------------------------------------- #
# DeepSeek
# --------------------------------------------------------------------------- #


def _deepseek_tool(tool: ToolSpec) -> dict:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }


def _deepseek_tool_choice(tool_choice: str) -> dict | str:
    if tool_choice in ("auto", "none", "required"):
        return tool_choice
    return {"type": "function", "function": {"name": tool_choice}}


def _deepseek_messages(system: str, messages: Sequence[ChatMessage]) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": system}]
    for message in messages:
        if message.role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": message.tool_call_id,
                    "content": message.content,
                }
            )
        elif message.role == "assistant" and message.tool_calls:
            out.append(
                {
                    "role": "assistant",
                    # Present but null: DeepSeek rejects an assistant turn that
                    # carries neither content nor tool calls.
                    "content": message.content or None,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.raw_arguments
                                or json.dumps(call.arguments, ensure_ascii=False),
                            },
                        }
                        for call in message.tool_calls
                    ],
                }
            )
        else:
            out.append({"role": message.role, "content": message.content})
    return out


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
        return _text_only(
            self.chat(system, [ChatMessage(role="user", content=user)]),
            "DeepSeek",
        )

    def chat(
        self,
        system: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec] | None = None,
        tool_choice: str | None = None,
        max_tokens: int | None = None,
        timeout: int | None = None,
    ) -> ChatResult:
        body: dict[str, Any] = {
            "model": self.model_id,
            "messages": _deepseek_messages(system, messages),
            # Deliberately left at the configured ceiling. Lowering this does not
            # buy latency (measured 2026-10-16: 300/400/900 tokens all land
            # within 3.0-3.8 s) and it truncates answers mid-sentence.
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": self.temperature,
            "stream": False,
        }

        if tools:
            body["tools"] = [_deepseek_tool(tool) for tool in tools]
            if tool_choice is not None:
                body["tool_choice"] = _deepseek_tool_choice(tool_choice)
            # `parallel_tool_calls: false` is accepted and then ignored by
            # DeepSeek — measured 2026-10-16, two calls still came back with it
            # set. It is not sent: config that reads as a guarantee while doing
            # nothing is worse than no config. The loop answers every call id.

        payload = _post_json(
            f"{self.base_url}/chat/completions",
            body,
            {"authorization": f"Bearer {self.api_key}"},
            timeout=timeout or DEFAULT_TIMEOUT_SECONDS,
        )

        choices = payload.get("choices") or []
        if not choices:
            raise ProviderError(f"DeepSeek returned no choices: {json.dumps(payload)[:300]}")

        choice = choices[0]
        message = choice.get("message") or {}
        return ChatResult(
            # `content` is `""` when forced onto a tool and may be `null` as
            # well; both mean "no text", and neither is an empty completion.
            text=message.get("content") or "",
            tool_calls=_parse_openai_tool_calls(message.get("tool_calls")),
            finish_reason=choice.get("finish_reason") or "",
        )


# --------------------------------------------------------------------------- #
# Bedrock
# --------------------------------------------------------------------------- #


_BEDROCK_FINISH_REASONS = {
    "tool_use": "tool_calls",
    "end_turn": "stop",
    "max_tokens": "length",
}


def _bedrock_tool_choice(tool_choice: str) -> dict | None:
    if tool_choice == "none":
        # Bedrock has no "none"; omitting toolChoice is the equivalent, and the
        # model answers in text.
        return None
    if tool_choice in ("auto", "required"):
        return {"auto": {}}
    return {"tool": {"name": tool_choice}}


def _bedrock_messages(messages: Sequence[ChatMessage]) -> list[dict]:
    """Translate turns, merging consecutive tool results into one user turn.

    Bedrock requires *every* `toolUseId` from an assistant turn to be answered in
    the single user turn that follows it. The loop emits one result per call, so
    merging here keeps that requirement out of the loop's control flow.
    """
    out: list[dict] = []
    pending_results: list[dict] = []

    def flush_results() -> None:
        if pending_results:
            out.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for message in messages:
        if message.role == "tool":
            pending_results.append(
                {
                    "toolResult": {
                        "toolUseId": message.tool_call_id,
                        "content": [{"text": message.content}],
                    }
                }
            )
            continue

        flush_results()

        if message.role == "assistant" and message.tool_calls:
            content: list[dict] = []
            if message.content:
                content.append({"text": message.content})
            content.extend(
                {
                    "toolUse": {
                        "toolUseId": call.id,
                        "name": call.name,
                        # Already a mapping on this side — no JSON string to parse.
                        "input": call.arguments,
                    }
                }
                for call in message.tool_calls
            )
            out.append({"role": "assistant", "content": content})
        else:
            out.append({"role": message.role, "content": [{"text": message.content}]})

    flush_results()
    return out


@dataclass
class BedrockProvider:
    """Bedrock-hosted models. Kept for when account allowlisting clears.

    Not exercised in this environment — the account is blocked before the model
    is ever reached (docs/ARCHITECTURE.md §6.3).
    """

    model_id: str
    max_tokens: int
    temperature: float
    region: str
    name: str = "bedrock"

    def complete(self, system: str, user: str) -> str:
        return _text_only(
            self.chat(system, [ChatMessage(role="user", content=user)]),
            "Bedrock",
        )

    def chat(
        self,
        system: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec] | None = None,
        tool_choice: str | None = None,
        max_tokens: int | None = None,
        timeout: int | None = None,
    ) -> ChatResult:
        import boto3  # imported lazily so the DeepSeek path never needs it

        request: dict[str, Any] = {
            "modelId": self.model_id,
            "messages": _bedrock_messages(messages),
            "system": [{"text": system}],
            "inferenceConfig": {
                "maxTokens": max_tokens or self.max_tokens,
                "temperature": self.temperature,
            },
        }

        if tools:
            tool_config: dict[str, Any] = {
                "tools": [
                    {
                        "toolSpec": {
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": {"json": tool.parameters},
                        }
                    }
                    for tool in tools
                ]
            }
            chosen = _bedrock_tool_choice(tool_choice) if tool_choice is not None else None
            if chosen is not None:
                tool_config["toolChoice"] = chosen
            request["toolConfig"] = tool_config

        client = boto3.client("bedrock-runtime", region_name=self.region)
        try:
            response = client.converse(**request)
        except Exception as err:  # botocore exceptions vary by failure mode
            raise ProviderError(f"Bedrock call failed: {err}") from err

        return _bedrock_result(response)


def _bedrock_result(response: dict) -> ChatResult:
    blocks = response.get("output", {}).get("message", {}).get("content", []) or []
    text = "".join(block.get("text", "") for block in blocks)

    calls: list[ToolCall] = []
    for block in blocks:
        use = block.get("toolUse")
        if not use:
            continue
        calls.append(
            ToolCall(
                id=use.get("toolUseId") or "",
                name=use.get("name") or "",
                # Bedrock hands back a mapping, not a JSON string.
                arguments=use.get("input") or {},
            )
        )

    stop = response.get("stopReason") or ""
    return ChatResult(
        text=text,
        tool_calls=tuple(calls),
        finish_reason=_BEDROCK_FINISH_REASONS.get(stop, stop),
    )


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
