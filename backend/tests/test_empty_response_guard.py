"""Behavior test: the main loop must NOT treat an empty model response as a
clean turn finish.

Root cause (from production logs): when a model (e.g. hy3-free) returns a step
with NO tool call and NO meaningful text (finish_reason != "length"), the old
code silently ``break``-ed and the turn was considered clean — wiping the
resume checkpoint and looking like a disconnect to the user, with no error.

The fix mirrors the existing ``length``-truncation guard: auto-continue a
bounded number of times (reusing ``_auto_cont``/``_MAX_AUTO_CONT``) so the model
can actually produce output, and only warn+break if it keeps returning nothing.
"""

from mock_openai import text_reply


def _empty_spec():
    """An OpenAI SSE chunk spec with NO content and finish_reason='stop' —
    i.e. a genuinely empty model response (not a length truncation)."""
    return [
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]


async def test_empty_response_auto_continues_to_real_text(run_events, mock_server, workspace):
    """First step returns empty; the loop must auto-continue (not end the turn)
    and the eventual real text must reach the user — no error, no silent stop."""
    _base, mock = mock_server
    mock.script = [_empty_spec(), text_reply("ادامهٔ واقعی.")]

    events = await run_events("سلام", chat_id="pytest-empty-guard-ok")

    errors = [e for e in events if e.get("kind") == "error"]
    assert not errors, f"empty-response auto-continue must not emit errors, got {errors}"

    texts = "".join(e.get("content", "") for e in events if e.get("kind") == "text")
    assert "ادامهٔ واقعی" in texts, f"real text after empty step must appear, got {texts!r}"

    # The empty step must NOT have produced a premature 'empty response' warning
    # (that only fires when the model stays empty past the auto-continue budget).
    warns = [e for e in events if e.get("kind") == "warn"]
    assert not any("empty response" in (e.get("content") or "") for e in warns), (
        f"unexpected empty-response warning on successful auto-continue: {warns}"
    )


async def test_persistent_empty_response_warns_and_ends(run_events, mock_server, workspace):
    """If the model keeps returning empty (past the auto-continue budget), the
    loop must emit a clear 'empty response' warning and end the turn — instead of
    looping forever or silently succeeding."""
    _base, mock = mock_server
    # More empty specs than _MAX_AUTO_CONT (5) so the budget is exhausted.
    mock.script = [_empty_spec()] * 10

    events = await run_events("سلام", chat_id="pytest-empty-guard-warn")

    errors = [e for e in events if e.get("kind") == "error"]
    assert not errors, f"persistent empty response must not raise, got {errors}"

    warns = [e for e in events if e.get("kind") == "warn"]
    assert any("empty response" in (e.get("content") or "") for e in warns), (
        f"expected an 'empty response' warning when the model stays empty, got {warns}"
    )
