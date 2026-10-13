"""Behavior test: the composer glow signal follows REAL reasoning output,
NOT merely the model's ``reasoning`` flag.

The frontend only needs to know WHEN the model is actually reasoning (to show a
glow around the composer), not the chain-of-thought text — streaming the full
thinking content caused heavy re-renders and slowed the UI. So the backend emits
a ``{"kind": "thinking", "active": True}`` toggle ONLY when it sees genuine
reasoning content in a dedicated field (reasoning_content / reasoning /
thinking), and ``{"kind": "thinking", "active": False}`` when it ends, with NO
``content`` field.

This pins the contract so a future change can't silently start streaming
reasoning text again, and proves the signal follows real reasoning output — a
reasoning-capable model that goes straight to text (or an auto-think gateway
sending no thinking chunks) must NOT glow.
"""

from agents import run_agent


async def _collect(prompt, model_reasoning, mock_server, workspace, monkeypatch=None):
    # Isolate from the shared skill store (see test_thinking_signal_closes_on_first_text):
    # seeded skills would make the skill router consume mock.script[0].
    if monkeypatch is not None:
        import graph as _graph

        monkeypatch.setattr(_graph._agents, "_load_skills", lambda _r: [])
    base, mock = mock_server
    # Use a plain text reply (no thinking content) to prove the signal does NOT
    # depend on thinking chunks arriving.
    from mock_openai import text_reply

    mock.script = [text_reply("تمام شد.")]
    events = []
    async for ev in run_agent(
        provider="custom",
        model_name="mock-model",
        base_url=base,
        api_key="test",
        root=str(workspace),
        mode="build",
                prompt=prompt,
        history=[],
        chat_id="pytest-think-flag",
        model_reasoning=model_reasoning,
    ):
        events.append(ev)
    return events


async def test_reasoning_model_without_reasoning_content_emits_no_thinking_signal(run_events, mock_server, workspace, monkeypatch):
    """A reasoning-capable model that produces NO reasoning content (goes
    straight to text) must NOT show a thinking signal — the signal now follows
    real reasoning output, not the model's reasoning flag."""
    events = await _collect("سلام", True, mock_server, workspace, monkeypatch)
    thinking = [e for e in events if e.get("kind") == "thinking"]
    assert not thinking, f"thinking signal must not fire without real reasoning, got {thinking}"


async def test_non_reasoning_model_emits_no_thinking_signal(run_events, mock_server, workspace, monkeypatch):
    """A non-reasoning model must NOT glow."""
    events = await _collect("سلام", False, mock_server, workspace, monkeypatch)
    thinking = [e for e in events if e.get("kind") == "thinking"]
    assert not thinking, f"non-reasoning model must not emit a thinking signal, got {thinking}"


async def test_thinking_signal_closes_on_first_text(run_events, mock_server, workspace, monkeypatch):
    """The glow must turn OFF as soon as the model starts emitting text — not
    stay lit through the whole text-generation phase. We script a reasoning
    model that first streams a thinking chunk (no text) then real text, and
    assert the active:False toggle appears right after the first text event."""
    # Isolate from the shared skill store: when earlier tests seed skills,
    # the skill router would consume mock.script[0] and the turn would fall
    # back to the 'default' reply with no thinking signal. Empty skills skip
    # routing without an LLM call.
    import graph as _graph

    monkeypatch.setattr(_graph._agents, "_load_skills", lambda _r: [])
    base, mock = mock_server
    # One SSE spec (a single request consumes script[0]): a thinking-only chunk
    # (no text content) followed by two text chunks. The backend must close the
    # thinking window on the first text chunk.
    thinking_chunk = {
        "id": "c-0", "object": "chat.completion.chunk", "created": 0,
        "model": "mock-model",
        "choices": [{"index": 0, "delta": {"reasoning": "در حال فکر..."}, "finish_reason": None}],
    }
    mock.script = [
        [thinking_chunk]
        + [
            {"id": f"c-{i}", "object": "chat.completion.chunk", "created": 0,
             "model": "mock-model",
             "choices": [{"index": 0, "delta": {"content": t}, "finish_reason": None}]}
            for i, t in enumerate(["سلام ", "دنیا."], start=1)
        ]
        + [{"id": "c-end", "object": "chat.completion.chunk", "created": 0,
            "model": "mock-model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}],
    ]
    events = []
    async for ev in run_agent(
        provider="custom",
        model_name="mock-model",
        base_url=base,
        api_key="test",
        root=str(workspace),
        mode="build",
                prompt="سلام",
                history=[],
                chat_id="pytest-think-close",
        model_reasoning=True,
    ):
        events.append(ev)

    thinking = [e for e in events if e.get("kind") == "thinking"]
    assert thinking and thinking[0] == {"kind": "thinking", "active": True}
    assert {"kind": "thinking", "active": False} in thinking

    # The close toggle must come BEFORE the last text event (i.e. as soon as
    # text starts), proving the ring isn't lit through the whole generation.
    text_indices = [i for i, e in enumerate(events) if e.get("kind") == "text"]
    close_index = next(
        i for i, e in enumerate(events) if e == {"kind": "thinking", "active": False}
    )
    assert text_indices, "expected text events"
    assert close_index < text_indices[-1], (
        f"thinking window stayed open through text generation "
        f"(close@{close_index}, last text@{text_indices[-1]})"
    )


async def test_long_silent_reasoning_stream_signals_thinking(run_events, mock_server, workspace, monkeypatch):
    """A reasoning model whose pre-answer content streams for a long time with
    no dedicated reasoning field must light the thinking indicator (delayed)
    instead of leaving the UI on a frozen 'waiting for model' pill — while a
    fast straight-to-text answer stays signal-free (see the test above). The
    full answer must still arrive at stream end via the re-emit path."""
    import graph as _graph

    # Isolate from the shared skill store (same reason as the tests above).
    monkeypatch.setattr(_graph._agents, "_load_skills", lambda _r: [])

    # Fake clock: every monotonic() call advances 1s, so a multi-chunk dropped
    # stream spans well over the 5s signal delay without any real sleeping.
    _tick = [1000.0]

    def _fake_monotonic():
        _tick[0] += 1.0
        return _tick[0]

    monkeypatch.setattr(_graph.time, "monotonic", _fake_monotonic)
    base, mock = mock_server
    pieces = [f"w{i} " for i in range(8)]
    mock.script = [
        [
            {"id": f"c-{i}", "object": "chat.completion.chunk", "created": 0,
             "model": "mock-model",
             "choices": [{"index": 0, "delta": {"content": t}, "finish_reason": None}]}
            for i, t in enumerate(pieces)
        ]
        + [{"id": "c-end", "object": "chat.completion.chunk", "created": 0,
            "model": "mock-model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}],
    ]
    events = []
    async for ev in run_agent(
        provider="custom",
        model_name="mock-model",
        base_url=base,
        api_key="test",
        root=str(workspace),
        mode="build",
                prompt="سلام",
                history=[],
                chat_id="pytest-think-delayed",
        model_reasoning=True,
    ):
        events.append(ev)

    thinking = [e for e in events if e.get("kind") == "thinking"]
    assert thinking and thinking[0] == {"kind": "thinking", "active": True}
    assert {"kind": "thinking", "active": False} in thinking
    text = "".join(e.get("content", "") for e in events if e.get("kind") == "text")
    for p in pieces:
        assert p in text, f"dropped answer piece missing from re-emit: {p!r}"
