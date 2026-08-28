"""Regression: the `task` tool's `explore` sub-agent must honor a separate
explore_model override (set via the UI's Tool Models -> Explore slot).

When `explore_model` is passed to make_tool_callbacks, an `explore` sub-agent
runs on THAT model, not the main model. When it is omitted (None), the explore
sub-agent falls back to the main model (the existing default behavior).

Guards:
1. explore sub-agent uses explore_model when provided.
2. explore sub-agent falls back to main_model when explore_model is None.
3. general sub-agent is unaffected (always uses main_model).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-model-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage

import llm as llm_mod
import tools as tools_mod
from tools import make_tool_callbacks


class _FakeModel:
    """LangChain-style fake that replies immediately (no tool calls)."""

    def __init__(self, name: str, text: str = "done") -> None:
        self.model_name = name
        self._text = text

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        return AIMessage(content=self._text)


async def _run_explore(explore_model, main_model):
    """Drive an explore sub-agent and return the model name it actually ran on."""
    captured: dict = {}

    async def fake_tool_loop(model, **kwargs):
        captured["model_name"] = str(getattr(model, "model_name", "") or "")
        return "EXPLORE RESULT"

    # Patch langchain_tool_loop inside the llm module so _run_subagent_task
    # (which does `from llm import langchain_tool_loop`) picks up the override
    # (or the main model fallback) and reports which model it received.
    _orig = llm_mod.langchain_tool_loop
    llm_mod.langchain_tool_loop = fake_tool_loop
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-explore-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def main():\n    return 42\n")
        cbs = make_tool_callbacks(
            ws,
            lambda ev: None,
            main_model=main_model,
            explore_model=explore_model,
        )
        await cbs["task"](
            description="inspect app.py",
            prompt="Summarize app.py.",
            subagent_type="explore",
        )
    finally:
        tools_mod.langchain_tool_loop = _orig
    return captured.get("model_name", "")


async def main():
    main_model = _FakeModel("main-model")
    explore_model = _FakeModel("explore-model")

    # 1. explore honors the override.
    used = await _run_explore(explore_model, main_model)
    assert used == "explore-model", f"explore did not use explore_model: {used!r}"
    print(f"  explore with override -> {used} (expect explore-model)")

    # 2. explore falls back to main model when no override is set.
    used = await _run_explore(None, main_model)
    assert used == "main-model", f"explore did not fall back to main model: {used!r}"
    print(f"  explore without override -> {used} (expect main-model)")

    # 3. general sub-agent always uses the main model (no explore override).
    captured: dict = {}

    async def fake_tool_loop(model, **kwargs):
        captured["model_name"] = str(getattr(model, "model_name", "") or "")
        return "GENERAL RESULT"

    _orig = llm_mod.langchain_tool_loop
    llm_mod.langchain_tool_loop = fake_tool_loop
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-general-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def main():\n    return 42\n")
        cbs = make_tool_callbacks(
            ws,
            lambda ev: None,
            main_model=main_model,
            explore_model=explore_model,
        )
        await cbs["task"](
            description="check app.py",
            prompt="Read app.py and summarize.",
            subagent_type="general",
        )
    finally:
        tools_mod.langchain_tool_loop = _orig
    assert captured.get("model_name") == "main-model", (
        f"general sub-agent should use main model, got {captured.get('model_name')!r}"
    )
    print(f"  general (with explore override set) -> {captured.get('model_name')} (expect main-model)")

    print("EXPLORE-MODEL OVERRIDE TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
