"""Unit tests for opencode-parity context management (no live model needed).

Covers:
- `_usable_tokens` / `_recent_tail_budget` match opencode's `usable` / `preserveRecentBudget`.
- `_maybe_auto_compact` fires the `compact_start` -> `compact` event pair once the
  transcript reaches `usable`, and stays silent below it.
"""

import asyncio

import graph
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage


def test_usable_tokens_opencode_parity():
    # No output limit known -> opencode reserves 0 (usable == ctx).
    assert graph._agents._usable_tokens(200_000, 0, None) == 200_000
    # UI headroom (reserved) is honored directly.
    assert graph._agents._usable_tokens(200_000, 0, 20_000) == 180_000
    # Known max output -> opencode reserves min(20000, max_output).
    assert graph._agents._usable_tokens(200_000, 8192, None) == 200_000 - 8192
    # reserved is clamped to [0, ctx].
    assert graph._agents._usable_tokens(8000, 0, 200_000) == 0


def test_tail_budget_opencode_parity():
    # 200k window, 20k headroom -> usable 180k -> 25% = 45k, capped at 15000.
    assert graph._agents._recent_tail_budget(200_000, 0, 20_000) == 15_000
    # 8k window, max output 2048 -> reserved 2048 -> usable 6144 -> 25% = 1536,
    # floored at opencode's MIN_PRESERVE_RECENT_TOKENS (2000).
    assert graph._agents._recent_tail_budget(8192, 2048, None) == 2000


class _Queue:
    def __init__(self):
        self.items = []

    def put_nowait(self, x):
        self.items.append(x)


async def _run_trigger(messages, reserved=20_000, ctx=200_000):
    state = {"reserved": reserved, "max_history": 10}
    q = _Queue()
    await graph._maybe_auto_compact(state, q, None, None, messages, ctx)
    return [e["kind"] for e in q.items], q.items


def test_auto_compact_silent_below_usable():
    events, _ = asyncio.run(
        _run_trigger(
            [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="hello")],
        )
    )
    assert events == []


def test_auto_compact_fires_above_usable():
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        big = [SystemMessage(content="x" * 1000)] + [
            HumanMessage(content="y" * 800_000),
            AIMessage(content="z" * 800_000),
        ]
        events, items = asyncio.run(_run_trigger(big))
    finally:
        graph._agents._compact_history = original

    assert events == ["compact_start", "compact"]
    compact = [e for e in items if e["kind"] == "compact"][0]
    assert compact["keep"] == 3
    assert compact["content"].startswith("[Compacted earlier context]")


def test_messages_to_dicts_roles():
    dicts = graph._messages_to_dicts(
        [
            SystemMessage(content="s"),
            HumanMessage(content="h"),
            AIMessage(content="a"),
            ToolMessage(content="t", tool_call_id="x"),
        ]
    )
    assert [d["role"] for d in dicts] == ["system", "user", "assistant", "tool"]
    assert all("content" in d for d in dicts)
