"""Live test: the `task` tool enforces the sub-agent depth limit.

opencode's subagent_depth (default 1): the parent can spawn a sub-agent, but a
sub-agent cannot spawn another. The general sub-agent's tools exclude `task`
so nesting is impossible in practice — this is a belt-and-suspenders guard on
the contextvar.

Guards:
1. With _TASK_DEPTH_CTX at the limit, task(...) returns the depth error.
2. The depth error is an ERROR, not a silent fallback.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-task-depth-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage

from tools import (
    _SUBAGENT_DEPTH_LIMIT,
    _TASK_DEPTH_CTX,
    make_tool_callbacks,
)


class _FakeModel:
    """Minimal LangChain-style model: returns a fixed reply (no tool calls)."""

    model_name = "fake"

    def __init__(self, text: str = "done") -> None:
        self._text = text

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        return AIMessage(content=self._text)


async def _run_task_depth_limit_cases() -> None:
    ws = tempfile.mkdtemp(prefix="coder-test-task-depth-ws-")
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=_FakeModel(text="done"),
    )
    task = tools["task"]

    # Simulate being inside a sub-agent: depth already at the limit.
    token = _TASK_DEPTH_CTX.set(_SUBAGENT_DEPTH_LIMIT)
    try:
        out = await task(description="x", prompt="find foo", subagent_type="general")
    finally:
        _TASK_DEPTH_CTX.reset(token)

    assert "subagent depth limit reached" in out, out
    assert "cannot spawn another sub-agent" in out, out

    cards = [e for e in emitted if e.get("kind") == "tool" and e.get("tool") == "task"]
    assert len(cards) == 1, f"expected 1 task card (the error), got {len(cards)}"

    print(f"  depth limit ({_SUBAGENT_DEPTH_LIMIT}) enforced: nested task denied")
    print("TASK-DEPTH-LIMIT TEST PASSED")


async def test_task_depth_limit() -> None:
    """Same coverage as the legacy ``main()``; exposed as a pytest test so
    ``pytest tests/`` actually collects and runs it.
    """
    await _run_task_depth_limit_cases()


def main() -> None:
    asyncio.run(_run_task_depth_limit_cases())


if __name__ == "__main__":
    main()