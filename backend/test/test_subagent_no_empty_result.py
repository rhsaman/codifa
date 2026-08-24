"""Unit test: the sub-agent loop must never return an empty result.

Regression guard for the bug where ``langchain_tool_loop`` returned ``""``
when it hit ``max_steps`` without the model emitting a final text reply
(e.g. the sub-agent's last step was a tool call, or it never summarized).
Explore (and other sub-agents) would then come back empty to the parent.

After the fix, the loop recovers the last textual AIMessage it produced so
the parent always receives a real answer, not an empty ``<task_result/>``.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-noempty-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage  # noqa: E402

import llm as _llm  # noqa: E402


class _ToolCallLastStepModel:
    """Model that calls a tool on EVERY step, including the final one, and
    never emits a text summary. The last AIMessage before the limit is a
    real textual answer (step 1); the final step is a tool call only."""

    model_name = "fake-tool-last"

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
        if n == 1:
            # First step: a real textual answer (this is what we must recover).
            return AIMessage(content="found the answer on step 1")
        # Every later step (including the final one): a tool call, no text.
        return AIMessage(
            content="",
            tool_calls=[{"name": "grep", "args": {"pattern": "x"}, "id": f"c{n}"}],
        )


class _NoTextEverModel:
    """Model that only ever emits tool calls and never any text at all."""

    model_name = "fake-no-text"

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
        return AIMessage(
            content="",
            tool_calls=[{"name": "grep", "args": {"pattern": "x"}, "id": f"c{n}"}],
        )


async def test_recovers_last_text_when_final_step_is_tool_call():
    """When the loop hits max_steps on a tool-call step, it must return the
    last textual AIMessage it produced, not an empty string."""
    model = _ToolCallLastStepModel()
    out = await _llm.langchain_tool_loop(
        model,
        system="you are explore",
        user="find things",
        tools={},
        max_steps=3,
    )
    assert out.strip(), f"sub-agent returned empty result: {out!r}"
    assert "found the answer on step 1" in out, out
    print("  recovered last text answer when final step was a tool call")


async def test_never_returns_empty_when_no_text_was_ever_produced():
    """If the model never produced any text at all, the loop still must NOT
    return empty: it recovers the injected MAX_STEPS_PROMPT (a textual
    AIMessage) so the parent always gets a real, non-empty result."""
    model = _NoTextEverModel()
    out = await _llm.langchain_tool_loop(
        model,
        system="you are explore",
        user="find things",
        tools={},
        max_steps=2,
    )
    # The loop must never hand the parent an empty <task_result/>.
    assert out.strip(), f"sub-agent returned empty result: {out!r}"
    # The recovered message is the hard step-limit prompt (text, non-empty).
    assert "maximum step limit" in out or "maximum number of steps" in out, out
    print("  never empty: recovered the step-limit prompt when no text was produced")


async def main():
    await test_recovers_last_text_when_final_step_is_tool_call()
    await test_empty_only_when_no_text_was_ever_produced()
    print("SUBAGENT-NO-EMPTY-RESULT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
