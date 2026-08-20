"""Live test: a single task call (subagent_type='explore') -> ONE sub-agent
card (like opencode), and its sub-agent events are routed to that card via its
unique call id (no fan-out branches, no branch-less events floating across
cards).

The old symptom ("all parallel explores have similar sub-searches") came from
multiple sibling sub-agents sharing branch-less events. The new architecture
runs ONE sub-agent per task call; every card and every sub-event carries
the call's unique id, so the frontend nests each call's sub-events only under
its own card.

Guards:
1. task(explore) -> exactly 1 task card.
2. The sub-agent's tool events/results carry the same branch id as the card.
3. Sub-events carry call_ids (FIFO-correlated to their results).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-explore-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-parallel-explore-ws-")
    for name in ("app.py", "lib.py", "util.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    emitted: list[dict] = []
    explore_model = TestModel(call_tools=["grep"], custom_output_text="REPORT: found in app.py")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    report = await task(description="find app logic", prompt="find where app logic lives", subagent_type="explore")
    assert "<task" in report and "<task_result>" in report, f"unexpected report: {report[:200]}"

    cards = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]
    sub_tools = [e for e in emitted if e.get("kind") == "tool" and e.get("sub")]
    sub_results = [e for e in emitted if e.get("kind") == "tool_result" and e.get("sub")]

    print(f"  task cards: {len(cards)} (expect 1)")
    print(f"  sub tool events: {len(sub_tools)} (expect 1: one grep)")
    print(f"  sub result events: {len(sub_results)} (expect 1)")

    # 1. Exactly ONE task card (one sub-agent per call, no fan-out).
    assert len(cards) == 1, f"expected 1 task card, got {len(cards)}"

    # 2. Every sub-event carries the task card's branch id (its call id) —
    #    the frontend routes sub-events to THIS card only.
    card_branch = cards[0].get("branch")
    assert isinstance(card_branch, int), f"task card has no branch id: {cards[0]}"
    for e in sub_tools + sub_results:
        assert e.get("branch") == card_branch, (
            f"sub-event branch {e.get('branch')} != card branch {card_branch}: {e}"
        )
        assert isinstance(e.get("call_id"), int), f"sub-event without call_id: {e}"

    # 3. The sub tool event and its result correlate via call_id (FIFO).
    assert len(sub_tools) == 1 and len(sub_results) == 1
    assert sub_tools[0]["call_id"] == sub_results[0]["call_id"], (
        f"sub tool/result call_id mismatch: {sub_tools[0]} vs {sub_results[0]}"
    )

    print("  single-subagent explore OK: 1 card, sub-events routed to it")
    print("PARALLEL-EXPLORE TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
