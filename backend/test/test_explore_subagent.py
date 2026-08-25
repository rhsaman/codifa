"""Unit tests: explore sub-agent prompt + retry/fallback behavior.

Guards the two changes that cut explore token use and stop the Main Agent from
reading the whole codebase by hand when explore fails:

1. EXPLORE_SYSTEM is a tight, grep-first, compact-output prompt (so the explore
   sub-agent finds answers faster and cheaper).
2. _run_subagent_task retries a transient explore-model failure, then falls back
   to the main model for one final attempt, and on total failure returns a
   structured note that steers the Main Agent to re-delegate with a NARROWER
   scope (name a folder/pattern/symbol) instead of reading everything manually.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-sub-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agent_registry import EXPLORE_SYSTEM  # noqa: E402
import tools as tools_mod  # noqa: E402
from tools import _explore_fail_note, make_tool_callbacks  # noqa: E402
import llm as llm_mod  # noqa: E402


async def test_explore_system_prompt_is_compact_and_grep_first():
    """The explore system prompt must instruct grep-first + compact output so
    the sub-agent is cheap and fast."""
    text = EXPLORE_SYSTEM
    assert "COMPACT" in text, "explore prompt must demand a compact report"
    assert "offset" in text and "limit" in text, (
        "explore prompt must tell it to read with offset/limit, not whole files"
    )
    assert "absolute" in text, "explore prompt must return absolute paths"
    assert "Grep" in text and "Glob" in text, (
        "explore prompt must lead with grep/glob, not reads"
    )


async def test_explore_fail_note_steers_to_narrower_scope():
    """The structured failure note must tell the Main Agent to re-delegate with
    a narrower scope rather than read the whole codebase manually."""
    note = _explore_fail_note("explore", "explore-model", RuntimeError("boom"))
    assert "explore" in note
    assert "NARROWER" in note, "note must steer to a narrower scope"
    assert "task(subagent_type='explore')" in note, (
        "note must tell it to re-delegate via the explore task tool"
    )
    assert "Do NOT read the whole codebase manually" in note


class _FailThenSucceedModel:
    """Fails the first N calls, then replies text. Used to exercise retry."""
    model_name = "explore-model"

    def __init__(self, fail_times: int = 2, text: str = "EXPLORE OK"):
        self._fail = fail_times
        self._n = 0
        self._text = text

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        raise RuntimeError("transient explore failure")


async def _run_with_fake_loop(explore_model, main_model, fake_loop):
    """Patch langchain_tool_loop and drive an explore sub-agent."""
    _orig = llm_mod.langchain_tool_loop
    llm_mod.langchain_tool_loop = fake_loop
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-explore-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def main():\n    return 42\n")
        cbs = make_tool_callbacks(
            ws,
            lambda ev: None,
            main_model=main_model,
            explore_model=explore_model,
            reserved=20_000,
        )
        return await cbs["task"](
            description="inspect app.py",
            prompt="Summarize app.py.",
            subagent_type="explore",
        )
    finally:
        llm_mod.langchain_tool_loop = _orig


async def test_explore_retries_then_falls_back_to_main_model():
    """When the explore model fails every retry, the sub-agent falls back to the
    main model for one final attempt and returns its result (no 'sub-agent failed')."""
    calls = {"explore": 0, "main": 0}

    async def fake_loop(model, **kwargs):
        name = str(getattr(model, "model_name", "") or "")
        if name == "explore-model":
            calls["explore"] += 1
            raise RuntimeError("explore model down")
        calls["main"] += 1
        return "MAIN MODEL RESULT"  # main model succeeds on its final attempt

    main_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    main_model.model_name = "main-model"
    explore_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    explore_model.model_name = "explore-model"

    report = await _run_with_fake_loop(explore_model, main_model, fake_loop)

    # 3 retries on explore, then exactly 1 final attempt on the main model.
    assert calls["explore"] == 3, f"expected 3 explore retries, got {calls['explore']}"
    assert calls["main"] == 1, f"expected 1 main-model fallback, got {calls['main']}"
    assert "sub-agent failed" not in report, f"unexpected failure: {report[:200]}"
    assert "MAIN MODEL RESULT" in report, f"main fallback result missing: {report[:200]}"


async def test_explore_total_failure_returns_structured_note():
    """When BOTH the explore model and the main model fail, the report is the
    structured note steering to a narrower scope (not a raw error)."""
    calls = {"explore": 0, "main": 0}

    async def fake_loop(model, **kwargs):
        name = str(getattr(model, "model_name", "") or "")
        if name == "explore-model":
            calls["explore"] += 1
            raise RuntimeError("explore model down")
        calls["main"] += 1
        raise RuntimeError("main model also down")

    main_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    main_model.model_name = "main-model"
    explore_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    explore_model.model_name = "explore-model"

    report = await _run_with_fake_loop(explore_model, main_model, fake_loop)

    assert calls["explore"] == 3, f"expected 3 explore retries, got {calls['explore']}"
    assert calls["main"] == 1, f"expected 1 main-model fallback, got {calls['main']}"
    assert "sub-agent failed" in report, f"expected structured failure note: {report[:200]}"
    assert "NARROWER" in report, "failure note must steer to a narrower scope"
    assert "Do NOT read the whole codebase manually" in report


if __name__ == "__main__":
    asyncio.run(test_explore_system_prompt_is_compact_and_grep_first())
    asyncio.run(test_explore_fail_note_steers_to_narrower_scope())
    asyncio.run(test_explore_retries_then_falls_back_to_main_model())
    asyncio.run(test_explore_total_failure_returns_structured_note())
    print("EXPLORE SUBAGENT TESTS PASSED")
