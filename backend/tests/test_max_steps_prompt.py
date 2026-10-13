"""Unit test: step budgets — no user cap, high internal safety ceiling.

The MAIN agent loop has no user-configurable step budget (the old 12-50
auto cap cut real tasks in half). A single high internal ceiling (200)
remains as a runaway guard: a model that calls tools with fresh arguments
forever is invisible to the repetition guard and would burn unbounded
tokens without it. Real tasks finish in single-digit steps, so the
ceiling is never reached in practice. Sub-agents (read-only researchers)
keep opencode's MAX_STEPS_PROMPT guardrail: on their final allowed step
the model is forced to STOP tool-calling and emit a text summary.

Guards:
1. The main loop runs far past the old 12-50 budget (60 tool steps here)
   with no MAX_STEPS_PROMPT injection.
2. A normal text-only reply (no tool calls) still works and is not affected.
3. The sub-agent loop (langchain_tool_loop) injects _MAX_STEPS_PROMPT on its
   final allowed step and gets a summary.
4. Registry per-agent step budgets stay present and capped.
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


class _LongModel:
    """Tool-calling model with fresh args each step; summarizes after N steps.

    If any step ceiling existed, the loop would stop (or inject
    MAX_STEPS_PROMPT) before N tool steps complete.
    """

    model_name = "fake-long"

    def __init__(self, limit: int = 60):
        self.limit = limit
        self.tool_steps = 0
        self.saw_max_steps = False

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        if any(
            getattr(m, "type", "") == "ai"
            and getattr(m, "content", "") == _agents._MAX_STEPS_PROMPT
            for m in msgs
        ):
            self.saw_max_steps = True
            yield AIMessage(content="Summary: stopped early.")
            return
        n = len([m for m in msgs if getattr(m, "type", "") == "ai"]) + 1
        if n > self.limit:
            yield AIMessage(content="Summary: finished all steps.")
            return
        self.tool_steps += 1
        yield AIMessage(
            content=f"step {n}",
            tool_calls=[{"name": "read", "args": {"filePath": f"f{n}.py"}, "id": f"call_{n}"}],
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


async def test_main_loop_runs_far_past_old_budget():
    """The main loop must run 60 tool steps (past the old 12-50 cap) with no
    MAX_STEPS_PROMPT injection — real tasks finish instead of being cut."""
    state = {
        "chat_id": "nocap-test",
        "context_window": 0,
        "model_name": "fake",
        "mode": "ask",
        "request": "x",
    }
    model = _LongModel(limit=60)
    events = await _run_with(model, state)
    assert not model.saw_max_steps, "MAX_STEPS_PROMPT must not fire below the ceiling"
    assert model.tool_steps == 60, (
        f"expected 60 uncapped tool steps, got {model.tool_steps}"
    )
    text_events = [e for e in events if e.get("kind") == "text"]
    assert any("finished all steps" in e.get("content", "") for e in text_events), text_events
    print("  main loop ran 60 tool steps, far past the old 12-50 budget")


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


def test_subagent_steps_capped_at_50():
    """Sub-agent worst-case LLM requests halved (100 -> 50), still enough
    for batched multi-file work in one go."""
    from agent_registry import AGENTS

    assert AGENTS["subagent"]["steps"] == 50


async def main():
    await test_main_loop_runs_far_past_old_budget()
    await test_text_only_reply_unaffected()
    await test_subagent_loop_injects_max_steps_prompt()
    await test_agent_registry_has_per_agent_steps()
    print("MAX-STEPS-PROMPT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
