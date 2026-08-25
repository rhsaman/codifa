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
    # All 100 items survive (the old cap was MAX_TOOL_ITEMS=50).
    for i in range(100):
        assert f"item-{i}-" in content, f"item {i} was dropped from the context"
    # The full long snippet survives (no 500-char truncation).
    assert long_snippet in content, "items were truncated before reaching the model"
    # `items` wins over `summary` — the short summary must not leak in.
    assert "short summary" not in content
