"""Mid-loop cheap step routing (laya step_route) — no real model, no UI.

Proves:
1. ``_prev_step_tool_summary`` only recognizes a tool-result tail.
2. Step 1 always runs on the main model (the gate is consulted from step 2).
3. When the gate says ``cheap_step``, the step model runs the follow-up step
   and the usage/trace rows name the step model.
4. A failing step model escalates that step to the main model and cheap
   routing stays off for the rest of the turn.
5. An empty cheap step escalates the same way.
6. ``big_model`` / abstained gate results keep the main model.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-steproute-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

import graph as _graph
import laya_decide
import trace_store

# ── fake models ───────────────────────────────────────────────────────────


class _MainModel:
    """Main model: call 1 = one tool call, call 2 = final text."""

    model_name = "fake-main"

    def __init__(self):
        self.calls = 0

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        self.calls += 1
        if self.calls == 1:
            yield AIMessage(
                content="opening the page",
                tool_calls=[{"name": "read", "args": {"path": "a.py"}, "id": "m1"}],
            )
        else:
            yield AIMessage(content="main finish")


class _StepModel:
    """Small step model with a scripted stream."""

    model_name = "fake-step"

    def __init__(self, chunks):
        self.calls = 0
        self._chunks = chunks

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        self.calls += 1
        for chunk in self._chunks:
            yield chunk


class _ExplodingStepModel:
    """Async generator that fails the way a broken provider does."""

    model_name = "fake-step-broken"

    def __init__(self):
        self.calls = 0

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        self.calls += 1
        raise RuntimeError("step model context overflow")
        yield AIMessage(content="")  # pragma: no cover — makes this a generator


# ── harness ───────────────────────────────────────────────────────────────


def _handled(value):
    return laya_decide.LayaDecision(
        handled=True, kind="choice", value=value, confidence=0.9,
        abstained=False, reason="local-decision",
    )


def _abstained():
    return laya_decide.LayaDecision(
        handled=False, kind="choice", value=None, confidence=0.0,
        abstained=True, reason="abstained",
    )


def _tctx(main, step):
    def _tool(**kwargs):
        return "ok"

    return {
        "model": main,
        "messages": [HumanMessage(content="hi")],
        "tools": {"read": _tool},
        "lc_tools": [],
        "compact_model": None,
        "step_model": step,
    }


async def _run(main, step, gate_value):
    """Run one ask turn; ``gate_value`` ("cheap_step"/"big_model"/None)
    is what the REAL laya_decide.step_route's choice() returns."""
    queue: asyncio.Queue = asyncio.Queue()
    seen_gate: dict = {}
    orig_ctx = _graph.build_turn_context
    orig_choice = laya_decide.choice

    def _fake_choice(state, options, threshold=0.65, provider_id="", timeout=4.0):
        seen_gate["state"] = dict(state)
        seen_gate["timeout"] = timeout
        return _handled(gate_value) if gate_value else _abstained()

    async def _fake_ctx(s, q):
        return _tctx(main, step)

    laya_decide.choice = _fake_choice
    _graph.build_turn_context = _fake_ctx
    try:
        reply = await _graph._run_mode_turn(
            {
                "chat_id": "steproute-test",
                "context_window": 0,
                "model_name": "fake-main",
                "mode": "ask",
                "request": "do the thing",
            },
            "ask",
            queue,
        )
    finally:
        _graph.build_turn_context = orig_ctx
        laya_decide.choice = orig_choice
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return reply, events, seen_gate


# ── unit: tail detection ──────────────────────────────────────────────────


def test_prev_step_tool_summary_variants():
    assert _graph._prev_step_tool_summary([]) is None
    assert _graph._prev_step_tool_summary([HumanMessage(content="hi")]) is None
    # Tool-result tail: names joined from the driving AIMessage.
    tool_tail = [
        AIMessage(
            content="",
            tool_calls=[
                {"name": "browser_navigate", "args": {}, "id": "a"},
                {"name": "browser_click", "args": {}, "id": "b"},
            ],
        ),
        ToolMessage(content="ok", tool_call_id="a"),
        ToolMessage(content="ok", tool_call_id="b"),
    ]
    assert _graph._prev_step_tool_summary(tool_tail) == (
        "browser_navigate, browser_click",
        False,
    )
    # An error result flags the step so the gate can keep the main model.
    err_tail = [
        AIMessage(
            content="",
            tool_calls=[{"name": "read", "args": {}, "id": "a"}],
        ),
        ToolMessage(content="boom", tool_call_id="a", status="error"),
    ]
    assert _graph._prev_step_tool_summary(err_tail) == ("read", True)
    # Text-only reply / orphan tool result: not a continuation candidate.
    assert _graph._prev_step_tool_summary([AIMessage(content="done")]) is None
    assert _graph._prev_step_tool_summary([ToolMessage(content="x", tool_call_id="a")]) is None


# ── integration: the step loop ────────────────────────────────────────────


def test_gate_never_consulted_on_first_step():
    async def _main():
        main, step = _MainModel(), _StepModel([AIMessage(content="step model reply")])
        reply, _events, seen = await _run(main, step, "cheap_step")
        # Step 1 ran on the main model (tool call), step 2 was routed cheap.
        assert main.calls == 1
        assert step.calls == 1
        assert "step model reply" in reply
        # The gate state is small: task + last tools + step number.
        assert seen["state"]["step"] == "2"
        assert seen["state"]["task"] == "do the thing"
        assert seen["state"]["last_tools"] == "read"
        assert seen["timeout"] == laya_decide.SECONDARY_PREDICT_TIMEOUT

    asyncio.run(_main())


def test_cheap_step_model_runs_and_is_attributed():
    async def _main():
        trace_store.clear("steproute-test")
        main, step = _MainModel(), _StepModel([AIMessage(content="done by step model")])
        reply, _events, _seen = await _run(main, step, "cheap_step")
        assert step.calls == 1 and main.calls == 1
        assert "done by step model" in reply
        rows = trace_store.list_traces("steproute-test", "llm")
        models = {str(r.get("model") or "") for r in rows}
        assert "fake-main" in models and "fake-step" in models
        gate_rows = trace_store.list_traces("steproute-test", "laya")
        assert any(
            "step_route" in str(r.get("detail", {}).get("sub", "")) for r in gate_rows
        )
        trace_store.clear("steproute-test")

    asyncio.run(_main())


def test_big_model_gate_keeps_main_model():
    async def _main():
        main, step = _MainModel(), _StepModel([AIMessage(content="should not run")])
        reply, _events, _seen = await _run(main, step, "big_model")
        assert step.calls == 0
        assert main.calls == 2
        assert "main finish" in reply

    asyncio.run(_main())


def test_abstained_gate_keeps_main_model():
    async def _main():
        main, step = _MainModel(), _StepModel([AIMessage(content="should not run")])
        reply, _events, _seen = await _run(main, step, None)
        assert step.calls == 0
        assert "main finish" in reply

    asyncio.run(_main())


def test_broken_step_model_escalates_once():
    async def _main():
        main = _MainModel()
        step = _ExplodingStepModel()
        reply, events, _seen = await _run(main, step, "cheap_step")
        # The step model ran exactly once, then the turn recovered on the
        # main model — no error surfaced, cheap routing stayed off.
        assert step.calls == 1
        assert main.calls == 2
        assert "main finish" in reply
        assert not [e for e in events if e.get("kind") == "error"]

    asyncio.run(_main())


def test_empty_cheap_step_escalates():
    async def _main():
        main = _MainModel()
        step = _StepModel([AIMessage(content="")])
        reply, _events, _seen = await _run(main, step, "cheap_step")
        assert step.calls == 1
        assert main.calls == 2
        assert "main finish" in reply

    asyncio.run(_main())
