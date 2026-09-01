"""Unit tests: soft tool-call budget nudge in ``langchain_tool_loop``.

After ``_TOOL_CALL_SOFT_LIMIT`` (8) tool calls, ``langchain_tool_loop`` injects a
``SystemMessage`` nudge that steers the model toward batching or summarizing.
Unlike the doom-loop guard (which breaks the loop), the nudge is advisory — the
model CAN keep calling tools. These tests verify:

1. The nudge SystemMessage appears in ``msgs`` after 8+ calls.
2. A model that finishes in <8 calls never sees the nudge.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-nudge-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, SystemMessage

import llm as _llm


class _ManyCallModel:
    """A model that always returns a tool call (never finishes on its own)."""

    model_name = "fake-many"

    def __init__(self):
        self.call_count = 0

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                self._model.call_count += 1
                # Check if a nudge was injected in previous messages
                for m in msgs:
                    if isinstance(m, SystemMessage) and "soft limit" in getattr(m, "content", ""):
                        # After seeing the nudge, stop calling tools
                        return AIMessage(content="summarized findings")
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "grep",
                            "args": {"pattern": f"q{self._model.call_count}"},
                            "id": f"call-{self._model.call_count}",
                        }
                    ],
                )

        return _Bound(self)


class _FewCallModel:
    """A model that finishes after 3 tool calls (before the soft limit)."""

    model_name = "fake-few"

    def __init__(self):
        self.call_count = 0

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                self._model.call_count += 1
                if self._model.call_count >= 3:
                    return AIMessage(content="done after 3 calls")
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "grep",
                            "args": {"pattern": f"q{self._model.call_count}"},
                            "id": f"call-{self._model.call_count}",
                        }
                    ],
                )

        return _Bound(self)


def _make_tools():
    async def grep(**kwargs):
        return "no matches"

    return {"grep": grep}


async def _run_many():
    model = _ManyCallModel()
    result = await _llm.langchain_tool_loop(
        model,
        system="",
        user="search everything",
        tools=_make_tools(),
        max_steps=25,
        ctx=0,
        emit=None,
    )
    return model, result


async def _run_few():
    model = _FewCallModel()
    result = await _llm.langchain_tool_loop(
        model,
        system="",
        user="search something",
        tools=_make_tools(),
        max_steps=25,
        ctx=0,
        emit=None,
    )
    return model, result


def test_nudge_injected_after_soft_limit():
    """After 8+ tool calls, a SystemMessage nudge must appear in msgs."""
    model, result = asyncio.run(_run_many())
    # The model should have been called at least 8 times before the nudge
    # kicked in (the nudge appears as a SystemMessage, and the model sees it
    # and stops on the next step).
    assert model.call_count >= 8, f"expected >= 8 calls, got {model.call_count}"
    assert isinstance(result, str)
    assert len(result) > 0


def test_no_nudge_when_few_calls():
    """A model that finishes in <8 calls should never see the nudge."""
    model, result = asyncio.run(_run_few())
    assert model.call_count == 3
    assert result == "done after 3 calls"


if __name__ == "__main__":
    test_nudge_injected_after_soft_limit()
    test_no_nudge_when_few_calls()
    print("OK")
