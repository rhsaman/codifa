"""Live test: auto-compact falls back to the main model.

The configured compact subagent can fail (bad key, provider down, rate limit,
timeout) or return an EMPTY summary. `_compact_history` must then fall back to
the main model once — mirroring the manual /compact path — instead of surfacing
`compact_failed`. Drives the real backend against the shared mock server.
Run standalone (`python backend/tests/test_compact.py`) or via
`python backend/tests/run_tests.py`.
"""
import asyncio
import os
import tempfile

# Hermetic data root BEFORE importing anything that touches state_db.
_TMP = tempfile.mkdtemp(prefix="coder-test-compact-data-")
os.environ["CODER_DATA_DIR"] = _TMP

from mock_openai import (
    mock,
    start_server,
    stop_server,
    text_reply,
)

from agents import _compact_history
from providers import build_model


def make_history(n=12):
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"message {i}"}
        for i in range(n)
    ]


async def main():
    task, base = await start_server()
    try:
        # Two DISTINCT model objects pointing at the same mock server: the
        # "compact subagent" (primary) and the "main model" (fallback).
        compact_model = build_model("custom", "mock-model", base, "test", "", "")
        main_model = build_model("custom", "mock-model", base, "test", "", "")
        history = make_history()

        # 1. Compact subagent FAILS (hard 400) -> fall back to the main model.
        mock.script = [None, text_reply("Fallback summary")]
        mock.captured = []
        compacted = await _compact_history(
            compact_model, history, max_history=5, fallback_model=main_model
        )
        assert compacted is not None, "fallback compact must succeed"
        new_history, recent_n = compacted
        assert new_history[0]["content"].startswith(
            "[Compacted earlier context]"
        ), new_history[0]
        assert "Fallback summary" in new_history[0]["content"], new_history[0]["content"]
        assert recent_n == 1, f"recent_n={recent_n}"
        assert len(new_history) == 2, f"1 summary + 1 recent turn, got {len(new_history)}"
        print("  OK: failing compact subagent falls back to main model")

        # 2. Compact subagent returns an EMPTY summary -> fall back too.
        mock.script = [text_reply(""), text_reply("Fallback summary")]
        mock.captured = []
        compacted = await _compact_history(
            compact_model, history, max_history=5, fallback_model=main_model
        )
        assert compacted is not None, "empty-summary fallback must succeed"
        new_history, _ = compacted
        assert "Fallback summary" in new_history[0]["content"], new_history[0]["content"]
        print("  OK: empty summary falls back to main model")

        # 3. NO fallback configured -> a failing compact returns None (caller
        #    surfaces compact_failed; nothing is dropped).
        mock.script = [None]
        mock.captured = []
        compacted = await _compact_history(compact_model, history, max_history=5)
        assert compacted is None, "no fallback -> None expected"
        print("  OK: no fallback -> None (compact_failed path)")

        # 4. Nothing to compact (single message, nothing older) -> None without
        #    any model request. (opencode-style keeps only the LAST message
        #    verbatim, so any history with >=2 turns is compactable.)
        mock.script = []
        mock.captured = []
        compacted = await _compact_history(compact_model, make_history(1), max_history=5)
        assert compacted is None, "single-message history -> None expected"
        assert not mock.captured, "no model request should be made"
        print("  OK: single-message history -> None, no request")

        print("COMPACT TESTS PASSED")
    finally:
        await stop_server(task)


if __name__ == "__main__":
    asyncio.run(main())