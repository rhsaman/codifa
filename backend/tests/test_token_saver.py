"""Tests for input-token savings without quality loss: map fast path,
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


# --- map fast path ----------------------------------------------------------


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
    assert "browser_navigate" in short, "behavioral rule must survive"
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


# --- output caps (token saver) ------------------------------------------------


def test_terminal_cap_is_10k():
    import tools

    assert tools.MAX_TERMINAL_OUTPUT == 10_000, (
        f"terminal cap must stay ~10K, got {tools.MAX_TERMINAL_OUTPUT}"
    )


def test_tool_out_chars_cap_is_8k():
    import inspect

    import tools

    src = inspect.getsource(tools.make_tool_callbacks)
    assert "8_000" in src, "tool_out_chars cap must be 8K"
    assert "16_000" not in src, "old 16K cap must be gone"


def test_exec_terminal_head_tail_truncation_preserves_tail(tmp_path):
    import tools

    code = "print('A' * 20000); print('TAIL_MARKER_XYZ')"
    _, output = tools._exec_terminal(
        f"python3 -c \"{code}\"", str(tmp_path), 30
    )
    assert len(output) <= tools.MAX_TERMINAL_OUTPUT + 200, len(output)
    assert "truncated" in output, "truncation marker must be present"
    assert "TAIL_MARKER_XYZ" in output, "tail (test summary) must survive"
    assert output.startswith("A"), "head must survive"


def test_terminal_tool_head_tail_truncation(tmp_path):
    async def _run():
        import tools

        cbs = tools.make_tool_callbacks(
            str(tmp_path), lambda ev: None, context_window=1_000_000
        )
        big = "y" * 50_000 + "FINAL_TAIL"
        (tmp_path / "big.txt").write_text(big)
        out = await cbs["run_terminal"](
            command="python3 -c \"print(open('big.txt').read())\""
        )
        return out

    out = asyncio.run(_run())
    assert "truncated" in out, "terminal tool must mark truncation"
    assert "FINAL_TAIL" in out, "tail must survive head+tail cut"
    # Capped near 8-10K, not the full 50K.
    assert len(out) < 20_000, len(out)


# --- solo update_plan ban -----------------------------------------------------


def test_update_plan_doc_bans_solo(tmp_path):
    import tools

    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    doc = cbs["update_plan"].__doc__ or ""
    assert "NEVER send update_plan alone" in doc, doc
    assert "a solo update_plan is fine" not in doc, doc


def test_plan_only_nudge_bans_solo():
    from llm import _PLAN_ONLY_NUDGE

    assert "solo update_plan is fine" not in _PLAN_ONLY_NUDGE
    assert "batch" in _PLAN_ONLY_NUDGE.lower()


def test_plan_reuse_note_bans_solo():
    from agents import _plan_reuse_note

    history = [
        {"mode": "build", "plan": [{"content": "do it", "status": "pending"}]}
    ]
    note = _plan_reuse_note(history)
    assert "NEVER send update_plan alone" in note, note


# --- turn-start truncation (compact still starts heavy) ----------------------


def test_truncate_old_tool_results_keeps_recent():
    msgs = []
    for i in range(5):
        tcid = f"t{i}"
        msgs.append(
            AIMessage(content="c", tool_calls=[{"id": tcid, "name": "read", "args": {}}])
        )
        msgs.append(ToolMessage(content="x" * 5000, tool_call_id=tcid))
    n = graph._truncate_old_tool_results(msgs)
    by_id = {m.tool_call_id: str(m.content) for m in msgs if isinstance(m, ToolMessage)}
    assert n == 2, "5 steps, keep last 3 verbatim -> truncate first 2"
    assert by_id["t0"].startswith("[truncated read(")
    assert by_id["t1"].startswith("[truncated read(")
    assert len(by_id["t4"]) == 5000, "recent step must stay verbatim"


def test_update_plan_accepts_text_title_aliases(tmp_path):
    import asyncio

    import tools

    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = asyncio.run(
        cbs["update_plan"](
            items=[
                {"text": "do backend fix", "status": "in_progress"},
                {"title": "run tests", "status": "pending"},
            ]
        )
    )
    assert not out.startswith("ERROR"), out
    assert "0/2" in out, out
