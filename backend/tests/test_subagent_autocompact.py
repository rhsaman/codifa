"""Unit tests: sub-agent loop auto-compacts its isolated context instead of failing.

Regression guard for the bug where a sub-agent (explore/general) that reads many
large files overflows its isolated context window and the whole task fails with
"context_length_exceeded" / "sub-agent failed". After the fix, ``langchain_tool_loop``
reclaims the sub-agent's transcript mid-run via ``_auto_compact_subagent`` (mirroring
graph._maybe_auto_compact) whenever a ``ctx`` budget is supplied.

Covers:
- ``_auto_compact_subagent`` compacts an over-budget transcript in place.
- ``langchain_tool_loop`` with ``ctx`` set survives a model that keeps reading
  large files (no context overflow) and still returns a result.
- ``task`` tool with ``context_window`` set hands the budget to the sub-agent loop
  so it auto-compacts instead of failing.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subauto-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
)

import agents as _agents
import llm as _llm
from tools import make_tool_callbacks


async def test_auto_compact_subagent_compacts_in_place():
    """When the transcript exceeds the usable window, the message list is
    rebuilt smaller (summary + recent tail) in place."""
    big = [SystemMessage(content="sys")]
    big += [
        HumanMessage(content="x" * 50_000),
        AIMessage(content="y" * 50_000),
    ] * 6

    async def fake_compact(*a, **k):
        return (
            [
                {"role": "system", "content": "sys"},
                {"role": "assistant", "content": "[Compacted earlier context] SUMMARY"},
                {"role": "user", "content": "recent tail kept verbatim"},
            ],
            1,
            None,
        )

    original = _llm._compact_history
    _llm._compact_history = fake_compact
    try:
        did = await _llm._auto_compact_subagent(big, None, ctx=4_000, reserved=20_000)
    finally:
        _llm._compact_history = original

    assert did is True
    # The system message is preserved; the rest is the compacted history.
    assert isinstance(big[0], SystemMessage)
    # Compacted list is much smaller than the 12-message original.
    assert len(big) < 12
    joined = " ".join(str(getattr(m, "content", "")) for m in big)
    assert "Compacted earlier context" in joined


async def test_auto_compact_subagent_noop_below_budget():
    """Below the usable window, nothing is compacted and the list is untouched."""
    small = [
        SystemMessage(content="sys"),
        HumanMessage(content="hi"),
        AIMessage(content="hello"),
    ]
    called = {"n": 0}

    async def fake_compact(*a, **k):
        called["n"] += 1

    original = _llm._compact_history
    _llm._compact_history = fake_compact
    try:
        did = await _llm._auto_compact_subagent(small, None, ctx=200_000, reserved=20_000)
    finally:
        _llm._compact_history = original

    assert did is False
    assert called["n"] == 0
    assert len(small) == 3


class _ReadHeavyModel:
    """Model that reads a large file on EVERY step, then finally replies text.

    Without auto-compact this would overflow the sub-agent's context window;
    with ``ctx`` set the loop compacts the transcript and still returns.
    """

    model_name = "fake-read-heavy"

    def __init__(self, steps: int = 4, reply: str = "done reading"):
        self._steps = steps
        self._n = 0
        self._reply = reply

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        self._n += 1
        if self._n <= self._steps:
            # Vary the path per step so the doom-loop guard (same name+args 3x
            # in a row) does not abort the loop before the final reply — we want
            # to exercise repeated large reads + mid-run compaction, not the
            # repeated-call stopper.
            return AIMessage(
                content="",
                tool_calls=[
                    {"name": "read", "args": {"filePath": f"big{self._n}.txt"}, "id": f"c{self._n}"}
                ],
            )
        return AIMessage(content=self._reply)


async def test_langchain_tool_loop_autocompacts_with_ctx():
    """With ctx set, a model that repeatedly reads large files does not fail and
    returns its final reply (the transcript is reclaimed mid-run)."""
    ws = tempfile.mkdtemp(prefix="coder-test-subauto-ws-")
    with open(os.path.join(ws, "big.txt"), "w") as fh:  # noqa: ASYNC230
        fh.write("line\n" * 4_000)  # ~40KB, exceeds the 50KB read excerpt cap? keep small

    async def fake_read(filePath: str = "", **kw):
        # Return a chunk large enough that several reads overflow a tiny ctx.
        return "data " * 2_000

    async def fake_compact(*a, **k):
        # Collapse to a short summary so the loop can keep going.
        return (
            [
                {"role": "system", "content": "sys"},
                {"role": "assistant", "content": "[compacted] summary"},
                {"role": "user", "content": "recent"},
            ],
            1,
            None,
        )

    model = _ReadHeavyModel(steps=4, reply="FINISHED")
    original = _llm._compact_history
    _llm._compact_history = fake_compact
    try:
        out = await _llm.langchain_tool_loop(
            model,
            system="you are explore",
            user="read big.txt repeatedly",
            tools={"read": fake_read},
            max_steps=10,
            ctx=4_000,
            compact_model=model,
            reserved=20_000,
        )
    finally:
        _llm._compact_history = original

    assert out.strip(), f"sub-agent returned empty result: {out!r}"
    assert "FINISHED" in out, out


async def test_task_tool_passes_context_window_to_subagent():
    """The task tool forwards context_window to the sub-agent loop so it can
    auto-compact. We assert the sub-agent still completes (no 'sub-agent failed')."""
    ws = tempfile.mkdtemp(prefix="coder-test-subauto-task-")
    with open(os.path.join(ws, "big.txt"), "w") as fh:  # noqa: ASYNC230
        fh.write("line\n" * 4_000)

    class _ReadThenReplyModel:
        model_name = "fake-task"

        def __init__(self):
            self._n = 0

        def bind_tools(self, tools):
            return self

        async def ainvoke(self, msgs):
            self._n += 1
            if self._n == 1:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "read", "args": {"filePath": "big.txt"}, "id": "r1"}
                    ],
                )
            return AIMessage(content="TASK RESULT OK")

    async def fake_read(filePath: str = "", **kw):
        return "data " * 2_000

    async def fake_compact(*a, **k):
        return (
            [
                {"role": "system", "content": "sys"},
                {"role": "assistant", "content": "[compacted] summary"},
                {"role": "user", "content": "recent"},
            ],
            1,
            None,
        )

    model = _ReadThenReplyModel()
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=model,
        context_window=4_000,
    )
    # Patch the read tool used by the sub-agent so it returns a large chunk.
    _orig_read = tools.get("read")
    if _orig_read is not None:
        async def _patched_read(filePath: str = "", **kw):
            return "data " * 2_000

        tools["read"] = _patched_read

    original = _llm._compact_history
    _llm._compact_history = fake_compact
    try:
        report = await tools["task"](
            description="read big.txt",
            prompt="Read big.txt and report what it contains.",
            subagent_type="general",
        )
    finally:
        _agents._compact_history = original

    assert "sub-agent failed" not in report, f"sub-agent failed: {report[:300]}"
    assert "TASK RESULT OK" in report, f"unexpected report: {report[:300]}"


if __name__ == "__main__":
    asyncio.run(test_auto_compact_subagent_compacts_in_place())
    asyncio.run(test_auto_compact_subagent_noop_below_budget())
    asyncio.run(test_langchain_tool_loop_autocompacts_with_ctx())
    asyncio.run(test_task_tool_passes_context_window_to_subagent())
    print("SUBAGENT AUTOCOMPACT TESTS PASSED")
