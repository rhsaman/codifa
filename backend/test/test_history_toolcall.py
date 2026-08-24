"""Unit tests: history toolActivity reconstruction.

When a turn is interrupted and the frontend re-sends the conversation, each
assistant message carries a ``toolActivity`` array (tool name, args, ``callId``,
and the completed result). ``history_to_langchain_messages`` must reconstruct
those as real ``AIMessage(tool_calls=[...])`` + ``ToolMessage`` pairs so the
model sees the prior work and does NOT re-run the tool calls.

Run: uv run pytest backend/test/test_history_toolcall.py
"""
import pytest

from graph import history_to_langchain_messages
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage


def test_assistant_with_tool_activity_reconstructs_tool_calls():
    """An assistant turn carrying toolActivity becomes AIMessage(tool_calls)
    + ToolMessage, not a bare AIMessage."""
    history = [
        {"role": "user", "content": "find foo"},
        {
            "role": "assistant",
            "content": "Let me search.",
            "toolActivity": [
                {
                    "tool": "grep",
                    "args": {"pattern": "foo", "path": ""},
                    "callId": 1,
                    "status": "done",
                    "items": "MATCHES for 'foo'\napp.py:1: def foo():",
                    "summary": "1 matches",
                }
            ],
        },
    ]
    msgs = history_to_langchain_messages(history)

    # user, assistant(AIMessage w/ tool_calls), tool(ToolMessage)
    assert len(msgs) == 3
    assert isinstance(msgs[0], HumanMessage)
    assert isinstance(msgs[1], AIMessage)
    assert isinstance(msgs[2], ToolMessage)

    ai = msgs[1]
    assert ai.content == "Let me search."
    assert ai.tool_calls and len(ai.tool_calls) == 1
    tc = ai.tool_calls[0]
    assert tc["name"] == "grep"
    assert tc["args"] == {"pattern": "foo", "path": ""}
    assert tc["id"] == "1"

    tool = msgs[2]
    assert tool.tool_call_id == "1"
    assert "MATCHES for 'foo'" in tool.content


def test_multiple_tool_calls_preserved_in_order():
    """Several completed tool calls keep their order and ids."""
    history = [
        {"role": "user", "content": "do things"},
        {
            "role": "assistant",
            "content": "Working.",
            "toolActivity": [
                {"tool": "read", "args": {"filePath": "a.py"}, "callId": 7,
                 "status": "done", "items": "line a"},
                {"tool": "grep", "args": {"pattern": "x"}, "callId": 8,
                 "status": "done", "items": "line x"},
            ],
        },
    ]
    msgs = history_to_langchain_messages(history)
    assert isinstance(msgs[1], AIMessage)
    assert isinstance(msgs[2], ToolMessage)
    assert isinstance(msgs[3], ToolMessage)
    assert [tc["id"] for tc in msgs[1].tool_calls] == ["7", "8"]
    assert msgs[2].tool_call_id == "7" and "line a" in msgs[2].content
    assert msgs[3].tool_call_id == "8" and "line x" in msgs[3].content


def test_running_tool_calls_are_still_reconstructed():
    """The frontend filters out 'running' cards before sending history, but if a
    completed+running mix arrives we still reconstruct every entry (the model
    should see what finished; a still-running call has no result yet)."""
    history = [
        {
            "role": "assistant",
            "content": "Half done.",
            "toolActivity": [
                {"tool": "read", "args": {"filePath": "a.py"}, "callId": 3,
                 "status": "done", "items": "result a"},
                {"tool": "write", "args": {"path": "b.py"}, "callId": 4,
                 "status": "running"},
            ],
        }
    ]
    msgs = history_to_langchain_messages(history)
    assert isinstance(msgs[0], AIMessage)
    assert len(msgs) == 3  # AIMessage + 2 ToolMessages
    assert msgs[1].tool_call_id == "3" and "result a" in msgs[1].content
    assert msgs[2].tool_call_id == "4"  # empty result for the running call


def test_assistant_without_tool_activity_is_plain_ai():
    """A normal assistant turn (no toolActivity) stays a bare AIMessage."""
    history = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    msgs = history_to_langchain_messages(history)
    assert len(msgs) == 2
    assert isinstance(msgs[0], HumanMessage)
    assert isinstance(msgs[1], AIMessage)
    assert not msgs[1].tool_calls


def test_system_and_user_turns_unchanged():
    """System/user turns ignore any stray toolActivity field."""
    history = [
        {"role": "system", "content": "be helpful", "toolActivity": [{"tool": "x"}]},
        {"role": "user", "content": "go", "toolActivity": [{"tool": "y"}]},
    ]
    msgs = history_to_langchain_messages(history)
    assert len(msgs) == 2
    assert isinstance(msgs[0], SystemMessage)
    assert isinstance(msgs[1], HumanMessage)
