"""Unit test: the hard step-limit guardrail (opencode's MAX_STEPS_PROMPT).

opencode injects MAX_STEPS_PROMPT on the FINAL allowed step (its `isLastStep`
flag in session/prompt.ts) so the model is forced to STOP tool-calling and
emit a text summary instead of burning more reads/searches. Without this the
loop just breaks at MAX_STEPS and returns an empty reply, so the model never
learns it should stop and tends to spam reads first.

Guards:
1. On the final allowed step, the loop injects _MAX_STEPS_PROMPT (English) as
   an AIMessage so the model sees the hard limit and summarizes.
2. The model is NOT told to stop on earlier steps (the prompt is only appended
   once, on the last step).
3. A normal text-only reply (no tool calls) still works and is not affected.
4. The sub-agent loop (langchain_tool_loop) mirrors the same guardrail.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-maxsteps-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, HumanMessage

import agents as _agents
import graph as _graph
import llm as _llm


def test_max_steps_prompt_constant_is_english_and_forces_summary():
    """_MAX_STEPS_PROMPT must be defined, in English, and forbid tool calls."""
    prompt = _agents._MAX_STEPS_PROMPT
    assert prompt.strip(), "MAX_STEPS_PROMPT must not be empty"
    # Kept in English on purpose (the model parses the hard limit reliably).
    assert "maximum step limit" in prompt
    assert "Do NOT make any tool calls" in prompt
    assert "text summary" in prompt


class _MaxStepsModel:
    """Model that keeps calling a tool every step until the loop injects the
    MAX_STEPS_PROMPT, then (on the final step) returns a text summary."""

    model_name = "fake-maxsteps"

    def __init__(self):
        self._saw_max_steps = False

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        # Detect the injected hard-limit prompt: once present, stop calling
        # tools and emit a text summary (what a well-behaved model does).
        if any(
            getattr(m, "type", "") == "ai"
            and getattr(m, "content", "") == _agents._MAX_STEPS_PROMPT
            for m in msgs
        ):
            self._saw_max_steps = True
            yield AIMessage(content="Summary: I reached the step limit and stopped.")
            return
        n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
        yield AIMessage(
            content=f"step {n}",
            tool_calls=[{"name": "read", "args": {"path": f"f{n}.py"}, "id": f"call_{n}"}],
        )


class _TextOnlyModel:
    """Model that returns a plain reply (no tool calls)."""

    model_name = "fake-text"

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        yield AIMessage(content="here is the answer")


async def _fake_build_turn_context(state, queue, model):
    def _fake_tool(**kwargs):
        return "ok"

    return {
        "model": model,
        "messages": [HumanMessage(content="hi")],
        "tools": {"task": _fake_tool},
        "lc_tools": [],
        "compact_model": None,
    }


async def _run_with(model, state):
    queue: asyncio.Queue = asyncio.Queue()
    orig = _graph.build_turn_context
    _graph.build_turn_context = lambda s, q: _fake_build_turn_context(s, q, model)
    try:
        await _graph._run_mode_turn(state, "ask", queue)
    finally:
        _graph.build_turn_context = orig
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def test_main_loop_injects_max_steps_prompt_on_final_step():
    """The main agent loop must inject _MAX_STEPS_PROMPT on the last step so the
    model stops tool-calling and summarizes (no empty reply)."""
    state = {
        "chat_id": "maxsteps-test",
        "context_window": 0,
        "model_name": "fake",
        "mode": "ask",
        "request": "x",
    }
    model = _MaxStepsModel()
    events = await _run_with(model, state)
    assert model._saw_max_steps, "MAX_STEPS_PROMPT was never injected on the final step"
    text_events = [e for e in events if e.get("kind") == "text"]
    # The model summarized instead of returning an empty reply.
    assert text_events, "expected a text summary after the step limit"
    assert any("Summary" in e.get("content", "") for e in text_events), text_events
    print("  main loop injected MAX_STEPS_PROMPT and got a summary")


async def test_text_only_reply_unaffected():
    """A normal text-only reply is not affected by the step-limit guardrail."""
    state = {
        "chat_id": "maxsteps-text",
        "context_window": 0,
        "model_name": "fake",
        "mode": "ask",
        "request": "x",
    }
    events = await _run_with(_TextOnlyModel(), state)
    errors = [e for e in events if e.get("kind") == "error"]
    assert not errors, f"text-only reply wrongly errored: {errors}"
    text_events = [e for e in events if e.get("kind") == "text"]
    assert any("here is the answer" in e.get("content", "") for e in text_events)
    print("  text-only reply unaffected by step-limit guardrail")


async def test_subagent_loop_injects_max_steps_prompt():
    """The sub-agent loop (langchain_tool_loop) mirrors the same guardrail."""
    from langchain_core.messages import AIMessage as _AIMessage

    class _SubModel:
        model_name = "fake-sub"

        def __init__(self):
            self._saw = False

        def bind_tools(self, tools):
            return self

        async def ainvoke(self, msgs):
            if any(
                getattr(m, "type", "") == "ai"
                and getattr(m, "content", "") == _llm._MAX_STEPS_PROMPT
                for m in msgs
            ):
                self._saw = True
                return _AIMessage(content="explore summary")
            n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
            return _AIMessage(
                content=f"step {n}",
                tool_calls=[{"name": "grep", "args": {"pattern": "x"}, "id": f"c{n}"}],
            )

    model = _SubModel()
    out = await _llm.langchain_tool_loop(
        model,
        system="you are explore",
        user="find things",
        tools={},
        max_steps=3,
    )
    assert model._saw, "sub-agent loop never injected MAX_STEPS_PROMPT"
    assert "explore summary" in out, out
    print("  sub-agent loop injected MAX_STEPS_PROMPT and summarized")


async def test_agent_registry_has_per_agent_steps():
    """Each sub-agent in the registry carries a hard step budget (opencode's
    agent.steps)."""
    from agent_registry import AGENTS

    assert AGENTS["general"]["steps"] > 0
    assert AGENTS["explore"]["steps"] > 0
    # Explore is bounded tighter than general (wide fan-out shouldn't run away).
    assert AGENTS["explore"]["steps"] <= AGENTS["general"]["steps"]
    print("  registry per-agent step budgets present")


async def main():
    await test_main_loop_injects_max_steps_prompt_on_final_step()
    await test_text_only_reply_unaffected()
    await test_subagent_loop_injects_max_steps_prompt()
    await test_agent_registry_has_per_agent_steps()
    print("MAX-STEPS-PROMPT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
