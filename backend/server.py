"""FastAPI sidecar serving the LangGraph agent over SSE.

Runs on 127.0.0.1:<ephemeral port>, spawned by the Electron main process. Only
reachable from the local machine. All file access is confined to the ROOT
provided in each request.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import time
import tracemalloc
from collections.abc import AsyncIterator
from typing import Annotated
from urllib.parse import quote

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

logger = logging.getLogger("codifa.server")

# tracemalloc instrumentation state. Tracing is started once at sidecar boot
# (see _maybe_start_tracemalloc) and a snapshot is taken after every agent run
# so codifa.log can show *which* allocator is growing between runs — the key to
# diagnosing the RSS climb flagged by the "agent run complete rss_mb=..." line.
_TRACE_PREV_SNAPSHOT = None
# frame depth must be small: in production self-cost is dominated by per-allocation
# bookkeeping, and 5 frames is enough to locate any allocator.
_TRACE_FRAMES = 5
# Skip snapshot above this RSS — tracemalloc's own materialization can push a
# near-OOM process over the edge. 1200 MB matches Electron's typical heap cap.
_TRACE_RSS_SNAPSHOT_MAX_MB = 1200.0


def _rss_mb() -> float | None:
    """Peak resident memory in MB, best-effort (unix only). Helpful for spotting
    the OOM crashes that manifest as a silent sidecar drop mid-turn."""
    try:
        import resource
        import sys

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS reports bytes; Linux reports KB.
        if sys.platform == "darwin":
            return rss / (1024 * 1024)
        return rss / 1024
    except Exception:  # noqa: BLE001 — RSS is best-effort diagnostics only
        return None


def _maybe_start_tracemalloc() -> None:
    """Start allocation tracing once, if enabled via env or DEBUG logging.

    tracemalloc overhead is modest but non-zero, so tracing stays OFF unless the
    operator opts in (CODFA_TRACE_MALLOC=1) or runs a DEBUG diagnostic session
    (CODFA_LOG_LEVEL=DEBUG). Once started it is never stopped for the process
    lifetime; snapshots are diffed run-over-run in _log_memory_snapshot.
    """
    global _TRACE_PREV_SNAPSHOT
    if tracemalloc.is_tracing():
        return
    _enabled = os.environ.get("CODFA_TRACE_MALLOC", "").strip() in ("1", "true", "yes")
    _debug = os.environ.get("CODFA_LOG_LEVEL", "WARNING").upper() == "DEBUG"
    if not (_enabled or _debug):
        return
    try:
        tracemalloc.start(_TRACE_FRAMES)
        _TRACE_PREV_SNAPSHOT = None
        logger.warning("tracemalloc tracing started (run-complete snapshots enabled)")
    except Exception:  # noqa: BLE001, S110 — tracing must never break the sidecar
        pass


def _log_memory_snapshot(chat_id: str) -> None:
    """Log the top allocation growth since the last run, and top overall holders.

    Only does work when tracemalloc is actually tracing. Emits a compact,
    grep-friendly block so the dominant allocator between runs is visible in
    codifa.log without external tooling.
    """
    global _TRACE_PREV_SNAPSHOT
    if not tracemalloc.is_tracing():
        return
    try:
        # Guard: skip the snapshot when RSS is already too high. take_snapshot()
        # materializes every live trace and can transiently spike RSS by hundreds
        # of MB; on a near-OOM sidecar that materialization can be the trigger
        # that finally tips the process over the edge.
        _rss = _rss_mb() or 0.0
        if _rss > _TRACE_RSS_SNAPSHOT_MAX_MB:
            logger.warning(
                "tracemalloc snapshot skipped chat_id=%s rss_mb=%.1f (above %.0f MiB cap)",
                chat_id, _rss, _TRACE_RSS_SNAPSHOT_MAX_MB,
            )
            return

        # Drop the previous snapshot reference FIRST so its trace frames are
        # reclaimable before we allocate the next one. Without this, the old
        # trace stays alive in tracemalloc's internal bookkeeping and RSS
        # high-water accumulates run-over-run.
        prev = _TRACE_PREV_SNAPSHOT
        _TRACE_PREV_SNAPSHOT = None
        del prev

        # NOTE: take_snapshot() materializes every live trace (hundreds of
        # thousands here) and can transiently spike RSS by hundreds of MB. On
        # macOS ru_maxrss is a monotonic high-water mark, so that transient spike
        # shows up as a fake "jump" in the next "agent run start rss_mb". Log RSS
        # around the snapshot so the instrumentation's own cost is visible and
        # not mistaken for a leak.
        _rss_before = _rss
        _snap = tracemalloc.take_snapshot()
        _rss_after = _rss_mb() or 0.0
        if _rss_after - _rss_before > 50.0:
            logger.warning(
                "tracemalloc snapshot self-cost chat_id=%s ~%.0f MiB (transient, RSS high-water only)",
                chat_id,
                _rss_after - _rss_before,
            )

        def _loc_of(stat) -> str:
            # statistics() -> Statistic (traceback attr); compare_to() ->
            # StatisticDiff (trace attr). Normalize so both render the same.
            _tb = getattr(stat, "traceback", None) or getattr(stat, "trace", None)
            if not _tb:
                return "?"
            _frames = _tb.format()
            return _frames[-1] if _frames else "?"

        if _TRACE_PREV_SNAPSHOT is not None:
            _top = _snap.compare_to(_TRACE_PREV_SNAPSHOT, "lineno")[:8]
            _lines = [
                f"MEM-GROW chat_id={chat_id} top allocators since last run (size KiB / count):"
            ]
            for _st in _top:
                _lines.append(
                    f"  +{_st.size / 1024:.0f} KiB  {_st.count} objs  {_loc_of(_st)}"
                )
            logger.warning("\n".join(_lines))
        # Top overall current holders (where the memory lives right now).
        _overall = _snap.statistics("lineno")[:8]
        _olines = [
            f"MEM-NOW chat_id={chat_id} top current allocations (size KiB / count):"
        ]
        for _st in _overall:
            _olines.append(
                f"  {_st.size / 1024:.0f} KiB  {_st.count} objs  {_loc_of(_st)}"
            )
        logger.warning("\n".join(_olines))
        _TRACE_PREV_SNAPSHOT = _snap
    except Exception:  # noqa: BLE001, S110 — diagnostics must never break the run
        pass

# Pending permission requests: id -> asyncio.Future. Resolved by the
# /permission/respond endpoint and awaited by the agent's request_permission /
# confirm_action tools.
PERMISSION_GATES: dict[str, asyncio.Future] = {}
# Pending multiple-choice / open questions the agent asked the user mid-task.
# Resolved by /ask/respond and awaited by the agent's ask_user tool.
ASK_GATES: dict[str, asyncio.Future] = {}
# Google OAuth sign-in state: generated `state` token -> dict(client_id,
# client_secret, redirect_uri, expiry). Populated by /oauth/google/start (when
# the Electron main opens the consent window) and consumed by the callback that
# exchanges the resulting authorization code for tokens.
OAUTH_STATES: dict[str, dict] = {}
# Authorization codes received via the callback, keyed by `state` so the
# renderer can pick them up once the exchange lands.
OAUTH_CODES: dict[str, str] = {}
# Completed OAuth exchanges, keyed by `state`: {refresh_token, access_token,
# expires_in, error}. Written by /oauth/google/callback (called by the OS
# browser), polled by /oauth/google/result (called by the Electron main).
OAUTH_RESULTS: dict[str, dict] = {}

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, model_validator

import providers
from agents import (
    _compact_history,
    _drain_steer,
    _enqueue_steer,
    _is_read_timeout,
    _prune_history,
    _remove_steer,
    normalize_mode,
    run_agent,
)
from graph import (
    clear_chat_resume_checkpoint,
    prune_stale_resume_checkpoints,
)
from llm import build_chat_model, llm_complete


def wants_skill_or_mcp(text: str) -> bool:
    """True when a prompt asks to create/edit/install/import skills or MCP connectors,
    so the agent gets the `create_skill` / `create_mcp` tools for the turn.
    `create_skill` overwrites an existing skill with the same name, so the same
    grant covers both creating AND editing a skill.
    Matches English AND Persian intent words (نصب/ساخت/بساز/ایجاد/ذخیره/اضافه/ویرایش/ادیت/اصلاح/تغییر/حذف/آپدیت/بروز →
    action; اسکیل/مهارت → skill target)."""
    low = text.lower()
    if re.search(r"/\s*(skill|mcp|connector|اسکیل|مهارت)", low):
        return True
    action = re.search(
        r"\b(install|add|create|import|save|set up|setup|copy|edit|update|modify|change|fix|delete|remove)\b|(نصب|ساخت|بساز|ایجاد|ذخیره|اضافه|ویرایش|ادیت|اصلاح|تغییر|حذف|آپدیت|بروز)",
        low,
    )
    target = re.search(r"\b(skill|mcp|connector)s?\b|(اسکیل|مهارت|سورس)", low)
    return bool(action and target)


# Sidecar's own listening port, set in main(). Used to build the loopback
# redirect_uri for Google OAuth (the consent page lands back on this process).
_SIDECAR_PORT = 0


def _oauth_redirect_uri() -> str:
    """Loopback URI Google redirects to after consent. The Electron main catches
    this navigation in-process, so the path only needs to be unique per sidecar."""
    return f"http://127.0.0.1:{_SIDECAR_PORT}/oauth/google/callback"


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Preload models.dev catalog and start the schedule loop at startup.

    The catalog is fetched once and cached in memory. The schedule loop
    runs due tasks every 30 seconds (background, headless).
    """

    async def _bg() -> None:
        try:
            from providers import _models_dev_catalog

            await _models_dev_catalog()
        except Exception:
            logger.warning(
                "models.dev catalog preload failed (non-fatal)", exc_info=True
            )

    _spawn_tracked(_bg(), "models-dev-preload")
    _stop = await _start_schedule_loop()
    # The embedding ONNX model (~1.1 GB resident) is deliberately NOT preloaded
    # here: it loads lazily on the first real embed call (embeddings._load) and
    # is evicted after idle. Preloading pinned that memory on every launch even
    # when RAG / indexing was never used.
    yield
    try:
        _stop.set()
    except Exception:  # noqa: BLE001, S110 — best-effort shutdown signal
        pass

    # Close all cached MCP sessions on exit.
    try:
        from mcp_bridge import shutdown_mcp_sessions

        await shutdown_mcp_sessions()
    except Exception:
        logger.warning("shutdown_mcp_sessions failed", exc_info=True)


app = FastAPI(title="Codifa agent sidecar", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- زمان‌بندی تسک‌های خودکار (مثل Codex) ---------------------------------- #
# حلقه پس‌زمینه هر SCHEDULE_POLL_SECONDS سررسیدها را چک می‌کند؛ اجرای هر تسک
# headless است (بدون ask_user/permission — گیت‌ها None) و نتیجه در
# schedules/runs ثبت می‌شود.

SCHEDULE_POLL_SECONDS = 30
_SCHEDULE_RUNNING: set[str] = set()
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def _spawn_tracked(coro, name: str) -> asyncio.Task:
    """Track a fire-and-forget task so it is not GC-collected and failures log."""
    task = asyncio.create_task(coro, name=name)
    _BACKGROUND_TASKS.add(task)

    def _done(t: asyncio.Task) -> None:
        _BACKGROUND_TASKS.discard(t)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.warning("background task %s failed: %s", name, exc, exc_info=exc)

    task.add_done_callback(_done)
    return task


# Time window (seconds) during which a run counts as fresh "running".
# A task with a running run started inside this window does not start again.
# Disk-backed guard, works across processes and restarts
# (unlike _SCHEDULE_RUNNING which is memory-only).
_SCHEDULE_RUNNING_WINDOW = 15 * 60
# Runs older than this (seconds) count as orphaned at startup and turn to error
# (previous sidecar died mid-run).
_SCHEDULE_ORPHAN_AFTER = 60 * 60


def _has_recent_running(schedule_id: str, now: float) -> bool:
    """True when a fresh running run for this task exists on disk."""
    import state_db

    try:
        runs = state_db.list_schedule_runs(str(schedule_id), limit=5)
    except Exception:  # noqa: BLE001 — unreadable schedule state reads as not-running
        return False
    for r in runs:
        if not isinstance(r, dict) or r.get("status") != "running":
            continue
        try:
            started = float(r.get("started_at") or 0)
        except (TypeError, ValueError):
            continue
        if started and (now - started) < _SCHEDULE_RUNNING_WINDOW:
            return True
    return False


async def _mark_orphaned_running() -> int:
    """ران‌های running به‌جامانده از پردازه قبلی را error کن؛ تعداد."""
    import state_db

    try:
        runs = state_db.list_schedule_runs("", limit=10_000)
    except Exception:  # noqa: BLE001 — unreadable schedule state means nothing to fix
        return 0
    now = time.time()
    fixed = 0
    for r in runs:
        if not isinstance(r, dict) or r.get("status") != "running":
            continue
        try:
            started = float(r.get("started_at") or 0)
        except (TypeError, ValueError):
            started = 0.0
        if started and (now - started) < _SCHEDULE_ORPHAN_AFTER:
            continue
        try:
            state_db.save_schedule_run({
                **r,
                "status": "error",
                "error": "interrupted (sidecar restarted)",
                "finished_at": now,
            })
            fixed += 1
        except Exception:  # noqa: BLE001, S110 — per-task repair is best-effort
            pass
    return fixed


async def _start_schedule_loop() -> asyncio.Event:
    """Start the schedule due-check loop; return the stop event."""
    stop = asyncio.Event()

    async def _loop() -> None:
        # Small initial delay so startup can finish.
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
            return
        except asyncio.TimeoutError:
            pass
        # Close orphaned running runs from the previous process.
        try:
            await _mark_orphaned_running()
        except Exception:
            logger.warning("schedule orphan sweep failed", exc_info=True)
        while not stop.is_set():
            try:
                await _run_due_schedules()
            except Exception:
                logger.warning("schedule loop tick failed", exc_info=True)
            try:
                await asyncio.wait_for(stop.wait(), timeout=SCHEDULE_POLL_SECONDS)
            except asyncio.TimeoutError:
                continue

    _spawn_tracked(_loop(), "schedule-loop")
    return stop


async def _run_due_schedules(now: float | None = None) -> int:
    """Run due tasks; return the number of started runs.

    Multi-guard: each task has at most one concurrent run (``_SCHEDULE_RUNNING``)
    and ``is_due`` ignores missed runs from paused periods, so after resume only
    one fresh run starts — no repeat burst.
    """
    import scheduler
    import state_db

    now = now if now is not None else time.time()
    started = 0
    for task in state_db.list_schedules():
        sid = str(task.get("id") or "")
        if not sid or sid in _SCHEDULE_RUNNING:
            continue
        if not task.get("enabled", True):
            continue
        # گارد روی دیسک: اگر همین تسک یک ران running تازه دارد (حتی از
        # پردازه/تیک دیگر)، اجرای جدید شروع نکن — جلوی ران چندتایی هم‌زمان.
        if _has_recent_running(sid, now):
            continue
        try:
            due = scheduler.is_due(task, now)
        except Exception:
            logger.debug("schedule is_due failed for %s", sid, exc_info=True)
            continue
        if not due:
            # heal: next_run گم‌شده یا stale (قدیمی‌تر از grace) را تازه کن تا
            # تسک گیر نکند — ولی ران missed اجرا نمی‌شود (بدون catch-up).
            try:
                nxt_raw = task.get("next_run")
                nxt_f = float(nxt_raw) if nxt_raw else None
            except (TypeError, ValueError):
                nxt_f = None
            stale = nxt_f is None or (nxt_f <= now and (now - nxt_f) > scheduler.DUE_GRACE_SECONDS)
            if stale:
                try:
                    fresh = state_db.get_schedule(sid) or task
                    fresh["next_run"] = scheduler.compute_next_run(fresh, now)
                    state_db.save_schedule(fresh)
                except Exception:  # noqa: BLE001, S110 — reschedule is best-effort
                    pass
            continue
        _SCHEDULE_RUNNING.add(sid)
        try:
            # Advance next_run here so the next loop tick (30s later) does not
            # see the same task as due again — even if the run is still going.
            try:
                fresh = state_db.get_schedule(sid) or task
                fresh["next_run"] = scheduler.compute_next_run(fresh, now)
                state_db.save_schedule(fresh)
            except Exception:  # noqa: BLE001, S110 — reschedule is best-effort
                pass
            _spawn_tracked(_execute_schedule(sid), f"schedule-{sid}")
            started += 1
        except Exception:
            _SCHEDULE_RUNNING.discard(sid)
            logger.warning("failed to schedule task %s", sid, exc_info=True)
            continue
    return started


async def _execute_schedule(schedule_id: str, run_id: str | None = None) -> None:
    """Headless task run: run_agent without interactive gates + run record."""
    import scheduler
    import state_db

    started_at = time.time()
    preset_run_id = str(run_id or "").strip()
    run_id = preset_run_id
    # تجمیع مصرف توکن (ایونت‌های kind == usage) برای نمایش در model usage.
    usage_totals: dict[tuple[str, str], dict] = {}
    try:
        task = state_db.get_schedule(schedule_id)
        if task is None:
            return
        prompt = str(task.get("prompt") or "").strip()
        root = str(task.get("root") or "").strip()
        if not prompt or not root or not os.path.isdir(root):
            state_db.save_schedule_run({
                "schedule_id": schedule_id,
                "status": "error",
                "error": "پرامپت یا مسیر workspace نامعتبر است",
                "started_at": started_at,
                "finished_at": time.time(),
            })
            return
        # تنظیمات ذخیره‌شده برای مدل/پروایدر + مدل‌های subagent (اختیاری —
        # خالی یعنی پیش‌فرض چت). مدل اسکجول از setting->tools می‌آید.
        settings = state_db.get_settings() or {}
        provider_id = str(task.get("provider_id") or "")
        model = str(task.get("model") or "")
        subagent_models = settings.get("subagentModels") or {}
        if not isinstance(subagent_models, dict):
            subagent_models = {}
        providers_cfg: dict = {}
        for p in settings.get("providers") or []:
            if isinstance(p, dict) and p.get("id"):
                providers_cfg[str(p.get("id"))] = p
        provider_cfg: dict = {}
        active_id = str(settings.get("activeProviderId") or "")
        for p in settings.get("providers") or []:
            if not isinstance(p, dict):
                continue
            if (provider_id and str(p.get("id")) == provider_id) or (
                not provider_id and str(p.get("id")) == active_id
            ):
                provider_cfg = p
                break
        if not provider_cfg and isinstance(settings.get("providers"), list) and settings["providers"]:
            provider_cfg = settings["providers"][0] if isinstance(settings["providers"][0], dict) else {}
        # مدل اسکجول از setting->tools: اگر روی خود تسک مدل/پروایدر ست نشده
        # باشد و در تنظیمات مدل schedule انتخاب شده باشد، از همان استفاده کن.
        schedule_entry = str(subagent_models.get("schedule") or "").strip()
        if schedule_entry and not provider_id and not model:
            try:
                from agents import _subagent_target as _schedule_target

                def _lookup(pid: str) -> dict | None:
                    return providers_cfg.get(pid)

                target = _schedule_target(
                    schedule_entry,
                    str(provider_cfg.get("kind") or "custom"),
                    str(provider_cfg.get("baseUrl") or ""),
                    str(provider_cfg.get("apiKey") or ""),
                    str(provider_cfg.get("envVar") or ""),
                    _lookup,
                    active_id,
                )
                if target:
                    kind, sched_model, burl, akey, env, spid = target
                    if sched_model:
                        provider_cfg = {
                            **provider_cfg,
                            "kind": kind,
                            "baseUrl": burl,
                            "apiKey": akey,
                            "envVar": env,
                            "id": spid or provider_cfg.get("id") or "",
                        }
                        model = sched_model
            except Exception:  # noqa: BLE001, S110 — model override fallback stays
                pass
        if run_id:
            # ران running از قبل توسط POST /run ساخته شده؛ started_at آن را نگه دار.
            try:
                existing = None
                for r in state_db.list_schedule_runs(schedule_id, limit=5):
                    if isinstance(r, dict) and str(r.get("id") or "") == run_id:
                        existing = r
                        break
                if isinstance(existing, dict) and existing.get("started_at"):
                    started_at = float(existing.get("started_at"))
            except Exception:  # noqa: BLE001, S110 — خواندن رکورد running اختیاری است
                pass
        else:
            run = state_db.save_schedule_run({
                "schedule_id": schedule_id,
                "status": "running",
                "started_at": started_at,
            })
            run_id = str(run.get("id"))
        # اجرای headless: گیت‌های تعاملی None → ابزارهای ask/permission
        # بلافاصله خطای «سیستم در دسترس نیست» می‌دهند و مدل ادامه می‌دهد.
        final_text = ""

        def _accrue_schedule_usage(ev: dict) -> None:
            try:
                if ev.get("unbilled"):
                    return
                inp = int(ev.get("input_tokens") or 0)
                outp = int(ev.get("output_tokens") or 0)
                cr = int(ev.get("cache_read_tokens") or 0)
                cw = int(ev.get("cache_write_tokens") or 0)
                if inp + outp + cr + cw <= 0:
                    return
                pid = str(ev.get("provider_id") or ev.get("provider") or provider_cfg.get("id") or "")
                mdl = str(ev.get("model") or model or provider_cfg.get("model") or "main")
                key = (pid, mdl)
                cur = usage_totals.get(key)
                if cur is None:
                    cur = {"providerId": pid, "model": mdl, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "lastUsed": 0}
                    usage_totals[key] = cur
                cur["input"] += inp
                cur["output"] += outp
                cur["cacheRead"] += cr
                cur["cacheWrite"] += cw
                cur["lastUsed"] = int(time.time() * 1000)
            except Exception:  # noqa: BLE001, S110 — تجمیع usage نباید اجرا را بکشد
                pass

        async for event in run_agent(
            provider=str(provider_cfg.get("kind") or "custom"),
            provider_id=str(provider_cfg.get("id") or ""),
            model_name=model or str(provider_cfg.get("model") or ""),
            base_url=str(provider_cfg.get("baseUrl") or ""),
            api_key=str(provider_cfg.get("apiKey") or ""),
            env_var=str(provider_cfg.get("envVar") or ""),
            root=root,
            mode=str(task.get("mode") or "coder"),
            prompt=prompt,
            history=[],
            permission_gates=None,
            ask_gates=None,
            subagent_models=dict(subagent_models),
            providers=providers_cfg,
            chat_id=f"schedule-{schedule_id}",
        ):
            if isinstance(event, dict):
                if event.get("kind") == "text":
                    final_text += str(event.get("content") or "")
                elif event.get("kind") == "usage":
                    _accrue_schedule_usage(event)
        finished = time.time()
        done_run: dict = {
            "id": run_id,
            "schedule_id": schedule_id,
            "status": "done",
            "output": final_text[:8000],
            "started_at": started_at,
            "finished_at": finished,
        }
        if usage_totals:
            done_run["usage"] = {"entries": list(usage_totals.values())}
        state_db.save_schedule_run(done_run)
        # به‌روزرسانی last_run/next_run/run_count تسک
        fresh = state_db.get_schedule(schedule_id) or task
        fresh["last_run"] = finished
        fresh["run_count"] = int(fresh.get("run_count") or 0) + 1
        try:
            fresh["next_run"] = scheduler.compute_next_run(fresh, finished)
        except Exception:  # noqa: BLE001 — بدون نوبت بعدی ادامه می‌دهد
            fresh["next_run"] = None
        state_db.save_schedule(fresh)
        try:
            state_db.prune_schedule_runs(schedule_id)
        except Exception:  # noqa: BLE001, S110 — prune اختیاری است
            pass
    except Exception as exc:  # خطای اجرا نباید حلقه را بکشد
        logger.warning("schedule %s failed: %s", schedule_id, exc, exc_info=True)
        try:
            err_run: dict = {
                **({"id": run_id} if run_id else {}),
                "schedule_id": schedule_id,
                "status": "error",
                "error": str(exc)[:500],
                "started_at": started_at,
                "finished_at": time.time(),
            }
            if usage_totals:
                err_run["usage"] = {"entries": list(usage_totals.values())}
            state_db.save_schedule_run(err_run)
        except Exception:  # noqa: BLE001, S110 — ثبت خطا best-effort است
            pass
    finally:
        _SCHEDULE_RUNNING.discard(schedule_id)


class ScheduleUpsertRequest(BaseModel):
    """ساخت/ویرایش تسک زمان‌بندی."""

    id: str = ""
    name: str = ""
    prompt: str = ""
    cron: str = ""
    enabled: bool = True
    root: str = ""
    mode: str = "coder"
    provider_id: str = ""
    model: str = ""


@app.get("/schedules")
async def schedules_list() -> dict:
    """لیست تسک‌های زمان‌بندی + next_run محاسبه‌شده برای هر کدام."""
    import scheduler
    import state_db

    now = time.time()
    out = []
    for task in state_db.list_schedules():
        t = dict(task)
        try:
            t["next_run"] = scheduler.compute_next_run(task, now)
        except Exception:  # noqa: BLE001 — a bad cron must not hide the schedule
            t["next_run"] = None
        try:
            t["cron_label"] = scheduler.describe_cron_fa(str(task.get("cron") or ""))
        except Exception:  # noqa: BLE001 — show the raw cron when it can't be parsed
            t["cron_label"] = str(task.get("cron") or "")
        out.append(t)
    return {"schedules": out}


@app.post("/schedules")
async def schedules_upsert(req: ScheduleUpsertRequest) -> dict:
    """ایجاد یا ویرایش تسک زمان‌بندی (id خالی = ساخت جدید)."""
    import scheduler
    import state_db

    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="پرامپت تسک خالی است")
    try:
        cron = scheduler.normalize_cron(req.cron or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    existing = state_db.get_schedule(req.id) if req.id else None
    base = existing or {}
    was_disabled = bool(existing and not existing.get("enabled", True))
    task = {
        **base,
        **({"id": req.id} if req.id else {}),
        "name": (req.name or "").strip() or str(base.get("name") or "تسک زمان‌بندی"),
        "prompt": prompt,
        "cron": cron,
        "enabled": bool(req.enabled),
        "root": (req.root or "").strip() or str(base.get("root") or ""),
        "mode": (req.mode or "").strip() or str(base.get("mode") or "coder"),
        "provider_id": (req.provider_id or "").strip(),
        "model": (req.model or "").strip(),
    }
    # resume از لحظه ادامه: اگر تسک از حالت مکث برمی‌گردد، last_run قدیمی
    # (قبل از مکث) را به اکنون منتقل کن تا next_run تازه از همین لحظه حساب
    # شود و ران‌های missed دوران مکث اجرا نشوند. next_run ذخیره‌شده قدیمی
    # هم پاک می‌شود تا پنل ساعت گذشته (stale) نشان ندهد.
    if was_disabled and bool(task.get("enabled", True)):
        task["last_run"] = time.time()
        task.pop("next_run", None)
    saved = state_db.save_schedule(task)
    try:
        saved["next_run"] = scheduler.compute_next_run(saved)
    except Exception:  # noqa: BLE001 — a bad cron must not fail the save
        saved["next_run"] = None
    # next_run محاسبه‌شده را روی دیسک هم persist کن — حلقه پس‌زمینه فقط روی
    # next_run ذخیره‌شده تصمیم می‌گیرد (is_due) و بدون این، تسک تازه هیچ‌وقت
    # due نمی‌شود و در زمان تعیین‌شده اجرا نمی‌کند.
    if saved.get("next_run"):
        try:
            persisted = dict(saved)
            # save_schedule خودش next_run گذشته را پاک می‌کند؛ اینجا مقدار
            # آینده است پس نگه داشته می‌شود.
            state_db.save_schedule(persisted)
        except Exception:  # noqa: BLE001, S110 — persisting next_run is best-effort
            pass
    return {"schedule": saved}


@app.delete("/schedules/{schedule_id}")
async def schedules_delete(schedule_id: str) -> dict:
    """حذف تسک زمان‌بندی (تاریخچه اجراها نگه داشته می‌شود)."""
    import state_db

    if not state_db.delete_schedule(schedule_id):
        raise HTTPException(status_code=404, detail="تسک یافت نشد")
    return {"ok": True}


@app.post("/schedules/{schedule_id}/run")
async def schedules_run_now(schedule_id: str) -> dict:
    """اجرای دستی یک تسک (بدون انتظار برای سررسید).

    فقط گارد حافظه چک می‌شود (اجرای واقعاً در حال انجام در همین پردازه)؛
    گارد روی دیسک عمداً اعمال نمی‌شود تا رکورد running به‌جامانده (یتیم)
    دکمه Run را قفل نکند — اجرای دستی همیشه مجاز است.
    """
    import state_db

    if state_db.get_schedule(schedule_id) is None:
        raise HTTPException(status_code=404, detail="تسک یافت نشد")
    if schedule_id in _SCHEDULE_RUNNING:
        try:
            for r in state_db.list_schedule_runs(schedule_id, limit=5):
                if isinstance(r, dict) and r.get("status") == "running" and r.get("id"):
                    return {"ok": True, "running": True, "run_id": str(r.get("id"))}
        except Exception:  # noqa: BLE001, S110 — بدون run_id هم پاسخ معتبر است
            pass
        return {"ok": True, "running": True}
    # Create the running record synchronously so its id can be returned;
    # polling follows that exact run instead of guessing the latest one.
    run = state_db.save_schedule_run({
        "schedule_id": schedule_id,
        "status": "running",
        "started_at": time.time(),
    })
    new_run_id = str(run.get("id"))
    _SCHEDULE_RUNNING.add(schedule_id)
    try:
        _spawn_tracked(_execute_schedule(schedule_id, new_run_id), f"schedule-{schedule_id}")
    except Exception:
        _SCHEDULE_RUNNING.discard(schedule_id)
        raise
    return {"ok": True, "running": True, "run_id": new_run_id}


@app.get("/schedules/{schedule_id}/runs")
async def schedules_runs(schedule_id: str, limit: int = 20) -> dict:
    """Run history for one task (newest first)."""
    import state_db

    return {"runs": state_db.list_schedule_runs(schedule_id, limit=limit)}


@app.delete("/schedules/{schedule_id}/runs")
async def schedules_runs_clear(schedule_id: str) -> dict:
    """پاک‌کردن چت اینباکس یک کرون: حذف همه اجراهای همان تسک."""
    import state_db

    # تسک حذف‌شده هم ممکن است ران یتیم داشته باشد؛ به‌جای 404 آن‌ها را پاک کن
    # تا دکمه Clear فرانت همیشه کار کند.
    if state_db.get_schedule(schedule_id) is None:
        removed = state_db.delete_schedule_runs(schedule_id)
        return {"ok": True, "removed": removed}
    removed = state_db.delete_schedule_runs(schedule_id)
    return {"ok": True, "removed": removed}


@app.delete("/schedule-runs/orphans")
async def schedule_runs_orphans_clear() -> dict:
    """حذف همه ران‌های یتیم (ران تسک‌های حذف‌شده)."""
    import state_db

    removed = state_db.delete_orphan_schedule_runs()
    return {"ok": True, "removed": removed}


@app.delete("/schedule-runs/{run_id}")
async def schedule_run_delete(run_id: str) -> dict:
    """حذف تکی یک ران با id."""
    import state_db

    if not state_db.delete_schedule_run(run_id):
        raise HTTPException(status_code=404, detail="ران یافت نشد")
    return {"ok": True}


@app.get("/schedule-runs")
async def schedule_runs_all(limit: int = 50) -> dict:
    """تازه‌ترین اجراهای همه تسک‌ها (برای Inbox؛ جدیدترین اول)."""
    import state_db

    try:
        lim = max(1, min(200, int(limit or 50)))
    except (TypeError, ValueError):
        lim = 50
    return {"runs": state_db.list_schedule_runs("", limit=lim)}


class ChatRequest(BaseModel):
    provider: str = "custom"
    # User-configured provider id (distinct from `provider` which is the kind).
    # Several providers can share the same kind (e.g. two openrouter accounts
    # with different ids), so the kind alone is ambiguous for per-usage
    # grouping. Frontend sends both; backend propagates provider_id into the
    # usage event so the sidebar groups by the id the user actually picked.
    provider_id: str = ""

    @model_validator(mode="after")
    def _normalize_mode(self) -> ChatRequest:
        # Normalize legacy/UI mode names (e.g. "chat", "codewriter") to the
        # canonical workflow modes at the API boundary, so downstream code only
        # ever sees keys that exist in SYSTEM_PROMPTS.
        self.mode = normalize_mode(self.mode)
        return self
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    base_url: str = ""
    model: str = ""
    root: str = ""
    mode: str = "chat"
    prompt: str = ""
    history: list[dict] = []
    attachments: list[str] = []
    # Each image may be a string path OR an object {path, dataUrl}; the backend
    # prefers an inline dataUrl so it never depends on reading the frontend's temp
    # file (uploaded images and screenshots both carry one).
    images: list = []
    system_prompt: str = ""
    thinking_level: str = "medium"
    # Whether the selected model is reasoning-capable (from the /models
    # `reasoning` flag). The backend uses this to emit a lightweight composer
    # glow signal while the model reasons, instead of streaming raw thinking
    # text. No model names are inferred here — the flag comes straight from the
    # provider payload / models.dev catalog.
    model_reasoning: bool = False
    mcp_servers: dict = {}
    # Names of skills the user explicitly attached this turn (via @mention).
    # These are the only skills inlined in full; when empty, no skill body is
    # loaded (skills are never auto-selected).
    skills: list[str] = []
    context_window: int = 0
    allow_create: bool = False
    # Mode capabilities: tool access per mode, so the backend can gate tools
    # data-driven instead of hardcoding mode names. Optional for backward compat.
    cap: dict = {}
    # User pre-approved outside-workspace access for this session (workspace).
    allow_outside: bool = False
    # Outside-workspace folders the user pre-approved per-folder ("Always
    # allow" on the per-folder permission dialog). Each entry is an absolute
    # realpath; grants are scoped to exactly that folder subtree.
    allow_outside_folders: list[str] = []
    # User pre-approved desktop-app control (the `computer` tool's mutating
    # actions) for this session — set by "Always allow" in the UI.
    allow_computer: bool = False
    # Absolute path of the file currently open in Neovim (auto-mentioned unless
    # the user disabled it). Resolved against the workspace root; ignored if it
    # escapes the root or the auto-mention is off.
    nvim_file: str = ""
    # LSP diagnostics Neovim reported for the open file (array of dicts with
    # lnum/col/severity/source/code/message). Summarized into the agent's
    # context so it can see what's wrong in the active file.
    nvim_diagnostics: list[dict] = []
    # Chat id (renderer-side) so plans can be stored per chat
    # (<data>/plan/<workspace>/<chat-id>/plan.md) instead of per workspace.
    chat_id: str = ""
    # Directory for the per-workspace RAG vector store (memory + web chunks).
    # Empty string = default (~/.codifa/vector-db).
    vector_db_path: str = ""
    # Size / TTL bounds for the RAG store (max_docs, max_chunks, ttl_days).
    # None = backend defaults.
    vector_config: dict | None = None
    # Retrieval knobs (auto_index, auto_recall, top_k, include_* toggles).
    # None = backend defaults.
    retrieval_config: dict | None = None
    # Per-subagent model overrides: {"search": "model-id", "web": "...", "vision": "...", "compact": "..."}.
    # Missing / empty dict = use the parent model for every subagent.
    subagent_models: dict = {}
    # Cross-provider routing: full provider configs keyed by provider id, so a
    # "providerId/model" subagent entry can be run on that provider's own base
    # URL / key (not the parent provider's).
    providers: dict = {}
    # Single auto-compaction threshold as a percentage of the RAW context window.
    # Auto-compaction fires once `total_tokens >= ctx * compact_at_percent / 100`.
    # The reserved headroom is implicit: `(100 - compact_at_percent)%` of the
    # window is left free. Range 1-99. Default 80.
    compact_at_percent: int = 80
    # Max tool-loop steps per turn (Settings → General). 0 = backend auto from
    # the context window (12–40). N > 0 = fixed budget (clamped 5–200).
    max_steps: int = 0
    # Explicit restart (message retry icon / truncate-and-restart). Skips the
    # interrupted-turn checkpoint and clears it so old tool work is not replayed.
    restart: bool = False


class CompactRequest(BaseModel):
    """Manual ``/compact`` — runs opencode's compaction (structured summary,
    token-budgeted tail, prior-summary merge) on the supplied history."""

    # Primary summarizer (the user's configured compact subagent if any).
    provider: str = "custom"
    model: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    # The user-configured provider id (several rows can share a kind) so the
    # returned usage event groups under the REAL provider. Mirrors
    # ChatRequest.provider_id.
    provider_id: str = ""
    # Fallback summarizer (the active chat model) — mirrors opencode's
    # subagent -> main-model retry when the compact subagent is unavailable.
    fallback_provider: str = ""
    fallback_model: str = ""
    fallback_base_url: str = ""
    fallback_api_key: str = ""
    fallback_env_var: str = ""
    fallback_api_keys: list[str] = []
    fallback_provider_id: str = ""
    # Conversation history to compact — full-fidelity turns (role, content,
    # toolActivity, plan, mode, preservedToolSummary) so the summarizer sees
    # WHAT tools ran, not just prose.
    history: list[dict] = []
    context_window: int = 0
    # Default matches the auto-compact `compact_at_percent` (80) and the UI's
    # default, so a manual /compact without an explicit percent behaves
    # identically to auto-compaction. The frontend always sends the user's
    # actual `compactAtPercent` here, so this is only a fallback.
    compact_at_percent: int = 80


class ModelsRequest(BaseModel):
    provider: str = "custom"
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    base_url: str = ""


class ModelTestRequest(ModelsRequest):
    """POST /models/test — probing one model with a tiny completion."""

    model: str = ""


class ModelDownloadRequest(BaseModel):
    """Download a managed on-device model (whisper / embedding)."""

    kind: str = ""
    model: str = ""
    base_url: str = ""


class ModelRemoveRequest(BaseModel):
    """Delete a downloaded model. ``model`` = repo id (embeddings) or "". """

    kind: str = ""
    model: str = ""


class ModelControlRequest(BaseModel):
    """Pause / resume / cancel a running model download."""

    kind: str = ""


class TtsRequest(BaseModel):
    """POST /tts — synthesize text via an OpenAI-compatible /audio/speech endpoint."""

    text: str = ""
    provider: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    model: str = ""
    voice: str = ""


class PermissionResponse(BaseModel):
    id: str
    allowed: bool


class AskResponse(BaseModel):
    id: str
    answer: str


class StateRequest(BaseModel):
    """Whole-state write from Electron main: settings and/or chat snapshot."""

    settings: dict | None = None
    chats: list | None = None
    deleted_chats: list | None = None
    deleted_workspaces: list | None = None


@app.post("/permission/respond")
async def permission_respond(req: PermissionResponse) -> dict:
    """Resolve a pending outside-workspace permission / confirm_action request from the agent."""
    fut = PERMISSION_GATES.pop(req.id, None)
    if fut is None or fut.done():
        raise HTTPException(status_code=404, detail="permission request not found or already resolved")
    fut.set_result(req.allowed)
    return {"status": "ok"}


@app.post("/ask/respond")
async def ask_respond(req: AskResponse) -> dict:
    """Resolve a pending ask_user question (multiple-choice or free-text) from the agent."""
    fut = ASK_GATES.pop(req.id, None)
    if fut is None or fut.done():
        raise HTTPException(status_code=404, detail="question not found or already answered")
    fut.set_result(req.answer)
    return {"status": "ok"}


# --- app state (settings + chats/messages) ------------------------------ #
# Persisted as plain files in the user data root (backend/state_db.py): a
# settings.json plus per-chat JSON files under chats/<workspace>/. Electron's
# main process reads/writes state through these endpoints; the data root
# defaults to ~/.codifa (configurable via CODER_DATA_DIR).


@app.get("/app/state")
async def app_state() -> dict:
    import state_db

    return state_db.get_state()


@app.post("/app/state")
async def app_save(req: StateRequest) -> dict:
    import state_db

    if req.settings is not None:
        state_db.save_settings(req.settings)
    if req.chats is not None or req.deleted_chats is not None:
        state_db.save_chats(req.chats or [], deleted_ids=req.deleted_chats)
        # A deleted chat's resume checkpoint is now orphaned — drop it so it
        # doesn't linger in the checkpointer SQLite file.
        for cid in req.deleted_chats or []:
            await clear_chat_resume_checkpoint(str(cid))
            try:
                import trace_store as _ts_del

                _ts_del.clear(str(cid))
            except Exception:  # noqa: BLE001, S110 — cleanup never breaks save
                pass
            try:
                import tools as _tools_del

                _tools_del.clear_chat_state(str(cid))
            except Exception:  # noqa: BLE001, S110 — cleanup never breaks save
                pass
            try:
                import browser_session as _bs_del

                await _bs_del.close(str(cid))
            except Exception:  # noqa: BLE001, S110 — cleanup never breaks save
                pass
    if req.deleted_workspaces:
        state_db.remove_workspace_vectors(req.deleted_workspaces)
        try:
            from symbol_index import clear_symbol_cache

            for _root in req.deleted_workspaces or []:
                try:
                    clear_symbol_cache(str(_root))
                except Exception:  # noqa: BLE001, S110 — best-effort
                    pass
        except Exception:  # noqa: BLE001, S110 — best-effort
            pass
    return {"ok": True}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "1.0.0"}


class DocReadRequest(BaseModel):
    """Read a document for the UI viewer. ``path`` may be workspace-relative
    or absolute (imported uploads under the data root are allowed).
    ``format``: text (default) | html (styled Word/Excel view) | pages
    (PDF pages as JPEG data URLs). ``sheet`` selects one Excel sheet,
    ``pages`` selects PDF pages like "1-3,7"."""

    root: str = ""
    path: str = ""
    format: str = "text"
    sheet: str = ""
    pages: str = ""


# Small mtime-keyed cache for /doc/read so repeated viewer polls do not
# re-parse the file while edits still refresh via mtime change.
_DOC_READ_CACHE: dict[tuple[str, str, str, str], tuple[float, dict]] = {}
_DOC_READ_CACHE_MAX = 64


@app.post("/doc/read")
async def doc_read(req: DocReadRequest) -> dict:
    """Extract or render a PDF / Word / Excel / text file for the right-hand
    file viewer (which cannot parse those formats itself)."""
    import doc_tools
    from tools import PathEscapeError, resolve_safe

    p = (req.path or "").strip()
    if not p:
        return {"error": "path is required"}
    try:
        target = resolve_safe((req.root or "").strip() or os.getcwd(), p, allow_coder=True)
    except PathEscapeError as exc:
        return {"error": str(exc)}
    sheet = (req.sheet or "").strip()
    pages = (req.pages or "").strip()
    fmt = (req.format or "text").strip() or "text"
    cache_key = (target, fmt, sheet, pages)
    try:
        mtime = os.path.getmtime(target)
    except OSError:
        mtime = -1.0
    cached = _DOC_READ_CACHE.get(cache_key)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    try:
        if fmt == "html":
            result = {"html": await asyncio.to_thread(doc_tools.render_document, target, sheet, pages)}
        elif fmt == "pages":
            result = {
                "pages": await asyncio.to_thread(doc_tools.render_pdf_pages, target, pages)
            }
        else:
            content = await asyncio.to_thread(doc_tools.read_document, target, sheet, pages)
            result = {"content": content}
        if len(_DOC_READ_CACHE) >= _DOC_READ_CACHE_MAX:
            _DOC_READ_CACHE.pop(next(iter(_DOC_READ_CACHE)))
        _DOC_READ_CACHE[cache_key] = (mtime, result)
        return result
    except doc_tools.DocError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — surfaced verbatim in the viewer
        return {"error": f"{type(exc).__name__}: {exc}"}


# --- checkpoints (Undo) -------------------------------------------------- #
# Content snapshots before each model write/edit (backend/checkpoints.py).
# Frontend fetches the list for the Undo button and restore returns files.


class CheckpointRestoreRequest(BaseModel):
    """Restore a checkpoint in the given workspace."""

    root: str


@app.get("/checkpoints/{chat_id}")
async def checkpoints_list(chat_id: str) -> dict:
    import checkpoints

    return {"checkpoints": checkpoints.list_checkpoints(chat_id)}


@app.post("/checkpoints/{chat_id}/{seq}/restore")
async def checkpoints_restore(chat_id: str, seq: int, req: CheckpointRestoreRequest) -> dict:
    import checkpoints
    import tools

    root = (req.root or "").strip()
    if not root:
        raise HTTPException(status_code=400, detail="missing workspace root")
    out = checkpoints.restore(chat_id, seq, root)
    if "error" in out:
        raise HTTPException(status_code=404, detail=out["error"])
    # Invalidate the read cache for restored files so the next read sees fresh
    # content instead of bytes cached before restore.
    for entry in out.get("restored", []):
        tools._invalidate_read_cache_for(entry.get("path", ""), root)
    checkpoints.prune(chat_id)
    return out


# --- traces (LangSmith-style per-chat log) -------------------------------- #
# Temporary per-chat log for the Trace panel (LLM / prompt / tool) - memory only, no persist.


@app.get("/chats/{chat_id}/traces")
async def chat_traces(chat_id: str, kind: str = "", task_id: str = "") -> dict:
    """Current chat logs with optional kind/task filter (llm / prompt / tool)."""
    import trace_store

    cid = (chat_id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="missing chat id")
    return {"traces": trace_store.list_traces(cid, kind, task_id)}


@app.delete("/chats/{chat_id}/traces")
async def chat_traces_clear(chat_id: str) -> dict:
    """Clear the current chat log."""
    import trace_store

    cid = (chat_id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="missing chat id")
    return {"ok": True, "removed": trace_store.clear(cid)}


# --- virtual browser (Playwright) ------------------------------------------ #
# Isolated headless Chromium for the Browser viewer tab. Screenshots and
# clicks go through this session only, so the user's real mouse/keyboard are
# never touched (backend/browser_session.py holds the actual page).

class BrowserLaunchRequest(BaseModel):
    url: str = "about:blank"
    chat_id: str = ""


class BrowserClickRequest(BaseModel):
    x: int
    y: int
    chat_id: str = ""


class BrowserTypeRequest(BaseModel):
    text: str
    chat_id: str = ""


class BrowserKeyRequest(BaseModel):
    key: str
    chat_id: str = ""


class BrowserNavigateRequest(BaseModel):
    url: str
    chat_id: str = ""


class BrowserScrollRequest(BaseModel):
    dx: int = 0
    dy: int = 0
    chat_id: str = ""


class BrowserViewportRequest(BaseModel):
    width: int
    height: int
    chat_id: str = ""


class BrowserMoveRequest(BaseModel):
    x: int
    y: int
    chat_id: str = ""


@app.post("/browser/viewport")
async def browser_viewport(req: BrowserViewportRequest) -> dict:
    """Resize the virtual browser viewport (responsive device presets)."""
    import browser_session

    return await browser_session.set_viewport(req.width, req.height, req.chat_id)


@app.post("/browser/move")
async def browser_move(req: BrowserMoveRequest) -> dict:
    """Move the virtual cursor (hover) inside the browser — no real mouse."""
    import browser_session

    return await browser_session.move(req.x, req.y, req.chat_id)


@app.get("/browser/status")
async def browser_status(chat_id: str = "") -> dict:
    """Whether a virtual browser session is currently alive."""
    import browser_session

    return browser_session.status(chat_id)


@app.get("/browser/devtools-url")
async def browser_devtools_url(chat_id: str = "") -> dict:
    """Verified DevTools frontend URL to open in the OS browser."""
    import browser_session

    return await browser_session.devtools_url(chat_id)


@app.post("/browser/launch")
async def browser_launch(req: BrowserLaunchRequest) -> dict:
    """Start the virtual browser (or navigate it when already running)."""
    import browser_session

    return await browser_session.launch(req.url.strip() or "about:blank", req.chat_id)


@app.get("/browser/screenshot")
async def browser_screenshot(chat_id: str = "") -> dict:
    """Latest JPEG frame of the virtual browser viewport (base64)."""
    import browser_session

    return await browser_session.screenshot(chat_id)


@app.post("/browser/click")
async def browser_click(req: BrowserClickRequest) -> dict:
    """Virtual click at viewport pixel coordinates — no real mouse involved."""
    import browser_session

    return await browser_session.click(req.x, req.y, req.chat_id)


@app.post("/browser/type")
async def browser_type(req: BrowserTypeRequest) -> dict:
    """Type text into the focused element inside the virtual browser."""
    import browser_session

    return await browser_session.type_text(req.text, req.chat_id)


@app.post("/browser/key")
async def browser_key(req: BrowserKeyRequest) -> dict:
    """Press a key (Enter, Tab, Escape, ...) inside the virtual browser."""
    import browser_session

    return await browser_session.press_key(req.key, req.chat_id)


@app.post("/browser/navigate")
async def browser_navigate(req: BrowserNavigateRequest) -> dict:
    """Navigate the virtual browser to a URL."""
    import browser_session

    return await browser_session.navigate(req.url.strip(), req.chat_id)


class BrowserSearchRequest(BaseModel):
    """Omnibox query for the virtual browser (Google → Bing → DuckDuckGo)."""

    query: str
    chat_id: str = ""


@app.post("/browser/search")
async def browser_search(req: BrowserSearchRequest) -> dict:
    """Search the web: Google first, falling back to Bing then DuckDuckGo."""
    import browser_session

    return await browser_session.search(req.query, req.chat_id)


@app.post("/browser/scroll")
async def browser_scroll(req: BrowserScrollRequest) -> dict:
    """Scroll the virtual browser viewport."""
    import browser_session

    return await browser_session.scroll(req.dx, req.dy, req.chat_id)


class BrowserHistoryRequest(BaseModel):
    """History control for the virtual browser (back / forward / reload)."""

    action: str
    chat_id: str = ""


@app.post("/browser/history")
async def browser_history(req: BrowserHistoryRequest) -> dict:
    """Run a history action (back, forward, reload) in the virtual browser."""
    import browser_session

    return await browser_session.history(req.action.strip().lower(), req.chat_id)


class BrowserCloseRequest(BaseModel):
    chat_id: str = ""


@app.post("/browser/close")
async def browser_close(req: BrowserCloseRequest | None = None) -> dict:
    """Shut down the virtual browser session."""
    import browser_session

    return await browser_session.close(req.chat_id if req else "")


class BrowserOpenChatsRequest(BaseModel):
    chat_ids: list[str] = []


@app.post("/browser/open-chats")
async def browser_open_chats(req: BrowserOpenChatsRequest | None = None) -> dict:
    """Mark which chats are open in the UI (exempt from idle eviction)."""
    import browser_session

    try:
        browser_session.set_open_chats(req.chat_ids if req else [])
    except Exception:  # noqa: BLE001, S110 — tracking never breaks the caller
        pass
    return {"ok": True}


# --- git ------------------------------------------------------------------- #
# ابزارهای git برای پنل فرانت‌اند (GitPanel) — همان توابع امنِ
# backend/git_tools.py که ابزارهای مدل هم استفاده می‌کنند.

class GitRootRequest(BaseModel):
    root: str


class GitCommitRequest(BaseModel):
    root: str
    message: str
    add_all: bool = False


class GitCheckoutRequest(BaseModel):
    root: str
    branch: str = ""
    create: bool = False


class GitAutoCommitRequest(BaseModel):
    root: str
    provider: str = "custom"
    model: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    provider_id: str = ""


@app.get("/git/status")
async def git_status(root: Annotated[str, Query(min_length=1)] = "") -> dict:
    import git_tools

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    return git_tools.git_status(root)


@app.get("/git/diff")
async def git_diff(
    root: Annotated[str, Query(min_length=1)] = "",
    path: str = "",
    staged: bool = False,
) -> dict:
    import git_tools

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    return git_tools.git_diff(root, path, staged)


@app.get("/git/log")
async def git_log(root: Annotated[str, Query(min_length=1)] = "", limit: int = 20) -> dict:
    import git_tools

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    return git_tools.git_log(root, limit)


@app.get("/git/show")
async def git_show(
    root: Annotated[str, Query(min_length=1)] = "",
    rev: str = "HEAD",
    path: str = "",
) -> dict:
    import git_tools

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    return git_tools.git_show(root, rev, path)


@app.post("/git/commit")
async def git_commit(req: GitCommitRequest) -> dict:
    import git_tools

    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")
    out = git_tools.git_commit(req.root, req.message, req.add_all)
    if "error" in out:
        raise HTTPException(status_code=400, detail=out["error"])
    return out


@app.post("/git/discard")
async def git_discard(req: GitRootRequest) -> dict:
    import git_tools

    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")
    out = git_tools.git_discard(req.root)
    if "error" in out:
        raise HTTPException(status_code=400, detail=out["error"])
    return out


@app.get("/git/branches")
async def git_branches(root: Annotated[str, Query(min_length=1)] = "") -> dict:
    import git_tools

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    return git_tools.git_branches(root)


@app.post("/git/checkout")
async def git_checkout(req: GitCheckoutRequest) -> dict:
    import git_tools

    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")
    out = git_tools.git_checkout(req.root, req.branch, req.create)
    if "error" in out:
        raise HTTPException(status_code=400, detail=out["error"])
    return out


@app.post("/git/autocommit")
async def git_autocommit(req: GitAutoCommitRequest) -> dict:
    """Generate a commit message with one LLM call and commit (no chat).

    The frontend routes this through the "compact" tool model (Settings →
    Tools → Compact model), so this endpoint assumes a small fast model: the
    input is kept tiny (file list + a ~4KB diff excerpt, not the full diff)
    and the output is capped at 64 tokens. Total worst case is ~30s.

    The commit never fails because of the model: a timeout, error, or empty
    reply falls back to a heuristic "Update N files: …" message built from
    git status, so the button always commits.
    """
    import git_tools
    from llm import build_chat_model, llm_complete

    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")
    if not req.model:
        raise HTTPException(status_code=400, detail="no model selected")
    status = git_tools.git_status(req.root)
    if "error" in status:
        raise HTTPException(status_code=400, detail=status["error"])
    entries = status.get("entries") or []
    if not entries:
        raise HTTPException(status_code=400, detail="nothing to commit")
    paths = [str(e.get("path") or "") for e in entries if e.get("path")]

    def _fallback_message() -> str:
        shown = ", ".join(paths[:3]) + ("…" if len(paths) > 3 else "")
        codes = {(str(e.get("st") or "").strip() or str(e.get("wt") or "").strip()) for e in entries}
        verb = "Add" if codes and codes <= {"?", "A"} else "Update"
        if len(paths) == 1:
            return f"{verb} {paths[0]}"
        return f"{verb} {len(paths)} files: {shown}"

    diff = git_tools.git_diff(req.root)
    if "error" in diff:
        raise HTTPException(status_code=400, detail=diff["error"])
    staged = git_tools.git_diff(req.root, staged=True)
    diff_text = (diff.get("diff") or "") + ("\n" + staged.get("diff") if staged.get("diff") else "")
    if not diff_text.strip():
        raise HTTPException(status_code=400, detail="nothing to commit")
    # Token diet: the model only needs the file list + a small excerpt to
    # name a one-line message — a full 20KB diff just burns input tokens and
    # slows the call on big repos.
    if len(diff_text) > 4000:
        diff_text = diff_text[:4000] + "\n…(truncated)"
    file_list = ", ".join(paths[:20]) + ("…" if len(paths) > 20 else "")
    try:
        mo = build_chat_model(
            req.provider,
            req.model,
            req.base_url,
            req.api_key,
            req.env_var,
            req.api_keys,
            temperature=0.0,
            max_tokens=64,
            thinking_level="off",
            timeout=30,
            provider_id=req.provider_id,
        )
    except Exception:  # noqa: BLE001 — any build failure falls back to heuristic commit
        message = _fallback_message()
        out = git_tools.git_commit(req.root, message, True)
        if "error" in out:
            raise HTTPException(status_code=400, detail=out["error"])
        return {**out, "message": message}
    try:
        text, usage = await asyncio.wait_for(
            llm_complete(
                mo,
                system="You write concise git commit messages. Reply with ONLY the commit message, one line, no quotes, no prefix.",
                user=f"Files: {file_list}\n\nWrite a short commit message for these changes:\n\n{diff_text}",
            ),
            timeout=30,
        )
    except (asyncio.TimeoutError, Exception):  # noqa: BLE001 — any model failure falls back to heuristic commit
        text, usage = "", None
    message = (text or "").strip().splitlines()[0].strip() if (text or "").strip() else ""
    if not message:
        # Never block the commit on the model ("model timed out generating
        # commit message" used to leave the button dead) — fall back to a
        # plain file-list message and commit anyway.
        message = _fallback_message()[:120]
    out = git_tools.git_commit(req.root, message, True)
    if "error" in out:
        raise HTTPException(status_code=400, detail=out["error"])
    # Surface the call's token usage so the frontend can accrue it into the
    # sidebar's Model usage panel (grouped under the compact model that ran).
    # None on the heuristic path — there was no model call to bill.
    resp: dict = {**out, "message": message}
    if usage:
        resp["usage"] = usage
    return resp


class OAuthStartRequest(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    # Optional override of the requested OAuth scopes. Empty = the default
    # Search Console scope (GOOGLE_SEARCH_CONSOLE_SCOPES) for the
    # search_console tool.
    scope: str = ""


@app.post("/oauth/google/start")
async def oauth_google_start(req: OAuthStartRequest) -> dict:
    """Begin a Google OAuth sign-in: build the consent URL for the client, keyed
    by a random `state`. The redirect_uri points back at THIS sidecar's loopback
    URL so the Electron main can catch the authorization code locally."""
    client_id = (req.client_id or "").strip()
    if not client_id:
        raise HTTPException(status_code=400, detail="missing Google OAuth client id")
    state = secrets.token_urlsafe(24)
    redirect_uri = _oauth_redirect_uri()
    scope = (req.scope or "").strip() or providers.GOOGLE_SEARCH_CONSOLE_SCOPES
    url = (
        f"{providers.GOOGLE_OAUTH_AUTH_URL}"
        f"?client_id={quote(client_id, safe='')}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&response_type=code"
        f"&scope={quote(scope, safe='')}"
        f"&access_type=offline"
        f"&prompt=consent"
        f"&state={state}"
    )
    OAUTH_STATES[state] = {
        "client_id": client_id,
        "client_secret": (req.client_secret or "").strip(),
        "expires": time.monotonic() + 15 * 60,
    }
    return {"url": url, "state": state}


@app.get("/oauth/google/callback")
async def oauth_google_callback(
    code: str = "", state: str = "", error: str = ""
) -> PlainTextResponse:
    """The OS browser lands here after Google consent (via the loopback
    redirect_uri). Exchange the code for refresh/access tokens, cache the result
    by ``state`` for /oauth/google/result to pick up, and tell the user to close
    the tab."""
    entry = OAUTH_STATES.pop(state or "", None)
    if error:
        OAUTH_RESULTS[state or ""] = {"error": f"Google sign-in cancelled ({error})"}
        return PlainTextResponse(
            "Sign-in cancelled. You can close this tab.", status_code=200
        )
    if not entry or entry.get("expires", 0) < time.monotonic():
        OAUTH_RESULTS[state or ""] = {"error": "oauth state expired; try signing in again"}
        return PlainTextResponse("Sign-in expired. You can close this tab.", status_code=200)
    if not code:
        OAUTH_RESULTS[state or ""] = {"error": "Google returned no authorization code"}
        return PlainTextResponse("No authorization code. You can close this tab.", status_code=200)
    try:
        data = await providers.google_exchange_code(
            entry["client_id"],
            entry["client_secret"],
            code,
            _oauth_redirect_uri(),
        )
    except providers.ProviderError as exc:
        OAUTH_RESULTS[state or ""] = {"error": str(exc)}
        return PlainTextResponse(
            f"Sign-in failed: {exc} You can close this tab.", status_code=200
        )
    refresh = data.get("refresh_token") or ""
    if not refresh:
        OAUTH_RESULTS[state or ""] = {
            "error": "Google returned no refresh token (was `access_type=offline` honored?)"
        }
        return PlainTextResponse("Sign-in failed. You can close this tab.", status_code=200)
    OAUTH_RESULTS[state or ""] = {
        "refresh_token": refresh,
        "access_token": data.get("access_token") or "",
        "expires_in": int(data.get("expires_in") or 3600),
    }
    return PlainTextResponse("Signed in! You can close this tab.", status_code=200)


@app.get("/oauth/google/result")
async def oauth_google_result(state: str = "") -> dict:
    """Polled by the Electron main: returns the completed OAuth exchange for
    ``state`` (or a pending marker) and clears it once consumed."""
    result = OAUTH_RESULTS.pop(state or "", None)
    if result is None:
        return {"status": "pending"}
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return {"status": "ok", **result}


@app.get("/models")
async def models(req: Annotated[ModelsRequest, Query()]) -> dict:
    try:
        ids = await providers.list_models(
            req.provider, req.base_url, req.api_key, req.env_var, req.api_keys
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"models": ids}


@app.get("/credits")
async def credits(req: Annotated[ModelsRequest, Query()]) -> dict:
    try:
        return await providers.fetch_credits(
            req.provider, req.base_url, req.api_key, req.env_var, req.api_keys
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# تست مدل (POST /models/test): کل پرامپت کوچک باید در MODEL_TEST_TIMEOUT ثانیه
# جواب بدهد؛ سقف کلاینت HTTP عمداً کوچک‌تر از آن است تا خطای خودِ پرووایدر
# زودتر (و با پیام خودش) به UI برسد و سقف بیرونی فقط ترمز دستی باشد.
MODEL_TEST_TIMEOUT = 15  # ثانیه — بودجه کل تست
MODEL_TEST_CLIENT_TIMEOUT = 12  # ثانیه — سقف کلاینت (کوچک‌تر از بودجه کل)


@app.post("/models/test")
async def models_test(req: ModelTestRequest) -> dict:
    """Send a tiny one-shot completion to check a model actually works.

    Uses the same build_chat_model + llm_complete path as a real chat turn
    (the pattern proven in backend/live_test_providers.py) so the probe
    exercises the exact provider+model the picker shows.
    """
    if not req.model:
        raise HTTPException(status_code=400, detail="no model selected")
    try:
        mo = build_chat_model(
            req.provider,
            req.model,
            req.base_url,
            req.api_key,
            req.env_var,
            req.api_keys,
            timeout=MODEL_TEST_CLIENT_TIMEOUT,
        )
        text, _usage = await asyncio.wait_for(
            llm_complete(mo, user="Reply with the single word: OK"),
            timeout=MODEL_TEST_TIMEOUT,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"timeout — model did not answer in {MODEL_TEST_TIMEOUT}s",
        ) from exc
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # the real provider error must reach the UI
        raise HTTPException(
            status_code=400, detail=f"{type(exc).__name__}: {exc}"
        ) from exc
    return {"ok": True, "reply": (text or "").strip()[:200]}


# --- managed on-device models (whisper / embedding) --------------------- #
# Download & removal are user-initiated from Settings → Models (never
# automatic). Downloads run on a background thread; /models/status is polled
# while one is in flight.


@app.post("/models/download")
async def models_download(req: ModelDownloadRequest) -> dict:
    import model_download

    kind = (req.kind or "").strip() or model_download.KIND_EMBEDDING
    if kind not in (model_download.KIND_WHISPER, model_download.KIND_EMBEDDING):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    if kind == model_download.KIND_WHISPER:
        default_repo = model_download.WHISPER_DEFAULT_REPO
    else:
        default_repo = model_download.EMBEDDING_DEFAULT_REPO
    model = (req.model or "").strip() or default_repo
    if not model_download.start_download(kind, model, req.base_url):
        raise HTTPException(status_code=400, detail="empty model repo id")
    return {"ok": True, "kind": kind, "model": model}


@app.get("/models/status")
async def models_status() -> dict:
    import model_download

    return model_download.status()


@app.get("/models/embedding-status")
async def models_embedding_status() -> dict:
    """RAG embedder diagnostics: model loaded? what dimension? why not?."""
    from embeddings import status as embed_status

    return embed_status()


@app.post("/models/remove")
async def models_remove(req: ModelRemoveRequest) -> dict:
    import model_download

    kind = (req.kind or "").strip().lower()
    if kind not in (model_download.KIND_WHISPER, model_download.KIND_EMBEDDING):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    removed = model_download.remove(kind, req.model)
    return {"ok": True, "kind": kind, "removed": removed}


def _require_model_kind(kind: str) -> str:
    import model_download

    kind = (kind or "").strip().lower()
    if kind not in (
        model_download.KIND_WHISPER,
        model_download.KIND_EMBEDDING,
    ):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    return kind


@app.post("/models/pause")
async def models_pause(req: ModelControlRequest) -> dict:
    """مکث دانلود در حال اجرا (بایت‌های گرفته‌شده حفظ می‌شوند)."""
    import model_download

    kind = _require_model_kind(req.kind)
    if not model_download.pause_download(kind):
        raise HTTPException(status_code=404, detail="no running download to pause")
    return {"ok": True, "kind": kind}


@app.post("/models/resume")
async def models_resume(req: ModelControlRequest) -> dict:
    """ادامه دانلود مکث‌شده از همان نیمه."""
    import model_download

    kind = _require_model_kind(req.kind)
    if not model_download.resume_download(kind):
        raise HTTPException(status_code=404, detail="no paused download to resume")
    return {"ok": True, "kind": kind}


@app.post("/models/cancel")
async def models_cancel(req: ModelControlRequest) -> dict:
    """Stop an in-flight download; partial files stay for later resume."""
    import model_download

    kind = _require_model_kind(req.kind)
    # Idempotent: stopping when nothing runs is still success so the
    # Stop button never looks dead (no 404 when state already cleared).
    model_download.cancel_download(kind)
    return {"ok": True, "kind": kind}


@app.get("/system-prompts")
async def system_prompts() -> dict:
    from agents import MODE_ALIASES, SYSTEM_PROMPTS

    # The frontend looks up canonical mode keys ("ask", "coder", "plan") for the
    # context popover, while legacy clients may still ask for "chat"/
    # "codewriter". Return canonical keys first, then append the aliases so both
    # spellings resolve to the same prompt without raising KeyError.
    out = dict(SYSTEM_PROMPTS)
    out.update({key: SYSTEM_PROMPTS[canonical] for key, canonical in MODE_ALIASES.items()})
    return out


# --- skills (file-based store in the user data folder) ---------------------- #


class SkillSyncRequest(BaseModel):
    name: str = ""
    previous_name: str = ""
    content: str = ""
    description: str = ""
    fa_keywords: list[str] = []
    delete: bool = False


@app.get("/skills")
async def skills_list() -> dict:
    import state_db

    try:
        skills = state_db.list_skills()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not read skills: {exc}") from exc
    return {"skills": skills}


@app.post("/skills/sync")
async def skills_sync(req: SkillSyncRequest) -> dict:
    from tools import persist_skill, remove_skill

    name = (req.name or "").strip()
    if req.delete:
        if not name:
            raise HTTPException(status_code=400, detail="missing skill name")
        return remove_skill(name)
    content = (req.content or "").strip()
    if not content:
        # Rebuild a full skill from structured fields when no raw markdown came.
        name = name or (req.description or "").strip()[:60] or "skill"
        _fa_line = ""
        _fa_clean = [str(k or "").strip() for k in (req.fa_keywords or []) if str(k or "").strip()]
        if _fa_clean:
            _fa_line = f"fa_keywords: {', '.join(_fa_clean)}\n"
        content = (
            "---\n"
            f"name: {name}\n"
            f"description: {(req.description or '').strip()}\n"
            f"{_fa_line}"
            "---\n\n"
            f"# {name}\n"
        )
    result = persist_skill(content, fallback_name=name, previous_name=req.previous_name, fa_keywords=req.fa_keywords or None)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("note", "save failed"))
    return result


# --- MCP connectors (file-based store in the user data folder) ------------- #


class McpSaveRequest(BaseModel):
    name: str = ""
    cfg: dict = {}


class McpDeleteRequest(BaseModel):
    name: str = ""


@app.get("/mcp")
async def mcp_list() -> dict:
    import state_db
    from tools import _BUILTIN_MCP_SERVERS

    try:
        return {
            "mcpServers": state_db.list_mcp(),
            "builtins": sorted(_BUILTIN_MCP_SERVERS),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not read MCP config: {exc}") from exc


@app.post("/mcp")
async def mcp_save(req: McpSaveRequest) -> dict:
    from tools import upsert_mcp_server

    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="missing connector name")
    if not isinstance(req.cfg, dict):
        raise HTTPException(status_code=400, detail="invalid connector config")
    return upsert_mcp_server("", name, req.cfg)


@app.post("/mcp/delete")
async def mcp_delete(req: McpDeleteRequest) -> dict:
    import state_db

    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="missing connector name")
    removed = state_db.delete_mcp(name)
    return {"ok": True, "removed": removed}


# Lazy-loaded faster-whisper model (the CTranslate2 model downloaded into
# backend/whisper/, see Settings → Models). Loaded once on first transcription
# and cached, so the first request pays the load cost but every later one is
# fast and fully local+offline. The cached model is EVICTED after an idle
# window (it holds 1.5-3 GB of RAM in a long-lived sidecar); the next
# transcription simply reloads it lazily.
_whisper_model = None
_whisper_model_lock = asyncio.Lock()
_WHISPER_IDLE_EVICT_S = 10 * 60
_whisper_last_used = 0.0
_whisper_evict_timer: asyncio.TimerHandle | None = None


def _schedule_whisper_evict() -> None:
    """Record activity and (re)arm the idle-eviction timer on the event loop."""
    global _whisper_last_used, _whisper_evict_timer
    _whisper_last_used = time.monotonic()
    if _whisper_evict_timer is not None:
        _whisper_evict_timer.cancel()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # no running loop (e.g. tests) — eviction stays off
        _whisper_evict_timer = None
        return
    _whisper_evict_timer = loop.call_later(_WHISPER_IDLE_EVICT_S, _evict_whisper_if_idle)


def _evict_whisper_if_idle() -> None:
    """Drop the cached Whisper model when it has been idle for the whole window.

    A model used within the window is left alone — the use already re-armed
    the timer, so touching the clock here would wrongly restart the idle
    window. Evicting mid-transcription is safe: the in-flight handler holds
    its own local reference, only the module cache is cleared.
    """
    global _whisper_model
    if _whisper_model is None:
        return
    if time.monotonic() - _whisper_last_used < _WHISPER_IDLE_EVICT_S:
        return
    _whisper_model = None
    import gc

    gc.collect()


async def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        async with _whisper_model_lock:
            if _whisper_model is None:
                import model_download

                if not model_download.whisper_ready():
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "Whisper model is not downloaded. Open Settings → Models and "
                            f"download it ({model_download.WHISPER_DEFAULT_REPO})."
                        ),
                    )
                from faster_whisper import WhisperModel

                model_dir = model_download.whisper_dir()
                _whisper_model = WhisperModel(
                    model_dir, device="auto", compute_type="auto"
                )
    _schedule_whisper_evict()
    return _whisper_model


@app.post("/transcribe")
async def transcribe(request: Request) -> dict:
    """Transcribe a recorded audio clip (multipart 'audio').

    Local (no `provider` form field): on-device Whisper, fully offline.
    Remote (`provider` + `base_url` fields): forwarded to
    `POST {base_url}/audio/transcriptions` (OpenAI-compatible, e.g. a custom
    9router gateway at `http://localhost:20128/v1`).
    Returns {"text": "..."} or an HTTP error.

    Tuned for clean, hallucination-free dictation on short clips:
    * Silero VAD trims silence and skips pure-silence clips (no ghost text).
    * An explicit `lang` hint (fa/en) beats auto-detection on short clips.
    * Temperature fallback + conservative thresholds fix repeated-text stutters.
    """
    import io

    try:
        # Parsing the multipart form (and every downstream step) lives inside the
        # try so that failures — e.g. a missing `python-multipart` dependency, or
        # a malformed upload — surface as a 500 with a `detail` message instead of
        # an unhandled AssertionError that FastAPI turns into a bare 500.
        form = await request.form()
        audio = form.get("audio")
        if audio is None:
            raise HTTPException(status_code=400, detail="missing 'audio' field")
        data = await audio.read()
        if not data:
            raise HTTPException(status_code=400, detail="empty audio")
        lang = str(form.get("lang") or "").strip().lower() or None
        provider_kind = str(form.get("provider") or "").strip()
        base_url = str(form.get("base_url") or "").strip()
        api_key = str(form.get("api_key") or "").strip()
        env_var = str(form.get("env_var") or "").strip()
        stt_model = str(form.get("model") or "").strip() or "whisper-1"

        if provider_kind and provider_kind != "local":
            return await _transcribe_remote(
                data, provider_kind, base_url, api_key, env_var, stt_model, lang,
            )

        from faster_whisper.audio import decode_audio

        model = await _get_whisper_model()
        # faster-whisper's decode_audio uses `av` to decode webm/ogg/opus/wav/mp3
        # to a float32 16 kHz PCM array, so any container the browser MediaRecorder
        # emits is handled without extra conversion code here.
        pcm = decode_audio(io.BytesIO(data))
        vad_parameters = {
            "min_silence_duration_ms": 250,
            "speech_pad_ms": 200,
        }
        # For Persian, steer the model toward correct punctuation and away
        # from filler words. The previous prompt ("no punctuation") hurt
        # readability and accuracy for Persian, so it is replaced here.
        fa_prompt = (
            "رونویسی فارسی با نشانه‌گذاری صحیح. متن را بدون کلمات اضافه و "
            "پرکننده بنویسید:"
        )
        segments, _info = model.transcribe(
            pcm,
            beam_size=10,
            language=lang,
            vad_filter=True,
            vad_parameters=vad_parameters,
            initial_prompt=fa_prompt if lang == "fa" else None,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8),
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-0.8,
            without_timestamps=True,
        )
        text = " ".join(seg.text for seg in segments).strip()
        return {"text": text}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc


async def _transcribe_remote(
    data: bytes,
    provider_kind: str,
    base_url: str,
    api_key: str,
    env_var: str,
    model: str,
    lang: str | None,
) -> dict:
    """Forward an audio clip to an OpenAI-compatible /audio/transcriptions endpoint."""
    import httpx

    if not base_url:
        raise HTTPException(status_code=400, detail="remote STT needs 'base_url'")
    url = f"{base_url.rstrip('/')}/audio/transcriptions"
    key = api_key or providers.env_key(provider_kind, env_var)
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    files = {"file": ("clip.wav", data, "application/octet-stream")}
    payload: dict[str, str] = {"model": model or "whisper-1"}
    if lang:
        payload["language"] = lang
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, files=files, data=payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"remote transcription failed: {exc}") from exc
    if resp.status_code >= 400:
        detail = resp.text.strip()[:500] or f"remote transcription failed ({resp.status_code})"
        raise HTTPException(status_code=502, detail=detail)
    try:
        body = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"remote transcription bad response: {exc}") from exc
    return {"text": str(body.get("text", "")).strip()}


@app.post("/tts")
async def text_to_speech(req: TtsRequest) -> Response:
    """Synthesize text to speech via an OpenAI-compatible /audio/speech endpoint.

    Local TTS is not supported yet — `provider: local` (or empty) is rejected
    with a clear 400. Remote providers are forwarded to
    `POST {base_url}/audio/speech` with {"model", "input", "voice"} and the
    audio bytes are streamed back (StreamingResponse) as they arrive from the
    upstream, so the first bytes reach the player without waiting for the full
    clip. Falls back to a buffered Response only when streaming is unavailable.
    """
    import httpx

    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="missing 'text' field")
    provider_kind = (req.provider or "").strip()
    if not provider_kind or provider_kind == "local":
        raise HTTPException(status_code=400, detail="TTS لوکال پشتیبانی نمی‌شود — یک پروایدر ریموت انتخاب کنید")
    base_url = (req.base_url or "").strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="remote TTS needs 'base_url'")
    url = f"{base_url.rstrip('/')}/audio/speech"
    key = (req.api_key or "").strip() or providers.env_key(provider_kind, (req.env_var or "").strip())
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    # Some OpenAI-compatible gateways (e.g. multi-vendor routers like 9router)
    # block unknown HTTP clients by User-Agent (HTTP 401 "unauthorized client")
    # while allowing well-known agent CLIs — same UA the chat path sends for
    # custom gateways (see llm._request_headers). Harmless for servers that
    # don't filter (llama.cpp/Ollama/LM Studio just ignore the header).
    headers["User-Agent"] = providers.UA_LADDER[0]
    payload: dict = {"input": text}
    # مدل/ویس خالی ارسال نمی‌شود: بعضی پروایدرهای 9router مدل یا ویس ندارند
    # و با دریافت فیلد اضافه خطا می‌دهند. وقتی مقدار هست، مثل قبل فرستاده می‌شود.
    tts_model = (req.model or "").strip()
    if tts_model:
        payload["model"] = tts_model
    tts_voice = (req.voice or "").strip()
    if tts_voice:
        payload["voice"] = tts_voice
    # Open the upstream in streaming mode so bytes are forwarded immediately.
    # The client/response pair is closed in the generator's finally block after
    # the stream ends (or the downloader disconnects and FastAPI cancels us).
    try:
        client = httpx.AsyncClient(timeout=120.0)
        upstream_req = client.build_request("POST", url, headers=headers, json=payload)
        upstream = await client.send(upstream_req, stream=True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"remote speech synthesis failed: {exc}") from exc
    if upstream.status_code >= 400:
        try:
            err_body = (await upstream.aread()).decode("utf-8", errors="replace").strip()[:500]
        except Exception:  # noqa: BLE001 — error body is best-effort
            err_body = ""
        try:
            await upstream.aclose()
        except Exception:  # noqa: BLE001, S110 — cleanup must not raise
            pass
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001, S110 — cleanup must not raise
            pass
        detail = err_body or f"remote speech synthesis failed ({upstream.status_code})"
        raise HTTPException(status_code=502, detail=detail)
    media_type = (upstream.headers.get("content-type") or "audio/mpeg").split(";")[0].strip() or "audio/mpeg"

    async def _audio_stream():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=32 * 1024):
                if chunk:
                    yield chunk
        finally:
            try:
                await upstream.aclose()
            except Exception:  # noqa: BLE001, S110 — cleanup must not raise
                pass
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001, S110 — cleanup must not raise
                pass

    return StreamingResponse(_audio_stream(), media_type=media_type)


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _friendly_error(exc: Exception, model: str, base_url: str = "") -> str:
    text = str(exc)
    # httpx.ReadTimeout / httpcore.ReadTimeout: the provider sent no data for
    # the whole read window (300s). The run already retried + resumed, so the
    # actionable advice is "tap Retry", not the generic "just wait" hint below.
    if _is_read_timeout(exc):
        return (
            "The provider didn't send any data for over 5 minutes (read timeout). "
            "Tap Retry to resume from where it left off — or switch to a faster "
            "model in Settings if this keeps happening."
        )
    # A bare `asyncio.TimeoutError` (and similar) has an EMPTY str() — the type
    # name is the only clue. Turn it into a readable timeout message so the user
    # isn't left with the generic fallback at the bottom.
    if not text.strip():
        text = "The model request timed out (no data arrived from the provider for an extended period)."
    # LangChain HTTP errors render as: status_code: 400, model_name: ...,
    # body: {'message': '...'} (or body: [{'error': {'message': '...'}}] from
    # Gemini's OpenAI-compat endpoint). Pull out the server's own message.
    detail = ""
    m = re.search(r"body:\s*(\{.*\})", text, re.DOTALL)
    if m:
        try:
            body = ast.literal_eval(m.group(1))
            if not isinstance(body, dict):
                detail = ""
            else:
                detail = body.get("message") or body.get("error") or ""
                if isinstance(detail, dict):
                    detail = str(detail)
                # OpenRouter / ai-gateway-style wrappers bury the REAL upstream
                # error inside `metadata.raw` as an escaped JSON string. When the
                # outer message is the generic "Provider returned error" (their
                # default wrapper), dig one level deeper to surface the actual
                # failure — otherwise the user sees a useless "Provider returned
                # error" with no clue what went wrong.
                meta = body.get("metadata") if isinstance(body, dict) else None
                raw = meta.get("raw") if isinstance(meta, dict) else None
                if (
                    isinstance(raw, str)
                    and (detail or "").strip().lower() in ("provider returned error", "")
                ):
                    try:
                        inner = ast.literal_eval(raw)
                        inner_msg = (
                            inner.get("message")
                            if isinstance(inner, dict)
                            else None
                        )
                        if isinstance(inner_msg, str) and inner_msg.strip():
                            detail = inner_msg
                    except (ValueError, SyntaxError, TypeError, AttributeError):
                        pass
        except (ValueError, SyntaxError, TypeError, AttributeError):
            detail = ""
    if not detail:
        # Array form: body: [{'error': {'code': ..., 'message': ..., 'status': ...}}]
        m = re.search(r"body:\s*(\[.*\])", text, re.DOTALL)
        if m:
            try:
                arr = ast.literal_eval(m.group(1))
                if isinstance(arr, list) and arr:
                    err = arr[0].get("error") or {} if isinstance(arr[0], dict) else {}
                    if isinstance(err, dict):
                        detail = err.get("message") or str(err)
                    else:
                        detail = str(err)
            except (ValueError, SyntaxError, TypeError):
                detail = ""
    if detail:
        text = detail
    low = text.lower()
    # Credential errors raised by providers.build_model are already actionable
    # (they tell the user exactly what to fix in Settings) — never wrap them in
    # a generic hint on top.
    if "settings → providers" in low:
        return text
    if (
        "all connection attempts failed" in low
        or "connection refused" in low
        or "connecterror" in low
        or "getaddrinfo" in low
        or "no connection could be made" in low
        or "name or service not known" in low
        or "unable to connect" in low
        or "connect call failed" in low
    ):
        endpoint = (base_url or "").strip()
        hint = f" at {endpoint}" if endpoint else ""
        text += (
            f"\n\nCouldn't connect to the provider endpoint{hint}. For a local server "
            "(llama.cpp/Ollama) make sure it's actually running and the base URL/port in "
            "Settings are correct. For a cloud provider, check the base URL and your "
            "internet connection."
        )
    elif (
        "401" in low
        or "invalid api key" in low
        or "unauthorized" in low
        or "auth error" in low
        or "authentication" in low
    ):
        text += (
            "\n\nThe API key for this provider is invalid, expired, or missing. Open "
            "Settings → Providers and check the API keys list."
        )
    elif (
        "incomplete chunked read" in low
        or "peer closed connection" in low
        or "connection was closed" in low
        or "remote protocol error" in low
        or "connection dropped" in low
    ):
        text += (
            "\n\nThe connection to the model was dropped mid-stream (the upstream closed the "
            "request while streaming a reply). This is usually transient — retry the same "
            "message, or switch to another model in Settings if it keeps happening."
        )
    elif "timed out" in low or "timeout" in low:
        text += (
            "\n\nThe connection stalled mid-stream (the provider was slow to send the "
            "next chunk). The run auto-resumes from the tool work already done, so "
            "just wait; if it keeps happening, switch to a faster model in Settings "
            "or compact the conversation."
        )
    elif "output retries" in low or "return text or call a tool" in low or "unexpectedmodelbehavior" in low:
        text += (
            "\n\nThe model returned no usable reply (empty or invalid response). This model/provider"
            " is unreliable for this turn — switch model in Settings and retry."
        )
    elif "no generation chunks" in low:
        text = (
            "The provider returned an empty response (no content was generated). "
            "This usually means the model's quota/budget pool is exhausted or the "
            "route is unavailable — switch to another model in Settings and retry."
        )
    elif "unknown variant" in low and "image_url" in low:
        text += (
            "\n\nThe selected model does not support image/batch attachments (it rejects image"
            " content, only accepting text). Screenshots and attached images were ignored for"
            " this turn — switch to a vision-capable model in Settings to send them."
        )
    elif "429" in low or "rate limit" in low or "freeusagelimit" in low or "quota" in low or "request limit reached" in low or "resource exhausted" in low or "worker local" in low or "upstream error" in low:
        text += (
            "\n\nThis is a provider rate/request limit (the upstream is throttling or at "
            "capacity right now — e.g. 'ResourceExhausted: Worker local total request "
            "limit reached'). Wait ~30s and retry, or switch to another model in Settings."
        )
    elif "capacity" in low or "ttft" in low or "all providers" in low or "overloaded" in low:
        text += (
            "\n\nAll upstream providers for this model are temporarily at capacity (free tiers are "
            "routed to a small pool that fills fast). Wait a moment and retry, or switch to a "
            "another model in Settings."
        )
    elif ("context" in low or "context_length" in low or "token" in low) and any(
        w in low
        for w in (
            "maximum context length",
            "max context",
            "context length",
            "context window",
            "context_length_exceeded",
            "too large",
            "exceeded the context",
            "token limit",
            "reduce the length",
            "reducing available tokens",
            "prompt is too long",
        )
    ):
        text += (
            "\n\nThe conversation is too long for this model's context window. "
            "Use /compact to summarize it (or start a new chat with /new), then retry."
        )
    elif "tool-loop step budget" in low or "compacting earlier turns" in low:
        text += (
            "\n\nThis task needed more tool calls (file searches, edits, etc.) than the safety "
            "budget allows, even after the budget was raised and the conversation was compacted "
            "automatically. Try breaking the request into smaller steps, or continue by asking to "
            "pick up where it left off."
        )
    elif "403" in low or "access denied" in low or "security policy" in low:
        text += (
            "\n\nThis looks like an OpenRouter gateway block (some regions/keys can't reach it). "
            "Try a different provider (Settings → Providers), or a custom OpenAI-compatible "
            "gateway with your own base URL and key."
        )
    elif "thought_signature" in low:
        text = (
            "Gemini 3.x models require a thought signature to be echoed back on every "
            "tool call. The app's native Google connector handles this automatically — "
            "restart the app and retry the same message. If it still fails, switch to a "
            "Gemini 2.x model or another provider."
        )
    elif (
        "no google credential configured" in low
        or "set the google_api_key" in low
        or "pass it via googleprovider" in low
        or "googleprovider(api_key" in low
    ):
        text += (
            "\n\nThe Google provider has no usable credential. Open Settings → Providers → "
            "Google and add an API key."
        )
    elif any(
        word in low
        for word in (
            "not a valid model",
            "model not found",
            "unknown model",
            "404",
            "400",
        )
    ):
        text += (
            f"\n\nThe model '{model}' was rejected by the server. Open Settings and "
            "pick a valid model for the selected provider, or check your API key/base URL."
        )
    else:
        text += (
            "\n\nUnexpected provider error. Wait a moment and retry; if it persists, "
            "verify your API key and provider settings in Settings."
        )
    return text[:2000]


@app.post("/chat/compact")
async def chat_compact(req: CompactRequest, request: Request):
    """Manual ``/compact`` — opencode-style compaction of the supplied history.

    Returns ``{"summary": <text>, "keep": <n>}`` on success, or
    ``{"summary": null, "error": <reason>}`` when there is nothing to compact or
    the summarizer failed (the frontend then surfaces the reason as a retry).
    """
    import sys

    # Route through the standard logging module so informational messages land
    # on stdout (not red stderr) while genuine problems still surface at
    # WARNING/ERROR on stderr. A dedicated, non-propagating logger keeps this
    # isolated from the root file handler configured at startup.
    #
    # Handlers resolve their stream dynamically (at emit time) so they always
    # target the *current* sys.stdout/sys.stderr — important under test
    # frameworks that swap those streams (e.g. pytest's capsys).
    class _DynamicStreamHandler(logging.StreamHandler):
        def __init__(self, stream_getter):
            super().__init__(stream=sys.stderr)  # placeholder; resolved per emit
            self._stream_getter = stream_getter

        def emit(self, record):
            # Resolve the *current* stream at emit time so pytest's capsys (and
            # any other stdout/stderr swap) is honoured.
            self.stream = self._stream_getter()
            super().emit(record)

    _logger = logging.getLogger("codifa.compact")
    if not _logger.handlers:
        _logger.propagate = False
        _logger.setLevel(logging.DEBUG)

        _info_handler = _DynamicStreamHandler(lambda: sys.stdout)
        _info_handler.setLevel(logging.DEBUG)
        _info_handler.addFilter(lambda r: r.levelno < logging.WARNING)
        _info_handler.setFormatter(logging.Formatter("[compact] %(message)s"))

        _err_handler = _DynamicStreamHandler(lambda: sys.stderr)
        _err_handler.setLevel(logging.WARNING)
        _err_handler.setFormatter(logging.Formatter("[compact] %(levelname)s %(message)s"))

        _logger.addHandler(_info_handler)
        _logger.addHandler(_err_handler)

    def _log(msg: str, level: int = logging.INFO) -> None:
        _logger.log(level, msg)

    _log(
        f"request: provider={req.provider!r} model={req.model!r} "
        f"fallback={req.fallback_provider!r}/{req.fallback_model!r} "
        f"history={len(req.history or [])} ctx={req.context_window} pct={req.compact_at_percent}"
    )
    if not req.history:
        _log("empty history -> nothing to do", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "no messages to compact"}

    def _build(
        provider: str,
        model: str,
        base_url: str,
        api_key: str,
        env_var: str,
        provider_id: str = "",
        api_keys: list[str] | None = None,
    ):
        if not model:
            return None
        try:
            return build_chat_model(
                provider,
                model,
                base_url,
                api_key,
                env_var,
                api_keys,
                temperature=0.0,
                thinking_level="off",
                max_tokens=8192,
                # Bounded so a slow/unreachable provider fails fast with a clear
                # error instead of hanging until the client disconnects.
                timeout=50,
                cache=True,
                provider_id=provider_id,
            )
        except Exception as exc:  # noqa: BLE001
            _log(f"model build failed (provider={provider!r} model={model!r}): {exc!r}", level=logging.WARNING)
            return None

    model = _build(req.provider, req.model, req.base_url, req.api_key, req.env_var, req.provider_id, req.api_keys)
    if model is None:
        _log(f"primary model failed to build (provider={req.provider!r} model={req.model!r})", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "invalid primary model"}
    fallback = _build(
        req.fallback_provider, req.fallback_model, req.fallback_base_url,
        req.fallback_api_key, req.fallback_env_var,
        req.fallback_provider_id, req.fallback_api_keys,
    )
    _log(f"primary built={bool(model)} fallback built={bool(fallback)}; running _compact_history")
    ctx = int(req.context_window or 0)
    last_error: list[str] = []
    # opencode prune: clear old tool outputs before the summarization pass.
    history = list(req.history)
    _prune_history(history)
    compact_task = asyncio.ensure_future(
        _compact_history(
            model,
            history,
            ctx=ctx,
            reserved=None,
            fallback_model=fallback,
            last_error=last_error,
            force=True,
        )
    )
    try:
        # Cancel the (potentially long, token-burning) summarization if the client
        # disconnects — e.g. the client timeout fired, or the user navigated away.
        # Without this the backend keeps running after the client is gone and logs
        # "[compact] success" for a result nobody receives.
        while not compact_task.done():
            if await request.is_disconnected():
                compact_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await compact_task
                _log("client disconnected — compact aborted", level=logging.WARNING)
                return {"summary": None, "keep": 0, "error": "client disconnected"}
            await asyncio.sleep(1.0)
        result = compact_task.result()
    except asyncio.CancelledError:
        compact_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await compact_task
        raise
    except Exception as exc:  # noqa: BLE001
        _log(f"_compact_history raised: {exc!r}", level=logging.ERROR)
        return {"summary": None, "keep": 0, "error": str(exc)}
    if result is None:
        if last_error:
            _log(f"failed: {last_error[-1]}", level=logging.WARNING)
            return {"summary": None, "keep": 0, "error": last_error[-1]}
        _log("nothing to compact (history too short / head already summarized)", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "nothing to compact"}
    new_history, keep, compact_usage = result
    summary = new_history[0]["content"] if new_history else ""
    if not summary:
        _log("empty summary after success", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "empty summary"}
    _log(f"success: keep={keep} summary_len={len(summary)}")
    return {"summary": summary, "keep": int(keep), "usage": compact_usage}


async def _with_keepalive(agent_iter, timeout: float = 15.0):
    """Yield agent SSE events, injecting a keepalive sentinel whenever the agent
    goes silent for `timeout` seconds so idle sockets survive proxy/OS/TCP
    timeouts mid-stream. The frontend forwards `: `-prefixed lines as a
    `keepalive` event and refreshes its stall watchdog, so a long-running tool is
    never mistaken for a dead connection.

    IMPORTANT: `shield` only protects `pending` from the keepalive timeout —
    it does NOT mean a real outer cancellation (client disconnect / aborted
    fetch) should leave the agent running. If this generator itself gets
    cancelled (or closed) while `pending` is in flight, we must explicitly
    cancel `pending` too, otherwise the underlying run_graph/_drive task keeps
    running orphaned in the background with nobody consuming its events. Left
    alone, it eventually reaches a "clean finish" and clears the interrupted-turn
    resume checkpoint (LangGraph checkpointer) even though the user never saw the
    result — the bug behind "interrupts with no log/error and the resume state is
    gone"."""
    pending = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(agent_iter.__anext__())
            try:
                # shield keeps the in-flight __anext__() alive across the
                # keepalive TIMEOUT specifically — we just keep waiting and
                # emit sentinels. A genuine outer cancellation is handled by
                # the try/except CancelledError wrapping the whole loop below.
                event = await asyncio.wait_for(asyncio.shield(pending), timeout=timeout)
                pending = None
                yield event
            except asyncio.TimeoutError:
                yield {"kind": "_keepalive"}
            except StopAsyncIteration:
                return
    finally:
        # Runs on EVERY exit path — CancelledError (Starlette aborts with this
        # in some paths), GeneratorExit (Starlette aborts with this in others),
        # or plain exhaustion. Without this, a GeneratorExit raised while
        # `await asyncio.shield(pending)` is suspended leaves `pending` (the
        # in-flight agent_iter.__anext__(), i.e. run_graph's queue.get()) alive:
        # shield deliberately does NOT propagate the cancellation into it, and
        # the old except-CancelledError-only handler never fired. The orphaned
        # task then keeps pulling tokens from the LLM provider, and the later
        # agent_gen.aclose() in _stream_drive fails with "async generator is
        # already running" (silently suppressed) — so run_graph's finally never
        # runs, _drive is never cancelled, and the provider stream keeps
        # token-burning after Stop. Cancel + reap it here so aclose() can
        # actually unwind the chain.
        if pending is not None and not pending.done():
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pending


async def _abort_close(ka_gen, agent_gen) -> None:
    """Tear down a stream on abort: close the keepalive wrapper FIRST, then the
    agent generator.

    Order matters. Closing ``ka_gen`` runs ``_with_keepalive``'s ``finally``,
    which cancels any in-flight ``agent_iter.__anext__()`` task. Only then is
    ``agent_gen`` no longer being driven, so ``agent_gen.aclose()`` can actually
    throw GeneratorExit into ``run_agent`` → ``run_graph``'s ``finally`` →
    ``_drive`` cancelled → the provider HTTP stream is aborted. Closing the
    agent first (while the __anext__ task is still driving it) fails with
    "async generator is already running" and — silently suppressed — leaves the
    provider stream token-burning after Stop.
    """
    with contextlib.suppress(Exception):
        await ka_gen.aclose()
    with contextlib.suppress(Exception):
        await agent_gen.aclose()


async def _stream_drive(agent_gen, chat_id: str, model: str, base_url: str):
    """Yield SSE bytes for every event from ``agent_gen`` with abort safety.

    Extracted from ``event_gen`` so the disconnect / GeneratorExit handling
    can be unit-tested without spinning up FastAPI. MUST stay in sync with
    the abort contract:

    * ``CancelledError`` (Starlette aborts with this in some paths) →
      close ``agent_gen`` and return silently.
    * ``GeneratorExit`` (Starlette aborts with this in other paths) →
      close ``agent_gen`` and re-raise. Without the close, the background
      ``_drive`` task keeps the LLM provider stream alive and every
      Stop + resend stacks another stream on top of the same chat.
    * Other ``Exception`` → close ``agent_gen`` and surface an error
      event so the frontend can render a banner.
    * Other ``BaseException`` (non-GeneratorExit) → log and surface a
      generic crash event.
    """
    ka_count = 0
    ka_gen = _with_keepalive(agent_gen)
    try:
        async for event in ka_gen:
            if event.get("kind") == "_keepalive":
                ka_count += 1
                yield ": keepalive\n\n"
            else:
                yield _sse(event)
        # Run finished cleanly: surface the post-run RSS so a growing memory
        # trend between runs is visible in codifa.log, and reclaim any cyclic
        # garbage the agent graph/SDK left behind (Python's allocator often
        # keeps RSS high even after objects die, so this only frees what it
        # can, but it makes genuine leaks observable).
        import gc

        gc.collect()
        logger.warning(
            "agent run complete chat_id=%s rss_mb=%.1f",
            chat_id,
            _rss_mb() or 0.0,
        )
        _log_memory_snapshot(chat_id)
    except asyncio.CancelledError:
        # Client disconnected (aborted the stream): close the keepalive wrapper
        # (cancels the in-flight __anext__ task) then the agent generator, to
        # unwind its background _drive task (which runs graph.astream). This
        # ensures the LLM provider call is properly interrupted.
        await _abort_close(ka_gen, agent_gen)
        # Log the drop with peak RSS so a recurring silent interrupt (crash /
        # OOM) becomes visible in codifa.log instead of going unnoticed.
        logger.warning(
            "stream DISCONNECTED (client/sidecar drop) chat_id=%s rss_mb=%.1f keepalives_sent=%d",
            chat_id,
            _rss_mb() or 0.0,
            ka_count,
        )
    except Exception as exc:
        # Log the full traceback to the FILE handler (codifa.log) so an opaque
        # upstream message ("Exceeded maximum output retries (1)", ...) never
        # hides the real trigger. Stderr may not be captured by Electron in
        # packaged mode, so print_exc alone is not enough. The user still sees
        # a readable error over SSE.
        await _abort_close(ka_gen, agent_gen)
        logger.exception(
            "agent run failed chat_id=%s rss_mb=%.1f",
            chat_id, _rss_mb() or 0.0,
        )
        yield _sse({"kind": "error", "content": _friendly_error(exc, model, base_url)})
    except BaseException as exc:  # non-Exception death (KeyboardInterrupt/SystemExit/custom)
        # Anything that is NOT a normal Exception (e.g. a BaseException raised
        # deep in the model SDK or checkpointer) would otherwise tear down the
        # SSE socket with NO event, so the frontend sees a silent "disconnect"
        # and self-heals with no explanation. Log it loudly and surface a
        # visible error so the real trigger is captured in codifa.log instead
        # of going unnoticed.
        if isinstance(exc, GeneratorExit):
            # Starlette frequently tears down an SSE stream with
            # ``GeneratorExit`` instead of ``CancelledError`` when the client
            # aborts (Stop button / closed socket). We must explicitly close
            # the agent generator here — otherwise ``run_graph``'s ``finally``
            # never runs, ``_drive`` is never cancelled, and the LLM provider
            # stream keeps running orphaned in the background. With every Stop
            # + resend a fresh stream is added on top, so the same chat ends
            # up with N concurrent provider streams still token-burning.
            # NOTE: we cannot await inside a GeneratorExit handler of an async
            # generator reliably, but aclose() on the keepalive wrapper runs
            # its finally (cancelling the in-flight __anext__ task) — awaited
            # here is fine because _stream_drive is being closed, not the
            # inner generator.
            await _abort_close(ka_gen, agent_gen)
            raise
        await _abort_close(ka_gen, agent_gen)
        logger.exception(
            "agent run terminated by non-Exception (silent-interrupt source) chat_id=%s rss_mb=%.1f",
            chat_id,
            _rss_mb() or 0.0,
        )
        try:
            yield _sse({"kind": "error", "content": f"agent crashed: {exc!r}"})
        except Exception:  # noqa: BLE001, S110 — best-effort: the stream is already dying
            pass


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")

    # Safety net: messages that ask to create/install skills or MCP connectors
    # grant the create_skill/create_mcp tools even if the frontend didn't flag
    # them. Available in EVERY mode (ask, plan, coder) — as long as the current
    # prompt (or the recent history, so a "continue" follow-up keeps the grant)
    # expresses the intent.
    if not req.allow_create:
        if wants_skill_or_mcp(req.prompt):
            req.allow_create = True
        else:
            for turn in (req.history or [])[-6:]:
                if turn.get("role") == "user" and wants_skill_or_mcp(
                    str(turn.get("content", ""))
                ):
                    req.allow_create = True
                    break

    async def event_gen():
        # New user turn -> new trace turn so the Trace panel can group
        # each turn's llm/prompt/tool entries under one header.
        # Carry the previous turn final status forward so a short follow-up
        # like "done?" starts with memory instead of re-running finished work.
        _prev_outcome_note = ""
        try:
            import trace_store as _trace_store

            _prev_outcome = _trace_store.previous_turn_outcome(str(req.chat_id or ""))
            _prev_outcome_note = _trace_store.format_turn_outcome_note(_prev_outcome)
            _trace_store.next_turn(str(req.chat_id or ""))
        except Exception:  # noqa: BLE001, S110 — trace must never break the stream
            pass
        _effective_history = list(req.history or [])
        if _prev_outcome_note:
            # Append at the TAIL, not prepend: the note text changes every
            # turn, so a position-0 entry shifts the entire transcript and
            # breaks the provider's prompt-cache prefix on EVERY turn start
            # (measured: a turn's first step re-read the whole history at
            # full price, cache_read=0). At the tail it only extends the
            # prefix, sits right next to the new user message, and
            # historyLimit trimming (which drops the oldest entries) can
            # never remove it. role=="system" maps to HumanMessage in
            # history_to_langchain_messages, so a tail entry is provider-safe.
            _effective_history = _effective_history + [
                {"role": "system", "content": _prev_outcome_note}
            ]
        # Create the agent generator so we can close it on disconnect
        agent_gen = run_agent(
            provider=req.provider,
            provider_id=req.provider_id,
            model_name=req.model,
            base_url=req.base_url,
            api_key=req.api_key,
            env_var=req.env_var,
            api_keys=req.api_keys,
            root=req.root,
            mode=req.mode,
            prompt=req.prompt,
            history=_effective_history,
            attachments=req.attachments,
            images=req.images,
            system_prompt=req.system_prompt,
            thinking_level=req.thinking_level,
            model_reasoning=req.model_reasoning,
            mcp_servers=req.mcp_servers,
            skills=req.skills,
            context_window=req.context_window,
            allow_create=req.allow_create,
            cap=req.cap,
            permission_gates=PERMISSION_GATES,
            ask_gates=ASK_GATES,
            allow_outside=req.allow_outside,
            allow_outside_folders=req.allow_outside_folders,
            allow_computer=req.allow_computer,
            nvim_file=req.nvim_file,
            nvim_diagnostics=req.nvim_diagnostics,
            vector_db_path=req.vector_db_path,
            vector_config=req.vector_config,
            retrieval_config=req.retrieval_config,
            subagent_models=req.subagent_models,
            chat_id=req.chat_id,
            providers=req.providers,
            compact_at_percent=req.compact_at_percent,
            max_steps=req.max_steps,
            restart=req.restart,
        )
        try:
            logger.warning(
                "agent run start chat_id=%s rss_mb=%.1f",
                req.chat_id,
                _rss_mb() or 0.0,
            )
            async for chunk in _stream_drive(
                agent_gen, req.chat_id, req.model, req.base_url
            ):
                yield chunk
        finally:
            # ارسال سیگنال پایان برای بستن استریم در فرانت‌اند
            # Clear any unconsumed steers for this chat so they don't leak into
            # a future run of the same chat (the frontend re-sends them as the
            # next turn via its own queue). Report them so the frontend can keep
            # them pending/visible instead of treating them as lost.
            dropped = await _drain_steer(req.chat_id)
            dropped_ids = [d.get("id", "") for d in dropped if d.get("id")]
            yield _sse({"kind": "done", "dropped_steer_ids": dropped_ids})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class SteerRequest(BaseModel):
    chat_id: str = ""
    id: str = ""
    prompt: str = ""
    attachments: list[str] = []
    images: list = []  # قرارداد یکسان با ChatRequest شامل path و dataUrl
    mcp_servers: dict = {}
    skills: list[str] = []
    # Full-fidelity history snapshot (same shape as ChatRequest.history).
    # Accepted for forward-compat but intentionally NOT enqueued: a running
    # turn already holds the live transcript, so re-attaching history here
    # would duplicate context and waste tokens.
    history: list[dict] = []


@app.post("/chat/steer")
async def chat_steer(req: SteerRequest) -> dict:
    """Queue a user message for injection into a RUNNING agent (no abort).

    The message sits in the per-chat STEER_INBOX until the run's next tool
    call, at which point the tool wrapper appends it to the tool result so the
    model reads it immediately. If the run ends before any tool call (e.g. the
    agent is already streaming its final answer), the message stays queued and
    the frontend auto-sends it as the next turn.
    """
    if not req.chat_id or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="chat_id and prompt are required")
    # ذخیره متن به‌همراه فایل‌ها و عکس‌ها تا تزریق گراف کامل باشد
    await _enqueue_steer(
        req.chat_id,
        {
            "id": req.id,
            "prompt": req.prompt.strip(),
            "attachments": req.attachments,
            "images": req.images,
            "mcp_servers": req.mcp_servers,
            "skills": req.skills,
        },
    )
    return {"ok": True}


class SteerCancelRequest(BaseModel):
    chat_id: str = ""
    id: str = ""


@app.post("/chat/steer/cancel")
async def chat_steer_cancel(req: SteerCancelRequest) -> dict:
    """Drop a pending steer from the inbox (user cancelled it before delivery)."""
    if not req.chat_id or not req.id:
        raise HTTPException(status_code=400, detail="chat_id and id are required")
    await _remove_steer(req.chat_id, req.id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Background sub-agents (per-chat) — right-panel live view + stop/steer from
# the UI, mirroring the main agent's task_steer/task_stop tools.
# ---------------------------------------------------------------------------


class SubagentSteerRequest(BaseModel):
    message: str = ""


def _subagent_job_view(job: dict) -> dict:
    """Public JSON shape of one background sub-agent job (no live internals)."""
    return {
        "task_id": str(job.get("task_id") or ""),
        "branch": int(job.get("branch") or 0),
        "description": str(job.get("description") or ""),
        "subagent_type": str(job.get("subagent_type") or ""),
        "status": str(job.get("status") or ""),
        "created_at": float(job.get("created_at") or 0.0),
        "steering": bool(job.get("steer_inbox")),
        "stop_requested": bool(job.get("stop_requested")),
        "report": str(job.get("report") or "")[:400],
        "events": [
            {
                "text": str(e.get("text") or ""),
                "tool": str(e.get("tool") or ""),
                "kind": str(e.get("kind") or "status"),
            }
            for e in (job.get("events") or [])[-14:]
        ],
    }


@app.get("/chats/{chat_id}/subagents")
async def subagents_list(chat_id: str) -> dict:
    """All background sub-agent jobs of one chat, newest first."""
    import subagent_jobs as _sub_jobs

    jobs = [
        _subagent_job_view(j)
        for j in _sub_jobs.list_chat_jobs(chat_id)
    ]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return {"jobs": jobs}


@app.post("/chats/{chat_id}/subagents/{task_id}/stop")
async def subagent_stop(chat_id: str, task_id: str) -> dict:
    """Stop one background sub-agent (same path as the task_stop tool)."""
    import subagent_jobs as _sub_jobs

    job = _sub_jobs.get_job(task_id)
    if job is None or str(job.get("chat_id") or "") != str(chat_id):
        raise HTTPException(status_code=404, detail="no such sub-agent in this chat")
    if job.get("status") != "running":
        return {"ok": True, "status": job.get("status")}
    _sub_jobs.request_stop(task_id)
    return {"ok": True, "status": "stopping"}


@app.post("/chats/{chat_id}/subagents/{task_id}/steer")
async def subagent_steer(chat_id: str, task_id: str, req: SubagentSteerRequest) -> dict:
    """Send a follow-up message to one running background sub-agent."""
    import subagent_jobs as _sub_jobs

    job = _sub_jobs.get_job(task_id)
    if job is None or str(job.get("chat_id") or "") != str(chat_id):
        raise HTTPException(status_code=404, detail="no such sub-agent in this chat")
    if not str(req.message or "").strip():
        raise HTTPException(status_code=400, detail="message is required")
    if job.get("status") != "running":
        raise HTTPException(status_code=409, detail=f"sub-agent is {job.get('status')}")
    _sub_jobs.enqueue_steer(task_id, req.message)
    return {"ok": True}


class MemoryRequest(BaseModel):
    """Root + optional vector-store folder for memory stats / clear."""

    root: str = ""
    vector_db_path: str = ""


class MemoryStatsResponse(BaseModel):
    available: bool = False
    db: str = ""
    docs: int = 0
    chunks: int = 0
    kinds: dict[str, int] = {}
    max_docs: int = 0
    max_chunks: int = 0
    ttl_days: int = 0


class MemoryClearResponse(BaseModel):
    ok: bool = False
    error: str = ""


@app.get("/memory/stats")
async def memory_stats(
    root: Annotated[str, Query(min_length=1, description="Workspace root")] = "",
    vector_db_path: Annotated[str, Query(description="Optional vector-store folder")] = "",
) -> MemoryStatsResponse:
    from tools import open_vector_store

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    store = open_vector_store(root, vector_db_path)
    if store is None:
        return MemoryStatsResponse()
    try:
        return MemoryStatsResponse(available=True, **store.stats())
    except Exception as exc:  # noqa: BLE001
        return MemoryStatsResponse(available=False, db="", error=str(exc))


@app.post("/memory/clear")
async def memory_clear(req: MemoryRequest) -> MemoryClearResponse:
    from tools import open_vector_store

    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")
    store = open_vector_store(req.root, req.vector_db_path)
    if store is None:
        raise HTTPException(status_code=503, detail="could not open vector store")
    try:
        store.clear()
        return MemoryClearResponse(ok=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not clear vector store: {exc}") from exc


# ---------------------------------------------------------------------------
# Index / retrieval / cleanup endpoints
# ---------------------------------------------------------------------------


class IndexStatusResponse(BaseModel):
    available: bool = False
    db: str = ""
    docs: int = 0
    chunks: int = 0
    kinds: dict[str, int] = {}
    embedder: bool = False
    needs_index: bool = False


class IndexRunRequest(BaseModel):
    root: str = ""
    vector_db_path: str = ""
    vector_config: dict | None = None
    budget: int = 0  # 0 = unlimited (index everything this run)


class IndexRunResponse(BaseModel):
    ok: bool = False
    total: int = 0
    indexed: int = 0
    pruned: int = 0
    skipped: int = 0
    unchanged: int = 0
    error: str = ""


class CleanupRunRequest(BaseModel):
    root: str = ""
    vector_db_path: str = ""


class CleanupRunResponse(BaseModel):
    ok: bool = False
    evicted: int = 0
    pruned_files: int = 0
    vacuumed: bool = False
    cache_purged: int = 0
    error: str = ""


def _open_store(root: str, vector_db_path: str):
    """Open the workspace store or raise 400 with a clear message."""
    from tools import open_vector_store

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    store = open_vector_store(root, vector_db_path)
    if store is None:
        raise HTTPException(status_code=503, detail="vector store unavailable")
    return store


@app.get("/code-map")
async def get_code_map(
    root: Annotated[str, Query(min_length=1, description="Workspace root")] = "",
) -> dict:
    """نقشه‌ی زنده‌ی نمادهای پروژه را برای پنل CodeMapPanel برمی‌گرداند.

    خروجی به شکل ``{rel_path: [{name, line, kind}, ...]}`` است؛ هر فایل فقط
    نمادهای قابل استخراج (تابع، کلاس، متد، struct، enum، ...) را شامل می‌شود.
    """
    from symbol_index import build_symbol_map

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=404, detail=f"workspace not found: {root}")
    try:
        sym_map = await asyncio.to_thread(build_symbol_map, root)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("code-map build failed for %s: %s", root, exc)
        raise HTTPException(status_code=500, detail=f"code-map build failed: {exc}") from exc
    # تبدیل tuple به dict (frontend-friendly) — kind همان مقدار "function"/"class"/...
    return {
        rel: [{"name": n, "line": l, "kind": k} for (n, l, k) in syms]
        for rel, syms in sym_map.items()
    }


@app.get("/index/status")
async def index_status(
    root: Annotated[str, Query(min_length=1, description="Workspace root")] = "",
    vector_db_path: Annotated[str, Query(description="Optional vector-store folder")] = "",
) -> IndexStatusResponse:
    # Lightweight gate: file-presence check only, never loads the model so
    # status polling does not pin the ~1.1 GB session in RAM.
    from embeddings import is_available as embedder_available
    from indexer import needs_index

    try:
        store = _open_store(root, vector_db_path)
    except HTTPException:
        return IndexStatusResponse()
    try:
        stats = store.stats()
        return IndexStatusResponse(
            available=True,
            db=str(getattr(store, "_db_path", "")),
            docs=int(stats.get("docs", 0)),
            chunks=int(stats.get("chunks", 0)),
            kinds=dict(stats.get("by_kind", {})),
            embedder=embedder_available(),
            needs_index=bool(needs_index(store, root)),
        )
    except Exception as exc:  # noqa: BLE001
        return IndexStatusResponse(available=False, error=str(exc))


@app.post("/index/run")
async def index_run(req: IndexRunRequest) -> IndexRunResponse:
    from indexer import index_workspace

    store = _open_store(req.root, req.vector_db_path)
    try:
        result = index_workspace(
            store,
            req.root,
            budget=req.budget or 0,
        )
        return IndexRunResponse(ok=True, **result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"indexing failed: {exc}") from exc


@app.post("/cleanup/run")
async def cleanup_run(req: CleanupRunRequest) -> CleanupRunResponse:
    from cleanup import run_cleanup

    store = _open_store(req.root, req.vector_db_path)
    try:
        report = run_cleanup(store, req.root)
        return CleanupRunResponse(ok=True, **report)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"cleanup failed: {exc}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Codifa agent sidecar")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    # Dump a C-level traceback to stderr on segfault/abort so a hard crash (e.g.
    # in onnxruntime/CTranslate2) is diagnosable instead of silent. The Electron
    # sidecar pipes this stderr to the app logs.
    try:
        import faulthandler

        faulthandler.enable()
    except Exception:  # noqa: BLE001, S110
        pass

    # Central file logging: every Python logger (retrieval, vector_store, and any
    # future module) appends WARNING+ to <data root>/codifa.log so a packaged app
    # whose stderr is not captured still leaves a persistent error trail behind.
    try:
        import logging
        import logging.handlers

        from _log_filter import ServerErrorOnlyFilter
        from tools import user_coder_dir

        _log_dir = user_coder_dir()
        os.makedirs(_log_dir, exist_ok=True)
        # Rotating handler: cap each log at 5 MB and keep 3 backups (15 MB total).
        # Without rotation, repeated run-start/complete lines + MEM-NOW/MEM-GROW
        # snapshot blocks push codifa.log into the hundreds-of-MB range over a
        # long session, and the file keeps growing forever.
        _handler = logging.handlers.RotatingFileHandler(
            os.path.join(_log_dir, "codifa.log"),
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        _handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s: %(message)s"
            )
        )
        # Default-on: silence the noisy per-run WARNING lines from codifa.server
        # ("agent run start/complete", "stream DISCONNECTED", rss snapshots …)
        # so codifa.log keeps only the genuine errors. Disconnect diagnostics
        # from graph.py / codifa.graph are unaffected (they reach the file
        # because they are emitted by a different logger name). Operators can
        # turn this off with CODFA_LOG_FILE_SERVER_ERROR_ONLY=0 if they need
        # the full per-run trail in the persistent log again.
        if os.environ.get("CODFA_LOG_FILE_SERVER_ERROR_ONLY", "1") != "0":
            _handler.addFilter(ServerErrorOnlyFilter())
        _root = logging.getLogger()
        # Allow raising the file-log verbosity via CODFA_LOG_LEVEL (e.g. "DEBUG"
        # or "WARNING") so diagnostic lines like graph.py's "[CTX_DEBUG]
        # auto_compact ..." reach the persistent log when needed. Defaults to
        # WARNING+ so every exception (logger.exception / logger.error / logger.warning)
        # lands in codifa.log — the persistent record the user reviews when a
        # run cuts off or errors silently.  Operators can raise to ERROR via
        # CODFA_LOG_LEVEL=ERROR to suppress warnings in the file.
        _level_name = os.environ.get("CODFA_LOG_LEVEL", "WARNING").upper()
        _root.setLevel(getattr(logging, _level_name, logging.WARNING))
        _root.addHandler(_handler)
        # Third-party libraries (httpx/httpcore transport noise, the openai SDK's
        # request/response debug, and aiosqlite's per-statement logging) emit an
        # enormous volume of DEBUG lines that bury the real signal and bloat the
        # persistent log (MBs of header dumps per agent run). Keep their file-log
        # verbosity capped at WARNING regardless of CODFA_LOG_LEVEL so a DEBUG
        # diagnostic session still produces a readable codifa.log. Our own
        # "codifa.*" modules are unaffected and follow CODFA_LOG_LEVEL as before.
        for _noisy in (
            "httpx",
            "httpcore",
            "openai",
            "openai._base_client",
            "aiosqlite",
        ):
            logging.getLogger(_noisy).setLevel(logging.WARNING)
        # Start allocation tracing when asked (off by default: tracemalloc adds a
        # small CPU/memory overhead). Enable via CODFA_TRACE_MALLOC=1, or
        # automatically when CODFA_LOG_LEVEL=DEBUG so a diagnostic session also
        # captures per-run allocation diffs.
        _maybe_start_tracemalloc()
    except Exception:  # noqa: BLE001, S110 — logging must never kill the sidecar
        pass

    # Disable broken stdio MCP connectors (e.g. a docker MCP with invalid flags)
    # as soon as the sidecar starts, so they never spam errors during use.
    try:
        from tools import validate_mcp_servers

        validate_mcp_servers()
    except Exception:  # noqa: BLE001, S110 — broken connectors are handled lazily
        pass

    # Seed built-in skills from backend/skills/*.md on every startup (no-op for
    # skills that already exist, so user edits/deletions are never overwritten).
    try:
        from tools import sync_builtin_skills

        sync_builtin_skills()
    except Exception:  # noqa: BLE001, S110 — a seed failure must not kill the sidecar
        pass

    # Install the built-in MCP connectors (e.g. the Docker MCP) on first run.
    try:
        from tools import seed_builtin_mcp

        seed_builtin_mcp()
    except Exception:  # noqa: BLE001, S110 — a seed failure must not kill the sidecar
        pass

    import uvicorn

    # Ensure essential data-root dirs exist (settings.json, skills/, mcp/, plan/).
    try:
        import state_db

        state_db.bootstrap()
    except Exception:  # noqa: BLE001, S110
        pass

    # Resume state is held in LangGraph's checkpointer (a SQLite DB under the
    # data root). On startup, reclaim any checkpoint left behind by an
    # interrupted turn that was never resumed (errors/crashes), keyed by age.
    try:
        asyncio.run(prune_stale_resume_checkpoints())
    except Exception:  # noqa: BLE001, S110
        pass

    # Still prune orphaned plan dirs on shutdown.
    try:
        import atexit

        import state_db as _state_db

        atexit.register(lambda: _state_db.prune_orphan_plans())
    except Exception:  # noqa: BLE001, S110
        pass

    # Make sure any unhandled exception (e.g. in a background task, signal
    # handler, or top-level code path that bypasses FastAPI) still reaches the
    # persistent codifa.log — not just stderr, which Electron may not capture
    # in packaged mode. Without this, a hard crash inside a background task
    # only shows up as a single "Task exception was never retrieved" line that
    # the user can never see, which is exactly the "message cuts off" symptom.
    try:
        import sys

        def _excepthook(exc_type, exc_value, exc_tb):
            logging.getLogger("codifa.server").error(
                "unhandled exception (not caught by FastAPI):",
                exc_info=(exc_type, exc_value, exc_tb),
            )
            # Also call the default hook so the process still dies normally
            # and the traceback reaches stderr for live dev.
            sys.__excepthook__(exc_type, exc_value, exc_tb)

        sys.excepthook = _excepthook
    except Exception:  # noqa: BLE001, S110
        pass

    # Same for asyncio: an orphaned background task that raises will print
    # "Task exception was never retrieved" to stderr (often dropped by
    # Electron) and otherwise disappear. Wire the loop's exception handler so
    # the same traceback lands in codifa.log.
    try:

        def _asyncio_excepthook(loop, context):
            logging.getLogger("codifa.server").error(
                "asyncio task exception: %s",
                context,
                exc_info=context.get("exception"),
            )
            loop.default_exception_handler(context)

        # Defer until uvicorn creates the loop — installing it here would be
        # overwritten by uvicorn's own loop setup. We register it via an
        # atexit-like boot hook by wrapping the existing handler install path
        # after uvicorn.run starts; the simplest approach is to monkey-patch
        # asyncio.get_event_loop_policy later. Instead, install a one-shot
        # factory that wires the handler as soon as a loop is created.
        _orig_get_event_loop_policy = asyncio.get_event_loop_policy

        class _PolicyWithHandler:
            def __init__(self, inner):
                self._inner = inner
                self._installed = False

            def get_event_loop(self):
                loop = self._inner.get_event_loop()
                self._install(loop)
                return loop

            def new_event_loop(self):
                loop = self._inner.new_event_loop()
                self._install(loop)
                return loop

            def _install(self, loop):
                if self._installed:
                    return
                self._installed = True
                try:
                    loop.set_exception_handler(_asyncio_excepthook)
                except Exception:  # noqa: BLE001, S110
                    pass

            def __getattr__(self, name):
                return getattr(self._inner, name)

        asyncio.set_event_loop_policy(_PolicyWithHandler(_orig_get_event_loop_policy()))
    except Exception:  # noqa: BLE001, S110
        pass

    global _SIDECAR_PORT
    _SIDECAR_PORT = args.port
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
