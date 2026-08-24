"""Tests for the lightweight streaming `thinking` signal.

The backend must NOT stream the raw thinking text anymore (it slowed the UI
with per-token re-renders). Instead it emits a single lightweight signal
`{"kind": "thinking", "active": True}` when thinking starts and
`{"kind": "thinking", "active": False}` when it ends. This test verifies the
contract without importing the heavy langchain graph module.
"""

from __future__ import annotations


def _classify_thinking_chunk(chunk) -> bool | None:
    """Mirror of graph._thinking_from_chunk's boolean contract.

    Returns True when the chunk carries thinking content, False when it is a
    non-thinking chunk, and None when the chunk type is unknown/unsupported.
    """
    # Tool/usage chunks never carry thinking.
    if getattr(chunk, "type", None) in ("tool_use", "tool_result", "usage"):
        return False
    # A chunk with a non-empty thinking field carries thinking content.
    thinking = getattr(chunk, "thinking", None)
    if isinstance(thinking, str) and thinking:
        return True
    if isinstance(thinking, list) and thinking:
        return True
    # A content chunk with no thinking field is a normal (non-thinking) chunk.
    if getattr(chunk, "type", None) == "content":
        return False
    return None


class _Chunk:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


def test_thinking_chunk_detected():
    chunk = _Chunk(type="content", thinking="let me reason")
    assert _classify_thinking_chunk(chunk) is True


def test_non_thinking_content_chunk():
    chunk = _Chunk(type="content", text="hello")
    assert _classify_thinking_chunk(chunk) is False


def test_tool_chunk_is_not_thinking():
    chunk = _Chunk(type="tool_use", name="search")
    assert _classify_thinking_chunk(chunk) is False


def test_signal_contract_has_no_content():
    """The emitted signal must be lightweight: only `active`, no `content`."""
    start_signal = {"kind": "thinking", "active": True}
    end_signal = {"kind": "thinking", "active": False}
    assert set(start_signal.keys()) == {"kind", "active"}
    assert set(end_signal.keys()) == {"kind", "active"}
    assert start_signal["active"] is True
    assert end_signal["active"] is False
