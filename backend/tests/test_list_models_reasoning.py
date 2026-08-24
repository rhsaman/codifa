"""Unit test: list_models reasoning resolution for auto_think providers.

Cloud gateways flagged `auto_think` (opencode, openrouter, nvidia, cloudflare,
tokenrouter) support steering a reasoning effort regardless of the model id.
When neither the /models payload nor the models.dev catalog says otherwise,
list_models must treat them as reasoning-capable (True) instead of falling back
to a name heuristic. No model names are hardcoded.
"""

import asyncio
from unittest import mock

import pytest

from providers import list_models, _model_cache


def _make_client(payload: dict):
    """Build a mock httpx.AsyncClient whose .get() returns `payload` as JSON."""
    resp = mock.Mock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    client = mock.AsyncMock()
    client.get.return_value = resp
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


def _empty_catalog():
    return {}


async def test_auto_think_provider_unknown_model_is_reasoning():
    """opencode model with no reasoning signal → True (auto_think)."""
    _model_cache.clear()
    client = _make_client({"data": [{"id": "hy3-free"}]})
    with mock.patch("providers.httpx.AsyncClient", return_value=client), \
         mock.patch("providers._models_dev_catalog", return_value=_empty_catalog()):
        models = await list_models("opencode", "http://x/v1", "key")
    assert models[0]["id"] == "hy3-free"
    assert models[0]["reasoning"] is True


async def test_auto_think_provider_explicit_false_is_respected():
    """opencode model with explicit reasoning=False → False (payload wins)."""
    _model_cache.clear()
    client = _make_client({"data": [{"id": "some-model", "reasoning": False}]})
    with mock.patch("providers.httpx.AsyncClient", return_value=client), \
         mock.patch("providers._models_dev_catalog", return_value=_empty_catalog()):
        models = await list_models("opencode", "http://x/v1", "key")
    assert models[0]["reasoning"] is False


async def test_non_auto_think_provider_unknown_model_is_none():
    """A provider without auto_think and no signal → None (no heuristic guess)."""
    _model_cache.clear()
    client = _make_client({"data": [{"id": "weird-model"}]})
    with mock.patch("providers.httpx.AsyncClient", return_value=client), \
         mock.patch("providers._models_dev_catalog", return_value=_empty_catalog()):
        models = await list_models("openai", "http://x/v1", "key")
    assert models[0]["reasoning"] is None


async def test_auto_think_provider_explicit_true_is_respected():
    """opencode model with explicit reasoning=True → True."""
    _model_cache.clear()
    client = _make_client({"data": [{"id": "weird-model", "reasoning": True}]})
    with mock.patch("providers.httpx.AsyncClient", return_value=client), \
         mock.patch("providers._models_dev_catalog", return_value=_empty_catalog()):
        models = await list_models("opencode", "http://x/v1", "key")
    assert models[0]["reasoning"] is True


if __name__ == "__main__":
    asyncio.run(test_auto_think_provider_unknown_model_is_reasoning())
    asyncio.run(test_auto_think_provider_explicit_false_is_respected())
    asyncio.run(test_non_auto_think_provider_unknown_model_is_none())
    asyncio.run(test_auto_think_provider_explicit_true_is_respected())
    print("✅ همه تست‌های list_models reasoning پاس شدند")
