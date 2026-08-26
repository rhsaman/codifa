"""LangChain chat-model factory.

Replaces pydantic-ai's ``build_model`` with a provider-config → LangChain
``BaseChatModel`` mapping so the LangGraph orchestration can call any
OpenAI-compatible / Google / OpenRouter gateway through one interface.

It reuses the SAME provider configuration that the rest of the app already
reads (``providers._provider_meta``, ``normalize_base_url``, ``env_key``,
``OPENCODE_UA``, ``model_timeout``, ...), so the user's Settings → Providers
entries keep working unchanged. Only the model *construction* differs.

The reasoning/UA/cache handling that pydantic-ai did with custom ``Model``
subclasses is reproduced with the equivalents LangChain supports:

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
from typing import Any

_logger = logging.getLogger(__name__)

from langchain_openai import ChatOpenAI

from providers import (
    OPENCODE_UA,
    _provider_meta,
    env_key,
    is_opencode,
    model_timeout,
    normalize_base_url,
    qualify_model_id,
)


def _strip_think_tags(
    text: str, in_think: bool, think_buf: str
) -> tuple[str, bool, str]:
    """Remove literal ``<think>…</think>`` reasoning from streamed text.

    Some models (DeepSeek/Qwen/llama.cpp and a few OpenAI-compatible gateways)
    emit their chain-of-thought as a literal ``<think>…</think>`` block inside
    the ``content`` stream instead of using a dedicated reasoning field. We drop
    it from the visible text so it never leaks to the frontend. The tag may span
    multiple streamed deltas, so the ``in_think`` / ``think_buf`` state is
    preserved across calls.
    """
    if not text:
        return text, in_think, think_buf
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if not in_think:
            start = text.find("<think", i)
            if start == -1:
                out.append(text[i:])
                break
            out.append(text[i:start])
            in_think = True
            i = start + len("<think")
            # Consume the optional 'i' of the <thinking> variant, then skip to
            # the closing '>' of the opening tag.
            if i < n and text[i] == "i":
                i += 1
            gt = text.find(">", i)
            if gt == -1:
                think_buf += text[i:]
                i = n
            else:
                i = gt + 1
        else:
            end = text.find("</think>", i)
            if end == -1:
                think_buf += text[i:]
                i = n
            else:
                think_buf += text[i:end]
                in_think = False
                i = end + len("</think>")
    return "".join(out), in_think, think_buf


def _is_repeating(
    text: str, min_len: int = 20, max_len: int = 200, min_reps: int = 3
) -> bool:
    """Detect a degenerate text loop at the tail of ``text``.

    Models sometimes emit the same sentence/phrase dozens of times with no
    tool call (e.g. "Let me check that. Let me check that. …"). The existing
    guards only watch the tool-call signature, so this text-only check catches
    it. It only flags *exact* back-to-back repetition of a bounded-length unit,
    so normal prose that happens to reuse a phrase a couple of times never
    trips it. ``min_len``/``max_len`` bound the repeated unit; ``min_reps`` is
    how many consecutive copies we need to call it a loop.
    """
    if not text or len(text) < min_len * min_reps:
        return False
    for unit in range(min(max_len, len(text) // min_reps), min_len - 1, -1):
        tail = text[-(unit * min_reps) :]
        if len(tail) < unit * min_reps:
            continue
        first = tail[:unit]
        if all(tail[i * unit : (i + 1) * unit] == first for i in range(1, min_reps)):
            return True
    return False


# Thinking level -> the downstream "reasoning effort" token. '' / 'none' mean
# reasoning is disabled. LangChain forwards these through model_kwargs to the
# OpenAI-compatible endpoint (OpenAI o1/o3, OpenRouter, DeepSeek-reasoner, ...).
_THINKING_LEVELS = {
    "": None,
    "none": False,
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
}


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
    """

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> Any:
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


def _extra_headers(provider: str, base_url: str, cache: bool) -> dict[str, str]:
    """Best-effort request headers (UA spoof + OpenRouter cache breakpoints)."""
    headers: dict[str, str] = {}
    if is_opencode(provider, base_url) or _provider_meta(provider).get("ua_spoof"):
        headers["User-Agent"] = OPENCODE_UA
    if cache and _provider_meta(provider).get("cache_headers"):
        # OpenRouter honours cache breakpoints via Anthropic-style headers; we
        # ask it to cache the system prompt + tool definitions + last message.
        headers["x-openrouter-cache"] = "true"
    return headers


def _thinking_kwargs(provider: str, model: str, thinking_level: str) -> dict[str, Any]:
    """Return ``model_kwargs`` carrying the reasoning effort, or {} when off."""
    level = _THINKING_LEVELS.get((thinking_level or "").strip())
    if level is None or level is False:
        return {}
    if not _provider_meta(provider).get("auto_think"):
        return {}
    # deepseek-reasoner / deepseek-r1 expose reasoning via `reasoning_effort`.
    # Other auto-think gateways (openrouter/openai) accept the same field with
    # vendor-specific vocabulary; passing it is a no-op on models that ignore it.
    return {"reasoning_effort": level}


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
    timeout: float = 0,
) -> Any:
    """Build a LangChain chat model for the given provider configuration.

    Mirrors ``providers.build_model``'s resolution (qualify id, credential
    chain, UA spoof, reasoning) but returns a ``BaseChatModel`` instead of a
    pydantic-ai ``Model``.
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
    headers = _extra_headers(provider, base_url, False)
    to = model_timeout(provider=provider, total=timeout or 300)
    # LangChain's ChatOpenAI only accepts a SCALAR `timeout` (total seconds);
    # passing an `httpx.Timeout` object is silently ignored, leaving the request
    # with no timeout (it hangs until the client gives up). Use the scalar total.
    lc_timeout = timeout or 300
    tkwargs = _thinking_kwargs(provider, model, thinking_level)
    reasoning_effort = tkwargs.pop("reasoning_effort", None)
    if meta.get("parallel_calls"):
        tkwargs["parallel_tool_calls"] = True
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

        return ChatGoogleGenerativeAI(
            model=model.removeprefix("models/") or model,
            google_api_key=key or None,
            temperature=temperature,
            max_output_tokens=max_tokens or None,
            streaming=True,
            timeout=to if isinstance(to, (int, float)) else None,
        )

    lc_kwargs: dict[str, Any] = {
        "model": model,
        "openai_api_base": base or None,
        "openai_api_key": key or "sk-noauth",
        "temperature": temperature,
        "max_tokens": max_tokens or None,
        "streaming": True,
        "timeout": lc_timeout,
        "model_kwargs": tkwargs,
        "default_headers": headers or None,
    }
    if reasoning_effort is not None:
        lc_kwargs["reasoning_effort"] = reasoning_effort
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
    ToolMessage,
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
    usage = usage_event(getattr(res, "usage_metadata", None), model=model_name, sub=sub)
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
    while steps < max_steps:
        steps += 1
        # Hard guardrail (opencode's isLastStep -> MAX_STEPS_PROMPT): on the
        # final allowed step, force the sub-agent to stop tool-calling and
        # summarize instead of burning more reads/searches.
        if steps >= max_steps:
            msgs.append(AIMessage(content=_MAX_STEPS_PROMPT))
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
            msgs.append(
                SystemMessage(
                    content=(
                        "You have issued the same tool call 3 times in a row with "
                        "identical arguments — this is a loop. Stop calling tools and "
                        "report your findings in text now."
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
            rebuilt.append(HumanMessage(content=f"[tool result]\n{content}"))
        else:
            rebuilt.append(HumanMessage(content=content))
    msgs[:] = rebuilt
    return True


def _extract_cache_tokens(um: dict) -> tuple[int, int, bool]:
    """Extract cache read/write token counts from ANY provider's usage metadata.

    Kept local to avoid a cross-import with graph.py. Handles Anthropic
    (cache_read_input_tokens / cache_read, additive with input_tokens), OpenAI /
    Google (cached_tokens, a subset of input_tokens), and OpenAI raw
    (prompt_tokens_details.cached_tokens). Returns (cache_read, cache_write, additive)
    where ``additive`` means the cache is reported separately and must be summed in.
    """
    details = um.get("input_token_details") or {}
    if not isinstance(details, dict):
        details = {}
    prompt_details = um.get("prompt_tokens_details") or {}
    if not isinstance(prompt_details, dict):
        prompt_details = {}
    anthropic_read = (
        details.get("cache_read_input_tokens") or um.get("cache_read_input_tokens") or 0
    )
    anthropic_write = (
        details.get("cache_creation_input_tokens")
        or um.get("cache_creation_input_tokens")
        or 0
    )
    openai_read = (
        details.get("cached_tokens")
        or details.get("cache_read")
        or details.get("cache_read_tokens")
        or prompt_details.get("cached_tokens")
        or um.get("cache_read_tokens")
        or 0
    )
    openai_write = (
        details.get("cache_creation")
        or details.get("cache_creation_tokens")
        or details.get("cache_write_tokens")
        or um.get("cache_write_tokens")
        or 0
    )
    cache_read = int(anthropic_read or openai_read or 0)
    cache_write = int(anthropic_write or openai_write or 0)
    key_additive = bool(anthropic_read or anthropic_write)
    return cache_read, cache_write, key_additive


def usage_event(
    metadata: Any, model: str = "", sub: bool = False, prompt_tokens: int | None = None
) -> dict | None:
    """Build a SSE ``usage`` event from a LangChain ``usage_metadata`` mapping.

    Mirrors ``agents._usage_event``'s output shape so the frontend context meter
    keeps working after the pydantic-ai removal.
    """
    if not metadata:
        return None
    try:
        if isinstance(metadata, dict):
            input_tokens = int(metadata.get("input_tokens", 0) or 0)
            output_tokens = int(metadata.get("output_tokens", 0) or 0)
            cache_read, cache_write, key_additive = _extract_cache_tokens(metadata)
        else:
            input_tokens = int(getattr(metadata, "input_tokens", 0) or 0)
            output_tokens = int(getattr(metadata, "output_tokens", 0) or 0)
            cache_read = int(getattr(metadata, "cache_read_input_tokens", 0) or 0)
            cache_write = int(getattr(metadata, "cache_creation_input_tokens", 0) or 0)
            key_additive = bool(cache_read or cache_write)
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
            total = input_tokens + output_tokens + cache_read + cache_write
        else:
            provided_total = (
                metadata.get("total_tokens")
                if isinstance(metadata, dict)
                else getattr(metadata, "total_tokens", 0)
            )
            total = (
                (provided_total or 0)
                if (provided_total or 0)
                else input_tokens + output_tokens
            )
        if total <= 0:
            return None
        return {
            "kind": "usage",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "context_tokens": prompt_tokens,
            "model": model or "",
            "sub": sub,
        }
    except Exception:  # noqa: BLE001 -- usage must never crash a run
        return None
