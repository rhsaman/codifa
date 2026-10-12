"""Local pocket-tts-farsi-v2 TTS endpoint tests (mocked, no downloads)."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import local_tts
import server


def test_local_tts_default_voice_is_pocket(monkeypatch, tmp_path):
    """Default local voice is the pocket v2 bundled voice, not Piper."""
    assert server.DEFAULT_PIPER_VOICE == local_tts.POCKET_DEFAULT_VOICE
    assert local_tts.active_provider_id() == "pocket-farsi-v2"
    assert local_tts.POCKET_REPO == "mehdi-hf/pocket-tts-farsi-v2"
    # v2 requirement: repo id must stay v2, never v1.
    assert "v2" in local_tts.POCKET_REPO


def test_local_tts_resolve_defaults_to_pocket(monkeypatch):
    """Empty/stale ids resolve to the pocket default voice."""
    req = server.TtsRequest(text="salam", provider="local")
    voice_id = server._resolve_tts_voice_id(req)
    assert voice_id == local_tts.POCKET_DEFAULT_VOICE
    # Legacy Piper ids migrate to the pocket default voice.
    legacy = server.TtsRequest(text="salam", provider="local", ttsModel="fa_IR-amir-medium")
    assert server._resolve_tts_voice_id(legacy) == local_tts.POCKET_DEFAULT_VOICE


def test_local_tts_success_with_mocked_pocket(monkeypatch, tmp_path):
    """Local provider synthesizes WAV bytes via mocked pocket model."""
    monkeypatch.setenv("LOCAL_TTS_DIR", str(tmp_path))
    monkeypatch.setenv("PIPER_VOICE_DIR", str(tmp_path))
    # Fake a ready pocket snapshot: weights + tokenizer + prompt.
    model_dir = tmp_path / "models--mehdi-hf--pocket-tts-farsi-v2"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "model.safetensors").write_bytes(b"fake-weights")
    (model_dir / "model.yaml").write_text("sample_rate: 24000")
    (model_dir / "tokenizer_ph.model").write_bytes(b"fake-tokenizer")
    (tmp_path / "default-prompt.wav").write_bytes(b"fake-prompt")
    assert local_tts.is_pocket_ready()

    captured = {}

    def fake_phonemise(text):
        captured["text"] = text
        return "sAlAm"

    class FakeModel:
        sample_rate = 24000

        def get_state_for_audio_prompt(self, prompt):
            captured["prompt"] = prompt
            return object()

        def generate_audio(self, voice_state, phonemes, max_tokens=50):
            captured["phonemes"] = phonemes
            captured["max_tokens"] = max_tokens
            import numpy as np

            return np.zeros(2400, dtype=np.float32)

    monkeypatch.setattr(local_tts, "_phonemise_fa", fake_phonemise)
    monkeypatch.setattr(local_tts, "_load_pocket_model", lambda: FakeModel())
    monkeypatch.setattr(local_tts, "_voice_state", lambda model, vid: object())

    wav_bytes = server._synthesize_piper_wav("salam", local_tts.POCKET_DEFAULT_VOICE)
    assert wav_bytes[:4] == b"RIFF"
    assert captured["text"] == "salam"
    assert captured["phonemes"] == "sAlAm"
    # Chunk budget must stay at the model card's safe ceiling (18 tokens):
    # larger chunks stop terminating and produce runaway noise.
    assert captured["max_tokens"] == local_tts.POCKET_MAX_CHUNK_TOKENS == 18


def test_local_tts_missing_model_returns_detail(monkeypatch, tmp_path):
    """Missing pocket snapshot raises 400 with a clear manual-download detail."""
    monkeypatch.setenv("LOCAL_TTS_DIR", str(tmp_path / "empty"))
    monkeypatch.setenv("PIPER_VOICE_DIR", str(tmp_path / "empty"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.chdir(tmp_path)

    with pytest.raises(HTTPException) as exc_info:
        local_tts.synthesize_wav("salam", local_tts.POCKET_DEFAULT_VOICE)
    assert exc_info.value.status_code == 400
    assert "not downloaded" in exc_info.value.detail
    assert local_tts.POCKET_REPO in exc_info.value.detail


def test_local_tts_empty_phonemes_raise_clear_error(monkeypatch, tmp_path):
    """Empty G2P output fails with a clear cause, not pocket's cryptic error."""
    monkeypatch.setenv("LOCAL_TTS_DIR", str(tmp_path))
    monkeypatch.setenv("PIPER_VOICE_DIR", str(tmp_path))
    model_dir = tmp_path / "models--mehdi-hf--pocket-tts-farsi-v2"
    model_dir.mkdir(parents=True)
    (model_dir / "model.safetensors").write_bytes(b"w")
    (model_dir / "model.yaml").write_text("sample_rate: 24000")
    (model_dir / "tokenizer_ph.model").write_bytes(b"t")
    (tmp_path / "default-prompt.wav").write_bytes(b"p")
    assert local_tts.is_pocket_ready()

    monkeypatch.setattr(local_tts, "_phonemise_fa", lambda text: "")
    monkeypatch.setattr(local_tts, "_load_pocket_model", lambda: object())
    monkeypatch.setattr(local_tts, "_voice_state", lambda model, vid: object())

    with pytest.raises(HTTPException) as exc_info:
        local_tts.synthesize_wav("salam", local_tts.POCKET_DEFAULT_VOICE)
    assert exc_info.value.status_code == 500
    assert "no phonemes" in exc_info.value.detail


def test_local_tts_size_counts_only_pocket_files(monkeypatch, tmp_path):
    """Settings size counts only the pocket snapshot + prompt, never siblings."""
    monkeypatch.setenv("LOCAL_TTS_DIR", str(tmp_path))
    monkeypatch.setenv("PIPER_VOICE_DIR", str(tmp_path))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    model_dir = tmp_path / "models--mehdi-hf--pocket-tts-farsi-v2"
    model_dir.mkdir(parents=True)
    weights, cfg, tok_size, prompt = 100, len("sample_rate: 24000"), 50, 25
    (model_dir / "model.safetensors").write_bytes(b"x" * weights)
    (model_dir / "model.yaml").write_text("sample_rate: 24000")
    (model_dir / "tokenizer_ph.model").write_bytes(b"x" * tok_size)
    (tmp_path / "default-prompt.wav").write_bytes(b"x" * prompt)
    # Sibling model dirs must not leak into the TTS card size.
    whisper = tmp_path / "models--Systran--faster-whisper-medium"
    whisper.mkdir()
    (whisper / "model.bin").write_bytes(b"x" * 999_999)

    assert local_tts.is_pocket_ready()
    snap = local_tts.download_snapshot()
    assert snap["state"] == "done"
    assert snap["size"] == weights + cfg + tok_size + prompt


def test_local_tts_endpoint_serves_wav(monkeypatch):
    """POST /tts with provider='local' returns WAV bytes (mocked synthesis)."""
    monkeypatch.setattr(local_tts, "synthesize_wav", lambda text, voice: b"RIFFfake-wav")
    client = TestClient(server.app)
    resp = client.post("/tts", json={"text": "سلام", "provider": "local"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content == b"RIFFfake-wav"


def test_local_tts_phonemes_split_within_token_ceiling(monkeypatch, tmp_path):
    """Punctuation-free phonemes are pre-split so pocket never skips words."""
    monkeypatch.setenv("LOCAL_TTS_DIR", str(tmp_path))
    monkeypatch.setenv("PIPER_VOICE_DIR", str(tmp_path))
    model_dir = tmp_path / "models--mehdi-hf--pocket-tts-farsi-v2"
    model_dir.mkdir(parents=True)
    (model_dir / "model.safetensors").write_bytes(b"w")
    (model_dir / "model.yaml").write_text("sample_rate: 24000")
    (model_dir / "tokenizer_ph.model").write_bytes(b"t")
    (tmp_path / "default-prompt.wav").write_bytes(b"p")
    assert local_tts.is_pocket_ready()

    class FakeTokenizer:
        """~1 token per 3 chars, like the phoneme sentencepiece model."""

        def __call__(self, text):
            n = max(1, (len(text) + 2) // 3)
            return [SimpleNamespace(tolist=lambda: list(range(n)))]

    generated: list[str] = []

    class FakeModel:
        sample_rate = 24000
        flow_lm = SimpleNamespace(
            conditioner=SimpleNamespace(tokenizer=FakeTokenizer())
        )

        def generate_audio(self, voice_state, phonemes, max_tokens=50):
            generated.append(phonemes)
            import numpy as np

            return np.ones(240, dtype=np.float32)

    words = ["abc"] * 30
    monkeypatch.setattr(local_tts, "_phonemise_fa", lambda text: " ".join(words))
    monkeypatch.setattr(local_tts, "_load_pocket_model", lambda: FakeModel())
    monkeypatch.setattr(local_tts, "_voice_state", lambda model, vid: object())

    wav = local_tts.synthesize_wav("long", local_tts.POCKET_DEFAULT_VOICE)
    assert wav[:4] == b"RIFF"
    # The oversized input needed more than one chunk ...
    assert len(generated) > 1
    tok = FakeTokenizer()
    for chunk in generated:
        # Budget is one below the ceiling: pocket appends terminal
        # punctuation (+1 token), so an 18-token split would become 19.
        assert len(tok(chunk)[0].tolist()) <= local_tts.POCKET_SPLIT_BUDGET_TOKENS
    # ... and no word was dropped by the splitting.
    assert " ".join(generated).split() == words


def test_local_tts_synthesis_serializes_concurrent_calls(monkeypatch, tmp_path):
    """Concurrent synthesize_wav calls never overlap in generate_audio.

    pocket's generate_audio is documented as not thread-safe: the frontend
    prefetches sentences in parallel, and overlapping calls corrupt the
    shared model state (generation hangs without EOS -> speech stops
    mid-sentence). The backend must serialize synthesis.
    """
    monkeypatch.setenv("LOCAL_TTS_DIR", str(tmp_path))
    monkeypatch.setenv("PIPER_VOICE_DIR", str(tmp_path))
    model_dir = tmp_path / "models--mehdi-hf--pocket-tts-farsi-v2"
    model_dir.mkdir(parents=True)
    (model_dir / "model.safetensors").write_bytes(b"w")
    (model_dir / "model.yaml").write_text("sample_rate: 24000")
    (model_dir / "tokenizer_ph.model").write_bytes(b"t")
    (tmp_path / "default-prompt.wav").write_bytes(b"p")
    assert local_tts.is_pocket_ready()

    active = 0
    max_active = 0
    guard = threading.Lock()

    class FakeModel:
        sample_rate = 24000
        flow_lm = SimpleNamespace(conditioner=SimpleNamespace(tokenizer=None))

        def generate_audio(self, voice_state, phonemes, max_tokens=50):
            nonlocal active, max_active
            with guard:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)
            with guard:
                active -= 1
            import numpy as np

            return np.ones(240, dtype=np.float32)

    monkeypatch.setattr(local_tts, "_phonemise_fa", lambda text: "a b c")
    monkeypatch.setattr(local_tts, "_load_pocket_model", lambda: FakeModel())
    monkeypatch.setattr(local_tts, "_voice_state", lambda model, vid: object())

    results: list = []
    errors: list = []

    def _run():
        try:
            results.append(local_tts.synthesize_wav("hi", local_tts.POCKET_DEFAULT_VOICE))
        except Exception as exc:  # noqa: BLE001 - collect any failure for the assert
            errors.append(exc)

    threads = [threading.Thread(target=_run) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert errors == []
    assert len(results) == 3
    for wav in results:
        assert wav[:4] == b"RIFF"
    # Without the synthesis lock, three overlapping calls push this to 3.
    assert max_active == 1


def test_concat_audio_inserts_pause_between_chunks():
    """Chunk joints carry a short silence so speech does not sound rushed.

    Independently synthesized chunks joined with no pause sound sped up,
    as if the playback rate went up. Frames of one generation still join
    seamlessly (gap 0).
    """
    import numpy as np

    left = np.ones(1000, dtype=np.float32)
    right = np.full(1000, 2.0, dtype=np.float32)
    seamless = np.asarray(local_tts._concat_audio([left, right])).reshape(-1)
    assert len(seamless) == 1000 + 1000 - 480
    gap = 2400
    paused = np.asarray(
        local_tts._concat_audio([left, right], gap_samples=gap)
    ).reshape(-1)
    assert len(paused) == 1000 + gap + 1000 - 2 * 480
    # The middle of the joint is silence, not a click.
    mid = paused[1000 - 480 : 1000 + gap]
    assert abs(float(np.mean(mid))) < 0.6


def test_generate_chunk_audio_joins_stream_frames_without_crossfade():
    """Contiguous frames of one generation join with NO crossfade.

    pocket itself joins streamed frames with a bare torch.cat: they are
    consecutive slices of the same audio. Crossfading them deletes ~480
    samples at every joint (~25% of each ~80 ms frame), compressing the
    timeline ~20% — the "sounds sped up" bug. The join must be exact.
    """
    import numpy as np

    frames = [np.ones(1920, dtype=np.float32), np.full(1920, 2.0, dtype=np.float32)]
    it = iter(frames)

    class FakeModel:
        sample_rate = 24000
        model_recommended_frames_after_eos = 3

        def _generate_audio_stream_short_text(self, **kwargs):
            yield from it

    joined = np.asarray(
        local_tts._generate_chunk_audio(FakeModel(), object(), "a b")
    ).reshape(-1)
    # Exact concatenation: no samples deleted at the frame joint.
    assert len(joined) == 1920 + 1920
    assert float(joined[1919]) == 1.0
    assert float(joined[1920]) == 2.0
