"""Live test: the agentic tool-loop detects and stops a repetition loop.

Some models fall into a degenerate loop where they emit the SAME text on every
step -- often while calling a DIFFERENT tool each time (e.g. reading a new
file). Without a guard the backend streams that one sentence dozens of times
(the user sees a "message that repeats itself"). The repetition-loop guard in
graph._inner must stop after a few identical text steps and emit a single
friendly error event instead of looping up to MAX_STEPS.

Guards:
1. A model that emits byte-identical TEXT every step (even with DIFFERENT tool
   calls each time) is stopped and a "repetition loop" error event is emitted.
2. The number of streamed text events stays bounded (the loop does NOT run to
   MAX_STEPS), so the frontend never receives dozens of duplicated sentences.
3. A normal text-only reply (no tool calls) is NOT flagged as a loop.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-loop-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402

import graph as _graph  # noqa: E402


class _LoopModel:
    """LangChain-style model that emits the SAME text every step but a
    DIFFERENT tool call each time -- the exact variant that slipped past the
    old text+tool guard (the model keeps saying the same sentence while reading
    a new file on every step)."""

    model_name = "fake-loop"

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        # Count prior AI steps so each tool call is unique (different file),
        # but the emitted TEXT is byte-identical every step.
        n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
        yield AIMessage(
            content=(
                "بگذارم ببینم finally واقعاً isThinking را ریست می‌کند یا نه، "
                "و CSS چطور انیمیشن را کنترل می‌کند."
            ),
            tool_calls=[
                {"name": "read", "args": {"path": f"f{n}.py"}, "id": f"call_{n}"}
            ],
        )


class _TextOnlyModel:
    """LangChain-style model that returns a plain reply (no tool calls)."""

    model_name = "fake-text"

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        yield AIMessage(content="here is the answer")


async def _fake_build_turn_context(state, queue, model):
    """Stand-in for graph.build_turn_context: no provider / RAG / real tools."""

    def _fake_tool(**kwargs):
        return "ok"

    return {
        "model": model,
        "messages": [HumanMessage(content="hi")],
        "tools": {"task": _fake_tool},
        "lc_tools": [],
        "compact_model": None,
    }


async def _run_with(model, state):
    queue: asyncio.Queue = asyncio.Queue()
    orig = _graph.build_turn_context
    _graph.build_turn_context = lambda s, q: _fake_build_turn_context(s, q, model)
    try:
        await _graph._run_mode_turn(state, "ask", queue)
    finally:
        _graph.build_turn_context = orig
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def main():
    state = {
        "chat_id": "loop-test",
        "context_window": 0,
        "model_name": "fake",
        "mode": "ask",
        "request": "x",
    }

    # --- Case 1: repetition loop must be detected and stopped. ----------------
    loop_events = await _run_with(_LoopModel(), state)
    errors = [e for e in loop_events if e.get("kind") == "error"]
    assert errors, "expected a repetition-loop error event"
    assert "repetition loop" in errors[0].get("content", ""), errors[0]
    text_events = [e for e in loop_events if e.get("kind") == "text"]
    # Bounded: the guard trips after _MAX_REPEAT identical steps, NOT at MAX_STEPS.
    assert len(text_events) <= 10, f"too many duplicated text events: {len(text_events)}"
    print(f"  repetition loop stopped after {len(text_events)} text events")

    # --- Case 2: a normal text-only reply is NOT flagged as a loop. -----------
    text_events = await _run_with(_TextOnlyModel(), state)
    errors = [e for e in text_events if e.get("kind") == "error"]
    assert not errors, f"text-only reply wrongly flagged as a loop: {errors}"
    print("  text-only reply not flagged as a loop")

    print("LOOP-DETECTION TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
