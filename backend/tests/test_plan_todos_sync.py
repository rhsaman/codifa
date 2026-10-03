"""Plan todos sync: revised plan replaces previous checklist items."""

import asyncio

import pytest

import graph
from graph import _plan_items_from_body, plan_build


def test_plan_items_from_body_parses_steps():
    body = "## Plan\n1. do the thing\n2. also write tests\nFiles: backend/graph.py"
    items = _plan_items_from_body(body)
    assert [i["content"] for i in items] == ["do the thing", "also write tests"]
    assert all(i["status"] == "pending" for i in items)


def test_plan_items_from_body_empty_keeps_todos():
    assert _plan_items_from_body("## Plan\njust prose, no steps") == []
    assert _plan_items_from_body("") == []


@pytest.mark.asyncio
async def test_plan_build_emits_todos_sync_after_card(tmp_path, monkeypatch):
    """Each saved plan (create + revision) emits plan_card then plan items."""
    q = asyncio.Queue()
    state = {"_queue": q, "root": str(tmp_path), "chat_id": "c-sync", "mode": "plan"}
    reply = "## Plan\n1. do the thing\n2. also write tests\nFiles: backend/graph.py"

    async def _fake_turn(state, mode, queue, **kwargs):
        return reply

    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)
    monkeypatch.setattr(graph, "_run_mode_turn", _fake_turn)

    await plan_build(state)

    events = []
    while not q.empty():
        events.append(q.get_nowait())
    kinds = [e.get("kind") for e in events]
    assert "plan_card" in kinds
    assert "plan" in kinds
    # Todos sync lands right after its card, replacing stale steps.
    card_idx = kinds.index("plan_card")
    plan_idx = kinds.index("plan")
    assert plan_idx == card_idx + 1
    items = events[plan_idx]["items"]
    assert [i["content"] for i in items] == ["do the thing", "also write tests"]
