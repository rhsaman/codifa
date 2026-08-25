"""Unit test: the parent search cache is shared between the main agent and the
explore sub-agent (and across parallel explore agents).

``_parent_search_cache`` lives at module scope in ``tools.py`` (not in a
closure), so every tool callback built from that module -- the main agent's
and every sub-agent's -- reads and writes the SAME dict. That means:

- A grep/glob the main agent already ran is returned from cache when the
  explore sub-agent issues the identical search (no second disk scan).
- Two parallel explore agents issuing the same search share the cache too.

This is the mechanism that keeps tool-call counts down (fewer redundant
grep/glob calls) without any quality loss -- the cached result is byte-for-byte
what a fresh scan would return. Regression guard for the assumption that the
cache is module-level and therefore shared across agents.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subcache-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage  # noqa: E402

import tools as _tools  # noqa: E402
from tools import make_tool_callbacks  # noqa: E402


class _RecordingModel:
    model_name = "fake"

    def __init__(self, reply="done"):
        self._step = 0
        self._reply = reply

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        self._step += 1
        if self._step == 1:
            return AIMessage(content="", tool_calls=[])
        return AIMessage(content=self._reply)


async def _run_grep_via(cbs, pattern, path=""):
    return await cbs["grep"](pattern=pattern, path=path)


async def test_search_cache_shared_main_then_explore():
    # Count how many times the real disk scan runs.
    real_scans = {"n": 0}

    _orig_search = _tools.search_in_files

    def _counting_search(*a, **k):
        real_scans["n"] += 1
        return _orig_search(*a, **k)

    _tools.search_in_files = _counting_search
    _tools._parent_search_cache.clear()
    try:
        # Main agent runs the grep first.
        main_cbs = make_tool_callbacks(
            root=os.getcwd(), emit=lambda ev: None, context_window=0,
            main_model=_RecordingModel(),
        )
        await _run_grep_via(main_cbs, pattern="def make_tool_callbacks")

        # Explore sub-agent issues the IDENTICAL grep.
        explore_cbs = make_tool_callbacks(
            root=os.getcwd(), emit=lambda ev: None, context_window=0,
            main_model=_RecordingModel(),
        )
        await _run_grep_via(explore_cbs, pattern="def make_tool_callbacks")

        # The disk scan must have run exactly ONCE -- the second call hit the
        # shared module-level cache.
        assert real_scans["n"] == 1, real_scans
    finally:
        _tools.search_in_files = _orig_search
        _tools._parent_search_cache.clear()


async def test_search_cache_shared_across_sequential_explore():
    real_scans = {"n": 0}
    _orig_search = _tools.search_in_files

    def _counting_search(*a, **k):
        real_scans["n"] += 1
        return _orig_search(*a, **k)

    _tools.search_in_files = _counting_search
    _tools._parent_search_cache.clear()
    try:
        # Two explore agents built independently, run sequentially, same search.
        a = make_tool_callbacks(root=os.getcwd(), emit=lambda ev: None, context_window=0, main_model=_RecordingModel())
        b = make_tool_callbacks(root=os.getcwd(), emit=lambda ev: None, context_window=0, main_model=_RecordingModel())

        await _run_grep_via(a, pattern="class _RecordingModel")
        await _run_grep_via(b, pattern="class _RecordingModel")
        # 2 identical greps across 2 agents, but only ONE real disk scan
        # (the second reuses the module-level cache the first populated).
        assert real_scans["n"] == 1, real_scans
    finally:
        _tools.search_in_files = _orig_search
        _tools._parent_search_cache.clear()


def main():
    asyncio.run(test_search_cache_shared_main_then_explore())
    asyncio.run(test_search_cache_shared_across_sequential_explore())
    print("OK: parent search cache is shared across main agent and explore sub-agents")


if __name__ == "__main__":
    main()
