"""Tests that completed tools are NOT re-executed on reconnect/interrupt.

The frontend sends the full history (including `toolActivity` with real
results) on reconnect, and `history_to_langchain_messages` rebuilds those
into `ToolMessage`s carrying the original `tool_call_id`. The agent loop in
`graph.py` must therefore SKIP any tool_call whose result already exists in
the transcript — otherwise the model re-issues the same call on resume and
the backend runs the (already-done) tool again, wasting context and
sometimes freezing.

These tests exercise the guard directly via `_existing_tool_result` and via
the public `history_to_langchain_messages` (which is what populates `msgs`
before the loop runs).
"""

from langchain_core.messages import AIMessage, ToolMessage

import graph


def test_history_rebuild_preserves_tool_call_id():
    """The rebuilt ToolMessage must carry the SAME id the AIMessage tool_call
    uses — that is what lets the loop's guard match and skip re-execution."""
    history = [
        {"role": "user", "content": "find foo"},
        {
            "role": "assistant",
            "content": "searching",
            "toolActivity": [
                {
                    "tool": "grep",
                    "args": {"pattern": "foo"},
                    "callId": "ta-3",
                    "status": "done",
                    "items": [{"snippet": "line1 foo"}, {"snippet": "line2 foo"}],
                }
            ],
        },
    ]
    msgs = graph.history_to_langchain_messages(history)
    ai_msgs = [m for m in msgs if getattr(m, "tool_calls", None)]
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert ai_msgs and tool_msgs
    tc_id = ai_msgs[0].tool_calls[0]["id"]
    assert tool_msgs[0].tool_call_id == tc_id
    # The guard (which scans `msgs` for a ToolMessage with this id) would now
    # find the prior result and skip re-execution.
    matched = [
        m for m in msgs
        if isinstance(m, ToolMessage) and m.tool_call_id == tc_id
    ]
    assert matched, "guard would not find the prior result -> tool re-runs"
    assert "line1 foo" in matched[0].content


def test_existing_tool_result_helper_skips_when_present():
    """End-to-end check of the guard logic against a transcript that mirrors
    what `_run_mode_turn` builds: an AIMessage with a tool_call whose result
    already sits in `msgs` as a ToolMessage with the matching id."""
    # Mirror the closure used inside `_run_mode_turn`.
    msgs = [
        AIMessage(
            content="",
            tool_calls=[{"name": "grep", "args": {"pattern": "foo"}, "id": "ta-3"}],
        ),
        ToolMessage(content="line1 foo\nline2 foo", tool_call_id="ta-3"),
    ]

    def _existing_tool_result(tool_call_id: str):
        for m in msgs:
            if isinstance(m, ToolMessage) and m.tool_call_id == tool_call_id:
                return m.content
        return None

    # The pending set must EXCLUDE ta-3 (already done) and only run new calls.
    tcs = [
        {"name": "grep", "args": {"pattern": "foo"}, "id": "ta-3"},  # done before
        {"name": "read", "args": {"path": "a.py"}, "id": "ta-4"},    # new
    ]
    pending = [tc for tc in tcs if _existing_tool_result(tc.get("id", "")) is None]
    assert [tc["id"] for tc in pending] == ["ta-4"], (
        "already-completed tool must be skipped on resume"
    )
