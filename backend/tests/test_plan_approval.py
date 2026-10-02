"""Plan approval gate: after plan_build saves a plan it emits a plan_card
event and raises a deterministic ask-gate (style="plan_approval") so the user
can Approve (run continues into the Coder node in the same stream), request
edits (the planner revises and re-asks), or Dismiss (plan mode ends with the
plan saved). Headless runs (no ask_gates) keep the old plan-and-stop behavior.
"""

import asyncio

import pytest

import graph
from graph import (
    PLAN_APPROVE_TOKEN,
    PLAN_DISMISS_TOKEN,
    _route_plan_build,
    plan_build,
)

PLAN_V1 = "## Plan\n1. do the thing\nFiles: backend/graph.py"
PLAN_V2 = "## Plan\n1. do the thing\n2. also write tests\nFiles: backend/graph.py"


def _state(root, ask_gates=None, chat_id="c-approval"):
    q = asyncio.Queue()
    state = {
        "_queue": q,
        "root": root,
        "chat_id": chat_id,
        "mode": "plan",
    }
    if ask_gates is not None:
        state["ask_gates"] = ask_gates
    return state, q


def _reply_factory(replies):
    """Fake _run_mode_turn returning each reply in order; captures extra_instruction."""
    calls = []

    def _fake(state, mode, queue, extra_instruction="", **kwargs):
        calls.append({"extra_instruction": extra_instruction})
        idx = min(len(calls) - 1, len(replies) - 1)

        async def _coro():
            return replies[idx]

        return _coro()

    return _fake, calls


async def _drain_until(q, kind, timeout=2.0):
    while True:
        ev = await asyncio.wait_for(q.get(), timeout=timeout)
        if ev.get("kind") == kind:
            return ev


async def _answer_gate(gates, answer, timeout=2.0):
    """Wait for the plan-approval gate to be raised, then resolve it."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not gates:
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("plan approval gate was never raised")
        await asyncio.sleep(0.01)
    (fut,) = gates.values()
    fut.set_result(answer)


@pytest.mark.asyncio
async def test_plan_card_preamble_split_and_title(tmp_path, monkeypatch):
    events = []
    fake, _calls = _reply_factory(["Here is my take:\n" + PLAN_V1])
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", fake)

    state, q = _state(str(tmp_path))
    # No ask_gates → the gate is skipped, plan_build returns immediately.
    result = await plan_build(state)

    while not q.empty():
        events.append(q.get_nowait())
    card = next((e for e in events if e.get("kind") == "plan_card"), None)
    assert card is not None
    assert card["body"] == PLAN_V1
    assert card["preamble"] == "Here is my take:"
    assert result["mode"] == "plan"
    assert result["plan"] == PLAN_V1


@pytest.mark.asyncio
async def test_plan_title_extracts_heading(tmp_path, monkeypatch):
    from graph import _plan_title

    assert _plan_title("## Plan: auth refactor\n- x") == "Plan: auth refactor"
    assert _plan_title("## Plan\n- x") == ""
    assert _plan_title("### Plan:\n- x") == ""
    assert _plan_title("no heading here") == ""


@pytest.mark.asyncio
async def test_approval_approve_routes_to_coder(tmp_path, monkeypatch):
    gates = {}
    fake, _calls = _reply_factory([PLAN_V1])
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", fake)

    state, q = _state(str(tmp_path), ask_gates=gates)
    task = asyncio.create_task(plan_build(state))

    ask_ev = await _drain_until(q, "ask")
    assert ask_ev["style"] == "plan_approval"
    assert ask_ev["question"] == "Implementation plan"
    assert ask_ev["options"], "approve option must be present"

    await _answer_gate(gates, PLAN_APPROVE_TOKEN)
    result = await asyncio.wait_for(task, timeout=2.0)

    mode_ev = await _drain_until(q, "mode_changed")
    assert mode_ev["mode"] == "coder"
    assert result["mode"] == "coder"
    # Full routing contract: the approved plan continues into the Coder node.
    assert _route_plan_build({**state, **result}) == "coder"
    # The run's capability map must upgrade to full coder access — the request
    # arrived with read-only plan caps and filter_tools_for_mode trusts it.
    assert result["cap"] == graph.CODER_CAPS
    from tools import make_tool_callbacks

    plain = make_tool_callbacks(root=str(tmp_path), emit=lambda _e: None, main_model=None)
    kept = graph.filter_tools_for_mode(
        "coder", dict(plain), result["cap"], set(), False, False
    )
    assert "edit_file" in kept and "write_file" in kept and "run_terminal" in kept


@pytest.mark.asyncio
async def test_approval_feedback_revises_plan_and_reasks(tmp_path, monkeypatch):
    gates = {}
    fake, calls = _reply_factory([PLAN_V1, PLAN_V2])
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", fake)

    state, q = _state(str(tmp_path), ask_gates=gates)
    task = asyncio.create_task(plan_build(state))

    await _drain_until(q, "ask")
    feedback = "add a step that writes tests"
    await _answer_gate(gates, feedback)

    # The revision turn receives the feedback AND the plan being revised.
    # Event order: plan_card(v2) lands before the next approval ask.
    card2 = await _drain_until(q, "plan_card")
    await _drain_until(q, "ask")
    assert len(calls) == 2
    assert "PLAN REVISION REQUEST" in calls[1]["extra_instruction"]
    assert feedback in calls[1]["extra_instruction"]
    assert PLAN_V1 in calls[1]["extra_instruction"]
    assert card2["body"] == PLAN_V2

    await _answer_gate(gates, PLAN_APPROVE_TOKEN)
    result = await asyncio.wait_for(task, timeout=2.0)
    assert result["mode"] == "coder"
    assert result["plan"] == PLAN_V2


@pytest.mark.asyncio
async def test_approval_dismiss_stays_in_plan_mode(tmp_path, monkeypatch):
    gates = {}
    fake, calls = _reply_factory([PLAN_V1])
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", fake)

    state, q = _state(str(tmp_path), ask_gates=gates)
    task = asyncio.create_task(plan_build(state))

    await _drain_until(q, "ask")
    await _answer_gate(gates, PLAN_DISMISS_TOKEN)
    result = await asyncio.wait_for(task, timeout=2.0)

    assert result["mode"] == "plan"
    assert len(calls) == 1, "dismiss must not trigger a revision turn"
    # No mode_changed event on dismiss.
    with pytest.raises(asyncio.TimeoutError):
        await _drain_until(q, "mode_changed", timeout=0.2)
    assert _route_plan_build({**state, **result}) == "done"


@pytest.mark.asyncio
async def test_no_ask_gates_keeps_plan_and_stop(tmp_path, monkeypatch):
    fake, _calls = _reply_factory([PLAN_V1])
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", fake)

    # Headless / scheduled runs pass no ask_gates: must not hang on a gate.
    state, _q = _state(str(tmp_path))
    result = await asyncio.wait_for(plan_build(state), timeout=2.0)
    assert result["mode"] == "plan"
    assert result["plan"] == PLAN_V1


@pytest.mark.asyncio
async def test_gate_resolution_via_ask_respond_contract(tmp_path, monkeypatch):
    """The gate must live in the SAME ask_gates dict the /ask/respond endpoint
    pops from — the frontend's existing respondAsk flow resolves it."""
    gates = {}
    fake, _calls = _reply_factory([PLAN_V1])
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", fake)

    state, q = _state(str(tmp_path), ask_gates=gates)
    task = asyncio.create_task(plan_build(state))

    ask_ev = await _drain_until(q, "ask")
    assert ask_ev["id"] in gates, "gate id must be registered in ask_gates"
    # Simulate POST /ask/respond: {"id": ..., "answer": ...}
    gates[ask_ev["id"]].set_result(PLAN_APPROVE_TOKEN)
    await asyncio.wait_for(task, timeout=2.0)
    assert ask_ev["id"] not in gates, "gate must be popped after resolution"
