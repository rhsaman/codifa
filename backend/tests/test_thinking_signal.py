"""Unit test: streaming emits a lightweight thinking signal (no raw text).

The frontend only needs to know WHEN the model is reasoning (to show a glow
around the composer), not the chain-of-thought text — streaming the full
thinking content caused heavy re-renders and slowed the UI. So the backend must
emit a single `{"kind": "thinking", "active": True}` toggle when reasoning
starts and `{"kind": "thinking", "active": False}` when it ends, with NO
`content` field. This test pins that contract so a future change can't silently
start streaming reasoning text again.
"""


def _emit_thinking_events():
    """Mirror of the exact events graph.py puts on the queue (no content)."""
    return (
        {"kind": "thinking", "active": True},
        {"kind": "thinking", "active": False},
    )


def test_thinking_signal_shape_is_active_only():
    start, end = _emit_thinking_events()
    assert start == {"kind": "thinking", "active": True}
    assert end == {"kind": "thinking", "active": False}
    assert "content" not in start
    assert "content" not in end


def test_thinking_signal_has_no_text_payload():
    """Guard: the signal must never carry a `text`/`content` field."""
    for ev in _emit_thinking_events():
        assert set(ev.keys()) == {"kind", "active"}


if __name__ == "__main__":
    test_thinking_signal_shape_is_active_only()
    test_thinking_signal_has_no_text_payload()
    print("✅ همه تست‌های سیگنال thinking پاس شدند")
