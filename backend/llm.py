"""LangChain chat-model factory.

Maps a provider-config to a LangChain ``BaseChatModel`` so the LangGraph
orchestration can call any OpenAI-compatible / Google / OpenRouter gateway
through one interface.

It reuses the SAME provider configuration that the rest of the app already
reads (``providers._provider_meta``, ``normalize_base_url``, ``env_key``,
``model_timeout``, ...), so the user's Settings → Providers
entries keep working unchanged.

Reasoning / User-Agent / cache handling is reproduced with the equivalents
LangChain supports:

* custom-gateway UA spoof -> ``default_headers``.
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
import inspect
import json
import logging
import os
import re
import threading
import time
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
    UA_LADDER,
    _provider_meta,
    env_key,
    is_opencode,
    model_timeout,
    normalize_base_url,
    qualify_model_id,
)
from tool_batching import (
    execute_readonly_calls,
    merge_same_scope_greps,
)
from tool_message_projection import (
    project_tool_results,
    stable_tool_order,
)

# Alias kept for existing call sites; logic lives in tool_message_projection.
_stable_tool_order = stable_tool_order

# _strip_think_tags and _is_repeating are imported from _common (single source of truth).

# _THINKING_LEVELS is imported from _common (single source of truth).


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


def resolve_keys(
    provider: str = "",
    api_key: str = "",
    env_var: str = "",
    api_keys: list[str] | tuple[str, ...] | str | None = None,
) -> list[str]:
    """Ordered API keys for a provider, top = tried first.

    Accepts the new ``api_keys`` list plus the legacy single ``api_key`` /
    ``env_var`` shapes so old settings keep working; env chain is kept as a
    last-resort fallback only.
    """
    out: list[str] = []
    if isinstance(api_keys, str):
        api_keys = [api_keys]
    for k in list(api_keys or []):
        if isinstance(k, str) and k.strip() and k.strip() not in out:
            out.append(k.strip())
    if isinstance(api_key, str) and api_key.strip() and api_key.strip() not in out:
        out.append(api_key.strip())
    if not out:
        env = env_key(provider=provider, env_var=env_var or "")
        if env and env not in out:
            out.append(env)
    return out


def resolve_key(
    provider: str,
    api_key: str,
    env_var: str = "",
    api_keys: list[str] | tuple[str, ...] | str | None = None,
) -> str:
    """Resolve the effective credential (first of ``resolve_keys``)."""
    keys = resolve_keys(provider, api_key, env_var, api_keys)
    return keys[0] if keys else ""


def _extra_headers(
    provider: str, base_url: str, cache: bool, session_id: str = ""
) -> dict[str, str]:
    """Best-effort request headers (UA spoof + cache/session stickiness)."""
    headers: dict[str, str] = {}
    if provider == "custom" and base_url and not _is_local_provider(provider, base_url):
        # Custom OpenAI-compatible gateways may block "unknown" HTTP clients by
        # User-Agent (HTTP 401 "unauthorized client") while allowing well-known
        # agent CLIs — same ladder the models fetch uses. Local servers
        # (llama.cpp/Ollama/LM Studio) are exempt: they never UA-filter.
        headers["User-Agent"] = UA_LADDER[0]
    if cache and _provider_meta(provider).get("cache_headers"):
        # OpenRouter honours cache breakpoints via Anthropic-style headers; we
        # ask it to cache the system prompt + tool definitions + last message.
        headers["x-openrouter-cache"] = "true"
    if session_id and (
        _provider_meta(provider).get("model_class") == "openrouter"
        or _provider_meta(provider).get("session_stickiness")
        or is_opencode(provider, base_url)
        or (
            base_url
            and not _is_local_provider(provider, base_url)
            and _provider_meta(provider).get("model_class") in (None, "openai")
        )
    ):
        # Sticky routing: OpenRouter derives the cache key from the FIRST
        # system+user messages by default; agent loops mutate the transcript
        # every step, so that hash drifts and cache hits vanish. A stable
        # per-chat session id keeps the prompt cache warm across the whole
        # conversation (docs: "For agent loops, set session_id"). The opencode
        # zen gateway gets the same header so sticky sessions land on warm
        # backends there too, as do router gateways (9router-style custom
        # entries) and any remote OpenAI-compatible endpoint; gateways that
        # do not recognize it ignore it. Local servers are excluded.
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


def _is_key_error(exc: Exception) -> bool:
    """True when the failure looks like a bad/expired/over-quota key.

    Only these errors are worth retrying with the NEXT key in the list
    (top-to-bottom fallback). Anything else (bad model, bad URL, context
    overflow) would fail identically on every key, so it surfaces at once.
    """
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    if status is None:
        m = re.search(r"(?:error\s+code|status_code|code)[:=\s]+(\d{3})", str(exc))
        if m:
            try:
                status = int(m.group(1))
            except (TypeError, ValueError):
                status = None
    if status in (401, 402, 403, 429):
        return True
    low = str(exc).lower()
    # Never treat context overflow as a key error, even when the message
    # happens to contain a generic word like "insufficient" or "expired".
    if any(
        w in low
        for w in (
            "context length",
            "context_length",
            "context window",
            "context_window",
            "max tokens",
            "max_tokens",
            "too many tokens",
            "token limit",
        )
    ):
        return False
    return any(
        w in low
        for w in (
            "invalid api key",
            "invalid_api_key",
            "incorrect api key",
            "invalid key",
            "unauthorized",
            "rate limit",
            "rate_limit",
            "quota",
            "quota_exceeded",
            "insufficient_quota",
            "insufficient balance",
            "insufficient_balance",
            "insufficient funds",
            "insufficient_funds",
            "payment required",
            "resource exhausted",
        )
    )


def build_chat_model(
    provider: str,
    model: str,
    base_url: str = "",
    api_key: str = "",
    env_var: str = "",
    api_keys: list[str] | tuple[str, ...] | str | None = None,
    *,
    temperature: float = 0.0,
    max_tokens: int = 0,
    thinking_level: str = "",
    model_reasoning: bool = False,
    timeout: float = 0,
    cache: bool = False,
    session_id: str = "",
    provider_id: str = "",
    parallel_tool_calls: bool = False,
) -> Any:
    """Build a LangChain chat model for the given provider configuration.

    Resolves the credential chain (qualify id, api key > env var, UA spoof,
    reasoning) and returns a ``BaseChatModel``.

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
    keys = resolve_keys(provider, api_key, env_var, api_keys)
    key = keys[0] if keys else ""
    if meta.get("requires_key") and not key:
        raise ProviderError(
            f"No {meta.get('name', provider)} credential configured. Open Settings "
            f"→ Providers → {meta.get('name', provider)} and add an API key."
        )

    model_class = meta.get("model_class") or "openai"
    headers = _extra_headers(provider, base_url, cache, session_id)
    to = model_timeout(provider=provider, total=timeout or _DEFAULT_STEP_TIMEOUT_S)
    # LangChain's ChatOpenAI only accepts a SCALAR `timeout` (total seconds);
    # passing an `httpx.Timeout` object is silently ignored, leaving the request
    # with no timeout (it hangs until the client gives up). Use the scalar total.
    # Default is effectively unlimited (24h) so a model that thinks silently is
    # never cut off (older 300s/900s ceilings killed long reasoning steps
    # mid-turn and triggered client-side resends).
    lc_timeout = timeout or _DEFAULT_STEP_TIMEOUT_S
    tkwargs = _thinking_kwargs(provider, model, thinking_level, model_reasoning)
    reasoning_effort = tkwargs.pop("reasoning_effort", None)
    # parallel_tool_calls is NOT sent by default: several OpenRouter free-tier
    # models (e.g. minimax/minimax-m3:free) reject it with 400, which would
    # kill every turn. It is only enabled when the caller explicitly opts in
    # (parallel_tool_calls=True) AND the provider is known to honor the flag
    # (meta["parallel_calls"]). The strip-on-400 retry path in
    # graph._run_mode_turn stays as the fallback for models that flip between
    # supporting and not supporting the field.
    # Ask OpenAI-compatible providers to return token usage on the final streamed
    # chunk. Without this, streaming responses omit usage and `usage_metadata`
    # stays None, so no `usage` event is emitted and the sidebar shows no cost /
    # the title bar shows no consumed context. This now applies to LOCAL servers
    # too (llama.cpp / LM Studio / Ollama all accept `include_usage` and return
    # token counts) so the context meter reflects local-model usage. If a server
    # genuinely rejects the param, the runner retries once without it (see the
    # stream_options fallback in graph.py / llm_generate).
    if parallel_tool_calls and meta.get("parallel_calls"):
        tkwargs["parallel_tool_calls"] = True
    # Ask OpenAI-compatible providers to return token usage on the final streamed
    # chunk. Without this, streaming responses omit usage and `usage_metadata`
    # stays None, so no `usage` event is emitted and the sidebar shows no cost /
    # the title bar shows no consumed context. This now applies to LOCAL servers
    # too (llama.cpp / LM Studio / Ollama all accept `include_usage` and return
    # token counts) so the context meter reflects local-model usage. If a server
    # genuinely rejects the param, the runner retries once without it (see the
    # stream_options fallback in graph.py / llm_generate).
    if model_class not in ("google", "anthropic"):
        tkwargs["stream_options"] = {"include_usage": True}
    base = normalize_base_url(provider, base_url)

    # Fallback keys (9router-style): tried top-to-bottom on key errors.
    # Stamped on the model so the runner can rebuild with the next key.
    extra_keys = keys[1:] if len(keys) > 1 else []
    _bk: dict[str, Any] = {
        "temperature": temperature,
        "max_tokens": max_tokens,
        "thinking_level": thinking_level,
        "model_reasoning": model_reasoning,
        "timeout": timeout,
        "cache": cache,
        "session_id": session_id,
        "provider_id": provider_id,
        "parallel_tool_calls": parallel_tool_calls,
        "env_var": env_var,
    }
    if model_class == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI

        # Gemini doesn't accept OpenAI's `reasoning_effort`; it uses a numeric
        # `thinking_budget` (tokens). Map the same effort levels to budgets so
        # the UI's thinking slider actually steers Gemini reasoning depth.
        # (Gemini 2.5+ exposes thinking; older models ignore the field.)
        google_thinking: dict[str, int] = {
            "low": 4096,
            "medium": 12288,
            "high": 32768,
            # Gemini 2.5's max thinking budget is 32768 — xhigh/max clamp to
            # the deepest available instead of disabling thinking (None).
            "xhigh": 32768,
            "max": 32768,
        }
        thinking_budget = google_thinking.get((thinking_level or "").strip())
        m = _stamp_provider(
            ChatGoogleGenerativeAI(
                model=model.removeprefix("models/") or model,
                google_api_key=key or None,
                temperature=temperature,
                max_output_tokens=max_tokens or None,
                streaming=True,
                timeout=to if isinstance(to, (int, float)) else None,
                thinking_budget=thinking_budget,
            ),
            provider,
            provider_id,
        )
        return _stamp_key_fallback(m, provider, model, base_url, keys, extra_keys, _bk)

    if model_class == "anthropic":
        from langchain_anthropic import ChatAnthropic

        # Anthropic-native protocol (/v1/messages, x-api-key). The base URL is
        # stored WITHOUT /v1 (normalize_base_url strips it) and the SDK appends
        # its own path, so pass the bare host root. Gateways that block unknown
        # HTTP clients by User-Agent get a well-known agent-CLI UA.
        anthropic_headers = dict(headers)
        anthropic_headers.setdefault("User-Agent", UA_LADDER[0])
        # Direct Anthropic connections get the same prompt-cache behavior as
        # OpenRouter+Claude: mark the system/tools/history prefix cacheable so
        # every step after the first bills at cache-read rates instead of full
        # price. The SDK maps this onto cache_control breakpoints.
        _anthropic_cache_kwargs: dict[str, Any] = {}
        if cache:
            _anthropic_cache_kwargs["cache_control"] = {"type": "ephemeral"}
        m = _stamp_provider(
            ChatAnthropic(
                model=model,
                api_key=key or None,
                base_url=base or None,
                temperature=temperature,
                max_tokens=max_tokens or 4096,
                streaming=True,
                timeout=lc_timeout,
                default_headers=anthropic_headers or None,
                **_anthropic_cache_kwargs,
            ),
            provider,
            provider_id,
        )
        return _stamp_key_fallback(m, provider, model, base_url, keys, extra_keys, _bk)

    # stream_chunk_timeout: maximum seconds between two consecutive streaming
    # chunks.  The default in langchain_openai is 120 s, which is too aggressive
    # for slow providers (e.g. minimax-m3 can pause > 2 min while the model
    # thinks silently).  Allow overriding via env; default is effectively
    # unlimited (24h) so thinking is never cut off.
    _chunk_timeout = int(
        os.environ.get("STREAM_CHUNK_TIMEOUT", str(_DEFAULT_STEP_TIMEOUT_S))
    )
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
        # Own HTTP client (short keep-alive, bounded read timeout) instead of
        # langchain-openai's process-wide cached one: after a network flap the
        # shared pool kept dead sockets and every chat failed until app restart.
        "http_async_client": _get_async_http_client(lc_timeout, _chunk_timeout),
    }
    if reasoning_effort is not None:
        lc_kwargs["reasoning_effort"] = reasoning_effort
    # ── Anthropic prompt caching on OpenRouter ──────────────────────────
    # OpenRouter supports automatic caching for Anthropic models via a
    # TOP-LEVEL `cache_control` field: the breakpoint is applied to the last
    # cacheable block and moves forward as the conversation converges — no
    # per-message markers needed. Only enabled for openrouter+anthropic so
    # local/custom (Qwen, llama.cpp) and Google models are untouched.
    # Non-Anthropic OpenRouter models still benefit from OpenRouter's
    # automatic prefix caching when the x-openrouter-cache header is set
    # (see _extra_headers): send the same top-level breakpoint so the
    # gateway can anchor it. Harmless on models that ignore the field.
    if cache and model_class == "openrouter":
        lc_kwargs["extra_body"] = {"cache_control": {"type": "ephemeral"}}
    # Use the reasoning-normalizing subclass so gateways that stream thinking
    # under delta.reasoning (opencode) don't leak it into the visible content.
    m = _stamp_provider(ReasoningChatOpenAI(**lc_kwargs), provider, provider_id)
    return _stamp_key_fallback(m, provider, model, base_url, keys, extra_keys, _bk)


# Effectively no timeout for one model step (24h) and for the silence between
# stream chunks: a thinking model must never be cut off for thinking too long.
_DEFAULT_STEP_TIMEOUT_S = 86400

_http_clients: dict[int, Any] = {}
_http_clients_lock = threading.Lock()


def _tcp_keepalive_options() -> list[tuple[int, int, int]]:
    """Socket options so the OS probes the peer and reports a *really* dead
    connection (half-open after a VPN/NAT drop) — independent of how long the
    model thinks. A healthy peer ACKs the probes, so silent thinking never trips
    this; only a truly broken connection does (~idle+intvl*cnt seconds)."""
    import socket

    opts: list[tuple[int, int, int]] = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
    # Idle before first probe differs per platform: TCP_KEEPALIVE on macOS,
    # TCP_KEEPIDLE on Linux. Missing constants are skipped.
    idle = getattr(socket, "TCP_KEEPIDLE", None) or getattr(
        socket, "TCP_KEEPALIVE", None
    )
    if idle is not None:
        opts.append((socket.IPPROTO_TCP, idle, 60))
    if hasattr(socket, "TCP_KEEPINTVL"):
        opts.append((socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 20))
    if hasattr(socket, "TCP_KEEPCNT"):
        opts.append((socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3))
    return opts


def _env_proxy_set() -> bool:
    return any(
        os.environ.get(k)
        for k in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        )
    )


def _get_async_http_client(total: float, chunk_timeout: float) -> Any:
    """Shared ``httpx.AsyncClient`` for OpenAI-compatible providers.

    - ``keepalive_expiry`` is short so idle pooled sockets (killed silently by
      NAT / VPN switches) are closed before they can be reused.
    - The read timeout is bounded (a half-open socket would otherwise hang for
      the full 900s request timeout, which is the "waiting for model" freeze).
    - TCP keepalive probes detect a really dead connection (no time limit on
      thinking). A custom transport is used only when no env proxy is set, so
      env proxies are still honoured.
    """
    import httpx

    read = max(float(chunk_timeout or 0) + 30.0, 180.0)
    if total:
        read = min(read, float(total))
    key = int(read)
    with _http_clients_lock:
        client = _http_clients.get(key)
        if client is not None and not client.is_closed:
            return client
        limits = httpx.Limits(
            max_connections=100,
            max_keepalive_connections=20,
            keepalive_expiry=20.0,
        )
        extra: dict[str, Any] = {}
        if not _env_proxy_set():
            # Passing `transport=` disables httpx's env-proxy handling, so only
            # do it when there is no env proxy to honour.
            extra["transport"] = httpx.AsyncHTTPTransport(
                limits=limits, socket_options=_tcp_keepalive_options()
            )
        else:
            extra["limits"] = limits
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(read, connect=15.0, write=60.0, pool=30.0),
            follow_redirects=True,
            **extra,
        )
        _http_clients[key] = client
        return client


def reset_http_clients() -> None:
    """Forget the cached HTTP clients so the next build opens fresh sockets.

    Old clients are NOT closed: other chats may still be streaming on them.
    """
    with _http_clients_lock:
        _http_clients.clear()


def _is_connection_dropped(exc: BaseException) -> bool:
    """True for transport-level failures (dead socket, reset, DNS, lost upstream)."""
    import httpx

    try:
        import openai

        _types: tuple[type, ...] = (httpx.TransportError, openai.APIConnectionError)
    except Exception:  # noqa: BLE001
        _types = (httpx.TransportError,)
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, _types):
            return True
        cur = cur.__cause__ or cur.__context__
    low = str(exc).lower()
    return any(
        s in low
        for s in (
            "connection error",
            "upstream connection lost",
            "connection reset",
            "server disconnected",
            "remote protocol error",
        )
    )


def rebuild_model_fresh(model: Any) -> Any:
    """Rebuild ``model`` on a brand-new HTTP pool (same key / settings)."""
    reset_http_clients()
    keys, _rest = model_key_fallback(model)
    return _clone_model_with_key(model, keys[0] if keys else "")


def _stamp_key_fallback(
    m: Any,
    provider: str,
    model: str,
    base_url: str,
    keys: list[str],
    extra_keys: list[str],
    build_kwargs: dict[str, Any] | None = None,
) -> Any:
    """Stamp the ordered key list on a built model for top-down fallback.

    ``build_kwargs`` carries the exact ``build_chat_model`` kwargs
    (temperature, timeout, thinking_level, ...) so
    :func:`_clone_model_with_key` can rebuild a fresh model with the next
    key instead of ``model_copy``-ing the old HTTP client.
    """
    try:
        object.__setattr__(m, "_codifa_api_keys", list(keys or []))
        object.__setattr__(m, "_codifa_api_keys_rest", list(extra_keys or []))
        object.__setattr__(m, "_codifa_provider_name", provider)
        object.__setattr__(m, "_codifa_model_name", model)
        object.__setattr__(m, "_codifa_base_url", base_url)
        if build_kwargs is not None:
            object.__setattr__(m, "_codifa_build_kwargs", dict(build_kwargs))
    except Exception:  # noqa: BLE001, S110 — attribution must never break a build
        pass
    return m


def model_key_fallback(model: Any) -> tuple[list[str], list[str]]:
    """(all keys, remaining keys) stamped by ``build_chat_model``."""
    try:
        all_keys = list(getattr(model, "_codifa_api_keys", None) or [])
        rest = list(getattr(model, "_codifa_api_keys_rest", None) or [])
        return all_keys, rest
    except Exception:  # noqa: BLE001
        return [], []


def _clone_model_with_key(model: Any, new_key: str) -> Any:
    """Return a model authenticated with ``new_key``.

    Rebuilds via :func:`build_chat_model` from the stamped provider/model/
    base_url/build-kwargs so langchain-openai creates a FRESH HTTP client.
    ``model_copy`` + field assignment is not enough: with langchain-openai
    1.6.0 the underlying ``async_client`` is shared and keeps sending the
    old key. Falls back to the old copy + client-cache reset when the
    stamp is missing (legacy/test models) so fallback never breaks a turn.

    Previously applied 400-strips (temperature / stream_options /
    parallel_tool_calls) are re-applied to the rebuilt model: the rebuild
    restores the original build kwargs, so without this a key rotation
    would resurrect a rejected param and repeat the same 400.
    """
    try:
        _no_temp = bool(getattr(model, "_codifa_no_temp", False))
        _no_so = bool(getattr(model, "_codifa_no_so", False))
        _no_pc = bool(getattr(model, "_codifa_no_pc", False))
        # Heuristic fallback for models stripped before the flags existed:
        # build always sets a numeric temperature and stream_options, so
        # None here means "was stripped".
        if not _no_temp and getattr(model, "temperature", 0.0) is None:
            _no_temp = True
        if not _no_so and hasattr(model, "openai_api_key"):
            _mk = dict(getattr(model, "model_kwargs", None) or {})
            if getattr(model, "stream_options", None) is None and "stream_options" not in _mk:
                _no_so = True
    except Exception:  # noqa: BLE001
        _no_temp = _no_so = _no_pc = False
    try:
        provider = str(getattr(model, "_codifa_provider_name", "") or "")
        model_name = str(getattr(model, "_codifa_model_name", "") or "")
        base_url = str(getattr(model, "_codifa_base_url", "") or "")
        rest = list(getattr(model, "_codifa_api_keys_rest", None) or [])
        bk = dict(getattr(model, "_codifa_build_kwargs", None) or {})
        if provider and model_name:
            remaining = rest[1:] if rest and rest[0] == new_key else list(rest)
            try:
                rebuilt = build_chat_model(
                    provider,
                    model_name,
                    base_url,
                    "",
                    bk.get("env_var", ""),
                    [new_key, *remaining] if new_key else list(remaining),
                    temperature=float(bk.get("temperature", 0.0) or 0.0),
                    max_tokens=int(bk.get("max_tokens", 0) or 0),
                    thinking_level=str(bk.get("thinking_level", "") or ""),
                    model_reasoning=bool(bk.get("model_reasoning", False)),
                    timeout=float(bk.get("timeout", 0) or 0),
                    cache=bool(bk.get("cache", False)),
                    session_id=str(bk.get("session_id", "") or ""),
                    provider_id=str(bk.get("provider_id", "") or ""),
                    parallel_tool_calls=bool(bk.get("parallel_tool_calls", False)),
                )
                if _no_temp:
                    rebuilt = _strip_temperature(rebuilt)
                if _no_so:
                    rebuilt = _strip_stream_options(rebuilt)
                if _no_pc:
                    rebuilt = _strip_parallel_calls(rebuilt)
                return rebuilt
            except Exception:  # noqa: BLE001, S110 — fall through to copy fallback
                pass
    except Exception:  # noqa: BLE001, S110 — stamp read must never break fallback
        pass
    try:
        clone = model.model_copy(deep=False)
    except Exception:  # noqa: BLE001
        return model
    try:
        if hasattr(clone, "openai_api_key"):
            clone.openai_api_key = new_key or "sk-noauth"
        if hasattr(clone, "api_key"):
            try:
                clone.api_key = new_key or None
            except Exception:  # noqa: BLE001, S110
                pass
        if hasattr(clone, "google_api_key"):
            try:
                clone.google_api_key = new_key or None
            except Exception:  # noqa: BLE001, S110
                pass
        # Force langchain to drop the shared HTTP client carrying the old key.
        for _attr in ("client", "async_client", "_client", "_async_client"):
            try:
                if hasattr(clone, _attr):
                    object.__setattr__(clone, _attr, None)
            except Exception:  # noqa: BLE001, S110
                pass
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        rest = list(getattr(clone, "_codifa_api_keys_rest", None) or [])
        if rest and rest[0] == new_key:
            rest = rest[1:]
        object.__setattr__(clone, "_codifa_api_keys_rest", rest)
    except Exception:  # noqa: BLE001, S110
        pass
    # Copy fallback preserves the stripped params themselves via model_copy,
    # but re-stamp the flags so a LATER key rotation still knows to strip.
    for _flag, _val in (
        ("_codifa_no_temp", _no_temp),
        ("_codifa_no_so", _no_so),
        ("_codifa_no_pc", _no_pc),
    ):
        if _val:
            try:
                object.__setattr__(clone, _flag, True)
            except Exception:  # noqa: BLE001, S110
                pass
    return clone


def _stamp_provider(m: Any, kind: str, pid: str) -> Any:
    """Stamp (kind, id) onto a built model so usage attribution can read them
    back (``model_provider``) without threading provider params through every
    caller. ``object.__setattr__`` bypasses pydantic field validation."""
    try:
        object.__setattr__(m, "_codifa_provider_kind", kind)
        object.__setattr__(m, "_codifa_provider_id", pid)
    except Exception:  # noqa: BLE001, S110 — attribution must never break a build
        pass
    return m


def model_provider(model: Any) -> tuple[str, str]:
    """(provider kind, provider id) stamped by ``build_chat_model``; ("", "")
    when the model was built without one (tests, legacy callers)."""
    return (
        str(getattr(model, "_codifa_provider_kind", "") or ""),
        str(getattr(model, "_codifa_provider_id", "") or ""),
    )


def bind_tools_parallel(model: Any, lc_tools: list, enabled: bool = True) -> Any:
    """``model.bind_tools`` that asks for parallel tool calls by default.
    Set at BIND time, not in model_kwargs, so it only ever travels together
    with tools — compaction/web/vision calls (no tools) never see it.
    ``enabled=False`` is the strip-on-400 fallback. Without this most
    gateways return ONE tool call per step, so N independent reads/greps cost
    N full-context round trips (the root cause of read/grep round-trip bloat
    in both the main agent and the background sub-agent).
    Also DEDUPLICATES the list by tool name (first wins): the same MCP tool
    can enter ``lc_tools`` twice (turn build + a mid-run steer rebuild), and
    providers reject duplicate declarations with HTTP 400 ("tool ... is
    declared more than once in `tools`").
    Opt-OUT, not opt-in: every provider gets ``parallel_tool_calls=True``
    unless its providers.py meta flag is explicitly ``parallel_calls=False``
    (a gateway known to reject the field). A 400 rejection still strips the
    field and retries once (see ``_is_parallel_calls_error``), so default-on
    never kills a turn — it just lets capable models batch N calls in ONE
    round-trip instead of N."""
    seen_names: set[str] = set()
    unique_tools: list = []
    for _t in lc_tools:
        _n = str(getattr(_t, "name", "") or "")
        if _n:
            if _n in seen_names:
                continue
            seen_names.add(_n)
        unique_tools.append(_t)

    kind, _ = model_provider(model)
    if enabled:
        try:
            meta_off = _provider_meta(kind).get("parallel_calls") is False
        except Exception:  # noqa: BLE001 — doubt enables parallel (safe fallback strips)
            meta_off = False
        if not meta_off:
            try:
                return model.bind_tools(unique_tools, parallel_tool_calls=True)
            except TypeError:
                # Fallback for models/gateway mocks that do not accept
                # parallel_tool_calls (older LangChain versions): retry without it.
                return model.bind_tools(unique_tools)
    return model.bind_tools(unique_tools)


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
    try:
        object.__setattr__(clone, "_codifa_no_so", True)
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
    try:
        object.__setattr__(clone, "_codifa_no_pc", True)
    except Exception:  # noqa: BLE001, S110
        pass
    return clone


def _is_temperature_error(exc: Exception) -> bool:
    """True when an exception is a 4xx caused by an unsupported
    ``temperature`` param. Reasoning-only model routes (e.g. some custom
    gateways' o-series style models) reject the field with a 400 — the runner
    retries once without it so the model still works instead of failing every
    turn."""
    msg = str(exc).lower()
    if "temperature" in msg and (
        "400" in msg
        or "not supported" in msg
        or "unsupported" in msg
        or "invalid_request_error" in msg
        or "remove the field" in msg
    ):
        return True
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    return bool(status == 400 and "temperature" in msg)


def _strip_temperature(model: Any) -> Any:
    """Return a copy of ``model`` with ``temperature`` cleared (set to ``None``
    so the request param is omitted entirely). Mirrors ``_strip_stream_options``
    for the same class of "route rejects a non-essential OpenAI field" failure.
    Falls back to the original model if cloning fails for any reason."""
    try:
        clone = model.model_copy(deep=False)
    except Exception:  # noqa: BLE001
        return model
    mk = dict(getattr(clone, "model_kwargs", None) or {})
    if "temperature" in mk:
        mk = {k: v for k, v in mk.items() if k != "temperature"}
        try:
            clone.model_kwargs = mk
        except Exception:  # noqa: BLE001, S110
            pass
    if getattr(clone, "temperature", None) is not None:
        try:
            clone.temperature = None
        except Exception:  # noqa: BLE001, S110
            pass
    try:
        object.__setattr__(clone, "_codifa_no_temp", True)
    except Exception:  # noqa: BLE001, S110
        pass
    return clone


# Ordered ladder of reasoning-effort values, weakest to strongest. Used to map
# the user's chosen thinking level onto the nearest value an always-thinking
# route accepts. Providers disagree on the top rung: some use 'max' (agentrouter,
# some OpenRouter routes), others 'xhigh' (e.g. gpt-5.1 style routes), so both
# sit above 'high' and the remapper picks whichever the route actually allows.
_EFFORT_LADDER = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

# Values that mean "reasoning off" — never a valid remap target on
# always-thinking routes, but some gateways list them in "supported values".
_EFFORT_OFF = {"none", "minimal"}


def _rejected_effort(low: str) -> str | None:
    """Extract the rejected effort value from a lowercased 400 error text.

    Handles single quotes, double quotes, and bare ``thinking_effort=xhigh``
    shapes (e.g. Kimi's ``thinking_effort="xhigh"``). Only returns values on
    the effort ladder so a quoted param name like 'reasoning_effort' is never
    mistaken for the rejected value.
    """
    for pat in (
        r"(?:reasoning_effort|thinking_effort)\s*=\s*[\"']?(\w+)[\"']?",
        r"does not support\s*[\"']?(\w+)[\"']?",
    ):
        m = re.search(pat, low)
        if m and m.group(1) in _EFFORT_LADDER:
            return m.group(1)
    return None


def _parse_allowed_efforts(exc: Exception) -> set[str] | None:
    """Parse the allowed reasoning-effort values from a 400's error text.

    Handles both shapes seen in the wild:
      * English: "does not support 'max' ... Supported values are: 'none',
        'low', 'medium', 'high', and 'xhigh'."
      * Kimi: 'Unsupported Kimi K3 thinking_effort="xhigh"; supported values
        are low, high, and max' (double quotes, ``thinking_effort=`` form).
      * Chinese (agentrouter): 「请使用 low、high 或 max」

    The REJECTED value (e.g. 'max' in "does not support 'max'") is excluded so
    it can never be mistaken for an allowed one — the bug that caused infinite
    max→max retry loops. Returns None when no explicit list is found.
    """
    text = str(exc)
    low = text.lower()
    # English "Supported values are: 'a', 'b', and 'c'" (quotes optional).
    m = re.search(
        r"supported values(?:\s+are)?:?\s*(.+?)(?:\.|$)", low, re.IGNORECASE
    )
    if m:
        segment = m.group(1)
        # Cut the JSON tail some gateways append after the message string
        # (e.g. Kimi: "...max', 'type': ..., 'param': None, ..." — the None
        # would otherwise parse as allowed 'none').
        for _marker in (
            "'type'",
            '"type"',
            "'param'",
            '"param"',
            "'code'",
            '"code"',
            "trace_id",
        ):
            _idx = segment.find(_marker)
            if _idx >= 0:
                segment = segment[:_idx]
                break
        words = re.findall(r"[a-z]+", segment)
        # The rejected value appears as "does not support 'max'" or
        # ``thinking_effort="xhigh"`` — grab THAT, not the param name quoted
        # in "Unsupported value: 'reasoning_effort'".
        bad = _rejected_effort(low)
        allowed = {w for w in words if w in _EFFORT_LADDER and w != bad}
        return allowed or None
    # Chinese "please use low, high or max" — list the bare ladder words.
    # Exclude the REJECTED value like the English branch to avoid max->max loop.
    bad_zh = _rejected_effort(low)
    allowed = {w for w in _EFFORT_LADDER if w in low and w != bad_zh}
    if allowed:
        return allowed
    return None


def _is_reasoning_effort_error(exc: Exception) -> bool:
    """True when a 400 means the route rejects our reasoning_effort value.

    Some always-thinking gateways (e.g. agentrouter's Chinese-language routes)
    only accept low/high/max and reject minimal/medium/absent with
    「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」("this model
    always thinks, disabling thinking is not supported; use low, high or
    max"). The runner retries once with the effort remapped to the nearest
    allowed value instead of failing the turn.
    """
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    if status is None:
        m = re.search(r"(?:error\s+code|status_code|code)[:=\s]+(\d{3})", str(exc))
        if m:
            try:
                status = int(m.group(1))
            except (TypeError, ValueError):
                status = None
    if status != 400:
        return False
    msg = str(exc).lower()
    mentions_thinking = any(w in msg for w in ("思考", "thinking", "reasoning"))
    rejects_value = any(
        w in msg for w in ("不支持", "not support", "unsupported", "始终", "always")
    )
    return mentions_thinking and rejects_value


def _remap_reasoning_effort(model: Any, exc: Exception) -> Any:
    """Return a copy of ``model`` with ``reasoning_effort`` remapped to the
    nearest value the route accepts.

    The allowed set is parsed from the error text itself (both the English
    "Supported values are: ..." shape and the Chinese 「请使用 low、high 或
    max」 one), falling back to low/high/max. The REJECTED value quoted in
    "does not support 'max'" is excluded so we never remap onto the very value
    the route just refused. The user's current level is mapped onto the nearest
    allowed rung of ``_EFFORT_LADDER`` — e.g. medium -> high, high -> xhigh/max
    when the route allows it, none -> low — so the retry keeps the user's
    intent instead of always dropping to "low". Handles BOTH the top-level
    LangChain field (set by build_chat_model) and model_kwargs. Falls back to
    the original model if cloning fails.
    """
    allowed = _parse_allowed_efforts(exc)
    if not allowed:
        allowed = {"low", "high", "max"}
    current = getattr(model, "reasoning_effort", None)
    if not current:
        mk = getattr(model, "model_kwargs", None) or {}
        current = mk.get("reasoning_effort")
    # Explicit top-rung equivalence: providers disagree on the strongest level
    # ('xhigh' vs 'max'). Any route rejecting one but listing the other maps
    # directly, regardless of ladder distance.
    _explicit: str | None = None
    if current == "xhigh" and "xhigh" not in allowed and "max" in allowed:
        _explicit = "max"
    elif current == "max" and "max" not in allowed and "xhigh" in allowed:
        _explicit = "xhigh"
    # Map the current level to the nearest allowed rung: the closest value by
    # ladder distance, preferring the stronger one on ties (a user who picked
    # medium wants real reasoning, not the floor).
    if _explicit is not None:
        target = _explicit
    elif current in allowed:
        # "high" is the strongest level the user can pick — when the route
        # allows something even stronger (xhigh or max), upgrade so the user
        # can actually use it. Lower picks (low/medium) keep the user's choice.
        if current == "high":
            stronger_above = [
                v
                for v in _EFFORT_LADDER
                if v in allowed and _EFFORT_LADDER.index(v) > _EFFORT_LADDER.index(current)
            ]
            target = stronger_above[0] if stronger_above else current
        else:
            target = current
    else:
        cur_idx = _EFFORT_LADDER.index(current) if current in _EFFORT_LADDER else -1
        if cur_idx < 0:
            # No effort set at all (thinking "off"): these routes can't be
            # turned off, so use the weakest allowed value.
            target = min(
                (v for v in allowed if v not in _EFFORT_OFF),
                key=_EFFORT_LADDER.index,
                default="low",
            )
        else:
            allowed_sorted = sorted(allowed, key=_EFFORT_LADDER.index)
            below = [v for v in allowed_sorted if _EFFORT_LADDER.index(v) < cur_idx]
            above = [v for v in allowed_sorted if _EFFORT_LADDER.index(v) > cur_idx]
            if below and above:
                lo, hi = below[-1], above[0]
                d_lo = cur_idx - _EFFORT_LADDER.index(lo)
                d_hi = _EFFORT_LADDER.index(hi) - cur_idx
                target = lo if d_lo < d_hi else hi
            elif above:
                target = above[0]
            else:
                target = below[-1]
    try:
        clone = model.model_copy(deep=False)
    except Exception:  # noqa: BLE001
        return model
    assigned = False
    try:
        clone.reasoning_effort = target
        assigned = True
    except Exception as exc2:  # noqa: BLE001
        _logger.warning("reasoning_effort assignment failed for %s: %s", target, exc2)
    mk = dict(getattr(clone, "model_kwargs", None) or {})
    # If direct assignment failed or the value is still stale, try model_kwargs.
    if not assigned or "reasoning_effort" in mk or getattr(clone, "reasoning_effort", None) != target:
        mk["reasoning_effort"] = target
        try:
            clone.model_kwargs = mk
        except Exception as exc2:  # noqa: BLE001
            _logger.warning("model_kwargs reasoning_effort assignment failed: %s", exc2)
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
    scope: str = "",
    api_keys: list[str] | tuple[str, ...] | str | None = None,
) -> dict[str, Any]:
    """Compute LangChain-compatible model kwargs from mode + context window.

    Port of ``agents._settings_for``'s essential behavior: per-mode temperature,
    a context-derived ``max_tokens`` cap, thinking level, UA/cache headers, and
    parallel-tool-calls flag. Heavy reasoning/usage bookkeeping is dropped (the
    LangGraph runner tracks usage itself).
    """
    temp = {"ask": 0.4, "plan": 0.3, "build": 0.2}.get(mode, 0.4)

    max_output = 0
    try:
        from providers import model_max_output

        max_output = await model_max_output(
            provider, model_name, base_url, api_key, env_var, api_keys
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
        "cache": provider_prompt_cache(provider),
    }


def provider_prompt_cache(provider: str) -> bool:
    """Whether this provider supports prompt caching at all.

    ``cache_headers`` (OpenRouter) implies it; ``prompt_cache`` marks native
    cache_control providers (direct Anthropic). Deriving ``cache`` from
    ``cache_headers`` alone left build_chat_model's Anthropic branch dead —
    every step of a direct-Anthropic chat re-billed the full prefix.
    """
    meta = _provider_meta(provider)
    return bool(meta.get("prompt_cache") or meta.get("cache_headers"))


# ---------------------------------------------------------------------------
# Shared LangChain execution helpers (one-shot completion + tool loop)
# ---------------------------------------------------------------------------


from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_core.tools import BaseTool, StructuredTool

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
# circular import -- graph.py imports FROM this module). Only mutating /
# blocking calls run one at a time; everything else (grep/glob/read /
# lsp_symbols/web_search/fetch_url/vision -- all read-only) runs concurrently
# via asyncio.gather with sync callables offloaded to worker threads, so two
# concurrent sub-agent loops never serialize on a shared lock or event loop.
# Each loop owns isolated trackers/transcript state; LSP is configured once
# per turn outside tool calls, never with a blocking start inside a call.
# Reads never take a global write lock (per-file locks only, held solely by
# mutating tools). See graph.py `_SEQUENTIAL_TOOLS` for the full rationale.
_SEQUENTIAL_TOOLS = {
    "write_file",
    "edit_file",
    "write_document",
    "run_terminal",
    "confirm_action",
    "memory",
    "create_skill",
    "create_mcp",
    "ask_user",
    "computer",
}


async def llm_generate(
    model: Any,
    *,
    system: str = "",
    user: str,
    images: list[str] | None = None,
    sub: bool = False,
    chat_id: str = "",
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
    _trace_prompt = f"[system]\n{system}\n\n[user]\n{user}" if (system or user) else ""
    if images:
        _trace_prompt += f"\n\n[{len(images)} image(s) attached]"
    try:
        res = await model.ainvoke(msgs)
    except Exception as exc:
        # Some local servers reject `stream_options`; retry once without it.
        if _is_stream_options_error(exc):
            model = _strip_stream_options(model)
            res = await model.ainvoke(msgs)
        elif _is_key_error(exc):
            # 9router-style fallback: retry the same prompt with the next key.
            _, rest = model_key_fallback(model)
            if not rest:
                raise
            model = _clone_model_with_key(model, rest[0])
            res = await model.ainvoke(msgs)
        elif _is_reasoning_effort_error(exc):
            # Always-thinking route rejected our effort (e.g. Kimi rejects
            # xhigh but accepts max). Remap and retry up to 3 times; providers
            # disagree on the top rung so one hop may lead to another.
            _re_exc = exc
            _re_model = model
            _done = False
            for _ in range(3):
                _remapped = _remap_reasoning_effort(_re_model, _re_exc)
                _old = getattr(_re_model, "reasoning_effort", None) or (
                    getattr(_re_model, "model_kwargs", None) or {}
                ).get("reasoning_effort")
                _new = getattr(_remapped, "reasoning_effort", None) or (
                    getattr(_remapped, "model_kwargs", None) or {}
                ).get("reasoning_effort")
                if _new == _old:
                    break
                _re_model = _remapped
                try:
                    res = await _re_model.ainvoke(msgs)
                    model = _re_model
                    _done = True
                    break
                except Exception as exc2:
                    if not _is_reasoning_effort_error(exc2):
                        raise
                    _re_exc = exc2
            if not _done:
                raise _re_exc
        else:
            try:
                import trace_store

                _chat_err = str(chat_id or getattr(model, "_trace_chat_id", "") or "")
                _ekind, _epid = model_provider(model)
                trace_store.append(
                    _chat_err,
                    "llm",
                    f"{model_name or 'llm'} · error",
                    detail={"provider": _ekind, "provider_id": _epid, "sub": bool(sub)},
                    model=model_name,
                    error=f"{type(exc).__name__}: {exc}"[:2000],
                    prompt=_trace_prompt,
                )
            except Exception:  # noqa: BLE001, S110 — trace must never break the call
                pass
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
    kind, pid = model_provider(model)
    usage = usage_event(
        getattr(res, "usage_metadata", None),
        model=model_name,
        sub=sub,
        provider=kind,
        provider_id=pid,
    )
    # ثبت فراخوانی تک‌شات LLM (compact/vision/provider-decide) در trace_store — best-effort.
    # همیشه ثبت می‌شود حتی وقتی usage None است تا پرامپت گم نشود.
    # chat_id خالی هم قبول است چون trace_store از ambient context (set_current_chat) برمی‌دارد.
    try:
        import trace_store

        _chat = str(chat_id or getattr(model, "_trace_chat_id", "") or "")
        _u = usage or {}
        _total = int(_u.get("total_tokens", 0) or 0)
        trace_store.append(
            _chat,
            "llm",
            f"{model_name or 'llm'} · {_total} tokens",
            detail={
                "provider": _u.get("provider"),
                "provider_id": _u.get("provider_id"),
                "input_tokens": _u.get("input_tokens", 0),
                "output_tokens": _u.get("output_tokens", 0),
                "total_tokens": _total,
                "sub": bool(sub),
                "has_usage": usage is not None,
            },
            model=model_name,
            tokens={
                "input": _u.get("input_tokens", 0),
                "output": _u.get("output_tokens", 0),
                "total": _total,
            },
            prompt=_trace_prompt,
            result=str(text or "")[:8000],
        )
    except Exception:  # noqa: BLE001, S110 — trace must never break the call
        pass
    return text, usage


async def llm_complete(
    model: Any,
    *,
    system: str = "",
    user: str,
    images: list[str] | None = None,
    chat_id: str = "",
) -> tuple[str, dict | None]:
    """Run a single LLM completion (no tools) and return ``(text, usage_event)``.

    The usage event (or ``None``) is surfaced so callers that summarize/compact
    can accrue those tokens into the session total instead of silently dropping
    them.
    """
    return await llm_generate(model, system=system, user=user, images=images, chat_id=chat_id)


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


def dedupe_tool_outputs(msgs: list) -> list:
    """فقط اولین ``ToolMessage`` به‌ازای هر ``tool_call_id`` را نگه می‌دارد.

    نگهبان نهاییِ قبل از هر درخواست provider: تاریخچهٔ تکراریِ front-end،
    چک‌پوینت خراب یا compaction ممکن است دو خروجی برای یک call_id بسازد که
    provider آن را با خطای 400 «Duplicate function_call_output for call_id»
    رد می‌کند.
    """
    seen: set[str] = set()
    out: list = []
    for m in msgs:
        if isinstance(m, ToolMessage):
            if m.tool_call_id in seen:
                continue
            seen.add(m.tool_call_id)
        out.append(m)
    return out


def _chunk_index(c: Any) -> Any:
    """شمارهٔ موقعیت تکهٔ استریم (``index``) یا ``None``."""
    if isinstance(c, dict):
        return c.get("index")
    return getattr(c, "index", None)


def _chunk_id(c: Any) -> Any:
    """شناسهٔ تکهٔ استریم یا ورودی blob خام."""
    if isinstance(c, dict):
        return c.get("id")
    return getattr(c, "id", None)


def _set_chunk_id(c: Any, new_id: str) -> None:
    if isinstance(c, dict):
        c["id"] = new_id
    else:
        with contextlib.suppress(Exception):
            c.id = new_id


def _sync_derived_tool_ids(
    chunks: list,
    raw_tcs: Any,
    total: int,
    renames: dict[int, tuple[str, str]],
) -> None:
    """همگام‌سازی درجا شناسه‌ها در منابعِ مشتق‌ساز ``tool_calls``.

    اعتبارسنج langchain در ``model_copy``/unpickle بعدی ``tool_calls`` را از
    ``tool_call_chunks`` بازاستخراج می‌کند و مبدل وایر وقتی ``tool_calls``
    خالی است به blob خام ``additional_kwargs["tool_calls"]`` برمی‌گردد؛ پس هر
    تغییرنام باید در هر سه منبع بنشیند وگرنه شناسهٔ کهنه برمی‌گردد و provider
    با 400 تکراری رد می‌کند (بای‌پس واقعی). ``renames`` نگاشت موقعیت→(کهنه،
    جدید) است؛ ``total`` طول ``tool_calls``. حالت معمول (طول برابر) موقعیتی
    همگام می‌شود؛ وگرنه (تکه‌تکه‌شدن آرگومان در استریم) بر اساس ``index``
    تکه‌ها، و در نهایت فقط وقتی شناسهٔ کهنه در آن منبع یکتاست (تا فراخوانیِ
    هم‌شناسهٔ دیگر خراب نشود).
    """
    if not renames:
        return
    if chunks:
        if len(chunks) == total:
            for j, (_old, new) in renames.items():
                if 0 <= j < len(chunks):
                    _set_chunk_id(chunks[j], new)
        else:
            by_index: dict[Any, list] = {}
            no_index: list = []
            for c in chunks:
                idx = _chunk_index(c)
                if idx is None:
                    no_index.append(c)
                else:
                    by_index.setdefault(idx, []).append(c)
            counts: dict[Any, int] = {}
            for c in chunks:
                cid = _chunk_id(c)
                counts[cid] = counts.get(cid, 0) + 1
            for j, (old, new) in renames.items():
                if j in by_index:
                    for c in by_index[j]:
                        _set_chunk_id(c, new)
                elif old and counts.get(old) == 1:
                    for c in no_index:
                        if _chunk_id(c) == old:
                            _set_chunk_id(c, new)
    if isinstance(raw_tcs, list) and raw_tcs:
        if len(raw_tcs) == total:
            for j, (_old, new) in renames.items():
                if 0 <= j < len(raw_tcs) and isinstance(raw_tcs[j], dict):
                    raw_tcs[j]["id"] = new
        else:
            counts = {}
            for e in raw_tcs:
                if isinstance(e, dict):
                    eid = e.get("id")
                    counts[eid] = counts.get(eid, 0) + 1
            for _j, (old, new) in renames.values():
                if old and counts.get(old) == 1:
                    for e in raw_tcs:
                        if isinstance(e, dict) and e.get("id") == old:
                            e["id"] = new


_UNSAFE_TOOL_ID_CHARS = re.compile(r"[^A-Za-z0-9_-]")


def _safe_tool_call_id(raw: str) -> str:
    """شناسهٔ tool_call را به کاراکترهای امن ``[A-Za-z0-9_-]`` تبدیل می‌کند.

    بعضی gatewayها (مثل muse) موقع تبدیل به فرمت Responses کاراکترهای غیرمجاز
    شناسه را حذف می‌کنند؛ آن‌وقت «1#2» می‌شود «12» و با شناسهٔ واقعیِ «12»
    برخورد می‌کند («Duplicate function_call_output»). پس هم پسوند یکتاساز و
    هم شناسه‌های قدیمیِ ذخیره‌شده (چک‌پوینت/تاریخچه) با ``_`` امن می‌شوند.
    """
    return _UNSAFE_TOOL_ID_CHARS.sub("_", raw) or "call"


def _uniquify_tool_call_ids(msgs: list, logger: Any = None) -> None:
    """یکتاسازیِ in-place شناسهٔ همهٔ ``tool_call``ها در کل ترنسکریپت.

    providerهایی که هر فراخوانی را با خروجی‌اش بر اساس ``call_id`` جفت می‌کنند
    (گیت‌وی‌های سبک OpenAI Responses) ترنسکریپتی را که یک ``call_id`` را در دو
    فراخوانیِ متفاوت تکرار کرده با 400 «Duplicate function_call_output for
    call_id» رد می‌کنند. یکتاسازی فعلی فقط *داخل یک پیام*
    (``dedupe_step_tool_call_ids``) و *داخل بازسازی تاریخچه*
    (``history_to_langchain_messages``) است؛ پس در «ترن جدید» یا «استاپ و
    ادامه» ترنسکریپتِ انباشته می‌تواند شناسهٔ تکراری داشته باشد.

    تکراری‌ها پسوند ``_dupN`` می‌گیرند و ``ToolMessage`` متناظر هم به شناسهٔ جدید
    اشاره می‌کند تا هر نتیجه به فراخوانی خودش متصل بماند (نه به فراخوانی
    قبلیِ هم‌شناسه).
    """
    used: set[str] = set()
    # صف FIFO از [شناسهٔ اصلی، شناسهٔ یکتا] برای فراخوانی‌های بی‌جواب.
    open_calls: list[list[Any]] = []
    renames: list[tuple[int, dict[int, tuple[str, str]]]] = []
    for i, m in enumerate(msgs):
        if isinstance(m, AIMessage):
            tcs = list(getattr(m, "tool_calls", None) or [])
            if not tcs:
                continue
            changed: dict[int, tuple[str, str]] = {}
            for j, tc in enumerate(tcs):
                raw = str(tc.get("id") or "")
                cid = _safe_tool_call_id(raw)
                if cid in used:
                    n = 2
                    while f"{cid}_dup{n}" in used:
                        n += 1
                    cid = f"{cid}_dup{n}"
                if cid != raw:
                    changed[j] = (raw, cid)
                used.add(cid)
                open_calls.append([raw, cid])
            if changed:
                renames.append((i, changed))
        elif isinstance(m, ToolMessage):
            tcid = str(m.tool_call_id or "")
            if tcid:
                # شناسهٔ خروجی‌ها هم فضای شناسه را اشغال می‌کند: حتی وقتی
                # فراخوانی متناظر پیدا نشود (خروجی یتیم از چک‌پوینت/ترمیم)،
                # باید رزرو شود تا فراخوانی بعدی همان شناسه را دوباره نگیرد
                # و خروجی تکراری نسازد (بای‌پس واقعی خطای 400 تکراری).
                used.add(tcid)
            for entry in open_calls:
                if entry[0] is not None and (
                    entry[0] == tcid or entry[1] == tcid
                ):
                    entry[0] = None  # مصرف شد
                    if entry[1] != tcid:
                        msgs[i] = m.model_copy(update={"tool_call_id": entry[1]})
                    break
    if not renames:
        return
    for i, changed in renames:
        m = msgs[i]
        tcs = list(m.tool_calls or [])
        for j, (_old, new_id) in changed.items():
            tcs[j]["id"] = new_id
        # اعتبارسنج langchain در ``model_copy``/unpickle بعدی ``tool_calls`` را
        # از ``tool_call_chunks`` بازاستخراج می‌کند و مبدل وایر وقتی
        # ``tool_calls`` خالی است به blob خام برمی‌گردد؛ پس هر دو را هم به‌روز
        # می‌کنیم (بای‌پس واقعی خطای 400 تکراری).
        chunks = getattr(m, "tool_call_chunks", None) or []
        raw_tcs = (getattr(m, "additional_kwargs", None) or {}).get("tool_calls")
        _sync_derived_tool_ids(chunks, raw_tcs, len(tcs), changed)
        msgs[i] = m.model_copy(update={"tool_calls": tcs})
    if logger is not None:
        logger.warning(
            "normalized %d assistant message(s) with duplicate tool_call ids",
            len(renames),
        )


def normalize_tool_transcript(msgs: list, logger: Any = None) -> list:
    """ترنسکریپت را در یک پاس برای provider معتبر می‌کند (in-place).

    ترتیب: یکتاسازی شناسه‌ها در کل ترنسکریپت → حذف ``tool_call``های بی‌جواب →
    نگه‌داشتن فقط یک خروجی به‌ازای هر شناسه. این تنها نقطهٔ گلوگاه پیش از هر
    درخواست provider است، پس هیچ مسیری (چک‌پوینت خراب، compaction، ادامهٔ turn)
    نمی‌تواند ترنسکریپت نامعتبر بفرستد.
    """
    _uniquify_tool_call_ids(msgs, logger)
    strip_orphaned_tool_calls(msgs, logger)
    msgs[:] = dedupe_tool_outputs(msgs)
    return msgs


def append_tool_result(msgs: list, content: Any, tool_call_id: str) -> bool:
    """فقط وقتی ``ToolMessage`` اضافه می‌کند که این ``tool_call_id`` بی‌جواب باشد.

    اگر جواب از قبل موجود باشد ``False`` برمی‌گرداند (تکراری حذف می‌شود):
    دو خروجی برای یک call_id خطای 400 «Duplicate function_call_output for
    call_id» را می‌سازد.
    """
    if any(
        isinstance(m, ToolMessage) and m.tool_call_id == tool_call_id for m in msgs
    ):
        return False
    msgs.append(ToolMessage(content=content, tool_call_id=tool_call_id))
    return True


def dedupe_step_tool_call_ids(ai: Any, reserved_ids: set[str] | None = None) -> None:
    """یکتاسازیِ in-place همهٔ idهای ``tool_call`` داخل یک پیام assistant.

    برخی providerها شناسهٔ ساده (عددی یا تکرارشونده بین فراخوانی‌ها) صادر
    می‌کنند، طوری که یک پیام می‌تواند دو ``tool_calls`` با یک id داشته باشد؛
    هر دو آن‌گاه یک ToolMessage مشترک می‌خواهند و provider پاسخ را با خطای
    400 «Duplicate function_call_output for call_id» رد می‌کند. تکراری‌ها
    قبل از ذخیرهٔ پیام پسوند ``_dupN`` می‌گیرند تا هر فراخوانی با id خودش جواب
    بگیرد (نتیجه‌ها بعد از این اجرا append می‌شوند).

    با ``reserved_ids`` می‌توان idهای موجود در تاریخچه را هم رزرو کرد؛
    در غیر این صورت provider اگر شناسهٔ مرحلهٔ قبل (مثلاً ``1``) را دوباره
    برگرداند، نتیجهٔ جدید به‌اشتباه به خروجی قدیمی وصل می‌شود.

    تغییر نام در ``tool_call_chunks`` و blob خام
    ``additional_kwargs["tool_calls"]`` هم اعمال می‌شود (اگر ترتیب‌شان با
    ``tool_calls`` یکی باشد) چون ``model_copy`` بعدی ``tool_calls`` را از
    همان‌ها بازاستخراج می‌کند (نگاه کن به ``strip_orphaned_tool_calls``) و
    بدون این کار، idهای تکراری برمی‌گشتند.
    """
    tcs = getattr(ai, "tool_calls", None) or []
    if not tcs:
        return
    renames: dict[int, tuple[str, str]] = {}
    seen: set[str] = set(reserved_ids or ())
    for idx, tc in enumerate(tcs):
        raw = str(tc.get("id") or "")
        cid = _safe_tool_call_id(raw)
        if cid in seen:
            n = 2
            while f"{cid}_dup{n}" in seen:
                n += 1
            cid = f"{cid}_dup{n}"
        if cid != raw:
            tc["id"] = cid
            renames[idx] = (raw, cid)
        seen.add(cid)
    if not renames:
        return
    chunks = getattr(ai, "tool_call_chunks", None) or []
    raw_tcs = (getattr(ai, "additional_kwargs", None) or {}).get("tool_calls")
    _sync_derived_tool_ids(chunks, raw_tcs, len(tcs), renames)


# ── Batchable-call detection (shared by both tool loops) ──────────────────
# The model keeps firing one grep/glob/read per turn even though the tools
# accept batch parameters (grep `patterns=[...]`, read `filePaths=[...]` /
# `ranges=[...]`). Prompt instructions alone don't break that habit, so this
# detector runs mechanically: when a step contains ≥2 calls of the SAME
# batchable tool that could have been ONE call, a short reminder is appended
# to the LAST result of that tool so the model sees it with its own results
# and self-corrects on the next step. Advisory only — never blocks a call.
_BATCHABLE_TOOLS = {"grep", "glob", "read", "run_terminal", "computer"}

# Only mutating computer actions belong in ONE sequence call. Read-only
# actions (read_screen/read_element/list_apps/open_app/see/check_access)
# must stay separate — merging a read into a sequence changes semantics.
_COMPUTER_SEQUENCE_ACTIONS = frozenset({"act", "input", "sequence"})


def _is_computer_sequence_call(args: dict) -> bool:
    """True when a computer call is a mutating step that belongs in sequence."""
    try:
        return str((args or {}).get("action") or "").strip().lower() in _COMPUTER_SEQUENCE_ACTIONS
    except Exception:  # noqa: BLE001
        return False

# Same-batch signature: the tool name + every arg EXCEPT the primary one
# (pattern / filePath). Calls sharing this signature differ only in the
# primary argument, so they merge into one `patterns=[...]` / `filePaths=[...]`
# call. (Same rule the per-step detector uses for its pair check.)


def _batch_rest(name: str, args: dict) -> dict:
    """Non-primary args that must match for two calls to merge into one.

    For read, ``offset``/``limit`` are per-file windows — a batch expresses
    differing windows via ``ranges=['path:offset:limit', ...]`` — so they
    are excluded and reads with different windows still merge, even two
    windows on the SAME file. For grep/glob the scope (``path``) and file
    filter (``include``) must be IDENTICAL: merging ``foo@src`` +
    ``bar@backend`` into ``foo|bar`` over both scopes is a Cartesian
    expansion that changes semantics and returns more tokens, so such
    calls are intentionally NOT mergeable — the model should fire them
    as parallel calls in ONE step instead (still one round-trip).
    """
    if name == "read":
        primary = "filePath"
    elif name == "run_terminal":
        primary = "command"
    else:
        primary = "pattern"
    rest = {k: v for k, v in args.items() if k != primary}
    if name == "read":
        rest.pop("offset", None)
        rest.pop("limit", None)
    if name == "run_terminal":
        rest.pop("timeout", None)
    if name == "computer":
        rest.pop("timeout", None)
        rest.pop("depth", None)
    return rest


def _batch_example(name: str, calls: list[dict]) -> str:
    """Build a CONCRETE merged call from the model's own recent calls.

    ``calls`` are the raw arg dicts of the one-at-a-time calls (most recent
    last). Models follow a literal example far better than an abstract rule,
    so the reminder shows the exact merged call they should have made.
    """
    if name == "read":
        # فهرست تاپل‌ها (نه dict روی filePath) تا خوانش‌های تکراری هم‌فایل
        # با پنجره‌های متفاوت گم نشوند (مثل ranges هم‌فایل tools.py).
        windows = [
            (
                str(c.get("filePath")),
                int(c.get("offset") or 1),
                int(c.get("limit") or 2000),
            )
            for c in calls
        ]
        if len({(o, l) for _, o, l in windows}) == 1:
            off, lim = windows[0][1], windows[0][2]
            seen: list[str] = []
            for p, _, _ in windows:
                if p not in seen:
                    seen.append(p)
            primary = seen[0]
            return (
                f"read(filePath={primary!r}, filePaths="
                f"{seen[1:]!r}, offset={off}, limit={lim})"
            )
        return (
            "read(filePath="
            + repr(windows[0][0])
            + ", ranges=["
            + ", ".join(repr(f"{p}:{o}:{l}") for p, o, l in windows)
            + "])"
        )
    if name == "run_terminal":
        cmds = [str(c.get("command") or "").strip() for c in calls]
        cmds = [c for c in cmds if c]
        chained = "; ".join(cmds)
        return f"run_terminal(command={chained!r})"
    if name == "computer":
        return (
            "computer(action='sequence', steps=[...]) — merge the separate "
            "act/input steps into ONE sequence call instead of one call per step"
        )
    # grep / glob — scope (path) and file filter (include) are identical
    # here (enforced by _batch_rest), so the example keeps that scope and
    # only merges the patterns. Different scopes must stay parallel calls
    # in one step, never a Cartesian paths=/includes= merge.
    scopes = [str(c.get("path") or "") for c in calls]
    includes = [str(c.get("include") or "") for c in calls]
    primary = "filePath" if name == "read" else "pattern"
    terms = [str(c.get(primary) or "") for c in calls]
    extra = {
        k: v for k, v in calls[-1].items() if k not in ("path", "include", primary)
    }
    arg_bits = [f"{primary}={terms[0]!r}"]
    if len(terms) > 1:
        arg_bits.append(f"patterns={terms[1:]!r}")
    if scopes[0]:
        arg_bits.append(f"path={scopes[0]!r}")
    if includes[0]:
        arg_bits.append(f"include={includes[0]!r}")
    for k, v in extra.items():
        arg_bits.append(f"{k}={v!r}")
    return f"{name}(" + ", ".join(arg_bits) + ")"


def _batchable_nudge(tcs: list) -> str:
    """Return a reminder suffix when a step's tool calls could be merged.

    Detects, per batchable tool name, whether ≥2 calls share the same
    non-primary parameters — i.e. they differ only in the primary
    argument (pattern / filePath) or the read window (offset/limit) and
    would have been a single call with `patterns=[...]` / `filePaths=[...]` /
    `ranges=[...]`. Grep/glob calls with different path/include are NOT
    mergeable (Cartesian over-scan); fire those as parallel calls in ONE
    step instead. Reads with different windows merge via
    `ranges=['path:offset:limit', ...]` — even two windows on the SAME file.
    Calls that ALREADY pass a batch parameter are ignored (the model is
    already batching). Returns "" when nothing is mergeable.
    """
    per_tool: dict[str, list[dict]] = {}
    for tc in tcs or []:
        name = (tc.get("name") or "").lower()
        if name not in _BATCHABLE_TOOLS:
            continue
        args = tc.get("args") or {}
        if any(
            k in args
            for k in ("patterns", "filePaths", "ranges", "paths", "includes", "symbols")
        ):
            continue  # already a batch call
        if name == "run_terminal" and (
            ";" in str(args.get("command") or "")
            or "&&" in str(args.get("command") or "")
        ):
            continue  # already chained in ONE call
        if name == "read":
            primary = "filePath"
        elif name == "run_terminal":
            primary = "command"
        elif name == "computer":
            primary = "action"
        else:
            primary = "pattern"
        if name == "computer" and not _is_computer_sequence_call(args):
            continue  # read-only computer actions never merge into sequence
        if not args.get(primary):
            continue
        per_tool.setdefault(name, []).append(args)
    hints: list[str] = []
    for name, calls in per_tool.items():
        if len(calls) < 2:
            continue
        if name == "computer":
            # Any 2+ act/input/sequence calls merge into ONE sequence —
            # selectors/targets always differ, so the identical-rests check
            # below would wrongly skip them. Suggest sequence directly.
            hints.append(_batch_example(name, calls))
            continue
        # A merge is only valid when the non-primary args are IDENTICAL —
        # e.g. two greps with different max_results must stay separate calls.
        rests = [_batch_rest(name, a) for a in calls]
        if any(r != rests[0] for r in rests[1:]):
            continue
        hints.append(_batch_example(name, calls))
    if not hints:
        return ""
    return (
        "\n\n⚠️ BATCHING REMINDER: these calls MUST have been ONE call:\n"
        + "\n".join(f"- {h}" for h in hints)
        + "\nThose calls already ran — do NOT repeat them. Your NEXT step MUST "
        "batch ALL remaining searches into ONE call (or parallel calls in ONE "
        "step when scopes differ). Single-arg calls waste round-trips."
    )


class _BatchStreakTracker:
    """Cross-step detector for one-at-a-time batchable calls.

    The per-step detector above only fires when the model puts ≥2 mergeable
    calls in ONE step. But most models (especially via gateways where
    ``parallel_tool_calls`` is not sent) emit exactly ONE tool call per step —
    so the per-step detector never fires and the model burns 6+ round-trips
    on 6 separate reads/greps. This tracker counts PER TOOL: when the same
    batchable tool is called one-at-a-time for ``threshold`` steps in a row,
    it returns a reminder. Same-scope calls get a concrete merged-call
    example; different-scope grep/glob calls get a parallel-step reminder
    (a Cartesian paths=/includes= merge would change semantics and cost
    more tokens).

    A batch call resets that tool's streak; steps with no batchable call
    leave streaks intact (real turns interleave reads with searches and
    commands). Genuine varied work is never nagged.
    """

    __slots__ = ("_counts", "_recent", "_threshold")

    def __init__(self, threshold: int = 2):
        self._counts: dict[str, int] = {}
        self._recent: dict[str, list[dict]] = {}
        self._threshold = max(2, threshold)

    def _batch_args(self, args: dict) -> bool:
        if any(
            k in (args or {})
            for k in ("patterns", "filePaths", "ranges", "paths", "includes", "symbols")
        ):
            return True
        cmd = str((args or {}).get("command") or "")
        if ";" in cmd or "&&" in cmd:
            return True
        if str((args or {}).get("action") or "") == "sequence":
            steps = (args or {}).get("steps") or []
            return isinstance(steps, list) and len(steps) >= 2
        return False

    def observe(self, tcs: list) -> str:
        """Record this step's calls; return a reminder when a streak fires.

        Call once per step with ALL of that step's tool calls (before
        execution). Returns "" most steps; once the per-tool count reaches
        the threshold it returns the reminder text — and keeps reminding
        (with the growing merged example) on EVERY further one-at-a-time
        step, because a single reminder demonstrably gets ignored.
        """
        step_calls: dict[str, dict] = {}
        batched: set[str] = set()
        for tc in tcs or []:
            name = (tc.get("name") or "").lower()
            if name not in _BATCHABLE_TOOLS:
                continue
            args = tc.get("args") or {}
            if self._batch_args(args):
                batched.add(name)  # already a batch call
                continue
            if name == "computer" and not _is_computer_sequence_call(args):
                continue  # read-only computer actions never streak toward sequence
            if name == "read":
                primary = "filePath"
            elif name == "run_terminal":
                primary = "command"
            elif name == "computer":
                primary = "action"
            else:
                primary = "pattern"
            if not args.get(primary):
                continue
            step_calls.setdefault(name, args)
        if not step_calls and not batched:
            # No batchable call this step — leave the streaks alone. Real
            # turns interleave reads with searches/commands; wiping here
            # meant the streak never reached the threshold.
            return ""
        for name in batched:
            self._counts.pop(name, None)
            self._recent.pop(name, None)
        fired: list[tuple[str, list[dict], int]] = []
        for name, args in step_calls.items():
            n = self._counts.get(name, 0) + 1
            self._counts[name] = n
            recent = self._recent.setdefault(name, [])
            recent.append(dict(args))
            if len(recent) > 6:
                del recent[: len(recent) - 6]
            if n >= self._threshold:
                fired.append((name, recent, n))
        if not fired:
            return ""
        lines = []
        for name, calls, _ in fired:
            if name == "computer":
                # Any 2+ act/input steps belong in ONE sequence call —
                # selectors/targets always differ, so never apply the
                # identical-rests check here.
                lines.append(f"- {_batch_example(name, calls)}")
                continue
            rests = [_batch_rest(name, a) for a in calls]
            if name != "read" and any(r != rests[0] for r in rests[1:]):
                # Different scopes/filters: a single merged call would be a
                # Cartesian over-scan. Advise parallel calls in one step.
                lines.append(
                    f"- fire remaining {name} calls together in ONE parallel "
                    "step (same scopes as before, one call per scope/pattern)"
                )
            else:
                lines.append(f"- {_batch_example(name, calls)}")
        return (
            "\n\n⚠️ BATCHING REMINDER: you called {tool} one-at-a-time "
            "{n} times — each single call wastes a full LLM round-trip. "
            "STOP issuing single calls. Your NEXT step MUST batch:\n".format(
                tool=" + ".join(name for name, _, _ in fired),
                n=max(n for _, _, n in fired),
            )
            + "\n".join(lines)
            + "\nThe calls above ALREADY ran — do NOT re-issue them. "
            "Merge ALL remaining searches into ONE step using the shapes above."
        )


# ── Revisit streak (shared by both tool loops) ──────────────────────────
# Touches of the SAME file / grep scope across steps in one turn. The model
# pages one file step after step (symbols, then a head window, then another
# window) instead of finishing it in one decisive call — and every such step
# is a full round-trip even when the result is a 2-line stub. Threshold 2:
# the first re-touch already burns a round-trip, so remind immediately.
_REVISIT_STREAK_TOUCHES = 2


def _revisit_ranges(path: str) -> str:
    """Compact 'A-B, C-D' of this turn's fetched windows for ``path``."""
    try:
        from tool_batching import fetched_windows as _fw

        _wins = sorted((int(a), int(b)) for a, b in (_fw(path) or []))
    except Exception:  # noqa: BLE001 — note text never breaks a turn
        return ""
    _merged: list[list[int]] = []
    for _a, _b in _wins:
        if _merged and _a <= _merged[-1][1] + 1:
            _merged[-1][1] = max(_merged[-1][1], _b)
        else:
            _merged.append([_a, _b])
    return ", ".join(f"{a}-{b}" if a != b else f"{a}" for a, b in _merged[:4])


class _RevisitStreakTracker:
    """Nudge when one file/scope is re-touched step after step in a turn.

    Counts touches per read path / grep scope (already-merged batch greps
    don't count — they are the desired shape). On the Nth touch and every
    later touch it returns a reminder naming the file/scope and what was
    seen so far, telling the model to fetch everything still needed in ONE
    call and stop re-touching it. Advisory only, never blocks a call.
    Steps without the key do NOT reset others (real turns interleave
    files, searches and commands).
    """

    __slots__ = ("_recent", "_threshold", "_touches")

    def __init__(self, threshold: int = _REVISIT_STREAK_TOUCHES) -> None:
        self._touches: dict[str, int] = {}
        self._recent: dict[str, list[str]] = {}
        self._threshold = max(2, threshold)

    def observe(self, tcs: list) -> str:
        """Record this step's calls; remind on the Nth touch of one key."""
        keys: list[tuple[str, str]] = []
        for tc in tcs or []:
            try:
                if not isinstance(tc, dict):
                    continue
                name = (tc.get("name") or "").lower()
                args = tc.get("args") or {}
                if not isinstance(args, dict):
                    continue
            except Exception:  # noqa: BLE001, S112 — bad calls never break tracking
                continue
            if name == "read":
                # symbols= reads resolve server-side (_read_windows skips them
                # — precise, never overlap-nudge bait), but they still cost a
                # round-trip, so they count as touches on the file.
                if args.get("symbols") and args.get("filePath"):
                    _k = ("read", str(args.get("filePath")))
                    if _k not in keys:
                        keys.append(_k)
                for _p, _s, _e in _read_windows(args):
                    _k = ("read", _p)
                    if _k not in keys:
                        keys.append(_k)
            elif name == "grep":
                if args.get("patterns") or args.get("paths") or args.get("includes"):
                    continue  # merged batch grep: the desired shape, no streak
                _scope = f"{args.get('path') or ''}|{args.get('include') or ''}"
                _k = ("grep", _scope)
                if _k not in keys:
                    keys.append(_k)
                _pat = str(args.get("pattern") or "")
                if _pat:
                    _recent = self._recent.setdefault(f"grep:{_scope}", [])
                    if _pat not in _recent:
                        _recent.append(_pat)
                    del _recent[:-3]
        notes: list[tuple[str, str]] = []
        for kind, label in keys:
            key = f"{kind}:{label}"
            n = self._touches.get(key, 0) + 1
            self._touches[key] = n
            if n >= self._threshold:
                notes.append((kind, label))
        if not notes:
            return ""
        _ord = {1: "1st", 2: "2nd", 3: "3rd"}.get(
            self._threshold, f"{self._threshold}th"
        )
        lines = []
        for kind, label in notes:
            if kind == "read":
                _ranges = _revisit_ranges(label)
                _have = f" (you hold {_ranges} this turn)" if _ranges else ""
                lines.append(
                    f"- {label}: {_ord} step this turn touching "
                    f"this file{_have}. Fetch EVERYTHING you still need from "
                    "it in ONE call (ranges=[...]/symbols=[...]) and stop "
                    "re-touching it — further windows are likely already in "
                    "context."
                )
            else:
                _pats = ", ".join(
                    f"'{_p}'" for _p in self._recent.get(f"grep:{label}", [])[:3]
                )
                _scope_disp = label.split("|")[0] or "/"
                lines.append(
                    f"- grep under {_scope_disp}: {_ord} search "
                    f"this turn on this scope ({_pats}). Merge any remaining "
                    "terms into ONE call via patterns=[...] instead of "
                    "another grep."
                )
        return (
            "\n\n📌 REPEAT NOTE: one file/scope keeps getting re-touched "
            "step after step (each step is a full round-trip):\n"
            + "\n".join(lines[:3])
        )


def _normalized_call_sig(name: str, args: dict) -> str:
    """Loop-guard signature: tool name + only the args that define the work.

    For read/grep/glob, windowing args (offset/limit/ranges) and cosmetic
    variants are dropped so "same file, different window" counts as a repeat
    — the model paging one file step after step is the loop shape we must
    catch. Other tools keep the full args (exact-arg repeats only).
    """
    name = str(name or "").lower()
    args = args or {}
    if name == "read":
        paths = [str(p) for p in [args.get("filePath"), *list(args.get("filePaths") or [])] if p]
        return f"read:{'|'.join(sorted(set(paths)))}"
    if name == "grep":
        # Keep the pattern: different terms on one scope are DIFFERENT work
        # (the revisit tracker nudges that shape softly); only the exact
        # same scope+pattern repeat is a doom-loop. Cosmetic args (max_results)
        # collapse so the repeat is still caught.
        scope = f"{args.get('path') or ''}|{args.get('include') or ''}"
        return f"grep:{scope}|{args.get('pattern') or ''}"
    if name == "glob":
        pats = "|".join(
            sorted(
                str(p)
                for p in [args.get("pattern") or "", *list(args.get("patterns") or [])]
                if p
            )
        )
        return f"glob:{pats}|{args.get('path') or ''}"
    try:
        return f"{name}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"
    except Exception:  # noqa: BLE001 — signature must never fail
        return f"{name}:{args!r}"


def _read_windows(args: dict) -> list[tuple[str, int, int]]:
    """Concrete (path, start1, end1) windows a read call will fetch.

    Mirrors read_tool's own window resolution (offset/limit, filePaths,
    ranges members). symbols= reads are precise by construction — they
    resolve server-side and never trigger the re-read nudge, so they are
    skipped here (which also steers the model toward symbols=).
    """
    args = args or {}
    if args.get("symbols"):
        return []
    try:
        offset = int(args.get("offset") or 1)
    except (TypeError, ValueError):
        offset = 1
    try:
        limit = int(args.get("limit") or 2000)
    except (TypeError, ValueError):
        limit = 2000
    wins: list[tuple[str, int, int]] = []
    for spec in args.get("ranges") or []:
        parts = str(spec).split(":")
        if (
            len(parts) == 3
            and parts[0].strip()
            and parts[1].strip().isdigit()
            and parts[2].strip().isdigit()
        ):
            o, li = int(parts[1]), int(parts[2])
            wins.append((parts[0].strip(), max(1, o), max(1, o) + max(1, li) - 1))
    ranged = {p for p, _, _ in wins}
    for p in [args.get("filePath"), *list(args.get("filePaths") or [])]:
        if p and str(p) not in ranged:
            o = max(1, offset)
            wins.append((str(p), o, o + max(1, limit) - 1))
    return wins


# ── Plan-only step detection (shared by both tool loops) ─────────────────
# A solo update_plan (no sibling tool call in the step) costs a full-context
# LLM round-trip, so batching it with the step's real work is preferred.
# But solo update_plan is LEGITIMATE when there is no next tool call to batch
# Only a solo update_plan that completes nothing is pure overhead. Ticks that
# mark step(s) completed (especially the final tick, which by definition has
# no following work) and plan mode's required initial checklist stay exempt
# from the backstop nudge — scolding those cases taught the model to never
# call update_plan at all, leaving todos/plan stale. The instruction text
# itself stays strict (always batch) so empty solos happen less often; the
# backstop just avoids spending an extra round-trip nagging a legitimate
# final tick.
_PLAN_ONLY_NUDGE = (
    "PLAN-ONLY STEP: that step did nothing but update_plan — a full "
    "round-trip for a checklist tick with no progress. NEVER send update_plan "
    "alone: always batch it with your next tool calls in the SAME step "
    "(parallel calls)."
)


def _is_plan_only_step(tcs: list) -> bool:
    """True when the step's calls are all update_plan (pure overhead)."""
    names = [(tc.get("name") or "").lower() for tc in tcs or []]
    return bool(names) and all(n == "update_plan" for n in names)


def _plan_only_step_marks_progress(tcs: list) -> bool:
    """True when a plan-only step marks at least one item completed.

    Final/progress ticks with no further tool work to batch with are
    legitimate solo steps — not overhead. Only a solo update_plan that
    completes nothing wastes a round-trip.
    """
    for tc in tcs or []:
        if (tc.get("name") or "").lower() != "update_plan":
            return False
        args = tc.get("args") or {}
        items = args.get("items") if isinstance(args, dict) else None
        if isinstance(items, list):
            for it in items:
                if (
                    isinstance(it, dict)
                    and str(it.get("status", "")).strip().lower() == "completed"
                ):
                    return True
    return False


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
    task_id: str = "",
) -> str:
    """Run a bounded tool-calling loop on a LangChain model.

    ``tools`` is a ``{name: callable}`` mapping (sync or async). Returns the
    final textual reply. Used by sub-agents (task) that need tools.

    Read-only tool calls requested in the same step run CONCURRENTLY via
    ``asyncio.gather`` (matching opencode's Promise.all); mutating/blocking
    tools run sequentially. See ``_SEQUENTIAL_TOOLS``.
    """
    lc_tools = [
        (
            fn
            if isinstance(fn, BaseTool)
            else StructuredTool.from_function(
                func=fn, name=name, description=(fn.__doc__ or name)
            )
        )
        for name, fn in tools.items()
    ]

    async def _exec(tc):
        """Execute a single tool call; never raises (errors become a result string).

        Read-only calls must not block the event loop: sync callables run in
        a worker thread so two concurrent sub-agent loops progress in
        parallel. This function never takes a shared lock; only the caller
        sequences _SEQUENTIAL_TOOLS one at a time.
        """
        name = tc.get("name") or ""
        args = tc.get("args") or {}
        fn = tools.get(name)
        if fn is None:
            return (
                f"ERROR: unknown tool {name!r}. "
                f"Bound tools: {', '.join(sorted(tools.keys())) or '(none)'}. "
                "Never claim a listed tool is unavailable — call it directly "
                "and report this exact ERROR if it fails."
            )
        try:
            if isinstance(fn, BaseTool):
                # MCP tools arrive as ready-made BaseTool instances (their
                # .name IS the dict key). Calling fn(**args) would resolve
                # BaseTool.__call__ -> type.__call__ and crash with
                # "descriptor '__call__' for 'type' objects..."; the Runnable
                # API is the correct invocation path.
                r = fn.ainvoke(args or {})
            elif inspect.iscoroutinefunction(fn):
                r = fn(**(args or {}))
            else:
                # Sync callable (blocking disk I/O): offload to a worker
                # thread so a sibling sub-agent sharing this event loop is
                # never stalled behind this call.
                r = await asyncio.to_thread(fn, **(args or {}))
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
    _sub_tid = str(task_id or "").strip()
    # Trace the sub-agent's own prompt so its filtered trace view shows the
    # full request like the main chat trace (best-effort, never breaks loop).
    if _sub_tid:
        try:
            import trace_store as _trace_store_prompt

            _trace_store_prompt.append(
                "",
                "prompt",
                f"sub-agent · {len(str(user or ''))} chars",
                detail={"mode": "subagent", "sub": True, "task_id": _sub_tid},
                prompt=f"[system]\n{system}\n\n[user]\n{user}" if (system or user) else "",
                task_id=_sub_tid,
            )
        except Exception:  # noqa: BLE001, S110 — trace must never break the loop
            pass
    steps = 0
    # opencode's doom-loop guard: if the model issues the SAME tool call (same
    # name + same args) N times in a row, it is stuck in a loop — stop burning
    # tokens and force it to report findings instead.
    _last_call_sig = None
    _same_call_streak = 0
    _last_exact_sig = None
    _same_exact_streak = 0
    # Exact repeats (same name + same args) hard-stop at 3; paging one file
    # window-per-step shares the normalized signature but differs in exact
    # args, so a short survey survives with only a revisit nudge.
    _DOOM_LOOP_LIMIT = 3
    _DOOM_LOOP_PAGING_LIMIT = 5
    # Cross-step batching tracker: catches the model firing ONE batchable
    # call per step (the common case when parallel_tool_calls is not sent)
    # and reminds it to batch after a few consecutive same-scope steps.
    _streak = _BatchStreakTracker()
    _revisit = _RevisitStreakTracker()
    _no_pc = False  # flips on a parallel_tool_calls 400 (strip and retry once)
    _no_re = 0  # counts reasoning-effort remaps (up to 3, xhigh<->max chain)
    # Reminders / steering are TRANSIENT: sent with the very next request only,
    # never stored in msgs. Stored copies were re-sent on every later step (one
    # more per step while a streak lasted), growing the context for no benefit.
    _transient: list[Any] = []
    while steps < max_steps:
        steps += 1
        _step_t0 = time.monotonic()
        # Mid-run steer: a follow-up the main agent queued via task_steer for
        # the job driving this loop (tools.py sets RUNNING_TASK_CTX). Drained
        # BETWEEN steps so the steer lands while the sub-agent is still
        # running, instead of only after its whole run; tools.py's post-run
        # follow-up loop then finds an empty inbox and needs no extra round.
        # Best-effort: a steer must never break the loop.
        try:
            import subagent_jobs as _sj

            _steer_tid = _sj.RUNNING_TASK_CTX.get()
            if _steer_tid:
                for _steer_msg in _sj.drain_steer(_steer_tid):
                    msgs.append(
                        HumanMessage(
                            content=(
                                "[steer from the main agent - continue the same "
                                f"task, incorporating this]\n{_steer_msg}"
                            )
                        )
                    )
        except Exception:  # noqa: BLE001, S110 — steer injection is best-effort
            pass
        if emit is not None:
            try:
                emit(
                    {
                        "kind": "status",
                        "stage": "subagent",
                        "content": f"sub-agent step {steps}/{max_steps}",
                    }
                )
            except Exception:  # noqa: BLE001, S110 — progress never breaks loop
                pass
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
        # Final transcript guard (dedupe ids + drop unanswered + one output
        # per id) -- same bottleneck as the main path.
        normalize_tool_transcript(msgs, _logger)
        _req = [*project_tool_results(_stable_tool_order(msgs)), *_transient]
        _llm_t0 = time.monotonic()
        while True:
            try:
                ai = await bind_tools_parallel(model, lc_tools, not _no_pc).ainvoke(_req)
                break
            except Exception as _pc_exc:
                # Always-thinking route rejected our effort (e.g. Kimi rejects
                # xhigh but accepts max): remap and retry the same step.
                if _no_re < 3 and _is_reasoning_effort_error(_pc_exc):
                    _remapped = _remap_reasoning_effort(model, _pc_exc)
                    _old = getattr(model, "reasoning_effort", None) or (
                        getattr(model, "model_kwargs", None) or {}
                    ).get("reasoning_effort")
                    _new = getattr(_remapped, "reasoning_effort", None) or (
                        getattr(_remapped, "model_kwargs", None) or {}
                    ).get("reasoning_effort")
                    if _new != _old:
                        _no_re += 1
                        model = _remapped
                        continue
                    raise
                # Some gateways/models reject `parallel_tool_calls` with a 400 —
                # retry this step once without it (same fallback as graph.py).
                if _no_pc or not _is_parallel_calls_error(_pc_exc):
                    raise
                _no_pc = True
                continue
        _llm_wait_s = time.monotonic() - _llm_t0
        try:
            _logger.info(
                "[step-timing] subagent step=%s/%s llm=%.1fs tools_pending=%s",
                steps,
                max_steps,
                _llm_wait_s,
                len(getattr(ai, "tool_calls", None) or []),
            )
        except Exception:  # noqa: BLE001, S110 — timing never breaks loop
            pass
        # Surface the sub-agent's own token usage so the frontend can accrue it
        # into the chat-wide session totals (the "Model usage" sidebar). The
        # main-agent loop emits usage from agents.py; sub-agents run through this
        # LangChain loop and were silently dropping usage_metadata. The caller's
        # `emit` (tools._emit) stamps `sub=True` so it stays out of the parent's
        # context meter while still counting toward the session total.
        if emit is not None:
            _um = getattr(ai, "usage_metadata", None)
            if _um:
                _kind, _pid = model_provider(model)
                _ev = usage_event(
                    _um,
                    model=str(getattr(model, "model_name", "") or ""),
                    sub=True,
                    provider=_kind,
                    provider_id=_pid,
                )
                if _ev:
                    emit(_ev)
            # Trace each sub-agent model step so its filtered trace view shows
            # LLM activity, not just tool calls (best-effort, never breaks loop).
            if _sub_tid:
                try:
                    import trace_store as _trace_store_step

                    _u = _um if isinstance(_um, dict) else {}
                    _total = int(_u.get("total_tokens", 0) or 0)
                    _trace_store_step.append(
                        "",
                        "llm",
                        f"{getattr(model, 'model_name', '') or 'llm'!s} · step {steps} · {_total} tokens",
                        detail={
                            "provider": _u.get("provider"),
                            "provider_id": _u.get("provider_id"),
                            "input_tokens": int(_u.get("input_tokens", 0) or 0),
                            "output_tokens": int(_u.get("output_tokens", 0) or 0),
                            "total_tokens": _total,
                            "step": int(steps or 0),
                            "sub": True,
                            "task_id": _sub_tid,
                        },
                        model=str(getattr(model, "model_name", "") or ""),
                        tokens={
                            "input": int(_u.get("input_tokens", 0) or 0),
                            "output": int(_u.get("output_tokens", 0) or 0),
                            "total": _total,
                        },
                        result=str(getattr(ai, "content", "") or "")[:8000],
                        task_id=_sub_tid,
                    )
                except Exception:  # noqa: BLE001, S110 — trace must never break the loop
                    pass
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
        # Duplicate ids within one message need one shared ToolMessage, and the
        # provider rejects them with "Duplicate function_call_output" -- dedupe
        # before recording so each call gets its own answer.
        _reserved_tc_ids = {
            str(m.tool_call_id)
            for m in msgs
            if isinstance(m, ToolMessage) and m.tool_call_id
        }
        dedupe_step_tool_call_ids(ai, _reserved_tc_ids)
        msgs.append(ai)
        # --- doom-loop guard (opencode's repeated-call detector) ---
        # NORMALIZED signature: read keeps only the file identity (windowing
        # args dropped), grep/glob keep scope+pattern — so paging one file
        # window after window counts as a repeat, the near-miss loop shape the
        # exact-args guard missed. Runs BEFORE execution so a repeated step is
        # short-circuited instead of re-burning tool I/O for the same result.
        _step_sig = "|".join(
            _normalized_call_sig(tc.get("name") or "", tc.get("args") or {})
            for tc in tcs
        )
        _exact_sig = "|".join(
            f"{tc.get('name') or ''}:{json.dumps(tc.get('args') or {}, sort_keys=True, ensure_ascii=False)}"
            for tc in tcs
        )
        if _step_sig == _last_call_sig:
            _same_call_streak += 1
        else:
            _same_call_streak = 1
            _last_call_sig = _step_sig
        if _exact_sig == _last_exact_sig:
            _same_exact_streak += 1
        else:
            _same_exact_streak = 1
            _last_exact_sig = _exact_sig
        _doom_hit = _same_exact_streak >= _DOOM_LOOP_LIMIT or _same_call_streak >= _DOOM_LOOP_PAGING_LIMIT
        if _doom_hit:
            # Hard stop: the model is stuck. Inject as HumanMessage (not
            # SystemMessage) so it lands mid-list without violating chat
            # templates that require SystemMessage only at position 0
            # (e.g. Qwen3.5 / llama.cpp).
            msgs.append(
                HumanMessage(
                    content=(
                        "[steering] You have issued the same tool call 3 times "
                        "in a row (same file/scope) — this is a loop. Stop "
                        "calling tools and report your findings in text now."
                    )
                )
            )
            break
        if _same_exact_streak >= 2:
            # Second consecutive identical step: cheap transient nudge (next
            # request only) + repeat short-circuit — point the model back at
            # the transcript instead of re-executing the identical calls.
            # Only exact repeats short-circuit here so paging one file
            # window-per-step still executes and reaches the revisit nudge.
            _transient.clear()
            _transient.append(
                HumanMessage(
                    content=(
                        "[steering] You just repeated the previous step's tool "
                        "call (same file/scope). Its result is already in the "
                        "transcript above — do NOT re-run it. Change your "
                        "approach or report your findings in text now."
                    )
                )
            )
            for tc in tcs:
                append_tool_result(
                    msgs,
                    (
                        "[repeat] This call is identical to the previous "
                        "step's call — its result is already in the transcript "
                        "above. Do not re-issue it; use what you already hold."
                    ),
                    tc.get("id", ""),
                )
            continue
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
        # Always observe — `or` would short-circuit the tracker whenever the
        # per-step detector fires, so that step would never be recorded and
        # the cross-step count would restart from zero. (The merge advice
        # itself runs later on the merged call list — see below.)
        _step_hint = ""
        _streak_hint = _streak.observe(tcs)
        _revisit_hint = _revisit.observe(tcs)
        # Join, never `or`: one pattern (e.g. one read per step) trips
        # several trackers at once and each reminder matters — `or` let the
        # first one starve the rest, which is how file paging looped
        # silently behind an ignored batching note.
        _batch_hint = "\n".join(
            h for h in (_step_hint, _streak_hint, _revisit_hint) if h
        )
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
        # Same-scope back-to-back greps run as one scan (see tool_batching);
        # the nudge reads the merged list so it never re-suggests the merge.
        _exec_calls, _expand_merged = merge_same_scope_greps(_parallel)
        _step_hint = _batchable_nudge([*_exec_calls, *_sequential])
        _batch_hint = "\n".join(
            h for h in (_step_hint, _streak_hint, _revisit_hint) if h
        )
        # Per-step tool activity line: the right-panel sub-agent trail tees
        # status events, so naming the tools here gives it live progress even
        # though the tools themselves emit through the parent's emit.
        if emit is not None and tcs:
            try:
                emit(
                    {
                        "kind": "status",
                        "stage": "subagent",
                        "content": "→ "
                        + ", ".join(
                            str(tc.get("name") or "?") for tc in ([*_exec_calls, *_sequential])
                        ),
                    }
                )
            except Exception:  # noqa: BLE001, S110 — progress never breaks loop
                pass
        _results = await execute_readonly_calls(_exec_calls, _exec)
        _expanded = _expand_merged(_results)
        for tc, result in zip(_parallel, _expanded):
            _cid = tc.get("id", "")
            append_tool_result(msgs, str(result), _cid)
        for tc in _sequential:
            result = await _exec(tc)
            _cid = tc.get("id", "")
            append_tool_result(msgs, str(result), _cid)
        # Completion counterpart of the in-flight line above: one event per
        # executed call so the right-panel sub-agent trail renders → / ✓
        # pairs per tool, like the chat's tool cards.
        if emit is not None and tcs:
            for _done_tc in (*_exec_calls, *_sequential):
                try:
                    emit(
                        {
                            "kind": "status",
                            "stage": "subagent",
                            "content": f"✓ {_done_tc.get('name') or '?'}",
                        }
                    )
                except Exception:  # noqa: BLE001, S110 — progress never breaks loop
                    pass
        # Emit ToolMessages for duplicate tool calls that were deduped above so
        # the LLM sees a result for every tool_call_id it originally sent.
        if _dup_ids:
            for _dup_id, _orig_id in _dup_ids.items():
                for _m in reversed(msgs):
                    if (
                        isinstance(_m, ToolMessage)
                        and getattr(_m, "tool_call_id", "") == _orig_id
                    ):
                        append_tool_result(msgs, _m.content, _dup_id)
                        break
        # Batching reminder: delivered as its OWN HumanMessage AFTER the tool
        # results (same placement as the steering messages below) — a
        # standalone message is impossible to miss, unlike a suffix at the
        # end of a huge result.
        _transient.clear()
        if _batch_hint:
            _transient.append(HumanMessage(content=_batch_hint.strip()))
        if _is_plan_only_step(tcs) and not _plan_only_step_marks_progress(tcs):
            _transient.append(HumanMessage(content=_PLAN_ONLY_NUDGE))
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
    _cid_n = 0
    for d in new_history:
        role = d.get("role")
        content = str(d.get("content") or "")
        if role == "system" and had_system:
            # The compact head ("[Compacted earlier context]") is the sub-agent's
            # ONLY memory of the summarized turns — dropping it (the old `continue`)
            # made the sub-agent forget everything it had done before compaction.
            # opencode keeps the summary as its own message; inject it as a
            # HumanMessage (never a second SystemMessage — strict Jinja
            # templates require system only at position 0).
            if content:
                rebuilt.append(HumanMessage(content=content))
            continue
        if role == "assistant":
            rebuilt.append(AIMessage(content=content))
        elif role == "tool":
            # NOTE: several compacted ToolMessages sharing one fixed tool_call_id
            # produce a 400 "Duplicate function_call_output" error; keep ids
            # unique with a counter so the pre-flight guard does not drop them.
            _cid = f"__compacted__{_cid_n}" if _cid_n else "__compacted__"
            _cid_n += 1
            rebuilt.append(ToolMessage(content=content, tool_call_id=_cid))
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
    provider_id: str = "",
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
            provided_total = int(
                (
                    metadata.get("total_tokens")
                    if isinstance(metadata, dict)
                    else getattr(metadata, "total_tokens", 0)
                )
                or 0
            )
            # Trust the provider total only when it covers input + output: some
            # routers report a total that excludes the cached subset of the
            # prompt, which would under-count the context meter by exactly the
            # cached portion. Inconsistent totals fall back to the hand-sum.
            total = (
                provided_total
                if provided_total >= input_tokens + output_tokens
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
            "provider_id": provider_id,
        }
    except Exception:  # noqa: BLE001 -- usage must never crash a run
        return None
