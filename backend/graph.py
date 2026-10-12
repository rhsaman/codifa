"""LangGraph orchestration for the Codifa agent workflow.

Explicit state machine:

    Router
    +-- Ask   (web_search / fetch_url / vision / read / grep / glob)
    +-- Plan  (web_search / fetch_url / vision / glob / grep / read / terminal)
    +-- Build (edit_file / write_file / create / delete)
              -> Review -> Done

The Build mode runs the project's tests itself (via run_terminal) before finishing —
there is NO automatic test/debug loop in the graph. The graph only routes
Build -> Review -> Done.

The graph controls the *high-level* flow (routing, the tool-permission
boundaries). Each node runs ONE LLM turn for its mode via a
shared LangChain tool-loop runner (``_run_mode_turn``). That runner:

* builds the system prompt / history / RAG / skills using the SAME helpers the
  old ``run_agent`` used (so the prompts stay identical);
* binds ONLY the tools allowed for that mode (enforced here, not just in text);
* streams text/thinking/tool events into a shared queue;
* applies the *essential* resilience from the old runner: free-tier throttle
  retry, context-window auto-compact, interrupted-turn resume, and live steer
  injection.

The existing tool implementations (``tools.make_tool_callbacks``) are reused
unchanged -- only the LLM client and the orchestration changed.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import itertools
import json
import logging
import os
import re
import time
import traceback
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone
from typing import Any, TypedDict

import httpx

logger = logging.getLogger(__name__)

# Cheap file-token extractor for the turn-start LSP warmup: matches file-ish
# tokens (src/app.py, backend/tools.py, ./x.ts) in the prompt so the right
# language server starts before the first lsp_* tool call needs it.
_PATH_TOKEN_RE = re.compile(r"(?:[\w.-]+/)*[\w.-]+\.[A-Za-z]{1,5}")


def _env_timeout(name: str, default_s: float) -> float:
    """Read a timeout budget from the environment with a safe fallback."""
    try:
        value = float(os.environ.get(name, "") or default_s)
    except (TypeError, ValueError):
        return default_s
    return value if value > 0 else default_s


async def _bounded_to_thread(
    label: str, chat_id: str, timeout_s: float, func, /, *args, **kwargs
):
    """Run sync ``func`` off the event loop with a fail-open timeout.

    Returns ``func``'s result, or raises ``asyncio.TimeoutError`` after
    ``timeout_s`` (callers fall back to continuing without that input, so a
    wedged worker can never freeze a turn). The orphaned worker thread keeps
    running detached and its late result is discarded.
    """
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(func, *args, **kwargs), timeout_s
        )
    except asyncio.TimeoutError:
        logger.warning(
            "[turn-ctx] %s timed out after %.0fs, continuing without it (chat=%s)",
            label,
            timeout_s,
            str(chat_id or "")[:8],
        )
        raise

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph

import agents as _agents
import state_db
from _common import (
    _extract_cache_tokens,
    _extract_reasoning_tokens,
    _is_repeating,
    _resolve_stream_end_text,
    _scrub_think_prefix,
    _strip_think_tags,
)
from agents import normalize_mode
from llm import (
    _PLAN_ONLY_NUDGE,
    _batchable_nudge,
    _BatchStreakTracker,
    _clone_model_with_key,
    _is_connection_dropped,
    _is_key_error,
    _is_parallel_calls_error,
    _is_plan_only_step,
    _is_reasoning_effort_error,
    _is_stream_options_error,
    _is_temperature_error,
    _normalized_call_sig,
    _plan_only_step_marks_progress,
    _remap_reasoning_effort,
    _RevisitStreakTracker,
    rebuild_model_fresh,
    _strip_parallel_calls,
    _strip_stream_options,
    _strip_temperature,
    append_tool_result,
    bind_tools_parallel,
    build_chat_model,
    chat_model_settings,
    dedupe_step_tool_call_ids,
    llm_generate,
    model_key_fallback,
    normalize_tool_transcript,
)
from mcp_bridge import build_mcp_tools, is_browser_mcp_tool
from tool_batching import (
    execute_readonly_calls,
    merge_same_scope_greps,
)
from tool_message_projection import (
    project_tool_results,
    stable_tool_order,
)

# Alias kept for existing call sites; logic lives in tool_message_projection.
_stable_tool_order = stable_tool_order
from tools import (
    _MAX_SEARCH_BATCHES_WITHOUT_EDIT,
    _PARENT_TOOLS_CTX,
    make_tool_callbacks,
)

# Tool calls in this set mutate persistent state (files, terminal, saved
# memory/skills/connectors) or block on a real human (ask_user) -- they run
# SEQUENTIALLY, each waiting for the previous to finish, so two writes can
# never race and a blocking question never overlaps another call. Everything
# else (grep/glob/read/lsp_symbols/web_search/fetch_url/vision/task -- all
# read-only) runs CONCURRENTLY via asyncio.gather when the model requests
# several in the same step, matching opencode's own behavior (regular tool
# calls run via Promise.all). Reads never take a global write lock (per-file
# locks only, held solely by mutating tools) and never block on LSP startup
# inside the call, so two concurrent sub-agent loops progress in parallel:
# each loop owns isolated transcript/tracker state and shares no transcript
# lock or LSP-start lock. This does NOT increase token cost: the provider
# still gets exactly the same set of ToolMessages either way -- only
# wall-clock latency changes.
_SEQUENTIAL_TOOLS = {
    "write_file",
    "edit_file",
    "write_document",
    "run_terminal",
    "confirm_action",
    "memory",
    "create_skill",
    "create_mcp",
    "ask_user",
    "computer",
}

# Build search guard (main agent loop only; Ask/Plan and sub-agents are never
# gated). After _MAX_SEARCH_BATCHES_WITHOUT_EDIT steps made of grep/glob with
# no edit in between, further search calls are refused with a message that
# points at the symbols earlier results already surfaced, so the model edits
# instead of searching again. Targeted read is NOT budgeted: it self-limits
# (covering-window stubs + per-file per-turn line cap in tools.py) and a live
# trace showed budgeting it made the model fight the guard for 3 wasted rounds
# instead of converging on the answer it already had the coordinates for.
# Any edit (including update_plan) re-arms the budget.
_SEARCH_TOOLS = frozenset({"grep", "glob"})
_EDIT_TOOLS = frozenset({"edit_file", "write_file", "update_plan"})
_SEARCH_REFUSAL_PREFIX = "SEARCH BUDGET EXCEEDED"
_SEARCH_HINT_SYMBOLS = 3
# Header of an annotated grep hit: `path:line: in NAME (Lstart-end)`.
_GREP_SYMBOL_HIT_RE = re.compile(
    r"^(?P<path>[^\s:][^:\n]*):\d+: in (?P<name>[^\s(]+) \(L\d+-\d+\)",
    re.MULTILINE,
)


def _is_search_refusal(content: Any) -> bool:
    """True for a search-budget refusal, which must never be replayed as a result."""
    return str(content or "").startswith(_SEARCH_REFUSAL_PREFIX)


def _recent_symbol_hits(
    msgs: list, limit: int = _SEARCH_HINT_SYMBOLS
) -> list[tuple[str, str]]:
    """Newest-first (path, symbol) pairs from `in NAME (L..)` grep annotations."""
    seen: set[tuple[str, str]] = set()
    hits: list[tuple[str, str]] = []
    for m in reversed(msgs):
        if not isinstance(m, ToolMessage):
            continue
        for found in _GREP_SYMBOL_HIT_RE.finditer(str(m.content or "")):
            key = (found.group("path"), found.group("name"))
            if key in seen:
                continue
            seen.add(key)
            hits.append(key)
            if len(hits) >= limit:
                return hits
    return hits


def _search_refusal_text(search_steps: int, msgs: list) -> str:
    """Refusal text for a search past the budget, with ready-to-use read calls."""
    text = (
        f"{_SEARCH_REFUSAL_PREFIX}: {search_steps} search steps without an edit "
        f"(max {_MAX_SEARCH_BATCHES_WITHOUT_EDIT}). No more grep/glob until you "
        "edit. Targeted read(symbols=[...]/ranges=[...]) calls are still allowed — "
        "use them to finish what you hold, then edit now with edit_file/write_file "
        "(or update_plan for the checklist step). If the task cannot proceed, say "
        "what is missing instead of searching again."
    )
    by_file: dict[str, list[str]] = {}
    for path, name in _recent_symbol_hits(msgs):
        by_file.setdefault(path, []).append(name)
    if by_file:
        calls = "; ".join(
            f"read(filePath={path!r}, symbols={names!r})"
            for path, names in by_file.items()
        )
        text += f" From earlier results: {calls}."
    return text


def _search_gate_text(
    mode: str | None, search_steps: int, call_names: list[str], msgs: list
) -> str | None:
    """Refusal text when a build step would search past the budget, else None."""
    if (mode or "") != "build":
        return None
    if search_steps < _MAX_SEARCH_BATCHES_WITHOUT_EDIT:
        return None
    if not any(name in _SEARCH_TOOLS for name in call_names):
        return None
    return _search_refusal_text(search_steps, msgs)


def _soft_search_nudge(mode: str, search_batches: int) -> str | None:
    """Soft model-visible search-budget message for ask mode, else None.

    Build refuses past the budget (hard gate) and plan converges via the
    scout budget plus the plan-done hint; ask had nothing, so an ask turn
    could spray searches step after step. Past the budget the nudge repeats
    every 4th search step. Calls still run — read-only modes are never
    gated, only steered back to answering.
    """
    if (mode or "") != "ask":
        return None
    if search_batches < _MAX_SEARCH_BATCHES_WITHOUT_EDIT:
        return None
    if (search_batches - _MAX_SEARCH_BATCHES_WITHOUT_EDIT) % 4:
        return None
    return (
        f"SEARCH BUDGET: {search_batches} search steps this turn. You have "
        "enough context — answer now from what you already hold instead of "
        "searching again."
    )


def _targeted_search_note(mode: str) -> str:
    """LSP-first search guidance appended to the workspace note.

    Every repo-access mode (ask/plan/build) gets the same core rule — a
    precise LSP jump before any grep — so blind OR-grep sprays don't happen
    in plan/ask turns either. Only the closing directive differs: build
    converges to editing, read-only modes converge to the answer/plan.
    """
    tail = (
        " After at most 2-3 search batches start editing in the SAME turn."
        if (mode or "") == "build"
        else " After at most 2-3 search batches, conclude from what you already hold."
    )
    return (
        f"\n\n=== TARGETED SEARCH ({str(mode or 'ASK').upper()}) ===\n"
        "Start from LSP (lsp_definition/references/hover/symbols) for a precise jump, "
        "then ONE targeted grep with context if needed, then read only the pointed windows via symbols=[...] or "
        "ranges=[...]. You have full workspace access; prefer targeted lookups with path/include."
        + tail
    )


# ---------------------------------------------------------------------------
# Native interrupted-turn resume (LangGraph checkpointer)
# ---------------------------------------------------------------------------
# We no longer keep a bespoke JSONL "resume file". The full in-flight message
# transcript is persisted through LangGraph's own ``AsyncSqliteSaver``
# checkpointer, keyed per chat. On a reconnect/interrupt the transcript
# (including every completed tool call + its result) is reloaded from the
# checkpointer so the turn CONTINUES instead of redoing work. LangGraph owns
# serialization, durability (survives a full app restart) and the schema — the
# exact responsibilities the old custom file hand-rolled, now delegated to the
# framework. This also fixes the repetition-loop coupling: the replayed results
# keep their ORIGINAL tool_call ids, so the loop's result-dedup (by name+args
# signature) reuses them instead of re-running identical greps.
_RESUME_CHECKPOINT_PATH: str | None = None


def _resume_checkpoint_path() -> str:
    global _RESUME_CHECKPOINT_PATH
    if _RESUME_CHECKPOINT_PATH is None:
        _RESUME_CHECKPOINT_PATH = os.path.join(
            state_db.data_root(), "resume_checkpoints.sqlite"
        )
    return _RESUME_CHECKPOINT_PATH


def _resume_checkpoint_config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}


def _resume_thread_id(state: AgentState) -> str:
    # Keyed per chat — equivalent to the prior per-chat resume semantics and
    # needs no frontend change. A future frontend-supplied ``run_id`` would make
    # this per-turn (so two turns in the same chat don't share one checkpoint).
    return f"resume:{state.get('chat_id', '')}"


async def _save_turn_checkpoint(
    thread_id: str, messages: list, mode: str = "", plan: list | None = None
) -> None:
    try:
        from langgraph.checkpoint.base import empty_checkpoint
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        ckpt = empty_checkpoint()
        ckpt["channel_values"] = {
            "messages": messages,
            "mode": mode or "",
            "plan": list(plan or []),
        }
        ckpt["channel_versions"] = {"messages": "v1"}
        ckpt["versions_seen"] = {}
        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            await saver.aput(
                _resume_checkpoint_config(thread_id),
                ckpt,
                {"step": 1, "source": "input", "writes": {}},
                {"messages": "v1"},
            )
    except Exception as exc:  # noqa: BLE001 — best-effort, but visible in the log
        logger.warning("failed to persist resume checkpoint: %s", exc)


# Placeholder result for tool_calls that never ran before the turn was cut off.
# Without this cover, the provider rejects the transcript with
# "tool_calls must be followed by tool messages" and resume breaks.
_INTERRUPTED_TOOL_PLACEHOLDER = (
    "[interrupted before running — re-issue if still needed]"
)


def _unanswered_tool_calls(msgs: list, calls: list) -> list:
    """Return ``calls`` that still lack a matching ToolMessage in ``msgs``."""
    answered = {m.tool_call_id for m in msgs if isinstance(m, ToolMessage)}
    return [tc for tc in calls if tc.get("id") and tc.get("id") not in answered]


# Save every step (was every 3): a mid-turn disconnect between saves lost
# the last 1-2 tool results and forced a redo. Sqlite aput on a single chat
# thread is cheap compared to an LLM round-trip, so always persist.
_CHECKPOINT_EVERY_N_STEPS = 1
_CHECKPOINT_MIN_GROWTH_CHARS = 20_000
_checkpoint_state: dict[str, dict] = {}
# In-flight background checkpoint save per thread: while a save is running,
# a newer one is skipped (the next due save catches up) so saves never pile
# up behind a slow sqlite write and never block the turn's critical path.
_checkpoint_save_tasks: dict[str, asyncio.Task] = {}


def _log_task_exception(task: asyncio.Task) -> None:
    """Done-callback for detached background tasks: log a swallowed exception
    instead of letting it surface only as "Task exception was never retrieved"."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.warning("background task failed: %s: %s", type(exc).__name__, exc)


# Repetition-loop scan stride for the streaming loop: _is_repeating()
# re-scans the reply tail on every call, so checking on EVERY chunk makes a
# long answer quadratic. A repeated unit is at most 200 chars (3 consecutive
# copies at most 600), so a 240-char stride can never skip a live loop; the
# stream-end check still catches anything shorter.
_REPEAT_SCAN_STRIDE = 240


def _checkpoint_due(thread_id: str, msgs: list, *, force: bool = False) -> bool:
    """True when a checkpoint write is worth its latency cost."""
    try:
        st = _checkpoint_state.get(thread_id)
        is_new = st is None
        if is_new:
            st = {"steps": 0, "chars": 0}
            _checkpoint_state[thread_id] = st
        st["steps"] = int(st.get("steps") or 0) + 1
        _chars = sum(len(str(getattr(m, "content", "") or "")) for m in msgs)
        _grown = _chars - int(st.get("chars") or 0)
        if force or is_new or st["steps"] >= _CHECKPOINT_EVERY_N_STEPS or _grown >= _CHECKPOINT_MIN_GROWTH_CHARS:
            st["steps"] = 0
            st["chars"] = _chars
            return True
        return False
    except Exception:  # noqa: BLE001 — throttling must never block a save
        return True


async def _save_turn_checkpoint_valid(
    thread_id: str,
    msgs: list,
    pending_calls: list = (),
    *,
    force: bool = False,
    mode: str = "",
    plan: list | None = None,
) -> None:
    """Save a checkpoint whose transcript is ALWAYS valid for the provider.

    Every tool_call of the current step that still lacks a result is covered
    with a placeholder ToolMessage, so resume is never rejected with
    "tool_calls must be followed by tool messages" and the turn continues
    from the same point.

    Writes are throttled (every N steps or on significant growth) so the
    per-step sqlite latency does not grow with the transcript; pass
    ``force=True`` for the final save of a turn.
    """
    if not _checkpoint_due(thread_id, msgs, force=force):
        return
    patch = [
        ToolMessage(content=_INTERRUPTED_TOOL_PLACEHOLDER, tool_call_id=tc["id"])
        for tc in _unanswered_tool_calls(msgs, pending_calls)
    ]
    # Snapshot the transcript NOW (the loop keeps mutating `msgs` while the
    # save runs in the background) and hand the snapshot to a detached task so
    # the per-step sqlite write never sits on the turn's critical path. A
    # forced save (turn end / last sequential tool) still awaits so the
    # durable state is guaranteed before the turn finishes.
    _snapshot = list(msgs) + patch
    _prev = _checkpoint_save_tasks.get(thread_id)
    if _prev is not None and not _prev.done():
        if force:
            # The final save must land; wait for the in-flight one first so
            # two concurrent writers never interleave on the same thread.
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await _prev
        else:
            # A save is already running for this thread: skip — the next due
            # save (throttling re-arms every step) persists the newer state.
            return

    async def _bg_save() -> None:
        _ckpt_t0 = time.monotonic()
        try:
            await _save_turn_checkpoint(thread_id, _snapshot, mode=mode, plan=plan)
        finally:
            _checkpoint_save_tasks.pop(thread_id, None)
            try:
                _ckpt_dt = time.monotonic() - _ckpt_t0
                if _ckpt_dt > 1.0:
                    logger.warning(
                        "[ckpt-timing] thread=%s slow_save=%.1fs msgs=%d",
                        str(thread_id or "")[:16],
                        _ckpt_dt,
                        len(_snapshot),
                    )
            except Exception:  # noqa: BLE001, S110 — timing never breaks save
                pass

    _task = asyncio.create_task(_bg_save())
    _checkpoint_save_tasks[thread_id] = _task
    if force:
        await _task
    else:
        # Detached: a crash of the save must never kill the turn. The task
        # removes itself from the registry on completion.
        _task.add_done_callback(_log_task_exception)


def _sanitize_trailing_tool_calls(msgs: list) -> list:
    """Defensive cleanup for (possibly corrupt) checkpoints already on disk.

    When the last AIMessage carries tool_calls that still lack their full
    answers, append placeholders for the unanswered calls. When a
    HumanMessage follows (e.g. a steer), leave it alone -- the pre-flight
    ``strip_orphaned_tool_calls`` covers that case.
    """
    for m in reversed(msgs):
        if isinstance(m, HumanMessage):
            return msgs
        calls = getattr(m, "tool_calls", None)
        if isinstance(m, AIMessage) and calls:
            patch = [
                ToolMessage(
                    content=_INTERRUPTED_TOOL_PLACEHOLDER, tool_call_id=tc["id"]
                )
                for tc in _unanswered_tool_calls(msgs, calls)
            ]
            return list(msgs) + patch if patch else msgs
    return msgs


def _append_resume_request(messages: list, request: str) -> list:
    """Append a fresh user message to the resume transcript (no duplicates).

    On resume, ``messages`` is fully replaced by the checkpoint; without this
    helper the user's new text ("continue" or any fresh instruction) would
    never reach the model. Retrying the same previous text is not duplicated
    because it matches an existing message.
    """
    req = (request or "").strip()
    if not req:
        return messages
    if any(
        isinstance(m, HumanMessage) and str(m.content).strip() == req
        for m in messages
    ):
        return messages
    return list(messages) + [HumanMessage(content=req)]


def _latest_plan_from_history(history: list | None) -> list[dict]:
    """Return the latest non-empty frontend checklist (`plan`) for resume.

    The checkpoint holds LangChain messages but not the UI checklist statuses;
    without this the resumed turn loses which todos are done and re-executes
    them. Frontend history carries `plan` on assistant messages — reuse the
    latest one so the resumed turn continues pending steps only.
    """
    if not history:
        return []
    for turn in reversed(history):
        if not isinstance(turn, dict):
            continue
        items = turn.get("plan")
        if isinstance(items, list) and items:
            clean: list[dict] = []
            for it in items:
                if not isinstance(it, dict):
                    continue
                content = str(it.get("content", "")).strip()
                if not content:
                    continue
                status = str(it.get("status", "pending")).strip().lower()
                if status not in ("pending", "in_progress", "completed"):
                    status = "pending"
                clean.append({"content": content[:200], "status": status})
            if clean and not all(i["status"] == "completed" for i in clean):
                return clean
    return []


def _plan_progress_line(plan: list[dict]) -> str:
    """One-line checklist progress (cheap resume memory, ~20 tokens).

    E.g. ``"2/5 done — current: write tests"`` so a resumed turn knows where
    to continue without re-reading the full checklist.
    """
    done = sum(
        1 for it in plan if isinstance(it, dict) and it.get("status") == "completed"
    )
    total = len(plan)
    current = ""
    for it in plan:
        if not isinstance(it, dict):
            continue
        if it.get("status") in ("in_progress", "pending"):
            current = str(it.get("content", "")).strip()[:120]
            if current:
                break
    if current:
        return f"{done}/{total} done — current: {current}"
    return f"{done}/{total} done"


def _plan_status_message(plan: list[dict]) -> HumanMessage | None:
    """Fold checklist progress into a one-line resume note."""
    if not plan:
        return None
    return HumanMessage(
        content=(
            "[Checklist progress "
            + _plan_progress_line(plan)
            + " — do NOT re-execute completed steps; continue pending steps "
            "via update_plan with the SAME items.]"
        )
    )


async def _load_turn_checkpoint(thread_id: str) -> list | None:
    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            tup = await saver.aget_tuple(_resume_checkpoint_config(thread_id))
        if tup is None:
            return None
        return tup.checkpoint.get("channel_values", {}).get("messages")
    except Exception as exc:  # noqa: BLE001 — best-effort: a missing/corrupt checkpoint just means "no resume"
        logger.warning("failed to load resume checkpoint: %s", exc)
        return None


async def _load_prev_mode(thread_id: str) -> str | None:
    """Read the persisted mode of the previous turn (BEFORE this run's input
    merges in) so we can detect a user mode switch and re-orient the agent."""
    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            tup = await saver.aget_tuple(_resume_checkpoint_config(thread_id))
        if tup is not None:
            return (tup.checkpoint.get("channel_values", {}) or {}).get("mode")
    except Exception:  # noqa: BLE001 — best-effort; a missing checkpoint just means "no prior mode"
        return None
    return None


async def _clear_turn_checkpoint(thread_id: str) -> None:
    with contextlib.suppress(Exception):
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            await saver.adelete_thread(thread_id)


def _parse_checkpoint_ts(ts_raw) -> float | None:
    if ts_raw is None:
        return None
    if isinstance(ts_raw, datetime):
        return ts_raw.timestamp()
    if isinstance(ts_raw, str):
        try:
            return datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).timestamp()
        except Exception:  # noqa: BLE001
            return None
    return None


# Default guards for "is this checkpoint fresh enough to resume?". A stale
# checkpoint from a previous model, workspace, or mode is more dangerous than
# useful: resuming it would re-execute already-done tool calls and could
# produce a silently broken first reply. Drop and start fresh instead.
# TTL is 12h (was 2h): a checkpoint left overnight by an interrupted turn
# must still resume instead of redoing all tool work. Size cap is 120 tool
# messages (was 40): a real build turn easily does 15-20 read/grep calls and
# long multi-file tasks exceed 40 without being a loop — the repetition guard
# (tool-signature based) already stops stuck loops, so the size guard only
# catches absurd transcripts.
_RESUME_MAX_AGE_S = 12 * 60 * 60  # 12 hours
# سیاست حد ابزار: این حد فقط «تعداد فراخوانی» را می‌شمارد، نه حجم توکن را؛
# پنجرهٔ کانتکست را auto-compact (آستانهٔ درصدی) محافظت می‌کند. یک turn واقعی
# build به‌راحتی ۱۵-۲۰ فراخوانی read/grep دارد، پس حدِ پایین (مثل ۸) عملاً
# چک‌پوینت را همیشه می‌انداخت و رزومهٔ واقعی بی‌استفاده می‌شد — همان
# «کانتکست کم می‌شود بعد از استپ» که کاربر می‌دید.
_RESUME_MAX_TOOL_CALLS = 120


async def _load_turn_checkpoint_valid(
    thread_id: str,
    *,
    max_age_s: int = _RESUME_MAX_AGE_S,
    max_tool_calls: int = _RESUME_MAX_TOOL_CALLS,
    current_mode: str = "",
) -> list | None:
    """Load a resume checkpoint only if it is still fresh.

    Returns the in-flight message transcript (same as ``_load_turn_checkpoint``)
    when all three guards pass:
      * age  — checkpoint is younger than ``max_age_s`` seconds;
      * size — checkpoint contains at most ``max_tool_calls`` ToolMessages;
      * mode — checkpoint's saved mode matches ``current_mode`` (when both are
        non-empty).

    On any failure the checkpoint is cleared so the next turn starts clean.
    """
    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            tup = await saver.aget_tuple(_resume_checkpoint_config(thread_id))
    except Exception:  # noqa: BLE001 — best-effort: a missing/corrupt checkpoint just means "no resume"
        return None
    if tup is None:
        return None
    ckpt = tup.checkpoint or {}
    messages = ckpt.get("channel_values", {}).get("messages")

    # Age guard: a checkpoint older than the TTL is from a previous session /
    # previous model — resuming it would replay stale tool calls.
    ts = _parse_checkpoint_ts(ckpt.get("ts"))
    if ts is not None:
        age = datetime.now(timezone.utc).timestamp() - ts
        if age > max_age_s:
            logger.warning(
                "resume checkpoint is stale (age=%.0fs > %ds); dropping",
                age, max_age_s,
            )
            await _clear_turn_checkpoint(thread_id)
            return None

    # Size guard: a checkpoint with too many tool calls is almost certainly
    # from a stuck loop; resuming it would just keep looping.
    if isinstance(messages, list):
        tool_count = sum(1 for m in messages if isinstance(m, ToolMessage))
        if tool_count > max_tool_calls:
            logger.warning(
                "resume checkpoint has too many tool calls (%d > %d); dropping",
                tool_count, max_tool_calls,
            )
            await _clear_turn_checkpoint(thread_id)
            return None

    # Mode guard: a checkpoint from a different mode is NOT dropped anymore.
    # Dropping forced a full redo (re-running all greps/reads) whenever the
    # user switched modes mid-task. The turn now resumes the completed tool
    # work regardless of mode; build_turn_context already re-orients the model
    # with an explicit MODE / MODE SWITCHED note, so a stale style cannot leak.
    if current_mode:
        saved_mode = (ckpt.get("channel_values", {}) or {}).get("mode")
        if saved_mode and saved_mode != current_mode:
            logger.info(
                "resume checkpoint mode switch (saved=%s current=%s); resuming tool work",
                saved_mode, current_mode,
            )

    # پاک‌سازی دفاعی: چک‌پوینت‌های قدیمیِ (خرابِ) روی دیسک ممکن است
    # tool_callهای بی‌جواب داشته باشند؛ قبل از برگرداندن، placeholder
    # می‌گیرند تا provider ترنسکریپت را رد نکند.
    if isinstance(messages, list):
        messages = _sanitize_trailing_tool_calls(messages)
    return messages if isinstance(messages, list) else None


async def clear_chat_resume_checkpoint(chat_id: str) -> None:
    """Drop the resume checkpoint for a deleted chat so it doesn't orphan on disk."""
    with contextlib.suppress(Exception):
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            await saver.adelete_thread(_resume_thread_id({"chat_id": chat_id}))


_checkpoint_janitor_state: dict[str, float] = {}


async def _checkpoint_janitor() -> None:
    """Log resume-checkpoint DB size and VACUUM when bloated.

    The DB grows per chat thread and deleted threads leave free pages behind.
    A 50MB+ file slows every per-step save, so vacuum at most once per hour.
    Best-effort only; failures never break the turn.
    """
    try:
        now = time.monotonic()
        last = float(_checkpoint_janitor_state.get("last", 0.0))
        if now - last < 3600:
            return
        _checkpoint_janitor_state["last"] = now
        path = _resume_checkpoint_path()

        def _size_mb() -> float:
            try:
                return os.path.getsize(path) / (1024 * 1024)
            except OSError:
                return 0.0

        size = await asyncio.to_thread(_size_mb)
        if size <= 0:
            return
        logger.info("[ckpt-janitor] resume_db=%.1fMB path=%s", size, path)
        if size < 50:
            return

        def _vacuum() -> None:
            import sqlite3

            con = sqlite3.connect(path, timeout=10)
            try:
                con.execute("VACUUM")
                con.commit()
            finally:
                con.close()

        await asyncio.to_thread(_vacuum)
        new_size = await asyncio.to_thread(_size_mb)
        logger.warning(
            "[ckpt-janitor] vacuumed resume_db %.1fMB -> %.1fMB",
            size,
            new_size,
        )
    except Exception:  # noqa: BLE001, S110 — janitor never breaks the turn
        pass


async def prune_stale_resume_checkpoints(ttl_hours: int = 24) -> None:
    """Reclaim orphaned resume checkpoints.

    A resume checkpoint is transient: it only exists for an in-flight turn that
    was interrupted (error/cancel/disconnect) and may be resumed. A turn that
    finishes cleanly deletes its own thread (see ``_run_mode_turn``), so any
    thread left behind is from a failure/crash that was never retried. Pruning by
    age on startup drops that state. A genuinely in-flight turn always has a
    recent checkpoint timestamp, so it is never pruned.
    """
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    cutoff = datetime.now(timezone.utc).timestamp() - ttl_hours * 3600
    try:
        async with AsyncSqliteSaver.from_conn_string(
            _resume_checkpoint_path()
        ) as saver:
            await saver.setup()
            # Enumerate threads directly. We avoid ``alist()`` here: with
            # from_conn_string it intermittently sees the connection as already
            # closed (a known lifecycle quirk), whereas aget_tuple/adelete_thread
            # are reliable on this handle.
            tids: list[str] = []
            async with saver.conn.execute(
                "SELECT DISTINCT thread_id FROM checkpoints"
            ) as cur:
                async for row in cur:
                    tids.append(row[0])
            for tid in tids:
                try:
                    tup = await saver.aget_tuple(
                        {"configurable": {"thread_id": tid, "checkpoint_ns": ""}}
                    )
                except Exception:  # noqa: BLE001, S112
                    continue
                if tup is None:
                    continue
                ts = _parse_checkpoint_ts(
                    (tup.checkpoint or {}).get("ts") if tup.checkpoint else None
                )
                if ts is not None and ts < cutoff:
                    with contextlib.suppress(Exception):
                        await saver.adelete_thread(tid)
    except Exception:  # noqa: BLE001 — best-effort cleanup
        return


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class AgentState(TypedDict, total=False):
    # Routing / request
    mode: str
    request: str
    # Conversation + attachments
    history: list[dict]
    attachments: list[str]
    images: list[str]
    # Provider / model config (preserved verbatim from the UI request)
    provider: str
    # User-configured provider id (distinct from `provider` which is the kind).
    # Emitted back on usage events so the sidebar groups per-usage entries by
    # the exact id the user picked, not just by the shared kind.
    provider_id: str
    model_name: str
    base_url: str
    api_key: str
    env_var: str
    api_keys: list
    context_window: int
    thinking_level: str
    # Whether the selected model is reasoning-capable (from the /models
    # `reasoning` flag). Drives the lightweight composer glow signal.
    model_reasoning: bool
    system_prompt: str
    root: str
    chat_id: str
    # Capability / permission gating (from the UI)
    cap: dict
    permission_gates: dict
    ask_gates: dict
    allow_outside: bool
    allow_computer: bool
    # پوشه‌های خارج از ریشه که کاربر از UI برایشان «همیشه اجازه» داده —
    # کفِ permit["folders"] در هر rebuild ابزار دوباره تزریق می‌شود.
    allow_outside_folders: list[str]
    allow_create: bool
    skills: list[str]
    vector_db_path: str
    vector_config: dict
    retrieval_config: dict
    lsp_config: dict
    subagent_models: dict
    providers: dict
    reserved: int | None
    compact_at_percent: int | None
    # MCP connectors the user toggled on in the composer chip. Passed through
    # verbatim from the UI request; consumed by build_turn_context to attach
    # live MCP tools. MUST be declared on the state or LangGraph drops it
    # before the node runs (and the model would see no MCP tools).
    mcp_servers: dict
    # Workflow scratch state
    web_search_results: list
    fetched_content: list
    vision_results: list
    candidate_files: list[str]
    grep_results: list
    read_context: str
    plan: str
    build_result: str
    changed_files: list[str]
    review_result: str
    final_response: str
    # Explore (deterministic repo-discovery) scratch state
    search_spec: dict
    explore_glob: list[str]
    explore_grep: list[str]
    explore_tree: str
    explore_answer: str
    plan_attempts: int
    # Internal transport (NOT serialised by the graph runner; in-memory only)
    _queue: Any
    # Mutable flag shared between _run_mode_turn (detects a hard failure) and
    # run_graph._drive (decides whether to clear the durable resume file). MUST
    # be declared on the state or LangGraph drops it before the node runs.
    _run_flags: dict
    # Shared in-memory permit dict ({"outside", "computer"}) — survives build
    # node re-entry within a turn. Rebuilding tools with a fresh dict would
    # lose grants made via "Always allow" / an in-turn Allow-once, re-prompting
    # the user on every agent step.
    _permit: dict
    # Explicit user restart (message retry icon / truncate-and-restart). When
    # True the run MUST NOT resume from the interrupted-turn checkpoint — it
    # starts fresh and clears any stale checkpoint so the next resume does
    # not replay the discarded turn. Resume (banner Retry / watchdog /
    # reconnect) leaves this False so the checkpoint is reused.
    restart: bool
    # Persistent goal condition (/goal). Plain text; empty means no active goal.
    # MUST be declared or LangGraph drops it before nodes run (same rule
    # as mcp_servers / _run_flags above).
    goal: str
    # Bounded auto-continue bookkeeping for an unmet goal.
    goal_turns: int
    goal_continue: bool
    # Previous turn's mode + whether it differs (mode-switch re-orientation).
    # MUST be declared or LangGraph drops them before nodes run (same rule
    # as mcp_servers / _run_flags above).
    _prev_mode: str | None
    _mode_changed: bool


# ---------------------------------------------------------------------------
# Message-history conversion (frontend plain-text turns -> LangChain messages)
# ---------------------------------------------------------------------------


def history_to_langchain_messages(
    history: list[dict], current_mode: str | None = None
) -> list[BaseMessage]:
    """Convert plain ``{role, content}`` turns to LangChain messages.

    Assistant turns may carry a ``toolActivity`` array (the frontend sends it on
    every assistant message: tool name, args, ``callId``, and the completed
    result). We reconstruct those as real ``AIMessage(tool_calls=[...])`` +
    ``ToolMessage`` pairs so the model SEES what it already did and does NOT
    re-run the tool calls after a reconnect/interrupt -- the transcript alone
    (no synthetic "you already did X" injection) carries the prior work forward.

    The authoritative mode for THIS turn is declared by the system prompt (via
    ``_mode_declare``), so we deliberately do NOT inject any per-turn mode tag into
    the history here: a past-mode marker in the transcript only teaches the model
    to echo it back at the start of its reply (e.g. writing ``<!-- mode:ask -->``
    while the button says Plan). Mode re-orientation is handled entirely by the
    system prompt, not by history tagging.
    """
    out: list[BaseMessage] = []
    # شناسهٔ tool_callهای بازسازی‌شده باید در کل تاریخچه یکتا باشد: front-end
    # کارت‌ها را با callId عددی علامت می‌زند که بین چند نوبت تکرار می‌شود
    # (مثلاً «1»). دو ToolMessage با یک tool_call_id خطای provider
    # «Duplicate function_call_output for call_id» را می‌سازد.
    used_ids: set[str] = set()
    # Progress attaches ONLY to the latest plan-carrying turn: every historic
    # turn re-injecting its own full checklist multiplied tokens per message.
    _latest_plan_idx = -1
    for _i, _t in enumerate(history or []):
        if (
            isinstance(_t, dict)
            and _t.get("role") == "assistant"
            and isinstance(_t.get("plan"), list)
            and any(
                isinstance(_p, dict) and str(_p.get("content", "")).strip()
                for _p in _t.get("plan")
            )
        ):
            _latest_plan_idx = _i
    for _turn_idx, turn in enumerate(history or []):
        role = turn.get("role", "user")
        content = str(turn.get("content", ""))
        # Non-visible recap of completed tools from a previously interrupted
        # turn. Folded into the assistant content so the model sees what was
        # already done and skips re-executing — the UI never renders this
        # string (it lives on `preservedToolSummary` on the frontend message).
        preserved_summary = turn.get("preservedToolSummary") or ""
        # Checklist statuses live on the frontend message (`plan`) but were
        # never folded into the transcript — so the model could not tell done
        # from pending and re-executed finished steps. Append them to the
        # assistant content (same mechanism as preserved_summary).
        _plan_items = turn.get("plan") or []
        _plan_note = ""
        if (
            role == "assistant"
            and isinstance(_plan_items, list)
            and _plan_items
            and _turn_idx == _latest_plan_idx
        ):
            _plan_note = (
                "\n[Checklist progress "
                + _plan_progress_line(_plan_items)
                + " — do NOT re-execute completed steps.]"
            )
        tool_activity = turn.get("toolActivity") or []
        # Reconstruct assistant tool calls from the carried toolActivity so a
        # resumed turn continues instead of redoing completed work.
        if role == "assistant" and tool_activity:
            tool_calls: list[dict] = []
            tool_msgs: list[BaseMessage] = []
            for ta in tool_activity:
                if not isinstance(ta, dict):
                    continue
                base_id = str(ta.get("callId") or f"ta-{len(tool_calls)}")
                tc_id = base_id
                _dup_n = 2
                while tc_id in used_ids:
                    tc_id = f"{base_id}_dup{_dup_n}"
                    _dup_n += 1
                used_ids.add(tc_id)
                tool_calls.append(
                    {
                        "name": ta.get("tool", "tool"),
                        "args": ta.get("args", {}) or {},
                        "id": tc_id,
                    }
                )
                # Prefer the full tool result (items, or the `results` alias the
                # backend emits on tool_result events); fall back to the summary.
                # Either may be a plain string (e.g. "MATCHES for 'foo'") OR a
                # list of dicts — flatten either into readable text so the model
                # sees the real result and does NOT re-execute the tool on
                # reconnect (which would waste context).
                raw_items = ta.get("items")
                if raw_items is None:
                    raw_items = ta.get("results")
                if isinstance(raw_items, str):
                    result = raw_items
                elif isinstance(raw_items, list) and raw_items:
                    parts = []
                    for _it in raw_items:
                        if isinstance(_it, dict):
                            # Keep the identifying fields, not just the snippet
                            # text, so the model can act without re-running:
                            # grep -> file:line:text, glob -> path,
                            # web_search -> title (url): snippet,
                            # read/terminal/task -> path: content.
                            _path = _it.get("path") or _it.get("file") or ""
                            _line_no = _it.get("line")
                            _title = _it.get("title") or ""
                            _url = _it.get("url") or ""
                            _body = (
                                _it.get("snippet")
                                or _it.get("content")
                                or _it.get("text")
                                or _it.get("result")
                                or _it.get("output")
                                or ""
                            )
                            if _path and _line_no is not None and _body:
                                parts.append(f"{_path}:{_line_no}:{_body}")
                            elif _path and _body:
                                parts.append(f"{_path}: {_body}")
                            elif _path and not _body:
                                parts.append(str(_path))
                            elif _title and _url and _body:
                                parts.append(f"{_title} ({_url}): {_body}")
                            elif _title and _body:
                                parts.append(f"{_title}: {_body}")
                            elif _body:
                                parts.append(str(_body))
                            else:
                                parts.append(str(_it))
                        else:
                            parts.append(str(_it))
                    result = "\n".join(parts)
                else:
                    result = ta.get("summary") or ""
                # write_file/edit_file store the unified diff on the activity
                # (not in items) — carry it so the next turn sees what changed
                # without re-reading the file.
                _diff = ta.get("diff")
                if isinstance(_diff, str) and _diff.strip():
                    _diff_text = _diff.strip()
                    if len(_diff_text) > 8000:
                        _diff_text = _diff_text[:8000] + "\n...(diff truncated)"
                    if result:
                        result = f"{result}\nDiff:\n{_diff_text}"
                    else:
                        result = f"Diff:\n{_diff_text}"
                tool_msgs.append(ToolMessage(content=str(result), tool_call_id=tc_id))
            if tool_calls:
                _ai_content = content
                if preserved_summary:
                    _ai_content += preserved_summary
                if _plan_note:
                    _ai_content += _plan_note
                out.append(AIMessage(content=_ai_content, tool_calls=tool_calls))
                out.extend(tool_msgs)
                continue
        if not content and not preserved_summary and not _plan_note:
            continue
        # History system messages (compact summaries, mode-switch markers)
        # are injected as HumanMessage — never SystemMessage — so
        # system_final at position 0 stays clean.  This avoids
        # "System message must be at the beginning" on strict Jinja
        # templates (Qwen3.5 etc.) where a second SystemMessage
        # anywhere else in the list raises an exception.
        # The compact summary content is still visible to the model;
        # it just looks like a user note, which is consistent with how
        # reuse/discovery/tool-reuse notes are already injected
        # (see build_turn_context lines ~1677-1681).
        if role == "system":
            out.append(HumanMessage(content=content))
        elif role == "assistant":
            _ai_content = content
            if preserved_summary:
                _ai_content += preserved_summary
            if _plan_note:
                _ai_content += _plan_note
            out.append(AIMessage(content=_ai_content))
        else:
            out.append(HumanMessage(content=content))
    return out


# ---------------------------------------------------------------------------
# Mode routing
# ---------------------------------------------------------------------------
# The UI/toolbar mode is authoritative. We only honor an explicit slash command
# (/plan, /code, /ask, /reader) in the prompt — never infer the mode from
# keywords (that would override the user's explicit selection and make the agent
# think it's in Build while the user picked Plan). See ``router`` below.


# ---------------------------------------------------------------------------
# Per-mode tool filtering (faithful port of agents.py's data-driven gating)
# ---------------------------------------------------------------------------

def filter_tools_for_mode(
    mode: str,
    tools: dict[str, Callable],
    cap: dict | None,
    allow_create: bool,
    allow_outside: bool,
    prompt: str = "",
    root: str = "",
    allow_computer: bool = False,
    history: list | None = None,
) -> dict[str, Callable]:
    """Return the mode-appropriate subset of ``tools``.

    Mirrors the original agents.py gating exactly: capability-driven denying
    (readFiles/writeFiles/runTerminal/web), the build-only write restriction,
    plan-mode persistence (handled by the plan_build node, not a tool), ask-mode drops (read/memory/trivial-prompt schemas),
    ``allow_create`` gating of skill/MCP creation, and file-scope stripping.
    """
    cap = cap or {}
    _WEB = {"web_search", "fetch_url", "search_console"}
    has_cap = any(
        isinstance(cap.get(k), bool)
        for k in ("readFiles", "writeFiles", "runTerminal", "web")
    )
    if has_cap:
        _READ = {"grep", "glob", "read", "task", "read_document"}
        _WRITE = {
            "write_file",
            "edit_file",
            "confirm_action",
            "git_commit",
            "write_document",
        }
        _TERM = {"run_terminal"}
        denied: set[str] = set()
        if not cap.get("readFiles", False):
            denied |= _READ
        if not cap.get("writeFiles", False):
            denied |= _WRITE
        if not cap.get("runTerminal", False):
            denied |= _TERM
        tools = {n: fn for n, fn in tools.items() if n not in denied}
        if "run_terminal" in tools:
            tools["run_terminal"] = _agents._wrap_no_search_bypass(
                tools["run_terminal"]
            )
        if cap.get("runTerminal") and not cap.get("writeFiles"):
            tools["run_terminal"] = _agents._wrap_readonly_terminal(
                tools["run_terminal"]
            )
    else:
        if mode != "build":
            tools = {
                n: fn
                for n, fn in tools.items()
                if n
                not in (
                    "write_file",
                    "edit_file",
                    "run_terminal",
                    "confirm_action",
                    "git_commit",
                    "write_document",
                )
            }
        if "run_terminal" in tools:
            tools["run_terminal"] = _agents._wrap_no_search_bypass(
                tools["run_terminal"]
            )

    # Web tools (web_search / fetch_url / search_console) are exposed to the
    # model whenever the web capability is not explicitly denied. The agent may
    # use them on its own initiative when it judges a web lookup is needed. They
    # are only stripped when ``cap["web"]`` is explicitly ``False`` (e.g. a
    # capability map that denies web access). When no capability map is supplied
    # (the common case), web tools stay available.
    if cap.get("web", True) is False:
        tools = {n: fn for n, fn in tools.items() if n not in _WEB}

    # Repo search tools (grep/glob/read/task) are now available to the Main
    # Agent for every mode that needs repo access (build/plan/ask/reader). The
    # LLM decides iteratively which to call — there is NO mandatory
    # glob->grep->read order (this matches OpenCode). Write/terminal tools stay
    # build-only (handled in the blocks above); non-build modes therefore keep
    # only read/search/web/vision capabilities. The background sub-agent reuses
    # the same tool runtime in an isolated context.
    if mode == "ask" and _agents._trivial_prompt(prompt):
        for n in (
            "update_plan",
            "ask_user",
            "request_permission",
        ):
            tools.pop(n, None)
    if not allow_create:
        tools = {
            n: fn for n, fn in tools.items() if n not in ("create_skill", "create_mcp")
        }
    # The `computer` tool (~2k tokens of schema) is only bound when the user
    # explicitly enabled desktop control (allow_computer — the Settings →
    # Tools "Computer use" toggle, persisted like an MCP connector). It is a
    # hard switch, not a hint: when OFF the tool never reaches the model —
    # no prompt-intent auto-binding, no schema tokens —
    # so the agent cannot touch the desktop at all. When ON, per-action
    # runtime permission prompting still applies until "Always allow".
    if "computer" in tools and not allow_computer:
        tools = {n: fn for n, fn in tools.items() if n != "computer"}
    # LSP tools are available in every mode with repo access
        # (build/plan/ask/reader): precise jump helps answering and planning
    # too, not just editing. Write/terminal tools stay build-only (handled
    # above), so LSP remains read-only outside build mode.

    # Full workspace access: every file inside the workspace is readable
    # without any scope gate. Only outside-workspace access needs permission
    # (handled by the permission gates in tools.py).
    # Stable toolset order across turns (prompt-cache friendly): dict insertion
    # order varies with mode-filter/scope paths, which would rewrite the tool
    # schema prefix every turn and force full-price reprocessing. Build in
    # particular must keep the same toolset across turns, so sort by name to
    # keep the bound schema prefix byte-identical (same set, deterministic order).
    tools = dict(sorted(tools.items(), key=lambda kv: kv[0]))
    # Record the PARENT's actual (mode-filtered) toolset so a sub-agent spawned
    # via `task` inherits exactly these tools — not the full registry. This is
    # what closes the read-only bypass: a plan-mode `task` call can no
    # longer hand the sub-agent write tools. tools.py reads this contextvar in
    # _run_subagent_task and falls back to the full registry only when it is
    # unset (which should never happen now).
    _PARENT_TOOLS_CTX.set(tools)
    return tools


def merge_mcp_tools(
    filtered: dict, mcp_tools: list, cap: dict | None
) -> bool:
    """Merge live MCP tools into the mode-filtered tool set.

    Returns True when a browser MCP (Playwright) toolset is live. Both
    ``web_search`` and browser tools stay available — the model picks per
    need (fast lookup via web_search, explicit open-site requests or
    JS-heavy pages via the browser). When ``cap`` denies web access,
    browser MCP tools are dropped instead (they are web access too).
    """
    cap = cap or {}
    browser_live = any(is_browser_mcp_tool(getattr(t, "name", "")) for t in mcp_tools)
    if cap.get("web", True) is False:
        mcp_tools = [
            t for t in mcp_tools if not is_browser_mcp_tool(getattr(t, "name", ""))
        ]
    for t in mcp_tools:
        filtered[t.name] = t
    return browser_live


def _mcp_server_of(t: Any) -> str:
    """نام سرور MCP پشتیبان یک ابزار — از metadata، یا از نام qualified.

    ابزارها معمولاً با نام کوتاه bind می‌شوند (``browser_navigate``) و سرور
    را در ``metadata["mcp_server"]`` حمل می‌کنند؛ نام qualified
    (``mcp__<server>__<tool>``) فقط fallback برخورد است. نام کوتاه بدون
    metadata سرورِ ناشناخته است (نه IndexError).
    """
    meta = getattr(t, "metadata", None) or {}
    if meta.get("mcp_server"):
        return str(meta["mcp_server"])
    parts = getattr(t, "name", "").split("__", 2)
    if len(parts) == 3 and parts[0] == "mcp":
        return parts[1]
    return ""


def _mcp_tools_note(mcp_tools: list, browser_live: bool) -> str:
    """Per-turn note telling the model which MCP connectors are live.

    When a browser MCP (Playwright) is connected the note adds a selection
    guide: both web_search and browser tools stay available and the model
    picks per need.
    """
    servers = sorted({s for s in (_mcp_server_of(t) for t in mcp_tools) if s})
    note = (
        "=== MCP CONNECTORS (live this turn) ===\n"
        f"Connected: {', '.join(servers)}. Their tools are bound under their SHORT "
        "names (e.g. browser_navigate, container_list) and callable now; only a "
        "name collision falls back to mcp__<server>__<tool>."
    )
    if browser_live:
        note += (
            "\nWEB RESEARCH GUIDE: both the built-in web_search and the browser "
            "MCP (Playwright) are available — pick per need. Use web_search ONLY for "
            "fast fact lookup. When the user asks (in any language) to open/show/visit a site "
            "(e.g. 'open digikala'), you MUST call "
            "browser_navigate — never answer an open-site request with web_search "
            "alone. Use the browser also when the page needs JS rendering/interaction "
            "(browser_snapshot / browser_evaluate to read, browser_click / "
            "browser_type / browser_fill_form to interact). "
            "fetch_url stays available for pulling a KNOWN url as markdown."
        )
    return note


def _tool_def_chars(t: Any) -> int:
    """Characters of one bound tool definition (name + description + args schema)."""
    total = len(str(getattr(t, "name", "") or ""))
    total += len(str(getattr(t, "description", "") or ""))
    try:
        schema = getattr(t, "args_schema", None)
        if schema is not None:
            try:
                js = schema.model_json_schema() if hasattr(schema, "model_json_schema") else {}
            except Exception:  # noqa: BLE001 — schema dump never breaks the turn
                js = {}
            total += len(json.dumps(js, ensure_ascii=False, default=str))
            return total
    except Exception:  # noqa: BLE001, S110 — fall back to plain args dict
        pass
    args = getattr(t, "args", None)
    if not isinstance(args, dict):
        args = {}
    total += len(json.dumps(args, ensure_ascii=False, default=str))
    return total


def mcp_schema_chars(tools: list | None) -> int:
    """Characters of the bound MCP tool definitions (name + description + args
    JSON schema).

    This is the MCP footprint the provider counts as tool definitions —
    separate from the connector config JSON the frontend can already see.
    """
    return sum(_tool_def_chars(t) for t in (tools or []))


def ctx_parts_event(
    mode: str,
    system_final: str,
    skill_section: str,
    tools: list | None,
    chat_id: str = "",
) -> dict:
    """Frontend-facing report of the real per-turn context part sizes.

    ``systemChars`` excludes the skills section (reported separately in
    ``skillsChars``) so the popover rows never double-count it.
    ``systemToolsChars`` is the measured native tool-schema footprint and
    ``mcpChars`` the MCP one — the frontend must show these instead of
    attributing the whole unexplained gap to System tools.
    """
    system = str(system_final or "")
    section = str(skill_section or "")
    all_tools = list(tools or [])
    mcp = [t for t in all_tools if _mcp_server_of(t)]
    native = [t for t in all_tools if not _mcp_server_of(t)]
    return {
        "kind": "ctx_parts",
        "chat_id": str(chat_id or ""),
        "mode": str(mode or ""),
        "systemChars": max(0, len(system) - len(section)),
        "skillsChars": len(section),
        "mcpChars": sum(_tool_def_chars(t) for t in mcp),
        "systemToolsChars": sum(_tool_def_chars(t) for t in native),
    }





def _mcp_note_for_turn(mcp_tools: list, browser_live: bool, chat_id: str) -> str:
    """Full MCP note on first sight / server change, one-line reminder after.

    The connector list + naming rules rarely change mid-chat, so resending
    the full block every turn is pure input-token overhead. The selection
    guide (web_search vs browser tools) IS repeated in the short form —
    dropping it would risk the model always reaching for one tool when the
    other fits better. Per-chat signature cache; any server-set change
    re-sends the full note.
    """
    servers = sorted({s for s in (_mcp_server_of(t) for t in mcp_tools) if s})
    sig = ",".join(servers) + ("|browser" if browser_live else "")
    cache = getattr(_mcp_note_for_turn, "_last_sig", None)
    if not isinstance(cache, dict):
        cache = {}
        _mcp_note_for_turn._last_sig = cache  # type: ignore[attr-defined]
    if sig and cache.get(chat_id) == sig:
        short = f"MCP connectors live: {', '.join(servers)} (tools callable under short names)."
        if browser_live:
            short += " Use web_search ONLY for fast lookup; when the user asks to open/show/visit a site you MUST call browser_navigate, never web_search alone."
        return short
    if len(cache) > 500:
        cache.clear()
    cache[chat_id] = sig
    return _mcp_tools_note(mcp_tools, browser_live)


# ---------------------------------------------------------------------------
# Sub-agent model resolution (web / compact / vision) -> LangChain models
# ---------------------------------------------------------------------------


def resolve_subagent_model(
    provider: str,
    entry: Any,
    base_url: str,
    api_key: str,
    env_var: str,
    parent_model_name: str = "",
    default_to_parent: bool = True,
    provider_lookup: Any = None,
    timeout: float | None = None,
    parent_provider_id: str = "",
    parent_api_keys: Any = None,
    thinking_level: str = "",
    model_reasoning: bool = False,
) -> Any:
    """Resolve a single sub-agent slot entry to a LangChain model.

    Cross-provider routing is delegated to ``agents._subagent_target`` so a
    ``"providerId/model"`` entry runs on THAT provider's own base URL / key —
    not silently dumped onto the parent (main) provider. This is the fix for
    the bug where a configured vision/web/compact model was ignored and the
    main model was used instead.

    * ``""`` / whitespace / ``None`` -> the parent model when
      ``default_to_parent`` is ``True`` (web / compact slots), otherwise
      ``None`` (vision slot, which has no parent default).
    * ``"main model"`` / ``"main_model"`` / ``"main"`` -> the parent model.
    * ``"provider/model"`` -> that provider's config + model (real routing).
    * bare model id -> the parent provider.
    """
    if entry is None:
        return (
            build_chat_model(
                provider,
                parent_model_name,
                base_url,
                api_key,
                env_var,
                parent_api_keys,
                temperature=0.2,
                timeout=timeout,
                cache=True,
                provider_id=parent_provider_id,
                thinking_level=thinking_level,
                model_reasoning=model_reasoning,
            )
            if (default_to_parent and parent_model_name)
            else None
        )
    if isinstance(entry, str):
        entry = entry.strip()
        if not entry:
            return (
                build_chat_model(
                    provider,
                    parent_model_name,
                    base_url,
                    api_key,
                    env_var,
                    parent_api_keys,
                    temperature=0.2,
                    timeout=timeout,
                    cache=True,
                    provider_id=parent_provider_id,
                    thinking_level=thinking_level,
                    model_reasoning=model_reasoning,
                )
                if (default_to_parent and parent_model_name)
                else None
            )
        if entry.lower() in ("main model", "main_model", "main"):
            entry = parent_model_name or entry
    target = _agents._subagent_target(
        entry,
        provider,
        base_url,
        api_key,
        env_var,
        provider_lookup or (lambda pid: None),
        parent_provider_id,
        parent_api_keys,
    )
    if not target:
        return None
    kind, model, burl, akey, env, spid, akeys = target
    if not model:
        return None
    return build_chat_model(
        kind,
        model,
        burl,
        akey,
        env,
        akeys,
        temperature=0.2,
        timeout=timeout,
        cache=True,
        provider_id=spid,
        thinking_level=thinking_level,
        model_reasoning=model_reasoning,
    )


async def _vision_analyze(
    model: Any, image_uris: list[str], chat_id: str = ""
) -> str | None:
    """One-shot vision analysis of attached images using ``model`` (the
    configured vision model). Returns the analysis text, or ``None`` on any
    failure. The caller injects the result into the main model's context so it
    can "see" the image without having to call a vision tool.

    Uses the vision model directly — there is deliberately NO fallback to the
    main model (a configured vision model is the contract; if it fails the
    caller surfaces that).

    Transient provider errors (rate-limit / 5xx / timeout / network blip) are
    retried with backoff so a single flaky request doesn't silently drop the
    image. Every failure is logged so the drop is diagnosable instead of silent.
    """
    from llm import llm_generate

    system = (
        "You are a vision analysis sub-agent. The user attached image(s) to their "
        "message. Examine them carefully and transcribe what you see VERBATIM and "
        "completely, because this analysis is the main agent's ONLY view of the "
        "image. Priorities, in order:\n"
        "1. TRANSCRIBE ALL visible text exactly as written — especially file paths, "
        "filenames, code, terminal output, error messages, stack traces, URLs, "
        "numbers, and UI labels. Do not paraphrase or summarize text; quote it.\n"
        "2. Describe layout, structure and UI elements (buttons, panels, lists,\n"
        "   tables) and any colors/icons that carry meaning.\n"
        "3. If the image is a UI mockup or design reference, note the visual style.\n"
        "Be literal and exhaustive. Keep prose tight but never drop visible text."
    )
    user = (
        "Analyze the attached image(s). Transcribe every piece of on-screen text "
        "verbatim (file paths, code, errors), then describe layout/UI."
    )
    model_name = getattr(model, "model_name", "") or "unknown"
    # Filter corrupt data URLs ONCE before any provider call (not per-attempt):
    # a truncated image would otherwise be resent on every retry, burning all
    # attempts on a request the provider can never accept (400 invalid base64).
    try:
        image_uris = [
            u for u in
            (_agents._sanitize_image_data_url(x) for x in (image_uris or []))
            if u
        ]
    except Exception:  # noqa: BLE001
        image_uris = list(image_uris or [])
    if not image_uris:
        return None
    # Retry ONLY transient provider failures (429 / 5xx / timeout / network
    # blip) so a single flaky vision request doesn't silently make the image
    # invisible. Permanent errors (e.g. 400 image-rejected) are NOT retried —
    # they surface immediately so the caller can tell the user to fix config.
    _start = time.monotonic()
    for attempt in range(_VISION_MAX_ATTEMPTS):
        # Stop early if we've burned the whole wall-clock budget — don't start
        # another (expensive) attempt that would blow past the 90s cap.
        if time.monotonic() - _start >= _VISION_TOTAL_BUDGET:
            logger.warning(
                "vision analyze (%s) hit the %ds total budget after %d attempt(s)",
                model_name,
                int(_VISION_TOTAL_BUDGET),
                attempt,
            )
            break
        try:
            text, _ = await llm_generate(
                model,
                system=system,
                user=user,
                images=image_uris,
                sub=True,
                chat_id=str(chat_id or ""),
            )
            result = (text or "").strip()
            if result:
                return result
            # Empty/whitespace-only reply is not transient — don't retry, but
            # log it so a misbehaving vision model is visible.
            logger.warning(
                "vision analyze (%s) returned empty text on attempt %d/%d",
                model_name,
                attempt + 1,
                _VISION_MAX_ATTEMPTS,
            )
            return None
        except Exception as exc:  # noqa: BLE001
            if not _is_transient_error(exc):
                logger.warning(
                    "vision analyze (%s) failed with a non-transient error: %s",
                    model_name,
                    exc,
                )
                return None
            if attempt < _VISION_MAX_ATTEMPTS - 1:
                _elapsed = time.monotonic() - _start
                _remaining = _VISION_TOTAL_BUDGET - _elapsed
                if _remaining <= 0:
                    logger.warning(
                        "vision analyze (%s) exhausted the %ds budget before retry",
                        model_name,
                        int(_VISION_TOTAL_BUDGET),
                    )
                    break
                delay = min(_VISION_BACKOFF_BASE * (2**attempt), _remaining)
                logger.warning(
                    "vision analyze (%s) failed (attempt %d/%d): %s — retrying in %.1fs",
                    model_name,
                    attempt + 1,
                    _VISION_MAX_ATTEMPTS,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)
            else:
                logger.warning(
                    "vision analyze (%s) failed after %d attempts: %s",
                    model_name,
                    _VISION_MAX_ATTEMPTS,
                    exc,
                )
    return None


def _is_transient_error(exc: Exception) -> bool:
    """Return True for retryable provider errors (400 / 429 / 5xx / timeout / network).

    400 is treated as transient because some upstream gateways (e.g. minimax-m3:free
    on OpenRouter) return 400 for transient conditions that resolve on retry.
    Other 4xx errors are NOT transient — retrying them just wastes time and hides
    a real config problem."""
    msg = str(exc).lower()
    # Gateway/proxy hiccup without a usable status code (e.g. OpenRouter
    # "upstream connection lost") is transient even when the wrapper carries
    # a non-retryable status — the connection itself dropped, not the request.
    if "upstream" in msg or "connection lost" in msg:
        return True
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    if status is not None:
        return status in (400, 429) or 500 <= status < 600
    # No status code -> treat as a network/timeout blip (retryable).
    return any(
        k in msg
        for k in ("timeout", "timed out", "connection", "reset", "eof", "broken pipe")
    )


# Per-process cache of vision analyses, keyed by the sorted set of image URIs,
# so an image attached earlier in a conversation is analyzed ONCE and reused on
# every follow-up turn instead of being re-sent to the vision model each turn.
_VISION_CACHE: dict[str, str] = {}
_VISION_CACHE_MAX = 40

# Transient-failure resilience for the server-side vision analysis: a single
# flaky provider request (429 / 5xx / timeout / network blip) must not silently
# drop the attached image. Retry with exponential backoff, capped.
_VISION_MAX_ATTEMPTS = 3
_VISION_BACKOFF_BASE = 1.0
# Hard wall-clock cap on the ENTIRE vision analysis (all attempts + backoff).
# Prevents a slow/unreachable vision provider from locking the turn for minutes
# (3 attempts × 30s timeout + backoff ≈ 90s worst case).
_VISION_TOTAL_BUDGET = 90.0


async def _vision_analyze_cached(
    model: Any, image_uris: list[str], chat_id: str = ""
) -> str | None:
    if not image_uris:
        return None
    import hashlib

    key = hashlib.sha256("|".join(sorted(image_uris)).encode("utf-8")).hexdigest()
    cached = _VISION_CACHE.get(key)
    if cached is not None:
        return cached
    result = await _vision_analyze(model, image_uris, chat_id)
    if result:
        _VISION_CACHE[key] = result
        if len(_VISION_CACHE) > _VISION_CACHE_MAX:
            # Evict the oldest entry (insertion order preserved in dicts).
            _VISION_CACHE.pop(next(iter(_VISION_CACHE)))
    return result


# Code/file token pattern: an English identifier, path or filename means the
# turn plausibly needs code tools/symbols. Used by ``_obvious_non_code_turn``
# to fast-skip the symbol map on obvious chit-chat. Skill selection does NOT
# key on it: the decision router matches by meaning, so short non-English
# task prompts are covered without any hard-coded keyword list.
_TASK_SIGNAL_RE = r"[A-Za-z_][A-Za-z0-9_]{2,}|[\w\-.]+/[\w\-.]+|[\w\-.]+\.\w{1,5}"


def _obvious_non_code_turn(prompt: str, history: list) -> bool:
    """Pure predicate: chit-chat turn that cannot need the symbol map.

    Short prompt, no code/file tokens in it, and history (if any) with no
    tool activity and no code tokens. The caller skips the map entirely.
    Anything doubtful returns False (fail-open: the map as before).
    """
    try:
        p = (prompt or "").strip()
        if not p or len(p) >= 32:
            return False
        if re.search(_TASK_SIGNAL_RE, p):
            return False
        for turn in history or []:
            if not isinstance(turn, dict):
                continue
            if turn.get("toolActivity") or turn.get("plan"):
                return False
            c = turn.get("content") or ""
            if isinstance(c, str) and re.search(r"[A-Za-z_][A-Za-z0-9_]{2,}", c):
                return False
        return True
    except Exception:  # noqa: BLE001 — doubt sends the map
        return False


_SKILL_CATALOG_LINE_MAX = 200
_SKILL_CATALOG_MAX_CHARS = 1800
_SKILL_CATALOG_MAX_SKILLS = 30
_SKILL_CATALOG_COMPACT_LINE_MAX = 80
_SKILL_CATALOG_COMPACT_MAX_CHARS = 600
_SKILL_CATALOG_COMPACT_MAX_SKILLS = 12


def _clip_skill_desc(text: str, limit: int) -> str:
    """Return ``text`` unchanged.

    Skill descriptions are part of the system prompt and must never be
    truncated. ``limit`` is retained for backward compatibility."""
    return text


def _fit_skill_catalog_lines(
    skills: list[dict],
    header: str,
    total_max: int,
    desc_max: int,
    max_skills: int,
) -> list[str]:
    """One ``- name: description`` line per skill, never truncated.

    Every skill keeps a full line: skill entries are part of the system
    prompt and must never be cut. Budget args are retained for backward
    compatibility and no longer cap the output.
    """
    lines: list[str] = []
    for s in skills:
        name = str(s.get("name") or "").strip()
        if not name:
            continue
        desc = str(s.get("description") or "").strip()
        lines.append(f"- {name}: {desc}" if desc else f"- {name}")
    return lines


def _skill_extra_files_map() -> dict:
    """Map skill name/slug (casefolded) to its extra file list, best-effort."""
    try:
        rows = state_db.list_skills()
    except Exception:  # noqa: BLE001
        return {}
    out: dict = {}
    for r in rows or []:
        files = [str(f or "").strip() for f in (r.get("files") or []) if str(f or "").strip()]
        for key in (str(r.get("name") or ""), str(r.get("slug") or "")):
            if key.strip():
                out[key.strip().casefold()] = files
    return out


def _skill_generic_norm(text: str) -> str:
    """Normalize text for data-driven skill matching (no hardcoded map)."""
    return (
        str(text or "")
        .lower()
        .replace("\u200c", " ")
        .replace("ي", "ی")
        .replace("ك", "ک")
    )


_SKILL_ROUTE_SYSTEM = (
    "You route a coding-agent request to reusable skills. You get a SKILLS list "
    "(name: description) and a REQUEST, often Persian and often vague. Match by "
    "MEANING and intent, never literal words: a vague non-English complaint about "
    "an ugly UI fits a design/redesign skill; condensing long content fits a "
    "summarization skill. Reply with ONLY a JSON array of at most 2 exact skill "
    "names whose description fits what the request needs, for example "
    "[\"summarization\"], or [] when no skill fits. Plain bug fixes, refactors, "
    "debugging and questions about code fit no skill. No prose, no markdown."
)
_SKILL_ROUTE_CACHE: dict[str, list[str]] = {}
_SKILL_ROUTE_CACHE_MAX = 64
_SKILL_ROUTE_TIMEOUT = 12.0  # seconds; a slow router must never stall the turn
_SKILL_ROUTE_MIN_CHARS = 3  # short vague requests still route; chit-chat skips
_SKILL_ROUTE_FAIL_LIMIT = 3  # consecutive failures before the router pauses
_SKILL_ROUTE_PAUSE_SECS = 120.0  # retry soon: a paused router disables auto-load
_SKILL_ROUTE_CATALOG_MAX_CHARS = 6000  # tiny local decision models have small windows
_skill_route_state: dict[str, float] = {"fails": 0, "paused_until": 0.0}

#: Sentinel router_model marking the downloaded on-device Laya router.
#: It is a plain string (never a LangChain model) so _route_skills can
#: branch to the local path without touching any provider.
_LAYA_LOCAL_MODEL: Any = "laya-local"


def _is_laya_decision(entry: Any) -> bool:
    """True when the decision slot picks the downloaded local Laya model."""
    try:
        from laya_router import is_laya_entry
    except Exception:  # noqa: BLE001 — fail-open, use the parent model
        return isinstance(entry, str) and entry.strip().lower() == "laya"
    return is_laya_entry(entry)


def _parse_skill_route(raw: str, rows: list[dict], max_n: int) -> list[str] | None:
    """Known skill names from the router reply; None when it has no JSON array."""
    by: dict[str, str] = {}
    for s in rows:
        name = str(s.get("name") or "").strip()
        for key in (name, str(s.get("slug") or "").strip()):
            if key:
                by.setdefault(key.casefold(), name)
    m = re.search(r"\[[^\[\]]*\]", str(raw or ""), re.DOTALL)
    if not m:
        # Tolerant fallback: the main model often answers in prose
        # (Persian explanation + skill name) instead of a JSON array.
        # Match known skill names as substrings so the turn still loads.
        text_fold = str(raw or "").casefold()
        found: list[str] = []
        for key_fold, name in by.items():
            if key_fold and key_fold in text_fold and name not in found:
                found.append(name)
                if len(found) >= max_n:
                    break
        return found if found else None
    try:
        items = json.loads(m.group(0))
    except ValueError:
        items = re.findall(r'"([^"]+)"', m.group(0))
    out: list[str] = []
    for it in items if isinstance(items, list) else []:
        name = by.get(str(it).strip().casefold())
        if name and name not in out:
            out.append(name)
    return out[:max_n]


async def _route_skills(
    prompt: str,
    skills: list[dict],
    model: Any,
    chat_id: str = "",
    emit: Callable[[dict], None] | None = None,
) -> list[str] | None:
    """Ask the decision model which skills this request needs (semantic match).

    The decision slot picks the router: the downloaded on-device Laya model
    or an external model (empty slot = the main model). An embedding
    prefilter first narrows any store size to the top candidates so the
    router always sees the most relevant slice. Returns skill names (``[]``
    = none needed) or ``None`` when routing is unavailable — no model,
    timeout, bad reply, or paused after repeated failures — so the caller
    inlines nothing (no keyword fallback).
    """
    text = (prompt or "").strip()
    rows = [s for s in skills or [] if str(s.get("name") or "").strip()]
    try:
        from skill_prefilter import prefilter_skills as _prefilter_skills

        rows = _prefilter_skills(text, rows)
    except Exception as exc:  # noqa: BLE001 — prefilter is best-effort
        logger.debug("[skills] prefilter failed: %s", exc)
    try:
        max_n = int(getattr(_agents, "_SKILL_AUTO_MAX", 2))
    except Exception:  # noqa: BLE001
        max_n = 2
    if model is None or not rows or max_n <= 0 or len(text) < _SKILL_ROUTE_MIN_CHARS:
        return None
    with contextlib.suppress(Exception):
        if _agents._SKILL_META_RE.search(_skill_generic_norm(text)):
            return []  # a request about making/editing skills loads none
    now = time.monotonic()
    if _skill_route_state["paused_until"] > now:
        return None
    lines = []
    for s in rows:
        desc = str(s.get("description") or "").strip()[:140]
        kws = ", ".join(str(k) for k in (s.get("fa_keywords") or [])[:3])
        lines.append(f"- {s['name']}: {desc}" + (f" (also: {kws})" if kws else ""))
    catalog = "\n".join(lines)
    # Tiny local decision models (a few hundred M params) have small context
    # windows; an oversized catalog would fail EVERY routing call, pause the
    # router and silently disable auto-load again. Cut at a line boundary.
    if len(catalog) > _SKILL_ROUTE_CATALOG_MAX_CHARS:
        catalog = catalog[:_SKILL_ROUTE_CATALOG_MAX_CHARS].rsplit("\n", 1)[0]
    key = hashlib.md5((catalog + "\n" + text[:1500]).encode("utf-8")).hexdigest()
    if key in _SKILL_ROUTE_CACHE:
        return list(_SKILL_ROUTE_CACHE[key])

    def _fail(reason: object) -> None:
        _skill_route_state["fails"] += 1
        if _skill_route_state["fails"] >= _SKILL_ROUTE_FAIL_LIMIT:
            _skill_route_state["fails"] = 0
            _skill_route_state["paused_until"] = now + _SKILL_ROUTE_PAUSE_SECS
            logger.warning(
                "[skills] router paused %ds after repeated failures: %s",
                int(_SKILL_ROUTE_PAUSE_SECS),
                reason,
            )

    # Local Laya path: the decision slot picked the downloaded on-device
    # router. No provider call, no usage event (local models are free) —
    # only a trace entry. Unavailability returns None so the caller inlines
    # nothing (no keyword fallback). The shared result cache above already
    # ran, so cache hits never reach this branch. ``rows`` are the
    # prefiltered top candidates, not raw store order.
    if isinstance(model, str) and model == _LAYA_LOCAL_MODEL:
        try:
            from laya_router import predict as _laya_predict

            _laya_names = await asyncio.wait_for(
                asyncio.to_thread(
                    _laya_predict, text, rows, str(chat_id or "")
                ),
                timeout=_SKILL_ROUTE_TIMEOUT,
            )
        except Exception as exc:  # noqa: BLE001 — routing never breaks
            _fail(exc)
            return None
        if _laya_names is None:
            _fail("laya unavailable")
            # Surface the miss in Trace: the local path emits no usage and
            # no catalog, so without this entry an unavailable snapshot looks
            # like the router never ran at all.
            try:
                import trace_store as _decision_trace

                _decision_trace.append(
                    str(chat_id or ""),
                    "llm",
                    "decision · laya unavailable",
                    detail={"sub": True},
                    model="laya-local",
                    prompt=text[:1500],
                    error="laya snapshot missing or failed to load",
                )
            except Exception:  # noqa: BLE001, S110 — trace never breaks routing
                pass
            return None
        _skill_route_state["fails"] = 0
        _SKILL_ROUTE_CACHE[key] = list(_laya_names)
        if len(_SKILL_ROUTE_CACHE) > _SKILL_ROUTE_CACHE_MAX:
            _SKILL_ROUTE_CACHE.pop(next(iter(_SKILL_ROUTE_CACHE)))
        return list(_laya_names)
    try:
        raw, _usage = await asyncio.wait_for(
            llm_generate(
                model,
                system=_SKILL_ROUTE_SYSTEM,
                user=f"SKILLS:\n{catalog}\n\nREQUEST:\n{text[:1500]}",
                sub=True,
                chat_id=str(chat_id or ""),
            ),
            timeout=_SKILL_ROUTE_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001 — routing never breaks the turn
        _fail(exc)
        return None
    # Forward the decision-call usage so Model Usage accrues it like any
    # other sub-call. Local decision models never go through llm_generate,
    # so they emit nothing here by construction.
    if _usage is not None and emit is not None:
        try:
            emit(_usage)
        except Exception:  # noqa: BLE001, S110 — usage never breaks routing
            pass
    names = _parse_skill_route(raw, rows, max_n)
    if names is None:
        _fail("unparseable reply")
        return None
    try:
        import trace_store as _decision_trace

        _decision_trace.append(
            str(chat_id or ""),
            "llm",
            f"decision · {', '.join(names) or '-'}",
            detail={"sub": True},
            model=str(getattr(model, "model_name", "") or "decision")[:80],
            prompt=text[:1500],
            result=", ".join(names),
        )
    except Exception:  # noqa: BLE001, S110 — trace never breaks routing
        pass
    _skill_route_state["fails"] = 0
    _SKILL_ROUTE_CACHE[key] = list(names)
    if len(_SKILL_ROUTE_CACHE) > _SKILL_ROUTE_CACHE_MAX:
        _SKILL_ROUTE_CACHE.pop(next(iter(_SKILL_ROUTE_CACHE)))
    return names


def _format_skill_body(s: dict) -> str:
    """One inlined skill (shared by @mentioned and auto-matched skills)."""
    files = [str(f or "").strip() for f in (s.get("files") or []) if str(f or "").strip()]
    extra = f"\nExtra files: {', '.join(files)} — call load_skill with file=<name> only when needed." if files else ""
    return (
        f"===== SKILL: {s['name']} =====\nDescription: {s['description'] or ''}"
        f"{extra}"
        f"\n\n{s['content']}\n===== END SKILL: {s['name']} ====="
    )


def _build_skills_section(
    picked_names: list[str],
    root: str,
    emit: Callable[[dict], None] | None = None,
    prompt: str = "",
    auto_names: list[str] | None = None,
) -> str:
    """Assemble the SKILLS section for ``build_turn_context``.

    Only what the decision router picked (``auto_names``) and what the user
    explicitly attached (``picked_names``) is inlined — full bodies, exactly
    like an @mention. There is NO ``AVAILABLE SKILLS`` catalog in the
    main-model prompt and NO keyword fallback: the router (external decision
    model or local Laya over prefiltered candidates) is the only automatic
    selector, so its output needs no second guess. Anything else is loaded
    on demand via the ``load_skill`` tool (one tool call instead of a
    prompt-sized body). No picks at all adds zero tokens.

    When a picked name matches no stored skill (deleted/renamed since the
    mention was made) a ``skill`` event with a ``note`` is emitted via
    ``emit`` so the user learns why the skill silently did not apply —
    previously this case was indistinguishable from a turn with no mentions
    at all.

    This is intentionally independent of ``_skill_names_to_strip``: stripping a
    skill's *name* out of the search-keyword derivation must never prevent its
    *body* from being inlined here — the skill is still fully used.
    """
    manual_names = list(dict.fromkeys(
        n.strip().casefold() for n in picked_names if n and n.strip()
    ))
    # Load the DB only when something needs it: a router pick or a manual
    # pick. (No picks = zero skill tokens AND zero DB reads.)
    if not manual_names and not auto_names:
        return ""
    all_skills = _agents._load_skills(root)
    if all_skills:
        try:
            _files_map = _skill_extra_files_map()
        except Exception:  # noqa: BLE001
            _files_map = {}
        if _files_map:
            for _s in all_skills:
                if not _s.get("files"):
                    _hit = _files_map.get(str(_s.get("name") or "").strip().casefold())
                    if _hit is None:
                        _hit = _files_map.get(str(_s.get("slug") or "").strip().casefold(), [])
                    _s["files"] = list(_hit or [])
    out = ""
    auto: list[dict] = []
    via = "-"
    if prompt and auto_names:
            _by: dict[str, dict] = {}
            for _s in all_skills:
                for _k in (_s.get("name"), _s.get("slug")):
                    if _k:
                        _by.setdefault(str(_k).strip().casefold(), _s)
            for _n in auto_names:
                _s = _by.get(str(_n).strip().casefold())
                if (
                    _s is not None
                    and str(_s.get("name") or "").strip().casefold() not in manual_names
                    and _s not in auto
                ):
                    auto.append(_s)
            via = "router"
        # No keyword fallback: when the router returns nothing, nothing is
        # inlined. The router is the only automatic selector.
    if prompt and all_skills:
        logger.info(
            "[skills] store=%d auto=%s via=%s",
            len(all_skills),
            ", ".join(s["name"] for s in auto) or "-",
            via if auto else "-",
        )
    if auto:
        if emit is not None:
            emit({
                "kind": "skill",
                "skills": [s["name"] for s in auto],
                "manual": False,
            })
        out += (
            "\n\n=== AUTO-MATCHED SKILLS ===\n"
            "These skills match the user's request and are ALREADY "
            "LOADED below — follow their instructions for this task "
            "and do NOT call load_skill for them. When a skill lists "
            "Extra files, the main body is enough unless the task needs "
            "a listed file — then call load_skill with file=<name> for "
            "that specific file only (saves tokens).\n"
            + "\n\n".join(_format_skill_body(s) for s in auto)
        )
    if not manual_names:
        return out
    if not all_skills:
        if emit is not None:
            emit({
                "kind": "skill",
                "skills": [],
                "manual": True,
                "note": (
                    "Attached skills not found — they may have been deleted or "
                    f"renamed: {', '.join(manual_names)}. The turn runs without them."
                ),
            })
        return out
    by_name = {s["name"].casefold(): s for s in all_skills}
    picked: list[dict] = []
    missing: list[str] = []
    for n in manual_names:
        skill = by_name.get(n)
        if skill is not None and skill not in picked:
            picked.append(skill)
        elif skill is None:
            missing.append(n)
    if not picked:
        if emit is not None:
            emit({
                "kind": "skill",
                "skills": [],
                "manual": True,
                "note": (
                    "Attached skills not found — they may have been deleted or "
                    f"renamed: {', '.join(missing)}. The turn runs without them."
                ),
            })
        return out
    if missing and emit is not None:
        emit({
            "kind": "skill",
            "skills": [s["name"] for s in picked],
            "manual": True,
            "note": (
                "Attached skills not found — they may have been deleted or "
                f"renamed: {', '.join(missing)}. The turn runs without them."
            ),
        })
    bodies = "\n\n".join(_format_skill_body(s) for s in picked)
    return out + "\n\n=== ATTACHED SKILLS ===\n" + bodies


def skills_catalog_block(max_chars: int = 1800) -> str:
    """Compact ``AVAILABLE SKILLS`` catalog for a sub-agent's first message.

    The main agent gets the catalog in its system prompt; a sub-agent runs
    on the registry prompt only, so without this it cannot see (and cannot
    ``load_skill``) any user skill. Returns "" when no skills exist — zero
    tokens for the common no-skills case. The names+descriptions order is
    the store's.

    Every skill keeps a full line: the catalog is part of the system prompt
    and must never be truncated. ``max_chars`` is retained for backward
    compatibility and no longer caps the output.
    """
    try:
        all_skills = _agents._load_skills("")
    except Exception:  # noqa: BLE001 — catalog is best-effort
        return ""
    if not all_skills:
        return ""
    header = (
        "\n\n=== AVAILABLE SKILLS ===\n"
        "Skills are reusable instruction bundles. When the task "
        "matches a description below, call the load_skill tool "
        "with that skill's name FIRST and follow its instructions; "
        "when nothing matches, load none.\n"
    )
    lines = _fit_skill_catalog_lines(
        all_skills, header, max_chars, _SKILL_CATALOG_LINE_MAX, len(all_skills)
    )
    if not lines:
        return ""
    return header + "\n".join(lines) + "\n"


def _slice_history_by_turns(history: list, n: int) -> list:
    """برش history به «n رفت‌وبرگشت اخیر» بر اساس مرز پیام user.

    یک turn = یک entry با ``role == "user"`` (به‌همراه هر entry غیر user که بعد
    از آن و قبل از user بعدی آمده، مثل system entryهای mode-switch). از آخر
    آرایه به عقب n پیام user می‌شماریم و slice از اولین آن‌ها به بعد
    برمی‌گردانیم. اگر تعداد user کمتر از n باشد، کل history برگردانده می‌شود
    (caller این حالت را با مقایسهٔ ``len(_recent) == len(history)`` تشخیص می‌دهد
    و در آن صورت اصلاً trim نمی‌کند).

    این helper تضمین می‌کند:
    - n واقعاً «n رفت‌وبرگشت» می‌شود (نه ≈n/2 با شمارش entryهای flat).
    - slice همیشه با یک ``user`` شروع می‌شود و هیچ‌وقت وسط یک جفت
      user/assistant نمی‌افتد.
    - system entryهای بین آخرین nامین user و انتهای آرایه (مثل mode-switch
      notice بعد از آخرین reply) به‌عنوان بخشی از همان turn نگه داشته می‌شوند
      و از سهم n کم نمی‌شوند.
    """
    if n <= 0 or not history:
        return list(history)
    for i in range(len(history) - 1, -1, -1):
        entry = history[i]
        if isinstance(entry, dict) and entry.get("role") == "user":
            n -= 1
            if n == 0:
                return history[i:]
    # تعداد user کمتر از n درخواستی → همهٔ history نگه داشته می‌شود.
    return list(history)


def _truncate_old_tool_results(messages: list, keep_steps: int = 3, max_chars: int = 1000) -> int:
    """Truncate old tool results so turn-start context stays bounded.

    Keeps the last ``keep_steps`` assistant tool-call steps verbatim and
    replaces older tool contents longer than ``max_chars`` with a short
    placeholder that keeps the tool name and args, so a re-issue is a
    single targeted call instead of a blind re-search. Results the recent
    conversation still refers to are never truncated. Returns the number
    of messages truncated. Never raises.
    """
    try:
        step_ids: list[set[str]] = []
        call_meta: dict[str, tuple[str, dict]] = {}
        for _m in messages or []:
            _tcs = getattr(_m, "tool_calls", None)
            if _tcs:
                _ids = set()
                for tc in _tcs:
                    if isinstance(tc, dict) and tc.get("id"):
                        _ids.add(tc.get("id"))
                        call_meta[tc.get("id")] = (str(tc.get("name") or "tool"), tc.get("args") or {})
                if _ids:
                    step_ids.append(_ids)
        keep: set[str] = set()
        for _ids in step_ids[-keep_steps:]:
            keep |= _ids
        recent_refs: set[str] = set()
        try:
            recent_non_tool = [m for m in messages if getattr(m, "type", "") != "tool"][-3:]
            for _m in recent_non_tool:
                _rc = str(getattr(_m, "content", "") or "")
                if len(_rc) > 8_000:
                    _rc = _rc[:4_000] + "\n…\n" + _rc[-4_000:]
                for _tok in re.findall(r"[\w\-.]+/[\w\-.]+|[\w\-.]+\.\w{1,5}", _rc):
                    _t = _tok.strip("./-")
                    if len(_t) >= 4:
                        recent_refs.add(_t)
                for _tok in re.findall(r"[a-z]+(?:_[a-z0-9]+)+", _rc):
                    if len(_tok) >= 4:
                        recent_refs.add(_tok)
                for _tok in re.findall(r"[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+", _rc):
                    if len(_tok) >= 4:
                        recent_refs.add(_tok)
                if len(recent_refs) > 200:
                    break
        except Exception:  # noqa: BLE001 — exemption is best-effort
            recent_refs = set()
        count = 0
        _total_msgs = len(messages or [])
        # Even kept/referenced results are capped so the last steps cannot
        # blow up turn-start context (continuation-turn inflation: several
        # 60k verbatim results = ~60k tokens on step 1).
        _keep_cap = 8000
        for _mi, _m in enumerate(messages or []):
            if getattr(_m, "type", "") != "tool":
                continue
            _tid = getattr(_m, "tool_call_id", "")
            _c = getattr(_m, "content", "") or ""
            if not isinstance(_c, str):
                continue
            if _c.startswith("[truncated ") and _c.endswith("re-issue if still needed]"):
                continue
            _is_keep = _tid in keep
            _is_exempt = (
                not _is_keep
                and _total_msgs - _mi <= 40
                and bool(recent_refs)
                and any(_ref in _c for _ref in recent_refs)
            )
            if _is_keep or _is_exempt:
                if len(_c) > _keep_cap:
                    try:
                        _m.content = (
                            _c[:_keep_cap]
                            + "\n[truncated for turn-start — re-read with offset/limit if needed]"
                        )
                    except Exception:  # noqa: BLE001, S112 — one bad message never blocks
                        continue
                    count += 1
                continue
            if len(_c) <= max_chars:
                continue
            # Age rule: results older than ~40 messages always truncate even
            # when referenced — the placeholder keeps name/args so re-issue
            # is cheap. Without this a common token (e.g. a filename still
            # mentioned in chat) keeps EVERY old result verbatim and the
            # turn-start context never shrinks (continuation-turn inflation).
            _name, _args = call_meta.get(_tid, (getattr(_m, "name", "") or "tool", {}))
            try:
                _arg_str = json.dumps(_args, ensure_ascii=False, sort_keys=True)[:160]
            except Exception:  # noqa: BLE001 — placeholder must never fail
                _arg_str = str(_args)[:160]
            _ph = f"[truncated {_name}({_arg_str}) ({len(_c)} chars) — re-issue if still needed]"
            if len(_c) <= len(_ph) + 20:
                continue
            try:
                _m.content = _ph
            except Exception:  # noqa: BLE001, S112 — one bad message never blocks
                continue
            count += 1
        return count
    except Exception:  # noqa: BLE001 — truncation never breaks the turn
        return 0


def _today_stamp() -> str:
    """Turn-local date stamp for the user turn.

    Answers "today / recent / latest" questions with zero tool round-trips
    (the most common avoidable ``current_time`` call). Lives in the USER turn,
    not the system prompt, so the static prefix cache stays hit; computed per
    turn so a multi-day session keeps the date accurate.
    """
    return (
        "[Context] Today's date: "
        + datetime.now().astimezone().strftime("%A, %Y-%m-%d")
        + "."
    )


async def build_turn_context(state: AgentState, queue: asyncio.Queue) -> dict:
    """Assemble everything one mode-turn needs: system prompt, history messages,
    the mode-filtered tool set, and the LangChain chat model.

    Reuses the SAME helpers ``run_agent`` used so prompts / RAG / skills stay
    equivalent to the previous behaviour.
    """
    import os
    import time as _tctx_time

    _tctx_marks: dict[str, float] = {}
    _tctx_t0 = _tctx_time.monotonic()

    def _tctx_mark(name: str) -> None:
        try:
            _tctx_marks[name] = _tctx_time.monotonic() - _tctx_t0
        except Exception:  # noqa: BLE001, S110 — timing never breaks the turn
            pass

    def _tctx_status(stage: str, content: str) -> None:
        try:
            queue.put_nowait({"kind": "status", "stage": stage, "content": content})
        except Exception:  # noqa: BLE001, S110 — progress never breaks the turn
            pass

    root = state["root"]
    mode = state["mode"]
    prompt = (state.get("request") or "").strip()
    chat_id = state.get("chat_id", "")
    try:
        from lsp_manager import configure_lsp as _configure_lsp
        _configure_lsp(state.get("lsp_config") or {})
    except Exception:  # noqa: BLE001, S110 — lsp config never breaks the turn
        pass
    cap = state.get("cap") or {}
    allow_create = bool(state.get("allow_create"))
    allow_outside = bool(state.get("allow_outside"))
    attachments = state.get("attachments")
    images = state.get("images")
    skills = state.get("skills")
    system_extra = (state.get("system_prompt") or "").strip()

    # Fire-and-forget LSP warmup: start servers for the files this turn is
    # about (paths mentioned in the prompt) in
    # background daemon threads. The cold-start handshake then overlaps with
    # the FIRST LLM round-trip instead of blocking the first lsp_* tool call
    # and adding its full startup latency to the turn's wall time.
    try:
        from lsp_manager import get_manager as _get_lsp_mgr_turn

        _warm_paths = _PATH_TOKEN_RE.findall(str(prompt or ""))
        _warm_abs = [
            p if os.path.isabs(p) else os.path.join(root, p)
            for p in _warm_paths
            if str(p or "").strip()
        ]
        if _warm_abs:
            _get_lsp_mgr_turn(root).warmup(_warm_abs)
    except Exception:  # noqa: BLE001, S110 - warmup never breaks the turn
        pass

    # Gather images from the CURRENT turn AND every earlier message in the
    # conversation that carried an image. History is converted to text only
    # (history_to_langchain_messages drops image content), so without this the
    # model would "forget" an attached image on the very next turn and claim it
    # can't see anything. Re-analyzing historical images keeps the image context
    # alive across follow-up turns.
    _img_items: list = list(images or [])
    for _turn in state.get("history") or []:
        if isinstance(_turn, dict):
            _ti = _turn.get("images")
            if _ti:
                _img_items.extend(_ti)
    image_uris = _agents._load_images(_img_items)
    # Deduplicate by content so the same image isn't analyzed repeatedly within
    # a single turn (current + historical copies). Cross-turn de-duplication is
    # handled by the vision cache below.
    _seen: set[str] = set()
    _deduped: list[str] = []
    for _u in image_uris:
        if _u and _u not in _seen:
            _seen.add(_u)
            _deduped.append(_u)
    image_uris = _deduped

    # Context window (resolve live when the UI did not supply one).
    # Bounded so a slow catalog/provider never parks Preparing context for
    # tens of seconds; on timeout ctx stays 0 (full prompt, safe fallback).
    ctx = int(state.get("context_window") or 0)
    if ctx <= 0:
        try:
            from providers import model_context

            ctx = await asyncio.wait_for(
                model_context(
                    state["provider"],
                    state["model_name"],
                    state["base_url"],
                    state["api_key"],
                    state["env_var"],
                    state.get("api_keys"),
                ),
                timeout=10.0,
            )
        except Exception:  # noqa: BLE001 — includes the 10s timeout above
            ctx = 0
    ctx = max(0, ctx)
    # Small-context mode: when the model's window is below the threshold we
    # switch to a token-frugal prompt assembly (half-size RAG, no skill
    # descriptions, tighter project-memory cap, tighter tool-output trim).
    # Models with ctx >= threshold (or unknown ctx=0) keep the full prompt.
    small_ctx = _agents.is_small_context(ctx)

    cap = state.get("cap")
    # All sub-agents (search / web / subagent / vision / compact distills) and
    # the PARENT LLM loop run on LangChain models built from ``build_chat_model``.
    subagent_models = state.get("subagent_models") or {}
    # Cross-provider routing: a "providerId/model" sub-agent entry must run on
    # that provider's OWN base URL / key. The frontend sends the full provider
    # configs (keyed by id) so we can look them up here.
    _providers = state.get("providers") or {}
    _provider_lookup = lambda pid: (
        _providers.get(pid) if isinstance(_providers, dict) else None
    )
    _parent_thinking = str(state.get("thinking_level", "") or "")
    _parent_reasoning = bool(state.get("model_reasoning", False))
    web_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("web"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["model_name"],
        provider_lookup=_provider_lookup,
        parent_provider_id=state.get("provider_id", ""),
        parent_api_keys=state.get("api_keys"),
        thinking_level=_parent_thinking,
        model_reasoning=_parent_reasoning,
    )
    compact_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("compact"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["model_name"],
        provider_lookup=_provider_lookup,
        # Bounded so an auto-compact summarizer fails fast (and is skipped)
        # instead of hanging the turn when the provider is slow/unreachable.
        timeout=50,
        parent_provider_id=state.get("provider_id", ""),
        parent_api_keys=state.get("api_keys"),
        thinking_level=_parent_thinking,
        model_reasoning=_parent_reasoning,
    )
    # Skill routing is a tiny classification call on the dedicated "decision"
    # slot (Settings -> Tools), falling back to the main model when unset.
    # It is a SEPARATE sub-call (sub=True): the main model's prompt and token
    # usage stay exactly the same. Thinking/reasoning tokens only make it
    # blow the routing timeout — after a few timeouts the router pauses and
    # auto-matched skills silently stop loading — so the router always runs
    # on a plain non-thinking variant of the resolved slot.
    _decision_entry = subagent_models.get("decision")
    if _is_laya_decision(
        _decision_entry if isinstance(_decision_entry, str) else ""
    ):
        # Downloaded on-device Laya router: no provider call, no usage.
        router_model = _LAYA_LOCAL_MODEL
    else:
        router_model = resolve_subagent_model(
            state["provider"],
            _decision_entry,
            state["base_url"],
            state["api_key"],
            state["env_var"],
            state["model_name"],
            provider_lookup=_provider_lookup,
            # Slightly above _SKILL_ROUTE_TIMEOUT so the outer wait_for
            # stays the binding bound; routing never stalls the turn.
            timeout=_SKILL_ROUTE_TIMEOUT + 8.0,
            parent_provider_id=state.get("provider_id", ""),
            parent_api_keys=state.get("api_keys"),
            thinking_level="",
            model_reasoning=False,
        )
    vision_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("vision"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["model_name"],
        default_to_parent=False,
        provider_lookup=_provider_lookup,
        # Bounded so a slow/unreachable vision provider fails fast (and is
        # surfaced to the user) instead of hanging the turn. The retry/backoff
        # in _vision_analyze covers transient blips within this budget.
        timeout=30,
        parent_provider_id=state.get("provider_id", ""),
        parent_api_keys=state.get("api_keys"),
        thinking_level=_parent_thinking,
        model_reasoning=_parent_reasoning,
    )
    explore_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("subagent", subagent_models.get("explore")),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["model_name"],
        default_to_parent=True,
        provider_lookup=_provider_lookup,
        parent_provider_id=state.get("provider_id", ""),
        parent_api_keys=state.get("api_keys"),
        thinking_level=_parent_thinking,
        model_reasoning=_parent_reasoning,
    )
    settings = await chat_model_settings(
        mode,
        ctx,
        state.get("thinking_level", ""),
        state["provider"],
        state["model_name"],
        state["base_url"],
        state["api_key"],
        state["env_var"],
        _agents._detect_scope(prompt),
        api_keys=state.get("api_keys"),
    )
    model = build_chat_model(
        state["provider"],
        state["model_name"],
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state.get("api_keys"),
        temperature=settings["temperature"],
        max_tokens=settings["max_tokens"],
        thinking_level=settings["thinking_level"],
        model_reasoning=state.get("model_reasoning", False),
        timeout=model_timeout_for(state),
        cache=settings.get("cache", False),
        session_id=str(state.get("chat_id") or ""),
        provider_id=state.get("provider_id", ""),
    )

    tools = make_tool_callbacks(
        root,
        lambda ev: queue.put_nowait(ev),
        context_window=ctx,
        web_model=web_model,
        main_model=model,
        vision_model=vision_model,
        explore_model=explore_model,
        image_uris=image_uris,
        reserved=state.get("reserved"),
        permission_gates=state.get("permission_gates"),
        ask_gates=state.get("ask_gates"),
        permit=_shared_permit(state, allow_outside),
        chat_id=chat_id,
        history=state.get("history") or [],
    )

    filtered = filter_tools_for_mode(
        mode,
        tools,
        cap,
        allow_create,
        allow_outside,
        prompt=prompt,
        root=root,
        allow_computer=bool(state.get("allow_computer")),
        history=state.get("history"),
    )

    # --- MCP bridge -------------------------------------------------------
    # Previously the runtime never opened a connection to the configured MCP
    # servers, so their tools (e.g. the Docker MCP connector) were unreachable
    # and the frontend only injected a no-op text note. We now connect for real
    # and merge the live tools into the same `filtered` dict the tool loop
    # reads, plus expose a cleanup coroutine so the caller can close the
    # sessions when the turn ends.
    async def _analyze_mcp_images(
        image_uris: list[str], qualified: str = ""
    ) -> str | None:
        """Vision fallback for MCP results that carry images (e.g. a playwright
        ``browser_take_screenshot``). The configured vision model is this app's
        contract for images — the main model never receives them directly — so
        the analysis text is the main model's ONLY view of the screenshot.
        Returns None when no vision model is configured; the bridge then
        annotates the tool result instead of silently dropping the image.
        Cached like attachments so an unchanged screenshot is analyzed once."""
        if vision_model is None or not image_uris:
            return None
        return await _vision_analyze_cached(
            vision_model, image_uris, str(chat_id or "")
        )

    # Start independent prefetches early so their wall time overlaps the MCP
    # connect below instead of adding up sequentially. Same models and prompts
    # (routing quality unchanged) — only the overlap changes.
    _skill_task = None
    if prompt:
        try:
            _skill_task = asyncio.create_task(
                _route_skills(
                    prompt,
                    _agents._load_skills(root),
                    router_model,
                    chat_id=str(chat_id or ""),
                    emit=lambda ev: queue.put_nowait(ev),
                )
            )
        except Exception:  # noqa: BLE001 — routing never breaks the turn
            _skill_task = None
    _vision_task = None
    try:
        _prefetch_early = vision_model or model
        if image_uris and _prefetch_early:
            _vision_task = asyncio.create_task(
                asyncio.wait_for(
                    _vision_analyze_cached(
                        _prefetch_early, image_uris, chat_id
                    ),
                    timeout=15.0,
                )
            )
    except Exception:  # noqa: BLE001 — vision prefetch never breaks the turn
        _vision_task = None

    mcp_tools: list = []
    mcp_cleanup = None
    _mcp_servers = state.get("mcp_servers") or {}
    if _mcp_servers:
        # Native tool names are reserved: an MCP tool whose short name
        # collides with one of them falls back to its fully qualified
        # mcp__<server>__<tool> binding (see _make_tool).
        # Bounded so a slow MCP server never parks Preparing context for
        # tens of seconds; on timeout the turn proceeds without MCP tools.
        try:
            mcp_tools, mcp_cleanup = await asyncio.wait_for(
                build_mcp_tools(
                    _mcp_servers,
                    lambda ev: queue.put_nowait(ev),
                    reserved_names=set(filtered),
                    analyze_images=_analyze_mcp_images,
                    # The turn prompt feeds snapshot compaction: browser snapshots
                    # keep the lines relevant to what was actually asked.
                    task=str(prompt or ""),
                    chat_id=str(chat_id or ""),
                ),
                timeout=8.0,
            )
        except asyncio.TimeoutError:
            logger.warning("[turn-ctx] mcp connect timed out after 8s, continuing without MCP tools")
            mcp_tools, mcp_cleanup = [], None
        except Exception:  # noqa: BLE001 — MCP must never break the turn
            mcp_tools, mcp_cleanup = [], None
    browser_mcp_live = merge_mcp_tools(filtered, mcp_tools, cap)
    _tctx_mark("mcp")
    # Whether the `vision` tool survived mode filtering (e.g. build mode
    # strips it). When it is NOT available we must fall back to attaching the
    # image directly to the main model, otherwise the model could never see it.
    vision_tool_available = "vision" in filtered

    workspace_note = (
        "\n\nYou are running in the user's desktop IDE. The current open WORKSPACE "
        f"ROOT is:\n{root}\nUse paths RELATIVE to this folder (e.g. 'src/main.py'), "
        "never absolute paths. You operate ONLY inside this workspace. NEVER read, "
        "search or act on anything outside it. Skills, plans and MCP connectors are "
        "given to you inline."
    )
    if mode in ("build", "plan", "ask"):
        workspace_note += _targeted_search_note(mode)
    # Attached files are shown as a focus note; the agent reads them on demand
    # via the read/grep tools instead of force-reading their full contents
    # into the prompt.
    if attachments:
        _att_disp: list[str] = []
        try:
            # allow_coder: uploaded files imported from outside the workspace
            # live under the app data root (uploads/) — readable without a
            # permission prompt, like any other read under the data root.
            _base = _agents.resolve_safe(root, "")
            for a in (attachments or []):
                if not a:
                    continue
                _t = _agents.resolve_safe(root, a, allow_coder=True)
                if not os.path.isfile(_t):
                    continue
                _r = os.path.relpath(_t, _base)
                # Imported uploads sit OUTSIDE the workspace; a `../../`-relative
                # form is ambiguous for the model, so show the absolute path —
                # the read tools resolve both forms.
                _att_disp.append(_t if _r.startswith("..") else _r)
        except Exception:  # noqa: BLE001
            _att_disp = []
        if _att_disp:
            workspace_note += (
                "\n\n=== ATTACHED FILES ===\nThe user attached these file(s) as their "
                "focus: "
                + ", ".join("`" + f + "`" for f in _att_disp)
                + ". Focus on them — read them with the read tool when relevant. "
                "PDF / Word (.docx) / Excel (.xlsx) attachments must be read with the "
                "read_document tool (the plain read tool cannot decode them); use "
                "write_document in Build mode to create or edit such documents."
            )
    base_prompt = (
        _agents.SYSTEM_PROMPTS.get(mode, _agents.SYSTEM_PROMPTS["ask"])
        + _agents._UNIVERSAL_RULES
        + _agents._DOING_TASKS
        + (_agents._LENGTH_RULE if mode in ("plan", "build") else "")
        + (_agents._TEST_DIR_RULE if mode in ("plan", "build") else "")
        + (_agents._TEST_STYLE_RULE if mode in ("plan", "build") else "")
    )
    # Language directive depends on the CURRENT prompt (Persian/English
    # detection), so it must NOT live in the system prompt — otherwise the cache
    # prefix breaks every turn and prefix caching never hits. It is injected into
    # the user turn instead (see user_parts below). Same for the per-turn RAG
    # block.
    lang_directive = _agents._language_directive(prompt)
    system_final = (
        _agents._mode_declare(mode)
        + _agents._SEARCH_RULE
        + base_prompt
        + workspace_note
    )
    system_final += (
        "\n\nRULES (strict, always follow, in every mode):\n"
        "1. CLARIFY: when the request is ambiguous, call ask_user FIRST.\n"
        "2. CONTEXT-FIRST: before any file tool, check what is ALREADY "
        "in your context (RAG blocks, conversation, files you already read)."
    )
    if system_extra:
        system_final += (
            "\n\nUser-supplied custom prompt (append to the above):\n" + system_extra
        )
    if image_uris:
        system_final += (
            "\n\nIMAGE ATTACHED: the user included image(s) in this conversation "
            "(this turn or an earlier one). A verbatim ATTACHED IMAGE ANALYSIS block "
            "is included in your message — treat it as ground truth. Transcribe any "
            "visible file paths / filenames / code / text EXACTLY as analyzed; never "
            "invent or omit what the image shows."
        )
    if mode in ("ask", "plan", "build"):
        system_final += _agents._DISCOVERY_BLOCK
    if mode == "reader":
        system_final += (
            "\n\nFOCUSED READING: the user pointed you at specific file(s) (attached "
            "or @mentioned). Read them with the "
            "read tool (and grep/read within them as needed) to answer. The search "
            "tools are available, but stay focused on the pointed-at files unless the "
            "user asks to broaden. vision / skills / MCP connectors are available on "
            "demand when the question needs external info or attached images."
        )

    try:
        project_memory = _agents._load_project_memory(
            root,
            max_bytes=(
                _agents._SMALL_CTX_PROJECT_MEMORY_MAX
                if small_ctx
                else _agents._PROJECT_MEMORY_MAX_BYTES
            ),
        )
    except Exception:  # noqa: BLE001
        project_memory = ""
    if project_memory:
        system_final += project_memory

    # Skills: only the decision router's picks plus @mentioned bodies are
    # inlined in full — no AVAILABLE SKILLS catalog, no keyword fallback.
    # The model loads anything else on demand via load_skill.
    _routed: list[str] | None = None
    if _skill_task is not None:
        try:
            # Started early so the routing round-trip overlapped the MCP
            # connect above; same model and prompt, quality unchanged.
            _routed = await _skill_task
        except Exception:  # noqa: BLE001 — routing never breaks the turn
            _routed = None
    elif prompt:
        try:
            _routed = await _route_skills(
                prompt,
                _agents._load_skills(root),
                router_model,
                chat_id=str(chat_id or ""),
                emit=lambda ev: queue.put_nowait(ev),
            )
        except Exception:  # noqa: BLE001 — routing never breaks the turn
            _routed = None
    _skill_section = _build_skills_section(
        skills or [],
        root,
        emit=lambda ev: queue.put_nowait(ev),
        prompt=prompt,
        auto_names=_routed,
    )
    system_final += _skill_section

    if chat_id and mode in ("plan", "build"):
        try:
            saved = _agents._load_saved_plan(root, chat_id=chat_id, prompt=prompt)
        except Exception:  # noqa: BLE001
            saved = ""
        if saved:
            system_final += saved
    # Persistent goal (/goal): same pattern as plan persistence — append the
    # active goal block so every mode works toward the completion condition.
    try:
        from goals import format_goal_block as _format_goal_block
        from goals import normalize_goal as _normalize_goal

        _goal_text = _normalize_goal(state.get("goal"))
        if not _goal_text:
            # Fallback: the frontend prefixes the prompt with
            # "[Active goal: <condition>]" so the goal survives
            # even when the runner was called without a goal kwarg.
            import re as _re_goal2

            _pm = _re_goal2.match(r"\s*\[Active goal:\s*(.*?)\]\s*", str(state.get("prompt") or ""))
            if _pm:
                _goal_text = _normalize_goal(_pm.group(1))
        if _goal_text:
            system_final += "\n\n" + _format_goal_block(_goal_text)
    except Exception:  # noqa: BLE001, S110 — goal injection never breaks the turn
        pass

    # No code-map injection: build uses on-demand LSP tools (opencode-style lazy manager).

    # No pre-injected workspace scout: discovery is the agent's job now (it has
    # glob/grep/read and the Explore sub-agent), matching the OpenCode-style
    # design where nothing is force-read into the prompt before the model runs.
    # opencode sends the FULL history every turn and compacts on overflow — it
    # never trims history by a char/token budget before sending (that caused
    # messages to disappear every turn and mode switches to shrink context).
    # The backend's auto-compact (_maybe_auto_compact) still fires on real
    # overflow, so large windows are handled without silently dropping turns.
    history = state.get("history") or []
    # historyLimit (General setting): 0 = full history (default, unchanged
    # behaviour); N > 0 = send only the last N turns verbatim + a compact
    # summary of the older turns. The summary is prefixed with
    # "[Compacted earlier context]" so the auto-compactor (_maybe_auto_compact
    # -> _compact_history) MERGES it on a later overflow instead of
    # re-expanding it — keeping historyLimit and auto-compact compatible.
    _history_limit = 0
    with contextlib.suppress(Exception):
        _history_limit = int(
            (state_db.get_settings() or {}).get("historyLimit", 0) or 0
        )
    if _history_limit > 0 and len(history) > _history_limit:
        # بر اساس «N رفت‌وبرگشت» که UI در SettingsModal تب General وعده داده، نه
        # شمارش entry خام. هر turn = یک پیام user (+ هر entry غیر user که بعد
        # از آن و قبل از user بعدی آمده، مثل mode-switch system entry). slice
        # باید از Nامین پیام user از آخر شروع بشود تا (الف) برش وسط یک جفت
        # user/assistant نیفتد، و (ب) تعداد entryهای نگه‌داشته‌شده واقعاً متناسب
        # با N باشد نه ≈N/2.
        _recent = _slice_history_by_turns(history, _history_limit)
        if len(_recent) == len(history):
            # تعداد user واقعی کمتر از N درخواستی → همهٔ history نگه داشته می‌شود
            # (همان رفتار حالت «no trim»).
            lc_history = history_to_langchain_messages(history, current_mode=mode)
        else:
            _older = history[: len(history) - len(_recent)]
            _summary = await _summarize_history_head(
                compact_model, _older, root, chat_id
            )
            lc_history = history_to_langchain_messages(_recent, current_mode=mode)
            lc_history.insert(0, HumanMessage(content=_summary))
    else:
        lc_history = history_to_langchain_messages(history, current_mode=mode)
    # Bound turn-start context even right after a manual /compact: the mid-turn
    # cheap truncation only runs later, so without this the first step re-sends
    # the full history at full price.
    with contextlib.suppress(Exception):
        _truncate_old_tool_results(lc_history)
    # Small-context: tighter cap on tool outputs in the history transcript.
    # Anything over the cap gets a marker so the model knows it was trimmed
    # and can re-read with offset/limit if it needs the rest.
    if small_ctx:
        _tool_cap = _agents._SMALL_CTX_TOOL_OUTPUT_MAX
        for _m in lc_history:
            if getattr(_m, "type", "") == "tool":
                _c = getattr(_m, "content", "") or ""
                if isinstance(_c, str) and len(_c) > _tool_cap:
                    _m.content = (
                        _c[:_tool_cap]
                        + "\n[truncated for small-context model — re-read with offset/limit if needed]"
                    )
    with contextlib.suppress(Exception):
        _hist_chars = sum(len(str(getattr(m, "content", ""))) for m in lc_history)
        _tool_items_chars = 0
        for _h in history:
            for _ta in _h.get("toolActivity") or []:
                _its = _ta.get("items")
                if isinstance(_its, list):
                    for _it in _its:
                        if isinstance(_it, dict):
                            _tool_items_chars += len(str(_it.get("snippet", "")))
                        else:
                            _tool_items_chars += len(str(_it))
        # print(
        #     f"[CTX_DEBUG] history_msgs={len(history)} lc_msgs={len(lc_history)} "
        #     f"est_tokens={_hist_chars // 4} tool_items_chars={_tool_items_chars}",
        #     flush=True,
        # )

    # Turn continuity: pin previous-turn outcome evidence NEXT TO the new user
    # message (transcript tail) so a short confirmation like "done?" reports
    # from it instead of re-running. Tail, not head: the note text changes
    # every turn, and a position-0 entry would shift the whole transcript and
    # break the provider's prompt-cache prefix on every turn start. The tail
    # placement survives historyLimit slicing/summarization the same way
    # (they drop the oldest entries, never the newest).
    try:
        import trace_store as _ts

        _prev = _ts.previous_turn_outcome(chat_id)
        _note = _ts.format_turn_outcome_note(_prev)
        if _note and not any(
            _note[:40] in str(getattr(m, "content", "")) for m in lc_history
        ):
            lc_history.append(HumanMessage(content=_note))
    except Exception:  # noqa: BLE001, S110 — continuity note must never break the turn
        pass
    _is_status_check = _agents._is_status_check(prompt)
    if mode == "build" and not _is_status_check:
        reuse = _agents._plan_reuse_note(history, prompt)
        if reuse:
            lc_history.append(HumanMessage(content=reuse))
        disc = _agents._plan_discovery_note(history)
        if disc:
            lc_history.append(HumanMessage(content=disc))
        # Live user-like testing takes precedence over code-test verification:
        # when the user asks for a live test, the agent must launch the app
        # and behave like a user instead of writing test files. Generic across
        # projects and stacks: the start command and port always come from the
        # project's own manifest, never assumed. The predicate lives in agents.py.
        _is_live_test = False
        try:
            _is_live_test = bool(_agents._is_live_test_task(prompt))
        except Exception:  # noqa: BLE001 — detection never breaks the turn
            _is_live_test = False
        if _is_live_test and not _is_status_check:
            lc_history.insert(
                0,
                HumanMessage(
                    content=(
                        "LIVE TEST RULE: this is a live user-like test, not a code-test task. "
                        "Do NOT write test files (no pytest/vitest/jest specs for this request). "
                        "Do NOT loop on Read File / Search Files to guess the bug — browser "
                        "evidence comes first, code reads are a last resort (at most 2-3 targeted "
                        "reads, never batched Search Files loops). "
                        "Launch the project's own start/dev command from its manifest "
                        "(package.json scripts, pyproject, Cargo.toml, go.mod, etc. — never assume "
                        "the command, cwd, or port; run from the directory that actually holds "
                        "the manifest/server file) detached with `bg:` via run_terminal "
                        "(a foreground server timeout is expected, not a failure). "
                        "Read its output with run_terminal `terminal_logs <job_id>` (an internal "
                        "run_terminal command, not a shell binary) or the read tool on the "
                        "returned log path until ready; a missing log file means still "
                        "starting, retry shortly. The OS temp dir (log files) is always readable "
                        "without permission — never ask for permission to read it. Then drive "
                        "the REAL running app like a user at the sidecar's actual launched port "
                        "(never the playwright MCP port; never assume /health — probe only routes "
                        "declared in the server code) via browser navigate/click/type or computer "
                        "actions, DOM assertions, screenshots, and report a verdict per behavior "
                        "with evidence. After EVERY navigate, collect browser_console_messages "
                        "(errors), browser_snapshot, and DOM state via browser_evaluate before any "
                        "code read. A blank/white page with an empty #root plus a missing "
                        "window.coder means the app shell needs its bridge: use the harness route "
                        "(/tests/ui/harness.html?scenario=...) which stubs window.coder, instead of "
                        "reading source files in a loop. "
                        "Stop the dev server with `terminal_stop <job_id>` when finished."
                    )
                ),
            )
        # Enforce the test-verification rule at runtime for any code-changing
        # build task (feature/bugfix/refactor), not only when the prompt
        # literally says "test". This closes the gap the user reported: build
        # must write/update and run tests before finishing, even on ordinary
        # code work — but only for changes that alter behavior/logic, not pure
        # cosmetic/refactor/doc edits. The pure-logic predicates live in agents.py.
        elif _agents._is_code_task(prompt) and not _is_status_check:
            stack = detect_frontend_stack(root)
            fw_note = ""
            if stack:
                fw_note = (
                    f" This workspace is a {stack} frontend — write component tests "
                    f"with @testing-library/react (or that framework's testing library) "
                    f"and run the project's frontend command (npm run test:frontend / "
                    f"npx vitest run / npx jest). "
                )
            # Tell the Build mode the EXACT commands so it can run the project's
            # tests itself (there is no automatic test gate in the graph) —
            # but scope them to the END of the task: iterating on the full
            # suite burns minutes per run, so targeted files come first.
            cmds = detect_test_commands(root)
            cmd_note = ""
            if cmds:
                cmd_note = (
                    " While iterating, run ONLY the specific test file(s) you "
                    "wrote or touched (e.g. `uv run pytest tests/test_x.py -q`) "
                    "— never the whole suite. Run the full project command(s) ("
                    + "; ".join(cmds)
                    + ") at most ONCE, at the very end of the task — skip them "
                    "entirely when the targeted tests already cover the change. "
                )
            lc_history.insert(
                0,
                HumanMessage(
                    content=(
                        "TEST VERIFICATION RULE: this is code-changing work. "
                        "Write/update the relevant test(s) for the language(s) you "
                        "touched — but ONLY when the change introduces or alters "
                        "BEHAVIOR or LOGIC (new functions, branches, edge cases, bug "
                        "fixes). Skip tests for pure cosmetic/refactor/doc changes "
                        "unless they touch existing tested behavior; prefer extending "
                        "existing tests over adding trivial new ones. "
                        "DO NOT write tests for: config/metadata/env vars, error "
                        "messages + logging, imports/sorting/dead code removal, "
                        "comments/docs/README, cosmetic/style/formatting. "
                        "Write AT MOST 1-2 focused tests per change, not a test suite. "
                        "Keep them FAST (unit-level, no real sleeps — see the TEST "
                        "STYLE RULE). "
                        "If a relevant test file already exists, ADD test cases there "
                        "— do NOT create a new file. "
                        "Run ONLY the test file(s) you wrote or touched, never the "
                        "whole suite while iterating "
                        "(uv run pytest tests/test_x.py / npx vitest run "
                        "path/to/file.test.ts / cargo test / go test / ..."
                        + fw_note
                        + ")."
                        + cmd_note
                        + "Do NOT finish with red tests — keep fixing until "
                        "all tests pass. "
                        + "TEST LOCATION: permanent regression tests ship next to the "
                        "code they test (in the same package/sub-package). Temporary "
                        "tests — scratch / probe / smoke / quick experiments you do "
                        "just to verify behavior, reproduce a bug, or sanity-check an "
                        "API — may live in the OS temp directory (use Python's "
                        "tempfile.gettempdir() or Node's os.tmpdir(); the sandbox "
                        "permits this). Do NOT commit scratch tests into the project's "
                        "version-controlled directories; clean them up when done."
                    )
                ),
            )
    # Recency: the tool-reuse note must sit right BEFORE the current user
    # turn (not at index 0). An instruction buried at the head of a long
    # context is the weakest position — the model re-searched/re-read
    # everything instead of reusing results. Appending puts it adjacent to
    # the decision point. (Plan/test notes stay at the head: they are
    # orientation, not per-step action guidance.)
    reuse_tool = _agents._tool_reuse_note(history)
    if reuse_tool:
        lc_history.append(HumanMessage(content=reuse_tool))
    delegated_note = _delegated_scope_note(history, chat_id)
    if delegated_note:
        lc_history.append(HumanMessage(content=delegated_note))

    # User content (prompt; images as content parts). Attached FILE
    # contents are no longer force-injected here — they enter via the
    # focus note above and are read on demand. No workspace
    # scout is injected either; the agent discovers via its tools.
    user_parts: list[Any] = []
    if prompt:
        user_parts.append(prompt)
    # Prompt-dependent blocks (language directive + per-turn RAG context) are
    # injected HERE, into the user turn, instead of the system prompt. This keeps
    # the system prompt fully static so prefix caching hits consistently across
    # turns (previously these prompt-derived strings sat inside the system
    # message and changed the cache prefix every turn, causing cache_read=0
    # spikes and unstable input_tokens).
    if lang_directive:
        user_parts.append(lang_directive)
    user_parts.append(_today_stamp())
    # Always-on mode anchor (recency): re-stamp the current mode in the user turn
    # every message so the agent can never "forget" or misread it from the
    # un-labelled, possibly other-mode history. On a user switch, flag it loudly.
    _mode_changed = state.get("_mode_changed")
    _prev_mode = state.get("_prev_mode")
    _mode_label = _agents._MODE_LABELS.get(mode, (mode or "Ask").capitalize())
    _mode_caps = _agents._MODE_CAPS.get(mode, "")
    user_parts.append(f"MODE: {_mode_label} — {_mode_caps}")
    if _mode_changed and _prev_mode:
        _prev_label = _agents._MODE_LABELS.get(
            _prev_mode, (_prev_mode or "Ask").capitalize()
        )
        user_parts.append(
            f"⚠ MODE SWITCHED: the previous turn ran in {_prev_label}; this turn runs in "
            f"{_mode_label}. Fully re-orient to {_mode_label} NOW — ignore the style, length, "
            f"format and constraints of any earlier turns; they are only history."
        )
    if mcp_tools:
        user_parts.append(
            _mcp_note_for_turn(mcp_tools, browser_mcp_live, str(chat_id or ""))
        )
    # ابزار computer (کنترل اپ‌های دسکتاپ از طریق Accessibility Tree) فقط وقتی
    # از فیلتر مود عبور کرده به ایجنت اصلی note می‌شود — راهنمای استراتژی استفاده.
    if filtered.get("computer") is not None:
        user_parts.append(
            "=== COMPUTER USE ===\n"
            "The `computer` tool is live: it reads and controls desktop apps via "
            "the OS Accessibility Tree (macOS/Windows/Linux). Use it when the user "
            "asks to interact with OTHER apps (not this workspace's files).\n"
            "STRATEGY: if you can guess the target element, call computer with "
            "action='act' and a selector directly; only read the tree "
            "(action='read_screen') when you don't know the app's structure or an "
            "action failed. Prefer semantic 'act' over coordinate 'input'. One "
            "read_screen serves many later actions — don't re-read after every "
            "step. SPEED: plan the WHOLE interaction first, then execute it — "
            "batch every multi-step flow (click → type → Enter, menus, dialogs) "
            "into ONE action='sequence' call; separate calls are one full model "
            "round-trip EACH and make simple tasks take forever. Do NOT call "
            "action='open_app' between steps on the same app (activation is "
            "automatic and skipped when the app is already front). Avoid "
            "action='see' unless the tree truly cannot answer (terminals, "
            "canvases, video) — each see costs an extra vision-model round-trip. "
            "input/sequence activate ``app`` first when given, so keyboard/mouse "
            "events reach the right app. Use action='read_element' for a cheap "
            "subtree read. If it reports PermissionDenied, tell the user to grant "
            "Accessibility access (the tool's check_access action has the per-OS "
            "instructions) and stop."
        )
    # LSP tools are available in all modes with repo access
    # (build/plan/ask/reader): precise jump helps answering and planning
    # too, not just editing.
    # SERVER-SIDE vision analysis of attached images. Prefer the dedicated
    # vision model, but FALL BACK to the main model (mirroring the `vision`
    # tool's own fallback) so an attached image is ALWAYS analyzed
    # automatically — the agent must not need to be told "look at the image".
    # If even the fallback model can't analyze it, we surface a note rather
    # than attaching raw bytes that would just 400.
    prefetch_model = vision_model or model
    _analysis = None
    _vision_failure: str | None = None

    def _classify_vision_prefetch_error(exc: BaseException) -> str:
        # Distinguish a real image-rejection (text-only model) from transient
        # failures so the user-facing note never claims a capable model
        # "does not support images" when it only timed out or errored.
        low = str(exc or "").lower()
        if "unknown variant" in low and "image_url" in low:
            return "image_rejected"
        if "image_url" in low and any(
            k in low
            for k in (
                "field is required",
                "not supported",
                "does not support",
                "unexpected",
                "unrecognized",
            )
        ):
            return "image_rejected"
        return f"error:{exc}"

    if _vision_task is not None:
        try:
            # Started early so the vision round-trip overlapped MCP/skill work.
            _analysis = await _vision_task
            if not _analysis:
                _vision_failure = "error:empty response"
        except asyncio.TimeoutError:
            logger.warning("[turn-ctx] vision analysis timed out after 15s, continuing without prefetch")
            _analysis = None
            _vision_failure = "timeout"
        except Exception as _vexc:  # noqa: BLE001 — vision prefetch never breaks the turn
            _analysis = None
            _vision_failure = _classify_vision_prefetch_error(_vexc)
    elif image_uris and prefetch_model:
        try:
            # Bounded so a slow vision provider never parks Preparing context
            # for tens of seconds; on timeout the turn proceeds and the
            # dedicated vision tool covers the image on demand.
            _analysis = await asyncio.wait_for(
                _vision_analyze_cached(prefetch_model, image_uris, chat_id),
                timeout=15.0,
            )
            if not _analysis:
                _vision_failure = "error:empty response"
        except asyncio.TimeoutError:
            logger.warning("[turn-ctx] vision analysis timed out after 15s, continuing without prefetch")
            _analysis = None
            _vision_failure = "timeout"
        except Exception as _vexc:  # noqa: BLE001 — vision prefetch never breaks the turn
            _analysis = None
            _vision_failure = _classify_vision_prefetch_error(_vexc)
    if image_uris and prefetch_model:
        if _analysis:
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s); this is exactly what they show — treat it as part of the "
                f"request and ground your answer on it]\n{_analysis}\n\n"
                "INSTRUCTION: You MUST use the ATTACHED IMAGE ANALYSIS above. "
                "Transcribe any visible file paths / filenames / code / text VERBATIM "
                "into your reply; do not invent or omit them. If a design skill is "
                "mentioned, apply its guidance to render what the image depicts."
            )
        elif _vision_failure == "timeout":
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s) but the vision model "
                f"({getattr(prefetch_model, 'model_name', '') or 'unknown'}) could "
                f"not analyze them (timed out after 15s — transient slowness, NOT a "
                f"missing capability). ACTION: call the `vision` tool to analyze the "
                f"image(s) on demand and ground your answer on its report. Do NOT "
                f"claim the model lacks vision support. If the retry also times out, "
                f"tell the user to try a faster Vision model in "
                f"Settings → Subagents → Vision, or paste the image's text directly. "
                f"Do NOT guess what the image contains.]"
            )
        elif _vision_failure == "image_rejected":
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s) but the vision model "
                f"({getattr(prefetch_model, 'model_name', '') or 'unknown'}) could "
                f"not analyze them. The model likely does not support images or is "
                f"misconfigured. ACTION: tell the user to set a Vision model in "
                f"Settings → Subagents → Vision, or paste the image's text directly. "
                f"Do NOT guess what the image contains.]"
            )
        else:
            _detail = _vision_failure or "error:unknown"
            if _detail.startswith("error:"):
                _detail = _detail[len("error:"):].strip()[:300] or "unknown error"
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s) but the vision model "
                f"({getattr(prefetch_model, 'model_name', '') or 'unknown'}) could "
                f"not analyze them ({_detail}). This is a transient/provider failure, "
                f"NOT proof the model lacks vision support. ACTION: call the `vision` "
                f"tool to analyze the image(s) on demand and ground your answer on "
                f"its report. If it keeps failing, tell the user to check the Vision "
                f"model in Settings → Subagents → Vision, or paste the image's text "
                f"directly. Do NOT guess what the image contains.]"
            )
    elif image_uris:
        # No model available at all (only if `model` itself failed to build).
        user_parts.append(
            f"[context] {len(image_uris)} image(s) are attached but no vision model "
            "is configured, so you cannot see them. ACTION: tell the user to set a "
            "Vision model in Settings → Subagents → Vision, or ask them to paste the "
            "image's text."
        )
    user_content: Any
    if (
        image_uris
        and (not prefetch_model or not vision_tool_available)
        and not _analysis
    ):
        content_blocks = [{"type": "text", "text": "\n\n".join(user_parts)}]
        for uri in image_uris:
            content_blocks.append({"type": "image_url", "image_url": {"url": uri}})
        user_content = content_blocks
    else:
        user_content = "\n\n".join(user_parts)

    # All notes (reuse, discovery, test-rule, tool-reuse, summary) are
    # injected as HumanMessage — never SystemMessage — so system_final
    # stays clean at position 0.  This keeps provider prefix cache intact
    # for Claude / GPT-4 while avoiding "System message must be at the
    # beginning" errors on strict Jinja templates (Qwen3.5 etc.).
    messages: list[BaseMessage] = [SystemMessage(content=system_final)]
    messages.extend(lc_history)
    messages.append(HumanMessage(content=user_content))
    # ثبت پرامپت نهایی هر نوبت در trace_store برای پنل Trace — best-effort.
    with contextlib.suppress(Exception):
        import trace_store

        _prompt_text = user_content if isinstance(user_content, str) else "\n\n".join(
            str(c.get("text", "")) for c in user_content if isinstance(c, dict)
        )
        _full_prompt = f"[system]\n{system_final}\n\n[user]\n{_prompt_text}"
        # Trace storage is observability only: never write megabytes per turn.
        _trace_prompt = _full_prompt if len(_full_prompt) <= 50000 else _full_prompt[:50000] + "\n...(trace prompt truncated)"
        trace_store.append(
            str(chat_id or ""),
            "prompt",
            f"{mode} · {len(_full_prompt)} chars",
            detail={"mode": mode, "system_chars": len(str(system_final)), "user_chars": len(str(_prompt_text))},
            prompt=_trace_prompt,
        )

    with contextlib.suppress(Exception):
        _sys_chars = len(str(system_final))
        _user_chars = (
            len(user_content)
            if isinstance(user_content, str)
            else sum(
                len(str(c.get("text", ""))) for c in user_content if isinstance(c, dict)
            )
        )
        # print(
        #     f"[CTX_DEBUG] sys_chars={_sys_chars} hist_chars={_hist_chars} "
        #     f"user_chars={_user_chars} total_chars={_sys_chars + _hist_chars + _user_chars}",
        #     flush=True,
        # )

    # Convert the mode-filtered fns to LangChain StructuredTools. MCP tools are
    # already StructuredTools (built in build_mcp_tools), so they pass through.
    def _short_desc(fn: Any, name: str) -> str:
        # Opencode-style minimal schemas: tool schemas are re-sent every turn,
        # so verbose docstrings dominate context (see "System tools" meter).
        # Prefer the first English line (Persian costs ~2x tokens), cap 140.
        doc = (getattr(fn, "__doc__", "") or name).strip()
        for line in doc.split("\n"):
            s = line.strip()
            if len(s) >= 20 and s.isascii():
                return s[:140]
        head = doc.split("\n\n")[0].strip().split("\n")[0].strip()
        return head[:140] if head else name

    lc_tools = [
        (
            t
            if isinstance(t, StructuredTool)
            else StructuredTool.from_function(
                coroutine=t, name=name, description=_short_desc(t, name)
            )
        )
        for name, t in filtered.items()
    ]
    # Trim verbose arg-schema field descriptions (re-sent every turn like the
    # tool description). Keeps capability, drops the per-turn token tax.
    for _t in lc_tools:
        try:
            _schema = getattr(_t, "args_schema", None)
            _fields = getattr(_schema, "model_fields", None) if _schema else None
            if _fields:
                for _f in _fields.values():
                    _d = getattr(_f, "description", None)
                    if isinstance(_d, str) and len(_d) > 40:
                        _f.description = _d[:40].rstrip() + " …"
                    try:
                        if getattr(_f, "examples", None):
                            _f.examples = None
                        _ft = getattr(_f, "title", None)
                        if isinstance(_ft, str) and len(_ft) > 40:
                            _f.title = _ft[:40]
                    except Exception:  # noqa: BLE001, S110 - schema trim never breaks turn
                        pass
        except Exception:  # noqa: BLE001, S110 - schema trim never breaks turn
            pass
    # Stable toolset order for prompt-cache stability: dict insertion order
    # varies with mode-filter/MCP-merge paths, which would rewrite the tool
    # schema prefix every turn and force full-price reprocessing. The rank
    # below is deterministic given the same set (cache-stable) while sorting
    # LSP tools first, then read/grep/glob, then the rest — nudging the model
    # toward precise jumps over blind scans with the fewest LLM requests.
    _LSP_FIRST = (
        "lsp_definition", "lsp_references", "lsp_hover",
        "lsp_symbols", "lsp_diagnostics",
    )
    _SEARCH_NEXT = ("read", "grep", "glob")

    def _tool_rank(t) -> tuple[int, str]:
        name = str(getattr(t, "name", "") or "")
        if name in _LSP_FIRST:
            return (0, name)
        if name in _SEARCH_NEXT:
            return (1, name)
        return (2, name)

    try:
        lc_tools.sort(key=_tool_rank)
    except Exception:  # noqa: BLE001, S110 — order hint must never break turn
        pass
    _tctx_mark("done")
    try:
        _tctx_total = _tctx_marks.get("done", 0.0)
        _tctx_parts = []
        _tctx_prev = 0.0
        for _k in ("mcp", "done"):
            _v = float(_tctx_marks.get(_k, 0.0))
            _tctx_parts.append(f"{_k}={_v - _tctx_prev:.1f}s")
            _tctx_prev = _v
        (logger.warning if _tctx_total > 5.0 else logger.info)(
            "[turn-ctx] total=%.1fs %s mode=%s chat=%s",
            _tctx_total,
            " ".join(_tctx_parts),
            mode,
            str(chat_id or "")[:8],
        )
    except Exception:  # noqa: BLE001, S110 — timing never breaks the turn
        pass

    # Report the REAL per-turn part sizes to the popover (ctx_parts): the
    # system prompt tail actually sent (mode prompt + workspace note + saved
    # plan + ...), the skills section, and the bound MCP tool schemas.
    with contextlib.suppress(Exception):
        queue.put_nowait(
            ctx_parts_event(
                mode,
                str(system_final),
                _skill_section,
                lc_tools,
                str(chat_id or ""),
            )
        )

    return {
        "model": model,
        "messages": messages,
        "tools": filtered,
        "lc_tools": lc_tools,
        "system_final": system_final,
        "ctx": ctx,
        "web_model": web_model,
        "compact_model": compact_model,
        "vision_model": vision_model,
        "main_model": model,
        "prompt": prompt,
        "mcp_cleanup": mcp_cleanup,
        # Vision fallback for image-bearing MCP results; the steer path's
        # late build_mcp_tools call reuses this same hook.
        "analyze_images": _analyze_mcp_images,
    }


def model_timeout_for(state: AgentState) -> float:
    from providers import model_timeout

    mt = model_timeout(provider=state["provider"], total=900)
    # httpx.Timeout (non-Google) -> use its read component as the request timeout.
    with contextlib.suppress(Exception):
        import httpx

        if isinstance(mt, httpx.Timeout):
            return float(mt.read)
    return float(mt)


# ---------------------------------------------------------------------------
# Shared LLM tool-loop runner (LangChain)
# ---------------------------------------------------------------------------


def _estimate_content_tokens(content: Any) -> int:
    """Token estimate for a message content that may be a string or a list of
    content blocks (text/image)."""
    if not content:
        return 0
    if isinstance(content, str):
        return _agents._estimate_tokens(content)
    if isinstance(content, list):
        total = 0
        for p in content:
            if isinstance(p, dict):
                total += _agents._estimate_tokens(p.get("text", "") or "")
            else:
                total += _agents._estimate_tokens(str(p))
        return total
    return _agents._estimate_tokens(str(content))


def _estimate_prompt_tokens(messages: list) -> int | None:
    """Local, stable token estimate of the FULL input prompt sent this turn
    (every message in `messages`: system + history + current user turn + tools).

    This — not the provider's per-request input+output total — is what the
    context meter should reflect: it grows monotonically with the conversation
    history and is independent of how long the model's OUTPUT happens to be
    this turn (output length otherwise makes the running-max meter pin to an
    old value and stop moving). Mirrors opencode's message-list based context
    count."""
    try:
        total = 0
        for m in messages or []:
            total += _estimate_content_tokens(getattr(m, "content", ""))
        return total
    except Exception:  # noqa: BLE001
        return None


def _usage_event_from_ai(
    ai: Any, model: str, provider: str = "", provider_id: str = ""
) -> dict | None:
    """Build a frontend ``usage`` event from a LangChain ``AIMessage``.

    LangChain surfaces token counts in ``usage_metadata`` (OpenAI/Google),
    or sometimes under ``response_metadata.token_usage``. Returns ``None``
    when there is nothing usable so a degenerate (zero-token) event is never
    emitted — a zero event would drag the frontend context meter to a
    misleading 0%.
    """
    um = getattr(ai, "usage_metadata", None)
    if not um:
        rm = getattr(ai, "response_metadata", None) or {}
        um = rm.get("token_usage") or rm.get("usage") or None
    if not um:
        return None
    try:
        input_tokens = int(um.get("input_tokens") or um.get("prompt_tokens") or 0)
        output_tokens = int(um.get("output_tokens") or um.get("completion_tokens") or 0)
    except (TypeError, ValueError):
        return None
    if input_tokens <= 0 and output_tokens <= 0:
        return None
    cache_read, cache_write, key_additive = _extract_cache_tokens(um)
    reasoning_tokens = _extract_reasoning_tokens(um)
    # Additive (cache must be added to input) when the cache key is Anthropic-native
    # (cache_read_input_tokens / cache_creation_input_tokens, where input excludes
    # it), OR when the cached portion is LARGER than input_tokens (proving input
    # excludes the cache). Otherwise the cache is a SUBSET of input_tokens and the
    # provider's total_tokens already counts it (adding it back would double-count).
    additive = (
        key_additive
        or (cache_read > 0 and input_tokens < cache_read)
        or (cache_write > 0 and input_tokens < cache_write)
    )
    if additive:
        # Cache is separate from input_tokens -> add it back for the true total.
        # reasoning_tokens is reported separately by the provider, so include it.
        total_tokens = (
            input_tokens + output_tokens + reasoning_tokens + cache_read + cache_write
        )
    else:
        # Subset convention: cache_read/write is already folded into input_tokens,
        # so total_tokens already counts the cache. Trust the provider's own
        # total_tokens — but ONLY when it actually covers input + output: some
        # routers report a total that EXCLUDES the cached subset of the prompt
        # (input 286.6K with 40.7K cached -> total 245.9K), and trusting that
        # made the context meter under-report by exactly the cached portion.
        # An inconsistent total falls back to the hand-sum.
        provided_total = int(um.get("total_tokens") or 0)
        total_tokens = (
            provided_total
            if provided_total >= input_tokens + output_tokens
            else input_tokens + output_tokens + reasoning_tokens
        )
    import json as _json

    try:
        _um_dump = _json.dumps(um, default=str)
    except Exception:  # noqa: BLE001
        _um_dump = repr(um)
    # `context_tokens` is the true context footprint of this turn — the
    # provider's `total_tokens` (which already includes the system prompt, tool
    # schemas, history, output, reasoning and cache, and respects the
    # additive/subset cache convention). We report `total_tokens` verbatim (NOT
    # `total - output`) so the meter and the auto-compaction trigger agree: both
    # compare against the RAW window (`compact_at_percent` of `ctx`), so the bar
    # hits the threshold exactly when compaction fires (opencode's `isOverflow`
    # also uses the full token count). Subtracting output would make the meter
    # disagree with the trigger and report a falsely low usage.
    context_tokens = total_tokens
    return {
        "kind": "usage",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        # Always surface the TRUE cache counts so the sidebar can bill them at
        # the cheaper cache rate. For subset-convention providers (OpenAI /
        # OpenRouter / Google) cache_read/write is already folded into
        # input_tokens, so `total_tokens` stays the provider's native total
        # (which already counts the cache) — the frontend's opencode sum then
        # adds cache_read back, but since input_tokens already includes it the
        # frontend must NOT double-count. We signal this by sending the real
        # cache counts AND keeping total_tokens == provider total; the frontend
        # uses `total_tokens` for the meter when the provider reports it, and
        # only hand-sums (input+output+reasoning+cache) for additive providers.
        # For additive providers (Anthropic) the real cache counts are sent and
        # total_tokens is the hand-sum, so the meter's opencode sum is correct.
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning_tokens,
        "context_tokens": context_tokens,
        "model": model or "",
        "provider": provider,
        # User-configured provider id (distinct from `provider` which is the
        # kind). Frontend groups per-usage entries by this id so several
        # providers sharing the same kind do not collapse into one bucket.
        "provider_id": provider_id,
    }


# _extract_cache_tokens از _common import می‌شود (single source of truth).


# _strip_think_tags و _is_repeating از _common import می‌شوند (single source of truth).


def _thinking_from_chunk(chunk: Any) -> str | None:
    """Extract reasoning/thinking text from a streamed LangChain chunk.

    Reasoning-capable gateways (OpenAI o-series, DeepSeek reasoner, Gemini
    thinking, …) surface their chain-of-thought in different places: a
    ``reasoning_content`` field on the chunk, a ``thinking`` part inside a
    list-typed ``content``, or under ``additional_kwargs`` /
    ``response_metadata``. Returns the text when present, else ``None`` so the
    caller can skip emitting a frontend ``thinking`` event; never raises on
    unexpected shapes.
    """
    if chunk is None:
        return None

    def _coerce(val: Any) -> str | None:
        # A nested mapping like response_metadata={"reasoning": {"text": ...}}
        # is flattened to its inner string value.
        if isinstance(val, dict):
            for k in ("text", "thinking", "reasoning", "content"):
                inner = val.get(k)
                if isinstance(inner, str) and inner:
                    return inner
            return None
        if isinstance(val, str) and val:
            return val
        return None

    # 1) Direct attribute (OpenAI o-series / DeepSeek via langchain-openai).
    rc = getattr(chunk, "reasoning_content", None)
    out = _coerce(rc)
    if out:
        return out
    # 2) List-typed content with a "thinking"/"reasoning" part.
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") in ("thinking", "reasoning"):
                txt = _coerce(
                    part.get("text") or part.get("thinking") or part.get("reasoning")
                )
                if txt:
                    return txt
    # 3) additional_kwargs / response_metadata fallbacks.
    for bag in (
        getattr(chunk, "additional_kwargs", None) or {},
        getattr(chunk, "response_metadata", None) or {},
    ):
        if not isinstance(bag, dict):
            continue
        for key in ("reasoning_content", "reasoning", "thinking"):
            out = _coerce(bag.get(key))
            if out:
                return out
    return None


_HISTORY_SUMMARY_CACHE: dict = {}  # key=(root, hash) -> summary text
_HISTORY_SUMMARY_CACHE_MAX = 200  # bound growth; summaries are stable per (root, hash)


async def _summarize_history_head(
    compact_model: Any, older: list, root: str, chat_id: str = ""
) -> str:
    """Summarize the OLDER turns (dropped by historyLimit) into one block.

    The block is prefixed with "[Compacted earlier context]" so the
    auto-compactor merges it on a later overflow instead of re-expanding it
    (see agents.py _compact_history). Cached per (root, content-hash) so we
    don't re-summarize identical older history every turn (only new turns are
    appended, so the older slice is stable across turns).
    """
    _key = (
        root,
        hashlib.md5(
            json.dumps(older, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()[:16],
    )
    if _key in _HISTORY_SUMMARY_CACHE:
        return _HISTORY_SUMMARY_CACHE[_key]
    if compact_model is None:
        # Fallback without an LLM: keep the last few user messages + first line
        # of each assistant reply so the model still has the gist.
        # Checklist progress is folded in so the post-compact model knows
        # completed vs pending without re-reading or an extra roundtrip.
        _parts = []
        for t in older[-12:]:
            _p = f"{t.get('role')}: {str(t.get('content', ''))[:200]}"
            try:
                _pl = t.get("plan")
                if isinstance(_pl, list) and _pl:
                    _p += f"\n[Checklist progress {_plan_progress_line(_pl)}]"
            except Exception:
                pass
            _parts.append(_p)
        _summary = "[Compacted earlier context]\n" + "\n".join(_parts)
    else:
        try:
            _ser_parts = []
            for t in older:
                _sp = f"{t.get('role')}: {t.get('content', '')}"
                try:
                    _pl2 = t.get("plan")
                    if isinstance(_pl2, list) and _pl2:
                        _sp += f"\n[Checklist progress {_plan_progress_line(_pl2)}]"
                except Exception:
                    pass
                _ser_parts.append(_sp)
            _serialized = "\n\n".join(_ser_parts)
            _summary, _ = await llm_generate(
                compact_model,
                system=(
                    "Summarize this coding-agent conversation history into ONE "
                    "concise block preserving user requests, file paths, decisions, "
                    "and errors. Prefix the summary with '[Compacted earlier context]'."
                ),
                user=_serialized[:20000],
                chat_id=str(chat_id or ""),
            )
            if not str(_summary).startswith("[Compacted earlier context]"):
                _summary = "[Compacted earlier context]\n" + str(_summary)
        except Exception:  # noqa: BLE001 — degrade to a plain omission note
            _summary = "[Compacted earlier context]\n[history omitted by historyLimit]"
    _HISTORY_SUMMARY_CACHE[_key] = _summary
    if len(_HISTORY_SUMMARY_CACHE) > _HISTORY_SUMMARY_CACHE_MAX:
        # Evict the oldest entry (FIFO) so the cache can't grow without bound
        # across a long-running server with many chats/roots.
        _HISTORY_SUMMARY_CACHE.pop(next(iter(_HISTORY_SUMMARY_CACHE)))
    return _summary


def _apply_compaction_in_place(msgs: list, new_history: list[dict]) -> None:
    """Rebuild ``msgs`` in place from a compacted history dict list.

    Keeps the original leading ``SystemMessage`` (the assembled system prompt)
    UNTOUCHED — opencode stores the compaction summary as its own message part,
    never folded into the system prompt, so the prompt stays byte-identical
    across compactions (prefix-cache friendly) and can never grow. The compact
    head (``[Compacted earlier context]``) is re-injected as a standalone
    ``HumanMessage`` right after the system prompt, mirroring
    ``history_to_langchain_messages`` which already renders history system
    notes as HumanMessage (Jinja-safe: SystemMessage stays at position 0).
    Tool/assistant turns lose their structured ``tool_calls`` (they become
    plain text), which is exactly what a compacted summary tail should be —
    the model only needs the distilled context, not the original callable
    tool signatures.
    """
    rebuilt: list[BaseMessage] = []
    had_system = bool(msgs) and isinstance(msgs[0], SystemMessage)
    if had_system:
        rebuilt.append(msgs[0])
    for d in new_history:
        role = d.get("role")
        content = str(d.get("content") or "")
        if role == "system" and had_system:
            # The compacted head is itself a "[Compacted earlier context]"
            # system note. opencode keeps it as a separate message; we inject
            # it as a HumanMessage (never a second SystemMessage — strict Jinja
            # templates like Qwen3.5 require system only at position 0).
            if content:
                rebuilt.append(HumanMessage(content=content))
            continue
        if role == "assistant":
            # Keep the structured tool_calls so a compacted in-flight step can
            # still be continued by the model (older distilled turns carry none).
            rebuilt.append(
                AIMessage(content=content, tool_calls=d.get("tool_calls") or [])
            )
        elif role == "tool":
            # Keep the ORIGINAL tool_call_id so it still links to the assistant's
            # tool_calls entry. The placeholder is only a fallback for tool
            # messages whose id was lost (summarized older turns).
            rebuilt.append(
                ToolMessage(
                    content=content,
                    tool_call_id=d.get("tool_call_id") or "__compacted__",
                )
            )
        else:
            rebuilt.append(HumanMessage(content=content))
    msgs[:] = rebuilt


def _steer_to_human_message(steers: list[dict], steps_taken: int = 0) -> HumanMessage:
    """ساخت پیام تزریقی steer با همان قرارداد ترن عادی تا عکس هم به مدل برسد.

    متن + فایل‌های ضمیمه در بخش متنی می‌آیند و عکس‌ها (dataUrl یا مسیر) به
    بخش‌های `image_url` تبدیل می‌شوند؛ بدون عکس پیام تک‌متنه برمی‌گردد.
    اسکیل‌ها و سرورهای MCP انتخاب‌شده هم در متن تزریق می‌شوند تا مدل بداند
    کدام ابزار/دستورالعمل این نوبت فعال است.
    """
    _steer_lines = [f"- {s.get('prompt')}" for s in steers]
    _steer_atts: list[str] = []
    _steer_imgs: list = []
    _steer_skills: list[str] = []
    _steer_mcp: dict = {}
    for _s in steers:
        _steer_atts.extend(_s.get("attachments") or [])
        _steer_imgs.extend(_s.get("images") or [])
        for _name in _s.get("skills") or []:
            if _name and _name not in _steer_skills:
                _steer_skills.append(_name)
        _servers = _s.get("mcp_servers") or {}
        if isinstance(_servers, dict):
            _steer_mcp.update(_servers)
    _steer_text = (
        "[ADDITIONAL USER INPUT DURING THIS TASK]\n"
        + "\n".join(_steer_lines)
    )
    if _steer_atts:
        _steer_text += (
            "\nAttached files (in scope — read with the read tool): "
            + ", ".join(f"`{a}`" for a in _steer_atts)
        )
    if _steer_skills:
        _steer_text += (
            "\nUser-selected skills for this turn: "
            + ", ".join(f"`{n}`" for n in _steer_skills)
            + " — load each with the load_skill tool and follow its instructions."
        )
    if _steer_mcp:
        _steer_text += (
            "\nUser-selected MCP servers for this turn: "
            + ", ".join(f"`{n}`" for n in sorted(_steer_mcp))
            + " — their tools are bound under their short names and callable now."
        )
    _steer_text += (
        "\nKeep your ongoing task, completed steps, and current plan in mind — "
        "incorporate this input alongside them, do not drop or restart the work. "
        "If it conflicts with the ongoing task, say so briefly, then continue. "
        "If the user narrowed the scope (fewer items wanted), call update_plan "
        "to shrink the checklist to the matching items so todos/plan reflect "
        "the new scope."
    )
    if steps_taken > 0:
        _steer_text += (
            f"\nContext: you have already taken {steps_taken} step(s) this turn; "
            "completed tool results above stay valid."
        )
    _steer_uris = _agents._load_images(_steer_imgs)
    if _steer_uris:
        _steer_blocks: list = [{"type": "text", "text": _steer_text}]
        for _uri in _steer_uris:
            _steer_blocks.append({"type": "image_url", "image_url": {"url": _uri}})
        return HumanMessage(content=_steer_blocks)
    return HumanMessage(content=_steer_text)


# Cap on how many times mid-turn compaction may actually FIRE within a single
# turn, so a pathological transcript can never spin in a compact loop. The
# post-turn backstop still runs once at the end.
_MAX_COMPACT_PER_TURN = 6

# How long the turn blocks waiting for this chat's background sub-agents to
# finish before it proceeds anyway (their report is then picked up on a later
# step/turn instead of stalling the stream forever). Module-level so tests can
# shrink it to milliseconds rather than sleeping on real time.
_SUBAGENT_WAIT_TIMEOUT_S = 300.0

# How many extra wait rounds the final delivery performs while sub-agents are
# still running after a wait timeout (each round waits up to
# _SUBAGENT_WAIT_TIMEOUT_S and emits a still-waiting status). Covers long
# tasks instead of finalizing early; a hung job still cannot stall forever
# because rounds are bounded and each round times out.
_SUBAGENT_FINAL_WAIT_ROUNDS = 5


def _plan_scout_checklist_wasteful(
    pending: list, reply: str, msgs: list, seed_ids=None
) -> bool:
    """True when a plan-mode solo update_plan step wastes a round-trip.

    The initial checklist AFTER ## Plan was written and any tick marking
    progress are legitimate solo steps; a pending-only checklist DURING
    scouting (no ## Plan yet this turn) is the scout -> tick(0/N) -> scout
    loop. ``seed_ids`` is the turn-start identity snapshot so history plans
    don't count.
    """
    if _plan_only_step_marks_progress(pending):
        return False
    return not _plan_draft_in_turn(reply, msgs, seed_ids)


def _subagent_pending_count(chat_id: str) -> int:
    """Number of still-running sub-agent jobs for a chat (0 on any error)."""
    if not chat_id:
        return 0
    try:
        import subagent_jobs
    except Exception:  # noqa: BLE001
        return 0
    try:
        return len(subagent_jobs.pending_jobs(chat_id))
    except Exception:  # noqa: BLE001
        return 0


def _subagent_report_text(task_id: str, report: str, status: str) -> str:
    """Format one finished background sub-agent's report for the main agent."""
    label = {
        "completed": "finished",
        "failed": "failed",
        "stopped": "stopped by the main agent",
    }.get(status, status)
    body = (report or "").strip() or "(no report produced)"
    # Cap: a verbose sub-agent must not blow the main-agent window — keep the
    # head (findings) and drop the tail; observability only, no behavior change
    # to delivery/verification flow.
    if len(body) > 6000:
        body = body[:6000] + "\n…[sub-agent report truncated — see task output if needed]"
    return (
        f"[background sub-agent report - task_id={task_id}, status={label}]\n"
        f"{body}\n"
        "Verify the task is actually done before finalizing; if incomplete, "
        "follow up (task_steer/task) or finish it yourself — never claim "
        "completion without verification."
    )


# Delegated scopes per chat: what the main agent already handed to background
# sub-agents via task(). Recorded in-turn and surfaced as an anti-repeat note
# so later steps/turns trust the reports instead of re-running glob/grep/read
# over the same scope.
_DELEGATED_SCOPES_BY_CHAT: dict[str, list[str]] = {}
_DELEGATED_SCOPES_MAX = 20


def _track_delegated_tasks(chat_id: str, tool_calls: list | None) -> None:
    """Record scopes delegated to background sub-agents via task().

    Called once per model step right after the assistant message is appended,
    so the very next step can warn against re-discovering the same scope.
    Bounded per chat; bookkeeping only, never breaks the turn.
    """
    if not chat_id or not tool_calls:
        return
    try:
        scopes = _DELEGATED_SCOPES_BY_CHAT.setdefault(chat_id, [])
        for tc in tool_calls or []:
            if not isinstance(tc, dict) or tc.get("name") != "task":
                continue
            args = tc.get("args") or {}
            desc = str(args.get("description") or "").strip()[:120]
            prompt = str(args.get("prompt") or "").strip()[:160]
            scope = f"{desc}: {prompt}" if desc and prompt else (desc or prompt)
            scope = " ".join(scope.split())
            if scope and scope not in scopes:
                scopes.append(scope)
        while len(scopes) > _DELEGATED_SCOPES_MAX:
            scopes.pop(0)
    except Exception:  # noqa: BLE001, S110 — bookkeeping never breaks the turn
        pass


def _delegated_scope_note(history: list | None, chat_id: str) -> str:
    """Anti-repeat note for scopes already delegated to sub-agents.

    Combines in-turn tracked scopes with prior-turn task calls found in history
    toolActivity. Returns "" when nothing was delegated. Keeps the model from
    re-running discovery over a scope whose report is already delivered or in
    flight; only targeted follow-ups for files the report names are allowed.
    """
    scopes: list[str] = []
    seen: set[str] = set()
    try:
        for s in _DELEGATED_SCOPES_BY_CHAT.get(chat_id or "", []):
            if s and s not in seen:
                seen.add(s)
                scopes.append(s)
        for turn in history or []:
            if not isinstance(turn, dict):
                continue
            for a in turn.get("toolActivity") or []:
                if not isinstance(a, dict) or a.get("tool") != "task":
                    continue
                args = a.get("args") or {}
                desc = str(args.get("description") or "").strip()[:120]
                if desc and desc not in seen:
                    seen.add(desc)
                    scopes.append(desc)
                if len(scopes) >= _DELEGATED_SCOPES_MAX:
                    break
            if len(scopes) >= _DELEGATED_SCOPES_MAX:
                break
    except Exception:  # noqa: BLE001, S110 — note is best-effort
        pass
    if not scopes:
        return ""
    listed = "; ".join(scopes[-8:])
    return (
        "Delegated scopes already covered by background sub-agents: "
        f"{listed}. Do NOT re-run glob/grep/read to re-discover these scopes — "
        "trust the delivered sub-agent reports and do only targeted follow-ups "
        "for files they name."
    )


async def _drain_subagent_reports(
    msgs: list, chat_id: str, queue: asyncio.Queue
) -> int:
    """Inject every finished sub-agent report for this chat into ``msgs``.

    Reports are claimed exactly once (``pop_completed_reports`` flips
    ``delivered``), so a later turn never re-injects the same report. Returns
    how many reports were delivered.
    """
    if not chat_id:
        return 0
    try:
        import subagent_jobs
    except Exception:  # noqa: BLE001 — optional module, never break the turn
        return 0
    try:
        done = subagent_jobs.pop_completed_reports(chat_id)
    except Exception:  # noqa: BLE001 — bookkeeping must not kill the turn
        return 0
    delivered = 0
    for task_id, report, status in done:
        msgs.append(
            HumanMessage(content=_subagent_report_text(task_id, report, status))
        )
        try:
            queue.put_nowait(
                {
                    "kind": "subagent_report",
                    "task_id": task_id,
                    "status": status,
                    "content": report,
                }
            )
        except Exception:  # noqa: BLE001, S110 — UI event is best-effort
            pass
        delivered += 1
    return delivered


async def _await_subagent_jobs(chat_id: str, queue: asyncio.Queue) -> bool:
    """Block until this chat's running sub-agents finish. True if it waited.

    Bounded by ``_SUBAGENT_WAIT_TIMEOUT_S`` so one hung sub-agent can never
    stall the turn forever. When the timeout expires with jobs still running,
    a still-waiting status is emitted (the UI keeps showing progress) and the
    caller waits again on the next step instead of finalizing early; any
    report that lands later is picked up by ``_drain_subagent_reports``.
    """
    if not chat_id:
        return False
    try:
        import subagent_jobs
    except Exception:  # noqa: BLE001
        return False
    try:
        pending = subagent_jobs.pending_jobs(chat_id)
    except Exception:  # noqa: BLE001
        return False
    if not pending:
        return False
    try:
        queue.put_nowait(
            {
                "kind": "status",
                "stage": "subagent_wait",
                "content": (
                    f"Waiting for {len(pending)} background sub-agent(s) to finish"
                ),
            }
        )
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        _tasks = [j["task"] for j in pending if j.get("task") is not None]
        if _tasks:
            await asyncio.wait(_tasks, timeout=_SUBAGENT_WAIT_TIMEOUT_S)
        else:
            # Jobs registered but asyncio.Task not attached yet (race between
            # create_job and set_task): poll briefly so the turn does not
            # finalize while a spawn is still in flight.
            _deadline = time.monotonic() + min(5.0, _SUBAGENT_WAIT_TIMEOUT_S)
            while time.monotonic() < _deadline:
                await asyncio.sleep(0.05)
                try:
                    _fresh = subagent_jobs.pending_jobs(chat_id)
                except Exception:  # noqa: BLE001 — polling never breaks turn
                    break
                if not _fresh:
                    break
                _tasks = [j["task"] for j in _fresh if j.get("task") is not None]
                if _tasks:
                    await asyncio.wait(
                        _tasks,
                        timeout=max(0.0, _deadline - time.monotonic()),
                    )
                    break
    except Exception:  # noqa: BLE001, S110 — waiting must never break the turn
        pass
    # Timeout path: jobs are still running, so tell the UI the manager is
    # still waiting (instead of going silent) — the caller then waits again
    # on the next step rather than finalizing without the reports.
    try:
        _still = subagent_jobs.pending_jobs(chat_id)
    except Exception:  # noqa: BLE001
        _still = []
    if _still:
        try:
            queue.put_nowait(
                {
                    "kind": "status",
                    "stage": "subagent_wait",
                    "content": (
                        f"Still waiting for {len(_still)} background "
                        "sub-agent(s) to finish"
                    ),
                }
            )
        except Exception:  # noqa: BLE001, S110
            pass
    return True


async def _maybe_auto_compact(
    state: AgentState,
    queue: asyncio.Queue,
    model: Any,
    compact_model: Any,
    msgs: list,
    ctx: int,
    last_context_tokens: int | None = None,
    compact_at_percent: int | None = None,
) -> int:
    """opencode `isOverflow` -> auto-compaction.

    Returns the number of compaction operations performed (1 if it fired, 0 if
    it was a no-op), so the caller can throttle per-turn fire count without
    inspecting the event queue.

    Auto-compaction fires once the assembled transcript reaches
    ``ctx * compact_at_percent / 100`` of the RAW context window — the SAME
    percentage the context meter shows (the meter divides ``total_tokens`` by
    the raw window). The reserved headroom is implicit: ``(100 - percent)%`` of
    the window is left free. Summarize the older turns — keeping a recent tail
    verbatim — and emit the ``compact_start`` / ``compact`` / ``compact_failed``
    events the frontend already folds on. The summarizer is the configured
    compact subagent, falling back to the main model (mirrors opencode's
    compaction agent + retry).
    """
    if ctx <= 0:
        return 0
    max_output = _agents._model_max_output(model)
    # `reserved` is still used internally by _compact_history to size the output
    # buffer (opencode's COMPACTION_BUFFER). It is NOT the trigger — the trigger
    # is the single `compact_at_percent` of the raw window. Default to None so
    # opencode's own max-output-based reservation applies.
    reserved = state.get("reserved")
    # Single auto-compaction threshold as a percentage of the RAW context window
    # (user-tunable, default 80). Clamp defensively so a mis-set value can never
    # disable compaction (>=1) or fire on every step (<=99).
    _pct = max(
        1, min(99, int(compact_at_percent if compact_at_percent is not None else 80))
    )
    threshold = int(ctx * _pct / 100)
    # Auto-compaction fires off the SAME token breakdown the context meter
    # displays (tracked on `state["last_context_tokens"]` at the usage-emit
    # site), so the meter and the compaction trigger always agree. The breakdown
    # is opencode's `tokens.total` = input + output + reasoning + cache.read +
    # cache.write — the true context footprint (output/reasoning/cache all occupy
    # the window). Fall back to the stable local estimate of the whole transcript
    # when no usage has been reported yet (e.g. the very first turn, or a
    # provider that reports none).
    # `last_context_tokens` reflects the PREVIOUS model step's usage and does NOT
    # include the tool results appended to `msgs` since then. Triggering only off
    # it lags one step, so a mid-turn tool result that blows past the window isn't
    # compacted until after the next (overflowing) model call. Use a live estimate
    # of the CURRENT transcript as a floor so compaction fires BEFORE the next call.
    # Cheap gate first: when the provider-reported usage already exceeds the
    # threshold the outcome is decided without any full-transcript pass. The
    # live estimate (and its rare fallback) only runs below the threshold,
    # where it can still flip the decision. This keeps the per-step cost of
    # the common far-from-overflow case to a single estimate pass instead of
    # estimate + full dict serialization.
    live_total = 0
    if (last_context_tokens or 0) < threshold:
        live_total = _estimate_prompt_tokens(msgs) or 0
        if live_total <= 0:
            # Fallback to the char estimate when the local estimate is
            # unavailable (e.g. un-tokenizable message content, or local
            # models with no usage).
            live_total = sum(
                _agents._estimate_tokens(d["content"])
                for d in _agents._messages_to_dicts(msgs)
            )
    total = max(last_context_tokens or 0, live_total or 0)
    if total <= 0:
        total = live_total or 0
    # Diagnostic: surface the real window/threshold so we can confirm compaction
    # only fires when the prompt genuinely nears the window (and not spuriously).
    # logger.debug(
    #     "[CTX_DEBUG] auto_compact ctx=%s pct=%s threshold=%s total=%s msgs=%s",
    #     ctx, _pct, threshold, total, len(msgs),
    # )
    # opencode fires compaction when the latest turn reaches the threshold
    # (pct% of the raw window). The meter shows the same percentage, so the bar
    # hits the threshold exactly when compaction fires.
    # --- cheap truncation: runs at 50% of the compaction threshold --------
    # Before the heavy LLM summarization, replace old ToolMessage contents
    # with a short placeholder so the transcript sheds weight early.  This
    # fires at half the user's compact_at_percent, is a no-LLM operation,
    # and prevents slow context creep across many tool-call steps.
    # Batched: truncate all-but-recent in ONE pass and skip re-runs until
    # the transcript regrows significantly, so the message prefix stays
    # stable for prompt caching (truncating one more message every step
    # would rewrite the prefix each step and force full-price reprocessing).
    # Cheap truncation fires at 25% of the compaction threshold (e.g. 80 →
    # 20): old ToolMessages are the dominant per-step cost (every byte is
    # re-sent on every following step), so shed them early. LLM summarization
    # still fires at the full threshold.
    _cheap_pct = max(5, _pct // 4)  # e.g. 80 → 20
    cheap_threshold = min(int(ctx * _cheap_pct / 100), 40_000)
    if total >= cheap_threshold:
        _last_cheap = state.get("_cheap_truncated_at")
        _regrow = max(10_000, int(ctx * 5 / 100))
        _skip_cheap = isinstance(_last_cheap, (int, float)) and total < _last_cheap + _regrow
        if not _skip_cheap:
            # Keep whole tool steps, not a fixed count of ToolMessages:
            # collect tool_call ids of the last assistant steps and keep
            # all their results verbatim.
            _KEEP_STEPS = 3
            _step_ids: list[set[str]] = []
            for _m in msgs:
                _tcs = getattr(_m, "tool_calls", None)
                if isinstance(_m, AIMessage) and _tcs:
                    _ids = {tc.get("id") for tc in _tcs if tc.get("id")}
                    if _ids:
                        _step_ids.append(_ids)
            _keep_ids: set[str] = set()
            for _ids in _step_ids[-_KEEP_STEPS:]:
                _keep_ids |= _ids
            # Map every tool_call id to (name, args) for a meaningful placeholder.
            _call_meta: dict[str, tuple[str, dict]] = {}
            for _m in msgs:
                _tcs2 = getattr(_m, "tool_calls", None)
                if isinstance(_m, AIMessage) and _tcs2:
                    for _tc in _tcs2:
                        _tid = _tc.get("id")
                        if _tid and _tid not in _call_meta:
                            _call_meta[_tid] = (str(_tc.get("name") or "tool"), _tc.get("args") or {})
            # Exemption: never truncate a result the recent conversation still
            # refers to — collect distinctive tokens (file paths, snake_case
            # and CamelCase identifiers) from the last few non-tool messages;
            # an older ToolMessage containing any of them stays verbatim.
            # Without this the model could lose a result it is actively
            # discussing and pay a full extra round trip to re-read it, which
            # would wipe out the truncation saving. Common words are excluded
            # by construction (paths need a slash/extension, idents need an
            # underscore or mixed case), so this stays narrow.
            _recent_refs: set[str] = set()
            try:
                _recent_non_tool = [
                    m for m in msgs if getattr(m, "type", "") != "tool"
                ][-3:]
                for _m in _recent_non_tool:
                    _rc = str(getattr(_m, "content", "") or "")
                    # The path/ident regexes below are quadratic on inputs with
                    # no match (pure backtracking scans) — an 800k-char paste
                    # or tool dump would spin for minutes. This pass is
                    # best-effort: scan a small window from both ends only.
                    if len(_rc) > 8_000:
                        _rc = _rc[:4_000] + "\n…\n" + _rc[-4_000:]
                    for _tok in re.findall(r"[\w\-.]+/[\w\-.]+|[\w\-.]+\.\w{1,5}", _rc):
                        _t = _tok.strip("./-")
                        if len(_t) >= 4:
                            _recent_refs.add(_t)
                    for _tok in re.findall(r"[a-z]+(?:_[a-z0-9]+)+", _rc):
                        if len(_tok) >= 4:
                            _recent_refs.add(_tok)
                    for _tok in re.findall(r"[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+", _rc):
                        if len(_tok) >= 4:
                            _recent_refs.add(_tok)
                    if len(_recent_refs) > 200:
                        break
            except Exception:  # noqa: BLE001 — exemption is best-effort
                _recent_refs = set()
            _truncated_any = False
            # Same keep-cap as turn-start truncation: even kept/referenced
            # results never stay fully verbatim past 8k.
            _keep_cap = 8000
            for _i, _m in enumerate(msgs):
                if not isinstance(_m, ToolMessage):
                    continue
                _tid = getattr(_m, "tool_call_id", "")
                _c = getattr(_m, "content", "")
                _cs = str(_c)
                if _cs.startswith("[truncated ") and _cs.endswith("re-issue if still needed]"):
                    continue
                _is_keep = _tid in _keep_ids
                _is_exempt = (
                    not _is_keep
                    and len(msgs) - _i <= 40
                    and bool(_recent_refs)
                    and any(_ref in _cs for _ref in _recent_refs)
                )
                if _is_keep or _is_exempt:
                    if len(_cs) > _keep_cap:
                        with contextlib.suppress(Exception):
                            msgs[_i] = _m.model_copy(
                                update={
                                    "content": _cs[:_keep_cap]
                                    + "\n[truncated for turn-start — re-read with offset/limit if needed]"
                                }
                            )
                            _truncated_any = True
                    continue
                if len(_cs) <= 120:
                    continue
                # Age rule: results older than ~10 steps always truncate even
                # when referenced — the placeholder keeps path:line/args so
                # re-issue is cheap. Without this a common token (e.g. a
                # filename still mentioned in chat) keeps EVERY old result
                # verbatim and context never shrinks.
                _name, _args = _call_meta.get(_tid, (getattr(_m, "name", "") or "tool", {}))
                try:
                    _arg_str = json.dumps(_args, ensure_ascii=False, sort_keys=True)[:160]
                except Exception:  # noqa: BLE001 — placeholder must never fail
                    _arg_str = str(_args)[:160]
                _ph = f"[truncated {_name}({_arg_str}) — re-issue if still needed]"
                if len(_cs) > len(_ph) + 20:
                    with contextlib.suppress(Exception):
                        msgs[_i] = _m.model_copy(update={"content": _ph})
                        _truncated_any = True
            # Recalculate total after truncation so the threshold check
            # below sees the reduced size.
            total = max(
                last_context_tokens or 0,
                _estimate_prompt_tokens(msgs) or 0,
            )
            if total <= 0:
                total = sum(
                    _agents._estimate_tokens(d["content"])
                    for d in _agents._messages_to_dicts(msgs)
                )
            if _truncated_any:
                with contextlib.suppress(Exception):
                    state["_cheap_truncated_at"] = total
    # --- end cheap truncation -------------------------------------------
    if total < threshold:
        return 0
    dicts = _agents._messages_to_dicts(msgs)
    # opencode prune: clear old tool outputs (not the whole turn) before the
    # heavier summarization pass, so a large-but-not-overflowing transcript
    # still sheds context. Runs in place on the serialized history.
    _agents._prune_history(dicts)
    summarizer = compact_model or model
    queue.put_nowait({"kind": "compact_start"})
    try:
        result = await _agents._compact_history(
            summarizer,
            dicts,
            ctx=ctx,
            max_output=max_output,
            reserved=reserved,
            fallback_model=model,
        )
    except Exception:  # noqa: BLE001
        result = None
    if result is None:
        queue.put_nowait({"kind": "compact_failed"})
        return 1
    new_history, keep, compact_usage = result
    summary = new_history[0]["content"] if new_history else ""
    queue.put_nowait({"kind": "compact", "content": summary, "keep": int(keep)})
    # Accrue the tokens the summarizer itself consumed so the session total
    # (the "Model usage" sidebar) is complete.
    if compact_usage:
        queue.put_nowait(compact_usage)
    # Apply the compaction IN PLACE on the live transcript so the very next step
    # (and the next turn) sends the compressed history instead of the full one.
    # Without this the function only emitted a `compact` event while the model
    # kept receiving the un-compacted `msgs` — so the context never actually
    # shrank and the turn still overflowed. Mirrors llm._auto_compact_subagent.
    _apply_compaction_in_place(msgs, new_history)
    return 1





async def _run_mode_turn(
    state: AgentState,
    mode: str,
    queue: asyncio.Queue,
    extra_instruction: str = "",
    run_flags: dict | None = None,
) -> str:
    """Run ONE LLM turn for ``mode`` with the mode-filtered tools.

    Streams text/tool events into ``queue``. Applies the *essential* resilience:
    live steer injection, interrupted-turn resume, free-tier throttle retry, and
    a bounded context auto-compact. Returns the final reply text.
    """
    chat_id = state.get("chat_id", "")
    ctx = int(state.get("context_window") or 0)
    if ctx <= 0:
        try:
            from providers import model_context

            ctx = await model_context(
                state.get("provider"),
                state.get("model_name"),
                state.get("base_url"),
                state.get("api_key"),
                state.get("env_var"),
                state.get("api_keys"),
            )
        except Exception:  # noqa: BLE001 - context fallback never breaks turn
            ctx = 0
    ctx = max(0, int(ctx or 0))
    cap = state.get("cap") or {}
    root = state.get("root", "")
    # The `mode` parameter is authoritative for THIS turn. `reader_answer` and
    # other nodes mutate `state["mode"]` on the shared LangGraph state, so we
    # copy it and override with the parameter before building the context —
    # otherwise a previous node's mode would leak into this turn's system prompt.
    state = dict(state)
    state["mode"] = mode
    # Reuse the already-resolved window so build_turn_context skips its own
    # model_context network call (duplicate resolution cost every turn).
    if ctx > 0 and not state.get("context_window"):
        state["context_window"] = ctx
    # Ambient chat id for trace_store so sub-agent llm_generate calls (which
    # never receive chat_id explicitly) still land on the right chat.
    _trace_token = None
    try:
        import trace_store as _trace_store

        _trace_token = _trace_store.set_current_chat(str(chat_id or ""))
    except Exception:  # noqa: BLE001 — trace context must never break the turn
        _trace_token = None
    try:
        queue.put_nowait({"kind": "status", "stage": "preparing", "content": "Preparing context"})
    except Exception:  # noqa: BLE001, S110 — progress must never break the turn
        pass
    tctx = await build_turn_context(state, queue)
    try:
        queue.put_nowait({"kind": "status", "stage": "thinking", "content": "Contacting model"})
    except Exception:  # noqa: BLE001, S110 — progress must never break the turn
        pass
    model = tctx["model"]
    # The real model id the LangChain client will hit (e.g. a sub-agent model
    # resolved for web/compact/vision), used to attribute usage correctly.
    model_id = getattr(model, "model_name", None) or state.get("model_name", "")
    lc_tools = tctx["lc_tools"]
    filtered = tctx["tools"]
    mcp_cleanup = tctx.get("mcp_cleanup")
    messages: list[BaseMessage] = list(tctx["messages"])
    # Tracks whether the agent has produced at least one meaningful event
    # (text / tool / thinking / usage) in this turn.  Retry budget below is
    # only spent if this is True — an idle agent (no output yet) failing to
    # start is NOT a transient blip worth 10×15 s of silent retry; the stream
    # should close quietly so the client treats it as a normal drop.
    # A one-element list is the standard Python idiom for a mutable closure
    # variable that nested coroutines can flip without `nonlocal`.
    _agent_produced: list[bool] = [False]

    # --- Patch queue.put_nowait to track agent activity --------------------
    # Tools capture `queue` via `make_tool_callbacks(root, lambda ev:
    # queue.put_nowait(ev), …)`.  The lambda resolves `queue.put_nowait` by
    # attribute lookup at call-time, so monkey-patching the method here is
    # enough to intercept every event the tools emit (tool / tool_result).
    # Text / thinking / usage events are patched inline below.
    _orig_put = queue.put_nowait

    def _put_and_track(ev: object) -> None:
        if isinstance(ev, dict) and ev.get("kind") in (
            "text",
            "tool",
            "tool_result",
            "thinking",
            "usage",
        ):
            _agent_produced[0] = True
        _orig_put(ev)

    queue.put_nowait = _put_and_track  # type: ignore[assignment]

    # Compact model used for in-turn tool-history compaction (spec §10). May be
    # None when the user hasn't configured a compact/subagent model — in that
    # case obsolete tool results are dropped outright instead of summarized.
    compact_model = tctx.get("compact_model")

    if extra_instruction:
        # Inject as HumanMessage (not SystemMessage) so it lands mid-list
        # without violating chat templates that require SystemMessage only
        # at position 0 (Qwen3.5 / llama.cpp raise
        # "System message must be at the beginning" otherwise). Marked as a
        # non-user directive so the model still treats it as guidance.
        messages.insert(
            1,
            HumanMessage(
                content=f"[Earlier context — non-user directive]\n{extra_instruction}"
            ),
        )

    # NOTE: on a (re)started/interrupted turn we intentionally do NOT inject a
    # "here is what you already did" resume note or persist a durable replay
    # file. The model continues from the real message transcript (tool results
    # are already in `messages`); feeding it synthetic learned context on error
    # is undesirable. Transient throttles are retried below without any such
    # injection.

    # No user-configurable step budget: the old 12-50 auto cap cut real
    # tasks in half ("step limit reached" mid-task). A single high internal
    # safety ceiling remains so a model that never stops calling tools (fresh
    # args every step — invisible to the repetition guard) cannot burn
    # unbounded tokens. Real tasks finish in single-digit steps; 200 is a
    # runaway guard, never a task budget.
    MAX_STEPS = 200
    async def _execute_tool(name: str, args: dict, call_id: str = "", step: int = 0) -> str:
        import inspect

        fn = filtered.get(name)
        if fn is None:
            return (
                f"ERROR: unknown tool {name!r}. "
                f"Bound tools: {', '.join(sorted(filtered.keys())) or '(none)'}. "
                "Never claim a listed tool is unavailable — call it directly "
                "and report this exact ERROR if it fails."
            )
        # Trace every tool call with its prompt/args so the Trace panel shows
        # the full request like LangSmith (best-effort, never breaks the turn).
        _tool_entry = None
        try:
            import json as _tjson

            import trace_store as _ts

            try:
                _args_text = _tjson.dumps(args or {}, ensure_ascii=False, sort_keys=True)[:8000]
            except Exception:  # noqa: BLE001
                _args_text = str(args or "")[:8000]
            _tool_summary = f"{name} · step {step}" if step else str(name)
            _tool_entry = _ts.append(
                str(chat_id or ""),
                "tool",
                _tool_summary,
                detail={
                    "name": name,
                    "args": args or {},
                    "call_id": str(call_id or ""),
                    "step": int(step or 0),
                    "model": str(model_id or ""),
                    "status": "running",
                },
                model=str(model_id or ""),
                prompt=_args_text,
            )
        except Exception:  # noqa: BLE001 — trace must never break the tool
            _tool_entry = None
        try:
            if isinstance(fn, StructuredTool):
                res = await fn.ainvoke(args or {})
            elif inspect.iscoroutinefunction(fn):
                res = fn(**(args or {}))
                if inspect.isawaitable(res):
                    res = await res
            else:
                # Sync callable (blocking disk I/O): offload to a worker
                # thread so a sibling sub-agent sharing this event loop is
                # never stalled behind this call. Never takes a shared lock;
                # only the caller sequences _SEQUENTIAL_TOOLS one at a time.
                res = await asyncio.to_thread(fn, **(args or {}))
            try:
                import trace_store as _ts2

                _ts2.finish_tool(str(chat_id or ""), call_id or ((_tool_entry or {}).get("id") if _tool_entry else ""), res)
            except Exception:  # noqa: BLE001, S110
                pass
            return res
        except Exception as exc:  # noqa: BLE001
            try:
                import trace_store as _ts3

                _ts3.finish_tool(str(chat_id or ""), call_id or ((_tool_entry or {}).get("id") if _tool_entry else ""), "", error=f"{type(exc).__name__}: {exc}")
            except Exception:  # noqa: BLE001, S110
                pass
            return f"ERROR running {name}: {exc}"

    def _existing_tool_result(
        tool_call_id: str, name: str | None = None, args: dict | None = None
    ) -> str | None:
        """If the result of this tool call is already in the transcript (msgs),
        return it so the tool isn't run again — this is what stops the repeated
        identical-tool repetition loop.

        Matching is by exact ``tool_call_id`` FIRST (covers the common
        "frontend already sent this toolActivity" case), then by a
        ``(name, args)`` signature. The signature match is what stops the loop
        on a resumed turn: the reloaded checkpointer transcript keeps the
        original tool_call ids, while the model re-issues the SAME call with a
        freshly-minted id. An id-only match would miss it and the tool would
        re-run every time — re-producing (and re-looping on) identical greps.
        Matching on the signature reuses the prior result instead.

        Mutating tools (``_SEQUENTIAL_TOOLS``) are exempt from the signature
        match: re-issuing e.g. ``computer(type_text, "ls")`` is a REAL new
        action on the desktop, not a duplicate read — reusing a stale cached
        result would silently skip the action (and once returned a corrupted
        cached blob). Only the exact tool_call_id match applies to them.
        """
        for m in messages:
            if isinstance(m, ToolMessage) and m.tool_call_id == tool_call_id:
                return m.content
        if name and name not in _SEQUENTIAL_TOOLS:
            _sig = json.dumps(
                {"n": name, "a": args or {}}, sort_keys=True, ensure_ascii=False
            )
            for m in messages:
                if not isinstance(m, AIMessage):
                    continue
                for tc in getattr(m, "tool_calls", None) or []:
                    if (
                        json.dumps(
                            {"n": tc.get("name"), "a": tc.get("args") or {}},
                            sort_keys=True,
                            ensure_ascii=False,
                        )
                        == _sig
                    ):
                        _cid = tc.get("id")
                        for mm in messages:
                            if isinstance(mm, ToolMessage) and mm.tool_call_id == _cid:
                                # A budget refusal is not a result: replaying it
                                # would keep refusing after an edit re-arms the
                                # budget.
                                if _is_search_refusal(mm.content):
                                    break
                                return mm.content
        return None

    # --- Interrupted-turn resume (LangGraph checkpointer) --------------------
    # If a previous turn for this chat was interrupted (user Stop, error, or a
    # disconnect), the full in-flight transcript — including every completed tool
    # call + its result — was persisted to LangGraph's checkpointer. Reload it so
    # this turn CONTINUES from where it stopped instead of redoing the work. The
    # transcript keeps the original tool_call ids, so the loop's result-dedup
    # (by name+args signature) reuses those results rather than re-running them
    # (this is what previously caused the repeated-grep repetition loop). A fresh
    # (non-interrupted) turn has no checkpoint and simply starts from the context
    # built by build_turn_context. We skip this for instruction-augmented turns
    # (reader/explore) which don't interrupt mid-tool-loop.
    _resume_thread = _resume_thread_id(state)
    if state.get("restart"):
        # Explicit user restart (message retry icon): never resume the
        # discarded turn. Clear any stale checkpoint so the fresh run cannot
        # replay old tool work, then start from the newly built context.
        await _clear_turn_checkpoint(_resume_thread)
    elif not extra_instruction:
        # Only resume from a checkpoint that is still fresh: if it is stale
        # (older than the TTL) or oversized (likely a loop), drop it and start
        # fresh instead of replaying a poisoned turn. Mode switches resume too
        # (tool work is reused; the MODE note re-orients the model).
        # See _load_turn_checkpoint_valid for the policy.
        _ckpt_msgs = await _load_turn_checkpoint_valid(
            _resume_thread, current_mode=state.get("mode", "")
        )
        if _ckpt_msgs:
            # New user text ("continue" or a steer/follow-up) must always reach
            # the model; without this a resume silently drops it. Retrying the
            # same text does not duplicate (dedup inside the helper).
            messages = _append_resume_request(
                list(_ckpt_msgs), state.get("request") or ""
            )
            # The checkpoint has no UI checklist statuses — re-attach the
            # latest frontend plan so completed todos are not re-executed.
            # History is otherwise cleared (checkpoint already holds the full
            # transcript) to avoid duplicating the prompt.
            _resume_plan = _latest_plan_from_history(state.get("history"))
            if not _resume_plan:
                # Restart-proof memory: the in-memory checklist dies with the
                # process, but update_plan persists it next to plan.md.
                try:
                    _ws = state_db.workspace_slug_for_root(root)
                    _disk_plan = state_db.get_checklist(_ws, str(chat_id or ""))
                    if _disk_plan and not all(
                        isinstance(it, dict) and it.get("status") == "completed"
                        for it in _disk_plan
                    ):
                        _resume_plan = _disk_plan
                except Exception:  # noqa: BLE001, S110 — fallback never breaks resume
                    pass
            _resume_plan_msg = _plan_status_message(_resume_plan)
            if _resume_plan_msg is not None:
                messages = list(messages) + [_resume_plan_msg]
            # The checkpoint already holds the full in-flight transcript
            # (prompt + tool calls + tool results). Don't also re-pull the
            # frontend history, or we'd duplicate the prompt.
            state["history"] = []

    # Number of agent steps that completed successfully (the model responded)
    # across ALL retry attempts of this turn. The retry wrapper compares it
    # against its last-seen value to detect PROGRESS: an attempt that advanced
    # the turn before failing resets the consecutive-failure counter, so the
    # retry banner counts fresh attempts after each successful connection
    # instead of climbing 6/10 → 7/10 across unrelated failures.
    _step_progress = 0

    async def _inner() -> str:
        nonlocal model, _step_progress, mcp_cleanup
        # NOTE: `msgs` aliases the OUTER `messages` list so completed tool work
        # (tool calls + their results) survives a retry. On a transient throttle
        # we re-run the loop from the SAME accumulated transcript -- the model
        # continues from what it actually did, with no synthetic replay/no
        # "learned" resume note injected.
        msgs = messages
        # Identity snapshot of the seeded transcript (system + history): the
        # plan-draft scans below must only see messages written THIS turn —
        # a previous turn's "## Plan" lives in history as AIMessage and must
        # not satisfy turn-local checks like the scouting budget.
        _turn_seed_ids = set(map(id, msgs))
        steps = 0
        reply = ""
        _no_so = False
        _no_pc = False
        _no_temp = False
        _no_re = 0
        # --- Interrupted-turn resume (durable, step-by-step) -----------------
        # Every completed tool result is persisted to LangGraph's checkpointer
        # (see _save_turn_checkpoint) so a mid-turn disconnect/reconnect can replay
        # the already-done work instead of re-running the tools from scratch.
        # The checkpoint is cleared on a clean finish (see run_graph._drive).
        # --- Repetition-loop guard (opencode-aligned) -----------------------
        # opencode stops a degenerate loop via a step budget + finish_reason=="length"
        # and has no text-comparison guard. We keep a guard but base it on the
        # TOOL-CALL SIGNATURE (name + args), not emitted text: a real loop repeats
        # the SAME tool call with IDENTICAL arguments, whereas genuine multi-step
        # work varies the args (e.g. reading different files). The old text
        # comparison false-positived on models that emit similar phrasing while
        # doing real work.
        _last_tool_sig = ""
        _repeat_count = 0
        _MAX_REPEAT = 3
        # Give-up ceiling for the graceful recovery below: the model ignored
        # the firm "stop tools, summarize" nudge twice more. The turn then ends
        # with a warn (never an error) and whatever was produced so far.
        _MAX_REPEAT_GRACE = 5
        # Cross-step batching tracker: catches the model firing ONE batchable
        # call per step (the common case when parallel_tool_calls is not
        # sent) and reminds it to batch after a few consecutive same-scope
        # steps — the per-step detector alone never sees those.
        _streak = _BatchStreakTracker()
        # Re-touch tracker: catches paging one file window after window (or
        # re-grepping one scope term after term) step after step — the plan
        # scout loop shape. Implemented + tested in llm.py but previously
        # never wired into this loop, so only identical-arg repeats were
        # caught while near-miss repeats looped forever.
        _revisit = _RevisitStreakTracker()
        # Plan-mode scouting budget: tool steps used without writing ## Plan.
        # Breaks the scout -> update_plan(0/N) -> scout cycle deterministically.
        _plan_scout_steps = 0
        # When a recoverable repetition is detected (same tool+args, but still
        # below the hard-stop threshold), we queue a nudge and set this flag so
        # the HumanMessage is appended AFTER the tool results (keeping the
        # transcript valid: a tool_calls AIMessage must be followed by its
        # ToolMessages before any new HumanMessage).
        _nudge_pending = False
        # Firm-recovery flag (see the graceful stop below): a stronger transient
        # "stop calling tools, summarize now" message for a loop that survived
        # the regular nudge. Same transient channel as _nudge_pending.
        _final_nudge_pending = False
        # Batching / repetition reminders are TRANSIENT: sent with the very next
        # request only, never stored in msgs. Stored copies were re-sent on every
        # later step (and saved into the turn history) with no added value.
        _transient_msgs: list[Any] = []
        # رویداد warn تذکر batching فقط یک بار در هر نوبت به UI می‌رود.
        _batch_warned = False
        # Set when a step ended in a provider exception / escalation, so the
        # NEXT iteration re-binds the (possibly param-stripped) main model.
        _prev_step_failed = False
        # Auto-continue guard for max-output truncation (mirrors opencode, which
        # treats finish_reason=="length" as a normal partial stop and keeps
        # generating until the answer is complete instead of ending the turn).
        _auto_cont = 0
        _MAX_AUTO_CONT = 5
        # Plan-mode scouting budget: tool steps allowed before the loop
        # forces ## Plan. Normal plan scouting converges in 2-4 batches;
        # past this the turn is looping, not discovering.
        _PLAN_SCOUT_BUDGET = 8
        _compact_count = 0
        # Per-turn search guard (build only): counts steps that call grep/glob/read
        # without an intervening edit; see _search_gate_text.
        _search_batches = 0
        while steps < MAX_STEPS:
            steps += 1
            _step_t0 = time.monotonic()
            _llm_wait_s = 0.0
            _tool_exec_s = 0.0
            _ckpt_save_s = 0.0
            # Runaway guard (opencode's isLastStep -> MAX_STEPS_PROMPT): on the
            # final allowed step, force the model to stop tool-calling and
            # summarize instead of burning more reads/searches. Without this the
            # loop just breaks at the ceiling and returns an empty reply.
            if steps >= MAX_STEPS:
                msgs.append(AIMessage(content=_agents._MAX_STEPS_PROMPT))
            # Deliver any background sub-agent report that finished since the
            # previous step so the main agent reads it before its next call.
            await _drain_subagent_reports(msgs, chat_id, queue)
            # Live steer injection: user messages typed mid-run.
            steers = await _agents._drain_steer(chat_id)
            if steers:
                # ساخت پیام چندبخشی با همان قرارداد ترن عادی تا عکس هم به مدل برسد
                msgs.append(_steer_to_human_message(steers, steps_taken=steps))
                # ابزارهای همراه steer: اسکیل‌ها به متن تزریق شدند؛ سرورهای MCP
                # باید واقعاً وصل شوند تا ابزارشان قابل فراخوانی باشد.
                _steer_mcp: dict = {}
                _steer_skills: list[str] = []
                for _s in steers:
                    _srv = _s.get("mcp_servers") or {}
                    if isinstance(_srv, dict):
                        _steer_mcp.update(_srv)
                    for _name in _s.get("skills") or []:
                        if _name and _name not in _steer_skills:
                            _steer_skills.append(_name)
                if _steer_mcp:
                    try:
                        _new_tools, _new_cleanup = await build_mcp_tools(
                            _steer_mcp,
                            lambda ev: queue.put_nowait(ev),
                            reserved_names=set(filtered),
                            analyze_images=tctx.get("analyze_images"),
                            chat_id=str(chat_id or ""),
                        )
                        if _new_tools:
                            _browser_live = merge_mcp_tools(filtered, _new_tools, cap)
                            for _t in _new_tools:
                                if _t.name not in {getattr(_x, "name", "") for _x in lc_tools}:
                                    lc_tools.append(_t)
                            msgs.append(
                                HumanMessage(
                                    content=_mcp_tools_note(_new_tools, _browser_live)
                                )
                            )
                            if _new_cleanup is not None:
                                _prev_cleanup = mcp_cleanup
                                if _prev_cleanup is None:
                                    mcp_cleanup = _new_cleanup
                                else:
                                    async def _combined_cleanup(
                                        _a=_prev_cleanup, _b=_new_cleanup
                                    ) -> None:
                                        with contextlib.suppress(Exception):
                                            await _a()
                                        with contextlib.suppress(Exception):
                                            await _b()

                                    mcp_cleanup = _combined_cleanup
                    except Exception:  # noqa: BLE001, S110 — steer must never break the turn
                        pass
                if _steer_skills:
                    try:
                        _skill_section = _build_skills_section(
                            _steer_skills,
                            root,
                            emit=lambda ev: queue.put_nowait(ev),
                        )
                        if _skill_section:
                            msgs.append(HumanMessage(content=_skill_section))
                    except Exception:  # noqa: BLE001, S110 — steer must never break the turn
                        pass
                queue.put_nowait(
                    {"kind": "steer_applied", "ids": [s.get("id", "") for s in steers]}
                )
            # Every step runs on the main model (cheap step routing removed).
            _bind_model = model
            _prev_step_failed = False
            # Usage/trace rows must name the model that ACTUALLY ran.
            model_id = getattr(_bind_model, "model_name", None) or state.get(
                "model_name", ""
            )
            try:
                bound = bind_tools_parallel(_bind_model, lc_tools, not _no_pc)
                ai: Any = None
                _astream_count_local = 0
                _thinking_active = False
                _answer_started = False
                _saw_real_reasoning = False
                _model_reasoning = bool(state.get("model_reasoning"))
                # Literal <think>…</think> tags some models emit inline (DeepSeek/
                # Qwen/llama.cpp). State is preserved across chunks because the tag
                # may span multiple streamed deltas.
                _in_think = False
                _think_buf = ""
                # When pre-answer content is dropped as suspected-CoT (see the
                # two drop sites below), remember when the dropping started so
                # the thinking window is signalled only if the silence lasts —
                # a fast straight-to-text answer must stay signal-free.
                _drop_t0 = 0.0
                # Degenerate text-loop guard: accumulate the visible reply in a
                # buffer and check on every chunk whether the model has started
                # repeating itself verbatim (e.g. "Let me check. Let me check."
                # 80 times). The existing tool-signature guard only watches
                # tool calls, so a no-tool text loop slips through. We check on
                # EVERY chunk (not every Nth) because a fast model can push out
                # a complete 80x loop in fewer than N chunks — a 4-chunk cadence
                # only cuts ~75% of the wasted text, the rest still hits the UI.
                _reply_buf = ""
                _chunk_idx = 0
                # Next buffer length at which the repetition guard re-scans
                # (stride-throttled; see _REPEAT_SCAN_STRIDE).
                _rep_check_at = 0
                # Track the cumulative length of text we've actually emitted as
                # `kind: "text"` events. The stream-end re-emit path (when a
                # reasoning-capable model sent no real reasoning field) needs
                # this to know whether the dropped buffer was already partially
                # flushed — re-emitting the whole ``ai.content`` after a partial
                # emit duplicates everything the user already saw. The int is
                # wrapped in a list so the post-loop block can read it without
                # a `nonlocal` declaration.
                _emitted_text_len: list[int] = [0]
                # Emit the lightweight "thinking" toggle ONLY when the model
                # actually produces reasoning content (a dedicated reasoning
                # field caught by _thinking_from_chunk) — NOT merely because it
                # is flagged reasoning-capable. A reasoning model that goes
                # straight to text (or an auto-think gateway sending no thinking
                # chunks) shows no indicator. The window closes on the first
                # answer text (below) and as a safety net at stream end.

                # ── Pre-flight orphan guard ────────────────────────────────
                # Every AIMessage with tool_calls MUST have a matching
                # ToolMessage for each tool_call_id, or the provider will
                # reject the transcript with a 400 "missing results for
                # tool_call_id(s)" error.  This can happen when compaction
                # splits a step across older/tail, or when a resume
                # checkpoint is missing tool results for later calls.
                # Strip tool_calls from any such assistant messages so the
                # text content is still visible to the model.
                # نگهبان نهایی ترنسکریپت: یکتاسازی شناسهٔ فراخوانی‌ها در کل
                # ترنسکریپت (چک‌پوینت/ادامهٔ turn ممکن است یک call_id را در دو
                # نوبت تکرار کند) → حذف tool_callهای بی‌جواب → یک خروجی به‌ازای
                # هر شناسه. بدون این، provider با 400 «Duplicate
                # function_call_output for call_id» درخواست را رد می‌کند.
                normalize_tool_transcript(msgs)

                # ترتیب پایدار برای کش پرامپت: پیام‌های ابزار بر اساس شناسه
                # مرتب می‌شوند تا جایگشت ترتیب اجرا، پیشوند کش را نشکند.
                request_messages = project_tool_results(_stable_tool_order(msgs))
                if _transient_msgs:
                    request_messages = [*request_messages, *_transient_msgs]
                    # Single-flight reminders (mirrors llm.py's _transient):
                    # each nudge rides exactly ONE request. Without the clear,
                    # every reminder ever raised in the turn was re-sent on
                    # EVERY later step — re-billed each step and drifting past
                    # the AI/tool messages it originally followed.
                    _transient_msgs.clear()
                _llm_t0 = time.monotonic()
                _first_chunk_t = 0.0
                async for chunk in bound.astream(request_messages):
                    if not _first_chunk_t:
                        _first_chunk_t = time.monotonic() - _llm_t0
                    # Check for cancellation at each chunk so the Stop button
                    # properly interrupts the provider call (llama.cpp / local servers).
                    if asyncio.current_task().cancelled():
                        raise asyncio.CancelledError()
                    _astream_count_local += 1
                    # LangChain accumulates streamed deltas via AIMessageChunk.__add__
                    # (the standard, documented mechanism). We rely on it rather than
                    # hand-rolling delta/cumulative detection, which was fragile.
                    ai = chunk if ai is None else ai + chunk
                    # Drop raw chain-of-thought. The backend only emits a
                    # lightweight "thinking" toggle, never the reasoning text.
                    # _thinking_from_chunk catches reasoning surfaced in a
                    # dedicated field (reasoning_content / thinking part /
                    # additional_kwargs) — the OpenAI-compatible subclass in
                    # llm.py normalizes delta.reasoning into that field.
                    if _model_reasoning and _thinking_from_chunk(chunk):
                        _saw_real_reasoning = True
                        if not _thinking_active:
                            _thinking_active = True
                            queue.put_nowait({"kind": "thinking", "active": True})
                        continue
                    content = chunk.content
                    if isinstance(content, str) and content:
                        # Some gateways emit CoT as a literal <think>…</think>
                        # block inside content (LangChain does NOT normalize this
                        # for arbitrary OpenAI-compatible servers), so strip it.
                        content, _in_think, _think_buf = _strip_think_tags(
                            content, _in_think, _think_buf
                        )
                        if not content:
                            continue
                        # First answer token closes the thinking window.
                        if _thinking_active:
                            _thinking_active = False
                            queue.put_nowait({"kind": "thinking", "active": False})
                        # Scan for a degenerate text loop (the model repeating
                        # itself with no tool call). The tool-call guard below
                        # only watches signatures, so this catches the no-tool
                        # case; we abort mid-stream instead of dumping it all.
                        # Stride-throttled (see _REPEAT_SCAN_STRIDE): a repeated
                        # unit is at most 200 chars, so a 240-char stride can
                        # never skip a live loop while a long answer stays
                        # linear instead of quadratic.
                        _reply_buf += content
                        _chunk_idx += 1
                        if len(_reply_buf) >= _rep_check_at:
                            _rep_check_at = len(_reply_buf) + _REPEAT_SCAN_STRIDE
                            if _is_repeating(_reply_buf):
                                queue.put_nowait(
                                    {
                                        "kind": "warn",
                                        "content": (
                                            "The model entered a text repetition loop; "
                                            "showing partial output."
                                        ),
                                    }
                                )
                                break
                        # Gateways that null reasoning_content and stream CoT as
                        # plain content before the real answer: while reasoning is
                        # enabled and we haven't seen a genuine reasoning field,
                        # treat this pre-answer content as thinking and drop it.
                        # Signal the thinking window only if the silence lasts, so
                        # the UI shows "Thinking" instead of a frozen "waiting
                        # for model" pill while the model reasons (closed at
                        # stream end / first real text). Fast answers stay
                        # signal-free.
                        if _model_reasoning and not _saw_real_reasoning:
                            _now = time.monotonic()
                            if not _drop_t0:
                                _drop_t0 = _now
                            if not _thinking_active and _now - _drop_t0 > 5.0:
                                _thinking_active = True
                                queue.put_nowait({"kind": "thinking", "active": True})
                            continue
                        queue.put_nowait({"kind": "text", "content": content})
                        _emitted_text_len[0] += len(content)
                    elif isinstance(content, list):
                        # Anthropic / Gemini stream content as a list of typed
                        # parts (`{"type": "text", "text": …}` /
                        # `{"type": "tool_use", …}`). The text branch here MUST
                        # scrub a leading <think>…</think> opener before the
                        # first streamed part: those providers can emit the
                        # opener as part 0 in a single chunk (no delta), which
                        # the per-chunk _strip_think_tags above would not see
                        # because it runs on the full chunk text, not the
                        # text-part slice. Without this, "<think>answer"
                        # arrives in the UI verbatim on the very first frame.
                        # `ai.tool_calls` (extracted after the stream) carries
                        # the matching tool_use parts — we mirror them as
                        # `kind: "tool"` events here so the UI gets them in
                        # the correct order with the text that prompted them,
                        # instead of racing the tool-execution callback path
                        # which can interleave them.
                        for part in content:
                            if not isinstance(part, dict):
                                continue
                            ptype = part.get("type")
                            if ptype == "text":
                                t = part.get("text") or ""
                                if not t:
                                    continue
                                t = _scrub_think_prefix(t)
                                if not t:
                                    continue
                                if _thinking_active:
                                    _thinking_active = False
                                    queue.put_nowait(
                                        {"kind": "thinking", "active": False}
                                    )
                                _reply_buf += t
                                _chunk_idx += 1
                                if len(_reply_buf) >= _rep_check_at:
                                    _rep_check_at = len(_reply_buf) + _REPEAT_SCAN_STRIDE
                                    if _is_repeating(_reply_buf):
                                        queue.put_nowait(
                                            {
                                                "kind": "warn",
                                                "content": (
                                                    "The model entered a text "
                                                    "repetition loop; showing "
                                                    "partial output."
                                                ),
                                            }
                                        )
                                        break
                                if _model_reasoning and not _saw_real_reasoning:
                                    _now = time.monotonic()
                                    if not _drop_t0:
                                        _drop_t0 = _now
                                    if not _thinking_active and _now - _drop_t0 > 5.0:
                                        _thinking_active = True
                                        queue.put_nowait({"kind": "thinking", "active": True})
                                    continue
                                queue.put_nowait({"kind": "text", "content": t})
                                _emitted_text_len[0] += len(t)
                            elif ptype in ("tool_use", "tool_call"):
                                # Each tool function (via make_tool_callbacks)
                                # emits its own {"kind": "tool"} event during
                                # execution. We do NOT emit here to avoid
                                # duplicate UI cards — this streaming emit AND
                                # the in-tool emit both produced a card with
                                # different IDs (LLM string vs call_id int),
                                # doubling every tool row in the UI.
                                pass
                if ai is None:
                    _llm_wait_s = time.monotonic() - _llm_t0
                    logger.warning(
                        "[step-timing] chat=%s step=%s llm_empty=%.1fs model=%s",
                        str(chat_id or "")[:8],
                        steps,
                        _llm_wait_s,
                        model_id,
                    )
                    break
                _llm_wait_s = time.monotonic() - _llm_t0
                # Safety net for models that only reason and emit no text: make
                # sure the thinking window is always closed at stream end.
                if _thinking_active:
                    _thinking_active = False
                    queue.put_nowait({"kind": "thinking", "active": False})
                # If reasoning was enabled but we never saw a real reasoning field,
                # the pre-answer plain-content we dropped above was actually the
                # answer (opencode sent no reasoning at all). Re-emit it so the
                # user never gets an empty reply.
                if _model_reasoning and not _saw_real_reasoning:
                    # The streaming loop may have emitted SOME of the text
                    # before the loop guard fired (we cut at the first repeat,
                    # not at byte 0), AND may have dropped earlier chunks that
                    # looked like CoT before we knew reasoning was absent. Use
                    # the emitted-text counter to slice off the prefix the UI
                    # already saw, so the re-emit never duplicates any word
                    # the user is currently reading.
                    dropped = _resolve_stream_end_text(
                        ai.content, _emitted_text_len[0]
                    )
                    if dropped and _is_repeating(dropped):
                        queue.put_nowait(
                            {
                                "kind": "warn",
                                "content": (
                                    "The model entered a text repetition loop; "
                                    "showing partial output."
                                ),
                            }
                        )
                        # Truncate to the non-repeating prefix so the user never
                        # sees the full 80x loop dumped at stream end.
                        _unit = min(200, len(dropped) // 3)
                        while _unit >= 20 and _is_repeating(dropped[: _unit * 3]):
                            _unit = max(20, _unit // 2)
                        dropped = (
                            dropped[: _unit * 3] + " … [repetition loop truncated]"
                        )
                    if dropped:
                        queue.put_nowait({"kind": "text", "content": dropped})
                _astream_count_local_val = _astream_count_local
                # Surface token usage so the frontend can show per-model cost in
                # the sidebar and a real consumed-context meter in the title bar.
                usage_ev = _usage_event_from_ai(
                    ai,
                    model_id,
                    state.get("provider", ""),
                    state.get("provider_id", ""),
                )
                # ثبت فراخوانی LLM در trace_store برای پنل Trace — همیشه، حتی وقتی
                # usage_ev خالی است تا پرامپت هر استپ گم نشود (best-effort).
                with contextlib.suppress(Exception):
                    import trace_store

                    _llm_prompt_text = ""
                    try:
                        _parts = []
                        for _m in request_messages or []:
                            _c = getattr(_m, "content", "")
                            _t = type(_m).__name__
                            if isinstance(_c, list):
                                _c = " ".join(str(p.get("text", "")) for p in _c if isinstance(p, dict))
                            _parts.append(f"[{_t}]\n{str(_c)[:4000]}")
                        _llm_prompt_text = "\n\n".join(_parts)[:20000]
                    except Exception:  # noqa: BLE001
                        _llm_prompt_text = ""
                    _uev = usage_ev or {}
                    _utotal = int(_uev.get("total_tokens", 0) or 0)
                    trace_store.append(
                        str(state.get("chat_id", "") or chat_id or ""),
                        "llm",
                        f"{model_id} · step {steps} · {_utotal} tokens",
                        detail={
                            "provider": _uev.get("provider"),
                            "provider_id": _uev.get("provider_id"),
                            "input_tokens": _uev.get("input_tokens", 0),
                            "output_tokens": _uev.get("output_tokens", 0),
                            "total_tokens": _utotal,
                            "cache_read_tokens": _uev.get("cache_read_tokens", 0),
                            "cache_write_tokens": _uev.get("cache_write_tokens", 0),
                            "reasoning_tokens": _uev.get("reasoning_tokens", 0),
                            "step": steps,
                            "has_usage": usage_ev is not None,
                        },
                        model=str(model_id or ""),
                        tokens={
                            "input": _uev.get("input_tokens", 0),
                            "output": _uev.get("output_tokens", 0),
                            "total": _utotal,
                        },
                        prompt=_llm_prompt_text,
                        result=str(getattr(ai, "content", "") or "")[:8000],
                    )
                if usage_ev:
                    # Per-step usage log for cache-hit and token measurement
                    # (no behavior change — observability only). WARNING, not
                    # INFO: the persistent codifa.log handler runs at WARNING+
                    # and the graph logger inherits the root level, so an INFO
                    # line would never appear anywhere in a packaged app.
                    try:
                        logger.warning(
                            "[usage] chat=%s step=%s model=%s input=%s cache_read=%s cache_write=%s output=%s reasoning=%s total=%s",
                            str(state.get("chat_id", "") or chat_id or "")[:8],
                            steps,
                            model_id,
                            usage_ev.get("input_tokens", 0),
                            usage_ev.get("cache_read_tokens", 0),
                            usage_ev.get("cache_write_tokens", 0),
                            usage_ev.get("output_tokens", 0),
                            usage_ev.get("reasoning_tokens", 0),
                            usage_ev.get("total_tokens", 0),
                        )
                    except Exception:  # noqa: BLE001, S110 — logging never breaks turn
                        pass
                    # Track the SAME token breakdown the frontend context meter
                    # shows, so auto-compaction fires off the exact value the meter
                    # displays — they always agree. Use the provider-aware
                    # `total_tokens` from the usage event (which already respects the
                    # additive/subset cache convention) instead of hand-summing the
                    # breakdown: for subset providers (OpenAI/OpenRouter/hy3-free)
                    # cache_read/write is already folded into input_tokens, so a
                    # hand-sum would double-count the cache and make the meter (and
                    # the compaction trigger) report ~2x the real context.
                    state["last_context_tokens"] = usage_ev["total_tokens"]
                    queue.put_nowait(usage_ev)
            except Exception as exc:  # surfaced to the retry wrapper
                # DIAGNOSTIC: log the FULL upstream error so a recurring 400
                # shows the real cause in codifa.log (instead of just the
                # truncated openrouter wrapper that the user sees in the UI).
                logger.warning(
                    "[run_graph] step failed chat_id=%s step=%s exc_type=%s msg=%r",
                    state.get("chat_id", ""),
                    steps,
                    type(exc).__name__,
                    str(exc),
                )
                _prev_step_failed = True
                # A few local OpenAI-compatible servers (old llama.cpp / custom
                # builds) reject `stream_options` even though most accept or
                # ignore it. Retry the current step once with a model built
                # without that param so local-model usage still works.
                if not _no_so and _is_stream_options_error(exc):
                    _no_so = True
                    model = _strip_stream_options(model)
                    continue
                # Some free-tier OpenRouter models (e.g. minimax/minimax-m3:free)
                # reject `parallel_tool_calls` with a 400. opencode routes the
                # same model without the field and works fine. Strip it and
                # retry once so codifa matches opencode's behaviour instead of
                # failing the whole turn on a non-essential OpenAI field.
                if not _no_pc and _is_parallel_calls_error(exc):
                    _no_pc = True
                    model = _strip_parallel_calls(model)
                    continue
                # Dropped connection (network flap / VPN switch / dead keep-alive
                # socket): the pooled sockets are poisoned and every retry on the
                # same pool fails identically until the app restarts. Rebuild the
                # model on a fresh HTTP pool; the retry wrapper then re-runs it.
                if _is_connection_dropped(exc):
                    try:
                        model = rebuild_model_fresh(model)
                        logger.warning(
                            "[run_graph] connection dropped chat=%s: rebuilt model on a fresh HTTP pool",
                            state.get("chat_id", ""),
                        )
                    except Exception:  # noqa: BLE001 — never mask the original error
                        logger.debug("[run_graph] fresh-pool rebuild failed", exc_info=True)
                # 9router-style key fallback: on key errors (invalid/expired/
                # rate-limited) rebuild with the NEXT key and retry the step.
                if _is_key_error(exc):
                    _, _rest = model_key_fallback(model)
                    if _rest:
                        model = _clone_model_with_key(model, _rest[0])
                        continue
                # Some custom / reasoning-only model routes (e.g. o-series
                # style endpoints) reject ``temperature`` with a 400. Strip it
                # and retry once so the turn still works.
                if not _no_temp and _is_temperature_error(exc):
                    _no_temp = True
                    model = _strip_temperature(model)
                    continue
                # Always-thinking routes (e.g. agentrouter) reject
                # reasoning_effort values outside their allowed set with a 400
                # (「该模型始终思考…请使用 low、high 或 max」 or the English
                # "does not support 'max'; supported values are: ..."). Retry
                # with the effort remapped to the nearest allowed value so the
                # turn survives instead of dying on a thinking-mode mismatch.
                # Up to 3 remaps: providers disagree on the top rung ('max' vs
                # 'xhigh'), so one hop may lead to another (high -> max -> xhigh).
                if _no_re < 3 and _is_reasoning_effort_error(exc):
                    _remapped = _remap_reasoning_effort(model, exc)
                    if _remapped is not model and getattr(
                        _remapped, "reasoning_effort", None
                    ) != getattr(model, "reasoning_effort", None):
                        _no_re += 1
                        model = _remapped
                        continue
                # Surface the most common per-step failures as readable SSE
                # events instead of letting them bubble up to _drive as raw
                # tracebacks (the old behavior looked like a silent
                # "instant disconnect" to the user). The checkpoint is left
                # behind so a Retry resumes from the already-done tool work.
                # Timeouts and dropped/refused connections are NOT surfaced here:
                # they re-raise into the run_graph retry loop, which retries up
                # to _RETRY_MAX_ATTEMPTS (10) times, 30s apart, and only then
                # emits `retry_giveup` (checkpoint is kept for a manual Retry).
                raise
            if not getattr(ai, "tool_calls", None):
                meta = getattr(ai, "response_metadata", {}) or {}
                fr = meta.get("finish_reason") or meta.get("finishReason")
                if not fr and isinstance(getattr(ai, "additional_kwargs", None), dict):
                    fr = ai.additional_kwargs.get(
                        "finish_reason"
                    ) or ai.additional_kwargs.get("finishReason")
                _partial = (
                    ai.content if isinstance(ai.content, str) else str(ai.content)
                )
                if fr == "length":
                    # opencode treats length-truncation as a normal (partial) stop
                    # and AUTO-CONTINUES the generation so the answer completes
                    # seamlessly. Mirror that: append the partial reply and loop
                    # again so the model resumes where it left off, instead of
                    # ending the turn and forcing a manual resend.
                    if _auto_cont < _MAX_AUTO_CONT:
                        _auto_cont += 1
                        reply = (reply or "") + _partial
                        msgs.append(AIMessage(content=_partial))
                        continue
                    # Exhausted the auto-continues (the model keeps hitting the
                    # cap): end the turn with a clear note and leave the resume
                    # checkpoint behind so the user can pick up where it stopped.
                    if run_flags is not None:
                        with contextlib.suppress(Exception):
                            run_flags["error"] = True
                    queue.put_nowait(
                        {
                            "kind": "warn",
                            "content": (
                                "Response truncated by the model (max output tokens "
                                "reached). Showing partial output."
                            ),
                        }
                    )
                    reply = (reply or "") + _partial
                    break
                if _is_repeating(_partial):
                    queue.put_nowait(
                        {
                            "kind": "warn",
                            "content": (
                                "The model entered a text repetition loop; "
                                "showing partial output."
                            ),
                        }
                    )
                # --- Empty-response guard ---------------------------------
                # A model (e.g. hy3-free) can return a step with NO tool call
                # and NO meaningful text (finish_reason != "length"). The old
                # code treated that as a clean finish, silently ending the turn
                # and wiping the resume checkpoint — looking like a disconnect
                # to the user. Mirror the length-truncation guard: auto-continue
                # a bounded number of times so the model can actually produce
                # output, and only warn+break if it keeps returning nothing.
                if not _partial.strip() and not (reply or "").strip():
                    if _auto_cont < _MAX_AUTO_CONT:
                        _auto_cont += 1
                        msgs.append(HumanMessage(content="Continue."))
                        continue
                    queue.put_nowait(
                        {
                            "kind": "warn",
                            "content": (
                                "The model returned an empty response; ending "
                                "the turn early."
                            ),
                        }
                    )
                    break
                # Manager gate: the main agent manages its sub-agents and must
                # not write the final answer before their reports arrive and
                # are verified. Drain fast-finished reports even when nothing
                # is still running (pending empty), wait for running jobs,
                # then continue so the model incorporates the reports instead
                # of finalizing without them.
                _fast_reports = await _drain_subagent_reports(msgs, chat_id, queue)
                if await _await_subagent_jobs(chat_id, queue):
                    _draft = (_partial or "").strip()
                    if _draft:
                        msgs.append(AIMessage(content=_partial))
                    _delivered = await _drain_subagent_reports(msgs, chat_id, queue)
                    if _delivered and _draft:
                        # The draft above was written BEFORE the sub-agent
                        # reports arrived. Force a revision pass instead of
                        # letting the premature text stand as final.
                        _transient_msgs.append(
                            HumanMessage(
                                content=(
                                    "Your draft above was written BEFORE "
                                    "background sub-agent reports arrived. "
                                    "Revise it using the reports just "
                                    "delivered; do NOT re-search the delegated "
                                    "scopes yourself."
                                )
                            )
                        )
                    continue
                if _fast_reports:
                    if (_partial or "").strip():
                        msgs.append(AIMessage(content=_partial))
                    continue
                # Completion gate: never end with doable checklist items left.
                # A text-only finish while todos are pending is the classic
                # "half done, user must say continue" symptom. Nudge once more
                # (bounded by _MAX_AUTO_CONT) so the turn finishes the list
                # in THIS turn instead of costing an extra continue round-trip.
                _pending_todos = _latest_plan_from_history(state.get("history"))
                if not _pending_todos:
                    try:
                        import tools as _tools_mod

                        _stored = _tools_mod._PLAN_BY_CHAT.get(str(chat_id or ""), [])
                        if any(isinstance(it, dict) and it.get("status") != "completed" for it in _stored):
                            _pending_todos = _stored
                    except Exception:  # noqa: BLE001, S110 — gate must never break turn
                        pass
                # Plan mode delivers ## Plan plus an all-pending Build
                # checklist: those items are never the planner's work, so a
                # delivered plan ends the turn instead of re-looping it.
                _pending_gate_enabled = False  # TEMP-REVERT-CHECK
                if (
                    _pending_gate_enabled
                    and _pending_todos
                    and _auto_cont < _MAX_AUTO_CONT
                    and not (
                        (mode or "") == "plan"
                        and _plan_draft_in_turn(
                            (reply or "") + (_partial or ""), msgs, _turn_seed_ids
                        )
                    )
                ):
                    _auto_cont += 1
                    if (_partial or "").strip():
                        msgs.append(AIMessage(content=_partial))
                        reply = (reply or "") + _partial
                    _transient_msgs.append(
                        HumanMessage(
                            content=(
                                "You have unfinished checklist items — do NOT end "
                                "the turn yet. Continue working through the "
                                "pending steps with tools until every doable item "
                                "is completed."
                            )
                        )
                    )
                    continue
                reply = (reply or "") + _partial
                break
            # --- Repetition-loop detection (normalized tool-call signature) -----
            # A real loop repeats the SAME tool call on every step. Exact-arg
            # comparison missed the near-miss shape: the model paging ONE file
            # window after window (same path, different offset/limit) looped
            # forever. The signature is normalized per tool (read/grep/glob keep
            # only the file/scope identity), so those near-miss repeats now
            # count. Genuine multi-step work (different files) still never trips
            # this guard.
            _tool_sig = "|".join(
                _normalized_call_sig(tc.get("name") or "", tc.get("args") or {})
                for tc in (ai.tool_calls or [])
            )
            if _tool_sig and _tool_sig == _last_tool_sig:
                _repeat_count += 1
            else:
                _repeat_count = 0
            _last_tool_sig = _tool_sig
            if _repeat_count >= _MAX_REPEAT_GRACE:
                # Give-up ceiling: the model ignored the firm nudge twice more.
                # End the turn GRACEFULLY with whatever was produced so far — a
                # warn, never an error. There is nothing to retry (retrying the
                # identical transcript would loop again), and the next turn
                # starts fresh from history instead of replaying this loop, so
                # run_flags is deliberately left untouched.
                queue.put_nowait(
                    {
                        "kind": "warn",
                        "content": (
                            "Stopped repeating the same tool call — showing "
                            "results so far. Rephrase the request or break it "
                            "into smaller steps to continue."
                        ),
                    }
                )
                break
            elif _repeat_count >= _MAX_REPEAT:
                # Firm recovery instead of a hard error: tell the model plainly
                # to stop calling tools and summarize, then let it continue.
                # The message rides the transient channel (next request only).
                queue.put_nowait(
                    {
                        "kind": "warn",
                        "content": (
                            "Repetition detected: the same tool call was issued "
                            f"{_repeat_count} time(s) in a row with identical "
                            "arguments. STOP calling tools and write a summary "
                            "of what you found so far instead."
                        ),
                    }
                )
                _final_nudge_pending = True
            elif _tool_sig and _repeat_count >= 1:
                # Recoverable repetition: the SAME tool call with IDENTICAL
                # arguments just repeated, but we haven't hit the hard-stop yet.
                # Nudge the model to vary its approach instead of aborting on the
                # first repeat. The nudge HumanMessage is appended after the tool
                # results below (see _nudge_pending) so the transcript stays valid.
                # The model gets (_MAX_REPEAT - 1) chances to break the loop before
                # the hard stop fires. Skip the warn when _repeat_count == 0:
                # that's a fresh tool call, not a repeat (the previous "0 time(s)
                # in a row" message was a confusing false-positive).
                try:
                    _sig = json.loads(_tool_sig)
                    _nudge_tool = _sig[0][0] if _sig else "tool"
                except Exception:  # noqa: BLE001
                    _nudge_tool = "tool"
                queue.put_nowait(
                    {
                        "kind": "warn",
                        "content": (
                            f"Repetition detected: the same tool call ({_nudge_tool}) "
                            f"was issued {_repeat_count} time(s) in a row with "
                            f"identical arguments. Change your approach — use different "
                            f"arguments, a different tool, or stop and report what you "
                            f"found — instead of repeating it."
                        ),
                    }
                )
                _nudge_pending = True
            # tool_callهایی با id تکراری داخل یک پیام، یک ToolMessage مشترک
            # می‌خواهند و provider با «Duplicate function_call_output» ردشان
            # می‌کند — idهای تکراریِ داخل همین پیام را قبل از ثبت یکتا کن.
            _reserved_tc_ids = {
                str(m.tool_call_id)
                for m in msgs
                if isinstance(m, ToolMessage) and m.tool_call_id
            }
            dedupe_step_tool_call_ids(ai, _reserved_tc_ids)
            msgs.append(ai)
            _track_delegated_tasks(chat_id, ai.tool_calls)
            # Partition this step's tool calls: read-only ones (grep/glob/read/
            # web/vision/task/...) run CONCURRENTLY via gather -- they cannot
            # race each other since none of them mutate anything. Mutating /
            # blocking calls (_SEQUENTIAL_TOOLS) still run one at a time, in
            # order, AFTER the concurrent batch, so a write can never race
            # another write and ask_user never overlaps another call. Order in
            # `msgs` doesn't need to match request order -- each ToolMessage
            # carries its own tool_call_id, so the model matches results by id
            # regardless of position.
            _tcs = ai.tool_calls
            # On reconnect/interrupt, history may carry ToolMessages rebuilt
            # from toolActivity. When a tool_call result already exists in the
            # transcript, reuse it instead of re-running (saves context and
            # avoids re-executing completed work).
            # Collect tool_call_ids that already have a ToolMessage in msgs so
            # we can detect when a reuse-by-signature skipped call is missing
            # its result.
            _seen_tc_ids: set[str] = {
                m.tool_call_id for m in msgs if isinstance(m, ToolMessage)
            }
            _pending = []
            for tc in _tcs:
                _tc_id = tc.get("id", "")
                existing = _existing_tool_result(
                    _tc_id, tc.get("name"), tc.get("args")
                )
                if existing is None:
                    _pending.append(tc)
                elif _tc_id not in _seen_tc_ids:
                    # Signature match found a cached result but the NEW
                    # tool_call_id has no matching ToolMessage yet.  Create one
                    # so the API doesn't reject the transcript with "missing
                    # results for tool_call_id(s)".
                    append_tool_result(msgs, str(existing), _tc_id)
            # ── Deduplicate identical tool calls in the main agent loop ──
            # The model sometimes outputs the same (name, args) pair twice in
            # one step. Execute each unique call once and reuse the result for
            # the duplicates to save I/O, token cost, and avoid duplicate UI
            # sidecar events.
            _dup_ids: dict[str, str] = {}  # duplicate id → original id
            _seen_sigs: dict[str, str] = {}
            _deduped: list = []
            for _tc in _pending:
                _sig = (
                    f"{_tc.get('name')}:"
                    f"{json.dumps(_tc.get('args') or {}, sort_keys=True, ensure_ascii=False)}"
                )
                _orig_id = _seen_sigs.get(_sig)
                if _orig_id is not None:
                    _dup_ids[_tc.get("id", "")] = _orig_id
                else:
                    _seen_sigs[_sig] = _tc.get("id", "")
                    _deduped.append(_tc)
            if _dup_ids:
                import logging as _log
                _log.getLogger(__name__).info(
                    "deduped %d duplicate tool calls in main agent step",
                    len(_dup_ids),
                )
            _pending = _deduped
            # Build search guard: refuse search calls past the budget (the
            # advisory nudge below is ignored by weaker models). Other calls in
            # the same step still run; any edit re-arms the budget.
            _gate_text = _search_gate_text(
                mode,
                _search_batches,
                [(tc.get("name") or "") for tc in _pending],
                msgs,
            )
            if _gate_text:
                queue.put_nowait({"kind": "warn", "content": _gate_text})
                _kept_calls = []
                for _tc in _pending:
                    if (_tc.get("name") or "") in _SEARCH_TOOLS:
                        append_tool_result(msgs, _gate_text, _tc.get("id", ""))
                    else:
                        _kept_calls.append(_tc)
                _pending = _kept_calls
            # NOTE: Each tool function (via make_tool_callbacks) emits its own
            # {"kind": "tool"} event internally. We do NOT emit here to avoid
            # duplicate UI cards — previously this pre-execution emit AND the
            # in-tool emit both produced a card, doubling every tool row.
            _parallel = [
                tc for tc in _pending if (tc.get("name") or "") not in _SEQUENTIAL_TOOLS
            ]
            _sequential = [
                tc for tc in _pending if (tc.get("name") or "") in _SEQUENTIAL_TOOLS
            ]
            # Back-to-back greps on one scope run as ONE scan: merge first
            # so the trace shows one row and the transcript carries the
            # block once (siblings get a pointer). Habits are still tracked
            # on the original calls; the merge advice runs on the merged
            # list so it never re-suggests what the loop just did.
            _exec_calls, _expand_merged = merge_same_scope_greps(_parallel)
            # Always observe — `or` would short-circuit the tracker whenever
            # the per-step detector fires, so that step would never be
            # recorded and the cross-step count would restart from zero.
            _step_hint = _batchable_nudge([*_exec_calls, *_sequential])
            _streak_hint = _streak.observe(_pending)
            _revisit_hint = _revisit.observe(_pending)
            # Join, never `or`: one pattern trips several trackers at once
            # and each reminder matters (see llm.py).
            _batch_hint = "\n".join(
                h for h in (_step_hint, _streak_hint, _revisit_hint) if h
            )
            # Plan-mode scouting budget: force convergence to ## Plan instead
            # of scouting forever. Counts tool steps taken while no ## Plan
            # exists yet this turn; past the budget, nudge every 4th step.
            # Once a draft exists, stop further scouting so a second copy is
            # never generated in the first place (no post-hoc dedupe needed).
            _plan_scout_hint = ""
            _plan_done_hint = ""
            if mode == "plan" and _pending:
                _plan_written = _plan_draft_in_turn(reply, msgs, _turn_seed_ids)
                if not _plan_written:
                    _plan_scout_steps += 1
                    if _plan_scout_steps >= _PLAN_SCOUT_BUDGET and (
                        (_plan_scout_steps - _PLAN_SCOUT_BUDGET) % 4 == 0
                    ):
                        _plan_scout_hint = (
                            "SCOUTING BUDGET: you have used "
                            f"{_plan_scout_steps} tool steps without writing "
                            "## Plan. Write ## Plan NOW from what you hold "
                            "(one bullet per file + test commands); do only "
                            "targeted follow-up reads for files the plan names."
                        )
                else:
                    _plan_done_hint = (
                        "PLAN ALREADY WRITTEN: do NOT write another ## Plan copy "
                        "and do NOT call more search tools. Finalize the turn now "
                        "with the single plan you already wrote."
                    )
            async def _run_readonly(tc, _steps=steps) -> str:
                return await _execute_tool(
                    tc.get("name") or "", tc.get("args") or {}, tc.get("id") or "", _steps
                )

            _tool_t0 = time.monotonic()
            _results = await execute_readonly_calls(_exec_calls, _run_readonly)
            _expanded = _expand_merged(_results)
            for tc, result in zip(_parallel, _expanded):
                _cid = tc.get("id", "")
                append_tool_result(msgs, str(result), _cid)
            # Persist the completed parallel tool work ATOMICALLY — save once
            # after ALL results are appended so a crash never leaves a
            # half-finished checkpoint that orphans tool_calls on resume.
            # The `_valid` variant patches any not-yet-run sequential call
            # of this step with a placeholder so the saved transcript is
            # ALWAYS provider-valid (a resume never trips the "tool_calls
            # must be followed by tool messages" rejection).
            if _parallel:
                await _save_turn_checkpoint_valid(
                    _resume_thread, msgs, _sequential, mode=mode
                )
            for _seq_idx, tc in enumerate(_sequential):
                name = tc.get("name") or ""
                args = tc.get("args") or {}
                # The tool callback emits its own `tool` / `tool_result` events
                # (via the emit callback wired into make_tool_callbacks), so we
                # only execute it and feed the result back to the model.
                result = await _execute_tool(name, args, tc.get("id") or "", steps)
                _cid = tc.get("id", "")
                append_tool_result(msgs, str(result), _cid)
                # Persist this completed (mutating) tool result too — the
                # remaining sequential calls of this step get placeholders.
                # Force the save on the LAST sequential call so the turn-end
                # state is always durable despite throttling.
                await _save_turn_checkpoint_valid(
                    _resume_thread, msgs, _sequential[_seq_idx + 1:],
                    force=_seq_idx == len(_sequential) - 1, mode=mode,
                )
            # Emit ToolMessages for duplicate tool calls that were deduped above
            # so the LLM sees a result for every tool_call_id it originally sent.
            if _dup_ids:
                for _dup_id, _orig_id in _dup_ids.items():
                    for _m in reversed(msgs):
                        if (
                            isinstance(_m, ToolMessage)
                            and getattr(_m, "tool_call_id", "") == _orig_id
                        ):
                            append_tool_result(msgs, _m.content, _dup_id)
                            break
            # Batching reminder: delivered as its OWN HumanMessage AFTER the
            # tool results (same placement as the repetition warning below) —
            # a standalone message is impossible to miss, unlike a suffix at
            # the end of a huge result. Surfaced to the user once per turn so
            # the UI shows the nudge is actually firing.
            if _batch_hint:
                if not _batch_warned:
                    _batch_warned = True
                    queue.put_nowait(
                        {"kind": "warn", "content": _batch_hint.strip()}
                    )
                _transient_msgs.append(HumanMessage(content=_batch_hint.strip()))
            # Per-turn search guard: build refuses past the budget (the gate
            # before execution enforces it); plan converges via the scout
            # budget above; ask gets a soft model-visible nudge so discovery
            # converges instead of spraying searches step after step.
            _step_names = {(tc.get("name") or "") for tc in (_pending or [])}
            if (mode or "") == "build":
                if _step_names & _EDIT_TOOLS:
                    _search_batches = 0
                elif _step_names & _SEARCH_TOOLS:
                    _search_batches += 1
                    if _search_batches >= _MAX_SEARCH_BATCHES_WITHOUT_EDIT:
                        _search_msg = _search_refusal_text(_search_batches, msgs)
                        queue.put_nowait({"kind": "warn", "content": _search_msg})
                        _transient_msgs.append(HumanMessage(content=_search_msg))
            elif (mode or "") == "ask" and _step_names & _SEARCH_TOOLS:
                _search_batches += 1
                _soft_msg = _soft_search_nudge("ask", _search_batches)
                if _soft_msg:
                    queue.put_nowait({"kind": "warn", "content": _soft_msg})
                    _transient_msgs.append(HumanMessage(content=_soft_msg))
            if _plan_scout_hint:
                queue.put_nowait(
                    {"kind": "warn", "content": _plan_scout_hint.strip()}
                )
                _transient_msgs.append(HumanMessage(content=_plan_scout_hint.strip()))
            if _plan_done_hint:
                _transient_msgs.append(HumanMessage(content=_plan_done_hint))
            if _is_plan_only_step(_pending):
                # Solo update_plan costs a full round-trip. Outside plan mode,
                # nudge unless the tick marks progress; inside plan mode the
                # initial checklist AFTER ## Plan (and any progress tick) is
                # legitimate, while a pending-only checklist DURING scouting
                # is the scout -> tick(0/N) -> scout loop.
                if (mode or "") == "plan":
                    _wasteful = _plan_scout_checklist_wasteful(
                        _pending, reply, msgs, _turn_seed_ids
                    )
                else:
                    _wasteful = not _plan_only_step_marks_progress(_pending)
                if _wasteful:
                    _transient_msgs.append(HumanMessage(content=_PLAN_ONLY_NUDGE))
            # Recoverable-repetition nudge: appended AFTER the ToolMessages so the
            # transcript stays valid (a tool_calls AIMessage must be followed by its
            # ToolMessages before any new HumanMessage). Gives the model a chance to
            # self-recover from a doom loop before the hard stop at _MAX_REPEAT.
            if _nudge_pending:
                _nudge_pending = False
                _transient_msgs.append(
                    HumanMessage(
                        content=(
                            "REPETITION WARNING: you called the same tool with "
                            "identical arguments multiple times in a row. Do something "
                            "different (new arguments, a different tool, or conclude the "
                            "task) — do NOT repeat the same call again."
                        )
                    )
                )
            # Firm-recovery nudge (see the graceful stop above): after the loop
            # survived the regular nudge, order the model to stop tool-calling
            # and summarize. Same transient channel — next request only.
            if _final_nudge_pending:
                _final_nudge_pending = False
                _transient_msgs.append(
                    HumanMessage(
                        content=(
                            "FINAL WARNING: you repeated the same tool call with "
                            "identical arguments on consecutive steps. Do NOT "
                            "call any tool on the next step — write a text "
                            "summary of your findings so far instead."
                        )
                    )
                )
            # In-turn context management: single entry-point driven by the
            # user's compact_at_percent setting.  _maybe_auto_compact handles
            # BOTH cheap truncation (old ToolMessage placeholders) AND heavier
            # LLM summarization when the threshold is crossed.
            if ctx > 0 and _compact_count < _MAX_COMPACT_PER_TURN:
                _compacted = await _maybe_auto_compact(
                    state,
                    queue,
                    model,
                    compact_model,
                    msgs,
                    ctx,
                    last_context_tokens=state.get("last_context_tokens"),
                    compact_at_percent=state.get("compact_at_percent", 80),
                )
                _compact_count += _compacted
            # This step completed (the model responded and any tool calls
            # ran) — record the progress so the retry wrapper can tell a
            # mid-work failure from an idle one.
            _tool_exec_s = time.monotonic() - _tool_t0
            _step_total_s = time.monotonic() - _step_t0
            try:
                _first_s = _first_chunk_t if _first_chunk_t else _llm_wait_s
                _slow_step = (
                    _step_total_s > 15.0 or _llm_wait_s > 30.0 or _tool_exec_s > 10.0
                )
                (logger.warning if _slow_step else logger.info)(
                    "[step-timing] chat=%s step=%s total=%.1fs llm=%.1fs first_chunk=%.1fs tools=%.1fs n_tools=%s model=%s",
                    str(chat_id or "")[:8],
                    steps,
                    _step_total_s,
                    _llm_wait_s,
                    _first_s,
                    _tool_exec_s,
                    len(_pending or []),
                    model_id,
                )
            except Exception:  # noqa: BLE001, S110 — timing never breaks turn
                pass
            _step_progress += 1
        # Final delivery: a report that landed while the last step ran, or a
        # turn that ended with jobs still in flight, must never be
        # silently dropped. Wait, then inject whatever arrived; while jobs are
        # still running, wait again (bounded rounds, each emitting a
        # still-waiting status) instead of finalizing early. If reports
        # arrived after the last model step, the model never saw them — fold
        # them into the reply so the sub-agent work is visible instead of
        # being consumed and lost.
        await _await_subagent_jobs(chat_id, queue)
        _n_before = len(msgs)
        _final_reports = await _drain_subagent_reports(msgs, chat_id, queue)
        _wait_round = 0
        while (
            _subagent_pending_count(chat_id) > 0
            and _wait_round < _SUBAGENT_FINAL_WAIT_ROUNDS
        ):
            _wait_round += 1
            await _await_subagent_jobs(chat_id, queue)
            _final_reports += await _drain_subagent_reports(msgs, chat_id, queue)
        if _final_reports:
            _tails = []
            for _m in msgs[_n_before:]:
                _c = getattr(_m, "content", "")
                if isinstance(_c, str) and _c.strip():
                    _tails.append(_c.strip())
            if _tails:
                reply = ((reply or "") + "\n\n" + "\n\n".join(_tails)).strip()
        return reply

    # Unified retry: ANY transient provider failure (429 throttle, 5xx, timeout,
    # network blip) is retried up to the budget with capped exponential backoff
    # (see agents._retry_delay), so the turn keeps trying to continue instead
    # of giving up on the first blip. Hard failures
    # (bad request / quota exhausted / auth) surface as a fatal error event
    # without burning the retry budget.
    # Subagent runs use mode "subagent"; the main turn uses
    # ask/build/plan/reader. Tag retry events only for subagents so the UI can
    # show "Sub-agent failed — using main model" instead of a generic hiccup.
    def _retry_event_agent(state):
        mode = state.get("mode")
        return mode if mode in ("subagent",) else ""

    reply = ""
    # Whole-turn wall: counts IDLE failures only (attempts that made no
    # progress since the previous failure). A productive failure — the model
    # connected and completed real steps before dying — restarts the
    # consecutive counter instead and does NOT burn this wall, because real
    # work was done. Idle spinning against a dead provider still gives up
    # after _RETRY_MAX_ATTEMPTS, so the loop can't retry forever.
    _total_failures = 0
    # Log every attempt start so the user can verify from the sidecar log
    # that retries are actually firing. The renderer-side Network tab CAN'T
    # see these requests: they originate from the Python sidecar subprocess
    # (Electron main spawns it as a child), so they don't pass through the
    # renderer's fetch pipeline. The RetryBanner UI shows the same counter
    # (`4/10`); the log is the source of truth for "did the request actually
    # reach the provider or fail before the HTTP layer".
    chat_id = state.get("chat_id", "")
    logger.info("[run_graph] agent run starting (chat_id=%s)", chat_id)
    attempt = 0
    try:
        while True:
            attempt += 1
            logger.info(
                "[run_graph] agent run attempt %s/%s (chat_id=%s)",
                attempt,
                _agents._RETRY_MAX_ATTEMPTS,
                chat_id,
            )
            try:
                reply = await _inner()
                break
            except Exception as exc:  # noqa: BLE001
                # A client abort (CancelledError) means the user closed the stream —
                # do NOT retry or emit an error event (it would never be read anyway,
                # since the SSE socket is already torn down). Just stop cleanly.
                if isinstance(exc, asyncio.CancelledError):
                    # Flag the interruption so we LEAVE the resume checkpoint behind
                    # (a reconnect can replay the already-done tool work). Without
                    # this the clean-finish path below would wipe it.
                    if run_flags is not None:
                        with contextlib.suppress(Exception):
                            run_flags["cancelled"] = True
                    break
                # Progress-aware retry reset: if the failed attempt actually
                # advanced the turn (the model connected and completed steps
                # before the error), THIS failure counts as 1 of a fresh
                # consecutive cycle — the user sees "retrying 1/10", not
                # "7/10" for an unrelated later blip — and does not burn the
                # idle-failure wall, because real work was done.
                if _step_progress > 0:
                    _step_progress = 0
                    attempt = 1
                else:
                    _total_failures += 1
                # Context overflow: the transcript exceeds the provider's window.
                # Compact the history and retry immediately (no blind backoff).
                if _agents._is_context_overflow(exc):
                    logger.warning(
                        "[run_graph] context overflow (chat_id=%s); "
                        "attempting emergency compact before retry",
                        state.get("chat_id", ""),
                    )
                    try:
                        if ctx > 0:
                            await _maybe_auto_compact(
                                state,
                                queue,
                                model,
                                compact_model,
                                messages,
                                ctx,
                                last_context_tokens=state.get(
                                    "last_context_tokens"
                                ),
                                compact_at_percent=1,  # force: compact if >1% full
                            )
                    except Exception:
                        logger.debug(
                            "[run_graph] emergency compact failed", exc_info=True
                        )
                    # Retry immediately — compaction already fired.
                    delay = 0
                    logger.info(
                        "[run_graph] compacted after overflow, retrying in %ss "
                        "(chat_id=%s attempt=%d/%d)",
                        delay,
                        state.get("chat_id", ""),
                        attempt + 1,
                        _agents._RETRY_MAX_ATTEMPTS,
                    )
                    await asyncio.sleep(delay)
                    continue
                # Hard, non-recoverable failures: don't retry (would fail identically).
                if _agents._is_quota_exhausted(exc) or not _agents._is_retryable(exc):
                    queue.put_nowait(
                        {
                            "kind": "error",
                            "content": _agents._friendly_retry_reason(exc),
                        }
                    )
                    # Mark the turn as failed so run_graph._drive leaves the
                    # durable resume file behind (a reconnect/retry can replay the
                    # already-done tool work instead of re-running it from zero).
                    # `run_flags` is the SAME mutable dict seeded on `initial`
                    # (passed through from the node), so this reaches _drive.
                    if run_flags is not None:
                        try:
                            run_flags["hard_error"] = True
                        except Exception:  # noqa: BLE001, S110
                            pass
                    break
                # Transient failure: retry up to the budget, 30s apart. The
                # give-up fires when EITHER the consecutive-failure budget is
                # exhausted OR the whole-turn failure wall is hit.
                if (
                    attempt >= _agents._RETRY_MAX_ATTEMPTS
                    or _total_failures >= _agents._RETRY_MAX_ATTEMPTS
                ):
                    # Budget exhausted — surface the error to the user.
                    # Surface the exhausted retry in codifa.log (not just as an SSE
                    # event) so a cut-off turn is diagnosable without scraping the
                    # stream. Timeouts here are the classic "turn cut off after a
                    # long silent step" symptom.
                    logger.warning(
                        "[run_graph] agent run failed after %s attempts "
                        "(chat_id=%s attempt=%s): %s",
                        attempt,
                        state.get("chat_id", ""),
                        attempt,
                        _agents._friendly_retry_reason(exc),
                    )
                    queue.put_nowait(
                        {
                            "kind": "retry_giveup",
                            "attempt": attempt,
                            "max_attempts": _agents._RETRY_MAX_ATTEMPTS,
                            "reason": _agents._friendly_retry_reason(exc),
                            "agent": _retry_event_agent(state),
                        }
                    )
                    # Mark the turn as failed so run_graph._drive leaves the
                    # durable resume file behind (a reconnect/retry can replay the
                    # already-done tool work instead of re-running it from zero).
                    if run_flags is not None:
                        with contextlib.suppress(Exception):
                            run_flags["error"] = True
                    break
                try:
                    delay = _agents._retry_delay(attempt)
                except Exception:  # noqa: BLE001 — backoff never breaks retry
                    delay = 30.0
                if not isinstance(delay, (int, float)) or delay < 0:
                    delay = 30.0
                # Log each retry to codifa.log so a "no network entries in
                # DevTools" symptom is diagnosable. The retry's provider
                # HTTP request fires from the sidecar subprocess, which the
                # renderer-side Network tab CANNOT see (Electron spawns
                # the Python sidecar as a child process; the renderer's
                # fetch pipeline only sees requests made by the renderer
                # itself). The RetryBanner counter (`4/10`) is the
                # in-UI confirmation; this log line is the source of
                # truth for "did the request actually reach the provider".
                logger.warning(
                    "[run_graph] agent run failed (chat_id=%s attempt=%s/%s): %s — retrying in %ss",
                    state.get("chat_id", ""),
                    attempt,
                    _agents._RETRY_MAX_ATTEMPTS,
                    _agents._friendly_retry_reason(exc),
                    delay,
                )
                queue.put_nowait(
                    {
                        "kind": "retry",
                        "attempt": attempt,
                        "max_attempts": _agents._RETRY_MAX_ATTEMPTS,
                        "delay": delay,
                        "reason": _agents._friendly_retry_reason(exc),
                        "agent": _retry_event_agent(state),
                        # A backend-driven retry (transient 429/5xx/timeout) is
                        # a self-heal, not a user-triggered restart: the agent
                        # will resume from the existing transcript. The frontend
                        # branches on `reconnecting` to keep the already-
                        # streamed text and tool timeline; without this flag it
                        # wipes the partial reply, which made the user see the
                        # message vanish while the agent was clearly still
                        # working.
                        "reconnecting": True,
                    }
                )
                # Heartbeat during backoff so a 30-60s wait stays visible
                # in trace/chat instead of looking like a dead turn.
                _remaining = float(delay or 0)
                while _remaining > 0:
                    _chunk = min(10.0, _remaining)
                    await asyncio.sleep(_chunk)
                    _remaining -= _chunk
                    if _remaining > 0:
                        with contextlib.suppress(Exception):
                            queue.put_nowait(
                                {
                                    "kind": "status",
                                    "stage": "retry-wait",
                                    "content": f"Retrying in {int(_remaining)}s (attempt {attempt}/{_agents._RETRY_MAX_ATTEMPTS})",
                                }
                            )
                continue
    finally:
        # Close every opened MCP session so stdio subprocesses / HTTP
        # connections don't leak across turns.
        if mcp_cleanup is not None:
            with contextlib.suppress(Exception):
                await mcp_cleanup()
        try:
            import trace_store as _trace_store2

            if _trace_token is not None:
                _trace_store2.reset_current_chat(_trace_token)
        except Exception:  # noqa: BLE001, S110
            pass
    # opencode-style proactive auto-compaction: once the conversation reaches the
    # usable window, summarize the older turns and tell the frontend to fold.
    if reply and ctx and ctx > 0:
        with contextlib.suppress(Exception):
            await _maybe_auto_compact(
                state,
                queue,
                model,
                compact_model,
                messages,
                ctx,
                last_context_tokens=state.get("last_context_tokens"),
                compact_at_percent=state.get("compact_at_percent", 80),
            )
    # Clean finish: drop the interrupted-turn resume checkpoint so a LATER turn for
    # this chat starts fresh instead of mistakenly resuming this completed one. We
    # only clear on a GENUINE clean finish — no error, no hard failure, and no
    # cancellation. On any of those we LEAVE the checkpoint behind so a
    # reconnect/retry resumes the already-done tool work from the checkpointer.
    _rf = run_flags or {}
    if not (_rf.get("error") or _rf.get("hard_error") or _rf.get("cancelled")):
        await _clear_turn_checkpoint(_resume_thread)
        with contextlib.suppress(Exception):
            await _checkpoint_janitor()
    return reply


# ---------------------------------------------------------------------------
# Test command detection + Test / Debug / Review nodes
# ---------------------------------------------------------------------------


def detect_test_commands(root: str) -> list[str]:
    """Return every test/build/type-check command for languages present in root.

    Multi-language aware: a workspace may contain a Python backend, a JS/TS
    frontend, a Rust crate, etc. Each detected language contributes its own
    command so the test gate covers the whole project, not just one stack.
    """
    import os

    cmds: list[str] = []

    # --- Python (uv is preferred per AGENTS.md) ---
    if os.path.isfile(os.path.join(root, "uv.lock")) or os.path.isfile(
        os.path.join(root, "pyproject.toml")
    ):
        cmds.append("uv run pytest")
    elif os.path.isfile(os.path.join(root, "pytest.ini")) or os.path.isfile(
        os.path.join(root, "setup.py")
    ):
        cmds.append("python -m pytest")

    # --- Node / JS / TS (framework-aware) ---
    pkg = os.path.join(root, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, encoding="utf-8") as _f:
                data = json.loads(_f.read())
        except Exception:  # noqa: BLE001
            data = {}
        if isinstance(data, dict):
            scripts = data.get("scripts") or {}
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            has = lambda n: n in deps
            # Avoid double-running a Python suite that a node script merely delegates to.
            python_cmd_added = any(
                c.startswith(("uv run pytest", "python -m pytest")) for c in cmds
            )
            for key in scripts:
                if not re.match(r"^test(\b|:)", key):
                    continue
                val = str(scripts[key])
                if python_cmd_added and (
                    "pytest" in val or "python -m unittest" in val
                ):
                    continue
                cmds.append(f"npm run {key}")
            test_script = str(scripts.get("test", ""))
            if test_script:
                # The `test` script is already covered by the loop above; only
                # infer a runner-specific command when there is no `test` script.
                pass
            elif has("vitest"):
                cmds.append("npx vitest run")
            elif has("jest") or has("react-scripts"):
                cmds.append("npx jest")
            elif has("@playwright/test"):
                cmds.append("npx playwright test")
            elif has("cypress"):
                cmds.append("npx cypress run")

    # --- Rust ---
    if os.path.isfile(os.path.join(root, "Cargo.toml")):
        cmds.append("cargo test")

    # --- Go ---
    if os.path.isfile(os.path.join(root, "go.mod")):
        cmds.append("go test ./...")

    # --- Java (Maven / Gradle) ---
    if os.path.isfile(os.path.join(root, "pom.xml")):
        cmds.append("mvn -q test")
    if os.path.isfile(os.path.join(root, "build.gradle")) or os.path.isfile(
        os.path.join(root, "build.gradle.kts")
    ):
        cmds.append("./gradlew test")

    # --- .NET ---
    try:
        if any(f.endswith((".csproj", ".sln")) for f in os.listdir(root)):
            cmds.append("dotnet test")
    except OSError:
        pass

    # --- Ruby ---
    if os.path.isfile(os.path.join(root, "Gemfile")):
        cmds.append("bundle exec rspec")
    if os.path.isfile(os.path.join(root, "Rakefile")):
        cmds.append("rake test")

    # --- PHP ---
    if os.path.isfile(os.path.join(root, "composer.json")):
        cmds.append("vendor/bin/phpunit")

    # --- Elixir ---
    if os.path.isfile(os.path.join(root, "mix.exs")):
        cmds.append("mix test")

    # --- Dart / Flutter ---
    if os.path.isfile(os.path.join(root, "pubspec.yaml")):
        try:
            with open(os.path.join(root, "pubspec.yaml"), encoding="utf-8") as _f:
                _pub = _f.read()
            if "flutter:" in _pub or "sdk: flutter" in _pub:
                cmds.append("flutter test")
            else:
                cmds.append("dart test")
        except OSError:
            cmds.append("dart test")

    # --- C / C++ ---
    if os.path.isfile(os.path.join(root, "CMakeLists.txt")):
        cmds.append("ctest --output-on-failure")
    elif os.path.isfile(os.path.join(root, "Makefile")):
        cmds.append("make test")
    # C/C++ files without CMake/Make have no standard test runner; leave cmds
    # empty so the Build is told there are no project tests to run.

    return cmds


def detect_frontend_stack(root: str) -> str:
    """Best-effort label like 'React + Vite (vitest)' or '' if no frontend.

    Reads package.json deps to identify the framework (React/Vue/Svelte/
    Next/Angular) and the test runner (vitest/jest/playwright/cypress) so the
    agent can be told exactly which testing library and command to use.
    """
    import json
    import os

    pkg = os.path.join(root, "package.json")
    if not os.path.isfile(pkg):
        return ""
    try:
        with open(pkg, encoding="utf-8") as _f:
            data = json.loads(_f.read())
    except Exception:  # noqa: BLE001
        return ""
    if not isinstance(data, dict):
        return ""
    deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
    has = lambda n: n in deps
    runner = (
        "vitest"
        if has("vitest")
        else (
            "jest"
            if has("jest") or has("react-scripts")
            else (
                "playwright"
                if has("@playwright/test")
                else "cypress"
                if has("cypress")
                else ""
            )
        )
    )
    if has("next"):
        fw = "Next.js"
    elif has("vue"):
        fw = "Vue"
    elif has("svelte") or has("@sveltejs/kit"):
        fw = "Svelte"
    elif has("@angular/core"):
        fw = "Angular"
    elif has("react"):
        fw = "React"
    else:
        return ""
    return f"{fw} ({runner})" if runner else f"{fw}"


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------


def router(state: AgentState) -> dict:
    """Determine the requested mode (ASK / PLAN / BUILD / READER).

    The UI/toolbar mode is authoritative. We only honor an explicit slash
    command (/plan, /code, /ask, /reader) in the prompt — never infer the
    mode from keywords like "write/fix/edit" (that would override the user's
    explicit Plan selection and make the agent think it's in Build).
    """
    prompt = state.get("request", "") or ""
    text = prompt.strip().lower()
    if text.startswith("/plan") and (len(text) == 5 or text[5] in " \n\t"):
        return {"mode": "plan"}
    if text.startswith("/code") and (len(text) == 5 or text[5] in " \n\t"):
        return {"mode": "build"}
    if text.startswith("/ask") and (len(text) == 4 or text[4] in " \n\t"):
        return {"mode": "ask"}
    if text.startswith("/reader") and (len(text) == 7 or text[7] in " \n\t"):
        return {"mode": "reader"}
    # UI mode wins — no keyword inference (fixes mode confusion bug).
    return {"mode": _agents.normalize_mode(state.get("mode", "ask"))}


async def ask_node(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "ask", queue, run_flags=state.get("_run_flags"))
    return {"final_response": reply}


async def build_entry(state: AgentState) -> dict:
    # If a plan already exists (in state or persisted), Build implements from it
    # and skips the repo-discovery pipeline. Otherwise Build runs discovery just
    # like plan, then implements from the gathered context. The build->test->
    # debug->build loop never re-enters this node, so discovery runs at most once.
    return {}


def _route_build_entry(state: AgentState) -> str:
    # Build now performs its own repo exploration via grep/glob/read tools
    # directly (OpenCode-style), so it never needs the removed discovery
    # pipeline. It simply implements (from a plan when one exists).
    return "build"


async def build_node(state: AgentState) -> dict:
    queue = state["_queue"]
    recorder = _RecordingQueue(queue)
    # Same-run approved plan: plan_build ran just before in this graph run,
    # so the plan lives in state (not yet in history, and disk lookup alone
    # is not enough to orient the model). Hand it explicitly so Build
    # implements instead of writing a new '## Plan' document.
    approved_plan = state.get("plan") or ""
    extra = ""
    if isinstance(approved_plan, str) and approved_plan.strip():
        import re as _re_approved

        if _re_approved.search(r"#{1,3}\s*(plan|پلن)\b", approved_plan, _re_approved.IGNORECASE):
            extra = (
                "[APPROVED PLAN — implement now, do not re-plan]\n"
                "An approved implementation plan already exists for this task "
                "(saved below). Execute it now with edit_file/write_file — "
                "never reply with a new '## Plan' document.\n\n"
                f"{approved_plan.strip()}"
            )
    reply = await _run_mode_turn(
        state, "build", recorder, extra_instruction=extra, run_flags=state.get("_run_flags")
    )
    if not isinstance(reply, str):
        reply = "" if reply is None else str(reply)
    # A '## Plan' written in Build mode (plan-then-execute when none exists)
    # must produce the same clickable Plan card as plan mode — otherwise it
    # renders as plain chat text and never reaches the right-side viewer.
    turn_text = recorder.text() or reply
    if isinstance(turn_text, str) and turn_text.strip():
        import re as _re_build_plan

        # Line-anchored header only: a passing "C# plan" / "the plan is ..."
        # mention in a summary must never touch the saved plan.
        if _re_build_plan.search(
            r"^#{1,3}\s*(plan|پلن)\b",
            turn_text,
            _re_build_plan.IGNORECASE | _re_build_plan.MULTILINE,
        ):
            # Persist a build-written plan only when none is saved yet
            # (plan-then-execute when none exists): never silently overwrite
            # an approved/saved plan with a "### Plan vs actual" section
            # from a summary.
            try:
                _existing = _agents._load_saved_plan(
                    state.get("root", ""), chat_id=state.get("chat_id", "")
                )
            except Exception:  # noqa: BLE001 — lookup must never break build
                _existing = ""
            if not (_existing or "").strip():
                try:
                    _persist_plan_text(queue, state.get("root", ""), state.get("chat_id", ""), turn_text)
                except Exception:  # noqa: BLE001, S110 — the card must never break the run
                    pass
    return {"build_result": reply, "final_response": reply}


def _shared_permit(state: dict, allow_outside: bool) -> dict:
    """Flags and allowed folders shared across tool rebuilds within one turn.

    The build node in LangGraph re-runs every step and ``make_tool_callbacks``
    is rebuilt with a fresh dict; without this shared dict, an "Always allow"
    grant or an in-turn approval would be lost on the next step and the
    permission dialog would reappear for every call. A fresh dict is created
    only the first time (or when the state has no value yet).
    """
    permit = state.get("_permit")
    if not isinstance(permit, dict):
        permit = {}
        state["_permit"] = permit
    # Pre-approved session flags (from the UI) re-applied on every rebuild —
    # they are the floor, never cleared by a rebuild.
    if allow_outside:
        permit["outside"] = True
    if state.get("allow_computer"):
        permit["computer"] = True
    # Pre-approved folders from the UI (the "always allow" button on the
    # per-folder dialog) are also a floor: every rebuild re-injects them into
    # permit["folders"].
    for folder in state.get("allow_outside_folders") or []:
        if isinstance(folder, str) and folder and folder not in permit.setdefault("folders", []):
            permit["folders"].append(folder)
    return permit


def review_node(state: AgentState) -> dict:
    """Verify the implementation against the request / plan.

    Read-only. Produces a structured review result. The Build mode is responsible for
    running the project's tests itself (via run_terminal) before finishing, so
    the graph does not run a separate test gate — the review just checks that an
    implementation was produced.
    """
    queue = state["_queue"]
    plan = state.get("plan", "")
    build = state.get("build_result", "")
    notes = []
    if not build:
        notes.append("no implementation produced")
    if plan and "## Plan" not in plan and not build:
        notes.append("no plan/implementation to review")
    result = "APPROVED" if not notes else "NEEDS WORK: " + "; ".join(notes)
    queue.put_nowait({"kind": "review", "result": result})
    return {"review_result": result}


async def done_node(state: AgentState) -> dict:
    """Finalize the run.

    The terminal ``done`` SSE event is emitted by ``server.event_gen``'s
    ``finally`` block (always runs on every path: clean, error, cancel). It
    used to also be emitted here, which caused a duplicate ``done`` event
    on every turn (graph.done_node + event_gen.finally) — the frontend
    treats the second one as "stream DISCONNECTED" and could trigger a
    needless reconnect. Keep only the state update here.
    """
    final = state.get("final_response", "")
    if state.get("review_result"):
        final = final + "\n\n[Review] " + state["review_result"]
    # Persistent goal judge (Claude-style completion-condition check).
    # A small fast model (the compact/subagent slot, else the parent model)
    # grades the ASSISTANT's work only — user messages are excluded so the
    # goal's own reminder pings can never self-clear it. Any judge failure
    # resolves to not_met (fail closed). Bounded auto-continue: at most
    # GOAL_MAX_EXTRA_TURNS extra turns; the counter is seeded per request
    # from the client's cumulative turns (server is authoritative).
    try:
        from goals import GOAL_JUDGE_SYSTEM, GOAL_MAX_EXTRA_TURNS
        from goals import build_goal_transcript as _build_goal_transcript
        from goals import normalize_goal as _normalize_goal2
        from goals import parse_goal_judge_output as _parse_goal_verdict

        _goal_text2 = _normalize_goal2(state.get("goal"))
        if not _goal_text2:
            # Same prompt-prefix fallback as build_turn_context above.
            import re as _re_goal3

            _pm2 = _re_goal3.match(r"\s*\[Active goal:\s*(.*?)\]\s*", str(state.get("prompt") or ""))
            if _pm2:
                _goal_text2 = _normalize_goal2(_pm2.group(1))
        if _goal_text2:
            _turns = state.get("goal_turns", 0) or 0
            try:
                _turns = int(_turns)
            except (TypeError, ValueError):
                _turns = 0
            if _turns >= GOAL_MAX_EXTRA_TURNS:
                final = final + "\n\n[GOAL PAUSED] Max extra turns reached — stopping auto-continue."
                return {"final_response": final, "goal_continue": False}
            try:
                _hist = state.get("history") or []
            except Exception:  # noqa: BLE001, S110 — history is best-effort
                _hist = []
            _transcript = _build_goal_transcript(_hist, final)
            if not _transcript:
                _status, _reason = "not_met", "No assistant output yet — keep working."
            else:
                _status, _reason = "not_met", "Goal not yet met — continuing."
                try:
                    _judge_model = resolve_subagent_model(
                        state.get("provider", ""),
                        (state.get("subagent_models") or {}).get("compact"),
                        state.get("base_url", ""),
                        state.get("api_key", ""),
                        state.get("env_var", ""),
                        state.get("model_name", ""),
                        provider_lookup=lambda pid: (state.get("providers") or {}).get(pid),
                        timeout=30,
                        parent_provider_id=state.get("provider_id", ""),
                        parent_api_keys=state.get("api_keys"),
                        thinking_level="",
                        model_reasoning=False,
                    )
                except Exception:  # noqa: BLE001, S110 — judge never breaks the run
                    _judge_model = None
                if _judge_model is None:
                    _status, _reason = "not_met", "Goal not yet met — continuing."
                else:
                    try:
                        from llm import llm_generate as _llm_generate

                        _judge_user = (
                            f"GOAL: {_goal_text2}\n\n"
                            f"TRANSCRIPT (assistant work only):\n{_transcript}"
                        )
                        _raw, _usage = await asyncio.wait_for(
                            _llm_generate(
                                _judge_model,
                                system=GOAL_JUDGE_SYSTEM,
                                user=_judge_user,
                                sub=True,
                                chat_id=str(state.get("chat_id") or ""),
                            ),
                            timeout=35,
                        )
                        _verdict = _parse_goal_verdict(str(_raw or ""))
                        if _verdict is not None:
                            _status = _verdict.get("status", "not_met")
                            _reason = _verdict.get("reason", "") or _reason
                    except Exception:  # noqa: BLE001, S110 — fail closed to not_met
                        _status, _reason = "not_met", "Goal not yet met — continuing."
            if _status == "met":
                final = final + "\n\n[GOAL CLEARED] " + (_reason or "Completion condition met.")
                return {"final_response": final, "goal_continue": False}
            if _status == "impossible":
                final = final + "\n\n[GOAL IMPOSSIBLE] " + (_reason or "Goal cannot be achieved.")
                return {"final_response": final, "goal_continue": False}
            final = final + "\n\n[GOAL CONTINUES] " + (_reason or "Goal not yet met — continuing.")
            return {
                "final_response": final,
                "goal_continue": True,
                "goal_turns": _turns + 1,
            }
    except Exception:  # noqa: BLE001, S110 — judge must never break the run
        pass
    return {"final_response": final}


# ---------------------------------------------------------------------------
# Graph assembly + driver
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Deterministic repository-exploration workflow (REPO SEARCH subgraph)
# ---------------------------------------------------------------------------
#
# This is the "exploration OUT of the agent" piece: instead of letting the LLM
# call glob/grep/read ad-hoc, the request is turned into search patterns by a
# pure heuristic (no extra LLM call), and those run as deterministic nodes that
# fan out (glob || grep || tree) -> collect -> read. The gathered context is
# then handed to the mode's LLM, which may still use WEB / FETCH / VISION /
# SKILL / MCP capabilities on demand but never glob/grep/read again.

_EXTS = {
    "py",
    "js",
    "ts",
    "tsx",
    "jsx",
    "go",
    "rs",
    "java",
    "c",
    "cpp",
    "cc",
    "h",
    "hpp",
    "rb",
    "php",
    "cs",
    "swift",
    "kt",
    "kts",
    "md",
    "mdx",
    "json",
    "yaml",
    "yml",
    "toml",
    "sh",
    "bash",
    "zsh",
    "sql",
    "html",
    "htm",
    "css",
    "scss",
    "less",
    "vue",
    "svelte",
    "lua",
    "r",
    "m",
    "pl",
    "pm",
    "dart",
    "ex",
    "exs",
    "erl",
    "clj",
    "scm",
    "hs",
    "ml",
    "fs",
    "fsx",
    "nim",
    "zig",
    "groovy",
    "gradle",
    "xml",
    "ini",
    "cfg",
    "conf",
    "env",
}

# Files that are useless to read for comprehension: lockfiles, minified /
# bundled output, source maps, binaries, archives, build artifacts. They can
# still match glob/grep, so we skip them at read time -- unless the user named
# the file explicitly (then it stays in `named` and is always read).
_SKIP_READ_NAMES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "gemfile.lock",
    "composer.lock",
    "cargo.lock",
    "go.sum",
    "pip.lock",
    ".ds_store",
    "thumbs.db",
}
_SKIP_READ_EXTS = {
    "lock",
    "min.js",
    "min.css",
    "map",
    "min",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "ico",
    "webp",
    "svg",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "otf",
    "pdf",
    "zip",
    "gz",
    "tar",
    "tgz",
    "rar",
    "7z",
    "bin",
    "exe",
    "dll",
    "so",
    "dylib",
    "wasm",
    "mp4",
    "mp3",
    "wav",
    "avi",
    "mov",
    "log",
    "cache",
    "pyc",
    "class",
    "o",
    "obj",
    "jar",
    "war",
}


def _should_skip_read(rel: str) -> bool:
    import os

    name = os.path.basename(rel).lower()
    if name in _SKIP_READ_NAMES:
        return True
    if ".min." in name:
        return True
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    return ext in _SKIP_READ_EXTS


_STOPWORDS = {
    "what",
    "where",
    "which",
    "when",
    "how",
    "does",
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "your",
    "you",
    "are",
    "is",
    "it",
    "of",
    "to",
    "a",
    "an",
    "do",
    "i",
    "we",
    "they",
    "file",
    "files",
    "code",
    "function",
    "class",
    "mode",
    "plan",
    "ask",
    "use",
    "using",
    "need",
    "want",
    "find",
    "search",
    "show",
    "list",
    "explain",
    "describe",
    "trace",
    "understand",
    "investigate",
    "look",
    "looking",
    "who",
    "why",
    "can",
    "could",
    "should",
    "would",
    "may",
    "might",
    "repo",
    "repository",
    "project",
    "inside",
    "their",
    "our",
    "its",
    "as",
    "at",
    "by",
    "be",
    "been",
    "has",
    "have",
    "had",
    "will",
    "not",
    "no",
    "yes",
}


def _strip_skill_mentions(prompt: str, skills: list[str] | None) -> str:
    """Drop attached-skill names from a prompt so the skill's own words don't
    leak into the glob/grep search-pattern derivation.

    A skill can surface in many forms — an ``@slug`` mention, the raw slug
    (``anthropic-frontend-design``), the human-readable TITLE with spaces
    (``Anthropic Frontend Design``), or a reordered / comma-joined variant the
    model echoes back (``Anthropic, Design, Frontend``). We scrub every
    permutation of the name's words across space / comma / hyphen / underscore
    separators as a whole phrase, so the explorer never extracts the title's
    words (Anthropic/Frontend/Design) as grep keywords. The skill BODY still
    drives the agent via the system prompt; only the skill's *name* leaves the
    keywords."""
    prompt = prompt or ""
    names = [s.strip() for s in (skills or []) if s and s.strip()]
    if not names:
        return prompt
    lowered = {n.lower() for n in names}

    # Every textual variant of an attached skill name we should scrub.
    phrases: set[str] = set()
    for n in names:
        phrases.add(n)
        words = [w for w in re.split(r"[\s_\-]+", n) if w]
        if not words:
            continue
        spaced = " ".join(words)
        phrases.add(spaced)
        phrases.add(" ".join(w[:1].upper() + w[1:] for w in words))
        # Every permutation of the name's words, joined by each separator —
        # catches reordered / comma-joined echoes (Anthropic, Design, Frontend)
        # exactly instead of only the canonical ordering.
        if len(words) > 1:
            for perm in itertools.permutations(words):
                for sep in (" ", ", ", "-", "_"):
                    phrases.add(sep.join(perm))

    def _at(m: re.Match) -> str:
        tok = m.group(1).lower()
        if tok in lowered:
            return " "
        return m.group(0)

    prompt = re.sub(r"@([A-Za-z0-9_\-]+)", _at, prompt)
    for v in phrases:
        if not v:
            continue
        prompt = re.sub(rf"(?i)\b{re.escape(v)}\b", " ", prompt)
    return prompt


def _skill_name_appears_in_text(name: str, text: str) -> bool:
    """True if any textual form of ``name`` (spaced / hyphen / underscore /
    comma-permuted) appears in ``text``.

    Used to scrub ONLY skills the user actually referenced, so an unrelated
    skill whose name happens to coincide with a legitimate request word is
    never deleted from the derive keywords."""
    text = (text or "").lower()
    words = [w for w in re.split(r"[\s_\-]+", (name or "").lower()) if w]
    if not words:
        return False
    forms = {name.lower(), " ".join(words)}
    if len(words) > 1:
        for perm in itertools.permutations(words):
            forms.add(", ".join(perm))
    return any(f and f in text for f in forms)


def _skill_names_to_strip(state: AgentState) -> list[str]:
    """Skill names to keep out of search keywords.

    The attached skills (``state["skills"]``) are always scrubbed, plus any
    skill the user referenced by name / @mention directly in the request. A
    skill referenced only through an @mention may not appear in
    ``state["skills"]`` (the frontend can send ``skills: []``), but its name is
    still echoed in the message text — so we scrub it too.

    We deliberately do NOT blanket-scrub every skill in the workspace: that
    would wrongly delete legitimate request words that merely coincide with an
    unrelated skill's name. The derive should keep only the words that help
    locate files precisely and correctly."""
    names = [s for s in (state.get("skills") or []) if s]
    request = state.get("request") or ""
    with contextlib.suppress(Exception):
        for s in _agents._load_skills(state.get("root", "")):
            n = (s.get("name") or "").strip()
            if not n or n in names:
                continue
            if _skill_name_appears_in_text(n, request):
                names.append(n)
    return names


def _derive_explore_patterns(prompt: str) -> dict:
    """Turn a request into deterministic search patterns (no LLM)."""
    prompt = (prompt or "").strip()
    glob_p: set[str] = set()
    grep_p: set[str] = set()
    tree_root = ""

    # 1. Quoted literals -> path/glob when they look like one, else keyword.
    for q in re.findall(r"['\"`]([^'\"`\n]{1,200})['\"`]", prompt):
        q = q.strip()
        if not q:
            continue
        if (
            "/" in q
            or "\\" in q
            or "*" in q
            or q.lower().endswith(tuple("." + e for e in _EXTS))
        ):
            glob_p.add(q)
        else:
            grep_p.add(re.escape(q))

    # 2. File extensions -> **/*.<ext>  (e.g. "app.py", "src/a.ts")
    for ext in re.findall(r"\.([A-Za-z][A-Za-z0-9+#\-]{1,9})\b", prompt):
        ext = ext.lower()
        if ext in _EXTS:
            glob_p.add(f"**/*.{ext}")

    # 3. Path-like tokens (a/b/c, a/b/c.py, bare file.py, and **/ globs).
    for tok in re.findall(
        r"\b(?:[\w\-]+\/)+[\w\-.]+(?:\.\w+)?\b|"
        r"\b[\w\-]+\.[A-Za-z][A-Za-z0-9+#\-]{1,9}\b|"
        r"\*\*?/[\w\-./*?]+",
        prompt,
    ):
        glob_p.add(tok)

    # 4. Identifiers: CamelCase, snake_case, UPPER_CASE -> grep.
    for ident in re.findall(
        r"\b([A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|"
        r"[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+|[A-Z][A-Z0-9_]{2,})\b",
        prompt,
    ):
        if len(ident) >= 3:
            grep_p.add(re.escape(ident))

    # 5. Keyword fallback (skip stopwords; cap to keep grep cheap).
    for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", prompt):
        if w.lower() not in _STOPWORDS and len(w) >= 4:
            grep_p.add(re.escape(w))
            if len(grep_p) >= 16:
                break

    # 6. Semantic glob patterns from salient terms, so the deterministic
    #    fallback still returns useful globs when the request has no explicit
    #    path/extension (avoids near-empty globs that force the planner to
    #    shell out to the terminal). Grounded in the request's own nouns.
    salient: list[str] = []
    for ident in re.findall(
        r"\b([A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|"
        r"[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+)\b",
        prompt,
    ):
        if len(ident) >= 3 and ident.lower() not in _STOPWORDS:
            salient.append(ident)
    for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", prompt):
        if w.lower() not in _STOPWORDS and len(w) >= 4:
            salient.append(w)
    seen_s: set[str] = set()
    for term in salient:
        tl = term.lower()
        if tl in seen_s:
            continue
        seen_s.add(tl)
        glob_p.add(f"**/*{term}*")
        if len(glob_p) >= 20:
            break

    # 7. tree root from a mentioned top-level dir (a/b/...).
    m = re.search(r"\b([a-z][a-z0-9_\-]+)\/[\w\-]", prompt)
    if m:
        tree_root = m.group(1)

    return {
        "glob": sorted(glob_p)[:20],
        "grep": sorted(grep_p)[:24],
        "queries": sorted(grep_p)[:24],
        "tree_root": tree_root,
        "question": prompt,
    }


def _as_list(x) -> list[str]:
    """Coerce a JSON value into a deduplicated list of non-empty strings."""
    if not x:
        return []
    if isinstance(x, str):
        return [x] if x.strip() else []
    out: list[str] = []
    seen: set[str] = set()
    for v in x:
        s = str(v).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _extract_json_object(text: str) -> dict | None:
    """Best-effort extraction of the first JSON object from an LLM reply.

    Tolerates ```json fences and surrounding prose. Returns None if no valid
    object can be parsed.
    """
    if not text:
        return None
    t = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.DOTALL)
    if fenced:
        t = fenced.group(1)
    else:
        start = t.find("{")
        end = t.rfind("}")
        if start == -1 or end <= start:
            return None
        t = t[start : end + 1]
    try:
        obj = json.loads(t)
    except Exception:  # noqa: BLE001
        return None
    return obj if isinstance(obj, dict) else None


def _make_explore_tools(state: AgentState, queue: asyncio.Queue) -> dict:
    """Build the glob/grep/read tool callbacks (no network, no extra LLM)."""
    root = state["root"]
    image_uris = _agents._load_images(state.get("images"))
    ctx = int(state.get("context_window") or 0) or _agents.DEFAULT_CONTEXT_WINDOW_FLOOR
    model = build_chat_model(
        state["provider"],
        state["model_name"],
        state["base_url"],
        state["api_key"],
        state["env_var"],
        cache=True,
    )
    tools = make_tool_callbacks(
        root,
        lambda ev: queue.put_nowait(ev),
        context_window=ctx,
        web_model=model,
        main_model=model,
        vision_model=None,
        image_uris=image_uris,
        permission_gates=state.get("permission_gates"),
        ask_gates=state.get("ask_gates"),
        permit=_shared_permit(state, bool(state.get("allow_outside"))),
        chat_id=state.get("chat_id", ""),
        history=state.get("history") or [],
    )
    return tools


async def _run_repo_tool(tools: dict, name: str, **kwargs) -> str:
    fn = tools.get(name)
    if fn is None:
        return f"ERROR: unknown tool {name!r}"
    try:
        if inspect.iscoroutinefunction(fn):
            res = fn(**kwargs)
        else:
            # Sync tool (blocking disk I/O): run in a worker thread so
            # asyncio.gather callers overlap instead of serializing on the
            # event loop. No shared lock is taken here.
            res = await asyncio.to_thread(fn, **kwargs)
        if inspect.isawaitable(res):
            res = await res
        return res
    except Exception as exc:  # noqa: BLE001
        return f"ERROR running {name}: {exc}"


def _parse_glob_files(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith(("GLOB MATCHES", "(")):
            continue
        if (
            "/" in line or re.match(r"^[\w.\-]+\.\w+$", line)
        ) and not _is_excluded_discovery_path(line):
            out.append(line)
    return out


def _parse_grep_files(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").splitlines():
        m = re.match(r"^([^\s:]+):\d+:", line)
        if m and not _is_excluded_discovery_path(m.group(1)):
            out.append(m.group(1))
    return out


def _build_tree(root: str, max_depth: int = 3, max_entries: int = 400) -> str:
    import os

    lines: list[str] = []
    count = 0
    skip_dirs = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        "target",
        ".mypy_cache",
        ".pytest_cache",
        "skills",
        "release",
    }
    base = root.rstrip(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(base) :].count(os.sep)
        if depth > max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d not in skip_dirs
        )
        rel = os.path.relpath(dirpath, root)
        prefix = "" if rel == "." else rel + "/"
        for f in sorted(filenames):
            if f.startswith("."):
                continue
            lines.append(prefix + f)
            count += 1
            if count >= max_entries:
                lines.append("... (truncated)")
                return "\n".join(lines)
    return "\n".join(lines)


def _repo_source_files(root: str, max_files: int = 600) -> list[str]:
    """Flat list of source-file relative paths (vendored dirs skipped).

    Used to backfill candidate files when the derived glob/grep patterns return
    little or nothing, so the agent always gets a repo map instead of an empty
    discovery result.
    """
    import os

    skip_dirs = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        "target",
        ".mypy_cache",
        ".pytest_cache",
        ".next",
        "out",
        "coverage",
        ".idea",
        ".vscode",
        ".turbo",
        "skills",
        "release",
    }
    out: list[str] = []
    base = root.rstrip(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(base) :].count(os.sep)
        if depth > 7:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d not in skip_dirs
        )
        for f in sorted(filenames):
            if f.startswith("."):
                continue
            ext = f.rsplit(".", 1)[-1].lower() if "." in f else ""
            if ext not in _EXTS:
                continue
            rel = os.path.relpath(os.path.join(dirpath, f), root)
            # Skip root-level .md docs (README/CONTRIBUTING/...) but keep
            # AGENTS.md and any nested .md (project rule, Part 3).
            if (
                os.path.dirname(rel) in ("", ".")
                and rel.lower().endswith(".md")
                and rel.lower() != "agents.md"
            ):
                continue
            out.append(rel)
            if len(out) >= max_files:
                return out
    return out


def _is_skill_path(path: str) -> bool:
    """True for skill methodology files (e.g. ``backend/skills/*.md``).

    Skills are already injected via the system prompt (inlined body of the
    @mentioned skill), so the explore pipeline must never re-discover or read them
    as project code — that wastes context and can confuse the planner into
    treating a skill's instructions as something to modify."""
    return "skills" in re.split(r"[/\\]", (path or "").strip())


# Directories that must never be surfaced as project code during repo
# discovery. Note: ``backend/tests/*.py`` (real test source) is intentionally
# NOT excluded — test files are needed when the user asks to write tests.
_EXCLUDED_DISCOVERY_DIRS = {"skills", "release"}


def _is_excluded_discovery_path(path: str) -> bool:
    """True for paths inside discovery-junk directories:

    * ``skills`` — methodology, already injected via the system prompt.
    * ``release`` — a full *bundled duplicate copy* of the app that ships
      inside the repo (e.g. ``release/mac-arm64/.../backend/...``); walking it
      double-counts the whole codebase and blows the discovery budget.

    Test source (``backend/tests/*.py``) stays discoverable on purpose."""
    return any(
        p in _EXCLUDED_DISCOVERY_DIRS for p in re.split(r"[/\\]", (path or "").strip())
    )


def _is_excluded_root_md(path: str, root: str) -> bool:
    """True for a root-level ``.md`` file OTHER than AGENTS.md.

    Per project rule, the explore pipeline must not read top-level docs
    (README, CONTRIBUTING, CHANGELOG, ...) -- they are noise next to the code
    and bloat the context budget -- while AGENTS.md stays readable. Attached
    files bypass this entirely (they are read via the Reader, not explore).

    ``path`` is root-relative in the real callers; an absolute path is also
    accepted (normalized via ``relpath``)."""
    base = os.path.basename(path or "").lower()
    if not base.endswith(".md") or base == "agents.md":
        return False
    rel = path if not os.path.isabs(path) else os.path.relpath(path, root)
    return os.path.dirname(rel) in ("", ".")


def _rank_files_by_prompt(files: list[str], prompt: str) -> list[str]:
    """Rank files by how many salient prompt tokens appear in their path."""
    toks = {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", prompt or "")}
    toks -= _STOPWORDS
    if not toks:
        return list(files)
    scored = []
    for f in files:
        fl = f.lower()
        score = sum(1 for t in toks if t in fl)
        scored.append((score, -len(fl), f))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [f for _, _, f in scored]


_IMPORT_RE = re.compile(r"""(?mx)
    ^[^\S\n]*(?:
        from\s+([.\w]+)\s+import\s+([\w,\s]+)
      | import\s+([.\w]+)
      | import\s+[^\n'"]*?from\s+['"]([^'"]+)['"]
      | require\(\s*['"]([^'"]+)['"]\s*\)
      | import\s+['"]([^'"]+)['"]
      | export[^\n'"]*?from\s+['"]([^'"]+)['"]
    )""")


def _resolve_module(root: str, from_file: str, spec: str) -> str | None:
    """Resolve a module/relative specifier to a repo file (existence-checked)."""
    import os

    if not spec:
        return None
    if spec.startswith("."):
        n = 0
        while n < len(spec) and spec[n] == ".":
            n += 1
        rest = spec[n:].replace(".", os.sep)
        base = os.path.dirname(from_file)
        for _ in range(max(0, n - 1)):
            base = os.path.dirname(base)
        cand = os.path.normpath(os.path.join(base, rest))
    else:
        cand = spec.replace(".", os.sep)
    exts = (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt")
    for ext in exts:
        p = os.path.join(root, cand + ext)
        if os.path.exists(p):
            return os.path.relpath(p, root)
    for ext in (".py", ".ts", ".tsx", ".js", ".jsx"):
        idx = (
            os.path.join(root, cand, "__init__" + ext)
            if ext == ".py"
            else os.path.join(root, cand, "index" + ext)
        )
        if os.path.exists(idx):
            return os.path.relpath(idx, root)
    return None


def _expand_imports(root: str, files: list[str], budget: int = 80) -> list[str]:
    """Backfill directly-imported local files so the agent gets cross-file context.

    Only specifiers that resolve to a real repo file are added (relative imports
    like `./x` / `../x` / `from . import x`, absolute module paths that exist in
    the repo, and JS `require`/ESM imports). Bare stdlib/dependency imports are
    skipped because they don't resolve to a project file.
    """
    import os

    have = set(files)
    extra: list[str] = []
    seen_extra: set[str] = set()
    for f in files:
        if len(have) + len(extra) >= budget:
            break
        try:
            with open(os.path.join(root, f), "r", errors="ignore") as fh:
                head = fh.read(4000)
        except OSError:
            continue
        for m in _IMPORT_RE.finditer(head):
            mod = m.group(1)
            names = m.group(2)
            if mod is not None:
                spec = mod
                if mod.startswith(".") and set(mod) == {"."} and names:
                    # `from . import name` -> module ".name"
                    first = names.split(",")[0].strip()
                    spec = mod + first
                target = _resolve_module(root, f, spec)
            else:
                spec = next((g for g in m.groups()[2:] if g), None)
                target = _resolve_module(root, f, spec) if spec else None
            if target and target not in have and target not in seen_extra:
                extra.append(target)
                seen_extra.add(target)
    return files + extra


def _fully_read_files(read_context: str) -> set[str]:
    """Files present as a FULL read in ``read_context`` (``=== <file> ===``).

    Partial reads (``--- <file>:a-b ---``) are intentionally excluded: they may
    not cover the grep-hit line, so their grep matches must stay."""
    return {
        m.group(1) for m in re.finditer(r"^=== (.+?) ===$", read_context, re.MULTILINE)
    }


def _dedup_grep_results(grep_results: list[str], fully_read: set[str]) -> list[str]:
    """Drop grep-hit lines whose file was already injected in full via
    ``read_context`` -- otherwise that file's content appears twice (once as
    FILE CONTENTS READ, once as GREP MATCHES)."""
    if not fully_read:
        return list(grep_results)
    out: list[str] = []
    for block in grep_results:
        kept: list[str] = []
        for line in block.splitlines():
            m = re.match(r"^([^\s:]+):\d+:", line)
            if m and m.group(1) in fully_read:
                continue
            kept.append(line)
        if kept:
            out.append("\n".join(kept))
    return out


def _resolve_file_refs(texts, root) -> list[str]:
    """Return repo-relative paths of REAL files referenced anywhere in `texts`
    (the current request + all prior conversation turns).

    Used to force a named file into the discovery read set even when the LLM
    planner misses it. Only tokens that resolve to an actual file inside the
    project are kept, so prose like "v1.2" or "foo.bar" never forces a bogus
    read. Capped so the exploration budget stays bounded.
    """
    if not texts:
        return []
    joined = "\n".join(str(t) for t in texts if t)
    cands: set[str] = set()
    # Path-like tokens: a/b/c, a/b/c.py, bare file.py, **/ globs.
    for tok in re.findall(
        r"\b(?:[\w\-]+\/)+[\w\-.]+(?:\.\w+)?\b|"
        r"\b[\w\-]+\.[A-Za-z][A-Za-z0-9+#\-]{1,9}\b|"
        r"\*\*?/[\w\-./*?]+",
        joined,
    ):
        cands.add(tok.strip())
    # Quoted literals that look like a path.
    for q in re.findall(r"['\"`]([^'\"`\n]{1,200})['\"`]", joined):
        q = q.strip()
        if "/" in q or "\\" in q or q.lower().endswith(tuple("." + e for e in _EXTS)):
            cands.add(q)
    out: list[str] = []
    seen: set[str] = set()
    for c in cands:
        try:
            abs_p = _agents.resolve_safe(root, c)
        except Exception:  # noqa: BLE001, S112
            continue
        if not abs_p or not os.path.isfile(abs_p):
            continue
        rel = os.path.relpath(abs_p, _agents.resolve_safe(root, ""))
        if rel in seen:
            continue
        seen.add(rel)
        out.append(rel)
        if len(out) >= 12:
            break
    return out


# ----- Reader (targeted file reading, no repo discovery) -------------------

READER_CONTEXT_LINES = 30
READER_HEAD_LINES = 200
READER_MAX_FILES = 15
MAX_EXPLORE_READ_CHARS = 24_000


def _explicit_files(state: AgentState) -> list[str]:
    """Workspace-relative paths the user explicitly pointed at THIS turn:
    attachments plus any file named directly in the request.
    Used both for routing (ask -> reader) and for the reader's read set."""
    root = state["root"]
    files: list[str] = []
    for a in state.get("attachments") or []:
        if a and str(a).strip() and str(a) not in files:
            files.append(str(a))
    for f in _resolve_file_refs([state.get("request", "")], root):
        if f not in files:
            files.append(f)
    return files


def _parse_line_refs(
    request: str, files: list[str]
) -> dict[str, list[tuple[int, int | None]]]:
    """Map each explicit file to ``(start, end|None)`` line ranges cited in the
    request as ``path:123``, ``path#L123`` or ``path:123-145``."""
    refs: dict[str, list[tuple[int, int | None]]] = {}
    for rel in files:
        esc = re.escape(rel)
        for m in re.finditer(rf"{esc}[:#]L?(\d+)(?:-(\d+))?", request):
            a = int(m.group(1))
            b = int(m.group(2)) if m.group(2) else None
            refs.setdefault(rel, []).append((a, b))
    return refs


def _in_file_grep(root: str, rel: str, patterns: list[re.Pattern]) -> set[int]:
    """Return 1-indexed line numbers of ``rel`` matching any of ``patterns``."""
    try:
        target = _agents.resolve_safe(root, rel)
    except Exception:  # noqa: BLE001
        return set()
    out: set[int] = set()
    try:
        with open(target, "r", errors="ignore") as fh:
            # Stream line-by-line instead of fp.readlines() — huge files were
            # spiking the explore pipeline's memory cost. Output (set of line
            # numbers) is identical to the readlines() version.
            for i, line in enumerate(fh, 1):
                for rx in patterns:
                    if rx.search(line):
                        out.add(i)
                        break
    except OSError:
        return set()
    return out


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not ranges:
        return []
    rs = sorted(ranges)
    merged: list[list[int]] = [list(rs[0])]
    for a, b in rs[1:]:
        if a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


# ----- Repo-discovery nodes (deterministic) -------------------------------


_TREE_CACHE: dict[str, tuple[str, str]] = {}
_TREE_CACHE_MAX_ROOTS = 50

_MTIME_SIG_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    "out",
    "coverage",
    ".idea",
    ".vscode",
    ".turbo",
}


def _repo_mtime_signature(root: str, max_entries: int = 4000) -> str:
    """Cheap staleness signature for the whole tree: file count + the latest
    mtime seen (bounded walk, same skip-dirs as `_build_tree`). Catches edits
    and additions directly (a changed/new file bumps `latest`); catches
    deletions/renames indirectly via the changed `count`. Never hashes file
    CONTENT — only used to decide whether a cached SEARCH PLAN is still worth
    reusing, never to skip an actual glob/grep/read.
    """
    count = 0
    latest = 0.0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d
            for d in dirnames
            if not d.startswith(".") and d not in _MTIME_SIG_SKIP_DIRS
        )
        for f in filenames:
            if f.startswith("."):
                continue
            try:
                mtime = os.path.getmtime(os.path.join(dirpath, f))
            except OSError:
                continue
            latest = max(latest, mtime)
            count += 1
            if count >= max_entries:
                return f"{count}:{latest}"
    return f"{count}:{latest}"


def _spec_keyword_signature(request: str) -> str:
    """Order-independent keyword-set signature for spec-cache matching, so a
    reworded but semantically identical follow-up in the same chat still hits
    (e.g. "where is the auth timeout handled" vs "auth timeout, where's that
    handled")."""
    toks = {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", request or "")}
    toks -= _STOPWORDS
    return "|".join(sorted(toks))


def _build_tree_cached(
    root: str, root_sig: str, max_depth: int = 3, max_entries: int = 400
) -> str:
    """Same output as `_build_tree`, skipping the walk when `root_sig` (an
    already-computed `_repo_mtime_signature`) matches the last build for this
    root — the tree walk repeats on every single repo_derive call otherwise.
    """
    cached = _TREE_CACHE.get(root)
    if cached and cached[0] == root_sig:
        return cached[1]
    tree = _build_tree(root, max_depth=max_depth, max_entries=max_entries)
    if len(_TREE_CACHE) >= _TREE_CACHE_MAX_ROOTS and root not in _TREE_CACHE:
        _TREE_CACHE.pop(next(iter(_TREE_CACHE)))
    _TREE_CACHE[root] = (root_sig, tree)
    return tree


def _rank_files_semantic(
    root: str, prompt: str, files: list[str], state: AgentState
) -> list[str]:
    """Rank `files` by embedding similarity to `prompt` using the project's own
    vector store (the same index already built for RAG) instead of naive
    keyword-overlap counting — no extra LLM call, just an embedding lookup.
    Files the semantic search doesn't surface keep their keyword-ranked order,
    appended after the semantic hits. Falls back to pure keyword ranking on
    any failure or an empty/missing index — never raises.
    """
    # کد پروژه دیگه ایندکس نمی‌شه (KIND_FILE حذف شد) — فقط keyword ranking.
    return _rank_files_by_prompt(files, prompt)


_GREP_HIT_FILE_RE = re.compile(r"^([^\s:]+):\d+:")


def _grep_hit_file(line: str) -> str:
    m = _GREP_HIT_FILE_RE.match(line)
    return m.group(1) if m else ""


def _read_context_files(read_context: str) -> set[str]:
    """File paths already fully present in `read_context` (both repo_read's
    `=== path ===` and reader_read's `--- path:a-b ---` markers), so the grep
    dump can skip duplicating their content."""
    files: set[str] = set()
    for m in re.finditer(r"^=== (.+?) ===$", read_context, re.MULTILINE):
        files.add(m.group(1))
    for m in re.finditer(r"^--- (.+?):\d+-\d+ ---$", read_context, re.MULTILINE):
        files.add(m.group(1))
    return files


_REFERENCE_CUES = re.compile(
    r"ببین|نشون بده|نمایش بده|اون فایل|همون فایل|آن فایل|"
    r"look at it|that file|this file|show me|show it|open it",
    re.IGNORECASE,
)


def _has_reference_cue(text: str) -> bool:
    """True when the message refers to a file mentioned EARLIER in the
    conversation (e.g. "ببینش", "look at that file") rather than naming it
    directly."""
    return bool(_REFERENCE_CUES.search(text or ""))


# Messages that only refer back to a PRIOR answer in the conversation rather
# than introducing a new, searchable entity (e.g. "look at the paths you
# mentioned", "همون مسیرهاییکه گفتی رو ببین"). Used to keep a broadened
# _ASK_REPO_CUES from routing a no-op follow-up into an empty re-explore.
_FOLLOWUP_CUES = re.compile(
    r"look at|the paths|mentioned|refer|همون|اون|گفتی|ببین|نشون بده",
    re.IGNORECASE,
)


def _history_has_assistant_answer(state: AgentState) -> bool:
    return any(
        (m.get("role") in ("assistant", "agent")) and (m.get("content") or "").strip()
        for m in (state.get("history") or [])
    )


def _is_prior_reference_followup(state: AgentState) -> bool:
    """True for a short follow-up that only refers back to prior discussion and
    carries no new searchable entity. Such a message matches the broadened
    _ASK_REPO_CUES (e.g. "مسیر") but would yield an empty exploration, so we
    let the agent re-state from the prior answer already in history instead of
    looping on a pointless re-explore."""
    return bool(_FOLLOWUP_CUES.search(state.get("request", "") or "")) and (
        _history_has_assistant_answer(state)
    )


def _ask_needs_repo(text: str) -> bool:
    """True when an ask-mode question is about the project/codebase and should
    run the deterministic repo-discovery pipeline (instead of answering from
    general knowledge). Deliberately excludes chit-chat ("who/they are you",
    "hello", plain conceptual questions like "what is a closure")."""
    return bool(_ASK_REPO_CUES.search(text or ""))


async def ask_entry(state: AgentState) -> dict:
    # Ask is a GENERAL assistant. It has grep/glob/read tools directly
    # (OpenCode-style), so it explores the repo itself when the question is
    # project/code-related; for general questions it answers directly. It
    # consumes its own tool results and never re-searches from scratch.
    return {}


def _route_ask_entry(state: AgentState) -> str:
    # When the user explicitly points at file(s) THIS turn -- an attachment or
    # a file named directly in the message -- the question is
    # about THOSE files, so route to the Reader agent, which reads only the needed
    # parts (no repo-wide discovery / glob).
    if _explicit_files(state):
        return "reader"
    # Otherwise the agent decides for itself whether to search. A strong repo cue
    # or an explicit file reference means it likely should; either way it answers
    # directly with whatever tools it calls.
    return "ask_answer"


async def ask_answer(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "ask", queue, run_flags=state.get("_run_flags"))
    return {"final_response": reply}


async def reader_read(state: AgentState) -> dict:
    """Deterministically gather ONLY the needed parts of the explicitly specified
    file(s) -- no LLM, no repo-wide glob/grep.

    Per file, in order of preference:
      * explicit ``path:LINE`` / ``path#L123`` / ``path:123-145`` refs -> read that range;
      * otherwise an in-file grep of the question's deterministic keywords -> read each
        match expanded by ``READER_CONTEXT_LINES``;
      * fallback (no refs, no keywords) -> a bounded head, never the whole file.
    """
    queue = state["_queue"]
    root = state["root"]
    request = state.get("request", "")
    files = _explicit_files(state)[:READER_MAX_FILES]
    if not files:
        return {"read_context": ""}
    # same skill-name stripping as repo_derive: the skill's own words must not
    # become in-file grep keywords.
    spec = _derive_explore_patterns(
        _strip_skill_mentions(request, _skill_names_to_strip(state))
    )
    patterns: list[re.Pattern] = []
    for p in (spec.get("grep", []) or [])[:24]:
        try:
            patterns.append(re.compile(p))
        except re.error:
            continue
    line_refs = _parse_line_refs(request, files)
    tools = _make_explore_tools(state, queue)
    # Build every (file, range) read spec up front, then run ALL reads
    # concurrently via asyncio.gather — opencode-style parallel tool execution.
    # The read tool offloads the disk read to a worker thread (tools.read_file
    # -> asyncio.to_thread), so gathered reads overlap instead of running
    # one-at-a-time. The read tool emits its own tool/tool_result events, so no
    # manual queue events are needed here.
    read_specs: list[tuple[str, int, int]] = []  # (file, a, b)
    for f in files:
        ranges: list[tuple[int, int]] = []
        if f in line_refs:
            for a, b in line_refs[f]:
                end = b or a
                ranges.append(
                    (max(1, a - READER_CONTEXT_LINES), end + READER_CONTEXT_LINES)
                )
        elif patterns:
            for n in sorted(_in_file_grep(root, f, patterns)):
                ranges.append(
                    (max(1, n - READER_CONTEXT_LINES), n + READER_CONTEXT_LINES)
                )
        else:
            ranges.append((1, READER_HEAD_LINES))
        for a, b in _merge_ranges(ranges):
            read_specs.append((f, a, b))

    async def _read(spec: tuple[str, int, int]) -> str:
        f, a, b = spec
        limit = b - a + 1
        res = await _run_repo_tool(tools, "read", filePath=f, offset=a, limit=limit)
        return f"--- {f}:{a}-{b} ---\n{res}"

    chunks = await asyncio.gather(*(_read(s) for s in read_specs)) if read_specs else []
    # Assemble in input order and cap to MAX_EXPLORE_READ_CHARS (trims trailing
    # parts once the budget is reached — gather keeps order, so the head wins).
    parts: list[str] = []
    total = 0
    for chunk in chunks:
        if total + len(chunk) > MAX_EXPLORE_READ_CHARS and parts:
            break
        parts.append(chunk)
        total += len(chunk)
    return {"read_context": "\n\n".join(parts), "reader_files": files}


def _build_reader_context(state: AgentState) -> str:
    rc = state.get("read_context", "")
    if not rc:
        return ""
    return (
        "SPECIFIED FILE CONTENTS (read deterministically -- do NOT call "
        "glob/grep/read; use only this context):\n" + rc
    )


async def reader_answer(state: AgentState) -> dict:
    # Reader is a distinct agent persona; make build_turn_context treat it as such
    # (correct system note + tool gating), even when auto-triggered from ask mode.
    state["mode"] = "reader"
    queue = state["_queue"]
    extra = _build_reader_context(state)
    reply = await _run_mode_turn(
        state,
        "reader",
        queue,
        extra_instruction=extra,
        run_flags=state.get("_run_flags"),
    )
    return {"final_response": reply}


async def plan_understand(state: AgentState) -> dict:
    # Deterministic comprehension is folded into repo_derive; this node exists so
    # the PLAN flow has an explicit "understand -> discover" shape.
    return {}


def _route_plan_understand(state: AgentState) -> str:
    # When the user points at specific file(s) in PLAN mode, read ONLY those
    # (targeted, no repo-wide discovery) and let the planner build from that
    # context. Otherwise the planner explores the repo itself via grep/glob/read
    # tools (OpenCode-style) and then builds the plan.
    if _explicit_files(state):
        return "reader_read"
    return "plan_build"


def _route_reader_dispatch(state: AgentState) -> str:
    # After the targeted read, hand off to the right consumer: PLAN mode feeds
    # the read context to the planner; everything else gets the Reader answer.
    if state.get("mode") == "plan":
        return "plan_build"
    return "reader_answer"


# Sentinel answers the frontend sends for the plan-approval card (it must never
# depend on the visible option label, which is localized). Free-text answers are
# revision feedback for the planner.
PLAN_APPROVE_TOKEN = "__plan_approve__"
PLAN_DISMISS_TOKEN = "__plan_dismiss__"
# Capability map applied to the run when the user approves the plan: the request
# arrived with Plan-mode (read-only) caps from the UI, and filter_tools_for_mode
# trusts that map — without this upgrade the Build turn that starts in the SAME
# stream would have its write/edit/terminal tools stripped.
BUILD_CAPS = {"readFiles": True, "writeFiles": True, "runTerminal": True, "web": True}
CODER_CAPS = BUILD_CAPS  # legacy alias


def _split_plan_reply(reply: str) -> tuple[str, str]:
    """Split a planner reply into ``(preamble, plan_body)``.

    The model is told to open with ``## Plan``, but it sometimes prefixes a
    short lead-in or uses a variant header (``## plan``, ``### Plan``,
    ``## Plan:``). The plan body starts at the header when one is present;
    otherwise the whole reply IS the plan and the preamble is empty. The body
    is what gets persisted (the "plan sometimes isn't saved" bug) and shown in
    the Plan card/panel; the preamble stays visible as ordinary chat prose.
    When the streamed turn holds several plan drafts (an early draft plus the
    final answer), only the LAST document is taken, so a duplicate is never
    built in the first place.
    """
    import re

    text = (reply or "").strip()
    if not text:
        return "", ""
    anchored = list(
        re.finditer(r"^#{1,3}\s*(plan|پلن)\b\s*:?", text, re.IGNORECASE | re.MULTILINE)
    )
    if anchored:
        m = anchored[-1]
        return text[: m.start()].strip(), text[m.start() :].strip()
    # Streamed chunks concatenate without a newline (e.g. "scouting… " +
    # "## Plan"), so the header may sit mid-line. Fall back to an
    # unanchored match so the scouting prose still splits off as preamble.
    loose = list(re.finditer(r"#{1,3}\s*(plan|پلن)\b\s*:?", text, re.IGNORECASE))
    if not loose:
        return "", text
    m = loose[-1]
    return text[: m.start()].strip(), text[m.start() :].strip()


def _normalize_plan_reply(reply: str) -> str:
    """Return the plan body to persist (see `_split_plan_reply`)."""
    return _split_plan_reply(reply)[1]


def _qualifying_plan_body(text: str) -> str:
    """Return the persistable plan body, or "" when text is no plan document.

    Guards every plan-persist path: without this, any prose that merely
    mentions "plan" ("C# plan", "the plan is blocked on ...") overwrites the
    saved plan, re-derives checklist todos from its bullets, and pops an
    approval card for it. A line-anchored ``## Plan`` header always
    qualifies; a mid-line header (streamed chunks concatenate without
    newlines) only qualifies when the body is plan-shaped (steps and/or a
    Files: line).
    """
    import re

    _preamble, body = _split_plan_reply(text)
    if not body.strip():
        return ""
    if re.search(r"^#{1,3}\s*(plan|پلن)\b", text, re.IGNORECASE | re.MULTILINE):
        return body
    if _plan_items_from_body(body):
        return body
    if re.search(r"^files?\s*:", body, re.IGNORECASE | re.MULTILINE):
        return body
    return ""


def _plan_draft_in_turn(reply: str, msgs: list, seed_ids=None) -> bool:
    """True when a plan header was written during THIS turn (not history).

    Only line-anchored headers count (``## Plan``, ``# Plan``, ``## plan``),
    and history-seeded messages (by id snapshot) are skipped: a previous
    turn's plan lives in history as AIMessage and must not satisfy
    turn-local checks like the scouting budget.
    """
    import re

    _header = r"^#{1,3}\s*(plan|پلن)\b"
    if re.search(_header, reply or "", re.IGNORECASE | re.MULTILINE):
        return True
    for m in msgs or []:
        if seed_ids is not None and id(m) in seed_ids:
            continue
        if not isinstance(m, AIMessage):
            continue
        if re.search(
            _header,
            str(getattr(m, "content", "") or ""),
            re.IGNORECASE | re.MULTILINE,
        ):
            return True
    return False


def _plan_items_from_body(plan_body: str) -> list[dict]:
    """Derive checklist items from a plan body so todos stay in sync.

    Parses numbered/bullet steps (e.g. ``1. do X``, ``- [ ] do X``) while
    skipping the ``## Plan`` header and the trailing ``Files:`` line. Every
    item starts as ``pending`` — a revised plan is a fresh deliverable, not
    an execution update. Returns [] when no steps are found so callers keep
    the existing checklist instead of wiping it.
    """
    import re

    items: list[dict] = []
    for line in (plan_body or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if re.match(r"^#{1,6}\s*(plan|پلن)\b", s, re.IGNORECASE):
            continue
        if re.match(r"^files?\s*:", s, re.IGNORECASE):
            continue
        m = re.match(r"^(?:[0-9۰-۹٠-٩]+[.)]|[-*•])\s+(?:\[[ xX]\]\s+)?(.+)$", s)
        if not m:
            continue
        content = m.group(1).strip().strip("*").strip()
        if not content:
            continue
        items.append({"content": content[:200], "status": "pending"})
        if len(items) >= 20:
            break
    return items


def _plan_title(plan_body: str) -> str:
    """Human title for the Plan card: the first markdown heading if the planner
    wrote a custom one (``## Plan: auth refactor``), else the generic label."""
    import re

    for line in (plan_body or "").splitlines():
        s = line.strip()
        if not s:
            continue
        m = re.match(r"^#{1,6}\s+(.+)$", s)
        if m:
            title = m.group(1).strip().strip(":*#").strip()
            # A bare "Plan" heading adds nothing over the card's own label.
            if title.lower() in ("plan", "پلن"):
                return ""
            return title
        break
    return ""


def _persist_plan_text(queue: asyncio.Queue, root: str, chat_id: str, text: str) -> str:
    """Persist plan text, emit plan_card + todos sync, return the body."""
    preamble, plan_body = _split_plan_reply(text)
    try:
        ws = state_db.workspace_slug_for_root(root)
    except Exception:  # noqa: BLE001 — slug must never break the run
        ws = "workspace"
    if not ws:
        ws = "workspace"
    try:
        state_db.save_plan(ws, "plan", plan_body, chat_id=chat_id)
    except Exception:
        logging.getLogger(__name__).exception("persist_plan: save_plan failed")
    else:
        logging.getLogger(__name__).info(
            "persist_plan: saved %d chars for chat %s in workspace %s",
            len(plan_body),
            chat_id,
            ws,
        )
    try:
        queue.put_nowait(
            {
                "kind": "plan_card",
                "title": _plan_title(plan_body),
                "body": plan_body,
                "preamble": preamble,
            }
        )
    except Exception:  # noqa: BLE001, S110 — the card must never break the run
        pass
    try:
        derived = _plan_items_from_body(plan_body)
        if derived:
            queue.put_nowait({"kind": "plan", "items": derived})
    except Exception:  # noqa: BLE001, S110 — todos sync never breaks the run
        pass
    return plan_body


async def _request_plan_approval(queue: asyncio.Queue, gate: dict) -> str:
    """Ask the user to approve / edit / dismiss the finished plan and WAIT.

    Same ask-gate mechanics as the ask_user tool (future in ``ask_gates``,
    resolved by POST /ask/respond) but deterministic — the graph raises the
    gate itself after the plan is saved, so approval never depends on the
    model deciding to call a tool. The ``style`` field tells the frontend to
    render the "Permission required — Implementation plan" card.
    """
    import uuid

    aid = f"a{uuid.uuid4().hex[:8]}"
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    gate[aid] = fut
    queue.put_nowait(
        {
            "kind": "ask",
            "id": aid,
            "style": "plan_approval",
            "question": "Implementation plan",
            "options": [
                "Approve — exit plan mode and start implementation",
            ],
        }
    )
    try:
        answer = await fut
    finally:
        gate.pop(aid, None)
    return answer if isinstance(answer, str) else ""


class _RecordingQueue:
    """Queue proxy that records streamed text while forwarding every event.

    ``_run_mode_turn`` returns only the FINAL message of a turn, but the
    planner writes the ``## Plan`` body in an earlier step — the same message
    that carries its ``update_plan`` tool call — and text from tool-carrying
    steps never reaches that reply. Saving from the reply alone therefore
    stored only the closing prose as the plan (the "wrong text saved" bug).
    The full turn text is exactly what the queue streams, so plan_build
    records it here and splits the plan out of the concatenated text,
    falling back to the reply when the turn emitted no text events (tests
    that fake the turn entirely).
    """

    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._parts: list[str] = []

    def put_nowait(self, event: object) -> None:
        if isinstance(event, dict) and event.get("kind") == "text":
            content = event.get("content")
            if isinstance(content, str):
                self._parts.append(content)
        self._queue.put_nowait(event)

    def text(self) -> str:
        """All streamed text of the turn (stripped; "" when nothing streamed)."""
        return "".join(self._parts).strip()

    def __getattr__(self, name: str) -> Any:
        # Everything else (get/empty/…) is the real queue's — plan_build and
        # _run_mode_turn only need put_nowait, which is recorded above.
        return getattr(self._queue, name)


def _without_trailing_reply(turn_text: str, reply: str) -> str:
    """Drop the final closing message from the streamed turn text.

    The turn ends with a short closing prose ("plan written, ready for
    review") that is NOT part of the plan — the plan itself (``## Plan`` …
    ``Files:`` … summary) was streamed earlier. Since the closing message is
    also streamed, the concatenated turn text ends with it; stripping that
    suffix leaves just scouting + plan so ``_split_plan_reply`` persists the
    plan without the preamble prefix or the closing suffix. Falls back to the
    full text when there is no suffix match (e.g. single-message turns where
    the reply IS the whole turn).
    """
    import re

    text = (turn_text or "").strip()
    tail = (reply or "").strip()
    if tail and text.endswith(tail) and len(text) > len(tail):
        stripped = text[: -len(tail)].strip()
        # Never cut the plan itself: the reply CARRIES the plan when the model
        # wrote '## Plan' in a message without a tool call. Stripping that
        # suffix would delete the plan and leave only the scouting narration —
        # which then gets saved as the whole plan (the "narration saved as the
        # plan" bug). Keep the full text and let _split_plan_reply cut at the
        # header instead; the closing prose stays inside the body.
        header = re.compile(r"#{1,3}\s*(plan|پلن)\b", re.IGNORECASE)
        if header.search(text) and not header.search(stripped):
            return text
        return stripped
    return text


async def plan_build(state: AgentState) -> dict:
    queue = state["_queue"]
    chat_id = state.get("chat_id", "")
    attempts = int(state.get("plan_attempts", 0))
    approved = False

    def _save_and_emit(text: str) -> str:
        """Persist the plan text, emit the Plan card event, return the body."""
        return _persist_plan_text(queue, state["root"], chat_id, text)

    recorder = _RecordingQueue(queue)
    reply = await _run_mode_turn(
        state, "plan", recorder, run_flags=state.get("_run_flags")
    )
    # Guard against a non-string reply (e.g. None when the turn fails) so we
    # don't crash on .strip() — and never silently swallow a save failure.
    if not isinstance(reply, str):
        reply = "" if reply is None else str(reply)
    attempts += 1
    # Prefer the STREAMED turn text: the reply only carries the final message,
    # while the '## Plan' body was written in an earlier (tool-carrying) step.
    # The trailing closing message is stripped so only scouting + plan remain.
    turn_text = _without_trailing_reply(recorder.text() or reply, reply)
    # Only a real plan document is persisted and gated: planner prose (e.g. a
    # follow-up answer with no ## Plan) must never overwrite the saved plan.
    if _qualifying_plan_body(turn_text):
        reply = _save_and_emit(turn_text)
        # Approval gate. Headless runs (no ask_gates) keep the old
        # plan-and-stop behavior.
        gate = state.get("ask_gates")
        if gate is not None:
            # Strictly user-bounded loop: every iteration blocks on the gate
            # future, so another round only happens when the user submits
            # another edit request on the approval card.
            while True:
                answer = await _request_plan_approval(queue, gate)
                if answer == PLAN_APPROVE_TOKEN:
                    approved = True
                    try:
                        queue.put_nowait({"kind": "mode_changed", "mode": "build"})
                    except Exception:  # noqa: BLE001, S110 — UI sync only
                        pass
                    break
                # Dismiss (or empty): keep the saved plan, end plan mode. The
                # user can switch to Build manually later.
                if not answer or answer == PLAN_DISMISS_TOKEN:
                    break
                # Edit request: revise the plan with the planner, then re-ask.
                attempts += 1
                rev_recorder = _RecordingQueue(queue)
                revision = await _run_mode_turn(
                    state,
                    "plan",
                    rev_recorder,
                    extra_instruction=(
                        "[PLAN REVISION REQUEST — non-user directive]\n"
                        "The user reviewed your plan and asked for this change:\n"
                        f"{answer}\n\n"
                        "Here is the plan to revise:\n\n"
                        f"{reply}\n\n"
                        "Apply ONLY the requested change (keep everything that is "
                        "still correct), then output the FULL revised plan in the "
                        "same '## Plan' shape."
                    ),
                    run_flags=state.get("_run_flags"),
                )
                rev_text = _without_trailing_reply(
                    rev_recorder.text()
                    or (revision if isinstance(revision, str) else ""),
                    revision if isinstance(revision, str) else "",
                )
                if not _qualifying_plan_body(rev_text):
                    # Revision came back without a plan document — keep the
                    # previously saved plan instead of overwriting it with
                    # prose, and stop asking.
                    break
                reply = _save_and_emit(rev_text)
    return {
        "plan": reply,
        "plan_attempts": attempts,
        # Approved → this run continues into the Build node (implementation
        # starts in the SAME stream, ZCode-style); _route_plan_build sees the
        # switched mode and routes accordingly.
        "mode": "build" if approved else state.get("mode", "plan"),
        **({"cap": dict(BUILD_CAPS)} if approved else {}),
    }


def _route_plan_build(state: AgentState) -> str:
    # Plan mode is a read-only deliverable: present the plan once and STOP, so
    # the user can review / extend it or switch to Build manually. Other modes
    # (e.g. build invoked with a plan in history) jump straight to build.
    return "done" if state.get("mode") == "plan" else "build"


def _route_mode(state: AgentState) -> str:
    return normalize_mode(state.get("mode", "ask"))


def build_graph():
    """Compile the LangGraph state machine for the agent workflow.

    OpenCode-style architecture: every agent mode (build/plan/ask/reader) has
    direct access to the grep/glob/read tool runtime and decides iteratively
    which to call — there is NO forced derive stage and NO separate explore
    pipeline. Broad exploration is delegated to an isolated Explore subagent via
    the Task tool, whose history never enters the Main Agent context.
    """
    g = StateGraph(AgentState)
    g.add_node("router", router)
    g.add_node("build", build_node)
    g.add_node("build_entry", build_entry)
    g.add_conditional_edges("build_entry", _route_build_entry, {"build": "build"})
    g.add_node("review", review_node)
    g.add_node("done", done_node)
    # ASK flow: general assistant with repo tools; answers directly, searching
    # itself when the question is project-related.
    g.add_node("ask_entry", ask_entry)
    g.add_node("ask_answer", ask_answer)
    g.add_node("reader_read", reader_read)
    g.add_node("reader_answer", reader_answer)
    g.add_conditional_edges(
        "ask_entry",
        _route_ask_entry,
        {"ask_answer": "ask_answer", "reader": "reader_read"},
    )
    g.add_edge("ask_answer", "done")
    g.add_conditional_edges(
        "reader_read",
        _route_reader_dispatch,
        {"reader_answer": "reader_answer", "plan_build": "plan_build"},
    )
    g.add_edge("reader_answer", "done")
    # PLAN flow: the planner explores via grep/glob/read itself, then builds.
    g.add_node("plan_understand", plan_understand)
    g.add_node("plan_build", plan_build)
    g.add_conditional_edges(
        "plan_understand",
        _route_plan_understand,
        {"reader_read": "reader_read", "plan_build": "plan_build"},
    )
    g.add_conditional_edges(
        "plan_build",
        _route_plan_build,
        {"plan_build": "plan_build", "build": "build", "done": "done"},
    )

    g.add_edge(START, "router")
    g.add_conditional_edges(
        "router",
        _route_mode,
        {
            "ask": "ask_entry",
            "plan": "plan_understand",
            "build": "build_entry",
            "reader": "reader_read",
        },
    )

    # BUILD tail: Build runs the project's tests itself (via run_terminal) before
    # finishing, so there is no automatic test/debug loop here — just review.
    g.add_edge("build", "review")
    g.add_edge("review", "done")
    g.add_edge("done", END)
    return g.compile()


async def run_graph(initial: AgentState) -> AsyncIterator[dict]:
    """Drive the compiled graph, yielding SSE events as they are produced.

    The event protocol matches the old ``run_agent`` generator (dicts with a
    ``kind`` key), so ``server.py`` is unchanged.
    """
    queue: asyncio.Queue = asyncio.Queue()
    initial = dict(initial)
    initial["_queue"] = queue
    # Mutable flag shared between _run_mode_turn (which detects a hard failure)
    # and _drive (which decides whether to clear the durable resume file). A
    # plain attribute on `initial` would be invisible to _drive because
    # _run_mode_turn works on a *copy* of the state, so we use a nested dict.
    initial.setdefault("_run_flags", {})["hard_error"] = False
    initial["_run_flags"]["error"] = False
    # Detect a user mode switch so the agent re-orients immediately. The previous
    # turn's mode is persisted in the LangGraph checkpointer; read it BEFORE this
    # run's input merges in (the input would otherwise overwrite it).
    _cur_mode = initial.get("mode") or "ask"
    _prev_mode = await _load_prev_mode(_resume_thread_id(initial))
    initial["_prev_mode"] = _prev_mode
    initial["_mode_changed"] = bool(_prev_mode) and _prev_mode != _cur_mode
    if not (initial.get("request") or "").strip():
        yield {
            "kind": "error",
            "content": "empty or whitespace-only prompt — refusing to run",
        }
        return
    graph = build_graph()

    async def _drive() -> None:
        # Tracks whether the run ended cleanly (no error AND no cancellation).
        # A user abort / client disconnect cancels this task, which surfaces as
        # a BaseException (CancelledError / GeneratorExit) — NOT an Exception —
        # so it would otherwise slip past the `except Exception` and fall into
        # the `else` branch below, wiping the durable resume file on an
        # *interrupted* turn. We must only clear the file on a genuine clean
        # finish, so we gate the `else` on this flag.
        _clean = True
        try:
            async for _ in graph.astream(initial, stream_mode="updates"):
                pass
        except asyncio.CancelledError:
            # User aborted / client disconnected mid-turn: LEAVE the resume file
            # behind so a reconnect can replay the already-done tool work.
            _clean = False
            logger.warning(
                "[run_graph] run cancelled (client/sidecar disconnect) chat_id=%s",
                initial.get("chat_id", ""),
            )
            return
        except GeneratorExit:
            # Consumer (run_graph generator) closed early — same as a disconnect.
            _clean = False
            logger.warning(
                "[run_graph] run generator closed (downstream teardown) chat_id=%s",
                initial.get("chat_id", ""),
            )
            return
        except Exception as _exc:
            # Never swallow the error silently: a bare `queue.put(None)` would
            # end the stream with NO error event, so the frontend sees a sudden
            # "disconnect" (the message just cuts off) instead of a real error
            # it can show as a Retry banner. This is the root cause of the
            # intermittent "first/any message disconnects instantly" reports.
            _clean = False
            # Log the full traceback to the FILE handler (codifa.log) — stderr
            # alone is not enough because Electron may not capture it in
            # packaged mode. Also call traceback.print_exc() as a fallback for
            # live dev where stderr IS the live log.
            logger.exception("[run_graph] agent crashed chat_id=%s", initial.get("chat_id", ""))
            traceback.print_exc()
            await queue.put(
                {
                    "kind": "error",
                    "content": f"agent crashed before producing output: {_exc!r}",
                }
            )
        except BaseException as _exc:  # exotic non-Exception death
            # A BaseException other than CancelledError/GeneratorExit (e.g. a
            # custom BaseException from a library) would otherwise escape _drive,
            # leaving the queue without its terminal None so run_graph hangs and
            # the SSE socket silently drops. Surface it as a visible error.
            _clean = False
            logger.exception(
                "[run_graph] run terminated by non-Exception chat_id=%s",
                initial.get("chat_id", ""),
            )
            await queue.put({"kind": "error", "content": f"agent crashed: {_exc!r}"})
        else:
            # Clean finish. The interrupted-turn resume checkpoint (LangGraph
            # checkpointer) is cleared by _run_mode_turn itself on a genuine clean
            # finish; on an error/interrupt it is deliberately LEFT behind so a
            # reconnect can resume the already-done tool work.
            pass
        finally:
            await queue.put(None)

    task = asyncio.create_task(_drive())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        # Reap the background drive task so it can never outlive this generator
        # (e.g. on GeneratorExit when the consumer stops early) and bleed model
        # requests into a subsequent test's mock capture.
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


# Repo-discovery cue (used by `_ask_needs_repo` and follow-up routing): a strong
# signal the question is about the project/codebase rather than general chat.
_ASK_REPO_CUES = re.compile(
    r"where is|where are|find|locate|trace|investigate|"
    r"which function|which class|which module|which file|which files|"
    r"what file|what module|what class|what function|"
    r"path of|implementation of|how does .* work|explain .* code|what does .* do|"
    r"codebase|source code|component|"
    r"کجا|پیدا کن|کدوم تابع|کدوم فانکشن|کدوم کلاس|کدوم ماژول|"
    r"پیاده سازی|چطور کار|کامپوننت",
    re.IGNORECASE,
)
