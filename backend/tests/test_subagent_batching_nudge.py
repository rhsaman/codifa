"""Unit tests: no soft tool-call budget ceiling in ``langchain_tool_loop``.

There is intentionally no fixed search-usage cap: the model may keep calling
grep/glob/read until it holds what the task needs. Batching is still steered
via prompts (patterns/filePaths/ranges), but no steering message is injected
after N calls. Unlike the doom-loop guard (which breaks identical-repeat
loops), search volume alone never stops the loop. These tests verify:

1. No "soft limit" nudge appears even after 10+ calls.
2. A model that finishes in few calls still completes normally.
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

from langchain_core.messages import AIMessage

import llm as _llm


class _ManyCallModel:
    """A model that always returns a tool call (never finishes on its own)."""

    model_name = "fake-many"

    def __init__(self):
        self.call_count = 0
        self.saw_nudge = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                self._model.call_count += 1
                # Detect any soft-limit nudge in prior messages.
                for m in msgs:
                    if "soft limit" in getattr(m, "content", ""):
                        self._model.saw_nudge = True
                if self._model.call_count >= 12:
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


def test_no_nudge_after_many_calls():
    """After 12 tool calls, no soft-limit nudge must appear in msgs."""
    model, result = asyncio.run(_run_many())
    assert model.call_count >= 12, f"expected >= 12 calls, got {model.call_count}"
    assert model.saw_nudge is False, "soft-limit nudge must not be injected"
    assert isinstance(result, str)
    assert len(result) > 0


def test_no_nudge_when_few_calls():
    """A model that finishes in <8 calls should never see the nudge."""
    model, result = asyncio.run(_run_few())
    assert model.call_count == 3
    assert result == "done after 3 calls"


if __name__ == "__main__":
    test_no_nudge_after_many_calls()
    test_no_nudge_when_few_calls()
    print("OK")
