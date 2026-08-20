"""Live test: TWO concurrent task calls (subagent_type='explore') with
DIFFERENT prompts both run, each with its own uniquely-id'd card (no shared
branch ids, no cross-nesting).

The parent can issue multiple task calls in ONE response (parallel tool
calls). Each call gets its own globally-unique call id (`_ecall`) stamped on
its card AND its sub-events, so the frontend never nests call #2's sub-events
into call #1's still-running card ("all parallel explores show the same
sub-searches").

Guards:
1. 2 concurrent explore task calls (different prompts) -> 2 cards, both reports.
2. Card branch ids are globally unique.
3. Sub-events carry their own call's branch id.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-explore2-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


def _explore_cards(emitted: list[dict]) -> list[dict]:
    return [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-parallel-explore2-ws-")
    for name in ("app.py", "lib.py", "util.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    emitted: list[dict] = []
    explore_model = TestModel(call_tools=["grep"], custom_output_text="REPORT: found")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    # Two explore task calls with DIFFERENT prompts run CONCURRENTLY (as the
    # parent would issue them in one parallel-tool-calls response). Distinct
    # prompts must NOT be deduped — both run.
    reports = await asyncio.gather(
        task(description="find app logic", prompt="find app logic", subagent_type="explore"),
        task(description="find config", prompt="find config loading", subagent_type="explore"),
    )
    assert all("<task" in r and "<task_result>" in r for r in reports), reports

    cards = _explore_cards(emitted)
    sub_tools = [e for e in emitted if e.get("kind") == "tool" and e.get("sub")]

    card_branches = [e.get("branch") for e in cards]
    sub_branches = [e.get("branch") for e in sub_tools]

    print(f"  explore cards: {len(cards)} (expect 2: distinct tasks both run)")
    print(f"  card branch ids: {card_branches}")
    print(f"  sub branch ids:   {sub_branches}")

    # 1. Both distinct calls run (no over-dedup).
    assert len(cards) == 2, f"expected 2 cards (different tasks), got {len(cards)}"

    # 2. Branch ids are globally unique across both calls.
    assert len(card_branches) == len(set(card_branches)), \
        f"DUPLICATE branch ids across parallel explore calls: {card_branches}"

    # 3. Each call's sub-events carry one of the call cards' branch ids.
    assert set(sub_branches) <= set(card_branches), \
        f"sub branch ids {sub_branches} not a subset of card branch ids {card_branches}"

    print("  parallel-explore-calls OK: 2 concurrent distinct calls, unique ids")
    print("PARALLEL-EXPLORE-CALLS TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
