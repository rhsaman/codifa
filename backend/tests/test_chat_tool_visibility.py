"""Chat vs trace parity: every chat-visible tool must emit a start card.

Regression for "tool in trace but missing in chat": git_* and current_time
only emitted ``tool_result``. Chat builds cards from ``kind == tool`` events,
so without a start event no card (and no segment) exists and the call only
appears in the trace store. This test pins the start-event contract.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-tool-visibility-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tools import make_tool_callbacks


def _run(coro):
    return asyncio.run(coro)


def _collect(root):
    events = []
    cbs = make_tool_callbacks(root=root, emit=events.append)
    return cbs, events


def _kinds(events, tool):
    starts = [e for e in events if e.get("kind") == "tool" and e.get("tool") == tool]
    results = [e for e in events if e.get("kind") == "tool_result" and e.get("tool") == tool]
    return starts, results


def test_git_tools_emit_start_card(tmp_path):
    """git_* tools emit kind=tool before kind=tool_result (even on error)."""
    cbs, events = _collect(str(tmp_path))
    _run(cbs["git_status"]())
    _run(cbs["git_diff"]())
    _run(cbs["git_log"]())
    for name in ("git_status", "git_diff", "git_log"):
        starts, results = _kinds(events, name)
        assert len(starts) == 1, f"{name} missing start card event: {events}"
        assert len(results) == 1, f"{name} missing result event: {events}"
        assert events.index(starts[0]) < events.index(results[0])


def test_current_time_emit_start_and_result():
    """current_time emits a start card plus a result (was result-less/silent)."""
    cbs, events = _collect(os.getcwd())
    _run(cbs["current_time"]())
    starts, results = _kinds(events, "current_time")
    assert len(starts) == 1
    assert len(results) == 1
    assert events.index(starts[0]) < events.index(results[0])
