"""Regression: the `task` tool's `subagent` sub-agent must honor a separate
subagent_model override (set via the UI's Tool Models -> Sub-agent slot).

When `explore_model` is passed to make_tool_callbacks, a `subagent` sub-agent
runs on THAT model, not the main model. When it is omitted (None), the
sub-agent falls back to the main model (the existing default behavior).

Guards:
1. sub-agent uses explore_model when provided.
2. sub-agent falls back to main_model when explore_model is None.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subagent-model-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from conftest import await_task_report
from langchain_core.messages import AIMessage

import llm as llm_mod
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


async def _run_subagent(subagent_model, main_model):
    """Drive a sub-agent and return the model name it actually ran on."""
    captured: dict = {}

    async def fake_tool_loop(model, **kwargs):
        captured["model_name"] = str(getattr(model, "model_name", "") or "")
        return "SUBAGENT RESULT"

    # Patch langchain_tool_loop inside the llm module so _run_subagent_task
    # (which does `from llm import langchain_tool_loop`) picks up the override
    # (or the main model fallback) and reports which model it received.
    _orig = llm_mod.langchain_tool_loop
    llm_mod.langchain_tool_loop = fake_tool_loop
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-subagent-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def main():\n    return 42\n")
        cbs = make_tool_callbacks(
            ws,
            lambda ev: None,
            main_model=main_model,
            explore_model=subagent_model,
        )
        ack = await cbs["task"](
            description="inspect app.py",
            prompt="Summarize app.py.",
            subagent_type="subagent",
        )
        # Background dispatch: the loop runs after task() returns — await the
        # registry job while the langchain_tool_loop patch is still applied.
        await await_task_report(ack)
    finally:
        llm_mod.langchain_tool_loop = _orig
    return captured.get("model_name", "")


async def _run_subagent_model_override_cases() -> None:
    main_model = _FakeModel("main-model")
    subagent_model = _FakeModel("subagent-model")

    # 1. sub-agent honors the override.
    used = await _run_subagent(subagent_model, main_model)
    assert used == "subagent-model", f"sub-agent did not use subagent_model: {used!r}"
    print(f"  sub-agent with override -> {used} (expect subagent-model)")

    # 2. sub-agent falls back to main model when no override is set.
    used = await _run_subagent(None, main_model)
    assert used == "main-model", f"sub-agent did not fall back to main model: {used!r}"
    print(f"  sub-agent without override -> {used} (expect main-model)")

    print("SUBAGENT-MODEL OVERRIDE TEST PASSED")


async def test_subagent_model_override() -> None:
    """Same coverage as the legacy ``main()``; exposed as a pytest test so
    ``pytest tests/`` actually collects and runs it.
    """
    await _run_subagent_model_override_cases()


def main() -> None:
    asyncio.run(_run_subagent_model_override_cases())


if __name__ == "__main__":
    main()
