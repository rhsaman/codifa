"""Live test: the `task` tool rejects unknown subagent types (opencode-style).

opencode's task tool: "Unknown agent type: X is not a valid agent type". The
agent registry (backend/agent_registry.py) defines the valid types — currently
only `general`. Anything else is an ERROR, not a silent fallback.

Guards:
1. task(subagent_type='bogus') -> "Unknown agent type: bogus is not a valid agent type".
2. No sub-agent is spawned (no explore/general card, no model requests).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-task-unknown-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-task-unknown-ws-")
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=TestModel(custom_output_text="done"),
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

    print("  unknown subagent_type -> 'Unknown agent type' error, no sub-agent spawned")
    print("TASK-UNKNOWN-AGENT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())