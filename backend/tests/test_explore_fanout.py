"""Live test: the CODE decides to parallelize a broad explore — ONE
task(explore) call is split into N genuinely-different sub-questions and run
as N CONCURRENT sub-agents (asyncio.gather), then merged into ONE report.

This is the deterministic fix for "explore doesn't parallelize": the main
model never has to decide to batch explore calls (its batching is unreliable —
it often fires one explore per turn). A single broad task(explore) call fans
out internally, so "search the whole project" is N-way parallel no matter what
the main model fires. Narrow/quick lookups stay single (the split round-trip
would cost more than it saves).

Guards:
1. ONE broad task(explore) call -> exactly 1 explore card (fan-out is internal).
2. The code splits it into 3 sub-questions -> 3 branch sub-events with
   distinct branch ids (fan-out happened).
3. The merged task result (sent back to the parent) contains all 3 reports.
4. A narrow lookup does NOT fan out (single branch, no split round-trip).
"""
import asyncio
import json
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-fanout-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agents import run_agent  # noqa: E402
from mock_openai import mock, start_server, stop_server, text_reply, tool_call  # noqa: E402


def _explore_cards(events: list[dict]) -> list[dict]:
    return [
        e for e in events
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]


def _task_results(events: list[dict]) -> list[dict]:
    return [
        e for e in events
        if e.get("kind") == "tool_result" and e.get("tool") == "task"
    ]


async def _run_case(ws: str, base: str, prompt: str, script: list, chat_id: str) -> list[dict]:
    mock.script = script
    mock.captured = []
    events: list[dict] = []
    async for ev in run_agent(
        provider="custom",
        model_name="mock-model",
        base_url=base,
        api_key="test",
        root=ws,
        mode="coder",
        prompt=prompt,
        history=[],
        chat_id=chat_id,
    ):
        events.append(ev)
    return events


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-explore-fanout-ws-")
    for name in ("app.py", "lib.py", "config.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    server_task, base = await start_server()
    try:
        # ---- Case 1: ONE broad explore call -> code fans out into 3 ----
        events = await _run_case(
            ws, base,
            prompt="map the whole project",
            chat_id="pytest-fanout-broad",
            script=[
                # Main response: ONE broad explore call (the code fans it out).
                tool_call("task", json.dumps({
                    "description": "map the project",
                    "prompt": (
                        "search the whole project for app logic, config loading "
                        "and routing — map out every file involved"
                    ),
                    "subagent_type": "explore",
                })),
                # Split request (sub-agent model, no tools): 3 sub-questions.
                text_reply(
                    "find where app logic lives\n"
                    "find how config is loaded\n"
                    "find all routing setup"
                ),
                # Three parallel branch sub-agents (concurrent, order free).
                text_reply("REPORT A: app.py:1 — app logic entry"),
                text_reply("REPORT B: lib.py:1 — config loader"),
                text_reply("REPORT C: config.py:1 — routing table"),
                # Main final reply.
                text_reply("Done. Explored all three areas."),
            ],
        )

        cards = _explore_cards(events)
        results = _task_results(events)
        sub_branches = sorted({
            e.get("branch") for e in events
            if e.get("sub") and e.get("branch") is not None
        })
        captured_text = json.dumps(mock.captured)

        print(f"  [broad] explore cards: {len(cards)} (expect 1)")
        print(f"  [broad] sub branch ids: {sub_branches} (expect 3 distinct)")
        print(f"  [broad] task results:  {len(results)} (expect 1 merged)")

        # 1. ONE broad call -> ONE card (fan-out is internal, not more cards).
        assert len(cards) == 1, f"expected 1 explore card, got {len(cards)}"
        assert len(results) == 1, f"expected 1 merged task result, got {len(results)}"

        # 2. The code split it into 3 parallel branches (distinct branch ids).
        assert len(sub_branches) == 3, \
            f"expected 3 fan-out branches, got {sub_branches}"

        # 3. The merged report (sent back to the parent) carries all 3 reports.
        for marker in ("REPORT A", "REPORT B", "REPORT C"):
            assert marker in captured_text, \
                f"merged report missing {marker!r}"

        # ---- Case 2: narrow lookup -> NO fan-out (single branch) ----
        events = await _run_case(
            ws, base,
            prompt="find foo",
            chat_id="pytest-fanout-narrow",
            script=[
                tool_call("task", json.dumps({
                    "description": "find foo",
                    "prompt": "find where foo is defined",
                    "subagent_type": "explore",
                })),
                text_reply("REPORT: found at app.py:1"),
                text_reply("Done."),
            ],
        )

        cards = _explore_cards(events)
        results = _task_results(events)
        sub_branches = sorted({
            e.get("branch") for e in events
            if e.get("sub") and e.get("branch") is not None
        })
        captured_text = json.dumps(mock.captured)

        print(f"  [narrow] explore cards: {len(cards)} (expect 1)")
        print(f"  [narrow] sub branch ids: {sub_branches} (expect 1, no fan-out)")

        assert len(cards) == 1, f"expected 1 explore card, got {len(cards)}"
        assert len(results) == 1, f"expected 1 task result, got {len(results)}"
        # Single branch: exactly one sub-event, on the card's own branch id
        # (no split round-trip, no extra branches).
        assert len(sub_branches) == 1, \
            f"narrow lookup should NOT fan out, got branches {sub_branches}"
        assert "REPORT: found at app.py:1" in captured_text, \
            "narrow explore report missing"

        print("  explore-fanout OK: broad -> 3 parallel branches, narrow -> single")
        print("EXPLORE-FANOUT TEST PASSED")
    finally:
        await stop_server(server_task)


if __name__ == "__main__":
    asyncio.run(main())