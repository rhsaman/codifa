"""Behavior tests: the REAL agent service layer against a mocked LLM.

Only the LLM layer is mocked (an in-process OpenAI-compatible server). The
agent, its tools, the sub-agent runner and the event stream are all real —
so these tests prove the agent actually behaves the way the UI expects:
streams text, runs tools, routes sub-agents, and fails gracefully.
"""
import json

from mock_openai import text_reply, tool_call


def _text(events):
    return "".join(e.get("content", "") for e in events if e.get("kind") == "text")


async def test_agent_streams_text_reply_to_user(run_events, mock_server):
    base, mock = mock_server
    mock.script = [text_reply("سلام! چطور میتونم کمک کنم؟")]
    events = await run_events("سلام")
    assert "سلام! چطور میتونم کمک کنم؟" in _text(events)
    assert not [e for e in events if e.get("kind") == "tool_result"], \
        "a plain reply must not trigger tools"


async def test_agent_runs_tool_and_returns_result_to_model(run_events, mock_server):
    base, mock = mock_server
    mock.script = [
        tool_call("task", json.dumps({
            "description": "find foo",
            "prompt": "find where foo is defined",
            "subagent_type": "general",
        })),
        text_reply("SUBAGENT REPORT: foo is defined in app.py:1"),
        text_reply("Done. The exploration is complete."),
    ]
    events = await run_events("research the workspace for foo", mode="plan")
    tool_results = [
        e for e in events if e.get("kind") == "tool_result" and e.get("tool") == "task"
    ]
    assert tool_results, "expected a task tool_result"
    assert "chars" in tool_results[0].get("summary", ""), \
        f"unexpected task result: {tool_results[0]}"
    assert "Done. The exploration is complete." in _text(events), \
        "agent never finished after the tool result"
    assert len(mock.captured) >= 3, "parent + sub-agent + parent requests expected"


async def test_agent_passes_history_into_the_model_request(run_events, mock_server):
    base, mock = mock_server
    mock.script = [text_reply("ok")]
    events = await run_events("ادامه بده", history=[{"role": "user", "content": "قبلی"}])
    assert "ok" in _text(events)
    messages = mock.captured[0].get("messages", [])
    assert any(m.get("content") == "قبلی" for m in messages), \
        "history was not passed into the model request"


async def test_agent_routes_general_subagent_on_main_model(run_events, mock_server):
    """The `general` sub-agent inherits the PARENT's model (it runs on the main
    model, not a separate slot), and its report must NOT leak into the parent
    stream — the parent only sees the tool result, not the sub-agent's raw text."""
    base, mock = mock_server
    mock.script = [
        tool_call("task", json.dumps({
            "description": "find foo",
            "prompt": "find foo",
            "subagent_type": "general",
        })),
        text_reply("SUBAGENT REPORT: app.py:1"),
        text_reply("Done."),
    ]
    events = await run_events(
        "research the workspace",
        mode="plan",
        subagent_models={"search": "search-model", "web": "web-model"},
    )
    assert str(mock.captured[1].get("model", "")) == "mock-model", \
        f"general sub-agent should run on the main model: {mock.captured[1].get('model')!r}"
    # The general sub-agent ran and its report came back as the task tool_result.
    task_results = [
        e for e in events
        if e.get("kind") == "tool_result" and e.get("tool") == "task"
    ]
    assert task_results, "expected a general task tool_result"
    assert "chars" in task_results[0].get("summary", ""), \
        f"unexpected general task result: {task_results[0]}"


async def test_agent_rejects_empty_prompt_with_error_event(run_events):
    events = await run_events("   ")
    assert any(e.get("kind") == "error" for e in events), \
        f"expected an error event, got kinds={sorted({e.get('kind') for e in events})}"


async def test_agent_surfaces_provider_failure(run_events, mock_server):
    """A hard provider rejection must surface as an exception, not hang or
    silently succeed — the UI depends on the failure propagating."""
    import pytest
    from pydantic_ai.exceptions import ModelHTTPError

    base, mock = mock_server
    mock.script = [None] * 20  # every request rejected with HTTP 400
    with pytest.raises(ModelHTTPError):
        await run_events("سلام")


async def test_coder_does_not_force_test_run_without_terminal(run_events, mock_server):
    """Coder is implementation-only and has NO terminal (it MUST NOT run shell /
    tests — verification is Plan mode's job, which keeps a read-only terminal).
    Therefore a test-related coder task that finishes without running any test
    command must NOT trigger the forced run-and-see-green follow-up: there is no
    terminal to run on, so forcing would be dead code. This locks in the new
    architecture (coder relies on Plan for verification)."""
    base, mock = mock_server
    # The model replies immediately and never calls run_terminal (it can't — the
    # coder toolset has no terminal). No forced test-verification follow-up may fire.
    mock.script = [text_reply("تمام شد.")]
    events = await run_events("تست بنویس برای پروژه")

    retries = [e for e in events if e.get("kind") == "retry"]
    assert not any(
        "test" in (e.get("reason") or "").lower() for e in retries
    ), f"coder must not force a test run (no terminal): retries={retries}"
    # No verification follow-up turn: exactly one model request.
    assert len(mock.captured) == 1, "coder must not spawn a verification follow-up"


async def test_agent_skips_test_verification_when_tests_were_run(run_events, mock_server):
    """When the agent actually ran the test command, no forced follow-up fires —
    the verification step is satisfied by the real test run."""
    base, mock = mock_server
    mock.script = [
        tool_call("run_terminal", json.dumps({"command": "python -m pytest tests/ -q"})),
        text_reply("3 passed"),
    ]
    events = await run_events("تست بنویس برای پروژه", mode="plan")

    retries = [e for e in events if e.get("kind") == "retry"]
    assert not any(
        "test" in (e.get("reason") or "").lower() for e in retries
    ), f"test verification should be satisfied by the real run, got retries={retries}"
    assert "3 passed" in _text(events)