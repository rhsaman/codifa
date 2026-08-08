"""Provider abstraction: map UI provider configs to Pydantic AI models.

All three supported provider types expose an OpenAI-compatible HTTP API, so
every one collapses to pydantic_ai's ``OpenAIModel`` with a custom base URL and
API key.

Model lists are fetched live from the provider and cached for a short TTL.
"""

from __future__ import annotations

import asyncio
import os
import time

import httpx
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENCODE_BASE = "https://opencode.ai/zen/v1"
OLLAMA_BASE = "http://localhost:11434"

# opencode's /models endpoint does NOT advertise a context window, so the app
# can't derive a model's real capacity from it. This curated map (sourced from
# opencode's model catalog / models.dev) supplies context-window sizes for the
# models that gateway exposes. It is ONLY consulted for provider == "opencode"
# — never for openrouter/ollama/custom, which report real context via their own
# APIs. Not a generic fallback: unknown models simply stay "no context".
OPENCODE_CONTEXT: dict[str, int] = {
    "deepseek-v4-flash-free": 200_000,
    "deepseek-v4-flash": 1_000_000,
    "big-pickle": 200_000,
    "glm-5": 204_800,
}

_MODEL_CACHE_TTL = 120  # seconds
_model_cache: dict[tuple, tuple[float, list[str]]] = {}


class ProviderError(RuntimeError):
    pass


def env_key(provider: str = "", env_var: str = "") -> str:
    """API key from the global environment for a provider (env takes precedence).

    When an explicit ``env_var`` name is given (per-provider setting), it is
    read directly from the environment. Otherwise we fall back to the built-in
    name for each gateway: opencode exposes its key under OPENCODE_API_KEY and
    OPENCODE_ZEN_API_KEY; openrouter under OPENROUTER_API_KEY.
    """
    if env_var and env_var.strip():
        return os.environ.get(env_var.strip()) or ""
    if provider == "opencode":
        return os.environ.get("OPENCODE_API_KEY") or os.environ.get("OPENCODE_ZEN_API_KEY") or ""
    if provider == "openrouter":
        return os.environ.get("OPENROUTER_API_KEY") or ""
    return (
        os.environ.get("OPENCODE_API_KEY")
        or os.environ.get("OPENCODE_ZEN_API_KEY")
        or os.environ.get("OPENROUTER_API_KEY")
        or ""
    )


def env_base_url() -> str:
    return os.environ.get("OPENCODE_BASE_URL") or ""


def normalize_base_url(provider: str, base_url: str) -> str:
    """Return the OpenAI-compatible base URL for a provider.

    ``provider`` is the routing *kind* (opencode | openrouter | ollama |
    custom). Built-in gateways always use their own endpoint and ignore any
    stored ``base_url``; only ``custom`` providers use the user-supplied URL.
    """
    base = (base_url or "").strip().rstrip("/")
    if provider == "openrouter":
        # OpenRouter always talks to its own gateway.
        return OPENROUTER_BASE
    if provider == "opencode":
        # opencode is its OWN gateway — never route through OpenRouter.
        # Configurable via env OPENCODE_BASE_URL, defaulting to opencode.ai.
        return env_base_url() or OPENCODE_BASE
    if provider == "ollama":
        # Ollama exposes an OpenAI-compatible /v1 endpoint.
        if base and ("/v1" in base):
            return base
        return (base or OLLAMA_BASE) + "/v1"
    # custom: use the user-supplied base URL.
    return base


def build_model(
    provider: str, model: str, base_url: str, api_key: str, env_var: str = ""
) -> OpenAIChatModel:
    """Build a pydantic-ai model for the given provider configuration."""
    if not model:
        raise ProviderError("no model selected")
    base = normalize_base_url(provider, base_url)
    # Global env key wins over the per-app key stored in settings.
    key = env_key(provider, env_var) or api_key or ""

    provider_obj = OpenAIProvider(base_url=base, api_key=key or None)
    return OpenAIChatModel(model, provider=provider_obj)


def _models_endpoint(provider: str, base_url: str) -> tuple[str, str]:
    """Return (url, format) for the provider's model-list endpoint."""
    if provider == "ollama":
        base = (base_url or OLLAMA_BASE).rstrip("/")
        return base + "/api/tags", "tags"
    base = normalize_base_url(provider, base_url)
    return base + "/models", "models"


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


async def _ollama_context(
    client: httpx.AsyncClient, base: str, model_id: str
) -> int | None:
    """Real context window for a local ollama model via /api/show.

    The tags list carries no context info; /api/show returns it under
    ``model_info["<family>.context_length"]`` (and ``parameters`` may carry a
    ``num_ctx`` override). Errors are swallowed — context stays None.
    """
    try:
        resp = await client.post(base + "/api/show", json={"model": model_id})
        resp.raise_for_status()
        data = resp.json()
        for key, val in (data.get("model_info") or {}).items():
            if key.endswith(".context_length"):
                try:
                    return int(val)
                except (TypeError, ValueError):
                    continue
        params = data.get("parameters") or ""
        if isinstance(params, str):
            for line in params.splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[0] == "num_ctx":
                    try:
                        return int(parts[1])
                    except (TypeError, ValueError):
                        continue
        elif isinstance(params, dict) and params.get("num_ctx"):
            try:
                return int(params["num_ctx"])
            except (TypeError, ValueError):
                return None
    except Exception:  # noqa: BLE001
        return None
    return None


async def list_models(
    provider: str, base_url: str = "", api_key: str = "", env_var: str = ""
) -> list[dict]:
    """Fetch available models for a provider (cached for 120s).

    Returns a list of ``{"id": ..., "context": int | None}`` entries where
    ``context`` is the model's advertised context-window length in tokens.

    Context sources per provider kind:
    * openrouter -> ``context_length`` from the /models payload
    * opencode   -> the payload has no context; use the curated OPENCODE_CONTEXT
                    map (plus the known 200K for `-free` models)
    * ollama     -> per-model ``/api/show`` (tags carry no context)
    * custom     -> ``max_model_len`` per model, else llama.cpp/LM Studio
                    ``/props`` ``n_ctx`` as a server-wide default
    """
    if provider == "opencode" and not base_url:
        base_url = env_base_url()
    url, fmt = _models_endpoint(provider, base_url)
    cache_key = (provider, url)
    cached = _model_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < _MODEL_CACHE_TTL:
        return cached[1]

    headers = {}
    if env_key(provider, env_var) or api_key:
        headers["Authorization"] = f"Bearer {env_key(provider, env_var) or api_key}"

    timeout = 60.0 if provider == "openrouter" else 10.0
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
                    }
                    for entry in data.get("models", [])
                    if entry.get("name")
                ]
                base = url[: -len("/api/tags")]
                sem = asyncio.Semaphore(4)

                async def with_ctx(entry: dict) -> dict:
                    async with sem:
                        return {
                            **entry,
                            "context": await _ollama_context(client, base, entry["id"]),
                        }

                models = await asyncio.gather(*(with_ctx(m) for m in models))
            else:
                models = []
                for entry in data.get("data", []):
                    mid = entry.get("id")
                    if not mid:
                        continue
                    models.append({"id": mid, "context": _entry_context(entry)})
                if provider == "opencode":
                    for m in models:
                        if m["context"]:
                            continue
                        m["context"] = OPENCODE_CONTEXT.get(m["id"])
                        if not m["context"] and m["id"].endswith("-free"):
                            m["context"] = 200_000
                elif provider == "custom" and any(not m["context"] for m in models):
                    default_ctx = await _llamacpp_default_ctx(base_url)
                    for m in models:
                        if default_ctx and not m["context"]:
                            m["context"] = default_ctx
                models.sort(key=lambda m: m["id"])
    except Exception as exc:
        raise ProviderError(f"failed to fetch models from {url}: {exc}") from exc

    _model_cache[cache_key] = (time.monotonic(), models)
    return models


async def model_context(
    provider: str, model: str, base_url: str = "", api_key: str = "", env_var: str = ""
) -> int:
    """Resolve a specific model's context-window length (tokens).

    Tries the provider's advertised window first (openrouter ``context_length``,
    opencode curated map, ollama /api/show, custom ``max_model_len``). Falls
    back to a conservative floor ONLY when the model is truly unknown — never a
    hard-coded cap, and never under-reporting a model whose real window the
    provider advertises.

    Returns 0 when nothing can be determined.
    """
    if not model:
        return 0
    try:
        enlisted = await list_models(provider, base_url, api_key, env_var)
        for entry in enlisted:
            if entry.get("id") == model and entry.get("context"):
                return int(entry["context"])
    except Exception:  # noqa: BLE001, S110 — fall back to the curated map below
        pass
    # opencode exposes known-capacity models even when list_models fails
    # (offline / transient). Consult the curated map for exact known models.
    if provider == "opencode" and not base_url:
        if model in OPENCODE_CONTEXT:
            return OPENCODE_CONTEXT[model]
        if model.endswith("-free"):
            return 200_000
    return 0
