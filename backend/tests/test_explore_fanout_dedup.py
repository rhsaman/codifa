"""Live test: the parallel explore fan-out does NOT produce duplicate
sub-searches across branches.

The fan-out splits ONE broad explore call into N parallel sub-agents. The
protection against duplicate work is the SPLIT FILTER: sub-questions that are
near-duplicates (>=0.8 similar — the same containment metric the parent-level
explore dedup uses) are dropped, so each branch searches a genuinely different
area. On top of that, per-branch search dedup stops a branch repeating ITSELF,
and the shared turn-level digest + listings stop branches re-reading files.

Guards:
1. A split that returns 2 near-identical + 1 distinct sub-question -> only
   2 branches run (the near-duplicate is filtered out at the source).
2. The similarity metric itself: the near-duplicate pair scores >=0.8, the
   distinct pair scores <0.8.
"""
import asyncio
import json
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-fanout-dedup-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agents import run_agent  # noqa: E402
from mock_openai import mock, start_server, stop_server, text_reply, tool_call  # noqa: E402
from tools import _explore_task_similar  # noqa: E402


async def main():
    # 0. The similarity metric itself: near-duplicate pair >= 0.8, distinct < 0.8.
    assert _explore_task_similar(
        "find where app logic lives", "find where app logic is defined"
    ) >= 0.8, "near-duplicate sub-questions must score >= 0.8"
    assert _explore_task_similar(
        "find where app logic lives", "find how config is loaded"
    ) < 0.8, "genuinely different sub-questions must score < 0.8"

    ws = tempfile.mkdtemp(prefix="coder-test-explore-fanout-dedup-ws-")
    for name in ("app.py", "config.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    server_task, base = await start_server()
    try:
        mock.script = [
            # 1. Main response: ONE broad explore call (the code fans it out).
            tool_call("task", json.dumps({
                "description": "map the project",
                "prompt": "search the whole project for app logic, config loading and routing — map out every file involved",
                "subagent_type": "explore",
            })),
            # 2. Split reply: TWO near-identical sub-questions + ONE distinct.
            #    The near-duplicate must be filtered -> only 2 branches run.
            text_reply(
                "find where app logic lives\n"
                "find where app logic is defined\n"
                "find how config is loaded"
            ),
            # 3-4. The two surviving branches (concurrent, order free).
            text_reply("REPORT A: app.py:1 — app logic entry"),
            text_reply("REPORT C: config.py:1 — config loader"),
            # 5. Main final reply.
            text_reply("Done. Explored the distinct areas."),
        ]

        events: list[dict] = []
        async for ev in run_agent(
            provider="custom",
            model_name="mock-model",
            base_url=base,
            api_key="test",
            root=ws,
            mode="coder",
            prompt="map the whole project",
            chat_id="pytest-fanout-dedup",
            history=[],
        ):
            events.append(ev)

        cards = [
            e for e in events
            if e.get("kind") == "tool" and e.get("tool") == "task"
            and (e.get("args") or {}).get("subagent_type") == "explore"
        ]
        results = [
            e for e in events
            if e.get("kind") == "tool_result" and e.get("tool") == "task"
        ]
        sub_branches = sorted({
            e.get("branch") for e in events
            if e.get("sub") and e.get("branch") is not None
        })
        captured = json.dumps(mock.captured)

        print(f"  explore cards: {len(cards)} (expect 1)")
        print(f"  fan-out branches: {sub_branches} (expect 2 — near-duplicate dropped)")
        print(f"  task results:  {len(results)} (expect 1 merged report)")

        assert len(cards) == 1, f"expected 1 explore card, got {len(cards)}"
        assert len(results) == 1, f"expected 1 merged task result, got {len(results)}"
        # The near-duplicate sub-question was filtered -> exactly 2 branches.
        assert len(sub_branches) == 2, (
            f"expected 2 fan-out branches (near-duplicate dropped), got {sub_branches}"
        )
        # Both surviving branches' reports made it into the merged result.
        assert "REPORT A" in captured, "merged report missing branch 1 report"
        assert "REPORT C" in captured, "merged report missing branch 2 report"
        # The near-duplicate branch's report must NOT be there.
        assert "REPORT B" not in captured, "near-duplicate branch should not have run"

        print("  explore-fanout-dedup OK: near-duplicate sub-search filtered at the source")
        print("EXPLORE-FANOUT-DEDUP TEST PASSED")
    finally:
        await stop_server(server_task)


if __name__ == "__main__":
    asyncio.run(main())