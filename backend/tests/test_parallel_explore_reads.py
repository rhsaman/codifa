"""Live test: concurrent task calls (subagent_type='explore') with the SAME
prompt are deduped at the CALL level — only the first spawns a sub-agent, the
rest reuse its report (no duplicate sub-agent, no duplicate reads).

The old symptom: 4 parallel explore cards with different tasks but EVERY card
re-showing the same 4 read sub-searches — every branch re-read the same files
from scratch. The new architecture removes sibling fan-out entirely (one
sub-agent per call, like opencode) AND dedups near-identical explore calls, so
a repeated task never re-reads files.

Guards:
1. 2 concurrent explore task calls, same prompt -> 1 task card only.
2. Only 1 fresh read happens (the deduped call spawns no sub-agent).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-explore-reads-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-parallel-explore-reads-ws-")
    for name in ("a.go", "b.go", "c.go", "d.go"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"package x\n\nfunc {name.split('.')[0]}() {{\n    return 1\n}}\n")

    emitted: list[dict] = []
    explore_model = TestModel(call_tools=["read"], custom_output_text="REPORT: read done")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    # Two CONCURRENT explore task calls with the SAME prompt → call-level dedup:
    # only the first spawns a sub-agent, the second awaits/reuses its report.
    reports = await asyncio.gather(
        task(description="show a.go", prompt="show me a.go", subagent_type="explore"),
        task(description="show a.go", prompt="show me a.go", subagent_type="explore"),
    )
    assert all("<task" in r and "<task_result>" in r for r in reports), reports[:2]

    cards = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]
    read_tools = [e for e in emitted if e.get("kind") == "tool" and e.get("tool") == "read" and e.get("sub")]
    read_results = [e for e in emitted if e.get("kind") == "tool_result" and e.get("tool") == "read" and e.get("sub")]
    fresh = [e for e in read_results if e.get("summary") == "read"]

    print(f"  task cards: {len(cards)} (expect 1 — call dedup)")
    print(f"  read tool events: {len(read_tools)} (expect 1)")
    print(f"  fresh reads: {len(fresh)} (expect 1)")

    assert len(cards) == 1, (
        f"concurrent same-prompt explore calls spawned {len(cards)} cards (expected 1 — "
        f"the second call must reuse the first's report)"
    )
    assert len(read_tools) == 1, f"expected 1 read tool event, got {len(read_tools)}"
    assert len(fresh) == 1, f"expected 1 fresh read, got {len(fresh)}"

    print("  parallel-explore-reads OK: same-task concurrent calls deduped, no duplicate reads")
    print("PARALLEL-EXPLORE-READS TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
