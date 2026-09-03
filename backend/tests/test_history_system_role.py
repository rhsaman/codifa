"""Regression tests: history system-role entries must become HumanMessage.

The frontend pushes compact summaries and mode-switch markers with
``role: 'system'`` (store.ts compactChat / setChatMode).  If those arrive as
``SystemMessage`` inside ``history_to_langchain_messages``, a second
SystemMessage lands at position > 0 and strict Jinja templates (Qwen3.5 etc.)
raise ``"System message must be at the beginning"``.

Fix: ``history_to_langchain_messages`` converts every ``role == "system"``
entry to ``HumanMessage`` instead of ``SystemMessage`` — preserving the
content for the model while keeping system_final clean at position 0.
"""

from langchain_core.messages import HumanMessage, SystemMessage

import graph

# ---------------------------------------------------------------------------
# 1. System-role entries become HumanMessage, not SystemMessage
# ---------------------------------------------------------------------------

def test_system_role_becomes_human_message():
    """Compact summary (role: 'system') must be HumanMessage."""
    history = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"},
        {
            "role": "system",
            "content": "Summary of earlier conversation: discussed project X.",
            "compactSummary": True,
        },
    ]
    msgs = graph.history_to_langchain_messages(history)
    # The system-role entry is at the end.
    last = msgs[-1]
    assert isinstance(last, HumanMessage), (
        f"role:'system' history entry became {type(last).__name__}, expected HumanMessage"
    )
    assert "Summary of earlier" in last.content


# ---------------------------------------------------------------------------
# 2. Mode-switch markers become HumanMessage
# ---------------------------------------------------------------------------

def test_mode_switch_becomes_human_message():
    """modeSwitch entries (role: 'system') must also be HumanMessage."""
    history = [
        {"role": "user", "content": "switch to plan"},
        {
            "role": "system",
            "content": "modeSwitch",
            "modeSwitch": True,
        },
        {"role": "user", "content": "now plan something"},
    ]
    msgs = graph.history_to_langchain_messages(history)
    system_entries = [m for m in msgs if isinstance(m, SystemMessage)]
    assert len(system_entries) == 0, (
        f"modeSwitch created {len(system_entries)} SystemMessage(s); expected 0"
    )
    # The modeSwitch should appear as HumanMessage.
    human_entries = [m for m in msgs if isinstance(m, HumanMessage)]
    mode_msgs = [m for m in human_entries if "modeSwitch" in m.content]
    assert len(mode_msgs) == 1, "modeSwitch marker not found as HumanMessage"


# ---------------------------------------------------------------------------
# 3. system_final stays at position 0 (no SystemMessage leak)
# ---------------------------------------------------------------------------

def test_system_message_only_at_position_zero():
    """After building messages the way build_turn_context does, the only
    SystemMessage should be at position 0 (system_final)."""
    history = [
        {"role": "user", "content": "hello"},
        {
            "role": "system",
            "content": "Compact: discussed X, Y, Z",
            "compactSummary": True,
        },
        {"role": "assistant", "content": "ok"},
    ]
    lc_history = graph.history_to_langchain_messages(history)
    # Simulate build_turn_context message assembly:
    #   messages = [SystemMessage(system_final)] + lc_history
    system_final = "You are a helpful assistant."
    messages = [SystemMessage(content=system_final)] + lc_history
    # Assert: only messages[0] is SystemMessage.
    sys_msgs = [i for i, m in enumerate(messages) if isinstance(m, SystemMessage)]
    assert sys_msgs == [0], (
        f"SystemMessage found at positions {sys_msgs}; expected only at [0]"
    )


# ---------------------------------------------------------------------------
# 4. Compact summary content is preserved in HumanMessage
# ---------------------------------------------------------------------------

def test_compact_summary_content_preserved():
    """The full compact summary text must survive the role conversion."""
    summary_text = (
        "Earlier discussion: the user asked about Qwen3.5 template errors. "
        "The agent identified that SystemMessage at position > 0 breaks "
        "the Jinja template. The fix converts role:'system' history entries "
        "to HumanMessage."
    )
    history = [
        {"role": "user", "content": "continue"},
        {"role": "system", "content": summary_text},
        {"role": "user", "content": "what were we discussing?"},
    ]
    msgs = graph.history_to_langchain_messages(history)
    # Find the converted HumanMessage containing the summary.
    human_contents = [m.content for m in msgs if isinstance(m, HumanMessage)]
    assert any(summary_text in c for c in human_contents), (
        "Compact summary text was lost during role conversion"
    )


# ---------------------------------------------------------------------------
# 5. Normal history (user/assistant/tool) is unchanged
# ---------------------------------------------------------------------------

def test_normal_history_unchanged():
    """Non-system roles must convert exactly as before."""
    history = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello", "toolActivity": [
            {"tool": "grep", "args": {"pattern": "foo"}, "callId": "tc-1",
             "items": [{"snippet": "found foo"}]}
        ]},
        {"role": "user", "content": "thanks"},
    ]
    msgs = graph.history_to_langchain_messages(history)
    types = [type(m).__name__ for m in msgs]
    # user -> HumanMessage, assistant+tool -> AIMessage + ToolMessage, user -> HumanMessage
    assert types == ["HumanMessage", "AIMessage", "ToolMessage", "HumanMessage"], (
        f"Unexpected message types: {types}"
    )
    # Content preserved.
    assert msgs[0].content == "hi"
    assert msgs[3].content == "thanks"
