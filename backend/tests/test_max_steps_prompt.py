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
                return _AIMessage(content="subagent summary")
            n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
            return _AIMessage(
                content=f"step {n}",
                tool_calls=[{"name": "grep", "args": {"pattern": "x"}, "id": f"c{n}"}],
            )

    model = _SubModel()
    out = await _llm.langchain_tool_loop(
        model,
        system="you are subagent",
        user="find things",
        tools={},
        max_steps=3,
    )
    assert model._saw, "sub-agent loop never injected MAX_STEPS_PROMPT"
    assert "subagent summary" in out, out
    print("  sub-agent loop injected MAX_STEPS_PROMPT and summarized")


async def test_agent_registry_has_per_agent_steps():
    """Each sub-agent in the registry carries a hard step budget (opencode's
    agent.steps)."""
    from agent_registry import AGENTS

    assert AGENTS["subagent"]["steps"] > 0
    # The single sub-agent has a sane step budget (no step limit on grep/glob/read).
    print("  registry per-agent step budgets present")


class _CountingModel(_MaxStepsModel):
    """Count tool steps until the MAX_STEPS_PROMPT injection (budget probe)."""

    def __init__(self):
        super().__init__()
        self.tool_steps = 0

    async def astream(self, msgs):
        async for m in super().astream(msgs):
            if getattr(m, "tool_calls", None):
                self.tool_steps += 1
            yield m


async def test_auto_budget_finishes_in_one_turn():
    """Auto MAX_STEPS budget stays 12-50: enough to finish without a
    'continue' turn, capped to bound worst-case LLM round-trips."""
    for ctx, expected in ((0, 24), (20_000, 12), (1_000_000, 50)):
        model = _CountingModel()
        state = {
            "chat_id": "budget-test",
            "context_window": ctx,
            "model_name": "fake",
            "mode": "ask",
            "request": "x",
        }
        await _run_with(model, state)
        # Final step injects MAX_STEPS_PROMPT so the model summarizes
        # instead of calling a tool: tool steps = budget - 1.
        assert model.tool_steps == expected - 1, (
            f"ctx={ctx}: expected {expected - 1} tool steps, got {model.tool_steps}"
        )
    print("  auto budget 12-50 finishes without extra continue turn")


def test_subagent_steps_capped_at_50():
    """Sub-agent worst-case LLM requests halved (100 -> 50), still enough
    for batched multi-file work in one go."""
    from agent_registry import AGENTS

    assert AGENTS["subagent"]["steps"] == 50


async def main():
    await test_main_loop_injects_max_steps_prompt_on_final_step()
    await test_text_only_reply_unaffected()
    await test_subagent_loop_injects_max_steps_prompt()
    await test_agent_registry_has_per_agent_steps()
    print("MAX-STEPS-PROMPT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
