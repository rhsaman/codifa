"""Unit tests: sub-agent loop emits its own token usage.

Regression guard for the bug where a sub-agent (explore/general) running through
``langchain_tool_loop`` silently dropped ``usage_metadata`` from the model
response, so its token usage never reached the frontend and was missing from the
"Model usage" sidebar (while vision/web/search sub-agents, which go through
``llm_generate(..., sub=True)``, were counted correctly).

After the fix, ``langchain_tool_loop`` emits a ``usage`` event (tagged ``sub=True``
by the caller's ``emit`` wrapper) on every model step that returns usage metadata.

Covers:
- ``langchain_tool_loop`` emits a ``usage`` event when the model returns
  ``usage_metadata`` and an ``emit`` callback is supplied.
- The emitted event carries ``kind == "usage"``, ``sub == True`` and the model
  name, and is NOT emitted when no ``emit`` callback is passed (no crash, no leak).
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subusage-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage

import llm as _llm


class _FakeModel:
    """A LangChain-style model whose ``ainvoke`` returns a final text reply.

    The first call returns a tool call so the loop runs at least one step; the
    second returns a final answer. Both carry ``usage_metadata`` so we can assert
    the loop emits usage on every step that has it.
    """

    model_name = "sub-test-model"

    def __init__(self):
        self._calls = 0

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        self._calls += 1
        if self._calls == 1:
            # A tool call step (still carries usage_metadata).
            ai = AIMessage(content="", tool_calls=[{"name": "read", "args": {}, "id": "c1"}])
        else:
            ai = AIMessage(content="final answer")
        ai.usage_metadata = {
            "input_tokens": 100 * self._calls,
            "output_tokens": 25 * self._calls,
        }
        return ai


async def test_langchain_tool_loop_emits_usage():
    """Every model step with usage_metadata yields a ``usage`` event."""
    model = _FakeModel()
    emitted = []

    def emit(ev):
        emitted.append(ev)

    result = await _llm.langchain_tool_loop(
        model,
        system="sys",
        user="do the thing",
        tools={"read": lambda **k: "file contents"},
        max_steps=4,
        emit=emit,
    )

    assert result == "final answer"
    usage_events = [e for e in emitted if e.get("kind") == "usage"]
    # Two model steps (one tool-call step + one final step) -> two usage events.
    assert len(usage_events) == 2, emitted
    for ev in usage_events:
        assert ev["sub"] is True
        assert ev["model"] == "sub-test-model"
        assert ev["input_tokens"] > 0
        assert ev["output_tokens"] > 0
        assert ev["total_tokens"] == ev["input_tokens"] + ev["output_tokens"]


async def test_langchain_tool_loop_no_emit_callback_is_safe():
    """Without an ``emit`` callback the loop still works and emits nothing."""
    model = _FakeModel()

    result = await _llm.langchain_tool_loop(
        model,
        system="sys",
        user="do the thing",
        tools={"read": lambda **k: "file contents"},
        max_steps=4,
    )

    assert result == "final answer"


if __name__ == "__main__":
    asyncio.run(test_langchain_tool_loop_emits_usage())
    asyncio.run(test_langchain_tool_loop_no_emit_callback_is_safe())
    print("ok")
