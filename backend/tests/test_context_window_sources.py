"""Context-window resolution must come from model.dev OR the provider — never a
hardcoded floor, and never a cross-provider models.dev bleed.

Regression: `nvidia/deepseek-v4-flash` previously showed 1M because models.dev's
`opencode/deepseek-v4-flash` entry (1_000_000) overrode the provider's real
`context_length`. For non-opencode providers the provider's /models payload is
now authoritative and models.dev is only a fallback.
"""

import pytest

from providers import list_models


class _FakeResp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._p


class _FakeClient:
    """AsyncClient stand-in that returns canned /models + models.dev payloads."""

    def __init__(self, routes: dict[str, dict]):
        self._routes = routes

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, headers=None):
        for key, payload in self._routes.items():
            if key in url:
                return _FakeResp(payload)
        raise AssertionError(f"unexpected URL {url}")


FAKE_MODELS = {
    "data": [
        {
            "id": "deepseek-v4-flash",
            "context_length": 131072,  # the provider's REAL limit
            "pricing": {"prompt": "0.1", "completion": "0.2"},
        }
    ]
}

FAKE_MODELS_DEV = {
    "opencode": {
        "models": {
            "deepseek-v4-flash": {
                "id": "deepseek-v4-flash",
                "limit": {"context": 1_000_000},  # wrong for nvidia hosting
            }
        }
    }
}


@pytest.fixture
def patch_httpx(monkeypatch):
    import providers as P

    def _factory(routes):
        def _make(*a, **k):
            return _FakeClient(routes)

        return _make

    monkeypatch.setattr(P.httpx, "AsyncClient", _factory(FAKE_MODELS_DEV_SPLIT))
    monkeypatch.setattr(P, "_model_cache", {})
    monkeypatch.setattr(P, "_models_dev_cache", None)
    yield


# Separate /models + models.dev payloads keyed by URL substring. NOTE: the
# models.dev URL (https://models.dev/api.json) also contains the substring
# "/models" (from "//models"), so "models.dev" MUST be checked first.
FAKE_MODELS_DEV_SPLIT = {
    "models.dev": FAKE_MODELS_DEV,
    "/models": FAKE_MODELS,
}


@pytest.mark.asyncio
async def test_provider_context_wins_over_models_dev_bleed(patch_httpx):
    # Non-opencode provider (nvidia) — its /models context_length (131072) must
    # win, NOT models.dev's opencode entry (1_000_000).
    models = await list_models(
        "nvidia", base_url="https://integrate.api.nvidia.com/v1", api_key="x"
    )
    assert len(models) == 1
    assert models[0]["id"] == "deepseek-v4-flash"
    assert models[0]["context"] == 131072, (
        f"expected provider context_length 131072, got {models[0]['context']}"
    )
    assert models[0]["context"] != 1_000_000


@pytest.mark.asyncio
async def test_opencode_still_uses_models_dev(patch_httpx):
    import providers as P

    oc_models = {
        "data": [
            {
                "id": "deepseek-v4-flash-free",
                "context_length": 4096,  # opencode under-advertises
                "pricing": {"prompt": "0", "completion": "0"},
            }
        ]
    }
    oc_dev = {
        "opencode": {
            "models": {
                "deepseek-v4-flash-free": {
                    "id": "deepseek-v4-flash-free",
                    "limit": {"context": 128_000},
                }
            }
        }
    }
    P.httpx.AsyncClient = lambda *a, **k: _FakeClient(
        {"models.dev": oc_dev, "/models": oc_models}
    )
    P._model_cache = {}
    P._models_dev_cache = None
    # A generic provider whose base URL points at opencode's gateway: is_opencode
    # is True, so models.dev stays authoritative (the /models payload lies).
    models = await list_models(
        "custom", base_url="https://opencode.ai/v1", api_key="x"
    )
    assert models[0]["context"] == 128_000, (
        f"opencode should use models.dev 128K, got {models[0]['context']}"
    )
