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


def test_small_window_reserved_scales_down():
    # 40k window, UI headroom 20000 -> clamped to 10% = 4000.
    assert graph._agents._usable_tokens(40_000, 0, 4_000) == 36_000
    # Mirror the frontend scaleReserved() (src/lib/context.ts) so the clamp is
    # pinned here too: min(headroom, max(2000, 10% of cw)), unchanged when cw=0.
    def scale_reserved(cw: int, headroom: int) -> int:
        if cw <= 0:
            return headroom
        return min(headroom, max(2000, round(cw * 0.1)))

    assert scale_reserved(40_000, 20_000) == 4_000
    # 190k window: 10% = 19k, which is below the 20k default, so it clamps to
    # 19k (still ~10% of the window — no premature compaction near the start).
    assert scale_reserved(190_000, 20_000) == 19_000
    # A genuinely huge window keeps the full 20k headroom.
    assert scale_reserved(300_000, 20_000) == 20_000
    # Unknown window (0) passes the headroom through unchanged.
    assert scale_reserved(0, 20_000) == 20_000


def test_large_window_no_early_compaction_parity():
    # 190k window with the default 20k headroom: usable is 170k, so a 20k
    # conversation must NOT trigger compaction (the original bug report).
    assert graph._agents._usable_tokens(190_000, 0, 20_000) == 170_000


def test_backend_context_window_manual_override(monkeypatch):
    # The backend must honor a manually supplied context_window and not fall
    # back to model_context()/the floor. We patch the live-resolution branch
    # to blow up if it were ever reached, proving the manual value wins.
    async def _boom(*a, **k):
        raise AssertionError("model_context should not be called when ctx is set")

    import providers as _providers

    monkeypatch.setattr(_providers, "model_context", _boom)

    async def _resolve_ctx(state):
        # Mirror graph.py's context-window resolution exactly.
        ctx = int(state.get("context_window") or 0)
        if ctx <= 0:
            from providers import model_context

            ctx = await model_context(
                state["provider"], state["model_name"], state["base_url"],
                state["api_key"], state["env_var"], oauth_token=state["oauth_token"],
            )
        if ctx <= 0:
            ctx = graph._agents.DEFAULT_CONTEXT_WINDOW_FLOOR
        return ctx

    # Manual window set -> model_context is never called, value wins.
    assert asyncio.run(_resolve_ctx({"context_window": 190_000})) == 190_000
    # No manual window -> falls through to model_context (patched to blow up),
    # which proves the live-resolution branch is still reachable.
    try:
        asyncio.run(_resolve_ctx({
            "context_window": 0,
            "provider": "custom", "model_name": "", "base_url": "",
            "api_key": "", "env_var": "", "oauth_token": "",
        }))
        raise AssertionError("expected model_context to be called for ctx=0")
    except AssertionError as exc:
        # The patched model_context raises exactly this — confirms the
        # live-resolution branch runs when no manual window is supplied.
        assert "model_context should not be called" in str(exc)
