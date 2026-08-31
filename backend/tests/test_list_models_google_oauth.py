"""Unit test: list_models for Google with OAuth access tokens.

Google's OpenAI-compat endpoint at ``/v1beta/openai/models`` only accepts API
keys; passing an OAuth access token there returns 400. ``list_models`` must
detect the OAuth path for the ``google`` provider and route to the native
``/v1beta/models`` endpoint with ``Authorization: Bearer <token>`` instead,
parsing the ``{models: [{name, inputTokenLimit, outputTokenLimit}]}`` shape
and stripping the leading ``models/`` from each id.
"""

import asyncio
from unittest import mock

from providers import _list_google_models_native, _model_cache


def _make_client(payload: dict, status_code: int = 200):
    resp = mock.Mock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    if status_code >= 400:
        resp.raise_for_status.side_effect = RuntimeError(f"HTTP {status_code}")
    client = mock.AsyncMock()
    client.get.return_value = resp
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


async def test_google_oauth_strips_models_prefix():
    """Native ids like 'models/gemini-1.5-pro' come back bare ('gemini-1.5-pro')
    so the picker shows the same id as the OpenAI-compat path would."""
    _model_cache.clear()
    payload = {
        "models": [
            {
                "name": "models/gemini-1.5-pro",
                "inputTokenLimit": 1000000,
                "outputTokenLimit": 8192,
            },
            {
                "name": "models/gemini-2.0-flash",
                "inputTokenLimit": 1048576,
            },
        ]
    }
    client = _make_client(payload)
    with mock.patch("providers.httpx.AsyncClient", return_value=client):
        models = await _list_google_models_native("fake-oauth-token")
    assert [m["id"] for m in models] == ["gemini-1.5-pro", "gemini-2.0-flash"]
    assert models[0]["context"] == 1000000
    assert models[0]["max_output"] == 8192
    # No outputTokenLimit advertised → None (not 0 / not raised).
    assert models[1]["max_output"] is None


async def test_google_oauth_uses_bearer_header():
    """Verify the native endpoint is called with ``Authorization: Bearer <token>``
    (NOT ``x-goog-api-key``, which is API-key-only)."""
    _model_cache.clear()
    client = _make_client({"models": []})
    with mock.patch("providers.httpx.AsyncClient", return_value=client) as factory:
        await _list_google_models_native("ya29.fake-access-token")
    # factory() → client; client.get(url, headers=…) captured the kwargs.
    factory.assert_called_once()
    call = factory.return_value.get.call_args
    url = call.args[0]
    headers = call.kwargs.get("headers") or {}
    assert url == "https://generativelanguage.googleapis.com/v1beta/models"
    assert headers.get("Authorization") == "Bearer ya29.fake-access-token"
    assert "x-goog-api-key" not in headers


async def test_google_oauth_error_is_wrapped_as_provider_error():
    """A 4xx from the native endpoint must surface as ``ProviderError`` so the
    FastAPI route handler in server.py can convert it to a 400 response
    (same as the rest of the providers)."""
    from providers import ProviderError

    _model_cache.clear()
    client = _make_client({}, status_code=401)
    with mock.patch("providers.httpx.AsyncClient", return_value=client):
        try:
            await _list_google_models_native("expired-token")
        except ProviderError as exc:
            assert "google oauth /models failed" in str(exc)
        else:
            raise AssertionError("expected ProviderError to be raised")


if __name__ == "__main__":
    asyncio.run(test_google_oauth_strips_models_prefix())
    asyncio.run(test_google_oauth_uses_bearer_header())
    asyncio.run(test_google_oauth_error_is_wrapped_as_provider_error())
    print("\u2705 google oauth /models tests passed")
