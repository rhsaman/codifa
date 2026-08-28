"""Tests that the full tool result (`items`) reaches the provider untruncated.

The frontend now sends the COMPLETE `toolActivity.items` (store.ts no longer
trims them), and `history_to_langchain_messages` must reconstruct those into
ToolMessages verbatim — so the provider receives the full context, not a
500-char snippet or a 50-row cap. This is the fix for "context sent short /
a message summarized incompletely".
"""

from langchain_core.messages import ToolMessage

import graph


def test_history_to_langchain_keeps_full_items():
    # A snippet far longer than the old 500-char cap must survive intact.
    long_snippet = "y" * 5000
    many_items = [{"snippet": f"item-{i}-" + "z" * 100} for i in range(100)]
    # One extra item carries a snippet far longer than the old 500-char cap.
    many_items.append({"snippet": long_snippet})
    history = [
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "ran a tool",
            "toolActivity": [
                {
                    "tool": "read",
                    "args": {"path": "a.py"},
                    "status": "done",
                    "items": many_items,
                    "summary": "short summary (must NOT be used when items present)",
                }
            ],
        },
    ]
    msgs = graph.history_to_langchain_messages(history)
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert tool_msgs, "expected a ToolMessage rebuilt from toolActivity"
    content = tool_msgs[0].content
    # All 100 items survive (the old cap was MAX_TOOL_ITEMS=50). Item 50's
    # snippet was deliberately replaced with `long_snippet` (see above), so it
    # no longer contains the "item-50-" prefix — skip that one here.
    for i in range(100):
        if i == 50:
            continue
        assert f"item-{i}-" in content, f"item {i} was dropped from the context"
    # The full long snippet survives (no 500-char truncation).
    assert long_snippet in content, "items were truncated before reaching the model"
    # `items` wins over `summary` — the short summary must not leak in.
    assert "short summary" not in content


def test_history_items_flattened_to_tool_message():
    """`items` (list of dicts) must become readable text in the ToolMessage,
    NOT a python `str()` of the list (e.g. "[{'snippet': '...'}]") — otherwise
    the model can't read the result and re-executes the tool on reconnect,
    wasting context."""
    history = [
        {"role": "user", "content": "find foo"},
        {
            "role": "assistant",
            "content": "searching",
            "toolActivity": [
                {
                    "tool": "grep",
                    "args": {"pattern": "foo"},
                    "callId": 7,
                    "status": "done",
                    "items": [
                        {"snippet": "line1 foo"},
                        {"snippet": "line2 foo"},
                    ],
                }
            ],
        },
    ]
    msgs = graph.history_to_langchain_messages(history)
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert tool_msgs, "expected a ToolMessage rebuilt from toolActivity"
    content = tool_msgs[0].content
    assert "line1 foo" in content and "line2 foo" in content
    # Must NOT be the ugly python list repr.
    assert content.strip().startswith("line1") and "[" not in content
    # callId must be preserved so the AIMessage tool_call id matches.
    ai_msgs = [m for m in msgs if getattr(m, "tool_calls", None)]
    assert ai_msgs, "expected an AIMessage with tool_calls"
    assert ai_msgs[0].tool_calls[0]["id"] == "7"
