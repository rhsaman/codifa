"""Tests for the /transcribe endpoint's Persian accuracy settings.

These tests mock the Whisper model so no model download or GPU is needed.
They verify that, for Persian (lang=fa), the endpoint passes a correct
initial_prompt (with proper punctuation guidance) and sane decoding
parameters, and that the transcribed text is returned verbatim.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import server


def _make_client(captured: dict):
    """Build a TestClient whose Whisper model records its transcribe kwargs.

    The patch must stay active for the whole request, so we apply it at the
    module level via ``patch`` and return the started context manager's client.
    """
    fake_segment = SimpleNamespace(text="سلام دنیا")

    def fake_transcribe(*_args, **kwargs):
        captured.update(kwargs)
        # faster-whisper returns (segments_generator, info)
        return (iter([fake_segment]), SimpleNamespace(language="fa"))

    fake_model = SimpleNamespace(transcribe=fake_transcribe)

    patcher = patch.object(server, "_get_whisper_model", AsyncMock(return_value=fake_model))
    patcher.start()
    return TestClient(server.app)


def _silent_wav() -> bytes:
    """A tiny valid 16 kHz mono 16-bit PCM WAV (1 second of silence)."""
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)
    return buf.getvalue()


def _tone_wav() -> bytes:
    """A loud 1s 440Hz tone: passes the PCM energy gate in tests."""
    import io
    import math
    import struct
    import wave

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


def _post(client, lang: str | None = None):
    """POST a fake audio file (multipart) like the browser does."""
    data = {}
    if lang is not None:
        data["lang"] = lang
    return client.post(
        "/transcribe",
        files={"audio": ("clip.wav", _tone_wav(), "audio/wav")},
        data=data,
    )


def test_fa_initial_prompt_has_punctuation_guidance():
    captured: dict = {}
    client = _make_client(captured)

    resp = _post(client, lang="fa")

    assert resp.status_code == 200
    assert "فارسی" in (captured.get("initial_prompt") or "")
    # The old prompt told the model "no punctuation"; the new one must not.
    assert "no punctuation" not in (captured.get("initial_prompt") or "")
    # The prompt must never instruct the model to drop words: a "no filler
    # words" instruction made Whisper delete real spoken words.
    assert "پرکننده" not in (captured.get("initial_prompt") or "")
    assert resp.json()["text"] == "سلام دنیا"


def test_non_fa_has_no_initial_prompt():
    captured: dict = {}
    client = _make_client(captured)

    resp = _post(client, lang="en")

    assert resp.status_code == 200
    assert captured.get("initial_prompt") is None


def test_missing_lang_defaults_to_none_prompt():
    captured: dict = {}
    client = _make_client(captured)

    resp = _post(client)

    assert resp.status_code == 200
    assert captured.get("initial_prompt") is None


def test_decoding_params_tightened_for_accuracy():
    captured: dict = {}
    client = _make_client(captured)

    _post(client, lang="fa")

    # Beam 5 halves decode time vs 10 with no accuracy loss on short
    # live turns; stricter thresholds reject low-confidence output.
    assert captured.get("beam_size") == 5
    assert captured.get("log_prob_threshold") == -0.8
    # Ambient-noise rejection without chopping quiet words: a middle
    # no-speech threshold skips segments Whisper flags as
    # probably-not-speech, but keeps quiet real speech.
    assert captured.get("no_speech_threshold") == 0.5
    assert captured.get("condition_on_previous_text") is False
    # The Silero VAD gate drops sub-300ms blips (clicks/bumps) so they
    # never become text, while a moderate threshold keeps quiet word
    # edges (a stricter gate chopped syllables into wrong words).
    # Generous silence padding keeps word edges intact for accuracy.
    vad = captured.get("vad_parameters") or {}
    assert vad.get("threshold") == 0.5
    assert vad.get("min_speech_duration_ms") == 300
    assert vad.get("min_silence_duration_ms") == 400
    assert vad.get("speech_pad_ms") == 300
    assert captured.get("compression_ratio_threshold") == 2.0


def test_silence_returns_empty_without_model():
    """Pure silence is gated before Whisper: no ghost text, no model call."""
    captured: dict = {}
    client = _make_client(captured)
    resp = client.post(
        "/transcribe",
        files={"audio": ("clip.wav", _silent_wav(), "audio/wav")},
        data={"lang": "fa"},
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == ""
    assert captured == {}


def test_repeated_loop_filtered_as_hallucination():
    """A Whisper token loop (same word x4) is dropped, never sent to chat."""
    fake_segment = SimpleNamespace(text="test test test test")

    def fake_transcribe(*_args, **kwargs):
        return (iter([fake_segment]), SimpleNamespace(language="fa"))

    fake_model = SimpleNamespace(transcribe=fake_transcribe)
    with patch.object(server, "_get_whisper_model", AsyncMock(return_value=fake_model)):
        client = TestClient(server.app)
        resp = client.post(
            "/transcribe",
            files={"audio": ("clip.wav", _tone_wav(), "audio/wav")},
            data={"lang": "fa"},
        )
    assert resp.status_code == 200
    assert resp.json()["text"] == ""


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
