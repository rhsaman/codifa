"""Tests for the deterministic repository-exploration workflow.

Explore/plan run ONE LLM planner call (``repo_derive``) followed by a sequential
``glob -> grep -> read`` pass; the agent then consumes the gathered context and is
DENIED glob/grep/read/task.

Ask runs the SAME discovery pipeline ONLY when the question is project-related
(heuristic gate in ``ask_entry``); general questions are answered directly. Ask is
denied glob/grep/read, so when it discovers it consumes the result and never
re-searches from scratch.

Coder runs the discovery pipeline when no plan exists (like plan); when a plan is
present it implements from the plan and skips discovery.
"""

import pytest

from mock_openai import text_reply, tool_call


def _tool_names_in_captured(captured):
    names = set()
    for body in captured:
        for t in body.get("tools") or []:
            fn = t.get("function") or {}
            names.add(fn.get("name"))
    return names


def _request_contains(captured, needle):
    for body in captured:
        for msg in body.get("messages") or []:
            content = msg.get("content")
            if isinstance(content, str) and needle in content:
                return True
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and needle in (part.get("text") or ""):
                        return True
    return False


@pytest.mark.asyncio
async def test_explore_runs_deterministic_discovery(run_events):
    from mock_openai import mock as _mock

    _mock.script = [text_reply("exploration answer for the user")]
    events = await run_events("where is the foo function in app.py?", mode="explore")

    kinds = [e.get("kind") for e in events]
    tool_events = [e for e in events if e.get("kind") == "tool"]
    tool_names = {e["tool"] for e in tool_events}
    assert "repo_search" in tool_names
    # Sequential deterministic pass: glob -> grep -> read (no tree/collect node).
    assert tool_names & {"glob", "grep"}
    assert "read" in tool_names
    assert "tree" not in tool_names

    assert _request_contains(_mock.captured, "REPOSITORY EXPLORATION RESULTS")
    assert not (_tool_names_in_captured(_mock.captured) & {"glob", "grep", "read", "task"})
    assert any(k == "done" for k in kinds)


@pytest.mark.asyncio
async def test_explore_discovery_is_sequential(run_events):
    from mock_openai import mock as _mock

    _mock.script = [text_reply("exploration answer for the user")]
    events = await run_events("where is the foo function in app.py?", mode="explore")

    # The deterministic pass is SEQUENTIAL: derive -> glob -> grep -> read.
    seq = [e["tool"] for e in events if e.get("kind") == "tool"]
    idx = {t: [i for i, x in enumerate(seq) if x == t] for t in ("repo_search", "glob", "grep", "read")}
    assert idx["repo_search"] and idx["glob"] and idx["read"], seq
    assert idx["repo_search"][0] < idx["glob"][0] < idx["read"][0], seq
    if idx["grep"]:
        assert idx["glob"][0] < idx["grep"][0] < idx["read"][0], seq
    # No tree / collect nodes in the sequential pipeline.
    assert "tree" not in seq and "collect" not in seq


@pytest.mark.asyncio
async def test_ask_general_skips_discovery(run_events):
    from mock_openai import mock as _mock

    # A pure conceptual question: ask answers directly, never runs the
    # deterministic repo-discovery pipeline.
    _ = _mock
    _mock.script = [text_reply("a closure is a function that captures variables")]
    events = await run_events("what is a closure in python?", mode="ask")
    tool_names = {e["tool"] for e in events if e.get("kind") == "tool"}
    assert not (tool_names & {"repo_search", "tree", "collect", "glob", "grep", "read"})
    captured_tools = _tool_names_in_captured(_mock.captured)
    # Ask is DENIED glob/grep/read (it discovers via the pipeline, never self-searches).
    assert not ({"glob", "grep", "read", "task"} & captured_tools)


@pytest.mark.asyncio
async def test_ask_project_question_runs_discovery(run_events):
    from mock_openai import mock as _mock

    # A project question: ask runs the deterministic discovery pipeline and then
    # consumes the gathered context (denied glob/grep/read, so no re-search).
    _mock.script = [
        text_reply("search plan for foo"),
        text_reply("the foo function lives in app.py"),
    ]
    events = await run_events("where is the foo function defined?", mode="ask")
    tool_names = {e["tool"] for e in events if e.get("kind") == "tool"}
    assert tool_names & {"repo_search", "glob", "grep"}
    assert "tree" not in tool_names
    assert _request_contains(_mock.captured, "REPOSITORY EXPLORATION RESULTS")
    assert not (_tool_names_in_captured(_mock.captured) & {"glob", "grep", "read", "task"})


@pytest.mark.asyncio
async def test_plan_always_discovers_and_injects_context(run_events):
    from mock_openai import mock as _mock

    _mock.script = [text_reply("## Plan\n\n1. do the thing\n\nFiles: app.py")] * 6
    events = await run_events("add a logout button to the app", mode="plan")
    tool_names = {e["tool"] for e in events if e.get("kind") == "tool"}
    assert tool_names & {"repo_search", "glob", "grep"}
    assert "tree" not in tool_names
    assert _request_contains(_mock.captured, "REPOSITORY EXPLORATION RESULTS")
    assert not (_tool_names_in_captured(_mock.captured) & {"glob", "grep", "read", "task"})


@pytest.mark.asyncio
async def test_ask_hides_web_tools_by_default(run_events):
    from mock_openai import mock as _mock

    _mock.script = [text_reply("the latest python is 3.12")]
    await run_events("what is the latest python version?", mode="ask")
    captured = _tool_names_in_captured(_mock.captured)
    assert "web_search" not in captured
    assert "fetch_url" not in captured


@pytest.mark.asyncio
async def test_ask_shows_web_tools_on_explicit_request(run_events):
    from mock_openai import mock as _mock

    _mock.script = [text_reply("here are the web results")]
    await run_events(
        "search the web for the latest python release notes",
        mode="ask", cap={"web": True},
    )
    captured = _tool_names_in_captured(_mock.captured)
    assert "web_search" in captured


@pytest.mark.asyncio
async def test_ask_shows_web_tools_on_persian_explicit_request(run_events):
    from mock_openai import mock as _mock

    _mock.script = [text_reply("نتایج وب")]
    await run_events(
        "از وب سرچ کن برای آخرین نسخه پایتون",
        mode="ask", cap={"web": True},
    )
    captured = _tool_names_in_captured(_mock.captured)
    assert "web_search" in captured


# --- Coder: discovery gating + checklist behavior -------------------------


@pytest.mark.asyncio
async def test_coder_without_plan_runs_discovery(run_events):
    from mock_openai import mock as _mock

    # No plan: coder runs the deterministic discovery pipeline (like plan),
    # then implements. Discovery = repo_search + glob/grep/read.
    _mock.script = [
        text_reply("search plan"),
        text_reply("implemented from discovery"),
    ]
    events = await run_events("implement feature X", mode="coder")
    tool_names = {e["tool"] for e in events if e.get("kind") == "tool"}
    assert tool_names & {"repo_search", "glob", "grep", "read"}
    assert not (_tool_names_in_captured(_mock.captured) & {"glob", "grep", "read", "task"})


@pytest.mark.asyncio
async def test_coder_with_plan_skips_discovery(run_events):
    from mock_openai import mock as _mock

    cid = "pytest-coder-plan-skip"
    # Produce + persist a plan in this workspace/chat.
    _mock.script = [text_reply("## Plan\n\n1. add a button\n\nFiles: app.py")] * 8
    await run_events("add a logout button to the app", mode="plan", chat_id=cid)
    # A coder turn in the SAME chat must skip discovery and use the plan.
    _mock.script = [text_reply("implemented from plan")]
    events = await run_events("go ahead and implement it", mode="coder", chat_id=cid)
    tool_names = {e["tool"] for e in events if e.get("kind") == "tool"}
    assert not (tool_names & {"repo_search", "glob", "grep", "read"}), tool_names


@pytest.mark.asyncio
async def test_coder_creates_and_checks_off_todos(run_events):
    from mock_openai import mock as _mock

    # Coder (no plan -> discovery first) must create a todo checklist and tick
    # off each step the moment it finishes.
    _mock.script = [
        text_reply("search plan"),
        tool_call("update_plan", '{"items": [{"content": "step a", "status": "in_progress"}, {"content": "step b", "status": "pending"}]}'),
        tool_call("edit_file", '{"path": "app.py", "content": "x"}'),
        tool_call("update_plan", '{"items": [{"content": "step a", "status": "completed"}, {"content": "step b", "status": "in_progress"}]}'),
        tool_call("edit_file", '{"path": "app.py", "content": "y"}'),
        tool_call("update_plan", '{"items": [{"content": "step a", "status": "completed"}, {"content": "step b", "status": "completed"}]}'),
        text_reply("all done"),
    ]
    events = await run_events("implement feature X", mode="coder")
    plan_events = [e for e in events if e.get("kind") == "plan"]
    assert plan_events, "coder must create a todo checklist"
    # A finished task is ticked before the next starts.
    mid = [
        pe for pe in plan_events
        if any(i["content"] == "step a" and i["status"] == "completed" for i in pe["items"])
        and any(i["content"] == "step b" and i["status"] == "in_progress" for i in pe["items"])
    ]
    assert mid, "finished task must be ticked before the next starts"
    # Final checklist: all completed, nothing left in_progress.
    last = plan_events[-1]
    assert all(i["status"] == "completed" for i in last["items"])
    assert not any(i["status"] == "in_progress" for i in last["items"])


@pytest.mark.asyncio
async def test_coder_replaces_checklist_for_new_work(run_events):
    from mock_openai import mock as _mock

    # When all todos are ticked and NEW work needs its own steps, the old
    # completed checklist is cleared and replaced by a fresh one (not appended).
    _mock.script = [
        text_reply("search plan"),
        tool_call("update_plan", '{"items": [{"content": "a", "status": "in_progress"}, {"content": "b", "status": "pending"}]}'),
        tool_call("edit_file", '{"path": "app.py", "content": "x"}'),
        tool_call("update_plan", '{"items": [{"content": "a", "status": "completed"}, {"content": "b", "status": "in_progress"}]}'),
        tool_call("edit_file", '{"path": "app.py", "content": "y"}'),
        tool_call("update_plan", '{"items": [{"content": "a", "status": "completed"}, {"content": "b", "status": "completed"}]}'),
        tool_call("update_plan", '{"items": [{"content": "c", "status": "in_progress"}, {"content": "d", "status": "pending"}]}'),
        tool_call("edit_file", '{"path": "app.py", "content": "z"}'),
        tool_call("update_plan", '{"items": [{"content": "c", "status": "completed"}, {"content": "d", "status": "in_progress"}]}'),
        tool_call("edit_file", '{"path": "app.py", "content": "w"}'),
        tool_call("update_plan", '{"items": [{"content": "c", "status": "completed"}, {"content": "d", "status": "completed"}]}'),
        text_reply("done"),
    ]
    events = await run_events("implement feature X", mode="coder")
    plan_events = [e for e in events if e.get("kind") == "plan"]
    assert plan_events, "coder must create a todo checklist"
    # There is an all-completed event for the first checklist.
    all_done = [pe for pe in plan_events if all(i["status"] == "completed" for i in pe["items"])]
    assert all_done, "first checklist must be fully ticked"
    # After that, a FRESH checklist replaces it (old items gone, new present).
    seen_all_done = False
    for pe in plan_events:
        if all(i["status"] == "completed" for i in pe["items"]):
            seen_all_done = True
            continue
        if seen_all_done:
            new_contents = {i["content"] for i in pe["items"]}
            assert new_contents == {"c", "d"}, new_contents
            assert "a" not in new_contents and "b" not in new_contents
            break
    else:
        pytest.fail("no replacement checklist after all-completed")
    # Final checklist fully completed.
    assert all(i["status"] == "completed" for i in plan_events[-1]["items"])
