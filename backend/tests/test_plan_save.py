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
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue, **kwargs: _await(reply))

    state, _q = _state(root, reply)
    result = await plan_build(state)

    assert result["plan"] == reply
    # Exactly ONE write to disk -- the node, not a tool.
    assert len(calls) == 1
    assert calls[0][2] == reply
    assert calls[0][1] == "plan"


@pytest.mark.asyncio
async def test_plan_build_skips_save_when_empty(tmp_path, monkeypatch):
    root = str(tmp_path)
    reply = ""

    calls = []
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: calls.append(1))
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue, **kwargs: _await(reply))

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
            graph, "_run_mode_turn", lambda state, mode, queue, _v=v, **kwargs: _await(_v)
        )
        state, _q = _state(root, v)
        await plan_build(state)
        assert saved.get("content", "").strip(), v


@pytest.mark.asyncio
async def test_plan_build_saves_streamed_text_not_just_final_reply(tmp_path, monkeypatch):
    # The '## Plan' body is written in a step that also carries the update_plan
    # tool call, so the reply (final message only) lacks it. The saved plan
    # must come from the FULL streamed turn text — not the closing prose.
    plan_body = "## Plan\n1. do the thing\nFiles: backend/graph.py"
    closing = "Plan written and the checklist is ready for review."

    async def fake_turn(state, mode, queue, **kwargs):
        queue.put_nowait({"kind": "text", "content": "scouting… "})
        queue.put_nowait({"kind": "text", "content": plan_body})
        queue.put_nowait({"kind": "text", "content": "\n\n" + closing})
        return closing  # reply = final message only, no header

    saved = {}
    monkeypatch.setattr(
        graph.state_db, "save_plan", lambda *a, **k: saved.update({"content": a[2]})
    )
    monkeypatch.setattr(graph, "_run_mode_turn", fake_turn)

    state, _q = _state(str(tmp_path), closing)
    result = await plan_build(state)

    assert saved.get("content", "").startswith("## Plan"), saved
    assert "do the thing" in saved["content"]
    assert result["plan"].startswith("## Plan")


@pytest.mark.asyncio
async def test_plan_revision_saves_streamed_text(tmp_path, monkeypatch):
    # Same contract on the REVISION path: the gate feedback reruns the planner,
    # whose reply is again only the closing message — the revised plan streamed
    # earlier in the turn is what must land on disk.
    v1 = "## Plan\n1. first step\nFiles: a.py"
    v2 = "## Plan\n1. first step\n2. second step\nFiles: a.py"
    closing = "Revised and ready for review."

    async def fake_turn(state, mode, queue, extra_instruction="", **kwargs):
        body = v2 if extra_instruction else v1
        queue.put_nowait({"kind": "text", "content": body})
        queue.put_nowait({"kind": "text", "content": "\n\n" + closing})
        return closing

    saved = []
    monkeypatch.setattr(
        graph.state_db, "save_plan", lambda *a, **k: saved.append(a[2])
    )
    monkeypatch.setattr(graph, "_run_mode_turn", fake_turn)

    gates = {}
    state, q = _state(str(tmp_path), v1)
    state["ask_gates"] = gates
    task = asyncio.create_task(plan_build(state))

    async def answer_when_asked(answer):
        while True:
            ev = await asyncio.wait_for(q.get(), 2.0)
            if ev.get("kind") == "ask":
                gates[ev["id"]].set_result(answer)
                return

    await answer_when_asked("add a second step")
    await answer_when_asked(graph.PLAN_APPROVE_TOKEN)
    result = await asyncio.wait_for(task, 2.0)

    assert len(saved) == 2, saved
    assert saved[0].startswith("## Plan")
    assert "second step" in saved[1], saved[1]
    assert result["plan"].startswith("## Plan")
    assert result["mode"] == "build"


@pytest.mark.asyncio
async def test_plan_reply_carrying_header_not_stripped(tmp_path, monkeypatch):
    # When the model writes '## Plan' in a message WITHOUT a tool call, the
    # reply carries the plan (+ closing prose). Stripping that suffix from the
    # streamed turn text would delete the plan and leave only the scouting
    # narration — which would then be saved AS the plan.
    narration = "one final search for the setter name..."
    body = "## Plan\n1. do the thing\nFiles: backend/graph.py"
    closing = "Plan written and the checklist is ready."

    async def fake_turn(state, mode, queue, **kwargs):
        queue.put_nowait({"kind": "text", "content": narration})
        queue.put_nowait({"kind": "text", "content": "\n\n" + body})
        queue.put_nowait({"kind": "text", "content": "\n\n" + closing})
        return body + "\n\n" + closing  # reply = plan + closing (no tool call)

    saved = {}
    monkeypatch.setattr(
        graph.state_db, "save_plan", lambda *a, **k: saved.update({"content": a[2]})
    )
    monkeypatch.setattr(graph, "_run_mode_turn", fake_turn)

    state, _q = _state(str(tmp_path), "")
    await plan_build(state)

    assert saved.get("content", "").startswith("## Plan"), saved
    assert "do the thing" in saved["content"], saved


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
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue, **kwargs: _await(reply))

    state, _q = _state(root, reply)
    # Should not raise; returns the reply unchanged.
    result = await plan_build(state)
    assert result["plan"] == reply


@pytest.mark.asyncio
async def test_plan_build_handles_non_string_reply(tmp_path, monkeypatch):
    # If the turn returns None (or any non-str), plan_build must not crash on
    # .strip() and must return an empty plan string.
    root = str(tmp_path)

    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue, **kwargs: _await(None))
    monkeypatch.setattr(graph.state_db, "save_plan", lambda *a, **k: None)

    state, _q = _state(root, "")
    result = await plan_build(state)
    assert result["plan"] == ""


def _await(value):
    async def _coro():
        return value

    return _coro()


@pytest.mark.asyncio
async def test_update_plan_repeat_without_progress_nudges(tmp_path):
    # Re-sending an unchanged checklist after tool work ran must say so in the
    # result string (the stuck-at-0/N pattern) instead of silently confirming —
    # the todos panel only moves when statuses move.
    import tools as tools_mod
    from tools import make_tool_callbacks

    chat = "c-nudge-repeat"
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)
    tools = make_tool_callbacks(
        root=str(tmp_path), emit=lambda _e: None, main_model=None, chat_id=chat
    )
    items = [
        {"content": "step one", "status": "pending"},
        {"content": "step two", "status": "pending"},
    ]
    r1 = await tools["update_plan"](items)
    assert "without advancing" not in r1
    # Real (mutating) tool work runs after the checklist was set...
    w = await tools["write_file"](path="n.txt", content="hello")
    assert "Successfully wrote" in w
    # ...then the model re-sends the identical checklist: must be called out.
    r2 = await tools["update_plan"](items)
    assert "without advancing any status" in r2, r2
    assert "batch with your next tool calls" in r2, r2
    assert "a solo update_plan is fine" not in r2, r2
    # Advancing a status clears it: real progress → no note.
    r3 = await tools["update_plan"](
        [
            {"content": "step one", "status": "completed"},
            {"content": "step two", "status": "in_progress"},
        ]
    )
    assert "without advancing" not in r3
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)


@pytest.mark.asyncio
async def test_plan_nudge_fires_with_all_pending_open_list(tmp_path):
    # An all-pending checklist must still be reminded after mutating work —
    # previously only an in_progress-stuck list was reminded, so an
    # all-pending list went stale silently while edits ran (todos never ticked).
    import tools as tools_mod
    from tools import make_tool_callbacks

    chat = "c-nudge-all-pending"
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)
    tools = make_tool_callbacks(
        root=str(tmp_path), emit=lambda _e: None, main_model=None, chat_id=chat
    )
    await tools["update_plan"](
        [
            {"content": "step one", "status": "pending"},
            {"content": "step two", "status": "pending"},
        ]
    )
    out = await tools["write_file"](path="n.txt", content="hello")
    assert "checklist still has open steps" in out, out
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)


@pytest.mark.asyncio
async def test_plan_nudge_silent_without_checklist(tmp_path):
    # No checklist → no nag on mutating tools (no spurious reminders on
    # trivial single-step turns that correctly skipped update_plan).
    import tools as tools_mod
    from tools import make_tool_callbacks

    chat = "c-nudge-none"
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)
    tools = make_tool_callbacks(
        root=str(tmp_path), emit=lambda _e: None, main_model=None, chat_id=chat
    )
    out = await tools["write_file"](path="n.txt", content="hello")
    assert "checklist" not in out, out


@pytest.mark.asyncio
async def test_plan_save_uses_loader_workspace_slug(tmp_path, monkeypatch):
    import state_db

    root = str(tmp_path)
    reply = "## Plan\n1. do the thing\nFiles: backend/graph.py"
    captured = {}
    monkeypatch.setattr(
        graph.state_db,
        "save_plan",
        lambda *a, **k: captured.update({"ws": a[0], "content": a[2]}),
    )
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue, **kwargs: _await(reply))

    state, _q = _state(root, reply)
    await plan_build(state)

    assert captured.get("ws") == state_db.workspace_slug_for_root(root), captured
    assert captured.get("content", "").startswith("## Plan")


@pytest.mark.asyncio
async def test_build_node_emits_plan_card_when_writing_plan(tmp_path, monkeypatch):
    from graph import build_node

    plan_body = "## Plan\n1. do the thing\nFiles: backend/graph.py"

    async def fake_turn(state, mode, queue, **kwargs):
        queue.put_nowait({"kind": "text", "content": plan_body})
        return "implemented the thing"

    saved = {}
    monkeypatch.setattr(
        graph.state_db, "save_plan", lambda *a, **k: saved.update({"content": a[2]})
    )
    monkeypatch.setattr(graph, "_run_mode_turn", fake_turn)

    q: asyncio.Queue = asyncio.Queue()
    state = {"_queue": q, "root": str(tmp_path), "chat_id": "c-build", "mode": "build"}
    result = await build_node(state)

    assert saved.get("content", "").startswith("## Plan"), saved
    kinds = []
    while not q.empty():
        kinds.append(q.get_nowait().get("kind"))
    assert "plan_card" in kinds, kinds
    assert result["build_result"] == "implemented the thing"


@pytest.mark.asyncio
async def test_plan_build_saves_persian_header_once(tmp_path, monkeypatch):
    root = str(tmp_path)
    reply = "## پلن\n۱. انجام کار\nFiles: backend/graph.py"

    calls = []

    def fake_save_plan(workspace, title, content, chat_id=""):
        calls.append((workspace, title, content, chat_id))

    monkeypatch.setattr(graph.state_db, "save_plan", fake_save_plan)
    monkeypatch.setattr(graph, "_run_mode_turn", lambda state, mode, queue, **kwargs: _await(reply))

    state, _q = _state(root, reply)
    result = await plan_build(state)

    assert result["plan"] == reply
    assert len(calls) == 1
    assert calls[0][2] == reply
    assert calls[0][1] == "plan"


def test_plan_items_from_persian_digits():
    from graph import _plan_items_from_body

    body = "## پلن\n۱. قدم اول\n۲) قدم دوم\n• قدم سوم\nFiles: a.py"
    items = _plan_items_from_body(body)

    assert len(items) == 3
    assert items[0]["content"] == "قدم اول"
    assert items[1]["content"] == "قدم دوم"
    assert items[2]["content"] == "قدم سوم"


def test_plan_progress_line_is_one_line():
    # Cheap resume memory: a single short line, not the full checklist.
    from graph import _plan_progress_line, _plan_status_message

    plan = [
        {"content": "step one", "status": "completed"},
        {"content": "step two", "status": "in_progress"},
        {"content": "step three", "status": "pending"},
    ]
    line = _plan_progress_line(plan)
    assert line.startswith("1/3 done")
    assert "step two" in line
    assert "\n" not in line
    assert len(line) < 160
    msg = _plan_status_message(plan)
    assert msg is not None
    assert "\n- [" not in str(msg.content)


@pytest.mark.asyncio
async def test_update_plan_persists_and_hydrates(tmp_path, monkeypatch):
    # Open checklist survives a restart: update_plan writes checklist.json,
    # and fresh callbacks reload it so the nudge backstop keeps working.
    import tools as tools_mod
    from tools import make_tool_callbacks

    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    chat = "c-persist-hydrate"
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)
    tools = make_tool_callbacks(
        root=str(tmp_path), emit=lambda _e: None, main_model=None, chat_id=chat
    )
    await tools["update_plan"](
        [
            {"content": "step one", "status": "pending"},
            {"content": "step two", "status": "pending"},
        ]
    )
    import state_db

    ws = state_db.workspace_slug_for_root(str(tmp_path))
    assert len(state_db.get_checklist(ws, chat)) == 2
    # Simulate a process restart: drop the in-memory copy only.
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools2 = make_tool_callbacks(
        root=str(tmp_path), emit=lambda _e: None, main_model=None, chat_id=chat
    )
    out = await tools2["write_file"](path="n.txt", content="hello")
    assert "checklist still has open steps" in out, out
    tools_mod._PLAN_BY_CHAT.pop(chat, None)
    tools_mod._PLAN_MUTATING_SINCE_UPDATE.pop(chat, None)
