"""Tests for the perf/cost fixes: grep budget, cheap-truncation batching,
computer filtering, direct-Anthropic cache, and the parallel_tool_calls opt-in.
"""
import asyncio

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

import graph
import llm


class _Queue:
    def __init__(self):
        self.items = []

    def put_nowait(self, x):
        self.items.append(x)


def _tool_pair(tcid, name="read", args=None, size=60_000):
    return [
        AIMessage(content="call", tool_calls=[{"id": tcid, "name": name, "args": args or {}}]),
        ToolMessage(content="x" * size, tool_call_id=tcid, name=name),
    ]


def test_cheap_truncation_placeholder_names_tool_and_args():
    async def _run():
        msgs = [SystemMessage(content="sys")]
        for i in range(8):
            msgs += _tool_pair(f"t{i}", name="read", args={"path": f"f{i}.py"})
        q = _Queue()
        await graph._maybe_auto_compact(
            {"compact_at_percent": 99}, q, None, None, msgs, 200_000,
            last_context_tokens=0,
        )
        return msgs, q.items

    msgs, events = asyncio.run(_run())
    assert events == []
    truncated = [m for m in msgs if isinstance(m, ToolMessage) and str(m.content).startswith("[truncated ")]
    assert truncated, "expected meaningful placeholders"
    assert any("read" in str(m.content) and "f0.py" in str(m.content) for m in truncated)
    # Recent steps stay verbatim.
    assert any(isinstance(m, ToolMessage) and m.content == "x" * 60_000 for m in msgs)


def test_cheap_truncation_skips_rerun_until_regrow():
    async def _run(state):
        msgs = [SystemMessage(content="sys")]
        for i in range(8):
            msgs += _tool_pair(f"t{i}")
        q = _Queue()
        await graph._maybe_auto_compact(
            state, q, None, None, msgs, 200_000, last_context_tokens=0,
        )
        return msgs

    state = {"compact_at_percent": 99}
    msgs = asyncio.run(_run(state))
    assert state.get("_cheap_truncated_at"), "first pass must record its size"
    before = [str(getattr(m, "content", "")) for m in msgs]
    # Second run on the same transcript must not rewrite anything new.
    msgs2 = asyncio.run(_run(state))
    after = [str(getattr(m, "content", "")) for m in msgs2]
    assert before == after


def test_computer_filtered_without_grant_or_intent():
    tools = {"computer": lambda: None, "read": lambda: None, "grep": lambda: None}
    out = graph.filter_tools_for_mode("coder", dict(tools), {}, set(), True, False, prompt="fix the bug")
    assert "computer" not in out
    assert "read" in out


def test_computer_kept_with_allow_computer():
    tools = {"computer": lambda: None, "read": lambda: None}
    out = graph.filter_tools_for_mode(
        "coder", dict(tools), {}, set(), True, False, prompt="fix the bug", allow_computer=True,
    )
    assert "computer" in out


def test_computer_kept_with_desktop_intent():
    tools = {"computer": lambda: None, "read": lambda: None}
    out = graph.filter_tools_for_mode(
        "coder", dict(tools), {}, set(), True, False, prompt="take a screenshot of the desktop app",
    )
    assert "computer" in out


def test_computer_kept_with_chrome_tab_intent():
    tools = {"computer": lambda: None, "read": lambda: None}
    out = graph.filter_tools_for_mode(
        "coder", dict(tools), {}, set(), True, False,
        prompt="look at my open chrome tabs and check the tradingview chart",
    )
    assert "computer" in out


def test_computer_tab_hint_needs_word_boundary():
    tools = {"computer": lambda: None, "read": lambda: None}
    out = graph.filter_tools_for_mode(
        "coder", dict(tools), {}, set(), True, False, prompt="fix the database table",
    )
    assert "computer" not in out


def test_computer_kept_via_history_intent():
    tools = {"computer": lambda: None, "read": lambda: None}
    history = [{"role": "user", "content": "look at my open chrome tabs"}]
    out = graph.filter_tools_for_mode(
        "coder", dict(tools), {}, set(), True, False, prompt="continue", history=history,
    )
    assert "computer" in out


def test_checkpoint_throttled_and_forced():
    # Default is save-every-step now (disconnects lost tool results), so pin
    # the throttle MECHANISM with a wider window instead of the default.
    graph._checkpoint_state.pop("thr", None)
    orig_n = graph._CHECKPOINT_EVERY_N_STEPS
    graph._CHECKPOINT_EVERY_N_STEPS = 3
    msgs = [HumanMessage(content="hi")]
    calls = 0

    async def _fake_save(thread_id, messages, mode="", plan=None):
        nonlocal calls
        calls += 1

    orig = graph._save_turn_checkpoint
    graph._save_turn_checkpoint = _fake_save
    try:
        asyncio.run(graph._save_turn_checkpoint_valid("thr", msgs))
        asyncio.run(graph._save_turn_checkpoint_valid("thr", msgs))
        assert calls == 1, f"expected throttled saves, got {calls}"
        asyncio.run(graph._save_turn_checkpoint_valid("thr", msgs, force=True))
        assert calls == 2
    finally:
        graph._save_turn_checkpoint = orig
        graph._CHECKPOINT_EVERY_N_STEPS = orig_n
        graph._checkpoint_state.pop("thr", None)


def test_parallel_tool_calls_opt_in_only():
    m = llm.build_chat_model(
        provider="openrouter", model="x", base_url="https://openrouter.ai/api/v1", api_key="k",
    )
    assert "parallel_tool_calls" not in (m.model_kwargs or {})
    m2 = llm.build_chat_model(
        provider="openrouter", model="x", base_url="https://openrouter.ai/api/v1", api_key="k",
        parallel_tool_calls=True,
    )
    assert (m2.model_kwargs or {}).get("parallel_tool_calls") is True
    # Providers without the capability never get the flag, even on opt-in.
    m3 = llm.build_chat_model(provider="ollama", model="x", base_url="", api_key="", parallel_tool_calls=True)
    assert "parallel_tool_calls" not in (m3.model_kwargs or {})
