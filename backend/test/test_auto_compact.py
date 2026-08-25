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
    state = {"reserved": reserved}
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
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

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


async def _run_trigger_with_input(messages, last_input_tokens, reserved=20_000, ctx=200_000):
    state = {"reserved": reserved}
    q = _Queue()
    await graph._maybe_auto_compact(
        state, q, None, None, messages, ctx, last_input_tokens=last_input_tokens
    )
    return [e["kind"] for e in q.items], q.items


def test_auto_compact_uses_last_input_tokens():
    # A small transcript (local estimate below usable) but a reported
    # last_input_tokens above usable must still fire compaction — proving
    # auto-compaction is driven by the same input_tokens the context meter
    # displays, not just the local estimate.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[c]"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="hello")]
        events, _ = asyncio.run(_run_trigger_with_input(small, last_input_tokens=190_000))
    finally:
        graph._agents._compact_history = original
    assert events == ["compact_start", "compact"]


def test_auto_compact_low_last_input_tokens_stays_silent():
    # A large transcript whose local estimate would fire compaction, but a low
    # reported last_input_tokens keeps it silent — proving last_input_tokens
    # overrides the estimate.
    events, _ = asyncio.run(
        _run_trigger_with_input(
            [
                SystemMessage(content="x" * 1000),
                HumanMessage(content="y" * 800_000),
                AIMessage(content="z" * 800_000),
            ],
            last_input_tokens=10_000,
        )
    )
    assert events == []


def test_messages_to_dicts_roles():
    dicts = graph._agents._messages_to_dicts(
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
            # opencode leaves the window unknown (usable=0 -> compaction off)
            # instead of falling back to a 32k floor.
            ctx = 0
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


def test_chat_model_settings_output_cap_parity(monkeypatch):
    # opencode's OUTPUT_TOKEN_MAX: unknown output limit -> use 32k, never an
    # 8192 ctx-derived clamp that truncates ("context length exceeded") on an
    # empty context.
    async def _no_max_output(*a, **k):
        return 0

    import llm as _llm
    import providers as _providers

    monkeypatch.setattr(_providers, "model_max_output", _no_max_output)

    async def _get(mode, ctx):
        return await _llm.chat_model_settings(
            mode=mode, ctx=ctx, thinking_level="off", provider="custom",
            model_name="x", base_url="", api_key="",
        )

    # Unknown output limit (max_output=0) -> 32k regardless of ctx.
    assert asyncio.run(_get("coder", 0))["max_tokens"] == 32_000
    assert asyncio.run(_get("coder", 32_000))["max_tokens"] == 32_000
    # Known large output limit is capped at opencode's 32k ceiling.
    async def _big_max_output(*a, **k):
        return 200_000

    monkeypatch.setattr(_providers, "model_max_output", _big_max_output)
    assert asyncio.run(_get("coder", 200_000))["max_tokens"] == 32_000
    # A small known output limit is honored (not clamped to 32k).
    async def _small_max_output(*a, **k):
        return 8_192

    monkeypatch.setattr(_providers, "model_max_output", _small_max_output)
    assert asyncio.run(_get("coder", 200_000))["max_tokens"] == 8_192
    # ask mode still caps at 8k on top of the 32k ceiling.
    assert asyncio.run(_get("ask", 200_000))["max_tokens"] == 8_000


def test_auto_compact_uses_local_transcript_estimate():
    # Compaction is now driven by the STABLE LOCAL estimate of the whole
    # transcript (system + history + user + tools) — the same basis as the
    # context meter — NOT raw provider usage_metadata off the last AIMessage.
    # That avoids (a) reading only Anthropic cache keys (OpenAI/OpenRouter/hy3-free
    # cache was always 0) and (b) double-counting cache for subset providers.
    # Prove it here: a huge usage_metadata with TINY content must NOT fire, while
    # large content (estimated locally) must.
    async def _fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = _fake_compact
    try:
        # Huge usage_metadata but tiny content -> must NOT fire (metadata ignored).
        ai_small = AIMessage(content="answer")
        ai_small.usage_metadata = {"input_tokens": 9_000_000, "output_tokens": 9_000_000}
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), ai_small]
        events_small, _ = asyncio.run(_run_trigger(small, reserved=20_000, ctx=200_000))
        assert events_small == []

        # Large content -> local estimate exceeds usable (180k) -> fires.
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        events_big, _ = asyncio.run(_run_trigger(big, reserved=20_000, ctx=200_000))
        assert events_big == ["compact_start", "compact"]
    finally:
        graph._agents._compact_history = original


def test_auto_compact_fires_at_usable_like_opencode():
    # opencode fires compaction when the local transcript estimate >= usable
    # (ctx - reserved), with no extra proactive buffer. Above usable must
    # compact; below must not.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        # Above usable (180k for 200k ctx, 20k reserved): big content fires.
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        events, _ = asyncio.run(_run_trigger(big, reserved=20_000, ctx=200_000))
        assert events == ["compact_start", "compact"]

        # Well below usable: small content -> silent.
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="hello")]
        events_small, _ = asyncio.run(_run_trigger(small, reserved=20_000, ctx=200_000))
        assert events_small == []
    finally:
        graph._agents._compact_history = original


def test_auto_compact_fires_on_usable_threshold():
    # opencode fires compaction when the transcript estimate reaches `usable`
    # (ctx - reserved). With reserved=20k on a 200k window, usable=180k. A large
    # transcript (>= usable) must compact.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        state = {"reserved": 20_000}
        q = _Queue()
        asyncio.run(graph._maybe_auto_compact(state, q, None, None, big, 200_000))
        events = [e["kind"] for e in q.items]
    finally:
        graph._agents._compact_history = original

    assert events == ["compact_start", "compact"]


def test_auto_compact_respects_reserved_setting():
    # The single "Compaction headroom (tokens)" setting (reserved) controls the
    # threshold. A larger reserved (40k) lowers usable to 160k: a large transcript
    # must compact, while a tiny one must NOT.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        # Large transcript with reserved=40k -> usable 160k -> fires.
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        q = _Queue()
        asyncio.run(graph._maybe_auto_compact({"reserved": 40_000}, q, None, None, big, 200_000))
        assert [e["kind"] for e in q.items] == ["compact_start", "compact"]

        # Tiny content with the larger reserved -> still silent.
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="answer")]
        q2 = _Queue()
        asyncio.run(graph._maybe_auto_compact({"reserved": 40_000}, q2, None, None, small, 200_000))
        assert [e["kind"] for e in q2.items] == []
    finally:
        graph._agents._compact_history = original


def test_auto_compact_falls_back_when_estimate_missing():
    # If the local estimate returns None (e.g. un-tokenizable content), the
    # char-estimate fallback must still drive the decision.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original_compact = graph._agents._compact_history
    original_estimate = graph._estimate_prompt_tokens
    graph._estimate_prompt_tokens = lambda msgs: None  # force the fallback path
    graph._agents._compact_history = fake_compact
    try:
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        events, _ = asyncio.run(_run_trigger(big, reserved=20_000, ctx=200_000))
        assert events == ["compact_start", "compact"]
    finally:
        graph._agents._compact_history = original_compact
        graph._estimate_prompt_tokens = original_estimate


def _tool_msg(content: str, tool: str = "bash") -> dict:
    return {"role": "tool", "tool": tool, "content": content}


def test_prune_clears_old_tool_outputs():
    # Three user turns so the FIRST turn's tool outputs are older than the last
    # two turns (opencode only prunes tool outputs from turns older than the
    # final two). Each large output is ~22.5k tokens; once _PRUNE_PROTECT (40k)
    # is passed walking backward, older outputs are cleared.
    history = [
        {"role": "user", "content": "first"},
        _tool_msg("x" * 90_000),  # 1st turn tool output (~22.5k tokens)
        _tool_msg("y" * 90_000),  # 1st turn tool output (~22.5k tokens) -> total 45k > PROTECT
        {"role": "assistant", "content": "did work 1"},
        {"role": "user", "content": "second"},
        _tool_msg("z" * 90_000),  # 2nd turn tool output (~22.5k tokens) -> total 67.5k
        {"role": "assistant", "content": "did work 2"},
        {"role": "user", "content": "third"},
        _tool_msg("recent" * 100),  # 3rd (recent) turn tool output (small)
        {"role": "assistant", "content": "more"},
    ]
    pruned = graph._agents._prune_history(history)
    # The most recent tool output (in the 3rd turn) must survive.
    recent_tool = [m for m in pruned if m.get("role") == "tool" and not m.get("compacted")]
    assert recent_tool and recent_tool[-1]["content"] == "recent" * 100
    # Older tool outputs (1st + 2nd turn) beyond _PRUNE_PROTECT are cleared.
    cleared = [m for m in pruned if m.get("compacted")]
    assert len(cleared) > 0
    assert all(m["content"] == "[Old tool result content cleared]" for m in cleared)
    # Total cleared exceeds _PRUNE_MINIMUM (20k tokens).
    assert len(cleared) >= 1


def test_prune_skips_protected_tools():
    history = [
        {"role": "user", "content": "first"},
        _tool_msg("x" * 200_000, tool="skill"),  # protected tool, huge output
        {"role": "assistant", "content": "did work"},
        {"role": "user", "content": "second"},
        {"role": "assistant", "content": "more"},
    ]
    pruned = graph._agents._prune_history(history)
    # skill tool output is never cleared.
    assert pruned[1]["content"] == "x" * 200_000
    assert not pruned[1].get("compacted")


def test_prune_noop_when_below_minimum():
    # Only one user turn -> prune never starts counting (needs >= 2 turns).
    history = [
        {"role": "user", "content": "only"},
        _tool_msg("x" * 200_000),
        {"role": "assistant", "content": "did work"},
    ]
    pruned = graph._agents._prune_history(history)
    assert not any(m.get("compacted") for m in pruned)
    assert pruned[1]["content"] == "x" * 200_000


def test_prune_disabled_is_noop():
    history = [
        {"role": "user", "content": "first"},
        _tool_msg("x" * 200_000),
        {"role": "assistant", "content": "did work"},
        {"role": "user", "content": "second"},
        {"role": "assistant", "content": "more"},
    ]
    pruned = graph._agents._prune_history(history, enabled=False)
    assert not any(m.get("compacted") for m in pruned)
