"""Tests for the /tts endpoint (remote OpenAI-compatible /audio/speech).

No network is needed: the remote HTTP call (httpx.AsyncClient.post) is patched.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import server


def _post(client, payload: dict):
    return client.post("/tts", json=payload)


def test_remote_tts_forwards_model_input_voice():
    client = TestClient(server.app)
    captured: dict = {}

    async def fake_post(self, url, headers=None, json=None):
        captured.update({"url": url, "headers": headers, "json": json})
        resp = SimpleNamespace(status_code=200, content=b"FAKEAUDIO", headers={"content-type": "audio/mpeg"})
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = _post(
            client,
            {
                "text": "سلام دنیا",
                "provider": "custom",
                "base_url": "http://localhost:20128/v1",
                "api_key": "k",
                "model": "tts-1",
                "voice": "alloy",
            },
        )

    assert resp.status_code == 200
    assert resp.content == b"FAKEAUDIO"
    assert captured["url"] == "http://localhost:20128/v1/audio/speech"
    assert captured["headers"]["Authorization"] == "Bearer k"
    # گیت‌وی‌هایی مثل 9router کلاینت ناشناس را 401 می‌کنند — UA شناخته‌شده لازم است.
    assert captured["headers"]["User-Agent"] == server.providers.UA_LADDER[0]
    assert captured["json"] == {"model": "tts-1", "input": "سلام دنیا", "voice": "alloy"}


def test_tts_defaults_model_and_voice(monkeypatch):
    client = TestClient(server.app)
    captured: dict = {}
    monkeypatch.setenv("MY_TTS_KEY", "env-secret")

    async def fake_post(self, url, headers=None, json=None):
        captured.update({"url": url, "headers": headers, "json": json})
        resp = SimpleNamespace(status_code=200, content=b"A", headers={"content-type": "audio/mpeg"})
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = _post(
            client,
            {
                "text": "hi",
                "provider": "custom",
                "base_url": "http://localhost:20128/v1/",
                "env_var": "MY_TTS_KEY",
            },
        )

    assert resp.status_code == 200
    assert captured["headers"]["Authorization"] == "Bearer env-secret"
    # Trailing slash on base_url must not double up; empty model/voice are omitted
    # so providers without model/voice (e.g. some 9router vendors) still work.
    assert captured["url"] == "http://localhost:20128/v1/audio/speech"
    assert captured["json"] == {"input": "hi"}


def test_tts_local_rejected():
    client = TestClient(server.app)
    for provider in ("", "local"):
        resp = _post(client, {"text": "hi", "provider": provider, "base_url": "http://x/v1"})
        assert resp.status_code == 400


def test_tts_missing_text_rejected():
    client = TestClient(server.app)
    resp = _post(client, {"text": "  ", "provider": "custom", "base_url": "http://x/v1"})
    assert resp.status_code == 400


def test_tts_upstream_error_surfaced():
    client = TestClient(server.app)

    async def fake_post(self, url, headers=None, json=None):
        resp = SimpleNamespace(status_code=401, text="bad key")
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = _post(client, {"text": "hi", "provider": "custom", "base_url": "http://x/v1"})

    assert resp.status_code == 502
    assert "bad key" in resp.json()["detail"]


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
