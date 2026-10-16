"""Tests for the /transcribe endpoint's remote-provider branch.

No model download or network is needed: the local Whisper model is mocked and
the remote HTTP call (httpx.AsyncClient.post) is patched.
"""

from __future__ import annotations

import io
import time
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


def _tone_wav() -> bytes:
    """A loud 1s 440Hz tone: passes the PCM energy gate in tests."""
    import math
    import struct

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        frames = b"".join(
            struct.pack("<h", int(16000 * math.sin(2 * math.pi * 440 * i / 16000)))
            for i in range(16000)
        )
        wf.writeframes(frames)
    return buf.getvalue()


def _post(client, data: dict):
    return client.post(
        "/transcribe",
        files={"audio": ("clip.wav", _silent_wav(), "audio/wav")},
        data=data,
    )


def _post_tone(client, data: dict):
    """POST a loud tone (passes the silence gate) for local-model tests."""
    return client.post(
        "/transcribe",
        files={"audio": ("clip.wav", _tone_wav(), "audio/wav")},
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


def test_whisper_idle_eviction(monkeypatch):
    """Idle > window drops the cached multi-GB Whisper model; fresh use keeps it."""
    stale = time.monotonic() - server._WHISPER_IDLE_EVICT_S - 1

    monkeypatch.setattr(server, "_whisper_model", object())
    monkeypatch.setattr(server, "_whisper_last_used", stale)
    server._evict_whisper_if_idle()
    assert server._whisper_model is None, "idle model must be evicted"

    monkeypatch.setattr(server, "_whisper_model", object())
    monkeypatch.setattr(server, "_whisper_last_used", time.monotonic())
    server._evict_whisper_if_idle()
    assert server._whisper_model is not None, "recently used model must stay"


def test_unload_whisper_manual_drops_cache(monkeypatch):
    """Manual unload frees the cached model immediately without waiting."""
    monkeypatch.setattr(server, "_whisper_model", object())
    monkeypatch.setattr(server, "_whisper_evict_timer", None)
    assert server.unload_whisper() is True
    assert server._whisper_model is None
    assert server.unload_whisper() is False


def test_models_unload_frees_python_owned_weights(monkeypatch):
    """POST /models/unload drops the sidecar-owned whisper, TTS and Laya weights.

    The embedding session is native now (the Rust router drops it and merges
    the report), so this endpoint only covers what Python still owns.
    """
    import laya_router
    import local_tts

    monkeypatch.setattr(server, "_whisper_model", object())
    monkeypatch.setattr(server, "_whisper_evict_timer", None)
    monkeypatch.setattr(local_tts, "_POCKET_MODEL", object())
    monkeypatch.setattr(local_tts, "_G2P_MODEL", None)
    monkeypatch.setattr(local_tts, "_tts_evict_timer", None)
    monkeypatch.setattr(laya_router, "_agent", object())
    monkeypatch.setattr(laya_router, "_agent_dir", "/laya")
    monkeypatch.setattr(laya_router, "_laya_evict_timer", None)
    client = TestClient(server.app)
    resp = client.post("/models/unload")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["freed"] == {"whisper": True, "tts": True, "laya": True}
    assert server._whisper_model is None


def test_no_provider_field_uses_local():
    captured: dict = {}
    fake_segment = SimpleNamespace(text="سلام دنیا")

    def fake_transcribe(*_args, **kwargs):
        captured.update(kwargs)
        return (iter([fake_segment]), SimpleNamespace(language="fa"))

    fake_model = SimpleNamespace(transcribe=fake_transcribe)
    with patch.object(server, "_get_whisper_model", AsyncMock(return_value=fake_model)):
        client = TestClient(server.app)
        resp = _post_tone(client, {"lang": "fa"})

    assert resp.status_code == 200
    assert resp.json()["text"] == "سلام دنیا"
    assert captured.get("beam_size") == 5


def test_remote_filename_matches_audio_content():
    """Webm uploads must be forwarded as clip.webm, not clip.wav.

    Browsers record webm/opus; some OpenAI-compatible STT gateways pick the
    decoder from the filename extension and reject webm bytes named clip.wav
    with "could not process file" (live voice failed while dictate kept
    working on a lenient path).
    """
    client = TestClient(server.app)
    captured: dict = {}

    async def fake_post(self, url, headers=None, files=None, data=None):
        captured.update({"files": files})
        resp = SimpleNamespace(status_code=200, text='{"text":"hi"}')
        resp.json = lambda: {"text": "hi"}
        return resp

    webm = bytes([0x1A, 0x45, 0xDF, 0xA3]) + b"\x00" * 64
    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = client.post(
            "/transcribe",
            files={"audio": ("clip", webm, "audio/webm")},
            data={
                "provider": "custom",
                "base_url": "http://localhost:20128/v1",
                "model": "whisper-1",
            },
        )

    assert resp.status_code == 200
    name, _payload, mime = captured["files"]["file"]
    assert name == "clip.webm"
    assert mime == "audio/webm"


def test_remote_wav_keeps_wav_filename():
    """Real wav bytes keep the previous clip.wav contract."""
    client = TestClient(server.app)
    captured: dict = {}

    async def fake_post(self, url, headers=None, files=None, data=None):
        captured.update({"files": files})
        resp = SimpleNamespace(status_code=200, text='{"text":"hi"}')
        resp.json = lambda: {"text": "hi"}
        return resp

    wav = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * 64
    with patch("httpx.AsyncClient.post", new=fake_post):
        resp = client.post(
            "/transcribe",
            files={"audio": ("clip", wav, "audio/wav")},
            data={
                "provider": "custom",
                "base_url": "http://localhost:20128/v1",
                "model": "whisper-1",
            },
        )

    assert resp.status_code == 200
    name, _payload, _mime = captured["files"]["file"]
    assert name == "clip.wav"


def test_models_preload_unknown_kind_rejected():
    """Unknown preload kinds are a 400, never a silent no-op."""
    client = TestClient(server.app)
    resp = client.post("/models/preload", json={"kind": "nope"})
    assert resp.status_code == 400


def test_models_preload_whisper_triggers_load():
    """Preload fires the Whisper load in the background (live-start path)."""
    import asyncio as _aio

    client = TestClient(server.app)
    called = _aio.Event()

    async def fake_get():
        called.set()
        return object()

    with patch.object(server, "_get_whisper_model", fake_get):
        resp = client.post("/models/preload", json={"kind": "whisper"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "kind": "whisper"}


def test_models_preload_tts_accepted():
    """TTS preload is accepted without loading weights in the request."""
    client = TestClient(server.app)
    with patch("local_tts.warmup_local_tts", return_value=True):
        resp = client.post("/models/preload", json={"kind": "tts"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "kind": "tts"}


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
