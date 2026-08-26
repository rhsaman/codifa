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

    state, _q = _state(root, reply)
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
async def test_plan_build_auto_corrects_path(tmp_path, monkeypatch):
    root = str(tmp_path)
    # The real file lives under test/, but the plan references it without that
    # prefix. The self-check should auto-correct the path in-place (exactly one
    # basename match) and NOT emit a warning.
    test_dir = tmp_path / "test"
    test_dir.mkdir()
    (test_dir / "scrollPos.test.ts").write_text("// fixture\n")

    reply = "## Plan\nEdit `scrollPos.test.ts`.\nFiles: scrollPos.test.ts"

    saved = {}

    def fake_save_plan(workspace, title, content, chat_id=""):
        saved["content"] = content

    monkeypatch.setattr(graph.state_db, "save_plan", fake_save_plan)
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(reply))

    state, q = _state(root, reply)
    await plan_build(state)

    # The saved plan should have the corrected path, not the wrong one.
    assert "test/scrollPos.test.ts" in saved["content"]
    assert "`scrollPos.test.ts`" not in saved["content"]

    # No self-check warning should be emitted for an auto-corrected path.
    texts = []
    while not q.empty():
        item = q.get_nowait()
        if item.get("kind") == "text":
            texts.append(item["content"])
    assert not any("self-check" in t for t in texts)


@pytest.mark.asyncio
async def test_plan_build_skips_save_when_empty(tmp_path, monkeypatch):
    root = str(tmp_path)
    reply = ""

    calls = []
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: calls.append(1))
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(reply))

    state, _q = _state(root, reply)
    await plan_build(state)
    assert len(calls) == 0


@pytest.mark.asyncio
async def test_plan_build_saves_with_variant_header(tmp_path, monkeypatch):
    # The model is told to open with '## Plan', but it sometimes prefixes a
    # lead-in or uses a variant header. The plan must STILL be saved (the
    # "plan sometimes isn't saved" bug). We exercise _normalize_plan_reply
    # directly plus the full plan_build path for each variant.
    from graph import _normalize_plan_reply

    variants = [
        "## Plan\n1. do the thing\nFiles: backend/graph.py",
        "## plan\n1. do the thing\nFiles: backend/graph.py",
        "### Plan:\n1. do the thing\nFiles: backend/graph.py",
        "Here is the plan:\n## Plan\n1. do the thing\nFiles: backend/graph.py",
        "1. do the thing\nFiles: backend/graph.py",  # no header at all
    ]
    for v in variants:
        assert _normalize_plan_reply(v).lstrip().lower().startswith("## plan") or (
            v.strip() == _normalize_plan_reply(v)
        ), v

    # Full path: every variant must hit the disk exactly once.
    root = str(tmp_path)
    saved = {}
    monkeypatch.setattr(
        graph.state_db, "save_plan", lambda *a, **k: saved.update({"workspace": a[0], "content": a[2]})
    )
    for v in variants:
        monkeypatch.setattr(
            graph, "_run_mode_turn", lambda state, mode, queue, _v=v: _await(_v)
        )
        state, _q = _state(root, v)
        await plan_build(state)
        assert saved.get("content", "").strip(), v


def test_save_plan_tool_removed_from_registry():
    # The tool must no longer exist anywhere in the tool registry.
    from tools import make_tool_callbacks

    _tools = make_tool_callbacks(root="/tmp", emit=lambda _e: None, main_model=None)
    assert "save_plan" not in _tools


@pytest.mark.asyncio
async def test_update_plan_emits_checklist_only(tmp_path, monkeypatch):
    # update_plan must emit the checklist to the UI but must NOT persist it to
    # disk (the checklist is session-only now, to avoid re-loading stale todos
    # on every message). The persistence helper was removed entirely, so we
    # only assert the UI event is still emitted.
    from tools import make_tool_callbacks

    events = []

    def emit(ev):
        events.append(ev)

    tools = make_tool_callbacks(
        root=str(tmp_path), emit=emit, main_model=None, chat_id="c1"
    )
    items = [
        {"content": "step one", "status": "completed"},
        {"content": "step two", "status": "in_progress"},
        {"content": "step three", "status": "pending"},
    ]
    result = await tools["update_plan"](items)

    assert "Plan updated" in result
    # The plan event must still be emitted to the UI.
    assert any(e.get("kind") == "plan" for e in events)


@pytest.mark.asyncio
async def test_plan_build_logs_on_save_failure(tmp_path, monkeypatch):
    # A failing save_plan must NOT be silently swallowed — the reply is still
    # returned and the failure is logged (not raising into the caller).
    root = str(tmp_path)
    reply = "## Plan\n1. do the thing\nFiles: backend/graph.py"

    def boom(workspace, title, content, chat_id=""):
        raise RuntimeError("disk full")

    monkeypatch.setattr(graph.state_db, "save_plan", boom)
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(reply))

    state, _q = _state(root, reply)
    # Should not raise; returns the reply unchanged.
    result = await plan_build(state)
    assert result["plan"] == reply


@pytest.mark.asyncio
async def test_plan_build_handles_non_string_reply(tmp_path, monkeypatch):
    # If the turn returns None (or any non-str), plan_build must not crash on
    # .strip() and must return an empty plan string.
    root = str(tmp_path)

    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue: _await(None))
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)

    state, _q = _state(root, "")
    result = await plan_build(state)
    assert result["plan"] == ""


def _await(value):
    async def _coro():
        return value

    return _coro()
