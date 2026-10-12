import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture()
def client(monkeypatch):
    """TestClient with mocked build_chat_model — no real provider."""
    monkeypatch.setattr(server, "build_chat_model", lambda *a, **k: object())
    return TestClient(server.app)


def test_models_test_ok(client, monkeypatch):
    async def fake_complete(mo, *, system="", user="", images=None):
        return "OK", None

    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post("/models/test", json={"provider": "custom", "model": "test-model"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "reply": "OK"}


def test_models_test_failure_returns_detail(client, monkeypatch):
    async def fake_complete(mo, *, system="", user="", images=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post("/models/test", json={"provider": "custom", "model": "test-model"})
    assert r.status_code == 400
    assert "boom" in r.json()["detail"]


def test_models_test_no_model(client):
    r = client.post("/models/test", json={"provider": "custom", "model": ""})
    assert r.status_code == 400


def test_models_test_timeout_budget_is_15s(client, monkeypatch):
    """Total model-test budget is 15s and client ceiling stays below it."""
    seen: list = []
    real_wait_for = server.asyncio.wait_for

    async def spy_wait_for(aw, timeout=None):
        seen.append(timeout)
        return await real_wait_for(aw, timeout=timeout)

    captured: dict = {}

    def fake_build(*args, **kwargs):
        captured.update(kwargs)
        return object()

    async def fake_complete(mo, *, system="", user="", images=None):
        return "OK", None

    monkeypatch.setattr(server, "build_chat_model", fake_build)
    monkeypatch.setattr(server, "llm_complete", fake_complete)
    monkeypatch.setattr(server.asyncio, "wait_for", spy_wait_for)
    r = client.post("/models/test", json={"provider": "custom", "model": "test-model"})
    assert r.status_code == 200
    assert 15 in seen  # outer wait_for budget must be 15 seconds
    assert captured["timeout"] == 12  # client ceiling must stay below total budget
    # Chat-representative cap so quota pre-check matches a real turn.
    assert captured["max_tokens"] == 32_000


def test_models_test_quota_failure_returns_400(client, monkeypatch):
    """Single test must fail (no green tick) on 402/insufficient balance."""

    async def fake_complete(mo, *, system="", user="", images=None):
        raise RuntimeError("Error code: 402 - {'error': {'message': 'Insufficient balance. Please top up your account or upgrade your plan.', 'type': 'insufficient_funds', 'code': 'insufficient_quota'}}")

    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post("/models/test", json={"provider": "custom", "model": "poor-model"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "402" in detail or "Insufficient" in detail


def test_models_test_batch_ok(client, monkeypatch):
    async def fake_complete(mo, *, system="", user="", images=None):
        return "OK", None

    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post(
        "/models/test-batch",
        json={"provider": "custom", "models": ["a", "b"]},
    )
    assert r.status_code == 200
    results = {x["model"]: x for x in r.json()["results"]}
    assert results["a"]["ok"] is True
    assert results["b"]["ok"] is True


def test_models_test_batch_partial_quota_failure(client, monkeypatch):
    """A 402 on one model must not tick another model."""

    async def fake_complete(mo, *, system="", user="", images=None):
        raise RuntimeError("Error code: 402 - {'error': {'message': 'Insufficient balance. Please top up.', 'code': 'insufficient_quota'}}")

    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post(
        "/models/test-batch",
        json={"provider": "custom", "models": ["poor-model"]},
    )
    assert r.status_code == 200
    item = r.json()["results"][0]
    assert item["ok"] is False
    assert "402" in item["error"] or "Insufficient" in item["error"]


def test_models_test_batch_empty_reply_fails(client, monkeypatch):
    async def fake_complete(mo, *, system="", user="", images=None):
        return "", None

    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post(
        "/models/test-batch",
        json={"provider": "custom", "models": ["empty-model"]},
    )
    assert r.status_code == 200
    assert r.json()["results"][0]["ok"] is False


def test_models_test_batch_no_models(client):
    r = client.post("/models/test-batch", json={"provider": "custom", "models": []})
    assert r.status_code == 400


def test_models_test_probe_stays_negligible(client, monkeypatch):
    """Probe must burn ~1 token: tiny prompt, thinking off, short reply."""
    captured: dict = {}
    seen_user: dict = {}

    def fake_build(*args, **kwargs):
        captured.update(kwargs)
        return object()

    async def fake_complete(mo, *, system="", user="", images=None):
        seen_user["user"] = user
        seen_user["system"] = system
        return "OK", None

    monkeypatch.setattr(server, "build_chat_model", fake_build)
    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = client.post("/models/test", json={"provider": "custom", "model": "m"})
    assert r.status_code == 200
    # Tiny input: single short sentence asking for one word.
    assert len((seen_user["user"] or "").split()) <= 10
    assert not (seen_user["system"] or "").strip()
    # No reasoning tokens burned.
    assert captured.get("thinking_level") == "off"
    # Reply truncated so a chatty model cannot burn output tokens downstream.
    assert len(r.json()["reply"]) <= 200
