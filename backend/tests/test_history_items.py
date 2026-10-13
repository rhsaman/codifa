"""Tests for tool results reconstructed from PAST turns' toolActivity.

Two contracts live together:
- Flattening: `items` must become readable text (never a python repr),
  and reasonably-sized results reach the provider intact (the old bugs:
  500-char snippet cap, 50-item cap).
- Deterministic cap: oversized PAST-turn results are truncated with a
  pointer (graph._HISTORY_TOOL_RESULT_MAX_CHARS). Without it one large
  read/grep output is replayed IN FULL on every step of every later
  turn -- the 100K+ token request bases measured in live traces.
"""

from langchain_core.messages import ToolMessage

import graph


def test_history_to_langchain_keeps_full_items():
    # 100 TINY items stay well under the deterministic cap: the old 50-item
    # cap is still gone, and nothing is char-truncated at this size.
    many_items = [{"snippet": f"item-{i}-" + "z" * 10} for i in range(100)]
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
    assert "...(truncated history tool result" not in content
    # `items` wins over `summary` — the short summary must not leak in.
    assert "short summary" not in content


def test_history_tool_result_capped_deterministically():
    """An oversized PAST-turn result is capped with a re-run pointer.

    The full output already lived in ITS turn; replaying it verbatim on
    every later step is what inflated request bases to 100K+ tokens.
    """
    big = "y" * 20000
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
                    "items": [{"snippet": big}],
                }
            ],
        },
    ]
    msgs = graph.history_to_langchain_messages(history)
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    content = tool_msgs[0].content
    cap = graph._HISTORY_TOOL_RESULT_MAX_CHARS
    assert len(content) < cap + 200, "oversized history result was not capped"
    assert content.startswith("y" * 100), "cap must keep the head of the result"
    assert "re-run the tool for the full output" in content
    assert "20000 chars total" in content


def test_history_tool_results_total_budget_stubs_oldest(monkeypatch):
    """Beyond the TOTAL budget the OLDEST results become stubs while the
    NEWEST stay verbatim — the request base stays bounded no matter how
    many tools ran in earlier turns (dozens of 4K-capped results still
    summed to 150K-token bases in live traces)."""
    monkeypatch.setattr(graph, "_HISTORY_TOOL_RESULTS_BUDGET_CHARS", 5000)
    big = "x" * 3000  # under the per-result cap; only the total budget binds
    history = [
        {"role": "user", "content": "go"},
        {
            "role": "assistant",
            "content": "old turn",
            "toolActivity": [
                {
                    "tool": "read",
                    "args": {"path": "old.py"},
                    "status": "done",
                    "items": [{"snippet": big}],
                }
            ],
        },
        {"role": "user", "content": "again"},
        {
            "role": "assistant",
            "content": "new turn",
            "toolActivity": [
                {
                    "tool": "read",
                    "args": {"path": "new.py"},
                    "status": "done",
                    "items": [{"snippet": big}],
                }
            ],
        },
    ]
    msgs = graph.history_to_langchain_messages(history)
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 2
    # Newest result is allocated first from the budget: stays verbatim.
    assert "x" * 100 in tool_msgs[1].content
    assert "older tool result omitted" not in tool_msgs[1].content
    # The oldest (beyond the budget) becomes a short stub with a pointer.
    assert "older tool result omitted" in tool_msgs[0].content
    assert len(tool_msgs[0].content) < 200


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
