"""Unit tests: doom-loop detector in ``langchain_tool_loop``.

Regression guard for the bug where a sub-agent (explore/general) issues the SAME
tool call (same name + same args) over and over, burning tokens in an infinite
loop. After the fix, ``langchain_tool_loop`` detects 3 identical consecutive
tool-call steps and forces the model to stop and report findings instead.

Covers:
- A model that repeats the same tool call 3x in a row is stopped (loop breaks).
- A model that varies its tool calls is NOT falsely stopped.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-doom-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage  # noqa: E402

import llm as _llm  # noqa: E402


class _FakeModel:
    """A model that always returns the same tool call (simulating a doom loop)."""

    model_name = "fake-doom"

    def __init__(self, call_name: str = "grep", call_args: dict | None = None):
        self._name = call_name
        self._call_args = call_args or {"pattern": "x"}
        self.call_count = 0

    def bind_tools(self, tools):
        # Return an object whose ainvoke returns a fixed tool-call AIMessage.
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                # Count how many times we've been asked to call a tool.
                self._model.call_count += 1
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": self._model._name,
                            "args": self._model._call_args,
                            "id": f"call-{self._model.call_count}",
                        }
                    ],
                )

        return _Bound(self)


def _make_tools():
    async def grep(**kwargs):
        return "no matches"

    return {"grep": grep}


async def _run_doom():
    model = _FakeModel()
    result = await _llm.langchain_tool_loop(
        model,
        system="",
        user="find bugs",
        tools=_make_tools(),
        max_steps=25,
        ctx=0,  # no compaction; doom-loop detector is independent of ctx
        emit=None,
    )
    return model, result


async def _run_varied():
    """A model that varies its tool call each step should NOT be stopped."""
    calls = [
        {"name": "grep", "args": {"pattern": "a"}},
        {"name": "grep", "args": {"pattern": "b"}},
        {"name": "grep", "args": {"pattern": "c"}},
        {"name": "grep", "args": {"pattern": "d"}},
    ]

    class _VariedModel:
        model_name = "fake-varied"

        def __init__(self):
            self._calls = [
                {"name": "grep", "args": {"pattern": "a"}},
                {"name": "grep", "args": {"pattern": "b"}},
                {"name": "grep", "args": {"pattern": "c"}},
                {"name": "grep", "args": {"pattern": "d"}},
            ]
            self._i = 0

        def bind_tools(self, tools):
            class _Bound:
                def __init__(self, model):
                    self._model = model

                async def ainvoke(self, msgs):
                    if self._model._i >= len(self._model._calls):
                        return AIMessage(content="done")
                    c = self._model._calls[self._model._i]
                    self._model._i += 1
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {"name": c["name"], "args": c["args"], "id": f"call-{self._model._i}"}
                        ],
                    )

            return _Bound(self)

    result = await _llm.langchain_tool_loop(
        _VariedModel(),
        system="",
        user="find bugs",
        tools=_make_tools(),
        max_steps=25,
        ctx=0,
        emit=None,
    )
    return result


def test_doom_loop_stops_after_3_identical_calls():
    model, result = asyncio.run(_run_doom())
    # The loop must break after 3 identical consecutive calls, NOT run all 25.
    assert model.call_count == 3
    assert isinstance(result, str)


def test_varied_calls_not_falsely_stopped():
    result = asyncio.run(_run_varied())
    # Varied calls should reach the final text reply ("done") without a
    # doom-loop stop being injected.
    assert result == "done"


if __name__ == "__main__":
    test_doom_loop_stops_after_3_identical_calls()
    test_varied_calls_not_falsely_stopped()
    print("OK")
