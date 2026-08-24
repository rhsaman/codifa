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
import httpx
from typing import Any

from providers import (
    OPENCODE_UA,
    _provider_meta,
    env_key,
    is_opencode,
    model_timeout,
    normalize_base_url,
    qualify_model_id,
)

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


def _thinking_kwargs(
    provider: str, model: str, thinking_level: str
) -> dict[str, Any]:
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

    from langchain_openai import ChatOpenAI

    lc_kwargs: dict[str, Any] = dict(
        model=model,
        openai_api_base=base or None,
        openai_api_key=key or "sk-noauth",
        temperature=temperature,
        max_tokens=max_tokens or None,
        streaming=True,
        timeout=lc_timeout,
        model_kwargs=tkwargs,
        default_headers=headers or None,
    )
    if reasoning_effort is not None:
        lc_kwargs["reasoning_effort"] = reasoning_effort
    return ChatOpenAI(**lc_kwargs)


_MAX_OUTPUT_TOKENS = 128_000
_FALLBACK_OUTPUT_TOKENS = 8_192


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
        max_tokens = min(max(1_024, ctx // 4), _FALLBACK_OUTPUT_TOKENS) if ctx > 0 else 0
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
from agents import _MAX_STEPS_PROMPT

# Mirrors graph.py's `_SEQUENTIAL_TOOLS` (duplicated, not imported, to avoid a
# circular import -- graph.py imports FROM this module). Mutating / blocking
# tool calls run one at a time; everything else may run concurrently. See the
# comment on graph.py's `_SEQUENTIAL_TOOLS` for the full rationale.
_SEQUENTIAL_TOOLS = {
    "write_file", "edit_file", "run_terminal", "confirm_action",
    "memory", "create_skill", "create_mcp", "ask_user",
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
            p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
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
) -> str:
    """Run a single LLM completion (no tools) and return the text reply."""
    text, _ = await llm_generate(model, system=system, user=user, images=images)
    return text


async def langchain_tool_loop(
    model: Any,
    *,
    system: str = "",
    user: str,
    tools: dict[str, Any],
    max_steps: int = 24,
) -> str:
    """Run a bounded tool-calling loop on a LangChain model.

    ``tools`` is a ``{name: callable}`` mapping (sync or async). Returns the
    final textual reply. Used by sub-agents (general/task) that need tools.

    Read-only tool calls requested in the same step run CONCURRENTLY via
    ``asyncio.gather`` (matching opencode's Promise.all); mutating/blocking
    tools run sequentially. See ``_SEQUENTIAL_TOOLS``.
    """
    lc_tools = [
        StructuredTool.from_function(func=fn, name=name, description=(fn.__doc__ or name))
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
    while steps < max_steps:
        steps += 1
        # Hard guardrail (opencode's isLastStep -> MAX_STEPS_PROMPT): on the
        # final allowed step, force the sub-agent to stop tool-calling and
        # summarize instead of burning more reads/searches.
        if steps >= max_steps:
            msgs.append(AIMessage(content=_MAX_STEPS_PROMPT))
        ai = await model.bind_tools(lc_tools).ainvoke(msgs)
        tcs = getattr(ai, "tool_calls", None)
        if not tcs:
            meta = getattr(ai, "response_metadata", {}) or {}
            if meta.get("finish_reason") == "length":
                raise ProviderError(
                    "model response truncated by the provider (context length exceeded)"
                )
            content = getattr(ai, "content", "")
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
        _parallel = [tc for tc in tcs if (tc.get("name") or "") not in _SEQUENTIAL_TOOLS]
        _sequential = [tc for tc in tcs if (tc.get("name") or "") in _SEQUENTIAL_TOOLS]
        if len(_parallel) > 1:
            _results = await asyncio.gather(*(_exec(tc) for tc in _parallel))
        else:
            _results = [await _exec(tc) for tc in _parallel]
        for tc, result in zip(_parallel, _results):
            msgs.append(
                ToolMessage(content=str(result), tool_call_id=tc.get("id", ""))
            )
        for tc in _sequential:
            result = await _exec(tc)
            msgs.append(
                ToolMessage(content=str(result), tool_call_id=tc.get("id", ""))
            )
    return ""


def usage_event(metadata: Any, model: str = "", sub: bool = False) -> dict | None:
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
            details = metadata.get("input_token_details") or {}
            cache_read = int(
                metadata.get("cache_read_input_tokens")
                or (details.get("cached_tokens") if isinstance(details, dict) else 0)
                or (details.get("cache_read_tokens") if isinstance(details, dict) else 0)
                or 0
            )
            cache_write = int(
                metadata.get("cache_creation_input_tokens")
                or (details.get("cache_creation_tokens") if isinstance(details, dict) else 0)
                or (details.get("cache_write_tokens") if isinstance(details, dict) else 0)
                or 0
            )
        else:
            input_tokens = int(getattr(metadata, "input_tokens", 0) or 0)
            output_tokens = int(getattr(metadata, "output_tokens", 0) or 0)
            cache_read = int(getattr(metadata, "cache_read_input_tokens", 0) or 0)
            cache_write = int(getattr(metadata, "cache_creation_input_tokens", 0) or 0)
        total = input_tokens + output_tokens
        if total <= 0:
            return None
        return {
            "kind": "usage",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "model": model or "",
            "sub": sub,
        }
    except Exception:  # noqa: BLE001 -- usage must never crash a run
        return None

