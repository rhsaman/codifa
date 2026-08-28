"""Probe: does ReasoningChatOpenAI lift delta.reasoning -> reasoning_content?"""
from llm import ReasoningChatOpenAI


async def test_reasoning_delta_promoted(run_events, mock_server, workspace):
    base, mock = mock_server
    mock.script = [[
        {"id": "c-0", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {"reasoning": "در حال فکر..."}, "finish_reason": None}]},
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {"content": "سلام"}, "finish_reason": None}]},
        {"id": "c-end", "object": "chat.completion.chunk", "created": 0,
         "model": "mock-model",
         "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]]
    llm = ReasoningChatOpenAI(model="mock-model", api_key="test", base_url=base, streaming=True)
    from langchain_core.messages import HumanMessage, SystemMessage
    msgs = [SystemMessage(content="x"), HumanMessage(content="hi")]
    found_reasoning = False
    async for chunk in llm.astream(msgs):
        # The backend reads reasoning from additional_kwargs (see
        # _thinking_from_chunk), so assert the promotion landed there.
        rc = (getattr(chunk, "additional_kwargs", None) or {}).get("reasoning_content")
        if rc:
            found_reasoning = True
            assert "در حال فکر" in rc
    assert found_reasoning, "delta.reasoning was not promoted to reasoning_content"
