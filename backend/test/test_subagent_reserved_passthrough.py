"""Unit test: sub-agent loop receives the main auto-compact ``reserved`` budget.

Regression guard for the bug where ``_run_subagent_task`` hard-coded
``reserved=20_000`` instead of using the user's auto-compact setting
(``state["reserved"]``). After the fix, ``make_tool_callbacks`` accepts a
``reserved`` parameter and forwards it to ``langchain_tool_loop`` so the
sub-agent (explore/general) auto-compacts with the same budget the user
configured for the main agent — no quality/speed change, just consistent
token accounting.

Covers:
- ``make_tool_callbacks(..., reserved=X)`` makes the sub-agent loop receive ``X``.
- Default (no ``reserved``) still falls back to 20_000.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subreserved-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage

import llm as _llm
from tools import make_tool_callbacks


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


async def _run_with_reserved(reserved):
    captured = {}

    async def fake_loop(*a, **k):
        captured["reserved"] = k.get("reserved")
        return "sub-result"

    _orig = _llm.langchain_tool_loop
    _llm.langchain_tool_loop = fake_loop
    try:
        cbs = make_tool_callbacks(
            root=os.getcwd(),
            emit=lambda ev: None,
            context_window=0,
            main_model=_RecordingModel(),
            reserved=reserved,
        )
        await cbs["task"](
            description="find the config",
            prompt="find the config",
            subagent_type="explore",
        )
    finally:
        _llm.langchain_tool_loop = _orig
    return captured.get("reserved")


async def test_reserved_passthrough_explicit():
    assert await _run_with_reserved(12_000) == 12_000


async def test_reserved_passthrough_default():
    assert await _run_with_reserved(None) == 20_000


def main():
    asyncio.run(test_reserved_passthrough_explicit())
    asyncio.run(test_reserved_passthrough_default())
    print("OK: sub-agent reserved budget passes through from make_tool_callbacks")


if __name__ == "__main__":
    main()
