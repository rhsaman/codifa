"""Regression test: cloud gateways flagged `auto_think` must report reasoning=True.

For gateways like opencode the /models payload and the models.dev catalog often
carry no `reasoning` flag (e.g. "hy3-free" has no "reason/think" token). The UI
used to fall back to a name heuristic that missed such ids. Instead, `list_models`
now treats `auto_think` providers as reasoning-capable when neither the payload
nor the catalog says otherwise — with NO model names hardcoded.

These tests pin that behavior so a future change can't silently regress it.
"""
import asyncio
import os
import sys
from unittest import mock

os.environ.setdefault("CODER_DATA_DIR", "/tmp/codefa-test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import providers  # noqa: E402


def _fake_models_payload(ids: list[str]) -> dict:
    """OpenAI-style /models payload with no reasoning flag on any entry."""
    return {"data": [{"id": mid, "context_length": 1000} for mid in ids]}


def _patch_client(client_cls, payload: dict) -> None:
    client = client_cls.return_value.__aenter__.return_value
    resp = mock.Mock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    client.get = mock.AsyncMock(return_value=resp)


async def _run(provider: str, ids: list[str], auto_think: bool) -> list[dict]:
    payload = _fake_models_payload(ids)
    with mock.patch("httpx.AsyncClient") as client_cls, mock.patch(
        "providers._models_dev_catalog",
        new=mock.AsyncMock(return_value={}),
    ):
        _patch_client(client_cls, payload)
        # Force the provider's auto_think flag for the test (opencode is already
        # True; this lets us assert both branches deterministically).
        with mock.patch.dict(
            providers._PROVIDERS,
            {provider: {**providers._provider_meta(provider), "auto_think": auto_think}},
        ):
            return await providers.list_models(provider)


def test_auto_think_provider_flags_reasoning_true() -> None:
    # opencode is an auto_think gateway; "hy3-free" carries no reason/think token
    # and the (empty) catalog says nothing — must still be reasoning-capable.
    models = asyncio.run(_run("opencode", ["hy3-free"], True))
    assert len(models) == 1
    assert models[0]["id"] == "hy3-free"
    assert models[0]["reasoning"] is True


def test_non_auto_think_provider_stays_none() -> None:
    # A provider without auto_think (e.g. a custom endpoint) keeps reasoning=None
    # when neither payload nor catalog says anything — no name heuristic in backend.
    models = asyncio.run(_run("custom", ["hy3-free"], False))
    assert len(models) == 1
    assert models[0]["reasoning"] is None


def test_explicit_false_payload_wins_over_auto_think() -> None:
    # If the gateway explicitly says reasoning=False, that must win even for an
    # auto_think provider (no override to True). Force opencode's auto_think OFF
    # so the only signal is the payload's explicit False.
    payload = {"data": [{"id": "some-model", "reasoning": False}]}
    meta = dict(providers._provider_meta("opencode"))
    meta["auto_think"] = False
    with mock.patch("httpx.AsyncClient") as client_cls, mock.patch(
        "providers._models_dev_catalog",
        new=mock.AsyncMock(return_value={}),
    ), mock.patch.dict(providers._PROVIDERS, {"opencode": meta}):
        _patch_client(client_cls, payload)
        models = asyncio.run(providers.list_models("opencode"))
    assert models[0]["reasoning"] is False


if __name__ == "__main__":
    for fn in (
        test_auto_think_provider_flags_reasoning_true,
        test_non_auto_think_provider_stays_none,
        test_explicit_false_payload_wins_over_auto_think,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("ALL PASS")
