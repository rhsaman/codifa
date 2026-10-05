"""Background sub-agent job registry housekeeping.

Guards:
1. ``create_job`` GC: a new spawn sweeps the chat's already-delivered
   terminal jobs (registry + right-panel view stay bounded), but keeps
   finished-but-undelivered jobs — graph.py still has to inject those
   reports into the running turn.
2. Per-chat isolation: jobs of other chats are never swept or listed.
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subjobs-gc-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import subagent_jobs as jobs


def test_create_job_sweeps_delivered_terminal_jobs():
    done = jobs.create_job("c1", 0, "old done", "subagent")
    jobs.finish_job(done["task_id"], "completed", "report")
    assert jobs.pop_completed_reports("c1"), "report must be claimable"
    assert jobs.get_job(done["task_id"]) is not None

    fresh = jobs.create_job("c1", 0, "new task", "subagent")
    # The delivered terminal job was swept by the new spawn...
    assert jobs.get_job(done["task_id"]) is None
    # ...and the fresh job is registered.
    assert jobs.get_job(fresh["task_id"]) is not None
    assert [j["task_id"] for j in jobs.list_chat_jobs("c1")] == [fresh["task_id"]]


def test_create_job_keeps_undelivered_finished_jobs():
    failed = jobs.create_job("c2", 0, "failed task", "subagent")
    jobs.finish_job(failed["task_id"], "failed", "boom")
    # Finished but NOT delivered yet: a new spawn must keep it.
    jobs.create_job("c2", 0, "next task", "subagent")
    assert jobs.get_job(failed["task_id"]) is not None
    # Once delivered, the next spawn sweeps it.
    assert jobs.pop_completed_reports("c2")
    jobs.create_job("c2", 0, "third task", "subagent")
    assert jobs.get_job(failed["task_id"]) is None


def test_gc_is_per_chat():
    a = jobs.create_job("ca", 0, "chat a task", "subagent")
    b = jobs.create_job("cb", 0, "chat b task", "subagent")
    jobs.finish_job(a["task_id"], "completed", "r")
    assert jobs.pop_completed_reports("ca")
    # A spawn in chat b must not touch chat a's jobs.
    jobs.create_job("cb", 0, "chat b second", "subagent")
    assert jobs.get_job(a["task_id"]) is not None
    assert jobs.get_job(b["task_id"]) is not None


def test_append_event_trail_is_bounded():
    j = jobs.create_job("ct", 0, "trail task", "subagent")
    for i in range(30):
        jobs.append_event(j["task_id"], f"step {i}")
    job = jobs.get_job(j["task_id"])
    assert len(job["events"]) == jobs._JOB_EVENTS_MAX
    assert job["events"][-1]["text"] == "step 29"
    # Unknown task / empty text are silent no-ops.
    jobs.append_event("no-such-task", "x")
    jobs.append_event(j["task_id"], "   ")
    assert len(job["events"]) == jobs._JOB_EVENTS_MAX


async def test_subagent_run_tees_events_to_job():
    """The sub-agent loop's emit also lands on the job's live activity trail
    (right-panel view) while the parent stream stays untouched."""
    from conftest import await_task_report
    from langchain_core.messages import AIMessage

    import tools as T

    class _ToolCallingModel:
        model_name = "fake"

        def __init__(self) -> None:
            self._called = False

        def bind_tools(self, tools):
            return self

        async def ainvoke(self, msgs):
            if not self._called:
                self._called = True
                return AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "run_terminal", "args": {"command": "echo tee-ok"}, "id": "t1"}
                    ],
                )
            return AIMessage(content="TEE DONE")

    model = _ToolCallingModel()
    cbs = T.make_tool_callbacks(
        tempfile.mkdtemp(prefix="coder-test-tee-ws-"),
        lambda ev: None,
        main_model=model,
    )
    ack = await cbs["task"](
        description="tee test",
        prompt="echo tee-ok",
        subagent_type="subagent",
    )
    report = await await_task_report(ack)
    assert "TEE DONE" in str(report)
    tid = str(ack).split("task_id=", 1)[1].split(",", 1)[0].strip()
    evs = jobs.get_job(tid)["events"]
    # Per-step tool rows (teed from the loop's status events)...
    assert any(
        e["kind"] == "tool" and e["tool"] == "run_terminal" for e in evs
    ), evs
    # ...the loop's final completion entry with the report size...
    assert any(
        e["kind"] == "tool_result" and e["tool"] == "task" and "chars" in e["text"]
        for e in evs
    ), evs
    # ...and NO per-step heartbeat noise (retries would repeat it).
    assert not any(
        e["kind"] == "status"
        and e["text"].startswith(("sub-agent started:", "sub-agent step "))
        for e in evs
    ), evs
