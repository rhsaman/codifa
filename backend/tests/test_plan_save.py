"""Plan-mode persistence: the plan is saved exactly ONCE by the graph node
(plan_build), not by a separate save_plan tool. Covers the de-duplication fix
where the node took over persistence from the removed tool.
"""

import asyncio

import pytest

import graph
from graph import plan_build


def _state(root, reply, chat_id="c1"):
    q = asyncio.Queue()
    return {
        "_queue": q,
        "root": root,
        "chat_id": chat_id,
        "mode": "plan",
    }, q


@pytest.mark.asyncio
async def test_plan_build_saves_once(tmp_path, monkeypatch):
    root = str(tmp_path)
    reply = "## Plan\n1. do the thing\nFiles: backend/graph.py"

    calls = []

    def fake_save_plan(workspace, title, content, chat_id=""):
        calls.append((workspace, title, content, chat_id))

    monkeypatch.setattr(graph.state_db, "save_plan", fake_save_plan)
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(reply))

    state, q = _state(root, reply)
    result = await plan_build(state)

    assert result["plan"] == reply
    # Exactly ONE write to disk -- the node, not a tool.
    assert len(calls) == 1
    assert calls[0][2] == reply
    assert calls[0][1] == "plan"


@pytest.mark.asyncio
async def test_plan_build_emits_self_check_warning(tmp_path, monkeypatch):
    root = str(tmp_path)
    # A backtick-quoted path that does NOT exist -> self-check should flag it.
    reply = "## Plan\nEdit `backend/does_not_exist.py`.\nFiles: backend/does_not_exist.py"

    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(reply))

    state, q = _state(root, reply)
    await plan_build(state)

    # Drain the queue and look for the self-check warning text.
    texts = []
    while not q.empty():
        item = q.get_nowait()
        if item.get("kind") == "text":
            texts.append(item["content"])
    assert any("self-check" in t for t in texts)


@pytest.mark.asyncio
async def test_plan_build_skips_save_when_not_plan(tmp_path, monkeypatch):
    root = str(tmp_path)
    reply = "Just a normal reply, no plan header."

    calls = []
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: calls.append(1))
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(reply))

    state, q = _state(root, reply)
    await plan_build(state)
    assert len(calls) == 0


def test_save_plan_tool_removed_from_registry():
    # The tool must no longer exist anywhere in the tool registry.
    from tools import make_tool_callbacks

    _tools = make_tool_callbacks(root="/tmp", emit=lambda _e: None, main_model=None)
    assert "save_plan" not in _tools


def _await(value):
    async def _coro():
        return value

    return _coro()
