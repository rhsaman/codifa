"""Live test: N concurrent task calls (subagent_type='explore') with the SAME
prompt collapse into ONE sub-agent run (call-level dedup via
`_explore_inflight`) — no duplicate sub-agents, no duplicate searches, no
duplicate reads.

The user-reported symptom (recurring): "بازم چند تا اکسپلور با ساب ایجنت های
مثل هم درست کرد" — the parent issued N explore tool calls in one
parallel-tool-calls response with the same area (rephrased), and each used to
spawn its own sub-agent that re-searched the same area from scratch.

Fix: turn-level dedup of explore task CALLS — the first call runs and registers
itself in `_explore_inflight`; the other N-1 calls match it (Dice >= 0.8 on
the prompt text) and await its report instead of spawning their own sub-agent.

Guards:
1. 5 concurrent same-prompt explore calls -> exactly 1 task card.
2. 1 grep total (the deduped calls spawn no sub-agent).
3. All 5 reports contain the shared report text.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-explore-share-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-parallel-explore-share-ws-")
    for name in ("app.go", "lib.go", "util.go"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"package x\n\nfunc {name.split('.')[0]}() {{\n    return 1\n}}\n")

    emitted: list[dict] = []
    explore_model = TestModel(call_tools=["grep"], custom_output_text="REPORT: found")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    # 5 explore task calls run CONCURRENTLY (as the parent would issue them in
    # one parallel-tool-calls response), all with the SAME prompt.
    reports = await asyncio.gather(
        *[task(description="find app logic", prompt="find app logic", subagent_type="explore") for _ in range(5)]
    )
    assert all("<task" in r and "<task_result>" in r for r in reports), reports[:3]

    cards = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]
    greps = [e for e in emitted if e.get("kind") == "tool_result" and e.get("tool") == "grep" and e.get("sub")]

    print(f"  task cards: {len(cards)} (expect 1 — call dedup)")
    print(f"  grep results: {len(greps)} (expect 1)")

    # THE BUG: 5 concurrent calls each spawned a sub-agent and re-ran the same
    # grep from scratch. With call-level dedup, only the FIRST call runs; the
    # other 4 await its report and return it.
    assert len(cards) == 1, (
        f"5 concurrent same-prompt explore calls spawned {len(cards)} cards "
        f"(expected 1 — the other 4 must reuse the first call's report)"
    )
    assert len(greps) == 1, f"expected 1 grep, got {len(greps)}"

    print("  parallel-explore-share OK: N concurrent same-task calls collapse to one sub-agent")
    print("PARALLEL-EXPLORE-SHARE TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
