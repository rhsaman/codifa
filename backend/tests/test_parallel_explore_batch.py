"""Live test: the parent model emits TWO task(explore) calls in ONE response
(parallel tool calls) and the backend runs them CONCURRENTLY — both explore
cards appear before either completes, and both reports come back.

This is the end-to-end proof of the "batch your explores" behavior: pydantic-ai
executes every tool call from a single model response as a concurrent asyncio
task, so firing N explores in one response is N-way parallel (and the explore
sub-agents' searches never touch the parent's context tokens).

Guards:
1. 2 task(explore) calls in ONE model response -> 2 explore cards.
2. Both cards are emitted BEFORE any task tool_result (concurrent start —
   a sequential run would emit card #2 only after result #1).
3. Both distinct reports come back (no over-dedup).
"""
import asyncio
import json
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-batch-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agents import run_agent  # noqa: E402
from mock_openai import MODEL, mock, start_server, stop_server, text_reply  # noqa: E402


def two_task_calls(call1: dict, call2: dict) -> list[dict]:
    """A single streaming response carrying TWO tool calls (index 0 and 1)."""
    return [
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0, "model": MODEL,
         "choices": [{"index": 0, "delta": {"tool_calls": [
             {"index": 0, "id": "call_1", "type": "function",
              "function": {"name": "task", "arguments": json.dumps(call1)}}
         ]}, "finish_reason": None}]},
        {"id": "c-2", "object": "chat.completion.chunk", "created": 0, "model": MODEL,
         "choices": [{"index": 0, "delta": {"tool_calls": [
             {"index": 1, "id": "call_2", "type": "function",
              "function": {"name": "task", "arguments": json.dumps(call2)}}
         ]}, "finish_reason": None}]},
        {"id": "c-3", "object": "chat.completion.chunk", "created": 0, "model": MODEL,
         "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
         "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}},
    ]


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-explore-batch-ws-")
    for name in ("app.py", "lib.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    server_task, base = await start_server()
    try:
        mock.script = [
            two_task_calls(
                {"description": "find app logic", "prompt": "find app logic", "subagent_type": "explore"},
                {"description": "find config", "prompt": "find config loading", "subagent_type": "explore"},
            ),
            text_reply("REPORT A: app.py:1"),
            text_reply("REPORT B: lib.py:1"),
            text_reply("Done. Both explorations complete."),
        ]

        events: list[dict] = []
        async for ev in run_agent(
            provider="custom",
            model_name="mock-model",
            base_url=base,
            api_key="test",
            root=ws,
            mode="coder",
            prompt="explore the workspace for app logic and config loading",
            history=[],
            chat_id="pytest-batch",
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
        text = "".join(e.get("content", "") for e in events if e.get("kind") == "text")

        print(f"  explore cards: {len(cards)} (expect 2)")
        print(f"  task results:  {len(results)} (expect 2)")
        print(f"  final text:    {text!r}")

        # 1. Both distinct explores ran (no over-dedup).
        assert len(cards) == 2, f"expected 2 explore cards, got {len(cards)}"
        assert len(results) == 2, f"expected 2 task results, got {len(results)}"

        # 2. CONCURRENCY: both cards were emitted before either result — i.e.
        #    both sub-agents STARTED together (pydantic-ai gathered the two
        #    tool calls from the single response). A sequential run would emit
        #    card #2 only after result #1.
        first_result_idx = next(
            i for i, e in enumerate(events)
            if e.get("kind") == "tool_result" and e.get("tool") == "task"
        )
        card_idxs = [
            i for i, e in enumerate(events)
            if e.get("kind") == "tool" and e.get("tool") == "task"
            and (e.get("args") or {}).get("subagent_type") == "explore"
        ]
        assert all(i < first_result_idx for i in card_idxs), (
            f"explore cards {card_idxs} not all before first result at {first_result_idx} — "
            "the two explores did NOT start concurrently"
        )

        # 3. The parent finished after both reports.
        assert "Done. Both explorations complete." in text, f"agent never finished: {text!r}"

        print("  explore-batch OK: 2 explores in ONE response ran concurrently")
        print("EXPLORE-BATCH TEST PASSED")
    finally:
        await stop_server(server_task)


if __name__ == "__main__":
    asyncio.run(main())