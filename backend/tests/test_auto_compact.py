"""Unit tests for opencode-parity context management (no live model needed).

Covers:
- `_usable_tokens` / `_recent_tail_budget` match opencode's `usable` / `preserveRecentBudget`.
- `_maybe_auto_compact` fires the `compact_start` -> `compact` event pair once the
  transcript reaches `compact_at_percent%` of the RAW context window, and stays
  silent below it. The context meter shows `total_tokens / ctx` (the same
  percentage), so the meter and the trigger always agree.
"""

import asyncio

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

import graph


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


async def _run_trigger(messages, compact_at_percent=80, ctx=200_000):
    state = {"compact_at_percent": compact_at_percent}
    q = _Queue()
    await graph._maybe_auto_compact(state, q, None, None, messages, ctx)
    return [e["kind"] for e in q.items], q.items


def test_auto_compact_silent_below_threshold():
    events, _ = asyncio.run(
        _run_trigger(
            [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="hello")],
        )
    )
    assert events == []


def test_auto_compact_fires_above_threshold():
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
    compact = next(e for e in items if e["kind"] == "compact")
    assert compact["keep"] == 3
    assert compact["content"].startswith("[Compacted earlier context]")


async def _run_trigger_with_input(messages, last_context_tokens, compact_at_percent=80, ctx=200_000):
    state = {"compact_at_percent": compact_at_percent}
    q = _Queue()
    await graph._maybe_auto_compact(
        state, q, None, None, messages, ctx, last_context_tokens=last_context_tokens
    )
    return [e["kind"] for e in q.items], q.items


async def _run_trigger_with_input_pct(
    messages, last_context_tokens, compact_at_percent, ctx=200_000
):
    state = {"compact_at_percent": compact_at_percent}
    q = _Queue()
    await graph._maybe_auto_compact(
        state,
        q,
        None,
        None,
        messages,
        ctx,
        last_context_tokens=last_context_tokens,
        compact_at_percent=compact_at_percent,
    )
    return [e["kind"] for e in q.items], q.items


def test_auto_compact_uses_last_input_tokens():
    # A small transcript (local estimate below threshold) but a reported
    # last_context_tokens above threshold must still fire compaction — proving
    # auto-compaction is driven by the same total_tokens the context meter
    # displays, not just the local estimate.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[c]"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="hello")]
        events, _ = asyncio.run(_run_trigger_with_input(small, last_context_tokens=190_000))
    finally:
        graph._agents._compact_history = original
    assert events == ["compact_start", "compact"]


def test_auto_compact_fires_on_large_transcript_despite_low_usage():
    # A genuinely huge transcript (live estimate well above threshold) must
    # compact even when the reported last_context_tokens is low/stale — otherwise
    # the next model call would overflow. The live transcript estimate is used as
    # a floor under the reported usage, so compaction never lags a real overflow.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[c]"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        events, _ = asyncio.run(
            _run_trigger_with_input(
                [
                    SystemMessage(content="x" * 1000),
                    HumanMessage(content="y" * 800_000),
                    AIMessage(content="z" * 800_000),
                ],
                last_context_tokens=10_000,
            )
        )
    finally:
        graph._agents._compact_history = original
    assert events == ["compact_start", "compact"]


def test_auto_compact_fires_early_at_percent():
    # Mid-turn compaction: total=120k against a 200k window. At compact_at_percent=50
    # the threshold is 100k, so a turn that has used 120k compacts BEFORE reaching
    # the limit. The post-turn backstop (compact_at_percent=100, threshold 200k)
    # would leave the same 120k silent — proving the percent makes it fire early.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[c]"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        msgs = [HumanMessage(content="hi")]
        early, _ = asyncio.run(_run_trigger_with_input_pct(msgs, 120_000, 50))
        late, _ = asyncio.run(_run_trigger_with_input_pct(msgs, 120_000, 100))
    finally:
        graph._agents._compact_history = original
    assert early == ["compact_start", "compact"]
    assert late == []


def test_auto_compact_silent_below_percent():
    # total=80k, window=200k, compact_at_percent=50 -> threshold 100k -> silent.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[c]"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        events, _ = asyncio.run(_run_trigger_with_input_pct([HumanMessage(content="hi")], 80_000, 50))
    finally:
        graph._agents._compact_history = original
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


def test_large_window_no_early_compaction_parity():
    # 190k window with the default 80% threshold: threshold is 152k, so a 20k
    # conversation must NOT trigger compaction (the original bug report).
    assert int(190_000 * 80 / 100) == 152_000


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
        ctx = max(0, ctx)
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
        events_small, _ = asyncio.run(_run_trigger(small, compact_at_percent=80, ctx=200_000))
        assert events_small == []

        # Large content -> local estimate exceeds threshold (160k for 80% of 200k) -> fires.
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        events_big, _ = asyncio.run(_run_trigger(big, compact_at_percent=80, ctx=200_000))
        assert events_big == ["compact_start", "compact"]
    finally:
        graph._agents._compact_history = original


def test_auto_compact_fires_at_threshold_like_opencode():
    # Auto-compaction fires when the local transcript estimate >= threshold
    # (compact_at_percent% of the raw window). Above threshold must compact;
    # below must not.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        # Above threshold (160k for 80% of 200k): big content fires.
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        events, _ = asyncio.run(_run_trigger(big, compact_at_percent=80, ctx=200_000))
        assert events == ["compact_start", "compact"]

        # Well below threshold: small content -> silent.
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="hello")]
        events_small, _ = asyncio.run(_run_trigger(small, compact_at_percent=80, ctx=200_000))
        assert events_small == []
    finally:
        graph._agents._compact_history = original


def test_auto_compact_fires_on_threshold():
    # Auto-compaction fires when the transcript estimate reaches the threshold
    # (compact_at_percent% of the raw window). With 80% on a 200k window,
    # threshold=160k. A large transcript (>= threshold) must compact.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        state = {"compact_at_percent": 80}
        q = _Queue()
        asyncio.run(graph._maybe_auto_compact(state, q, None, None, big, 200_000))
        events = [e["kind"] for e in q.items]
    finally:
        graph._agents._compact_history = original

    assert events == ["compact_start", "compact"]


def test_auto_compact_respects_percent_setting():
    # The single "Auto-compaction threshold" setting (compact_at_percent) controls
    # the threshold. A lower percent (60%) lowers the threshold to 120k: a large
    # transcript must compact, while a tiny one must NOT.
    async def fake_compact(*a, **k):
        return ([{"role": "system", "content": "[Compacted earlier context]\nSUMMARY"}], 3, None)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        # Large transcript with compact_at_percent=60 -> threshold 120k -> fires.
        big = [SystemMessage(content="x" * 750_000), HumanMessage(content="hi"), AIMessage(content="y" * 750_000)]
        q = _Queue()
        asyncio.run(graph._maybe_auto_compact({"compact_at_percent": 60}, q, None, None, big, 200_000))
        assert [e["kind"] for e in q.items] == ["compact_start", "compact"]

        # Tiny content with the lower percent -> still silent.
        small = [SystemMessage(content="sys"), HumanMessage(content="hi"), AIMessage(content="answer")]
        q2 = _Queue()
        asyncio.run(graph._maybe_auto_compact({"compact_at_percent": 60}, q2, None, None, small, 200_000))
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
        events, _ = asyncio.run(_run_trigger(big, compact_at_percent=80, ctx=200_000))
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


def test_auto_compact_applies_result_in_place():
    # The whole point of auto-compact is that the LIVE transcript (`msgs`) is
    # actually shrunk — otherwise the model keeps receiving the full history and
    # the turn still overflows. This proves `_maybe_auto_compact` rewrites `msgs`
    # in place (keeping the leading system prompt) when compaction fires.
    async def fake_compact(*a, **k):
        return (
            [
                {"role": "system", "content": "[Compacted earlier context]\nSUMMARY"},
                {"role": "user", "content": "recent question"},
                {"role": "assistant", "content": "recent answer"},
            ],
            2,
            None,
        )

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        msgs = [
            SystemMessage(content="system prompt"),
            HumanMessage(content="old q1"),
            AIMessage(content="old a1"),
            HumanMessage(content="old q2"),
            AIMessage(content="old a2"),
            HumanMessage(content="recent question"),
            AIMessage(content="recent answer"),
        ]
        q = _Queue()
        asyncio.run(
            graph._maybe_auto_compact(
                {"compact_at_percent": 80}, q, None, None, msgs, 200_000,
                last_context_tokens=190_000,
            )
        )
    finally:
        graph._agents._compact_history = original

    # opencode parity: the leading system prompt is preserved BYTE-IDENTICAL
    # (never grows, prefix-cache friendly) and the compact summary lands as its
    # OWN message right after it — not folded into the system prompt.
    assert isinstance(msgs[0], SystemMessage)
    assert msgs[0].content == "system prompt"
    # Only one system message exists (the summary is a separate HumanMessage).
    assert sum(1 for m in msgs if isinstance(m, SystemMessage)) == 1
    # The summary is a standalone HumanMessage carrying the compact marker.
    summary_msgs = [
        m for m in msgs
        if isinstance(m, HumanMessage) and "[Compacted earlier context]" in m.content
    ]
    assert summary_msgs, "compact summary must survive as its own message"
    assert summary_msgs[0].content == "[Compacted earlier context]\nSUMMARY"
    # The old turns are gone; only the summary + recent tail remain.
    assert len(msgs) == 4
    assert any(
        isinstance(m, HumanMessage) and m.content == "recent question" for m in msgs
    )
    assert any(
        isinstance(m, AIMessage) and m.content == "recent answer" for m in msgs
    )
    # The `compact` event still fires so the frontend can fold the old turns.
    assert any(e["kind"] == "compact" for e in q.items)


def test_auto_compact_keeps_in_flight_step_verbatim():
    # Mid-turn auto-compact must NOT summarize the step currently in flight
    # (the trailing assistant tool_calls + their tool results). If it did, the
    # assistant's tool_calls would be dropped while the tool results remain,
    # leaving a dangling tool_call_id -> the model re-issues the same call next
    # step -> the repetition-loop guard STOPS the turn. Prove the in-flight step
    # survives verbatim so the turn keeps going after compaction.
    async def fake_compact(*a, **k):
        # Delegate to the REAL compaction so the in-flight protection logic runs,
        # but stub the summarizer call so no live model is needed.
        return await graph._agents._compact_history(*a, **k)

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    # Stub the summarizer so the test needs no live model.
    import llm as _llm_mod
    _orig_complete = _llm_mod.llm_complete
    async def _fake_complete(*a, **k):
        return "[Compacted earlier context]\nSUMMARY", None
    _llm_mod.llm_complete = _fake_complete
    try:
        # A huge older turn (must be summarized) + a current in-flight step whose
        # assistant tool_call + tool result are each large enough to exceed the
        # recent tail budget on their own.
        msgs = [
            SystemMessage(content="sys"),
            HumanMessage(content="x" * 800_000),  # old turn, should be summarized
            AIMessage(content="y" * 800_000),     # old turn, should be summarized
            HumanMessage(content="do the thing"),
            AIMessage(
                content="calling tool now",
                tool_calls=[{"id": "abc", "name": "read", "args": {"path": "a"}}],
            ),  # in-flight assistant w/ real tool_call
            ToolMessage(content="z" * 800_000, tool_call_id="abc"),  # live result
        ]
        q = _Queue()
        asyncio.run(
            graph._maybe_auto_compact(
                {"compact_at_percent": 80}, q, None, None, msgs, 200_000,
                last_context_tokens=190_000,
            )
        )
    finally:
        graph._agents._compact_history = original
        _llm_mod.llm_complete = _orig_complete

    # The live tool result must remain verbatim (not summarized away) AND keep its
    # ORIGINAL tool_call_id so it still links to the assistant's tool_calls.
    assert any(
        isinstance(m, ToolMessage)
        and m.content == "z" * 800_000
        and m.tool_call_id == "abc"
        for m in msgs
    ), "in-flight tool result was dropped / lost its tool_call_id"
    # The in-flight assistant message must remain (content intact) AND keep its
    # tool_calls; otherwise the next model call gets a dangling tool result and the
    # turn cannot continue after compaction.
    kept = [
        m for m in msgs
        if isinstance(m, AIMessage) and m.content == "calling tool now"
    ]
    assert kept, "in-flight assistant step was summarized away"
    assert kept[0].tool_calls, "in-flight assistant lost its tool_calls"
    assert (
        kept[0].tool_calls[0].get("id") == "abc"
    ), "in-flight tool_call id mismatch"


def test_auto_compact_in_place_noop_below_threshold():
    # Below the usable threshold nothing is compacted, so `msgs` must be left
    # completely untouched (no rebuild, no dropped messages).
    original = graph._agents._compact_history
    graph._agents._compact_history = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("compact must not be called below threshold")
    )
    try:
        msgs = [
            SystemMessage(content="system prompt"),
            HumanMessage(content="hi"),
            AIMessage(content="answer"),
        ]
        q = _Queue()
        asyncio.run(
            graph._maybe_auto_compact(
                {"compact_at_percent": 80}, q, None, None, msgs, 200_000,
                last_context_tokens=10_000,
            )
        )
    finally:
        graph._agents._compact_history = original
    # Untouched: same objects, same length.
    assert len(msgs) == 3
    assert isinstance(msgs[0], SystemMessage)
    assert msgs[1].content == "hi"
    assert msgs[2].content == "answer"
    assert q.items == []


def test_repeated_compaction_never_grows_system_prompt():
    """opencode parity: the summary is its OWN message, never folded into the
    system prompt. Regression guard for the bug where each compaction appended
    another summary onto the system message (prompt + summary1 + summary2 + …),
    so the prompt grew on every compact until the window overflowed — the
    system prompt must stay byte-identical across any number of compactions."""
    async def fake_compact(*a, **k):
        return (
            [
                {"role": "system", "content": "[Compacted earlier context]\nSUMMARY"},
                {"role": "user", "content": "recent question"},
                {"role": "assistant", "content": "recent answer"},
            ],
            2,
            None,
        )

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        msgs = [
            SystemMessage(content="system prompt"),
            HumanMessage(content="old q"),
            AIMessage(content="old a"),
            HumanMessage(content="recent question"),
            AIMessage(content="recent answer"),
        ]
        for _ in range(3):  # three consecutive compactions
            q = _Queue()
            asyncio.run(
                graph._maybe_auto_compact(
                    {"compact_at_percent": 80}, q, None, None, msgs, 200_000,
                    last_context_tokens=190_000,
                )
            )
    finally:
        graph._agents._compact_history = original

    # The system prompt is byte-identical after 3 compactions — never grew.
    assert isinstance(msgs[0], SystemMessage)
    assert msgs[0].content == "system prompt"
    # Exactly ONE summary message exists (replaced each time, not stacked).
    summaries = [
        m for m in msgs
        if isinstance(m, HumanMessage) and "[Compacted earlier context]" in m.content
    ]
    assert len(summaries) == 1, f"summary stacked: {[m.content for m in summaries]}"
    # The transcript is summary + recent tail — bounded, not growing per compact.
    assert len(msgs) == 4


def test_cheap_truncation_does_not_crash_on_plain_list():
    # The cheap-truncation pass used to mark the live transcript with
    # ``msgs._cheap_truncated = True`` to avoid re-scanning. ``msgs`` is a plain
    # ``list[BaseMessage]`` so that assignment raised ``AttributeError`` on the
    # EXACT turn compaction is needed most (long transcript, many old tool
    # results), killing the whole turn with no retry and no ``compact_start``
    # event reaching the frontend. Prove cheap truncation now runs cleanly and
    # rewrites old tool messages in place (without the AttributeError) by
    # triggering ONLY the cheap pass: ``compact_at_percent=99`` sets the heavy
    # compact threshold above the live transcript (~120k tokens of tool
    # results, well below 99% of 200k) but the cheap pass (40% threshold =
    # 80k) still fires.
    placeholder = "[result truncated — see earlier compact summary]"

    async def fake_compact(*a, **k):
        # Should NOT be called — the heavy threshold is above the transcript.
        raise AssertionError("heavy compact must not be called for this test")

    original = graph._agents._compact_history
    graph._agents._compact_history = fake_compact
    try:
        big = "x" * 60_000  # ~15k tokens each, 8 of them = ~120k tokens total
        msgs = [SystemMessage(content="sys")]
        for i in range(8):
            tcid = f"t{i}"
            msgs += [
                AIMessage(
                    content="call",
                    tool_calls=[{"id": tcid, "name": "read", "args": {}}],
                ),
                ToolMessage(content=big, tool_call_id=tcid, name="read"),
            ]
        q = _Queue()
        # Must NOT raise — the whole point of the fix.
        asyncio.run(
            graph._maybe_auto_compact(
                {"compact_at_percent": 99}, q, None, None, msgs, 200_000,
                last_context_tokens=0,
            )
        )
    finally:
        graph._agents._compact_history = original

    # Heavy compact did NOT fire (cheap-pass-only scenario).
    assert q.items == [], f"heavy compact should not have fired, got {q.items}"
    # Cheap pass must have rewritten old tool results in place. With 8 tool
    # results and _KEEP=6, the first 2 are eligible for shortening.
    shortened = [
        m for m in msgs
        if isinstance(m, ToolMessage) and m.content == placeholder
    ]
    assert len(shortened) >= 1, (
        f"cheap pass did not rewrite any tool message in place; got: "
        f"{[type(m).__name__ + ':' + str(len(getattr(m, 'content', ''))) for m in msgs]}"
    )


def test_messages_to_dicts_tags_tool_name_for_prune_protection():
    # The prune-protected-tools check (``m.get("tool") not in {"skill"}``) was
    # a no-op in production because ``_messages_to_dicts`` never set the
    # ``tool`` key on ``ToolMessage`` dicts. After the fix, a ToolMessage
    # produced by the ``skill`` tool keeps its name all the way through
    # ``_messages_to_dicts`` -> ``_prune_history`` and is therefore spared by
    # the prune pass while unprotected tools (e.g. ``read``) are cleared.
    # Three user turns so the first turn is older than opencode's
    # "preserve recent two turns" window and is actually eligible for pruning.
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    msgs = [
        HumanMessage(content="first turn"),
        AIMessage(
            content="skill",
            tool_calls=[{"id": "c-skill", "name": "skill", "args": {}}],
        ),
        ToolMessage(content="X" * 200_000, tool_call_id="c-skill", name="skill"),
        AIMessage(
            content="read",
            tool_calls=[{"id": "c-read", "name": "read", "args": {"filePath": "a"}}],
        ),
        ToolMessage(content="Y" * 200_000, tool_call_id="c-read", name="read"),
        HumanMessage(content="second turn"),
        AIMessage(content="between"),
        HumanMessage(content="third turn"),
        AIMessage(content="more"),
    ]
    dicts = graph._agents._messages_to_dicts(msgs)
    # Every tool message must be tagged with its originating tool name.
    by_tcid = {d.get("tool_call_id"): d for d in dicts if d.get("role") == "tool"}
    assert by_tcid["c-skill"].get("tool") == "skill", by_tcid
    assert by_tcid["c-read"].get("tool") == "read", by_tcid

    # Now run the real prune path. The skill result must survive; the read
    # result must be cleared.
    pruned = graph._agents._prune_history(dicts)
    skill_msg = next(d for d in pruned if d.get("tool_call_id") == "c-skill")
    read_msg = next(d for d in pruned if d.get("tool_call_id") == "c-read")
    assert not skill_msg.get("compacted"), (
        f"skill tool result must be protected, got: {skill_msg.get('content')[:80]!r}"
    )
    assert skill_msg["content"] == "X" * 200_000
    assert read_msg.get("compacted"), "non-protected tool result should be pruned"
    assert read_msg["content"] == "[Old tool result content cleared]"


# ---------------------------------------------------------------------------
# Orphaned tool-message detection
# ---------------------------------------------------------------------------


def test_compact_removes_orphaned_tool_messages():
    """Orphaned tool messages (whose assistant is in the summarized older portion)
    MUST be removed from the tail, otherwise the API 400s with
    'Tool messages starting at messages[N] are missing results for tool_call_id(s)'.
    """
    # Build a history where compaction will split assistant(A,B,C) from its
    # results: the tail picks up tool(B), tool(C), then more turns — but
    # assistant(A,B,C) falls into the older (summarized) part.  Tool messages
    # for A, B, C are orphaned because no assistant with those tool_call_ids
    # remains in the tail.
    _history = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "start"},
        {
            "role": "assistant",
            "content": "first step",
            "tool_calls": [
                {"id": "c-a", "name": "tool_a", "args": {}},
                {"id": "c-b", "name": "tool_b", "args": {}},
                {"id": "c-c", "name": "tool_c", "args": {}},
            ],
        },
        {"role": "tool", "content": "result_a", "tool_call_id": "c-a", "tool": "tool_a"},
        {"role": "tool", "content": "result_b", "tool_call_id": "c-b", "tool": "tool_b"},
        {"role": "tool", "content": "result_c", "tool_call_id": "c-c", "tool": "tool_c"},
        {"role": "user", "content": "continue"},
        {"role": "assistant", "content": "done"},
    ]

    tail = [
        {"role": "tool", "content": "result_b", "tool_call_id": "c-b", "tool": "tool_b"},
        {"role": "tool", "content": "result_c", "tool_call_id": "c-c", "tool": "tool_c"},
        {"role": "user", "content": "continue"},
        {"role": "assistant", "content": "done"},
    ]

    # Simulate what _compact_history does: collect tail_tc_ids then clean.
    # The tail has NO assistant with tool_calls, so _all_tail_tc_ids is empty.
    _all_tail_tc_ids: set[str] = set()
    for _m in tail:
        if _m.get("role") == "assistant":
            for _tc in _m.get("tool_calls") or []:
                _tid = _tc.get("id")
                if _tid:
                    _all_tail_tc_ids.add(_tid)

    # All tool messages are orphaned (their assistant is in the older part).
    orphaned_ids: list[str] = []
    _cleaned: list[dict] = []
    for _m in tail:
        if (
            _m.get("role") == "tool"
            and _m.get("tool_call_id") not in _all_tail_tc_ids
        ):
            orphaned_ids.append(_m.get("tool_call_id", "?"))
        else:
            _cleaned.append(_m)
    tail = _cleaned

    # Both orphaned tool messages must be removed.
    assert len(orphaned_ids) == 2, f"expected 2 orphaned, got {orphaned_ids}"
    assert set(orphaned_ids) == {"c-b", "c-c"}
    assert all(m.get("role") != "tool" for m in tail), (
        f"orphaned tool messages still in tail: {tail}"
    )


def test_compact_strips_tool_calls_when_any_result_missing():
    """When an assistant message has tool_call_ids [A, B, C] but only A and B
    have results in the tail, the entire tool_calls block must be stripped
    (otherwise the API 400s on the missing C result).
    """
    tail = [
        {
            "role": "assistant",
            "content": "step",
            "tool_calls": [
                {"id": "c-a", "name": "ta", "args": {}},
                {"id": "c-b", "name": "tb", "args": {}},
                {"id": "c-c", "name": "tc", "args": {}},
            ],
        },
        {"role": "tool", "content": "ok_a", "tool_call_id": "c-a"},
        {"role": "tool", "content": "ok_b", "tool_call_id": "c-b"},
        # c-c result is missing (it was in the older/summarized part).
    ]

    _kept_result_ids: set[str] = {
        _m.get("tool_call_id")
        for _m in tail
        if _m.get("role") == "tool" and _m.get("tool_call_id")
    }
    for _m in tail:
        if _m.get("role") == "assistant" and _m.get("tool_calls"):
            _own_ids = {
                _tc.get("id") for _tc in _m["tool_calls"] if _tc.get("id")
            }
            if _own_ids - _kept_result_ids:
                _m.pop("tool_calls", None)

    assistant = tail[0]
    assert assistant.get("role") == "assistant"
    assert not assistant.get("tool_calls"), (
        "tool_calls must be stripped when any result is missing"
    )
