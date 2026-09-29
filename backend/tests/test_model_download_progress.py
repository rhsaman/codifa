"""Download progress, pause/resume/stop for managed models (incl. Whisper)."""

from __future__ import annotations

import threading

import model_download


def _reset() -> None:
    model_download._STATES.clear()
    model_download._CONTROLS.clear()
    model_download._SPEED_SAMPLES.clear()
    model_download._RUNS.clear()


def test_record_bytes_computes_percent_and_speed():
    _reset()
    model_download._set_downloading("embedding", "org/repo", "", 0)
    model_download._record_bytes("embedding", 25, 100)
    st = model_download.download_state("embedding")
    assert st is not None
    assert st["downloaded_bytes"] == 25
    assert st["total_bytes"] == 100
    assert st["percent"] == 25.0
    # Negative increments (counter rewind when the server ignores Range)
    # must never drive the counter below zero.
    model_download._record_bytes("embedding", -10, 100)
    st = model_download.download_state("embedding")
    assert st is not None
    assert st["downloaded_bytes"] == 15
    assert st["percent"] == 15.0


def test_pause_resume_cancel_cycle():
    _reset()
    model_download._set_downloading("whisper", "org/whisper", "", 0)
    assert model_download.pause_download("whisper") is True
    st = model_download.download_state("whisper")
    assert st is not None and st["state"] == "paused"
    # Pausing twice is a no-op.
    assert model_download.pause_download("whisper") is False
    assert model_download.resume_download("whisper") is True
    st = model_download.download_state("whisper")
    assert st is not None and st["state"] == "downloading"
    # Resuming when not paused is a no-op.
    assert model_download.resume_download("whisper") is False
    assert model_download.cancel_download("whisper") is True


def test_cancel_clears_error_state():
    _reset()
    model_download._set_downloading("laya", "org/laya", "", 0)
    model_download._set_error("laya", "org/laya", "boom")
    assert model_download.cancel_download("laya") is True
    assert model_download.download_state("laya") is None


def test_cancel_clears_running_state_immediately():
    _reset()
    model_download._set_downloading("embedding", "org/repo", "", 0)
    assert model_download.cancel_download("embedding") is True
    assert model_download.download_state("embedding") is None
    # Idempotent: stopping again when nothing runs still succeeds.
    assert model_download.cancel_download("embedding") is True


def test_tqdm_class_tracks_and_cancels(monkeypatch):
    _reset()
    model_download._set_downloading("embedding", "org/repo", "", 0)
    controls = model_download._controls_for("embedding")
    cls = model_download._make_tqdm_class("embedding", controls)
    bar = cls(total=100, unit="B", desc="model.safetensors")
    bar.update(40)
    st = model_download.download_state("embedding")
    assert st is not None
    assert st["downloaded_bytes"] == 40
    assert st["percent"] == 40.0
    # The file-count bar (no byte unit) must not be counted.
    files_bar = cls(total=3, desc="Fetching 3 files")
    files_bar.update(1)
    st = model_download.download_state("embedding")
    assert st is not None
    assert st["downloaded_bytes"] == 40
    # Stopping: the next update must raise the cancel error.
    controls["cancel"].set()
    try:
        bar.update(1)
    except model_download._DownloadCancelled:
        cancelled = True
    else:
        cancelled = False
    assert cancelled is True


def test_cancellable_sleep_raises_on_cancel(monkeypatch):
    _reset()
    model_download._set_downloading("embedding", "org/repo", "", 0)
    controls = model_download._controls_for("embedding")
    # Pretend we are the download thread for this kind.
    monkeypatch.setattr(
        model_download.threading,
        "current_thread",
        lambda: type("T", (), {"name": "model-dl-embedding"})(),
    )
    slept: list[float] = []
    monkeypatch.setattr(model_download, "_ORIG_SLEEP", slept.append)
    # No cancel flag: sleeps in slices until the budget is consumed.
    model_download._cancellable_sleep(0.25)
    assert slept, "expected sliced sleeps"
    assert abs(sum(slept) - 0.25) < 1e-9
    # Cancel flag: raises immediately instead of sleeping.
    controls["cancel"].set()
    try:
        model_download._cancellable_sleep(5)
    except model_download._DownloadCancelled:
        cancelled = True
    else:
        cancelled = False
    assert cancelled is True


def test_start_download_resumes_paused_without_thread(monkeypatch):
    _reset()
    model_download._set_downloading("embedding", "org/repo", "", 0)
    assert model_download.pause_download("embedding") is True
    started_threads: list[threading.Thread] = []
    orig_thread = threading.Thread

    def _fake_thread(*args, **kwargs):
        raise AssertionError("paused resume must not spawn a thread")

    monkeypatch.setattr(threading, "Thread", _fake_thread)
    try:
        assert model_download.start_download("embedding", "org/repo") is True
    finally:
        monkeypatch.setattr(threading, "Thread", orig_thread)
    st = model_download.download_state("embedding")
    assert st is not None and st["state"] == "downloading"
    assert started_threads == []


def test_whisper_ready_requires_weight_file(tmp_path, monkeypatch):
    """A Whisper dir with only config fragments is NOT ready.

    Regression guard for the old check (any non-empty file counted), which
    marked a half-downloaded dir as Ready and hid the Download/Resume button.
    """
    _reset()
    monkeypatch.setattr(model_download, "whisper_dir", lambda: str(tmp_path))
    (tmp_path / "config.json").write_text("{}")
    assert model_download.whisper_ready() is False
    (tmp_path / "model.bin").write_bytes(b"\0" * 16)
    assert model_download.whisper_ready() is True


def test_whisper_pause_resume_cancel_cycle():
    """Whisper (Speech to Text) shares the same cancellable path as the rest."""
    _reset()
    model_download._set_downloading("whisper", "org/whisper", "", 0)
    assert model_download.pause_download("whisper") is True
    st = model_download.download_state("whisper")
    assert st is not None and st["state"] == "paused"
    assert model_download.resume_download("whisper") is True
    assert model_download.cancel_download("whisper") is True
    assert model_download.download_state("whisper") is None
    # Idempotent: stopping again when nothing runs still succeeds.
    assert model_download.cancel_download("whisper") is True


def test_snapshot_download_uses_tuned_settings(monkeypatch):
    """Slow-network tuning must reach snapshot_download (workers + timeout)."""
    _reset()
    calls: dict = {}

    def _fake_snapshot(**kwargs):
        calls.update(kwargs)
        return "/tmp/fake"

    monkeypatch.setattr(model_download, "whisper_dir", lambda: "/tmp/fake")
    monkeypatch.setattr(model_download, "_dir_size", lambda _p: 0)
    import huggingface_hub

    monkeypatch.setattr(huggingface_hub, "snapshot_download", _fake_snapshot)
    assert model_download.start_download("whisper", "org/whisper") is True
    # The download runs on a background thread — wait for it to call through.
    deadline = model_download.time.monotonic() + 5.0
    while "max_workers" not in calls and model_download.time.monotonic() < deadline:
        model_download.time.sleep(0.05)
    assert calls.get("max_workers") == model_download._SNAPSHOT_MAX_WORKERS
    assert calls.get("etag_timeout") == model_download._SNAPSHOT_ETAG_TIMEOUT
    model_download.cancel_download("whisper")
