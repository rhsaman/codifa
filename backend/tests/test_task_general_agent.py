"""Live tests for the `task` tool: sub-agent, depth limit, unknown type.

Consolidates coverage from the former ``test_task_subagent_tool``,
``test_task_depth_limit`` and ``test_task_unknown_agent`` files.

Guards:
1. task(subagent_type='subagent') returns <task> XML, runs on MAIN model,
   tool events are tagged sub=True with a branch id.
2. task(subagent_type='bogus') returns "Unknown agent type" error.
3. With _TASK_DEPTH_CTX at the limit, task(...) returns the depth error.
"""
import os
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="coder-test-task-subagent-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from conftest import await_task_report
from langchain_core.messages import AIMessage

from tools import (
    _SUBAGENT_DEPTH_LIMIT,
    _TASK_DEPTH_CTX,
    make_tool_callbacks,
)

# ---------------------------------------------------------------------------
# Fake models
# ---------------------------------------------------------------------------

class _FakeModel:
    """Minimal LangChain-style model: returns a fixed reply (no tool calls)."""

    model_name = "fake"

    def __init__(self, text: str = "done") -> None:
        self._text = text

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        return AIMessage(content=self._text)


class _FakeSubagentModel:
    """LangChain-style fake: calls `read` once, then returns the reply."""

    model_name = "fake"

    def __init__(self, text: str = "done") -> None:
        self._text = text
        self._called = False

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        if not self._called:
            self._called = True
            return AIMessage(
                content="",
                tool_calls=[
                    {"name": "read", "args": {"filePath": "app.py"}, "id": "call_1"}
                ],
            )
        return AIMessage(content=self._text)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_task_subagent():
    """task(subagent_type='subagent') returns XML, runs on main model,
    tool events are tagged sub=True with a branch id."""
    ws = tempfile.mkdtemp(prefix="coder-test-task-subagent-ws-")
    Path(os.path.join(ws, "app.py")).write_text("def main():\n    return 42\n")

    emitted: list[dict] = []
    main_model = _FakeSubagentModel(text="SUBAGENT DONE: app.py has main()")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=main_model,
    )
    task = tools["task"]

    ack = await task(
        description="check app.py",
        prompt="Read app.py and summarize what it does.",
        subagent_type="subagent",
    )
    # Background dispatch: the report lands on the registry job, not the ack.
    report = await await_task_report(ack)
    assert "<task" in report and "<task_result>" in report, f"unexpected report: {report[:300]}"
    assert "SUBAGENT DONE" in report, f"sub-agent output missing: {report[:300]}"

    cards = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "subagent"
    ]
    assert len(cards) == 1, f"expected 1 subagent task card, got {len(cards)}"

    sub_reads = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "read" and e.get("sub")
    ]
    assert sub_reads, "sub-agent's read event not tagged sub=True"
    assert sub_reads[0].get("branch"), "sub-agent's read event missing branch id"


async def test_task_unknown_agent_type():
    """task(subagent_type='bogus') returns 'Unknown agent type' error."""
    ws = tempfile.mkdtemp(prefix="coder-test-task-unknown-ws-")
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=_FakeModel(text="done"),
    )
    task = tools["task"]

    out = await task(description="x", prompt="do something", subagent_type="bogus")
    assert "Unknown agent type: bogus is not a valid agent type" in out, out

    cards = [e for e in emitted if e.get("kind") == "tool" and e.get("tool") == "task"]
    assert len(cards) == 1, f"expected 1 task card (the error), got {len(cards)}"
    errs = [
        e for e in emitted
        if e.get("kind") == "tool_result" and e.get("status") == "error"
    ]
    assert errs, "expected an error tool_result"


async def test_task_depth_limit():
    """With depth at limit, task() returns the depth error."""
    ws = tempfile.mkdtemp(prefix="coder-test-task-depth-ws-")
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=_FakeModel(text="done"),
    )
    task = tools["task"]

    token = _TASK_DEPTH_CTX.set(_SUBAGENT_DEPTH_LIMIT)
    try:
        out = await task(description="x", prompt="find foo", subagent_type="subagent")
    finally:
        _TASK_DEPTH_CTX.reset(token)

    assert "subagent depth limit reached" in out, out
    assert "cannot spawn another sub-agent" in out, out

    cards = [e for e in emitted if e.get("kind") == "tool" and e.get("tool") == "task"]
    assert len(cards) == 1, f"expected 1 task card (the error), got {len(cards)}"