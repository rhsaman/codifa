"""Behavior test: the composer glow signal is driven by the model's
``reasoning`` flag, NOT by raw thinking text.

The frontend only needs to know WHEN the model is reasoning (to show a glow
around the composer), not the chain-of-thought text — streaming the full
thinking content caused heavy re-renders and slowed the UI. So the backend must
emit a single ``{"kind": "thinking", "active": True}`` toggle at the START of a
reasoning-capable model's stream, and ``{"kind": "thinking", "active": False}``
when it ends, with NO ``content`` field.

This pins the contract so a future change can't silently start streaming
reasoning text again, and proves the signal follows the model flag (not the
presence of thinking chunks — many auto_think gateways send no thinking text at
all, so relying on it would leave the glow dark).
"""

from agents import run_agent


async def _collect(prompt, model_reasoning, mock_server, workspace):
    base, mock = mock_server
    mock.script = [type(mock.script[0])(text="تمام شد.")] if mock.script else []
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
        mode="coder",
        prompt=prompt,
        history=[],
        chat_id="pytest-think-flag",
        model_reasoning=model_reasoning,
    ):
        events.append(ev)
    return events


async def test_reasoning_model_emits_thinking_signal(run_events, mock_server, workspace):
    """A reasoning-capable model must glow (active:True) even when the provider
    sends NO thinking text chunks."""
    events = await _collect("سلام", True, mock_server, workspace)
    thinking = [e for e in events if e.get("kind") == "thinking"]
    assert thinking, f"expected a thinking signal for a reasoning model, got {[e.get('kind') for e in events]}"
    assert thinking[0] == {"kind": "thinking", "active": True}, f"unexpected start: {thinking[0]}"
    assert {"kind": "thinking", "active": False} in thinking, f"missing end toggle: {thinking}"
    # No raw thinking text may leak into the stream.
    assert all("content" not in e for e in thinking), "thinking signal must carry no content"


async def test_non_reasoning_model_emits_no_thinking_signal(run_events, mock_server, workspace):
    """A non-reasoning model must NOT glow."""
    events = await _collect("سلام", False, mock_server, workspace)
    thinking = [e for e in events if e.get("kind") == "thinking"]
    assert not thinking, f"non-reasoning model must not emit a thinking signal, got {thinking}"
