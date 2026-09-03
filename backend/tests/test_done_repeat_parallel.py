"""Tests for the four fixes bundled in this commit:

1. ``done`` event is no longer emitted twice (graph.done_node + event_gen.finally).
2. Repetition-loop guard no longer sends the "0 time(s) in a row" warn on the
   FIRST occurrence of a tool call (it used to fire whenever a fresh
   signature landed, polluting every turn with a confusing warning).
3. ``parallel_tool_calls`` is auto-stripped on a 400 from a free-tier model
   (e.g. minimax/minimax-m3:free) so the same model works on codifa as it
   does on opencode, instead of failing the whole turn.
4. The "Repetition detected" warn message accurately reflects the count.
"""
import asyncio
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

import graph as _graph
import llm

# ---------------------------------------------------------------------------
# Fix 1: done event is no longer emitted twice.
# ---------------------------------------------------------------------------


async def test_done_emitted_exactly_once():
    """A clean agent run must surface exactly one ``done`` SSE event — not the
    duplicate that came from graph.done_node ALSO emitting one alongside the
    server.event_gen finally block. The duplicate confused the frontend's
    "stream DISCONNECTED" detection (a second ``done`` is treated as a
    disconnect) and risked needless reconnects."""
    queue: asyncio.Queue = asyncio.Queue()
    state: dict = {
        "_queue": queue,
        "final_response": "all done",
        "mode": "ask",
    }
    # Drive the same logic that done_node uses.
    result = _graph.done_node(state)
    assert result == {"final_response": "all done"}
    # The fix: done_node no longer puts anything on the queue.
    assert queue.empty(), (
        f"done_node must NOT emit a 'done' event "
        f"(server.event_gen.finally owns the terminal event). Got: {queue.qsize()} events"
    )


# ---------------------------------------------------------------------------
# Fix 2 + 4: Repetition guard does not warn on the first occurrence, and
# the count is accurate when it does warn.
# ---------------------------------------------------------------------------


class _RepeatModel:
    """Calls read with the SAME args on every step — a real repetition loop."""

    model_name = "fake-repeat"

    def __init__(self) -> None:
        self.calls = 0

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        self.calls += 1
        yield AIMessage(
            content="",
            tool_calls=[{"name": "read", "args": {"path": "same.py"}, "id": f"c{self.calls}"}],
        )


async def _run_with_model(model) -> list[dict]:
    """Stand-in drive: bypass build_turn_context so we can control the loop."""
    queue: asyncio.Queue = asyncio.Queue()
    state: dict = {
        "_queue": queue,
        "mode": "ask",
        "chat_id": "pytest-repeat",
        "model": model,
    }

    async def _fake_build(state, q, *a, **k):
        return {
            "model": model,
            "messages": [HumanMessage(content="hi")],
            "tools": {"read": lambda **kw: "ok"},
            "lc_tools": [],
            "compact_model": None,
        }

    orig = _graph.build_turn_context
    _graph.build_turn_context = _fake_build
    try:
        await _graph._run_mode_turn(state, "ask", queue, run_flags={"hard_error": False})
    finally:
        _graph.build_turn_context = orig

    out = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


async def test_repetition_warn_not_emitted_on_first_occurrence():
    """The OLD guard had a bug: the very FIRST time a tool signature was seen
    the warn fired with ``_repeat_count == 0`` ("issued 0 time(s) in a row"),
    which is both confusing to the user and a false positive on every turn
    that does a single read. The fix gates the warn on
    ``_repeat_count >= 1`` so it only fires when there's an actual repeat."""
    events = await _run_with_model(_RepeatModel())

    # The model loops on the same tool call 3 times → hard stop fires
    # ("repetition loop" error event). The "Repetition detected" warn should
    # appear for the 1st and 2nd repeat (counts 1 and 2), NOT for the
    # 0-time initial occurrence.
    warns = [e for e in events if e.get("kind") == "warn" and "Repetition detected" in e.get("content", "")]
    assert warns, "expected at least one 'Repetition detected' warn before the hard stop"
    # CRITICAL: no warn may carry "0 time(s) in a row" — that's the bug.
    for w in warns:
        assert "0 time(s) in a row" not in w["content"], (
            f"warn fired with the old false-positive '0 time(s)' text: {w['content']!r}"
        )
    # And the counts must be monotonically non-decreasing starting at 1.
    import re

    counts = [
        int(m.group(1))
        for w in warns
        for m in [re.search(r"issued (\d+) time\(s\)", w["content"])]
        if m
    ]
    assert counts, "no count parsed from warns"
    assert counts[0] >= 1, f"first warn must report >=1 repeats, got {counts[0]}"
    assert counts == sorted(counts), f"counts must be monotonic, got {counts}"


# ---------------------------------------------------------------------------
# Fix 3: parallel_tool_calls 400 from free-tier models is auto-stripped.
# ---------------------------------------------------------------------------


def test_is_parallel_calls_error_detects_400_with_field():
    """The detector must recognise a 400 that names `parallel_tool_calls` in
    the body — the same shape opencode models emit on free-tier gateways."""
    exc = Exception(
        "Error code: 400 - {'error': {'message': \"Invalid parameter: parallel_tool_calls "
        "not supported by this model\", 'type': 'invalid_request_error', 'code': 400}}"
    )
    assert llm._is_parallel_calls_error(exc) is True


def test_is_parallel_calls_error_detects_openrouter_generic_wrapper():
    """OpenRouter wraps upstream errors in a generic ``Provider returned
    error`` with the real cause in ``metadata.raw`` (which is often
    truncated by the SSE transport, hiding the actual field name). The
    detector must still match this case — otherwise the very model this
    bug report is about (``minimax/minimax-m3:free``) wouldn't get the
    auto-strip retry and would just fail every turn."""
    exc = Exception(
        "Error code: 400 - {'error': {'message': 'Provider returned error', "
        "'code': 400, 'metadata': {'raw': '{\"error\":{\"message\":\"Backend "
        "request failed with status 400\",\"type\":\"backend_error\",\"code\":"
        "400,\"det..."
    )
    assert llm._is_parallel_calls_error(exc) is True, (
        "openrouter's generic 400 wrapper must be matched even when the "
        "real upstream field name is hidden in (truncated) metadata.raw"
    )


def test_is_parallel_calls_error_detects_backend_request_failed():
    """A second common wrapper shape: ``Backend request failed with status
    400`` with no further detail. The detector must match it so the
    auto-strip path can recover."""
    exc = Exception(
        "Error code: 400 - Backend request failed with status 400"
    )
    assert llm._is_parallel_calls_error(exc) is True


def test_is_parallel_calls_error_ignores_other_400s():
    """A 400 that does NOT mention `parallel_tool_calls` must NOT trigger the
    auto-strip — otherwise we'd hide a real bad-request (e.g. invalid prompt)
    behind a silent retry."""
    exc = Exception("Error code: 400 - {'error': {'message': 'Invalid API key'}}")
    assert llm._is_parallel_calls_error(exc) is False


def test_strip_parallel_calls_removes_from_model_kwargs():
    """The strip helper must drop parallel_tool_calls from the model kwargs
    AND from the top-level attribute, mirroring _strip_stream_options. The
    real LangChain ChatOpenAI is a Pydantic model (so .model_copy() exists);
    the helper explicitly falls back to the original if cloning fails."""
    from pydantic import BaseModel

    class _FakeChat(BaseModel):
        model_kwargs: dict = {"parallel_tool_calls": True, "stream_options": {"include_usage": True}}
        parallel_tool_calls: Any = True

    m = _FakeChat()
    out = llm._strip_parallel_calls(m)
    assert out is not m, "expected a copy, got the same instance back"
    assert "parallel_tool_calls" not in out.model_kwargs, (
        f"parallel_tool_calls not removed: {out.model_kwargs}"
    )
    # Original must be untouched (defensive copy).
    assert m.model_kwargs["parallel_tool_calls"] is True
    # stream_options must survive the strip (different field, untouched).
    assert "stream_options" in out.model_kwargs
    assert out.parallel_tool_calls is None, (
        f"top-level parallel_tool_calls not cleared: {out.parallel_tool_calls!r}"
    )


def test_strip_parallel_calls_returns_original_on_clone_failure():
    """If the model refuses to clone, fall back to the original model — never
    raise out of the strip helper (the runner calls it in a hot path)."""

    class _UnclonableModel:
        def model_copy(self, deep):
            raise RuntimeError("cannot copy")

    m = _UnclonableModel()
    out = llm._strip_parallel_calls(m)
    assert out is m


async def test_parallel_calls_error_strips_and_retries():
    """End-to-end: the stream loop in _run_mode_turn catches a 400 that
    names `parallel_tool_calls`, strips the field, and retries — instead of
    surfacing the 400 to the user as a fatal error."""
    state: dict = {"_queue": asyncio.Queue(), "chat_id": "pytest-pc", "mode": "ask"}

    class _PCModel:
        """First call: raise 400. Second call: yield a clean reply."""
        model_name = "fake-pc"
        attempts = 0

        def bind_tools(self, tools):
            return self

        async def astream(self, msgs):
            self.attempts += 1
            if self.attempts == 1:
                msg = "Error code: 400 - parallel_tool_calls not supported by this model"
                raise RuntimeError(msg)
            yield AIMessage(content="ok after strip")

    m = _PCModel()

    async def _fake_build(state, q, *a, **k):
        return {
            "model": m,
            "messages": [HumanMessage(content="hi")],
            "tools": {},
            "lc_tools": [],
            "compact_model": None,
        }

    orig = _graph.build_turn_context
    _graph.build_turn_context = _fake_build
    try:
        reply = await _graph._run_mode_turn(
            state, "ask", state["_queue"], run_flags={"hard_error": False}
        )
    finally:
        _graph.build_turn_context = orig

    assert m.attempts == 2, (
        f"expected 2 attempts (1 fail + 1 retry after strip), got {m.attempts}"
    )
    assert reply == "ok after strip", (
        f"retry should have succeeded with the stripped model, got reply={reply!r}"
    )

    # No error event was emitted to the user (the 400 was recovered, not surfaced).
    q = state["_queue"]
    errors = []
    while not q.empty():
        e = q.get_nowait()
        if e.get("kind") == "error":
            errors.append(e)
    assert errors == [], f"the 400 was recovered, no error event expected; got: {errors}"


# ---------------------------------------------------------------------------
# Fix 4 (root cause): parallel_tool_calls is NOT sent on the wire by default.
# This is what fixes the actual user-visible bug — opencode never sent the
# field either, so several free-tier OpenRouter models (e.g.
# minimax/minimax-m3:free) stopped 400-ing. The 400-strip retry above is a
# belt-and-braces fallback for the (rare) case where some other field trips
# a model in the future.
# ---------------------------------------------------------------------------


def test_parallel_tool_calls_not_sent_by_default():
    """The OpenRouter free-tier model that broke every turn with 400 is
    minimax/minimax-m3:free. opencode routes the same model WITHOUT the
    ``parallel_tool_calls`` request field and it works fine. codifa used to
    set ``parallel_tool_calls: True`` in model_kwargs for every OpenAI-
    compatible provider, which the model rejected with 400. The fix: never
    set it by default (matches opencode)."""
    m = llm.build_chat_model(
        provider="openrouter",
        model="minimax/minimax-m3:free",
        base_url="https://openrouter.ai/api/v1",
        api_key="test-key",
    )
    assert "parallel_tool_calls" not in m.model_kwargs, (
        f"parallel_tool_calls must NOT be sent by default "
        f"(it 400s free-tier models). Got: {m.model_kwargs}"
    )


def test_parallel_tool_calls_not_sent_for_any_provider():
    """Cross-provider check: codifa must not enable parallel tool calls for
    any provider by default — every provider goes through OpenRouter-style
    gateways or local servers that may reject the field."""
    for provider in ("openrouter", "custom", "ollama", "cloudflare", "nvidia"):
        m = llm.build_chat_model(
            provider=provider,
            model="m",
            base_url="",
            api_key="k",
        )
        assert "parallel_tool_calls" not in m.model_kwargs, (
            f"provider={provider} should not send parallel_tool_calls; "
            f"got model_kwargs={m.model_kwargs}"
        )
