"""Unit tests: Google model listing authenticates with an API key ONLY.

OAuth was removed from the model path (Gemini = API key, like every other
provider; OAuth exists solely for the Search Console tool). These tests pin
that contract: list_models("google", ...) sends the API key as a Bearer token
on the OpenAI-compat /models endpoint and never an OAuth access token.

Run: cd backend && uv run python -m pytest tests/test_list_models_google_oauth.py -q
"""
import asyncio
from unittest import mock

import providers
from providers import _model_cache, list_models


def _make_client(payload: dict, status_code: int = 200):
    """Fake httpx.AsyncClient serving per-URL payloads.

    ``list_models`` also consults the models.dev catalog and Google's native
    ``/v1beta/models`` (context limits) through the same client — those get
    inert payloads so only the OpenAI-compat /models call carries the payload.
    """

    class _Resp:
        def __init__(self, body):
            self.status_code = status_code
            self._body = body

        def raise_for_status(self):
            if status_code >= 400:
                raise RuntimeError(f"HTTP {status_code}")

        def json(self):
            return self._body

    class _Client:
        def __init__(self, *a, **kw):
            self.calls: list[tuple[str, dict | None]] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            self.calls.append((url, headers))
            if "models.dev" in url:
                return _Resp({})
            if url.endswith("/v1beta/models"):
                return _Resp({"models": []})
            return _Resp(payload)

    return _Client()


def _models_call_headers(client) -> dict:
    """Headers of the (single) OpenAI-compat /models request."""
    hits = [h for url, h in client.calls if url.endswith("/v1beta/openai/models")]
    assert hits, "the OpenAI-compat /models endpoint was never hit"
    return hits[0] or {}


def test_google_models_use_api_key_bearer():
    """The /models request authenticates with the API key, not an OAuth token."""
    _model_cache.clear()
    providers._models_dev_cache = None
    client = _make_client({"data": [{"id": "gemini-2.5-flash"}]})
    with mock.patch("providers.httpx.AsyncClient", return_value=client):
        models = asyncio.run(list_models("google", "", "AIza-fake-api-key", ""))
    assert [m["id"] for m in models] == ["gemini-2.5-flash"]
    # API-key auth: Bearer <api_key> on the OpenAI-compat endpoint.
    assert _models_call_headers(client).get("Authorization") == "Bearer AIza-fake-api-key"


def test_google_models_env_var_fallback():
    """With no explicit key, the env chain (GOOGLE_API_KEY) authenticates."""
    _model_cache.clear()
    providers._models_dev_cache = None
    client = _make_client({"data": [{"id": "gemini-2.5-pro"}]})
    with (
        mock.patch("providers.httpx.AsyncClient", return_value=client),
        mock.patch.dict("os.environ", {"GOOGLE_API_KEY": "env-key"}, clear=False),
    ):
        models = asyncio.run(list_models("google", "", "", ""))
    assert [m["id"] for m in models] == ["gemini-2.5-pro"]
    assert _models_call_headers(client).get("Authorization") == "Bearer env-key"
