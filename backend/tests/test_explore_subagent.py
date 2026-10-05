"""Unit tests: sub-agent prompt + retry/fallback behavior.

Guards the two changes that cut sub-agent token use and stop the Main Agent
from reading the whole codebase by hand when the sub-agent fails:

1. SUBAGENT_SYSTEM is a tight, grep-first, compact-output prompt (so the
   sub-agent finds answers faster and cheaper).
2. _run_subagent_task retries a transient sub-agent-model failure, then falls
   back to the main model for one final attempt, and on total failure returns
   a structured note that steers the Main Agent to re-delegate with a NARROWER
   scope (name a folder/pattern/symbol) instead of reading everything manually.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subagent-sub-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import llm as llm_mod
import tools as tools_mod
from agent_registry import SUBAGENT_SYSTEM
from agents import _is_retryable
from tools import _subagent_fail_scope_note, make_tool_callbacks


async def test_subagent_system_prompt_is_compact_and_grep_first():
    """The sub-agent system prompt must instruct grep-first + compact output
    so the sub-agent is cheap and fast."""
    text = SUBAGENT_SYSTEM
    assert "COMPACT" in text, "sub-agent prompt must demand a compact report"
    assert "offset" in text and "limit" in text, (
        "sub-agent prompt must tell it to read with offset/limit, not whole files"
    )
    assert "absolute" in text, "sub-agent prompt must return absolute paths"
    assert "Grep" in text and "Glob" in text, (
        "sub-agent prompt must lead with grep/glob, not reads"
    )


async def test_subagent_system_batches_searches_and_bans_chunk_walking():
    """The sub-agent prompt must state search merging, ban sequential chunk
    reading and repeated reads — regression for the subagent review CSS layout
    log with 19 calls (separate searches, chunk-reading global.css, re-reading
    Chat.tsx and global.css)."""
    text = SUBAGENT_SYSTEM
    assert "patterns=[...]" in text, "باید ادغام چند grep/glob در یک فراخوانی را بگوید"
    assert "ranges=[" in text, "باید خوانش چندپنجره‌ای با ranges را بگوید"
    assert "NEVER walk a large file chunk-by-chunk" in text, (
        "باید تکه‌خوانی ترتیبی فایل بزرگ را منع کند"
    )
    assert "when in doubt, re-read" in text, (
        "باید بگوید در صورت تردید دوباره بخواند"
    )
    assert "Finish ALL Glob/Grep discovery FIRST" in text, (
        "باید ترتیب اکتشاف-اول-بعد-خوانش را صریح بگوید"
    )


async def test_subagent_fail_note_steers_to_narrower_scope():
    """The structured failure note must tell the Main Agent to re-delegate
    with a narrower scope rather than read the whole codebase manually."""
    note = _subagent_fail_scope_note("subagent", "subagent-model", RuntimeError("boom"))
    assert "subagent" in note
    assert "NARROWER" in note, "note must steer to a narrower scope"
    assert "task(subagent_type='subagent')" in note, (
        "note must tell it to re-delegate via the sub-agent task tool"
    )
    assert "Do NOT read the whole codebase manually" in note


class _FailThenSucceedModel:
    """Fails the first N calls, then replies text. Used to exercise retry."""
    model_name = "subagent-model"

    def __init__(self, fail_times: int = 2, text: str = "SUBAGENT OK"):
        self._fail = fail_times
        self._n = 0
        self._text = text

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        raise RuntimeError("transient sub-agent failure")


async def _run_with_fake_loop(subagent_model, main_model, fake_loop):
    """Patch langchain_tool_loop and drive a sub-agent.

    The task tool now dispatches in background and returns a spawn
    acknowledgement. Await the registry job to completion and return the
    final report so retry/fallback assertions still observe the full run.
    """
    import re as _re

    import subagent_jobs as _jobs

    _orig = llm_mod.langchain_tool_loop
    llm_mod.langchain_tool_loop = fake_loop
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-subagent-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def main():\n    return 42\n")
        cbs = make_tool_callbacks(
            ws,
            lambda ev: None,
            main_model=main_model,
            explore_model=subagent_model,
            reserved=20_000,
        )
        ack = await cbs["task"](
            description="inspect app.py",
            prompt="Summarize app.py.",
            subagent_type="subagent",
        )
        # Blocking fallback (no running loop) returns the report directly.
        if "Sub-agent started in background" not in str(ack):
            return str(ack)
        _m = _re.search(r"task_id=(task-[0-9a-f]+)", str(ack))
        _tid = _m.group(1) if _m else ""
        _job = _jobs.get_job(_tid) if _tid else None
        _task = _job.get("task") if _job else None
        if _task is not None:
            try:
                await _task
            except Exception:  # noqa: BLE001, S110 — report is stored on the job
                pass
        _job = _jobs.get_job(_tid) if _tid else None
        return str((_job or {}).get("report") or "")
    finally:
        llm_mod.langchain_tool_loop = _orig


async def test_subagent_retries_then_falls_back_to_main_model():
    """When the sub-agent model fails every retry, the sub-agent falls back
    to the main model for one final attempt and returns its result (no
    'sub-agent failed')."""
    calls = {"subagent": 0, "main": 0}

    async def fake_loop(model, **kwargs):
        name = str(getattr(model, "model_name", "") or "")
        if name == "subagent-model":
            calls["subagent"] += 1
            raise RuntimeError("sub-agent model down")
        calls["main"] += 1
        return "MAIN MODEL RESULT"  # main model succeeds on its final attempt

    main_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    main_model.model_name = "main-model"
    subagent_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    subagent_model.model_name = "subagent-model"

    report = await _run_with_fake_loop(subagent_model, main_model, fake_loop)

    # 3 retries on the sub-agent model, then exactly 1 final attempt on main.
    assert calls["subagent"] == 3, f"expected 3 sub-agent retries, got {calls['subagent']}"
    assert calls["main"] == 1, f"expected 1 main-model fallback, got {calls['main']}"
    assert "sub-agent failed" not in report, f"unexpected failure: {report[:200]}"
    assert "MAIN MODEL RESULT" in report, f"main fallback result missing: {report[:200]}"


async def test_subagent_total_failure_returns_structured_note():
    """When BOTH the sub-agent model and the main model fail, the report is
    the structured note steering to a narrower scope (not a raw error)."""
    calls = {"subagent": 0, "main": 0}

    async def fake_loop(model, **kwargs):
        name = str(getattr(model, "model_name", "") or "")
        if name == "subagent-model":
            calls["subagent"] += 1
            raise RuntimeError("sub-agent model down")
        calls["main"] += 1
        raise RuntimeError("main model also down")

    main_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    main_model.model_name = "main-model"
    subagent_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    subagent_model.model_name = "subagent-model"

    report = await _run_with_fake_loop(subagent_model, main_model, fake_loop)

    assert calls["subagent"] == 3, f"expected 3 sub-agent retries, got {calls['subagent']}"
    assert calls["main"] == 1, f"expected 1 main-model fallback, got {calls['main']}"
    assert "sub-agent failed" in report, f"expected structured failure note: {report[:200]}"
    assert "NARROWER" in report, "failure note must steer to a narrower scope"
    assert "Do NOT read the whole codebase manually" in report


async def test_upstream_connection_lost_is_retryable():
    """Gateway 'upstream connection lost' must auto-retry instead of failing the turn."""
    assert _is_retryable(RuntimeError("upstream connection lost")) is True
    assert _is_retryable(RuntimeError("Upstream Connection Lost: proxy hiccup")) is True


async def test_subagent_auto_retry_emits_retry_and_fallback_events():
    """Auto-retry must emit retry banner events during backoff and a fallback
    event when falling back to the main model, so the UI never stays silent."""
    events: list[dict] = []
    calls = {"subagent": 0, "main": 0}

    async def fake_loop(model, **kwargs):
        name = str(getattr(model, "model_name", "") or "")
        if name == "subagent-model":
            calls["subagent"] += 1
            raise RuntimeError("sub-agent model down")
        calls["main"] += 1
        return "MAIN MODEL RESULT"

    main_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    main_model.model_name = "main-model"
    subagent_model = _FailThenSucceedModel.__new__(_FailThenSucceedModel)
    subagent_model.model_name = "subagent-model"

    orig_sleep = tools_mod.asyncio.sleep

    async def _no_sleep(_delay):
        return None

    tools_mod.asyncio.sleep = _no_sleep  # type: ignore[assignment]
    orig_loop = llm_mod.langchain_tool_loop
    llm_mod.langchain_tool_loop = fake_loop  # type: ignore[assignment]
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-subagent-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def main():\n    return 42\n")
        cbs = make_tool_callbacks(
            ws,
            events.append,
            main_model=main_model,
            explore_model=subagent_model,
            reserved=20_000,
        )
        ack = await cbs["task"](
            description="inspect app.py",
            prompt="Summarize app.py.",
            subagent_type="subagent",
        )
        # Background dispatch returns a spawn acknowledgement: await the
        # registry job so retry/fallback events have fired before asserting.
        import re as _re2

        import subagent_jobs as _jobs2

        if "Sub-agent started in background" in str(ack):
            _m2 = _re2.search(r"task_id=(task-[0-9a-f]+)", str(ack))
            _tid2 = _m2.group(1) if _m2 else ""
            _job2 = _jobs2.get_job(_tid2) if _tid2 else None
            _task2 = _job2.get("task") if _job2 else None
            if _task2 is not None:
                try:
                    await _task2
                except Exception:  # noqa: BLE001, S110 — report stored on job
                    pass
            _job2 = _jobs2.get_job(_tid2) if _tid2 else None
            report = str((_job2 or {}).get("report") or "")
        else:
            report = str(ack)
    finally:
        tools_mod.asyncio.sleep = orig_sleep  # type: ignore[assignment]
        llm_mod.langchain_tool_loop = orig_loop

    assert "MAIN MODEL RESULT" in report
    retries = [e for e in events if e.get("kind") == "retry"]
    assert retries, "expected retry banner events during auto-retry backoff"
    assert any(e.get("fallback") is True for e in retries), (
        "expected a fallback retry event when switching to the main model"
    )
    assert any(
        e.get("fallback") is not True and e.get("attempt", 0) >= 1 for e in retries
    ), "expected transient retry events before the fallback"


if __name__ == "__main__":
    asyncio.run(test_subagent_system_prompt_is_compact_and_grep_first())
    asyncio.run(test_subagent_system_batches_searches_and_bans_chunk_walking())
    asyncio.run(test_subagent_fail_note_steers_to_narrower_scope())
    asyncio.run(test_subagent_retries_then_falls_back_to_main_model())
    asyncio.run(test_subagent_total_failure_returns_structured_note())
    asyncio.run(test_upstream_connection_lost_is_retryable())
    asyncio.run(test_subagent_auto_retry_emits_retry_and_fallback_events())
    print("SUBAGENT TESTS PASSED")
