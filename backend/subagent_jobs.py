"""Background sub-agent job registry (per-chat).

The main agent spawns sub-agents via the ``task`` tool without blocking:
each spawn registers a job here keyed by a unique ``task_id``. The
``asyncio.Task`` runs the isolated sub-agent loop; when it finishes the
report is stored on the job so ``graph.py`` can inject it into the main
transcript on the next step and hold the turn open until every job for
the chat is done.

Steer/stop from the main agent:
- ``enqueue_steer`` queues a follow-up message the background runner
  picks up between rounds.
- ``request_stop`` flags the job and cancels its ``asyncio.Task``.
"""

from __future__ import annotations

import contextvars
import time
import uuid

_JOBS: dict[str, dict] = {}


def create_job(chat_id: str, branch: int, description: str, subagent_type: str) -> dict:
    """Register a new running job and return its dict."""
    # GC hook: every new spawn sweeps this chat's already-delivered terminal
    # jobs so the registry (and the right-panel sub-agents view) stays
    # bounded. Undelivered finished jobs are kept — graph.py still has to
    # inject their reports into the running turn.
    clear_delivered_chat_jobs(chat_id)
    tid = f"task-{uuid.uuid4().hex[:8]}"
    while tid in _JOBS:
        tid = f"task-{uuid.uuid4().hex[:8]}"
    job: dict = {
        "task_id": tid,
        "chat_id": str(chat_id or ""),
        "branch": int(branch or 0),
        "description": str(description or "")[:120],
        "subagent_type": str(subagent_type or ""),
        "status": "running",
        "report": "",
        "task": None,
        "steer_inbox": [],
        "stop_requested": False,
        "created_at": time.time(),
        "delivered": False,
    }
    _JOBS[tid] = job
    return job


def get_job(task_id: str) -> dict | None:
    """Return the job dict for ``task_id`` or None."""
    return _JOBS.get(str(task_id or ""))


def list_chat_jobs(chat_id: str) -> list[dict]:
    """All jobs (any status) for one chat."""
    cid = str(chat_id or "")
    return [j for j in _JOBS.values() if j.get("chat_id") == cid]


def pending_jobs(chat_id: str) -> list[dict]:
    """Jobs still running for one chat."""
    return [j for j in list_chat_jobs(chat_id) if j.get("status") == "running"]


def pop_completed_reports(chat_id: str) -> list[tuple[str, str, str]]:
    """Claim undelivered finished reports for a chat.

    Returns ``[(task_id, report, status)]`` and marks each delivered so
    a later turn never re-injects the same report.
    """
    out: list[tuple[str, str, str]] = []
    for job in list_chat_jobs(chat_id):
        if job.get("status") in ("completed", "failed", "stopped") and not job.get(
            "delivered"
        ):
            job["delivered"] = True
            out.append(
                (
                    str(job.get("task_id") or ""),
                    str(job.get("report") or ""),
                    str(job.get("status") or ""),
                )
            )
    return out


# task_id of the sub-agent whose loop is running in the CURRENT context.
# tools._run_subagent_task sets it around the langchain_tool_loop call so
# llm.langchain_tool_loop can drain mid-run steers without threading a
# callback through every call site (same ambient-context pattern as
# tools._SUB_AGENT_CTX). Empty string = no background job in this context.
RUNNING_TASK_CTX: contextvars.ContextVar[str] = contextvars.ContextVar(
    "codifa_running_subagent_task", default=""
)


def drain_steer(task_id: str) -> list[str]:
    """Pop every queued steer message for ``task_id`` (they are consumed).

    Called by the RUNNING loop between steps so a follow-up lands while the
    sub-agent still works; the post-run follow-up loop in tools.py then finds
    an empty inbox and needs no extra round. Unknown task -> no messages.
    """
    job = get_job(task_id)
    if job is None:
        return []
    items = list(job.get("steer_inbox") or [])
    job["steer_inbox"] = []
    out: list[str] = []
    for item in items:
        text = str((item or {}).get("message") or "").strip()
        if text:
            out.append(text)
    return out


def enqueue_steer(task_id: str, message: str) -> dict | None:
    """Queue a follow-up message for a running job."""
    job = get_job(task_id)
    if job is None or job.get("status") != "running":
        return job
    text = str(message or "").strip()
    if not text:
        return job
    job["steer_inbox"].append({"message": text[:4000], "at": time.time()})
    return job


def request_stop(task_id: str) -> dict | None:
    """Flag a job as stop-requested and cancel its asyncio task."""
    job = get_job(task_id)
    if job is None:
        return None
    job["stop_requested"] = True
    task = job.get("task")
    try:
        if task is not None and not task.done():
            task.cancel()
    except Exception:  # noqa: BLE001, S110 — stop must never raise
        pass
    return job


def set_task(task_id: str, task) -> None:
    """Attach the running asyncio task to a job."""
    job = get_job(task_id)
    if job is not None:
        job["task"] = task


def finish_job(task_id: str, status: str, report: str) -> None:
    """Mark a job finished with its final report."""
    job = get_job(task_id)
    if job is not None:
        job["status"] = status
        job["report"] = str(report or "")


# Live activity trail per job (bounded): the right-panel sub-agents view
# reads these instead of subscribing to the SSE stream, so it stays
# per-chat by construction and never re-renders the transcript. Entries are
# structured so the panel can render tool-call-like rows:
# ``{"at", "kind" ("tool"|"tool_result"|"status"), "tool", "text"}``.
_JOB_EVENTS_MAX = 14


def append_event(task_id: str, text: str, tool: str = "", kind: str = "status") -> None:
    """Append one compact activity entry to a job's live trail (bounded)."""
    job = get_job(task_id)
    if job is None:
        return
    text = str(text or "").strip()
    if not text:
        return
    trail = job.setdefault("events", [])
    trail.append({
        "at": time.time(),
        "kind": str(kind or "status"),
        "tool": str(tool or ""),
        "text": text[:160],
    })
    del trail[:-_JOB_EVENTS_MAX]


def clear_delivered_chat_jobs(chat_id: str) -> None:
    """Drop delivered terminal jobs so the registry stays bounded."""
    cid = str(chat_id or "")
    for tid in [
        tid
        for tid, job in _JOBS.items()
        if job.get("chat_id") == cid
        and job.get("status") in ("completed", "failed", "stopped")
        and job.get("delivered")
    ]:
        _JOBS.pop(tid, None)
