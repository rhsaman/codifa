"""Regression tests: the pre-flight orphan guard must actually reach the wire.

The guard strips tool_calls whose ToolMessage is missing so the provider never
sees a tool_calls block without results (400 "missing results for
tool_call_id(s)"). The first implementation only cleared the normalized
``tool_calls`` field via ``model_copy`` — but the call is stored in FOUR
places, and ``_convert_message_to_dict`` (langchain-openai) re-serializes
three of them:

* ``additional_kwargs["tool_calls"]`` — raw provider format; the converter's
  FALLBACK branch reads it whenever ``tool_calls`` is empty, so the orphan
  silently re-entered the payload.
* ``tool_call_chunks`` — AIMessageChunk's raw stream fragments; the
  ``init_tool_calls`` validator re-derives ``tool_calls`` from them on every
  ``model_copy``, undoing the strip.
* ``invalid_tool_calls`` — serialized alongside the valid ones.

These tests run the REAL installed ``_convert_message_to_dict`` against the
guard's output, so they fail if any storage path leaks back onto the wire.
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_openai.chat_models.base import _convert_message_to_dict

from llm import strip_orphaned_tool_calls


def _wire_tool_call_ids(msg) -> set[str]:
    """The tool_call ids that would actually reach the provider."""
    d = _convert_message_to_dict(msg)
    return {
        tc.get("id") or ""
        for tc in (d.get("tool_calls") or [])
    }


def test_guard_strips_plain_aimessage_orphan():
    """Plain AIMessage (history_to_langchain_messages path): the orphan call
    disappears from the wire dict; the answered one survives."""
    msgs = [
        AIMessage(
            content="searching",
            tool_calls=[
                {"name": "grep", "args": {"pattern": "a"}, "id": "call-1"},
                {"name": "grep", "args": {"pattern": "b"}, "id": "call-2"},
            ],
        ),
        ToolMessage(content="result a", tool_call_id="call-1"),
    ]
    strip_orphaned_tool_calls(msgs)
    assert _wire_tool_call_ids(msgs[0]) == {"call-1"}


def test_guard_strips_additional_kwargs_fallback():
    """The raw provider-format list in additional_kwargs is the fallback the
    converter reads when tool_calls is empty — it must be cleared too."""
    msgs = [
        AIMessageChunk(
            content="",
            additional_kwargs={
                "tool_calls": [
                    {
                        "id": "call-x",
                        "type": "function",
                        "function": {"name": "grep", "arguments": "{}"},
                    }
                ]
            },
        ),
    ]
    # The chunk validator derives tool_calls from additional_kwargs, so the
    # guard sees the orphan and must clear BOTH storages.
    strip_orphaned_tool_calls(msgs)
    assert _wire_tool_call_ids(msgs[0]) == set()
    assert "tool_calls" not in (msgs[0].additional_kwargs or {})


def test_guard_strips_stream_chunk_tool_call_chunks():
    """AIMessageChunk from streaming keeps raw tool_call_chunks; the
    init_tool_calls validator re-derives tool_calls from them on every
    model_copy, so the guard must clear the chunks as well."""
    msgs = [
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "name": "grep",
                    "args": '{"pattern": "x"}',
                    "id": "call-s",
                    "index": 0,
                    "type": "tool_call_chunk",
                }
            ],
        ),
    ]
    strip_orphaned_tool_calls(msgs)
    assert _wire_tool_call_ids(msgs[0]) == set()
    assert msgs[0].tool_call_chunks == []


def test_guard_clears_invalid_tool_calls():
    """invalid_tool_calls are serialized alongside valid ones; an orphan
    living there must be stripped too."""
    msgs = [
        AIMessage(
            content="",
            tool_calls=[{"name": "grep", "args": {"pattern": "a"}, "id": "call-v"}],
            invalid_tool_calls=[
                {"name": "grep", "args": "not-json", "id": "call-i", "error": ""}
            ],
        ),
        ToolMessage(content="ok", tool_call_id="call-v"),
    ]
    strip_orphaned_tool_calls(msgs)
    assert _wire_tool_call_ids(msgs[0]) == {"call-v"}


def test_guard_keeps_fully_answered_step_untouched():
    """A step whose every call has a result must pass through unchanged
    (same message object, no model_copy churn)."""
    ai = AIMessage(
        content="done",
        tool_calls=[{"name": "grep", "args": {"pattern": "a"}, "id": "call-1"}],
    )
    msgs = [ai, ToolMessage(content="result", tool_call_id="call-1")]
    strip_orphaned_tool_calls(msgs)
    assert msgs[0] is ai
    assert _wire_tool_call_ids(msgs[0]) == {"call-1"}


def test_guard_preserves_message_order_and_content():
    """Stripping never reorders msgs or drops the assistant's text."""
    msgs = [
        AIMessage(
            content="I will search now",
            tool_calls=[{"name": "grep", "args": {}, "id": "call-1"}],
        ),
        ToolMessage(content="result", tool_call_id="call-1"),
        AIMessage(
            content="orphan step",
            tool_calls=[{"name": "read", "args": {}, "id": "call-2"}],
        ),
    ]
    strip_orphaned_tool_calls(msgs)
    assert len(msgs) == 3
    assert msgs[0].content == "I will search now"
    assert msgs[2].content == "orphan step"
    assert not msgs[2].tool_calls


if __name__ == "__main__":
    test_guard_strips_plain_aimessage_orphan()
    test_guard_strips_additional_kwargs_fallback()
    test_guard_strips_stream_chunk_tool_call_chunks()
    test_guard_clears_invalid_tool_calls()
    test_guard_keeps_fully_answered_step_untouched()
    test_guard_preserves_message_order_and_content()
    print("ORPHAN GUARD TESTS PASSED")
