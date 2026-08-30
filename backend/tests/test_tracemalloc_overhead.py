"""Tests: tracemalloc overhead guard + snapshot lifecycle.

These cover the two changes that bring run-over-run RSS growth under control:

1. The previous snapshot reference is dropped BEFORE take_snapshot() so the
   old trace frames are GC'able (without this the RSS high-water keeps
   climbing between runs).
2. When RSS is already too high, the snapshot is skipped (rather than
   materializing every live trace and tipping a near-OOM process over the
   edge).
"""
import tracemalloc

import server
from server import (
    _TRACE_FRAMES,
    _TRACE_RSS_SNAPSHOT_MAX_MB,
    _log_memory_snapshot,
)


def _ensure_tracing():
    """tracemalloc must be active for the snapshot to do anything; the sidecar
    only starts it when CODFA_TRACE_MALLOC=1 or CODFA_LOG_LEVEL=DEBUG. Tests
    start it explicitly so the same code path is exercised."""
    if not tracemalloc.is_tracing():
        tracemalloc.start(_TRACE_FRAMES)


def test_snapshot_skipped_when_rss_too_high(monkeypatch, caplog):
    """When RSS exceeds the cap, _log_memory_snapshot must skip the snapshot
    AND log a clear 'skipped' line (so the operator knows why the diagnostic
    didn't run this time, and so it never silently OOMs the sidecar while
    trying to diagnose it)."""
    _ensure_tracing()
    monkeypatch.setattr(server, "_rss_mb", lambda: _TRACE_RSS_SNAPSHOT_MAX_MB + 100.0)
    with caplog.at_level("WARNING", logger="codifa.server"):
        _log_memory_snapshot("test-chat-rss-high")
    # Look for the skip line — it must say 'snapshot skipped' so a postmortem
    # can tell the diagnostic was deliberately bypassed.
    skip_lines = [r.message for r in caplog.records if "snapshot skipped" in r.message]
    assert skip_lines, "expected a 'snapshot skipped' warning when RSS exceeds the cap"


def test_snapshot_drops_prev_before_taking_next(monkeypatch, caplog):
    """The previous snapshot reference must be cleared BEFORE
    tracemalloc.take_snapshot() so the old trace frames are GC'able. Without
    this, the prior snapshot stays alive in tracemalloc's bookkeeping and the
    RSS high-water accumulates run-over-run."""
    _ensure_tracing()
    seen = {}
    orig = tracemalloc.take_snapshot

    def spy():
        # At the moment take_snapshot is called, the module-level
        # _TRACE_PREV_SNAPSHOT must already be None (the old reference was
        # dropped first).
        seen["prev_at_take"] = server._TRACE_PREV_SNAPSHOT
        return orig()

    monkeypatch.setattr(tracemalloc, "take_snapshot", spy)
    # Keep RSS below the cap so the skip-guard doesn't short-circuit.
    monkeypatch.setattr(server, "_rss_mb", lambda: 100.0)
    with caplog.at_level("WARNING", logger="codifa.server"):
        _log_memory_snapshot("test-chat-prev-drop")
    assert seen["prev_at_take"] is None, (
        "_TRACE_PREV_SNAPSHOT was not cleared before take_snapshot(); "
        "the old trace will accumulate run-over-run."
    )
    # After the call, the new snapshot must be stored.
    assert server._TRACE_PREV_SNAPSHOT is not None
