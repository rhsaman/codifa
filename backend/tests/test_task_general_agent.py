"""Live test: the `task` tool's `general` sub-agent (opencode's general agent).

The general agent inherits the parent's tools minus `task`/`update_plan`/
`save_plan` (no nested sub-agents, no checklist pollution — opencode's general
denies todowrite) and runs on the MAIN model. Its tool events are tagged
sub=True and routed to the task card via a branch id, so they never count
against the parent's deterministic tool-step budget.

Guards:
1. task(subagent_type='general') returns the <task> XML wrapper.
2. The general sub-agent runs on the MAIN model and can call parent tools (read).
3. Its tool events are tagged sub=True with a branch id.
4. The general sub-agent's tool set excludes task/update_plan/save_plan.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-task-general-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-task-general-ws-")
    with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
        fh.write("def main():\n    return 42\n")

    emitted: list[dict] = []
    # main_model drives the general sub-agent: it calls `read` then replies.
    main_model = TestModel(call_tools=["read"], custom_output_text="GENERAL DONE: app.py has main()")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        main_model=main_model,
    )
    task = tools["task"]

    report = await task(
        description="check app.py",
        prompt="Read app.py and summarize what it does.",
        subagent_type="general",
    )
    assert "<task" in report and "<task_result>" in report, f"unexpected report: {report[:300]}"
    assert "GENERAL DONE" in report, f"general sub-agent output missing: {report[:300]}"

    cards = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "general"
    ]
    assert len(cards) == 1, f"expected 1 general task card, got {len(cards)}"

    # The general sub-agent's read tool event must be tagged sub=True + branch.
    sub_reads = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "read" and e.get("sub")
    ]
    assert sub_reads, "general sub-agent's read event not tagged sub=True"
    assert sub_reads[0].get("branch"), "general sub-agent's read event missing branch id"

    print("  general task card: 1")
    print(f"  sub-tagged read events: {len(sub_reads)} (expect 1)")
    print("  general sub-agent OK: runs on main model, inherits parent tools, sub-tagged events")
    print("TASK-GENERAL TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())