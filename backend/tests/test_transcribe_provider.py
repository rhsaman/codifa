"""Tests for the /transcribe endpoint's remote-provider branch.

No model download or network is needed: the local Whisper model is mocked and
the remote HTTP call (httpx.AsyncClient.post) is patched.
"""

from __future__ import annotations

import io
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import server


def _silent_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)
    return buf.getvalue()


def _post(client, data: dict):
    return client.post(
        "/transcribe",
        files={"audio": ("clip.wav", _silent_wav(), "audio/wav")},
        data=data,
    )


def test_remote_provider_calls_audio_transcriptions():
    client = TestClient(server.app)
    captured: dict = {}

    async def fake_post(self, url, headers=None, files=None, data=None):
        captured.update({"url": url, "headers": headers, "files": files, "data": data})
        resp = SimpleNamespace(status_code=200, text='{"text":"hello"}')
        resp.json = lambda: {"text": "hello"}
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = _post(
            client,
            {
                "provider": "custom",
                "base_url": "http://localhost:20128/v1",
                "api_key": "k",
                "model": "whisper-1",
                "lang": "fa",
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {"text": "hello"}
    assert captured["url"] == "http://localhost:20128/v1/audio/transcriptions"
    assert captured["headers"] == {"Authorization": "Bearer k"}
    assert captured["data"]["model"] == "whisper-1"
    assert captured["data"]["language"] == "fa"


def test_remote_env_var_key_fallback(monkeypatch):
    client = TestClient(server.app)
    captured: dict = {}
    monkeypatch.setenv("MY_STT_KEY", "env-secret")

    async def fake_post(self, url, headers=None, files=None, data=None):
        captured.update({"url": url, "headers": headers, "data": data})
        resp = SimpleNamespace(status_code=200, text='{"text":"hi"}')
        resp.json = lambda: {"text": "hi"}
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = _post(
            client,
            {
                "provider": "custom",
                "base_url": "http://localhost:20128/v1/",
                "env_var": "MY_STT_KEY",
                "model": "whisper-1",
            },
        )

    assert resp.status_code == 200
    assert captured["headers"] == {"Authorization": "Bearer env-secret"}
    # Trailing slash on base_url must not double up.
    assert captured["url"] == "http://localhost:20128/v1/audio/transcriptions"


def test_no_provider_field_uses_local():
    captured: dict = {}
    fake_segment = SimpleNamespace(text="سلام دنیا")

    def fake_transcribe(*_args, **kwargs):
        captured.update(kwargs)
        return (iter([fake_segment]), SimpleNamespace(language="fa"))

    fake_model = SimpleNamespace(transcribe=fake_transcribe)
    with patch.object(server, "_get_whisper_model", AsyncMock(return_value=fake_model)):
        client = TestClient(server.app)
        resp = _post(client, {"lang": "fa"})

    assert resp.status_code == 200
    assert resp.json()["text"] == "سلام دنیا"
    assert captured.get("beam_size") == 10


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
