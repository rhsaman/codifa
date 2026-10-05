"""Sub-agent wait behavior: still-waiting status and re-wait, no early finalize.

Guards the manager rule: after a wait timeout with jobs still running, the
turn emits a still-waiting status and waits again on the next step instead of
finalizing without the reports.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subwait-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import graph
import subagent_jobs


def _drain_queue(q):
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


async def test_await_emits_still_waiting_on_timeout(monkeypatch):
    monkeypatch.setattr(graph, "_SUBAGENT_WAIT_TIMEOUT_S", 0.05)
    chat = "c-still-wait"
    job = subagent_jobs.create_job(chat, 0, "slow job", "subagent")
    tid = job["task_id"]
    bg = asyncio.create_task(asyncio.sleep(30))
    subagent_jobs.set_task(tid, bg)
    try:
        q: asyncio.Queue = asyncio.Queue()
        waited = await graph._await_subagent_jobs(chat, q)
        assert waited is True
        events = _drain_queue(q)
        stages = [
            e
            for e in events
            if e.get("kind") == "status" and e.get("stage") == "subagent_wait"
        ]
        assert len(stages) >= 2, stages
        assert any("Waiting for 1" in str(e.get("content")) for e in stages)
        assert any("Still waiting for 1" in str(e.get("content")) for e in stages)
        # Re-wait on the next step still blocks instead of finalizing.
        q2: asyncio.Queue = asyncio.Queue()
        waited2 = await graph._await_subagent_jobs(chat, q2)
        assert waited2 is True
    finally:
        bg.cancel()
        try:
            await bg
        except BaseException:  # noqa: BLE001, S110 — test cleanup only
            pass
        subagent_jobs.finish_job(tid, "stopped", "cleanup")
        subagent_jobs.pop_completed_reports(chat)


async def test_await_returns_false_without_pending():
    q: asyncio.Queue = asyncio.Queue()
    assert await graph._await_subagent_jobs("c-still-wait-empty", q) is False
    assert _drain_queue(q) == []


async def test_pending_count_tracks_running_jobs():
    chat = "c-still-count"
    assert graph._subagent_pending_count(chat) == 0
    assert graph._subagent_pending_count("") == 0
    job = subagent_jobs.create_job(chat, 0, "count job", "subagent")
    tid = job["task_id"]
    try:
        assert graph._subagent_pending_count(chat) == 1
    finally:
        subagent_jobs.finish_job(tid, "completed", "done")
    assert graph._subagent_pending_count(chat) == 0
    subagent_jobs.pop_completed_reports(chat)


async def test_report_arriving_during_rewait_is_drained(monkeypatch):
    monkeypatch.setattr(graph, "_SUBAGENT_WAIT_TIMEOUT_S", 0.05)
    chat = "c-still-drain"

    async def _finish_soon(tid):
        await asyncio.sleep(0.15)
        subagent_jobs.finish_job(tid, "completed", "LATE REPORT")

    job = subagent_jobs.create_job(chat, 0, "late job", "subagent")
    tid = job["task_id"]
    bg = asyncio.create_task(asyncio.sleep(30))
    subagent_jobs.set_task(tid, bg)
    finisher = asyncio.create_task(_finish_soon(tid))
    try:
        q: asyncio.Queue = asyncio.Queue()
        # First wait times out while the job is still running.
        assert await graph._await_subagent_jobs(chat, q) is True
        # Wait again on the next step; the report lands meanwhile.
        await asyncio.sleep(0.25)
        msgs: list = []
        delivered = await graph._drain_subagent_reports(msgs, chat, q)
        assert delivered == 1
        assert any("LATE REPORT" in str(getattr(m, "content", "")) for m in msgs)
    finally:
        bg.cancel()
        try:
            await bg
        except BaseException:  # noqa: BLE001, S110 — test cleanup only
            pass
        finisher.cancel()
        try:
            await finisher
        except BaseException:  # noqa: BLE001, S110 — test cleanup only
            pass
        subagent_jobs.pop_completed_reports(chat)
