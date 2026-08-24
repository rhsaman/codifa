"""Provider abstraction: map UI provider configs to Pydantic AI models.

All three supported provider types expose an OpenAI-compatible HTTP API, so
every one collapses to pydantic_ai's ``OpenAIModel`` with a custom base URL and
API key.

Model lists are fetched live from the provider and cached for a short TTL.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from collections.abc import Sequence

import httpx

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENCODE_BASE = "https://opencode.ai/zen/v1"
OLLAMA_BASE = "http://localhost:11434"
# Gemini's OpenAI-compatible endpoint. Both API keys and OAuth access tokens
# authenticate here via `Authorization: Bearer <credential>`.
GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
NVIDIA_BASE = "https://integrate.api.nvidia.com/v1"
TOKENROUTER_BASE = "https://api.tokenrouter.com/v1"
# Cloudflare's OpenAI-compatible /ai/v1 endpoint is account-scoped; the account
# id (CLOUDFLARE_ACCOUNT_ID) is injected via the `{account}` token.
CLOUDFLARE_ACCOUNTS_BASE = "https://api.cloudflare.com/client/v4/accounts"
GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_OAUTH_SCOPES = (
    "https://www.googleapis.com/auth/cloud-platform "
    "https://www.googleapis.com/auth/generative-language.retriever "
    "https://www.googleapis.com/auth/webmasters.readonly"
)
# Search Console API (webmasters) scope for the search_console tool. Now merged
# into GOOGLE_OAUTH_SCOPES so ONE Google sign-in (Gemini + Search Console)
# covers everything with a single consent / refresh token.
GOOGLE_SEARCH_CONSOLE_SCOPES = "https://www.googleapis.com/auth/webmasters.readonly"
# Access tokens from the OAuth flow live ~1h; refresh before expiry.
GOOGLE_TOKEN_LEEWAY = 120  # seconds
# In-memory cache of (access_token, expiry_ts) keyed by the refresh token so a
# long tool-loop turn doesn't mint a fresh token per request.
_google_token_cache: dict[str, tuple[str, float]] = {}

# opencode's zen gateway misclassifies plain python/httpx clients as
# rate-limited: the default `python-httpx/...` / `pydantic-ai/...` User-Agent
# gets a bogus HTTP 429 `FreeUsageLimitError` even on a healthy free-tier
# account, while a UA that looks like the real opencode client streams
# normally. This constant is the hammer used everywhere a request to the zen
# gateway is built (provider client default headers AND per-request model
# settings extra_headers — pydantic-ai's own openai adapter unconditionally
# overrides the UA with `pydantic-ai/x.y.z` unless the setting already carries
# one).
OPENCODE_UA = "opencode/1.18.15 (npm:@opencode-ai/opencode)"


def model_timeout(
    model: object | None = None,
    provider: str = "",
    total: float = 300,
    connect: float = 15,
    read: float = 300,
) -> int | float | httpx.Timeout:
    """Return a ModelSettings-compatible ``timeout`` for a model/provider.

    Google's ``GoogleModel`` only accepts a scalar ``int | float`` (it converts
    it to milliseconds at request time); passing an ``httpx.Timeout`` raises
    ``UserError('Google does not support setting ModelSettings.timeout to a
    httpx.Timeout')`` and kills every request. Detect Google by provider name or
    by model type, and return the scalar. All other providers accept the
    granular ``httpx.Timeout`` (connect vs read).
    """
    is_google = _provider_meta(provider).get("model_class") == "google"
    if is_google:
        return total
    return httpx.Timeout(total, connect=connect, read=read)


def is_opencode(provider: str = "", base_url: str = "") -> bool:
    """True for the opencode zen gateway (which needs the spoofed UA)."""
    if _provider_meta(provider).get("ua_spoof"):
        return True
    return "opencode.ai" in (base_url or "")

# opencode's own /models endpoint does NOT advertise a context window. Rather
# than hardcode a per-model map here (which silently goes stale the moment
# opencode adds/renames a model), we fetch it live from models.dev — a
# community-maintained, machine-readable catalog that opencode's own docs
# point to ("Standard providers pull these from models.dev automatically").
# Cached for MODELS_DEV_CACHE_TTL since the catalog changes rarely. ONLY
# consulted for provider == "opencode" — openrouter/ollama/custom already
# report real context via their own APIs.
MODELS_DEV_API = "https://models.dev/api.json"
MODELS_DEV_CACHE_TTL = 3600  # seconds
_models_dev_cache: tuple[float, dict] | None = None

_MODEL_CACHE_TTL = 120  # seconds
_model_cache: dict[tuple, tuple[float, list[str]]] = {}

class ProviderError(RuntimeError):
    pass


# Provider kind → metadata shared by credential resolution, error messages,
# base-URL resolution, model-list format and model construction. This is the
# SINGLE source of truth for adding a gateway: ONE entry here (plus its
# frontend twin in src/lib/provider-meta.ts) — never more per-kind if/else
# blocks scattered across the module.
#
# Fields:
#   name                 Display name.
#   requires_key         True = a credential is mandatory (blocked otherwise).
#   env_vars             Env-var names accepted for the API key.
#   account_var          Optional env var carrying an account/org id (cloudflare).
#   model_class          "google" | "openrouter" use pydantic-ai native model
#                        classes; everything else uses the generic OpenAIChatModel.
#   models               Model-list payload format: "openai" (GET /models,
#                        `data[]`), "tags" (ollama /api/tags) or
#                        "cloudflare_search" (GET .../ai/models/search, `result[]`).
#   base_url             Static base URL; `{account}` is substituted from
#                        `account_var`. If editable_base_url, this is only the
#                        default the user can override.
#   models_url           Optional override for the model-list URL (cloudflare
#                        has no /models under /ai/v1).
#   models_timeout       Optional HTTP timeout for the model-list request.
#   ua_spoof             Spoof the opencode User-Agent (opencode zen gateway).
#   continuous_usage     Provider streams cumulative usage per chunk (opencode).
#   cache_headers        Set openrouter_cache_* breakpoints (openrouter).
#   auto_think           Gate auto-thinking level by context size (cloud LLMs).
#   id_prefix            Provider prefix re-added to bare model ids on the
#                        request (nvidia, openrouter, opencode). opencode's zen
#                        gateway requires the prefixed form ("opencode/...").
#   strip_models_prefix  Strip a leading `models/` from model ids (google).
#   free_ctx_fallback    Treat `-free` models as 200K context (opencode).
#   editable_base_url    User can enter a custom base URL (custom/ollama).
#   local                Runs locally, no network credential (ollama).
#   parallel_calls       OpenAI-compatible gateway that honors `parallel_tool_calls`
#                        in the request body. Only these kinds get the flag; local
#                        (ollama) and non-OpenAI-compatible kinds (google) never
#                        see it, so no request can fail on an unsupported field.
_PROVIDERS: dict[str, dict] = {
    "google": {
        "name": "Google",
        "requires_key": True,
        "env_vars": ("GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"),
        "model_class": "google",
        "models": "openai",
        "base_url": GOOGLE_BASE,
        "strip_models_prefix": True,
    },
    "openrouter": {
        "name": "OpenRouter",
        "requires_key": True,
        "env_vars": ("OPENROUTER_API_KEY",),
        "model_class": "openrouter",
        "models": "openai",
        "base_url": OPENROUTER_BASE,
        "models_timeout": 60,
        "id_prefix": "openrouter",
        "cache_headers": True,
        "auto_think": True,
        "parallel_calls": True,
    },
    "opencode": {
        "name": "opencode",
        "requires_key": False,  # free-tier may work keyless; never hard-block
        "env_vars": ("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"),
        "model_class": "openai",
        "models": "openai",
        # opencode is its OWN gateway (never routed through OpenRouter) —
        # configurable via env OPENCODE_BASE_URL, defaulting to opencode.ai.
        "base_url": OPENCODE_BASE,
        "env_base_url": "OPENCODE_BASE_URL",
        "ua_spoof": True,
        "continuous_usage": True,
        "auto_think": True,
        # opencode.ai/zen takes the model id EXACTLY as stored — both bare ids
        # ("hy3-free") and provider-prefixed ids ("opencode/claude-3.5-sonnet")
        # are accepted in the form the UI saves them. Do NOT add or strip a
        # prefix here: qualifying a bare id to "opencode/<id>" is rejected with
        # HTTP 401 "Model is not supported" (observed for "hy3-free").
        "free_ctx_fallback": True,
        "parallel_calls": True,
    },
    "ollama": {
        "name": "local",
        "requires_key": False,
        "env_vars": (),
        "model_class": "openai",
        "models": "tags",
        "base_url": OLLAMA_BASE,
        "editable_base_url": True,
        "local": True,
    },
    "custom": {
        "name": "Custom API",
        "requires_key": False,
        "env_vars": (),
        "model_class": "openai",
        "models": "openai",
        "base_url": "",
        "editable_base_url": True,
        "parallel_calls": True,
    },
    "nvidia": {
        "name": "NVIDIA",
        "requires_key": True,
        "env_vars": ("NVIDIA_API_KEY",),
        "model_class": "openai",
        "models": "openai",
        "base_url": NVIDIA_BASE,
        # NVIDIA's canonical ids are "nvidia/<model>" for its own models — the
        # API 404s on a bare id. The UI stores the bare form, so re-add the
        # prefix here when the stored id is slash-less.
        "id_prefix": "nvidia",
        "auto_think": True,
        "parallel_calls": True,
    },
    "cloudflare": {
        "name": "Cloudflare",
        "requires_key": True,
        "env_vars": ("CLOUDFLARE_AUTH_TOKEN", "CLOUDFLARE_API_TOKEN"),
        "account_var": "CLOUDFLARE_ACCOUNT_ID",
        "model_class": "openai",
        "models": "cloudflare_search",
        "models_id_field": "name",  # search rows key the model under `name`, not `id`
        "base_url": CLOUDFLARE_ACCOUNTS_BASE + "/{account}/ai/v1",
        "models_url": CLOUDFLARE_ACCOUNTS_BASE + "/{account}/ai/models/search",
        "auto_think": True,
        "parallel_calls": True,
    },
    "tokenrouter": {
        "name": "TokenRouter",
        "requires_key": True,
        "env_vars": ("TOKEN_ROUTER_API_KEY", "TOKENROUTER_API_KEY"),
        "model_class": "openai",
        "models": "openai",
        "base_url": TOKENROUTER_BASE,
        "models_query": "?limit=200",  # gateway 400s on /models without any arg
        "auto_think": True,
        "parallel_calls": True,
    },
}

# Fallback for kinds without a table entry (custom endpoints) so a machine that
# only exports one gateway key still works everywhere.
_ENV_FALLBACK = ("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENROUTER_API_KEY")


def _provider_meta(provider: str) -> dict:
    """Meta entry for a provider kind (empty dict for unknown/custom kinds)."""
    return _PROVIDERS.get(provider) or {}


def _provider_env_names(provider: str) -> tuple[str, ...]:
    meta = _provider_meta(provider)
    return meta.get("env_vars") or _ENV_FALLBACK


def _provider_account(provider: str) -> str:
    """Account/org id from env (e.g. Cloudflare's CLOUDFLARE_ACCOUNT_ID)."""
    var = _provider_meta(provider).get("account_var")
    return (os.environ.get(var) or "").strip() if var else ""


def qualify_model_id(provider: str, model: str) -> str:
    """Re-add a provider's model-id prefix when the stored id lost it.

    Some gateways (nvidia, openrouter, opencode) prefix their OWN models with
    the provider name — ``nvidia/nemotron-mini-4b-instruct``,
    ``opencode/claude-3.5-sonnet`` — and the API rejects a bare id (opencode
    responds with HTTP 401 "Model is not supported"). The UI stores the bare
    form (its picker strips the ``providerId/`` prefix), so put it back when the
    id no longer carries a vendor/model separator. Ids with a slash (e.g.
    ``meta/llama-3.3-70b`` on NVIDIA, ``deepseek/deepseek-chat`` on OpenRouter)
    are left untouched.
    """
    if not model:
        return model
    prefix = _provider_meta(provider).get("id_prefix")
    if prefix and "/" not in model:
        return f"{prefix}/{model}"
    return model


def env_key(provider: str = "", env_var: str = "") -> str:
    """API key from the global environment for a provider (env takes precedence).

    When an explicit ``env_var`` name is given (per-provider setting), it is
    read directly from the environment; if that exact variable isn't set we fall
    back to the provider's other known names (e.g. a machine that only exports
    OPENCODE_ZEN_API_KEY still works when the app asks for OPENCODE_API_KEY).
    """
    if env_var and env_var.strip():
        val = os.environ.get(env_var.strip())
        if val:
            return val
        return env_key(provider=provider, env_var="")
    for name in _provider_env_names(provider):
        val = os.environ.get(name)
        if val:
            return val
    return ""


async def google_exchange_code(
    client_id: str, client_secret: str, code: str, redirect_uri: str
) -> dict:
    """Exchange an OAuth authorization code for tokens (access + refresh)."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            GOOGLE_OAUTH_TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        data = resp.json()
        if resp.status_code >= 400:
            raise ProviderError(
                f"google oauth token exchange failed ({resp.status_code}): "
                f"{data.get('error_description') or data.get('error') or data}"
            )
        return data


async def google_refresh_token(
    client_id: str, client_secret: str, refresh_token: str
) -> dict:
    """Refresh an OAuth access token from its refresh token."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            GOOGLE_OAUTH_TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
            },
        )
        data = resp.json()
        if resp.status_code >= 400:
            raise ProviderError(
                f"google oauth refresh failed ({resp.status_code}): "
                f"{data.get('error_description') or data.get('error') or data}"
            )
        return data


async def google_access_token(
    client_id: str, client_secret: str, refresh_token: str
) -> str:
    """Return a valid Google OAuth access token for the stored refresh token,
    refreshing + caching it (per-process) so repeated calls stay cheap."""
    now = time.monotonic()
    cached = _google_token_cache.get(refresh_token)
    if cached and cached[1] > now + GOOGLE_TOKEN_LEEWAY:
        return cached[0]
    data = await google_refresh_token(client_id, client_secret, refresh_token)
    access = data.get("access_token") or ""
    if not access:
        raise ProviderError("google oauth refresh returned no access_token")
    # Fall back to wall-clock expiry when the API omits expires_in.
    expires_in = int(data.get("expires_in") or 3600)
    _google_token_cache[refresh_token] = (access, now + expires_in)
    return access


def normalize_base_url(provider: str, base_url: str) -> str:
    """Return the OpenAI-compatible base URL for a provider.

    Driven entirely by the ``_PROVIDERS`` table: built-in gateways use their
    own ``base_url`` (with ``{account}``/``env_base_url`` substitution and any
    ``models_url`` override), while only kinds with ``editable_base_url``
    (custom / ollama) honor a user-supplied URL.
    """
    meta = _provider_meta(provider)
    if meta.get("editable_base_url"):
        base = (base_url or "").strip().rstrip("/")
        if provider == "ollama":
            if base and ("/v1" in base):
                return base
            return (base or OLLAMA_BASE) + "/v1"
        return base
    return _expand_base(meta.get("base_url") or "", provider)


def _expand_base(template: str, provider: str) -> str:
    """Substitute the provider's dynamic tokens into a base-URL template."""
    base = template
    if "{account}" in base:
        acct = _provider_account(provider)
        base = base.replace("{account}", acct) if acct else ""
    if meta_base := _provider_meta(provider).get("env_base_url"):
        base = os.environ.get(meta_base) or base
    return base.rstrip("/")


def _is_deepseek_reasoning_model(model: str) -> bool:
    """DeepSeek reasoning models require `reasoning_content` round-trip on every
    assistant message while thinking is active; plain chat models (deepseek-chat
    / deepseek-v3) don't and can ignore the extra field.

    Matches deepseek-reasoner / deepseek-r1 / deepseek-v4* / deepseek-v3.1*
    (and any id carrying "thinking"/"reason"), but NOT deepseek-chat / v3.
    """
    m = (model or "").lower()
    if "deepseek" not in m:
        return False
    return any(token in m for token in ("reasoner", "r1", "v4", "v3.1", "thinking", "reason"))


def _models_endpoint(provider: str, base_url: str) -> tuple[str, str]:
    """Return (url, format) for the provider's model-list endpoint.

    Format is one of ``models`` (OpenAI ``/models`` → ``data[]``), ``tags``
    (ollama ``/api/tags``) or ``cloudflare_search`` (``result[]``).
    """
    meta = _provider_meta(provider)
    if meta.get("models_url"):
        return _expand_base(meta["models_url"], provider), meta.get("models") or "openai"
    if meta.get("models") == "tags":
        # The "ollama" provider in the UI is the generic LOCAL endpoint
        # (llama.cpp / LM Studio / vLLM / Ollama). A custom base URL means a
        # non-Ollama OpenAI-compatible server, which lists via /v1/models, not
        # Ollama's /api/tags — otherwise llama.cpp/LM Studio return nothing and
        # the UI can't show the model's real context window.
        if provider == "ollama" and base_url and base_url.strip().rstrip("/") not in (
            "",
            OLLAMA_BASE.rstrip("/"),
        ):
            base = normalize_base_url(provider, base_url)
            return base + "/models", "openai"
        base = (base_url or OLLAMA_BASE).rstrip("/")
        return base + "/api/tags", "tags"
    base = normalize_base_url(provider, base_url)
    query = meta.get("models_query") or ""
    return base + "/models" + query, "openai"


def _entry_context(entry: dict) -> int | None:
    """Best-effort context-window (tokens) from a /models entry.

    Tries the field names used by the various OpenAI-compatible gateways
    (openrouter ``context_length``, vLLM/LM Studio ``max_model_len``, ...).
    """
    for key in (
        "context_length",
        "max_context_length",
        "context_window",
        "max_model_len",
        "context_len",
    ):
        val = entry.get(key)
        if val:
            try:
                return int(val)
            except (TypeError, ValueError):
                continue
    return None


def _entry_max_output(entry: dict) -> int | None:
    """Best-effort max output tokens from a /models entry.

    OpenRouter advertises ``max_completion_tokens`` (top-level or under
    ``top_provider``); some gateways use ``max_output_tokens``.
    """
    for key in ("max_completion_tokens", "max_output_tokens", "output_tokens"):
        val = entry.get(key)
        if val:
            try:
                return int(val)
            except (TypeError, ValueError):
                continue
    top = entry.get("top_provider") or {}
    val = top.get("max_completion_tokens")
    if val:
        try:
            return int(val)
        except (TypeError, ValueError):
            pass
    return None


def _entry_pricing(entry: dict) -> dict | None:
    """Best-effort USD-per-MILLION-token pricing from a /models entry.

    OpenRouter's payload carries this under ``pricing.prompt`` / ``pricing.completion``
    as decimal-string USD-per-TOKEN (e.g. "0.0000008") — normalize to USD per
    MILLION tokens (models.dev's own convention, see ``_models_dev_pricing``
    below) so callers use one unit everywhere. A price of exactly 0 is a real,
    meaningful value (free models) and is kept, not treated as missing.

    When the provider also advertises per-token cache rates
    (``pricing.cache_read_input_tokens`` / ``pricing.cache_write_input_tokens``,
    OpenRouter), those are normalized to per-million ``cacheRead`` / ``cacheWrite``
    so the sidebar cost meter can bill cache-read tokens at the cheaper rate.
    """
    pricing = entry.get("pricing")
    if not isinstance(pricing, dict):
        return None
    prompt = pricing.get("prompt")
    completion = pricing.get("completion")
    if prompt is None or completion is None:
        return None
    try:
        out = {
            "input": float(prompt) * 1_000_000,
            "output": float(completion) * 1_000_000,
        }
        cache_read = pricing.get("cache_read_input_tokens")
        cache_write = pricing.get("cache_write_input_tokens")
        if cache_read is not None:
            out["cacheRead"] = float(cache_read) * 1_000_000
        if cache_write is not None:
            out["cacheWrite"] = float(cache_write) * 1_000_000
        return out
    except (TypeError, ValueError):
        return None


def _entry_reasoning(entry: dict) -> bool | None:
    """Best-effort reasoning-support flag from a models-listing entry.

    Some gateways advertise a boolean ``reasoning`` field (OpenRouter carries
    it on newer entries; others use ``supports_reasoning``). Returns None when
    the payload doesn't say — callers then fall back to the models.dev catalog
    or a name-based heuristic.
    """
    for key in ("reasoning", "supports_reasoning", "reasoning_supported"):
        val = entry.get(key)
        if isinstance(val, bool):
            return val
    return None


def _server_root(base_url: str) -> str:
    """Strip a trailing /v1 so server-level endpoints (/props) resolve."""
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3].rstrip("/")
    return root


async def _llamacpp_default_ctx(base_url: str) -> int | None:
    """Default ``n_ctx`` for a llama.cpp / LM Studio server from GET /props."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(_server_root(base_url) + "/props")
            resp.raise_for_status()
            n = (resp.json().get("default_generation_settings") or {}).get("n_ctx")
            return int(n) if n else None
    except Exception:  # noqa: BLE001
        return None


async def _lmstudio_context(root: str, model_id: str = "") -> int | None:
    """Real context window for a local LM Studio model via its native API."""
    def _extract(obj):
        if not isinstance(obj, dict):
            return None
        if isinstance(obj.get("data"), dict):
            obj = obj["data"]
        for key in ("context_length", "max_seq_len", "n_ctx"):
            v = obj.get(key)
            if v:
                try:
                    return int(v)
                except (TypeError, ValueError):
                    pass
        info = obj.get("model_info") or {}
        if isinstance(info, dict):
            for key in ("context_length", "max_seq_len", "n_ctx"):
                v = info.get(key)
                if v:
                    try:
                        return int(v)
                    except (TypeError, ValueError):
                        pass
        return None

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if model_id:
                try:
                    r = await client.get(root + "/api/v1/model")
                    if r.status_code == 200:
                        n = _extract(r.json())
                        if n:
                            return n
                except Exception:  # noqa: BLE001
                    pass
            r = await client.get(root + "/api/v1/models")
            if r.status_code == 200:
                data = r.json()
                models = data.get("data") or []
                if not isinstance(models, list):
                    models = [models]
                for m in models:
                    if model_id and m.get("id") != model_id and m.get("model_key") != model_id:
                        continue
                    n = _extract(m)
                    if n:
                        return n
    except Exception:  # noqa: BLE001
        return None
    return None


async def _local_model_ctx(base_url: str, model_id: str = "") -> int | None:
    """Resolve the real context window from a local model server.

    Tries llama.cpp's /props n_ctx, then LM Studio's native /api/v1/model and
    /api/v1/models context_length. Returns None when neither advertises it.
    """
    root = _server_root(base_url)
    n = await _llamacpp_default_ctx(root)
    if n:
        return n
    return await _lmstudio_context(root, model_id)


async def _models_dev_catalog() -> dict:
    """Fetch (and cache) the models.dev catalog: ``{provider_id: {"models": {model_id: {"limit": {"context": N, ...}, ...}}}}``.

    Never raises — on failure this returns the last good cache (if any) or an
    empty dict, so a transient network blip just means "no context known" for
    this call rather than crashing model listing.
    """
    global _models_dev_cache
    now = time.monotonic()
    if _models_dev_cache and now - _models_dev_cache[0] < MODELS_DEV_CACHE_TTL:
        return _models_dev_cache[1]
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(MODELS_DEV_API)
            resp.raise_for_status()
            data = resp.json()
        if isinstance(data, dict):
            _models_dev_cache = (now, data)
            return data
    except Exception:  # noqa: BLE001, S110
        pass
    return (_models_dev_cache[1] if _models_dev_cache else {}) or {}


def _models_dev_id(provider: str, model_id: str, base_url: str = "") -> str:
    """Normalize a model id to the form models.dev catalogs use.

    Google's OpenAI-compatible /models returns ids prefixed with ``models/``
    (``models/gemini-2.5-flash``) while models.dev keys them bare; opencode-
    compatible gateways are cataloged under bare ids too, but the UI can hand
    us ``opencode/deepseek-v4-flash-free`` (the gateway's own /models returns
    the bare ``deepseek-v4-flash-free``). Stripping the ``models/`` prefix for
    google and the ``opencode/`` prefix for opencode lets one catalog lookup
    serve every provider.

    The provider-key prefix is stripped ONLY for opencode-compatible gateways:
    models.dev keys opencode entries bare, but keys other providers' entries
    WITH their own prefix (nvidia: ``nvidia/<model>``), so stripping there
    would break the lookup and lose the model's context/reasoning metadata.
    """
    mid = model_id or ""
    if _provider_meta(provider).get("strip_models_prefix") and mid.startswith("models/"):
        return mid[len("models/") :]
    if (
        _models_dev_provider_key(provider, base_url) == "opencode"
        and mid.startswith("opencode/")
    ):
        return mid[len("opencode/") :]
    return mid


# models.dev catalog keys for well-known gateways, detected by base URL so a
# custom provider pointed at a known gateway (e.g. api.openai.com) still gets
# the catalog's context/reasoning metadata instead of an empty "custom" key.
_GATEWAY_CATALOG_KEYS: tuple[tuple[str, str], ...] = (
    ("api.openai.com", "openai"),
    ("api.anthropic.com", "anthropic"),
    ("openrouter.ai", "openrouter"),
    ("generativelanguage.googleapis.com", "google"),
    ("integrate.api.nvidia.com", "nvidia"),
    ("api.deepseek.com", "deepseek"),
    ("api.mistral.ai", "mistral"),
    ("api.x.ai", "xai"),
    ("api.groq.com", "groq"),
    ("api.together.xyz", "together"),
    ("api.fireworks.ai", "fireworks"),
    ("api.cohere.com", "cohere"),
    ("opencode.ai", "opencode"),
)


def _models_dev_provider_key(provider: str, base_url: str = "") -> str:
    """models.dev catalog key for a provider.

    opencode-compatible gateways — the built-in ``opencode`` provider OR any
    custom provider pointed at ``opencode.ai`` (``is_opencode`` detects the
    base URL) — are all cataloged under the single ``opencode`` key in
    models.dev, so lookups must use that key rather than the provider name.
    Custom providers pointed at a well-known gateway (api.openai.com,
    api.anthropic.com, ...) resolve to that gateway's catalog key too, so
    their models get the same context/reasoning metadata as the built-in
    provider.
    """
    if is_opencode(provider, base_url):
        return "opencode"
    if provider == "custom" and base_url:
        for host, key in _GATEWAY_CATALOG_KEYS:
            if host in base_url:
                return key
    # Cloudflare's Workers AI models are cataloged under "cloudflare-workers-ai"
    # in models.dev (there is no "cloudflare" key).
    if provider == "cloudflare":
        return "cloudflare-workers-ai"
    return provider


def _models_dev_keys(provider: str, base_url: str, model_id: str) -> list[str]:
    """Catalog keys to try for a model, most specific first.

    The resolved gateway key (opencode, nvidia, cloudflare-workers-ai, ...) is
    tried first. Router gateways that proxy upstream providers' models
    (tokenrouter) additionally try the model id's own provider prefix
    (``openai/gpt-4o`` -> ``openai``), so their models resolve against the
    upstream provider's catalog entry instead of an empty "tokenrouter" key.
    """
    keys = [_models_dev_provider_key(provider, base_url)]
    if "/" in (model_id or ""):
        prefix = model_id.split("/", 1)[0]
        if prefix and prefix not in keys:
            keys.append(prefix)
    return keys


# Google's REST /v1beta/models list carries the AUTHORITATIVE per-model context
# (inputTokenLimit) and output (outputTokenLimit); the OpenAI-compatible
# endpoint exposes neither. Cached briefly — the payload is ~50 entries.
_google_model_cache: dict[str, tuple[float, dict[str, tuple[int | None, int | None]]]] = {}
GOOGLE_MODEL_CACHE_TTL = 300.0  # seconds


async def _google_model_limits(
    api_key: str = "", oauth_token: str = "",
) -> dict[str, tuple[int | None, int | None]]:
    """Fetch Google's per-model (input_token_limit, output_token_limit) map.

    Authenticates with whatever credential the caller resolved (API key or
    OAuth access token) via the ``key`` query param / ``x-goog-api-key``
    header, falling back to the env chain. Never raises — returns the last
    good cache or an empty dict so a blip means "no extra context" only.
    """
    key = oauth_token or api_key or env_key("google", "")
    if not key:
        return {}
    global _google_model_cache
    now = time.monotonic()
    if _google_model_cache and now - _google_model_cache[0] < GOOGLE_MODEL_CACHE_TTL:
        return _google_model_cache[1]
    headers = {"x-goog-api-key": key}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        out: dict[str, tuple[int | None, int | None]] = {}
        for m in data.get("models") or []:
            name = m.get("name") or ""
            if not name:
                continue
            ctx = m.get("inputTokenLimit")
            max_out = m.get("outputTokenLimit")
            out[name] = (
                int(ctx) if ctx else None,
                int(max_out) if max_out else None,
            )
        if out:
            _google_model_cache = (now, out)
            return out
    except Exception:  # noqa: BLE001, S110 — fall back to cache/empty
        pass
    return (_google_model_cache[1] if _google_model_cache else {}) or {}


def _normalize_catalog_id(model_id: str) -> str:
    """Normalize a router-gateway model id to the form models.dev catalogs use.

    TokenRouter renames upstream models with dots and speed suffixes
    (``anthropic/claude-opus-4.7-fast``) while models.dev keys them with dashes
    (``claude-opus-4-7``). Lowercase, dots → dashes, and strip common speed
    suffixes so the underlying catalog entry's context/reasoning still applies.
    Only ever consulted as a FALLBACK (after exact/stripped/alias lookups miss),
    so a model the catalog knows verbatim is never affected.
    """
    mid = (model_id or "").strip().lower()
    mid = mid.replace(".", "-")
    for suffix in ("-fast", "-turbo"):
        if mid.endswith(suffix):
            mid = mid[: -len(suffix)]
            break
    # TokenRouter also serves DATED and FREE variants of upstream models
    # ("deepseek-v4-pro-0813-free", "deepseek-v4-flash-0731") while models.dev
    # keys the BASE model ("deepseek-v4-pro"). Strip a trailing "-free" and a
    # trailing date stamp so the variant resolves to the base entry's
    # context/reasoning instead of falling through to unknown (0).
    while mid.endswith("-free"):
        mid = mid[: -len("-free")]
    mid = re.sub(r"-\d{4,8}$", "", mid)
    return mid


# Reverse index of models.dev catalog entries by bare model id (the id after
# the last '/'), cached per catalog fetch so router-gateway lookups of bare ids
# ("deepseek-v4-pro") resolve without scanning the whole catalog per model.
_models_dev_bare_cache: tuple[dict, dict[str, dict]] | None = None


def _models_dev_bare_index(catalog: dict) -> dict[str, dict]:
    """Map bare model ids ("deepseek-v4-pro") to their catalog entry.

    Keyed on the catalog dict's identity (a stored reference, not ``id()``) so
    a fresh ``_models_dev_catalog`` fetch rebuilds the index while the cached
    dict reuses it. First entry wins for a bare id that appears under several
    providers (all the same model).
    """
    global _models_dev_bare_cache
    if _models_dev_bare_cache and _models_dev_bare_cache[0] is catalog:
        return _models_dev_bare_cache[1]
    index: dict[str, dict] = {}
    for provider_data in (catalog or {}).values():
        for entry in ((provider_data or {}).get("models") or {}).values():
            if not isinstance(entry, dict):
                continue
            bare = (entry.get("id") or "").split("/")[-1]
            if bare and bare not in index:
                index[bare] = entry
    _models_dev_bare_cache = (catalog, index)
    return index


def _models_dev_entry(catalog: dict, provider_keys: list[str], model_id: str) -> dict:
    """Resolve a model's entry in a models.dev catalog.

    Tries each candidate provider key in order (see ``_models_dev_keys``): the
    exact ``model_id`` key first, then the id with any ``<provider>/`` prefix
    stripped (opencode gateways may present ids as
    ``opencode/deepseek-v4-flash-free`` while the catalog keys them bare), then
    scans entries whose ``aliases``/``alias`` array (or ``id`` field) matches —
    so a gateway alias resolves to its catalog entry even when the key differs.
    Finally, router gateways (tokenrouter) that rename upstream models with dots
    and speed suffixes are matched via ``_normalize_catalog_id`` so their
    context/reasoning still resolves against the upstream provider's entry.
    """
    for provider_key in provider_keys:
        models = ((catalog or {}).get(provider_key) or {}).get("models") or {}
        entry = models.get(model_id)
        if isinstance(entry, dict):
            return entry
        stripped = model_id.split("/", 1)[-1]
        if stripped != model_id:
            entry = models.get(stripped)
            if isinstance(entry, dict):
                return entry
        for candidate in models.values():
            if not isinstance(candidate, dict):
                continue
            if candidate.get("id") == stripped:
                return candidate
            for alias in candidate.get("aliases") or candidate.get("alias") or []:
                if alias == model_id or alias == stripped:
                    return candidate
        norm = _normalize_catalog_id(stripped)
        if norm and norm != stripped:
            entry = models.get(norm)
            if isinstance(entry, dict):
                return entry
            for candidate in models.values():
                if not isinstance(candidate, dict):
                    continue
                if candidate.get("id") == norm:
                    return candidate
                for alias in candidate.get("aliases") or candidate.get("alias") or []:
                    if alias == norm:
                        return candidate
    # Router gateways (tokenrouter) present some upstream models BARE
    # ("deepseek-v4-pro" — no provider prefix), so `_models_dev_keys` only
    # yields the gateway's own (uncataloged) key and every per-provider lookup
    # above misses. When NONE of the candidate keys exist in the catalog, fall
    # back to the reverse index of bare ids (exact, then normalized) so the
    # model's context/reasoning still resolves against the upstream provider's
    # catalog entry.
    if not any((catalog or {}).get(key) for key in provider_keys):
        # Router gateways (tokenrouter) present upstream models bare, so the
        # model id often carries its OWN provider prefix (e.g.
        # "nvidia/deepseek-v4-flash"). Resolve against THAT upstream provider's
        # section first — never a different provider's entry with the same bare
        # id (which would return the wrong context window).
        prefix = model_id.split("/", 1)[0] if "/" in model_id else None
        candidates = [model_id]
        if prefix:
            candidates.append(model_id.split("/", 1)[-1])
        if prefix:
            for cand in candidates:
                entry = (catalog.get(prefix) or {}).get("models", {}).get(cand)
                if isinstance(entry, dict):
                    return entry
                norm = _normalize_catalog_id(cand)
                if norm and norm != cand:
                    entry = (catalog.get(prefix) or {}).get("models", {}).get(norm)
                    if isinstance(entry, dict):
                        return entry
        # Last resort: the reverse index of bare ids (first provider wins).
        bare_index = _models_dev_bare_index(catalog)
        for candidate in candidates:
            entry = bare_index.get(candidate)
            if isinstance(entry, dict):
                return entry
        for candidate in candidates:
            norm = _normalize_catalog_id(candidate)
            if norm and norm != candidate:
                entry = bare_index.get(norm)
                if isinstance(entry, dict):
                    return entry
    return {}


def _models_dev_context(catalog: dict, provider_keys: list[str], model_id: str) -> int | None:
    """Look up ``model_id``'s context window under ``provider_keys`` in a
    models.dev catalog already fetched via ``_models_dev_catalog``."""
    entry = _models_dev_entry(catalog, provider_keys, model_id)
    ctx = (entry.get("limit") or {}).get("context")
    try:
        return int(ctx) if ctx else None
    except (TypeError, ValueError):
        return None


def _models_dev_max_output(catalog: dict, provider_keys: list[str], model_id: str) -> int | None:
    """Look up ``model_id``'s max output tokens under ``provider_keys`` in a
    models.dev catalog already fetched via ``_models_dev_catalog``."""
    entry = _models_dev_entry(catalog, provider_keys, model_id)
    out = (entry.get("limit") or {}).get("output")
    try:
        return int(out) if out else None
    except (TypeError, ValueError):
        return None


def _models_dev_reasoning(catalog: dict, provider_keys: list[str], model_id: str) -> bool | None:
    """Look up ``model_id``'s reasoning-support flag under ``provider_keys`` in a
    models.dev catalog already fetched via ``_models_dev_catalog`` (the catalog's
    top-level ``reasoning`` boolean — the ``limit``-nested variant on older
    snapshots is also accepted — is the authoritative, community-maintained
    source for which models expose a reasoning mode)."""
    entry = _models_dev_entry(catalog, provider_keys, model_id)
    reasoning = entry.get("reasoning")
    if not isinstance(reasoning, bool):
        reasoning = (entry.get("limit") or {}).get("reasoning")
    return reasoning if isinstance(reasoning, bool) else None


def _models_dev_pricing(catalog: dict, provider_keys: list[str], model_id: str) -> dict | None:
    """Look up ``model_id``'s USD-per-million-token pricing under ``provider_keys``
    in a models.dev catalog (native unit there — ``cost.input`` / ``cost.output``,
    already USD per million tokens, no conversion needed). Cache rates, when the
    catalog advertises them (``cost.cache_read_input`` / ``cost.cache_write_input``),
    are surfaced as ``cacheRead`` / ``cacheWrite`` for the meter."""
    entry = _models_dev_entry(catalog, provider_keys, model_id)
    cost = entry.get("cost") or {}
    inp, out = cost.get("input"), cost.get("output")
    if inp is None or out is None:
        return None
    try:
        entry_out = {"input": float(inp), "output": float(out)}
        cache_read = cost.get("cache_read_input")
        cache_write = cost.get("cache_write_input")
        if cache_read is not None:
            entry_out["cacheRead"] = float(cache_read)
        if cache_write is not None:
            entry_out["cacheWrite"] = float(cache_write)
        return entry_out
    except (TypeError, ValueError):
        return None


async def _ollama_info(
    client: httpx.AsyncClient, base: str, model_id: str
) -> tuple[int | None, int | None]:
    """Real context window and max output tokens for a local ollama model via
    /api/show.

    The tags list carries no context info; /api/show returns them under
    ``model_info["<family>.context_length"]`` and
    ``model_info["<family>.max_tokens"]`` (``parameters`` may carry a ``num_ctx``
    override). Errors are swallowed — both stay None.
    """
    ctx = out = None
    try:
        resp = await client.post(base + "/api/show", json={"model": model_id})
        resp.raise_for_status()
        data = resp.json()
        for key, val in (data.get("model_info") or {}).items():
            try:
                ival = int(val)
            except (TypeError, ValueError):
                continue
            if key.endswith(".context_length") and ctx is None:
                ctx = ival
            elif key.endswith(".max_tokens") and out is None:
                out = ival
        params = data.get("parameters") or ""
        if isinstance(params, str):
            for line in params.splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[0] == "num_ctx":
                    try:
                        ctx = int(parts[1])
                    except (TypeError, ValueError):
                        continue
        elif isinstance(params, dict) and params.get("num_ctx"):
            try:
                ctx = int(params["num_ctx"])
            except (TypeError, ValueError):
                pass
    except Exception:  # noqa: BLE001
        return ctx, out
    return ctx, out


async def fetch_credits(
    provider: str,
    base_url: str = "",
    api_key: str = "",
    env_var: str = "",
    oauth_token: str = "",
) -> dict:
    """Fetch the provider account's remaining credit balance.

    Only OpenRouter exposes a balance endpoint (``/api/v1/credits``). Other
    providers return an empty dict so the UI renders no balance line.
    """
    if provider != "openrouter":
        return {}
    url = f"{OPENROUTER_BASE}/credits"
    headers: dict[str, str] = {}
    key = oauth_token or api_key or env_key(provider, env_var)
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json().get("data", {})
            total = float(data.get("total_credits") or 0)
            usage = float(data.get("total_usage") or 0)
            return {
                "balance": round(total - usage, 6),
                "total_credits": total,
                "total_usage": usage,
            }
    except Exception as exc:
        raise ProviderError(f"credits lookup failed: {exc}") from exc


async def list_models(
    provider: str,
    base_url: str = "",
    api_key: str = "",
    env_var: str = "",
    oauth_token: str = "",
) -> list[dict]:
    """Fetch available models for a provider (cached for 120s).

    Returns a list of ``{"id": ..., "context": int | None}`` entries where
    ``context`` is the model's advertised context-window length in tokens.

    Context sources per provider kind:
    * openrouter -> ``context_length`` from the /models payload
    * opencode   -> the payload has no context; fetched live from the
                    models.dev catalog (plus the known 200K for `-free` models)
    * ollama     -> per-model ``/api/show`` (tags carry no context)
    * custom     -> ``max_model_len`` per model, else llama.cpp/LM Studio
                    ``/props`` ``n_ctx`` as a server-wide default
    """
    url, fmt = _models_endpoint(provider, base_url)
    cache_key = (provider, url)
    cached = _model_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < _MODEL_CACHE_TTL:
        return cached[1]

    headers = {}
    if oauth_token:
        headers["Authorization"] = f"Bearer {oauth_token}"
    elif api_key or env_key(provider, env_var):
        headers["Authorization"] = f"Bearer {api_key or env_key(provider, env_var)}"

    timeout = _provider_meta(provider).get("models_timeout") or 10.0
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()

            if fmt == "tags":
                models = [
                    {
                        "id": entry.get("name", "").rpartition(":")[0]
                        if entry.get("name", "").endswith(":latest")
                        else entry.get("name", ""),
                        "context": None,
                        "reasoning": None,
                    }
                    for entry in data.get("models", [])
                    if entry.get("name")
                ]
                base = url[: -len("/api/tags")]
                sem = asyncio.Semaphore(4)

                async def with_ctx(entry: dict) -> dict:
                    async with sem:
                        ctx, out = await _ollama_info(client, base, entry["id"])
                        return {**entry, "context": ctx, "max_output": out}

                models = await asyncio.gather(*(with_ctx(m) for m in models))
            else:
                if fmt == "cloudflare_search":
                    # Workers AI has no /models under /ai/v1; the catalog lives
                    # at .../ai/models/search which returns a `result[]` array.
                    rows = data.get("result") or []
                else:
                    rows = data.get("data") or []
                models = []
                for entry in rows:
                    mid = entry.get(_provider_meta(provider).get("models_id_field") or "id")
                    if not mid:
                        continue
                    models.append(
                        {
                            "id": mid,
                            "context": _entry_context(entry),
                            "max_output": _entry_max_output(entry),
                            "pricing": _entry_pricing(entry),
                            "reasoning": _entry_reasoning(entry),
                        }
                    )
                # Enrich model metadata from the live models.dev catalog
                # (community-maintained, provider- and model-specific).
                #
                # Context-window source precedence:
                #  * opencode (and opencode-compatible gateways) UNDER-advertise
                #    context in their /models payload (e.g. 4096 for
                #    deepseek-v4-flash-free while the real limit is 128K), so
                #    models.dev is authoritative there.
                #  * every other provider reports a real ``context_length`` via
                #    its /models payload, so TRUST that and only fall back to
                #    models.dev when it's missing/zero. This avoids a
                #    cross-provider bleed where models.dev's ``opencode/...``
                #    entry (which may carry a different limit) was overriding
                #    the provider's own correct number.
                catalog = await _models_dev_catalog()
                _is_oc = is_opencode(provider, base_url)
                for m in models:
                    dev_id = _models_dev_id(provider, m["id"], base_url)
                    dev_keys = _models_dev_keys(provider, base_url, dev_id)
                    dev_ctx = _models_dev_context(catalog, dev_keys, dev_id)
                    if _is_oc:
                        if dev_ctx:
                            m["context"] = dev_ctx
                        elif (
                            not m["context"]
                            and _provider_meta(provider).get("free_ctx_fallback")
                            and m["id"].endswith("-free")
                        ):
                            m["context"] = 200_000
                    else:
                        # Provider /models context_length is primary; models.dev
                        # only fills the gaps (and still supplies pricing /
                        # reasoning / max_output below).
                        if not m["context"] and dev_ctx:
                            m["context"] = dev_ctx
                    dev_out_val = _models_dev_max_output(catalog, dev_keys, dev_id)
                    if dev_out_val:
                        m["max_output"] = m["max_output"] or dev_out_val
                    if not m.get("pricing"):
                        m["pricing"] = _models_dev_pricing(catalog, dev_keys, dev_id)
                    if m.get("reasoning") is None:
                        m["reasoning"] = _models_dev_reasoning(catalog, dev_keys, dev_id)
                    # Cloud gateways flagged `auto_think` (OpenRouter, opencode,
                    # NVIDIA, Cloudflare, TokenRouter) support steering a reasoning
                    # effort regardless of the model id — the gateway negotiates it
                    # with the upstream model. When neither the /models payload nor
                    # the models.dev catalog says otherwise, treat them as
                    # reasoning-capable instead of falling back to a name heuristic
                    # (which would miss ids like "hy3-free" that carry no
                    # "reason/think" token). No model names are hardcoded here.
                    if m.get("reasoning") is None and _provider_meta(provider).get("auto_think"):
                        m["reasoning"] = True
                if _provider_meta(provider).get("model_class") == "google":
                    # Google's own REST catalog is the authoritative source for
                    # context (inputTokenLimit) / output (outputTokenLimit) —
                    # more complete than models.dev and never stale. Fill any
                    # gaps the OpenAI-compatible /models payload left behind.
                    limits = await _google_model_limits(api_key, oauth_token)
                    for m in models:
                        pair = limits.get(m["id"]) or (None, None)
                        if not m["context"] and pair[0]:
                            m["context"] = pair[0]
                        if not m["max_output"] and pair[1]:
                            m["max_output"] = pair[1]
                if _provider_meta(provider).get("editable_base_url") and any(not m["context"] for m in models):
                    for m in models:
                        if not m["context"]:
                            local_ctx = await _local_model_ctx(base_url, m["id"])
                            if local_ctx:
                                m["context"] = local_ctx
                # No hardcoded floor: the context window must come from the
                # provider's /models payload or the models.dev catalog — never a
                # baked-in constant. If both are silent the value stays null and
                # the UI shows a dash rather than a wrong number. A provider may
                # still advertise its OWN default via provider metadata
                # (provider-sourced, not a code constant).
                floor = _provider_meta(provider).get("context_window")
                if floor:
                    for m in models:
                        if not m["context"]:
                            m["context"] = floor
                models.sort(key=lambda m: m["id"])
    except Exception as exc:
        raise ProviderError(f"failed to fetch models from {url}: {exc}") from exc

    _model_cache[cache_key] = (time.monotonic(), models)
    return models


def _looks_local(provider: str, base_url: str) -> bool:
    """True when the base URL points at a locally-served model server.

    Includes "ollama" because the UI's "ollama" provider is the generic local
    endpoint (llama.cpp / LM Studio / vLLM), not Ollama specifically.
    """
    if provider in ("local", "custom", "ollama"):
        return True
    host = (base_url or "").split("://", 1)[-1].split("/", 1)[0].split(":")[0]
    return host in ("localhost", "127.0.0.1")


async def model_context(
    provider: str,
    model: str,
    base_url: str = "",
    api_key: str = "",
    env_var: str = "",
    oauth_token: str = "",
) -> int:
    """Resolve a specific model's context-window length (tokens).

    The live models.dev catalog is the PRIMARY source (community-maintained,
    provider- and model-specific). Falls back to the provider's advertised
    window (openrouter ``context_length``, opencode curated map, ollama
    /api/show, custom ``max_model_len``) only when the catalog doesn't know
    the model, then to a conservative floor ONLY when the model is truly
    unknown — never a hard-coded cap, and never under-reporting a model whose
    real window the provider advertises.

    Returns 0 when nothing can be determined.
    """
    if not model:
        return 0
    model = qualify_model_id(provider, model)
    # Known-capacity models resolve from the live models.dev catalog first —
    # even when list_models fails (offline / transient). Exact known models
    # only — never a hardcoded map.
    catalog = await _models_dev_catalog()
    dev_id = _models_dev_id(provider, model, base_url)
    ctx = _models_dev_context(catalog, _models_dev_keys(provider, base_url, dev_id), dev_id)
    if ctx:
        return ctx
    if _provider_meta(provider).get("free_ctx_fallback") and model.endswith("-free"):
        return 200_000
    try:
        enlisted = await list_models(
            provider, base_url, api_key, env_var, oauth_token=oauth_token
        )
        for entry in enlisted:
            if entry.get("id") == model and entry.get("context"):
                return int(entry["context"])
    except Exception:  # noqa: BLE001, S110 — provider lookup is best-effort
        pass
    # Local model servers (ollama / llama.cpp / LM Studio) expose their REAL
    # context window directly — resolve it from the server, not a hard-coded floor.
    if _looks_local(provider, base_url):
        local_ctx = await _local_model_ctx(base_url, model)
        if local_ctx:
            return local_ctx
    return 0


async def model_max_output(
    provider: str,
    model: str,
    base_url: str = "",
    api_key: str = "",
    env_var: str = "",
    oauth_token: str = "",
) -> int:
    """Resolve a specific model's max output tokens (best-effort).

    Mirrors model_context(): the live models.dev catalog is the PRIMARY source
    (``limit.output``); falls back to the provider's advertised output limit
    (openrouter ``max_completion_tokens``, ollama ``max_tokens``) only when the
    catalog doesn't know the model. Returns 0 when nothing can be determined.
    """
    if not model:
        return 0
    model = qualify_model_id(provider, model)
    catalog = await _models_dev_catalog()
    dev_id = _models_dev_id(provider, model, base_url)
    out = _models_dev_max_output(
        catalog, _models_dev_keys(provider, base_url, dev_id), dev_id
    )
    if out:
        return out
    # opencode-compatible gateways under-advertise output limits in their own
    # /models payload (deepseek-v4-flash-free reports 4096 while the real limit
    # is 128K per models.dev) — when the catalog doesn't know the model, report
    # UNKNOWN (0) rather than the gateway's own under-advertised value:
    # _settings_for then falls back to the context-scaled budget (capped at
    # 8192), which is far more useful than a wrong 4096.
    if is_opencode(provider, base_url):
        return 0
    try:
        enlisted = await list_models(
            provider, base_url, api_key, env_var, oauth_token=oauth_token
        )
        for entry in enlisted:
            if entry.get("id") == model and entry.get("max_output"):
                return int(entry["max_output"])
    except Exception:  # noqa: BLE001, S110 — provider lookup is best-effort
        pass
    return 0
