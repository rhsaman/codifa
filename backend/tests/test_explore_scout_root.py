"""Live test: the explore sub-agent receives the AUTO-SCOUTED WORKSPACE OVERVIEW.

agents.py sets `_SCOUT_CTX` before each agent run; task_tool folds it into
the explore sub-agent's system prompt so the sub-agent knows the root is
already listed and does NOT re-glob the root to orient itself (a duplicate of
the auto-scout).

Guards:
1. With `_SCOUT_CTX` set -> the sub-agent's system prompt contains the scout
   header and the root-entries line.
2. Without `_SCOUT_CTX` (default) -> the sub-agent's prompt does NOT contain it
   (no stale scout leaks across turns/chats).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-scout-root-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.messages import ModelRequest, SystemPromptPart  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import _SCOUT_CTX, make_tool_callbacks  # noqa: E402


class SpyModel(TestModel):
    """TestModel that records every system prompt it receives."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.system_prompts: list[str] = []

    def request(self, messages, model_settings=None, model_request_parameters=None):
        for m in messages:
            if isinstance(m, ModelRequest):
                for part in m.parts:
                    if isinstance(part, SystemPromptPart):
                        self.system_prompts.append(part.content)
        return super().request(messages, model_settings, model_request_parameters)


async def _run_explore(spy: SpyModel, ws: str) -> list[dict]:
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=spy,
        main_model=TestModel(custom_output_text="done"),
    )
    report = await tools["task"](
        description="find app logic",
        prompt="find where app logic lives",
        subagent_type="explore",
    )
    assert "<task" in report and "<task_result>" in report, f"unexpected report: {report[:200]}"
    return emitted


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-scout-root-ws-")
    for name in ("app.py", "lib.py", "util.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    scout_text = (
        "=== AUTO-SCOUTED WORKSPACE OVERVIEW (do not take this as exhaustive) ===\n"
        "This already covers the workspace root — do NOT list the root again "
        "this turn.\n"
        f"root: {ws} — top-level entries: app.py, lib.py, util.py"
    )

    # 1. Scout set -> sub-agent's system prompt carries it.
    spy = SpyModel(call_tools=["glob"], custom_output_text="REPORT: found in app.py")
    _SCOUT_CTX.set(scout_text)
    await _run_explore(spy, ws)
    assert spy.system_prompts, "spy saw no sub-agent system prompt"
    prompt = spy.system_prompts[0]
    assert "AUTO-SCOUTED" in prompt, "sub-agent prompt missing the scout header"
    assert "top-level entries: app.py, lib.py, util.py" in prompt, (
        "sub-agent prompt missing the root-entries line"
    )
    print(f"  [1] scout set -> sub-agent prompt carries it ({len(prompt)} chars) OK")

    # 2. Scout NOT set (fresh context) -> no stale scout leaks in.
    spy2 = SpyModel(call_tools=["glob"], custom_output_text="REPORT: found in app.py")
    _SCOUT_CTX.set("")  # simulate a turn where scouting was skipped
    await _run_explore(spy2, ws)
    assert spy2.system_prompts, "spy saw no sub-agent system prompt"
    prompt2 = spy2.system_prompts[0]
    assert "AUTO-SCOUTED" not in prompt2, "stale scout leaked into the sub-agent"
    print("  [2] scout unset -> no stale scout leaks OK")

    print("SCOUT-ROOT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())