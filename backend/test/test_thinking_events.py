"""Tests that the streaming chunk -> frontend `thinking` event mapping
extracts reasoning/thinking tokens from the various shapes providers use
(reasoning_content, thinking, response_metadata, list content) so the
frontend can pin a live "thinking" block during streaming.

These lock in the contract that `_thinking_from_chunk` pulls the thinking
text out of a LangChain AIMessageChunk, or returns None when there is none.
"""
from langchain_core.messages import AIMessageChunk

from graph import _thinking_from_chunk


def test_thinking_from_reasoning_content():
    # DeepSeek / OpenAI o-series expose reasoning under additional_kwargs.
    chunk = AIMessageChunk(content="", additional_kwargs={"reasoning_content": "let me think"})
    assert _thinking_from_chunk(chunk) == "let me think"


def test_thinking_from_thinking_kwarg():
    chunk = AIMessageChunk(content="", additional_kwargs={"thinking": "hmm"})
    assert _thinking_from_chunk(chunk) == "hmm"


def test_thinking_from_response_metadata():
    chunk = AIMessageChunk(
        content="",
        response_metadata={"reasoning": {"text": "step by step"}},
    )
    assert _thinking_from_chunk(chunk) == "step by step"


def test_thinking_from_list_content():
    # Some providers stream thinking as a typed content block.
    chunk = AIMessageChunk(content=[{"type": "thinking", "thinking": "internal"}])
    assert _thinking_from_chunk(chunk) == "internal"


def test_thinking_none_when_absent():
    chunk = AIMessageChunk(content="hello")
    assert _thinking_from_chunk(chunk) is None


def test_thinking_none_on_empty_string():
    # An empty reasoning string must not emit a thinking event.
    chunk = AIMessageChunk(content="", additional_kwargs={"reasoning_content": ""})
    assert _thinking_from_chunk(chunk) is None
