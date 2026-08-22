"""Tests for the ask/plan/coder agent optimization.

Verify the *behavior* changes (per-mode toolsets + prompt directives) and the
search-distiller failure fallback without a live LLM: a spy on ``agents.Agent``
captures the tool list the moment the agent is built and then aborts the run,
so no model call ever happens.
"""
import os
import tempfile

import pytest
from pydantic_ai import Agent as _RealAgent

import agents


class _StopCapture(Exception):
    """Raised by the spy to abort run_agent right after the Agent is built."""


_CAPTURED: list[dict] = []


class _SpyAgent(_RealAgent):
    def __init__(self, *a, **kw):
        tools = kw.get("tools") or []
        _CAPTURED.append(
            {
                "tools": [getattr(t, "name", None) for t in tools],
                "system_prompt": kw.get("system_prompt") or "",
            }
        )
        raise _StopCapture()


@pytest.fixture(autouse=True)
def _spy():
    _CAPTURED.clear()
    orig = agents.Agent
    agents.Agent = _SpyAgent
    yield
    agents.Agent = orig


def _ws():
    d = tempfile.mkdtemp()
    with open(os.path.join(d, "app.py"), "w") as f:
        f.write("def foo():\n    return 42\n")
    return d


async def _run(mode: str, cap=None):
    try:
        async for _ in agents.run_agent(
            provider="custom",
            model_name="mock",
            base_url="http://localhost:1",
            api_key="test",
            root=_ws(),
            mode=mode,
            chat_id="t-" + mode,
            history=[],
            cap=cap or {"readFiles": True, "writeFiles": True, "runTerminal": True, "web": True},
            prompt="do a thing",
        ):
            pass
    except _StopCapture:
        pass


def _agent_for(mode: str) -> dict:
    marker = {"ask": "mentor", "plan": "planning agent", "coder": "implementation-only"}
    for a in _CAPTURED:
        if marker[mode] in a["system_prompt"]:
            return a
    return {}


CODERS_ALLOWED = {"write_file", "edit_file", "confirm_action", "update_plan", "ask_user"}
DISALLOWED = {
    "grep", "glob", "read", "task", "run_terminal", "web_search",
    "fetch_url", "search_console", "memory", "search_memory",
}


async def test_coder_tools_restricted():
    await _run("coder", {"readFiles": True, "writeFiles": True, "runTerminal": True, "web": True})
    a = _agent_for("coder")
    assert a, "coder agent not captured"
    names = set(a["tools"])
    assert names == CODERS_ALLOWED, f"coder toolset mismatch: {names}"
    assert not (names & DISALLOWED), "coder has disallowed tools"


async def test_plan_tools_read_only():
    await _run("plan", {"readFiles": True, "writeFiles": False, "runTerminal": True, "web": True})
    a = _agent_for("plan")
    assert a, "plan agent not captured"
    names = set(a["tools"])
    assert "grep" in names and "read" in names, "plan missing search/read"
    assert "write_file" not in names and "edit_file" not in names, "plan can write?!"
    assert "run_terminal" in names, "plan should keep read-only terminal"


async def test_ask_tools_no_read():
    await _run("ask", {"readFiles": True, "writeFiles": False, "runTerminal": False, "web": True})
    a = _agent_for("ask")
    assert a, "ask agent not captured"
    names = set(a["tools"])
    assert "grep" in names, "ask missing grep"
    assert "read" not in names and "write_file" not in names, "ask should be read-only mentor"


def test_prompt_directives():
    ask = agents.SYSTEM_PROMPTS["ask"]
    plan = agents.SYSTEM_PROMPTS["plan"]
    coder = agents.SYSTEM_PROMPTS["coder"]
    assert "answer directly" in ask and "do NOT call a tool" in ask
    assert "MINIMIZE EXPLORATION" in plan
    assert "without reading the files itself" in plan
    assert "implementation-only" in coder
    assert "cannot grep" in coder and "run commands" in coder and "run tests" in coder
    assert "scout the relevant files" not in coder
    assert "run_terminal" not in coder
