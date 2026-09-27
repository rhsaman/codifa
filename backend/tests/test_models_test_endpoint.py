import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture()
def client(monkeypatch):
    """TestClient با build_chat_model ماک‌شده — بدون پروایدر واقعی."""
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
    """بودجه کل تست مدل ۱۵ ثانیه است و سقف کلاینت از آن کوچک‌تر می‌ماند."""
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
    assert 15 in seen  # سقف بیرونی wait_for باید ۱۵ ثانیه باشد
    assert captured["timeout"] == 12  # سقف کلاینت باید از بودجه کل کوچک‌تر باشد
