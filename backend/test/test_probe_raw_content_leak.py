"""Probe: does raw thinking streamed as plain string content leak?

opencode sometimes nulls reasoning_content and streams the chain-of-thought
as a plain string in `content` (before the real answer). This test reproduces
that exact wire shape and asserts the backend does NOT emit it as a `text`
event.
"""
import pytest


async def test_probe_raw_content_leak(run_events, mock_server, workspace):
    from agents import run_agent

    base, mock = mock_server
    mock.script = [[
        {"id": "c-0", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {"content": "بذار کد رو چک کنم"}, "finish_reason": None}]},
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {"content": "جواب اینه: سلام"}, "finish_reason": None}]},
        {"id": "c-end", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]]
    events = []
    async for ev in run_agent(
        provider="custom", model_name="mock-model", base_url=base,
        api_key="test", root=str(workspace), mode="coder", prompt="سلام",
        history=[], chat_id="pytest-probe-raw", model_reasoning=True,
    ):
        events.append(ev)
    texts = [e["content"] for e in events if e.get("kind") == "text"]
    print("TEXT EVENTS:", texts)
    assert "بذار کد رو چک کنم" not in texts, f"raw thinking leaked: {texts}"
    assert any("جواب اینه: سلام" in t for t in texts), f"answer missing: {texts}"
