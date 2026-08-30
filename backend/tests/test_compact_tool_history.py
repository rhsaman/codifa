"""Regression tests for in-turn tool-history compaction.

The bug: ``_compact_tool_history`` dropped old ``ToolMessage``s but left the
parent ``AIMessage`` (which still carried ``tool_calls``) in the transcript.
That produced an INVALID transcript — an unanswered tool request — so the
provider saw a dangling call and the model re-issued the SAME tool call on the
next step, tripping the repetition-loop guard and aborting the turn.

These tests pin the fix: when a tool result is dropped, its parent assistant
tool_calls must be neutralized (and empty pure-tool-call stubs removed) so the
transcript stays valid and the model never re-runs an already-answered call.
"""

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

import graph


def _make_transcript() -> list:
    """A transcript with 3 tool calls (only the 2 newest should survive)."""
    return [
        SystemMessage(content="sys"),
        HumanMessage(content="do the work"),
        AIMessage(
            content="",
            tool_calls=[{"name": "read", "args": {"path": "a.py"}, "id": "call_a"}],
        ),
        ToolMessage(content="result-a", tool_call_id="call_a"),
        AIMessage(
            content="",
            tool_calls=[{"name": "read", "args": {"path": "b.py"}, "id": "call_b"}],
        ),
        ToolMessage(content="result-b", tool_call_id="call_b"),
        AIMessage(
            content="",
            tool_calls=[{"name": "read", "args": {"path": "c.py"}, "id": "call_c"}],
        ),
        ToolMessage(content="result-c", tool_call_id="call_c"),
    ]


async def test_compact_drops_old_tool_results_but_keeps_transcript_valid():
    msgs = _make_transcript()
    # budget_chars=1 forces compaction of everything but the 2 newest.
    ran = await graph._compact_tool_history(msgs, compact_model=None, budget_chars=1)
    assert ran is True

    # Exactly one compacted ToolMessage should be appended.
    compacted = [m for m in msgs if isinstance(m, ToolMessage) and m.tool_call_id == "__compact__"]
    assert len(compacted) == 1

    # No AIMessage may reference a dropped tool_call_id ("call_a").
    dangling = [
        tc
        for m in msgs
        if isinstance(m, AIMessage)
        for tc in (m.tool_calls or [])
        if tc.get("id") == "call_a"
    ]
    assert dangling == [], "parent tool_calls for a dropped result must be neutralized"

    # The newest two tool calls must still be fully answered.
    surviving_ids = {m.tool_call_id for m in msgs if isinstance(m, ToolMessage)}
    assert "call_b" in surviving_ids
    assert "call_c" in surviving_ids

    # Every AIMessage tool_call must have a matching ToolMessage (valid transcript).
    answered = set()
    for m in msgs:
        if isinstance(m, AIMessage):
            for tc in (m.tool_calls or []):
                answered.add(tc.get("id"))
    for m in msgs:
        if isinstance(m, ToolMessage) and m.tool_call_id != "__compact__":
            assert m.tool_call_id in answered, "orphan ToolMessage without a parent call"


async def test_compact_noop_below_budget():
    msgs = _make_transcript()
    ran = await graph._compact_tool_history(msgs, compact_model=None, budget_chars=10_000_000)
    assert ran is False
    # Nothing removed.
    assert sum(1 for m in msgs if isinstance(m, ToolMessage)) == 3
