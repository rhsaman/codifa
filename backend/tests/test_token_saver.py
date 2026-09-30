"""Tests for input-token savings without quality loss: CODE MAP laya gate,
cheap-truncation reference exemption, two-tier tool-reuse note, and the
short MCP reminder (full note only on first sight / server change).
"""
import asyncio
import types

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

import agents
import graph


class _Queue:
    def __init__(self):
        self.items = []

    def put_nowait(self, x):
        self.items.append(x)


def _gate_decision(handled=True, value="no_code_map", confidence=0.9):
    return types.SimpleNamespace(handled=handled, value=value, confidence=confidence)


# --- CODE MAP laya gate -----------------------------------------------------


def test_code_map_gate_skips_on_confident_no_map():
    assert graph._code_map_gate_skips(set(), set(), _gate_decision()) is True


def test_code_map_gate_sends_on_any_mention():
    d = _gate_decision()
    assert graph._code_map_gate_skips({"a.py"}, set(), d) is False
    assert graph._code_map_gate_skips(set(), {"my_func"}, d) is False


def test_code_map_gate_sends_on_abstain_or_weak_signal():
    assert graph._code_map_gate_skips(set(), set(), _gate_decision(handled=False)) is False
    assert graph._code_map_gate_skips(set(), set(), _gate_decision(confidence=0.5)) is False
    assert graph._code_map_gate_skips(set(), set(), _gate_decision(value="needs_code_map")) is False


def test_code_map_gate_sends_on_malformed_decision():
    assert graph._code_map_gate_skips(set(), set(), None) is False
    assert graph._code_map_gate_skips(set(), set(), object()) is False


# --- task-signal / skill auto-pick / map fast path ---------------------------


def _ranked(*pairs):
    return [{"name": n, "confidence": c} for n, c in pairs]


def test_task_signal_greeting_fresh_is_false():
    assert graph._turn_task_signal("سلام", []) is False
    assert graph._turn_task_signal("چطوری؟", []) is False


def test_task_signal_greeting_with_greeting_history_is_false():
    history = [
        {"role": "user", "content": "سلام"},
        {"role": "assistant", "content": "سلام! چطور می‌تونم کمکتون کنم؟"},
    ]
    assert graph._turn_task_signal("چطوری؟", history) is False


def test_task_signal_true_cases():
    assert graph._turn_task_signal("یه دکمه لاگین به فرم اضافه کن که وسط‌چین باشه", []) is True
    assert graph._turn_task_signal("fix it", []) is True  # latin token: fail-open
    assert graph._turn_task_signal("fix build_graph", []) is True
    assert graph._turn_task_signal("look at backend/graph.py", []) is True
    hist = [{"role": "assistant", "toolActivity": [{"tool": "read"}]}]
    assert graph._turn_task_signal("thanks", hist) is True


def test_skill_auto_pick_rejects_flat_noise():
    # Greeting-like scores: everything ~0.7, no distinctive winner.
    assert graph._skill_auto_pick(_ranked(("impeccable", 0.74), ("caveman", 0.72)), True) == ""
    assert graph._skill_auto_pick(_ranked(("movie-finder", 0.77), ("translation", 0.75)), True) == ""


def test_skill_auto_pick_accepts_strong_match():
    assert (
        graph._skill_auto_pick(_ranked(("landing-page-design", 0.92), ("other", 0.5)), True)
        == "landing-page-design"
    )


def test_skill_auto_pick_no_signal_or_weak():
    assert graph._skill_auto_pick(_ranked(("a", 0.95), ("b", 0.4)), False) == ""
    assert graph._skill_auto_pick(_ranked(("a", 0.6), ("b", 0.4)), True) == ""
    assert graph._skill_auto_pick([], True) == ""


def test_obvious_non_code_turn():
    assert graph._obvious_non_code_turn("سلام", []) is True
    hist = [
        {"role": "user", "content": "سلام"},
        {"role": "assistant", "content": "سلام! چطور می‌تونم کمکتون کنم؟"},
    ]
    assert graph._obvious_non_code_turn("چطوری؟", hist) is True
    assert graph._obvious_non_code_turn("این تابع build_graph چی کار می‌کنه؟", []) is False
    assert graph._obvious_non_code_turn("یه فرم لاگین کامل با اعتبارسنجی بساز", []) is False
    code_hist = [{"role": "assistant", "toolActivity": [{"tool": "read"}]}]
    assert graph._obvious_non_code_turn("ممنون", code_hist) is False
    assert graph._obvious_non_code_turn("", []) is False


# --- tool-reuse note tiers --------------------------------------------------


def _act(tool, args, status="done", summary="ok"):
    return {"tool": tool, "args": args, "status": status, "summary": summary}


def test_tool_reuse_note_short_without_repetition():
    history = [
        {"role": "assistant", "toolActivity": [_act("read", {"path": "a.py"})]},
        {"role": "assistant", "toolActivity": [_act("grep", {"pattern": "foo"})]},
    ]
    note = agents._tool_reuse_note(history)
    assert note, "preventive reminder must still be present"
    assert "- read(" not in note, "no full listing without real repetition"
    assert len(note) < 500


def test_tool_reuse_note_full_on_real_repetition():
    history = [
        {"role": "assistant", "toolActivity": [_act("read", {"path": "a.py"})]},
        {"role": "assistant", "toolActivity": [_act("read", {"path": "a.py"})]},
    ]
    note = agents._tool_reuse_note(history)
    assert "- read(" in note, "repeated call must trigger the full listing"


def test_tool_reuse_note_error_retry_is_not_repetition():
    history = [
        {"role": "assistant", "toolActivity": [_act("fetch_url", {"url": "u"}, status="error")]},
        {"role": "assistant", "toolActivity": [_act("fetch_url", {"url": "u"}, status="error")]},
    ]
    note = agents._tool_reuse_note(history)
    assert note
    assert "- fetch_url(" not in note, "error retries are legitimate, not a loop"


def test_tool_reuse_note_empty_without_activity():
    assert agents._tool_reuse_note([{"role": "user", "content": "hi"}]) == ""


# --- MCP note short/full ----------------------------------------------------


def _mcp_tool(name):
    return types.SimpleNamespace(name=name, metadata={})


def test_mcp_note_full_first_then_short():
    if isinstance(getattr(graph._mcp_note_for_turn, "_last_sig", None), dict):
        graph._mcp_note_for_turn._last_sig.clear()
    tools = [_mcp_tool("mcp__browser__navigate")]
    full = graph._mcp_note_for_turn(tools, True, "chat-1")
    assert "MCP CONNECTORS" in full
    short = graph._mcp_note_for_turn(tools, True, "chat-1")
    assert "MCP CONNECTORS" not in short
    assert "web_search is DISABLED" in short, "behavioral rule must survive"
    # Server change re-sends the full note.
    tools2 = tools + [_mcp_tool("mcp__files__read")]
    full2 = graph._mcp_note_for_turn(tools2, True, "chat-1")
    assert "MCP CONNECTORS" in full2
    # Other chats are independent.
    full3 = graph._mcp_note_for_turn(tools, True, "chat-2")
    assert "MCP CONNECTORS" in full3


# --- cheap-truncation reference exemption -----------------------------------


def _tool_pair(tcid, content, name="read", args=None):
    return [
        AIMessage(content="call", tool_calls=[{"id": tcid, "name": name, "args": args or {}}]),
        ToolMessage(content=content, tool_call_id=tcid, name=name),
    ]


def test_cheap_truncation_exempts_referenced_result():
    async def _run():
        msgs = [SystemMessage(content="sys")]
        ref_content = "result of backend/graph.py read ... " + "y" * 60_000
        msgs += _tool_pair("t0", ref_content, args={"path": "backend/graph.py"})
        msgs += _tool_pair("t1", "z" * 60_000, args={"path": "other.py"})
        for i in range(2, 8):
            msgs += _tool_pair(f"t{i}", "x" * 60_000, args={"path": f"f{i}.py"})
        msgs.append(HumanMessage(content="look at backend/graph.py again, is it fine?"))
        q = _Queue()
        await graph._maybe_auto_compact(
            {"compact_at_percent": 99}, q, None, None, msgs, 200_000,
            last_context_tokens=0,
        )
        return msgs

    msgs = asyncio.run(_run())
    by_id = {m.tool_call_id: str(m.content) for m in msgs if isinstance(m, ToolMessage)}
    assert "backend/graph.py" in by_id["t0"], "referenced result must stay verbatim"
    assert by_id["t1"].startswith("[truncated "), "unreferenced old result still truncates"
