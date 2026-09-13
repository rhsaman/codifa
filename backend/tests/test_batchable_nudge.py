"""Unit tests: advisory batching nudge in both tool loops.

The model keeps firing one grep/glob/read per turn even though the tools
accept batch parameters (grep ``patterns=[...]``, read ``filePaths=[...]`` /
``ranges=[...]``). ``_batchable_nudge`` detects, per step, whether ≥2 calls
of the same batchable tool differ only in their primary argument (pattern /
filePath) — i.e. they could have been ONE call — and returns a reminder
that the loops append to the LAST tool result of that step.

Covers:
1. Two greps with different patterns, same path/include → nudge fires.
2. Two reads with different filePaths, same offset/limit → nudge fires.
3. A call that already passes patterns=[...] → NO nudge (already batching).
4. Two greps with DIFFERENT paths → NO nudge (merge would change scope).
5. Mixed tools (grep + read) → nudge mentions both.
6. Single call per tool → NO nudge.
7. End-to-end: the sub-agent loop appends the nudge to the LAST result only.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-batchnudge-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, ToolMessage

from llm import _batchable_nudge
from llm import langchain_tool_loop as _tool_loop

# ── pure detector tests ────────────────────────────────────────────────────

def test_two_greps_same_scope_nudge_fires():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "path": "src", "include": "*.ts"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "path": "src", "include": "*.ts"}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "patterns=[...]" in out


def test_two_reads_same_window_nudge_fires():
    tcs = [
        {"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 100}, "id": "a"},
        {"name": "read", "args": {"filePath": "b.py", "offset": 1, "limit": 100}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "filePaths=[...]" in out


def test_already_batched_call_no_nudge():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "patterns": ["beta"]}, "id": "a"},
        {"name": "grep", "args": {"pattern": "gamma", "patterns": ["delta"]}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_different_paths_no_nudge():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "path": "src"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "path": "backend"}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_mixed_tools_nudge_mentions_both():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta"}, "id": "b"},
        {"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 50}, "id": "c"},
        {"name": "read", "args": {"filePath": "b.py", "offset": 1, "limit": 50}, "id": "d"},
    ]
    out = _batchable_nudge(tcs)
    assert "grep" in out and "read" in out


def test_single_call_per_tool_no_nudge():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha"}, "id": "a"},
        {"name": "read", "args": {"filePath": "a.py"}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_empty_and_none_safe():
    assert _batchable_nudge([]) == ""
    assert _batchable_nudge(None) == ""


# ── end-to-end: sub-agent loop appends the nudge to the LAST result ────────

class _TwoGrepModel:
    """Step 1: two same-scope greps. Step 2: stop after seeing the nudge."""

    model_name = "fake-two-grep"

    def __init__(self):
        self._step = 0
        self.saw_nudge = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                self._model._step += 1
                for m in msgs:
                    if isinstance(m, ToolMessage) and "BATCHING REMINDER" in str(
                        getattr(m, "content", "")
                    ):
                        self._model.saw_nudge = True
                if self._model._step == 1:
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {"name": "grep", "args": {"pattern": "alpha"}, "id": "c1"},
                            {"name": "grep", "args": {"pattern": "beta"}, "id": "c2"},
                        ],
                    )
                return AIMessage(content="done")

        return _Bound(self)


def _make_tools():
    async def grep(**kwargs):
        return "no matches"

    return {"grep": grep}


def test_loop_appends_nudge_to_last_result():
    model = _TwoGrepModel()
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="find alpha and beta",
            tools=_make_tools(),
            max_steps=5,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_nudge, "the nudge must reach the model via the last ToolMessage"


if __name__ == "__main__":
    test_two_greps_same_scope_nudge_fires()
    print("  ✅ two greps same scope")
    test_two_reads_same_window_nudge_fires()
    print("  ✅ two reads same window")
    test_already_batched_call_no_nudge()
    print("  ✅ already batched → no nudge")
    test_different_paths_no_nudge()
    print("  ✅ different paths → no nudge")
    test_mixed_tools_nudge_mentions_both()
    print("  ✅ mixed tools")
    test_single_call_per_tool_no_nudge()
    print("  ✅ single call per tool")
    test_empty_and_none_safe()
    print("  ✅ empty/None safe")
    test_loop_appends_nudge_to_last_result()
    print("  ✅ loop appends nudge to last result")
    print("\n🎉 همه تست‌های batching nudge رد شد")
