"""Live test: sub-agent tool loop (explore/general) runs read-only tools concurrently.

Mirrors opencode's Promise.all: when the model emits several read-only tool
calls in one step, ``langchain_tool_loop`` executes them via ``asyncio.gather``
so they overlap in wall-clock time (grep/glob/read/web/vision all run at once).
Mutating/blocking tools still run sequentially. This is the same behavior the
main-agent loop in ``graph.py`` already had -- this test guards it for the
sub-agent path that ``task(subagent_type='explore'|'general')`` uses.
"""
import asyncio
import os
import sys
import tempfile
import threading
import time

_TMP = tempfile.mkdtemp(prefix="coder-test-subparallel-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage

import tools
from llm import langchain_tool_loop
from tools import make_tool_callbacks


class _RecordingModel:
    """Fake LangChain model: first replies with N parallel tool calls, then text."""

    model_name = "fake"

    def __init__(self, tool_calls, reply="done"):
        self._tool_calls = tool_calls
        self._reply = reply
        self._step = 0

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        self._step += 1
        if self._step == 1:
            return AIMessage(content="", tool_calls=self._tool_calls)
        return AIMessage(content=self._reply)


def _make_slow_tool(active, peaks, sleep=0.05):
    async def _tool():
        active.append(1)
        peaks.append(len(active))
        try:
            await asyncio.sleep(sleep)
            return "ok"
        finally:
            active.pop()

    return _tool


async def test_subagent_readonly_tools_run_concurrently():
    active: list[int] = []
    peaks: list[int] = []

    tools = {
        "tool_a": _make_slow_tool(active, peaks),
        "tool_b": _make_slow_tool(active, peaks),
        "tool_c": _make_slow_tool(active, peaks),
    }

    model = _RecordingModel(
        tool_calls=[
            {"name": "tool_a", "args": {}, "id": "c1"},
            {"name": "tool_b", "args": {}, "id": "c2"},
            {"name": "tool_c", "args": {}, "id": "c3"},
        ],
    )

    result = await langchain_tool_loop(model, tools=tools, user="search everything")
    assert result == "done", f"unexpected final reply: {result!r}"
    # All three read-only tools were requested in one step and must overlap: at
    # least two were in-flight simultaneously (true concurrency via gather).
    assert max(peaks) >= 2, (
        f"expected concurrent execution (peak in-flight >= 2), got {max(peaks)}"
    )
    # Every parallel call resolved exactly once.
    assert len(peaks) == 3, f"expected 3 tool executions, got {len(peaks)}"


async def test_subagent_single_toolcall_still_sequential_path():
    """One tool call at a time takes the (equivalent) sequential branch safely."""
    active: list[int] = []
    peaks: list[int] = []

    tools = {"tool_a": _make_slow_tool(active, peaks)}

    model = _RecordingModel(
        tool_calls=[{"name": "tool_a", "args": {}, "id": "c1"}],
    )

    result = await langchain_tool_loop(model, tools=tools, user="one thing")
    assert result == "done"
    assert len(peaks) == 1


async def test_explore_grep_searches_run_concurrently(monkeypatch):
    """Regression: grep_tool must offload its blocking scan off the event loop.

    grep_tool used to call ``search_in_files()`` synchronously inside an async
    function. Because a sync call freezes the event loop until it returns,
    ``asyncio.gather`` (in graph.py and langchain_tool_loop) ran gathered
    read-only tools ONE AT A TIME -- so Explore's searches (and any parallel
    ``task`` fan-out) never overlapped. Now grep_tool uses
    ``await asyncio.to_thread(search_in_files, ...)``, so two greps emitted in
    one step overlap on worker threads and finish in ~one scan's time.

    This test fakes a slow, blocking scan and asserts the two grep calls (a)
    overlap in wall-clock time and (b) run OFF the event-loop thread.
    """
    calls: list[dict] = []
    loop_tid = threading.get_ident()

    def fake_search_in_files(root, pattern, path, snippet, include):
        rec = {"tid": threading.get_ident(), "start": time.time(), "end": 0.0}
        calls.append(rec)  # capture the reference; update OUR OWN record below
        time.sleep(0.08)  # simulate a heavy, blocking filesystem scan
        rec["end"] = time.time()
        return {"matches": []}

    monkeypatch.setattr(tools, "search_in_files", fake_search_in_files)

    _tools = make_tool_callbacks(root="/tmp", emit=lambda _e: None, main_model=None)
    grep = _tools["grep"]

    model = _RecordingModel(
        tool_calls=[
            {"name": "grep", "args": {"pattern": "alpha"}, "id": "g1"},
            {"name": "grep", "args": {"pattern": "beta"}, "id": "g2"},
        ],
    )

    result = await langchain_tool_loop(model, tools={"grep": grep}, user="search")
    assert result == "done"
    assert len(calls) == 2, f"expected 2 search_in_files calls, got {len(calls)}"
    # Both scans must run on worker threads (not the event-loop thread).
    assert calls[0]["tid"] != loop_tid and calls[1]["tid"] != loop_tid, (
        "search ran on the event-loop thread -- to_thread offload is missing"
    )
    # And they must overlap in time (true concurrency, not serialized).
    a, b = calls[0], calls[1]
    assert a["start"] < b["end"] and b["start"] < a["end"], (
        f"grep searches did not overlap (serialized): {calls}"
    )


async def test_reader_read_runs_concurrent(monkeypatch):
    """Regression: the deterministic Explore reader (reader_read) must read the
    targeted files concurrently, not loop one-at-a-time.

    reader_read builds every (file, range) read spec, then runs them through
    ``asyncio.gather`` over the (thread-offloaded) read tool. This test fakes a
    slow blocking read and asserts the N targeted reads overlap in wall-clock
    time -- matching opencode's parallel tool execution for independent reads.
    """
    import graph as G

    calls: list[dict] = []

    async def fake_run_repo_tool(**kwargs):
        rec = {"file": kwargs.get("filePath"), "start": time.time()}
        calls.append(rec)
        await asyncio.sleep(0.06)  # simulate a blocking disk read
        rec["end"] = time.time()
        return "file contents"

    # Avoid building a real chat model / vector store inside _make_explore_tools.
    monkeypatch.setattr(G, "_make_explore_tools", lambda s, q: {"read": fake_run_repo_tool})
    # Force the fallback "read head" branch per file (no grep patterns / line refs).
    monkeypatch.setattr(G, "_derive_explore_patterns", lambda prompt: {"grep": []})
    monkeypatch.setattr(G, "_explicit_files", lambda s: ["a.py", "b.py", "c.py", "d.py"])

    state = {
        "_queue": asyncio.Queue(),
        "root": "/tmp",
        "request": "read a.py b.py c.py d.py",
    }
    result = await G.reader_read(state)
    assert "read_context" in result
    assert len(calls) == 4, f"expected 4 reads, got {len(calls)}"
    # All four reads must overlap: the last one must start before the first ends.
    starts = sorted(c["start"] for c in calls)
    ends = sorted(c["end"] for c in calls)
    first_end = ends[0]
    last_start = starts[-1]
    assert last_start < first_end, (
        f"reader_read ran sequentially "
        f"(last start {last_start:.3f} >= first end {first_end:.3f})"
    )
