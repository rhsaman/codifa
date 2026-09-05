"""LangChain chat-model factory.

Maps a provider-config to a LangChain ``BaseChatModel`` so the LangGraph
orchestration can call any OpenAI-compatible / Google / OpenRouter gateway
through one interface.

It reuses the SAME provider configuration that the rest of the app already
reads (``providers._provider_meta``, ``normalize_base_url``, ``env_key``,
``OPENCODE_UA``, ``model_timeout``, ...), so the user's Settings → Providers
entries keep working unchanged.

Reasoning / User-Agent / cache handling is reproduced with the equivalents
LangChain supports:

* opencode zen gateway UA spoof -> ``default_headers``.
* OpenRouter prompt-cache breakpoints -> ``default_headers`` (best-effort).
* DeepSeek reasoning round-trip -> LangChain's OpenAI client already handles
  ``reasoning_content`` natively, so no custom backfill is needed.
* thinking level -> ``model_kwargs["reasoning_effort"]`` for auto-think gateways.

This is intentionally a faithful-but-essential mapping: exotic providers with
very specific header requirements can be extended here without touching the
graph or the tools.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any

_logger = logging.getLogger(__name__)

from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI

from _common import (
    _THINKING_LEVELS,
    _extract_cache_tokens,
    _extract_reasoning_tokens,
    _is_repeating,
    _strip_think_tags,
)
from providers import (
    OPENCODE_UA,
    _provider_meta,
    env_key,
    is_opencode,
    model_timeout,
    normalize_base_url,
    qualify_model_id,
)

# _strip_think_tags و _is_repeating از _common import می‌شوند (single source of truth).

# _THINKING_LEVELS از _common import می‌شود (single source of truth).


class ReasoningChatOpenAI(ChatOpenAI):
    """ChatOpenAI that normalizes gateway-specific reasoning fields.

    Some OpenAI-compatible gateways (notably opencode) stream chain-of-thought
    under ``delta.reasoning`` instead of the ``reasoning_content`` field
    LangChain expects. ``langchain-openai`` (≤1.6) silently drops
    ``delta.reasoning`` (and even ``delta.reasoning_content`` in the Chat
    Completions path), so the thinking text would otherwise leak into the
    visible ``content`` stream.

    This subclass lifts any reasoning text found in ``delta.reasoning`` /
    ``delta.reasoning_content`` onto ``AIMessageChunk.additional_kwargs`` so the
    backend's existing ``_thinking_from_chunk`` filter can drop it before it
    reaches the frontend. We patch the *output* message chunk (not the raw
    ``delta``) because the parent parser ignores ``reasoning_content`` entirely
    and would otherwise discard our backfill.

    It also de-duplicates per-chunk token usage: some gateways (TokenRouter /
    opencode providers) include the FULL ``usage`` block in EVERY SSE chunk
    instead of only the final one (the OpenAI spec). LangChain's chunk merge
    (``AIMessageChunk.__add__`` → ``add_usage``) SUMS usage across chunks, so a
    350-chunk reply with a real 14K-token request would be reported as ~4.9M
    input tokens — inflating the sidebar totals, the context meter and firing
    spurious auto-compactions. Here we drop ``usage`` from non-terminal chunks
    (keeping it only on the final usage-only chunk or any chunk carrying a
    ``finish_reason``) so the merged ``usage_metadata`` always equals exactly
    one request's true usage.
    """

    @staticmethod
    def _chunk_is_terminal(chunk: dict) -> bool:
        """True when a raw SSE chunk may legitimately carry final usage.

        The OpenAI streaming spec sends usage once, on a terminal chunk: either
        the final usage-only chunk (``choices`` empty) or a chunk whose choice
        carries ``finish_reason``. Some gateways attach usage to ordinary
        mid-stream deltas too — those are the ones this filter must reject.
        """
        if not isinstance(chunk, dict):
            return False
        choices = chunk.get("choices")
        if not choices:
            return True
        for choice in choices:
            if isinstance(choice, dict) and choice.get("finish_reason"):
                return True
        return False

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> Any:
        if (
            isinstance(chunk, dict)
            and chunk.get("usage") is not None
            and not self._chunk_is_terminal(chunk)
        ):
            # Mid-stream chunk carrying the gateway's running/full usage —
            # dropping it here prevents add_usage() from summing it into an
            # N-chunks-inflated total. A terminal usage chunk still passes.
            chunk = {k: v for k, v in chunk.items() if k != "usage"}
        generation_chunk = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation_chunk is None:
            return None
        # Pull reasoning text out of the raw delta (the parent parser drops it).
        raw_reasoning: str | None = None
        if isinstance(chunk, dict):
            for choice in chunk.get("choices") or []:
                delta = (choice or {}).get("delta")
                if not isinstance(delta, dict):
                    continue
                # Prefer an explicit reasoning_content, fall back to delta.reasoning
                # (opencode's wire format). opencode may send reasoning AND content
                # in the same delta, so we no longer skip reasoning when content is
                # present — both are lifted onto additional_kwargs and the backend's
                # _thinking_from_chunk filter drops the reasoning before the frontend.
                rc = delta.get("reasoning_content")
                if isinstance(rc, str) and rc:
                    raw_reasoning = rc
                elif delta.get("reasoning") is not None:
                    raw_reasoning = str(delta["reasoning"])
                if raw_reasoning:
                    break
        if raw_reasoning:
            message = generation_chunk.message
            ak = dict(getattr(message, "additional_kwargs", {}) or {})
            # Only set when not already populated, to avoid clobbering a gateway
            # that already surfaces reasoning through additional_kwargs.
            if not ak.get("reasoning_content"):
                ak["reasoning_content"] = raw_reasoning
                with contextlib.suppress(Exception):
                    message.additional_kwargs = ak
        return generation_chunk


class ProviderError(RuntimeError):
    """Raised when a provider configuration is unusable (no key, no model)."""


def resolve_key(
    provider: str,
    api_key: str,
    env_var: str = "",
    oauth_token: str = "",
) -> str:
    """Resolve the effective credential (OAuth > api_key > env chain)."""
    return oauth_token or api_key or env_key(provider=provider, env_var=env_var) or ""


def _extra_headers(
    provider: str, base_url: str, cache: bool, session_id: str = ""
) -> dict[str, str]:
    """Best-effort request headers (UA spoof + OpenRouter cache/session)."""
    headers: dict[str, str] = {}
    if is_opencode(provider, base_url) or _provider_meta(provider).get("ua_spoof"):
        headers["User-Agent"] = OPENCODE_UA
    if cache and _provider_meta(provider).get("cache_headers"):
        # OpenRouter honours cache breakpoints via Anthropic-style headers; we
        # ask it to cache the system prompt + tool definitions + last message.
        headers["x-openrouter-cache"] = "true"
    if session_id and _provider_meta(provider).get("model_class") == "openrouter":
        # Sticky routing: OpenRouter derives the cache key from the FIRST
        # system+user messages by default; agent loops mutate the transcript
        # every step, so that hash drifts and cache hits vanish. A stable
        # per-chat session id keeps the prompt cache warm across the whole
        # conversation (docs: "For agent loops, set session_id").
        headers["x-session-id"] = session_id
    return headers


def _thinking_kwargs(
    provider: str,
    model: str,
    thinking_level: str,
    model_reasoning: bool = False,
) -> dict[str, Any]:
    """Return ``model_kwargs`` carrying the reasoning effort, or {} when off.

    The reasoning effort is sent when EITHER:
      * the provider is a cloud gateway flagged ``auto_think`` (OpenRouter,
        opencode, NVIDIA, Cloudflare, TokenRouter), OR
      * the selected model is explicitly reasoning-capable (``model_reasoning``
        True) — this covers local/custom providers (ollama ``deepseek-r1``,
        a custom OpenAI-compatible endpoint running a reasoning model) that
        don't carry the cloud ``auto_think`` flag.
    """
    level = _THINKING_LEVELS.get((thinking_level or "").strip())
    if level is None or level is False:
        return {}
    if not (_provider_meta(provider).get("auto_think") or model_reasoning):
        return {}
    # deepseek-reasoner / deepseek-r1 expose reasoning via `reasoning_effort`.
    # Other auto-think gateways (openrouter/openai) accept the same field with
    # vendor-specific vocabulary; passing it is a no-op on models that ignore it.
    return {"reasoning_effort": level}


def _is_anthropic_model(model: str) -> bool:
    """True for Anthropic model ids on OpenRouter (``anthropic/claude-*`` or a
    bare ``claude-*``). Used to gate Anthropic-only request params (prompt
    caching) so other models never receive them."""
    m = (model or "").lower()
    return m.startswith(("anthropic/", "claude"))


def build_chat_model(
    provider: str,
    model: str,
    base_url: str = "",
    api_key: str = "",
    env_var: str = "",
    oauth_token: str = "",
    *,
    temperature: float = 0.0,
    max_tokens: int = 0,
    thinking_level: str = "",
    model_reasoning: bool = False,
    timeout: float = 0,
    cache: bool = False,
    session_id: str = "",
) -> Any:
    """Build a LangChain chat model for the given provider configuration.

    Mirrors ``providers.build_model``'s resolution (qualify id, credential
    chain, UA spoof, reasoning) but returns a ``BaseChatModel``.

    ``model_reasoning`` is the per-model capability flag (from the provider's
    ``/models`` ``reasoning`` field). It lets local / custom providers that
    don't carry the cloud ``auto_think`` flag still receive a reasoning effort
    when the selected model is known to support reasoning (e.g. ollama's
    ``deepseek-r1``).
    """
    if not model:
        raise ProviderError("no model selected")
    meta = _provider_meta(provider)
    model = qualify_model_id(provider, model)
    key = resolve_key(provider, api_key, env_var, oauth_token)
    if meta.get("requires_key") and not key:
        raise ProviderError(
            f"No {meta.get('name', provider)} credential configured. Open Settings "
            f"→ Providers → {meta.get('name', provider)} and set an API key / "
            "environment variable."
        )

    model_class = meta.get("model_class") or "openai"
    headers = _extra_headers(provider, base_url, cache, session_id)
    to = model_timeout(provider=provider, total=timeout or 900)
    # LangChain's ChatOpenAI only accepts a SCALAR `timeout` (total seconds);
    # passing an `httpx.Timeout` object is silently ignored, leaving the request
    # with no timeout (it hangs until the client gives up). Use the scalar total.
    # Default raised to 900s so a single model step that thinks silently for up
    # to 15 min is not cut off (the old 300s ceiling killed long reasoning/slow
    # provider steps mid-turn).
    lc_timeout = timeout or 900
    tkwargs = _thinking_kwargs(provider, model, thinking_level, model_reasoning)
    reasoning_effort = tkwargs.pop("reasoning_effort", None)
    # parallel_tool_calls is intentionally NOT sent. opencode also doesn't
    # send it, and several OpenRouter free-tier models (e.g.
    # minimax/minimax-m3:free) reject it with 400 — which would kill every
    # turn. If a future provider really needs it, set it explicitly in
    # tkwargs here; the strip-on-400 retry path in graph._run_mode_turn will
    # also handle any model that flips between supporting and not supporting
    # the field.
    # if meta.get("parallel_calls"):
    #     tkwargs["parallel_tool_calls"] = True
    # Ask OpenAI-compatible providers to return token usage on the final streamed
    # chunk. Without this, streaming responses omit usage and `usage_metadata`
    # stays None, so no `usage` event is emitted and the sidebar shows no cost /
    # the title bar shows no consumed context. This now applies to LOCAL servers
    # too (llama.cpp / LM Studio / Ollama all accept `include_usage` and return
    # token counts) so the context meter reflects local-model usage. If a server
    # genuinely rejects the param, the runner retries once without it (see the
    # stream_options fallback in graph.py / llm_generate).
    if model_class != "google":
        tkwargs["stream_options"] = {"include_usage": True}
    base = normalize_base_url(provider, base_url)

    if model_class == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI

        # Gemini doesn't accept OpenAI's `reasoning_effort`; it uses a numeric
        # `thinking_budget` (tokens). Map the same effort levels to budgets so
        # the UI's thinking slider actually steers Gemini reasoning depth.
        # (Gemini 2.5+ exposes thinking; older models ignore the field.)
        google_thinking: dict[str, int] = {
            "minimal": 1024,
            "low": 4096,
            "medium": 12288,
            "high": 32768,
        }
        thinking_budget = google_thinking.get((thinking_level or "").strip())
        return ChatGoogleGenerativeAI(
            model=model.removeprefix("models/") or model,
            google_api_key=key or None,
            temperature=temperature,
            max_output_tokens=max_tokens or None,
            streaming=True,
            timeout=to if isinstance(to, (int, float)) else None,
            thinking_budget=thinking_budget,
        )

    # stream_chunk_timeout: maximum seconds between two consecutive streaming
    # chunks.  The default in langchain_openai is 120 s, which is too aggressive
    # for slow providers (e.g. minimax-m3 can pause > 2 min while the model
    # thinks silently).  Allow overriding via env; 150 s is a safe default.
    _chunk_timeout = int(os.environ.get("STREAM_CHUNK_TIMEOUT", "150"))
    lc_kwargs: dict[str, Any] = {
        "model": model,
        "openai_api_base": base or None,
        "openai_api_key": key or "sk-noauth",
        "temperature": temperature,
        "max_tokens": max_tokens or None,
        "streaming": True,
        "timeout": lc_timeout,
        "stream_chunk_timeout": _chunk_timeout,
        "model_kwargs": tkwargs,
        "default_headers": headers or None,
    }
    if reasoning_effort is not None:
        lc_kwargs["reasoning_effort"] = reasoning_effort
    # ── Anthropic prompt caching on OpenRouter ──────────────────────────
    # OpenRouter supports automatic caching for Anthropic models via a
    # TOP-LEVEL `cache_control` field: the breakpoint is applied to the last
    # cacheable block and moves forward as the conversation converges — no
    # per-message markers needed. Only enabled for openrouter+anthropic so
    # local/custom (Qwen, llama.cpp) and Google models are untouched.
    if (
        cache
        and model_class == "openrouter"
        and _is_anthropic_model(model)
    ):
        lc_kwargs["extra_body"] = {"cache_control": {"type": "ephemeral"}}
    # Use the reasoning-normalizing subclass so gateways that stream thinking
    # under delta.reasoning (opencode) don't leak it into the visible content.
    return ReasoningChatOpenAI(**lc_kwargs)


# opencode's OUTPUT_TOKEN_MAX (packages/opencode/src/provider/transform.ts):
# when a model's real output limit is unknown, assume 32k -- NOT a ctx-derived
# 8192 clamp. The old 128k ceiling let max_tokens balloon past the window and
# the old 8192 fallback clamped small windows so models truncated ("context
# length exceeded") even on an empty context.
_MAX_OUTPUT_TOKENS = 32_000


def _is_local_provider(provider: str, base_url: str) -> bool:
    """True when the model server is local (llama.cpp / LM Studio / Ollama),
    so we avoid sending cloud-only request params (e.g. ``stream_options``)
    that would otherwise 400."""
    if provider in ("ollama", "local"):
        return True
    if provider == "custom" and base_url:
        host = base_url.split("://", 1)[-1].split("/", 1)[0].split(":")[0]
        if host in ("localhost", "127.0.0.1", ""):
            return True
    return False


def _strip_stream_options(model: Any) -> Any:
    """Return a copy of ``model`` with ``stream_options`` removed.

    Some local OpenAI-compatible servers reject ``stream_options`` even though
    most (llama.cpp / LM Studio / Ollama) accept or ignore it. If a request
    still 400s we retry the turn with a clone built without that param. Falls
    back to the original model if cloning fails for any reason.
    """
    try:
        clone = model.model_copy(deep=False)
    except Exception:  # noqa: BLE001
        return model
    mk = dict(getattr(clone, "model_kwargs", None) or {})
    if "stream_options" in mk:
        mk = {k: v for k, v in mk.items() if k != "stream_options"}
        try:
            clone.model_kwargs = mk
        except Exception:  # noqa: BLE001, S110
            pass
    so = getattr(clone, "stream_options", None)
    if so is not None:
        try:
            clone.stream_options = None
        except Exception:  # noqa: BLE001, S110
            pass
    return clone


def _is_stream_options_error(exc: Exception) -> bool:
    """True when an exception is a 4xx caused by an unsupported ``stream_options``
    param (so the runner can retry once without it)."""
    msg = str(exc).lower()
    if "stream_options" in msg and (
        "400" in msg
        or "unsupported" in msg
        or "not supported" in msg
        or "additionalproperties" in msg
        or "additional properties" in msg
    ):
        return True
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    return bool(status == 400 and "stream_options" in msg)


def _is_parallel_calls_error(exc: Exception) -> bool:
    """True when an exception is a 4xx that LOOKS LIKE an unsupported
    ``parallel_tool_calls`` request field. Some free-tier OpenRouter models
    (e.g. ``minimax/minimax-m3:free``) reject the field with 400 — opencode
    routes the same model without it and works fine. The runner retries once
    with the field stripped instead of failing the whole turn.

    Detection strategy: any 400 that doesn't unambiguously identify itself
    as a different kind of bad-request (invalid API key, invalid model id,
    context length exceeded, etc.) is treated as a possible
    parallel_tool_calls rejection, since that field is the one most commonly
    sent-but-unsupported across OpenRouter's free-tier models. The
    conservative fallback: if the field is set on the model and we got a
    400, strip and retry — the cost of one extra round-trip is much lower
    than killing the whole turn.
    """
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    if status is None:
        # LangChain HTTP errors often don't carry status_code on the exception
        # itself — the status is embedded in the text. Parse it from the
        # string. Match both `Error code: 400` (openai SDK) and `code: 400` /
        # `status_code: 400` forms.
        import re

        m = re.search(r"(?:error\s+code|status_code|code)[:=\s]+(\d{3})", str(exc))
        if m:
            try:
                status = int(m.group(1))
            except (TypeError, ValueError):
                status = None
    if status != 400:
        return False
    msg = str(exc).lower()
    # The error explicitly names parallel_tool_calls (most specific case).
    if "parallel_tool_calls" in msg:
        return True
    # The error doesn't identify another specific cause — and we only enter
    # this branch when the model actually has parallel_tool_calls enabled.
    # Falling through here is safe because the retry path strips a single
    # non-essential OpenAI field, not a real bad-request param.
    return any(
        phrase in msg
        for phrase in (
            "provider returned error",  # OpenRouter generic wrapper
            "backend request failed",  # OpenRouter upstream wrapper
            "backend_error",  # explicit error type
        )
    )


def _strip_parallel_calls(model: Any) -> Any:
    """Return a copy of ``model`` with ``parallel_tool_calls`` removed from
    model_kwargs. Mirrors ``_strip_stream_options`` for the same class of
    "free-tier model rejects a non-essential OpenAI field" failure."""
    try:
        clone = model.model_copy(deep=False)
    except Exception:  # noqa: BLE001
        return model
    mk = dict(getattr(clone, "model_kwargs", None) or {})
    if "parallel_tool_calls" in mk:
        mk = {k: v for k, v in mk.items() if k != "parallel_tool_calls"}
        try:
            clone.model_kwargs = mk
        except Exception:  # noqa: BLE001, S110
            pass
    pa = getattr(clone, "parallel_tool_calls", None)
    if pa is not None:
        try:
            clone.parallel_tool_calls = None
        except Exception:  # noqa: BLE001, S110
            pass
    return clone


async def chat_model_settings(
    mode: str,
    ctx: int,
    thinking_level: str,
    provider: str,
    model_name: str,
    base_url: str,
    api_key: str,
    env_var: str = "",
    oauth_token: str = "",
    scope: str = "",
) -> dict[str, Any]:
    """Compute LangChain-compatible model kwargs from mode + context window.

    Port of ``agents._settings_for``'s essential behavior: per-mode temperature,
    a context-derived ``max_tokens`` cap, thinking level, UA/cache headers, and
    parallel-tool-calls flag. Heavy reasoning/usage bookkeeping is dropped (the
    LangGraph runner tracks usage itself).
    """
    temp = {"ask": 0.4, "plan": 0.3, "coder": 0.2}.get(mode, 0.4)

    max_output = 0
    try:
        from providers import model_max_output

        max_output = await model_max_output(
            provider, model_name, base_url, api_key, env_var, oauth_token=oauth_token
        )
    except Exception:  # noqa: BLE001
        max_output = 0
    if max_output > 0:
        max_tokens = min(max_output, _MAX_OUTPUT_TOKENS)
    else:
        # opencode: unknown output limit -> OUTPUT_TOKEN_MAX (32k), never ctx//4.
        # The old `min(max(1024, ctx // 4), 8192)` clamped small windows to 8k and
        # made models truncate ("context length exceeded") even on an empty context.
        max_tokens = _MAX_OUTPUT_TOKENS
    if mode == "ask":
        max_tokens = min(max_tokens, 8_000)
    if scope == "narrow":
        max_tokens = min(max_tokens, max(2_048, max_tokens // 2))

    return {
        "temperature": temp,
        "max_tokens": max_tokens,
        "thinking_level": thinking_level,
        "parallel_calls": bool(_provider_meta(provider).get("parallel_calls")),
        "cache": bool(_provider_meta(provider).get("cache_headers")),
    }


# ---------------------------------------------------------------------------
# Shared LangChain execution helpers (one-shot completion + tool loop)
# ---------------------------------------------------------------------------

import inspect

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_core.tools import StructuredTool

# The hard step-limit prompt is defined once in agents.py (kept in English on
# purpose) and reused here so the sub-agent loop mirrors the main loop's
# isLastStep guardrail. agents.py only imports llm lazily (inside functions),
# so this top-level import does not create a circular dependency.
from agents import (
    _MAX_STEPS_PROMPT,
    _compact_history,
    _estimate_tokens,
    _messages_to_dicts,
    _model_max_output,
    _usable_tokens,
)

# Mirrors graph.py's `_SEQUENTIAL_TOOLS` (duplicated, not imported, to avoid a
# circular import -- graph.py imports FROM this module). Mutating / blocking
# tool calls run one at a time; everything else may run concurrently. See the
# comment on graph.py's `_SEQUENTIAL_TOOLS` for the full rationale.
_SEQUENTIAL_TOOLS = {
    "write_file",
    "edit_file",
    "run_terminal",
    "confirm_action",
    "memory",
    "create_skill",
    "create_mcp",
    "ask_user",
}


async def llm_generate(
    model: Any,
    *,
    system: str = "",
    user: str,
    images: list[str] | None = None,
    sub: bool = False,
    provider: str = "",
) -> tuple[str, dict | None]:
    """Run a single LLM completion (no tools).

    Returns ``(text, usage_event)`` where ``usage_event`` is a SSE ``usage``
    dict (or ``None``). ``model`` is a LangChain ``BaseChatModel``. Vision
    requests pass ``images`` (data/base64 URIs) as image content parts.
    """
    model_name = str(getattr(model, "model_name", "") or "")
    msgs: list[Any] = []
    if system:
        msgs.append(SystemMessage(content=system))
    if images:
        content: list[dict] = [
            {"type": "image_url", "image_url": {"url": u}} for u in images
        ]
        content.append({"type": "text", "text": user})
        msgs.append(HumanMessage(content=content))
    else:
        msgs.append(HumanMessage(content=user))
    try:
        res = await model.ainvoke(msgs)
    except Exception as exc:
        # Some local servers reject `stream_options`; retry once without it.
        if _is_stream_options_error(exc):
            model = _strip_stream_options(model)
            res = await model.ainvoke(msgs)
        else:
            raise
    content = getattr(res, "content", "")
    if isinstance(content, list):
        text = "".join(
            p.get("text", "")
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
        text = text or str(content)
    else:
        text = str(content or "")
    usage = usage_event(
        getattr(res, "usage_metadata", None),
        model=model_name,
        sub=sub,
        provider=provider,
    )
    return text, usage


async def llm_complete(
    model: Any,
    *,
    system: str = "",
    user: str,
    images: list[str] | None = None,
) -> tuple[str, dict | None]:
    """Run a single LLM completion (no tools) and return ``(text, usage_event)``.

    The usage event (or ``None``) is surfaced so callers that summarize/compact
    can accrue those tokens into the session total instead of silently dropping
    them.
    """
    return await llm_generate(model, system=system, user=user, images=images)


def strip_orphaned_tool_calls(msgs: list, logger: Any = None) -> list:
    """Drop tool_calls with no matching ToolMessage, in place.

    A provider rejects the transcript with a 400 "missing results for
    tool_call_id(s)" when an AIMessage carries a tool_calls block whose
    results are absent (compaction split a step, a resume checkpoint lost
    tool results, …). This pre-flight guard strips such calls so the text
    content is still visible to the model.

    The call lives in FOUR places on the message, and every one must be
    cleared or it leaks back onto the wire:

    * ``tool_calls`` — the normalized list (what most code reads).
    * ``invalid_tool_calls`` — malformed variants; serialized alongside.
    * ``tool_call_chunks`` — AIMessageChunk's raw stream fragments; the
      ``init_tool_calls`` validator re-derives ``tool_calls`` from them on
      every ``model_copy``, so clearing only ``tool_calls`` is undone.
    * ``additional_kwargs["tool_calls"]`` — the raw provider-format list;
      ``_convert_message_to_dict`` falls back to it when ``tool_calls`` is
      empty, so it silently re-enters the payload.

    Returns the (same) list for convenience.
    """
    answered = {
        m.tool_call_id
        for m in msgs
        if isinstance(m, ToolMessage) and m.tool_call_id
    }
    for i in range(len(msgs)):
        m = msgs[i]
        if not isinstance(m, AIMessage):
            continue
        all_tcs = list(m.tool_calls or [])
        inv_tcs = list(getattr(m, "invalid_tool_calls", None) or [])
        chunk_tcs = list(getattr(m, "tool_call_chunks", None) or [])
        all_ids = {tc.get("id") for tc in all_tcs if tc.get("id")}
        all_ids |= {tc.get("id") for tc in inv_tcs if tc.get("id")}
        for c in chunk_tcs:
            cid = getattr(c, "id", None) or (c.get("id") if isinstance(c, dict) else None)
            if cid:
                all_ids.add(cid)
        missing = {tid for tid in all_ids if tid not in answered}
        if not missing:
            continue
        if logger is not None:
            logger.warning(
                "pre-flight guard: stripping %d orphaned tool_calls (ids: %s) "
                "from assistant message",
                len(missing),
                sorted(missing),
            )
        update: dict[str, Any] = {
            "tool_calls": [tc for tc in all_tcs if tc.get("id") not in missing],
        }
        if inv_tcs:
            update["invalid_tool_calls"] = [
                tc for tc in inv_tcs if tc.get("id") not in missing
            ]
        chunks = getattr(m, "tool_call_chunks", None) or []
        if chunks:
            update["tool_call_chunks"] = [
                c for c in chunks
                if (c.get("id") if isinstance(c, dict) else getattr(c, "id", None)) not in missing
            ]
        kw = dict(getattr(m, "additional_kwargs", None) or {})
        if "tool_calls" in kw:
            update["additional_kwargs"] = {
                k: v for k, v in kw.items() if k != "tool_calls"
            }
        msgs[i] = m.model_copy(update=update)
    return msgs


async def langchain_tool_loop(
    model: Any,
    *,
    system: str = "",
    user: str,
    tools: dict[str, Any],
    max_steps: int = 24,
    ctx: int = 0,
    compact_model: Any = None,
    reserved: int | None = None,
    emit: Any = None,
    provider: str = "",
) -> str:
    """Run a bounded tool-calling loop on a LangChain model.

    ``tools`` is a ``{name: callable}`` mapping (sync or async). Returns the
    final textual reply. Used by sub-agents (general/task) that need tools.

    Read-only tool calls requested in the same step run CONCURRENTLY via
    ``asyncio.gather`` (matching opencode's Promise.all); mutating/blocking
    tools run sequentially. See ``_SEQUENTIAL_TOOLS``.
    """
    lc_tools = [
        StructuredTool.from_function(
            func=fn, name=name, description=(fn.__doc__ or name)
        )
        for name, fn in tools.items()
    ]

    async def _exec(tc):
        """Execute a single tool call; never raises (errors become a result string)."""
        name = tc.get("name") or ""
        args = tc.get("args") or {}
        fn = tools.get(name)
        if fn is None:
            return f"ERROR: unknown tool {name!r}"
        try:
            r = fn(**(args or {}))
            if inspect.isawaitable(r):
                r = await r
            return r
        except Exception as exc:  # noqa: BLE001
            return f"ERROR running {name}: {exc}"

    msgs: list[Any] = []
    # Safety net: some chat templates (e.g. Qwen3.5 / llama.cpp) crash with
    # "System message must be at the beginning" if msgs[0] is a HumanMessage.
    # Callers like ``graph._read`` pass ``system=""`` explicitly; without this
    # guard the ``if system:`` check below would skip the SystemMessage and
    # msgs[0] would become HumanMessage. Fall back to a minimal placeholder
    # so the template parser stays happy. Sub-agents don't share prefix cache
    # with the main agent, so this has no cache cost.
    if not system:
        system = "You are a helpful assistant."
    if system:
        msgs.append(SystemMessage(content=system))
    msgs.append(HumanMessage(content=user))
    steps = 0
    # opencode's doom-loop guard: if the model issues the SAME tool call (same
    # name + same args) N times in a row, it is stuck in a loop — stop burning
    # tokens and force it to report findings instead.
    _last_call_sig = None
    _same_call_streak = 0
    _DOOM_LOOP_LIMIT = 3
    _TOOL_CALL_SOFT_LIMIT = 8
    _tool_call_count = 0
    while steps < max_steps:
        steps += 1
        # Hard guardrail (opencode's isLastStep -> MAX_STEPS_PROMPT): on the
        # final allowed step, force the sub-agent to stop tool-calling and
        # summarize instead of burning more reads/searches.
        if steps >= max_steps:
            msgs.append(AIMessage(content=_MAX_STEPS_PROMPT))
        # ── Pre-flight orphan guard (shared with graph.py) ───────────────
        # Strip tool_calls from any AIMessage whose results are missing, so
        # the provider never sees a tool_calls block without matching
        # ToolMessages (which causes a 400 "missing results for
        # tool_call_id(s)" validation error).
        strip_orphaned_tool_calls(msgs, _logger)
        ai = await model.bind_tools(lc_tools).ainvoke(msgs)
        # Surface the sub-agent's own token usage so the frontend can accrue it
        # into the chat-wide session totals (the "Model usage" sidebar). The
        # main-agent loop emits usage from agents.py; sub-agents run through this
        # LangChain loop and were silently dropping usage_metadata. The caller's
        # `emit` (tools._emit) stamps `sub=True` so it stays out of the parent's
        # context meter while still counting toward the session total.
        if emit is not None:
            _um = getattr(ai, "usage_metadata", None)
            if _um:
                _ev = usage_event(
                    _um,
                    model=str(getattr(model, "model_name", "") or ""),
                    sub=True,
                    provider=provider,
                )
                if _ev:
                    emit(_ev)
        tcs = getattr(ai, "tool_calls", None)
        if not tcs:
            meta = getattr(ai, "response_metadata", {}) or {}
            if meta.get("finish_reason") == "length":
                raise ProviderError(
                    "model response truncated by the provider (context length exceeded)"
                )
            content = getattr(ai, "content", "")
            if isinstance(content, str):
                # Drop any literal <think>…</think> reasoning some models emit
                # inline (DeepSeek/Qwen/llama.cpp) so it never reaches the parent.
                content = _strip_think_tags(content, False, "")[0]
                # Guard against a degenerate text loop (the model repeating the
                # same sentence dozens of times with no tool call). The doom-loop
                # guard only watches tool-call signatures, so this catches the
                # no-tool-call case. Return only the non-repeating prefix.
                if _is_repeating(content):
                    _logger.warning(
                        "sub-agent reply entered a text repetition loop; truncating"
                    )
                    # Keep the longest non-repeating prefix.
                    _unit = min(200, len(content) // 3)
                    while _unit >= 20 and _is_repeating(content[: _unit * 3]):
                        _unit = max(20, _unit // 2)
                    content = content[: _unit * 3] + " … [repetition loop truncated]"
            return str(content) if isinstance(content, str) else str(content or "")
        msgs.append(ai)
        # ── Deduplicate identical tool calls ──────────────────────────
        # The model sometimes outputs the same (name, args) pair twice in one
        # step.  Execute each unique call once and reuse the result for the
        # duplicates so we don't burn extra I/O, emit duplicate sidecar
        # events, or send redundant ToolMessages back to the LLM.
        _dup_ids: dict[str, str] = {}  # duplicate tool_call_id → original id
        if tcs:
            _seen_sigs: dict[str, str] = {}
            _deduped: list = []
            for _tc in tcs:
                _sig = (
                    f"{_tc.get('name')}:"
                    f"{json.dumps(_tc.get('args') or {}, sort_keys=True, ensure_ascii=False)}"
                )
                _orig_id = _seen_sigs.get(_sig)
                if _orig_id is not None:
                    _dup_ids[_tc.get("id", "")] = _orig_id
                else:
                    _seen_sigs[_sig] = _tc.get("id", "")
                    _deduped.append(_tc)
            if _dup_ids:
                _logger.info(
                    "deduped %d duplicate tool calls in sub-agent step",
                    len(_dup_ids),
                )
            tcs = _deduped
        # Partition this step's tool calls: read-only tools (grep/glob/read/
        # web/vision/...) run CONCURRENTLY via gather -- they cannot race each
        # other since none mutate anything. Mutating/blocking calls
        # (_SEQUENTIAL_TOOLS) run one at a time, after the concurrent batch, so a
        # write never races another write and ask_user never overlaps another
        # call. This mirrors the main-agent loop in graph.py so sub-agents
        # (explore/general) parallelize like opencode's Promise.all; token cost
        # is unchanged (the provider still receives every ToolMessage, just
        # faster). ToolMessages carry their own tool_call_id, so `msgs` order
        # need not match request order.
        _parallel = [
            tc for tc in tcs if (tc.get("name") or "") not in _SEQUENTIAL_TOOLS
        ]
        _sequential = [tc for tc in tcs if (tc.get("name") or "") in _SEQUENTIAL_TOOLS]
        if len(_parallel) > 1:
            _results = await asyncio.gather(*(_exec(tc) for tc in _parallel))
        else:
            _results = [await _exec(tc) for tc in _parallel]
        for tc, result in zip(_parallel, _results):
            msgs.append(ToolMessage(content=str(result), tool_call_id=tc.get("id", "")))
        for tc in _sequential:
            result = await _exec(tc)
            msgs.append(ToolMessage(content=str(result), tool_call_id=tc.get("id", "")))
        # Emit ToolMessages for duplicate tool calls that were deduped above so
        # the LLM sees a result for every tool_call_id it originally sent.
        if _dup_ids:
            for _dup_id, _orig_id in _dup_ids.items():
                for _m in reversed(msgs):
                    if (
                        isinstance(_m, ToolMessage)
                        and getattr(_m, "tool_call_id", "") == _orig_id
                    ):
                        msgs.append(
                            ToolMessage(content=_m.content, tool_call_id=_dup_id)
                        )
                        break
        # --- soft tool-call budget nudge ---
        # After _TOOL_CALL_SOFT_LIMIT calls, steer the model toward batching or
        # summarizing — mirrors the doom-loop guard but for "too many calls" rather
        # than "same call repeated". The model can still call tools if genuinely
        # needed; this just breaks the habit of fire-one-at-a-time greps.
        _tool_call_count += len(tcs)
        if _tool_call_count >= _TOOL_CALL_SOFT_LIMIT and steps < max_steps - 1:
            # Inject as HumanMessage (not SystemMessage) so it lands mid-list
            # without violating chat templates that require SystemMessage only
            # at position 0 (e.g. Qwen3.5 / llama.cpp). This mirrors the same
            # fix applied in graph.py for plan/tool-reuse notes.
            msgs.append(
                HumanMessage(
                    content=(
                        f"[steering] You have made {_tool_call_count} tool calls so far "
                        f"(soft limit: {_TOOL_CALL_SOFT_LIMIT}). "
                        "If you have enough information, STOP calling tools and "
                        "summarize your findings now. "
                        "If not, batch remaining searches: combine patterns with "
                        "'|' in a single grep, use filePaths=[...] for multiple "
                        "reads, and fire them all in ONE parallel turn."
                    )
                )
            )
        # --- doom-loop guard (opencode's repeated-call detector) ---
        # Build a signature of THIS step's tool calls; if it matches the previous
        # step exactly N times in a row, the model is looping — inject a hard
        # stop so it reports findings instead of burning more tokens.
        _step_sig = "|".join(
            f"{tc.get('name')}:{json.dumps(tc.get('args') or {}, sort_keys=True, ensure_ascii=False)}"
            for tc in tcs
        )
        if _step_sig == _last_call_sig:
            _same_call_streak += 1
        else:
            _same_call_streak = 1
            _last_call_sig = _step_sig
        if _same_call_streak >= _DOOM_LOOP_LIMIT:
            # Inject as HumanMessage (not SystemMessage) so it lands mid-list
            # without violating chat templates that require SystemMessage only
            # at position 0 (e.g. Qwen3.5 / llama.cpp).
            msgs.append(
                HumanMessage(
                    content=(
                        "[steering] You have issued the same tool call 3 times in a row "
                        "with identical arguments — this is a loop. Stop calling tools "
                        "and report your findings in text now."
                    )
                )
            )
            break
        # Reclaim the sub-agent's isolated context mid-run before it overflows
        # and the whole task fails. Mirrors graph._maybe_auto_compact but works
        # directly on the LangChain message list (no state/queue), so a sub-agent
        # that reads many large files can keep going instead of hitting
        # context_length_exceeded. Any failure degrades silently (the next step
        # simply retries with the uncompacted transcript).
        if ctx > 0:
            with contextlib.suppress(Exception):
                await _auto_compact_subagent(msgs, model, ctx, reserved, emit)
    # The loop ended by hitting max_steps (not by the model returning a
    # final text reply). Recover the last textual answer the sub-agent
    # produced so it never returns an empty result to the parent.
    for _m in reversed(msgs):
        if isinstance(_m, AIMessage):
            _c = getattr(_m, "content", "")
            if isinstance(_c, str) and _c.strip():
                return _c.strip()
    return ""


async def _auto_compact_subagent(
    msgs: list, model: Any, ctx: int, reserved: int | None, emit: Any = None
) -> bool:
    """Compact a sub-agent's transcript in place when it nears the context limit.

    Mirrors ``graph._maybe_auto_compact`` but works directly on the LangChain
    message list (no ``AgentState``/queue) so a sub-agent's isolated context can
    be reclaimed mid-run instead of overflowing and failing the whole task. The
    older turns are summarized (keeping a recent tail verbatim) and the list is
    rebuilt in place. Returns True when a compaction happened.
    """
    if ctx <= 0:
        return False
    max_output = _model_max_output(model)
    usable = _usable_tokens(ctx, max_output, reserved)
    dicts = _messages_to_dicts(msgs)
    total = sum(_estimate_tokens(d["content"]) for d in dicts)
    if total < usable:
        return False
    result = await _compact_history(
        model,
        dicts,
        ctx=ctx,
        max_output=max_output,
        reserved=reserved,
        fallback_model=model,
    )
    if not result:
        return False
    new_history, _keep, compact_usage = result
    # Accrue the tokens the summarizer itself consumed so the session total
    # (the "Model usage" sidebar) is complete. The caller's `emit` (tools._emit)
    # stamps `sub=True`, keeping these out of the parent's context meter while
    # still counting toward the session total.
    if emit is not None and compact_usage:
        emit(compact_usage)
    rebuilt: list[Any] = []
    had_system = bool(msgs) and isinstance(msgs[0], SystemMessage)
    if had_system:
        rebuilt.append(msgs[0])
    for d in new_history:
        role = d.get("role")
        content = str(d.get("content") or "")
        if role == "system" and had_system:
            continue
        if role == "assistant":
            rebuilt.append(AIMessage(content=content))
        elif role == "tool":
            rebuilt.append(ToolMessage(content=content, tool_call_id="__compacted__"))
        else:
            rebuilt.append(HumanMessage(content=content))
    msgs[:] = rebuilt
    return True


# _extract_cache_tokens از _common import می‌شود (single source of truth).


def usage_event(
    metadata: Any,
    model: str = "",
    sub: bool = False,
    prompt_tokens: int | None = None,
    provider: str = "",
) -> dict | None:
    """Build a SSE ``usage`` event from a LangChain ``usage_metadata`` mapping.

    Mirrors ``agents._usage_event``'s output shape so the frontend context meter
    keeps working.
    """
    if not metadata:
        return None
    try:
        if isinstance(metadata, dict):
            input_tokens = int(metadata.get("input_tokens", 0) or 0)
            output_tokens = int(metadata.get("output_tokens", 0) or 0)
            cache_read, cache_write, key_additive = _extract_cache_tokens(metadata)
            reasoning_tokens = _extract_reasoning_tokens(metadata)
        else:
            input_tokens = int(getattr(metadata, "input_tokens", 0) or 0)
            output_tokens = int(getattr(metadata, "output_tokens", 0) or 0)
            cache_read = int(getattr(metadata, "cache_read_input_tokens", 0) or 0)
            cache_write = int(getattr(metadata, "cache_creation_input_tokens", 0) or 0)
            key_additive = bool(cache_read or cache_write)
            reasoning_tokens = _extract_reasoning_tokens(
                getattr(metadata, "model_dump", dict)() or {}
            )
        # Additive when Anthropic-native key, or when cached portion exceeds
        # input_tokens (input excludes the cache). Otherwise cache is a subset of
        # input_tokens and the provider total already counts it.
        additive = (
            key_additive
            or (cache_read > 0 and input_tokens < cache_read)
            or (cache_write > 0 and input_tokens < cache_write)
        )
        import json as _json

        try:
            _md_dump = _json.dumps(metadata, default=str)
        except Exception:  # noqa: BLE001
            _md_dump = repr(metadata)
        if additive:
            # Cache is separate from input_tokens -> add it back for the true
            # total. reasoning_tokens is reported separately, so include it.
            total = (
                input_tokens
                + output_tokens
                + reasoning_tokens
                + cache_read
                + cache_write
            )
        else:
            # Subset convention: cache_read/write is already folded into
            # input_tokens, so total_tokens already counts the cache. Trust the
            # provider's own total_tokens when present; only hand-sum (adding
            # reasoning_tokens) when it is absent.
            provided_total = (
                metadata.get("total_tokens")
                if isinstance(metadata, dict)
                else getattr(metadata, "total_tokens", 0)
            )
            total = (
                (provided_total or 0)
                if (provided_total or 0)
                else input_tokens + output_tokens + reasoning_tokens
            )
        if total <= 0:
            return None
        return {
            "kind": "usage",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total,
            # Always surface the TRUE cache counts so the sidebar can bill them
            # at the cheaper cache rate. For subset-convention providers (OpenAI
            # / OpenRouter / Google) cache_read/write is already folded into
            # input_tokens, so `total_tokens` stays the provider's native total
            # (which already counts the cache) — the frontend's meter uses
            # `total_tokens` directly and only hand-sums (input+output+reasoning
            # +cache) when total_tokens is absent, so no double-count occurs. For
            # additive providers (Anthropic) the real cache counts are sent and
            # total_tokens is the hand-sum, so the meter's opencode sum is correct.
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "reasoning_tokens": reasoning_tokens,
            "context_tokens": prompt_tokens,
            "model": model or "",
            "sub": sub,
            "provider": provider,
        }
    except Exception:  # noqa: BLE001 -- usage must never crash a run
        return None
