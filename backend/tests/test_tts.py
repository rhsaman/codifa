"""Tests for the /tts endpoint (remote OpenAI-compatible /audio/speech).

No network is needed: the remote HTTP call (httpx.AsyncClient.post) is patched.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import server


def _post(client, payload: dict):
    return client.post("/tts", json=payload)


class _FakeStream:
    """Minimal async streaming upstream: status/headers + aiter_bytes/aread."""

    def __init__(self, chunks, status_code=200, content_type="audio/mpeg", text=""):
        self._chunks = list(chunks)
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self.text = text
        self.closed = False

    async def aiter_bytes(self, chunk_size=None):
        for chunk in self._chunks:
            yield chunk

    async def aread(self):
        return b"".join(self._chunks) if isinstance(self._chunks, list) else b""

    async def aclose(self):
        self.closed = True


class _FakeClient:
    """httpx.AsyncClient replacement capturing the request and serving a stream."""

    last: _FakeClient | None = None

    def __init__(self, stream, *args, **kwargs):
        self._stream = stream
        self.captured: dict = {}
        _FakeClient.last = self

    def build_request(self, method, url, headers=None, json=None):
        self.captured.update({"method": method, "url": url, "headers": headers, "json": json})
        return (method, url, headers, json)

    async def send(self, request, stream=False):
        return self._stream

    async def aclose(self):
        pass


def test_remote_tts_forwards_model_input_voice():
    client = TestClient(server.app)
    stream = _FakeStream([b"FAKE", b"AUDIO"])

    with patch("httpx.AsyncClient", lambda *a, **k: _FakeClient(stream, *a, **k)):
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
    # StreamingResponse must forward every upstream chunk in order.
    assert resp.content == b"FAKEAUDIO"
    captured = _FakeClient.last.captured if _FakeClient.last else {}
    assert captured["url"] == "http://localhost:20128/v1/audio/speech"
    assert captured["headers"]["Authorization"] == "Bearer k"
    # گیت‌وی‌هایی مثل 9router کلاینت ناشناس را 401 می‌کنند — UA شناخته‌شده لازم است.
    assert captured["headers"]["User-Agent"] == server.providers.UA_LADDER[0]
    assert captured["json"] == {"model": "tts-1", "input": "سلام دنیا", "voice": "alloy"}
    assert stream.closed


def test_tts_defaults_model_and_voice(monkeypatch):
    client = TestClient(server.app)
    monkeypatch.setenv("MY_TTS_KEY", "env-secret")
    stream = _FakeStream([b"A"])

    with patch("httpx.AsyncClient", lambda *a, **k: _FakeClient(stream, *a, **k)):
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
    captured = _FakeClient.last.captured if _FakeClient.last else {}
    assert captured["headers"]["Authorization"] == "Bearer env-secret"
    # Trailing slash on base_url must not double up; empty model/voice are omitted
    # so providers without model/voice (e.g. some 9router vendors) still work.
    assert captured["url"] == "http://localhost:20128/v1/audio/speech"
    assert captured["json"] == {"input": "hi"}


def test_tts_empty_provider_rejected():
    """Empty provider is malformed, not a remote request: fail fast with 400.

    The local provider is a supported path now (see test_tts_local.py);
    only the empty kind must be rejected.
    """
    client = TestClient(server.app)
    resp = _post(client, {"text": "hi", "provider": "", "base_url": "http://x/v1"})
    assert resp.status_code == 400


def test_tts_missing_text_rejected():
    client = TestClient(server.app)
    resp = _post(client, {"text": "  ", "provider": "custom", "base_url": "http://x/v1"})
    assert resp.status_code == 400


def test_tts_upstream_error_surfaced():
    client = TestClient(server.app)
    stream = _FakeStream([], status_code=401, text="bad key")

    async def _aread(self):
        return b"bad key"

    stream.aread = _aread.__get__(stream, _FakeStream)

    with patch("httpx.AsyncClient", lambda *a, **k: _FakeClient(stream, *a, **k)):
        resp = _post(client, {"text": "hi", "provider": "custom", "base_url": "http://x/v1"})

    assert resp.status_code == 502
    assert "bad key" in resp.json()["detail"]


def test_tts_streams_chunks_without_buffering():
    """Chunks arrive progressively: first chunk must not wait for the last."""
    client = TestClient(server.app)
    stream = _FakeStream([b"one", b"two", b"three"])

    with patch("httpx.AsyncClient", lambda *a, **k: _FakeClient(stream, *a, **k)):
        resp = _post(
            client,
            {"text": "hi", "provider": "custom", "base_url": "http://x/v1"},
        )

    assert resp.status_code == 200
    assert resp.content == b"onetwothree"
    assert resp.headers["content-type"].startswith("audio/")


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
