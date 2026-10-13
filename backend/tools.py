"""Sandboxed filesystem tools for the LangGraph agent.

Every path is resolved through a project ROOT. Absolute paths, `..` escapes and
symlink escapes are rejected by comparing realpaths so the agent can never touch
files outside the selected project folder.
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import difflib
import glob as _pyglob
import html
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unicodedata
import uuid
import warnings
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlparse

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)

import checkpoints as _checkpoints
import doc_tools as _doc_tools
import git_tools as _git
import providers as _providers
import state_db as _state_db
import subagent_jobs as _subagent_jobs
from agent_registry import AGENTS, agent_names, agent_system, agent_tools, resolve_agent
from cache import Cache, cache_path_for
from secret_utils import decrypt_secret
from tool_batching import (
    coalesce_io,
)
from vector_store import (
    KIND_WEB,
    StoreConfig,
    VectorStore,
    db_path_for,
    web_rag_path_for,
)

MAX_READ_BYTES = 2_000_000  # 2 MB
MAX_SEARCH_RESULTS = 200
MAX_FILES = 10_000
MAX_TERMINAL_OUTPUT = 10_000
TERMINAL_TIMEOUT = 120
TERMINAL_TIMEOUT_MAX = 300
# Tools a read-only research sub-agent must never receive: anything that can
# create, edit, delete, commit, confirm, run shell commands, manage tasks,
# or prompt the user. Web research tools (web_search/fetch_url) are
# intentionally NOT in this set.
_SUBAGENT_STRIPPED_TOOLS = frozenset({
    "write_file",
    "edit_file",
    "write_document",
    "confirm_action",
    "git_commit",
    "run_terminal",
    "terminal_stop",
    "terminal_logs",
    "create_skill",
    "create_mcp",
    "task",
    "task_steer",
    "task_stop",
    "update_plan",
    "vision",
    "ask_user",
    "request_permission",
    "computer",
})
_LONG_RUNNING_CMD_RE = re.compile(
    r"\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck)\S*"
    r"|pytest|vitest|jest|tsc|cargo\s+(?:test|build)|go\s+(?:test|build)|mvn|gradle)\b"
)
MAX_WEB_SEARCH_RESULTS = 10
WEB_SEARCH_SNIPPET_MAX = 200  # per-result snippet cap to keep search context lean
WEB_SEARCH_TIMEOUT = 15
WEB_SEARCH_AUTO_FETCH = 3  # top-N results to actually fetch full content for, not just snippet
WEB_SEARCH_FETCH_CHARS = 4000  # per-page cap when auto-fetched inside web_search (keeps distill input lean)
SEARCH_TIMEOUT = 20  # seconds for a ripgrep search
# `see` screenshot: xa11y/ScreenCaptureKit can hang forever without Screen
# Recording consent (packaged app) — outer bound so the tool always returns.
SEE_CAPTURE_TIMEOUT = 25
SNIPPET_CONTEXT = 3  # surrounding lines (each side) grep returns inline so a `read` is usually unnecessary
SNIPPET_LINE_WIDTH = 240  # per-line cap in grep snippets to keep results compact
_GREP_PER_FILE_CAP = 8  # max hits shown per file when a dump truncates across many files
_DEF_BODY_MAX_LINES = 60  # per-definition body lines expanded inline in grep hits
_DEF_BODY_MAX_COUNT = 6  # max definition bodies expanded inline per grep call
_LSP_REF_CAP = 40  # max reference locations returned per call (grouped by file)
_LSP_REF_INLINE_CAP = 25  # hits whose source line is inlined in lsp_references
_LSP_REF_INLINE_MAX_CHARS = 160  # per-line cap for inlined reference lines
_LSP_SYMBOLS_CAP = 400  # max document-symbol rows returned by lsp_symbols
_LSP_START_WAIT_S = 30.0  # in-tool wait for a lazy LSP start (initialize handshake)
# Keywords that never carry symbol information: a position snapped onto one
# (e.g. character=0 on "async def foo") makes the LSP answer empty, costing
# the model extra round-trips to re-guess the column.
_LSP_SKIP_WORDS = frozenset({
    "async", "await", "def", "class", "return", "yield", "import", "from",
    "const", "let", "var", "function", "export", "default", "public",
    "private", "protected", "static", "final", "void", "new", "type",
    "interface", "struct", "impl", "fn", "pub", "use", "package", "self",
    "cls", "this",
})

# Formatted results include output limits in their keys. In-flight sharing
# covers only raw scans, scoped to a workspace, event loop and edit generation.
_parent_search_cache: dict[tuple[str, ...], str] = {}
_search_generations: dict[str, int] = {}
_search_inflight: dict[tuple, asyncio.Task[dict]] = {}

# Search enforcement: hard limits for disciplined search behavior.
_MAX_GREP_ALTERNATIVES = 3
_MAX_SEARCH_BATCHES_WITHOUT_EDIT = 3
_SEARCH_BATCHES: dict[tuple[str, str], int] = {}
_SEARCH_BATCH_GENERATIONS: dict[tuple[str, str], int] = {}


def _count_grep_alternatives(combined: str) -> int:
    """Count top-level grep alternatives separated by unescaped '|'.

    Ignores escaped pipes (\\|), pipes inside [...] character classes,
    pipes inside (...) groups (a grouped alternation like `(popup|slash)`
    is ONE concept, not two), and empty alternatives from '||' or
    leading/trailing '|'.
    """
    if not combined:
        return 1
    parts: list[str] = []
    buf: list[str] = []
    in_class = False
    depth = 0
    i = 0
    n = len(combined)
    while i < n:
        ch = combined[i]
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(combined[i + 1])
            i += 2
            continue
        if ch == "[" and not in_class:
            in_class = True
            buf.append(ch)
            i += 1
            continue
        if ch == "]" and in_class:
            in_class = False
            buf.append(ch)
            i += 1
            continue
        if ch == "(" and not in_class:
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch == ")" and not in_class and depth:
            depth -= 1
            buf.append(ch)
            i += 1
            continue
        if ch == "|" and not in_class and not depth:
            parts.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf))
    count = sum(1 for p in parts if p != "")
    return max(1, count)


def _search_budget_key(root: str, chat_id: str = "") -> tuple[str, str]:
    """Scope the search budget by chat and workspace root."""
    return (str(chat_id or ""), str(root or ""))


def _sync_search_budget(root: str, chat_id: str = "") -> int:
    """Sync the search batch counter with the edit generation.

    Edits bump the search generation to invalidate cached scans, so a
    generation change means an edit happened and the counter resets.
    The counter is scoped by (chat_id, root) so one chat never blocks
    another, and make_tool_callbacks resets it per turn.
    """
    key = _search_budget_key(root, chat_id)
    gen_key = str(root or "")
    try:
        current_gen = int(_search_generations.get(gen_key, 0) or 0)
    except Exception:  # noqa: BLE001 - generation check never breaks search
        return int(_SEARCH_BATCHES.get(key, 0) or 0)
    last_gen = _SEARCH_BATCH_GENERATIONS.get(key)
    if last_gen is None:
        _SEARCH_BATCH_GENERATIONS[key] = current_gen
        return int(_SEARCH_BATCHES.get(key, 0) or 0)
    if last_gen != current_gen:
        _SEARCH_BATCH_GENERATIONS[key] = current_gen
        _SEARCH_BATCHES[key] = 0
        return 0
    return int(_SEARCH_BATCHES.get(key, 0) or 0)


def _note_search_batch(root: str, chat_id: str = "") -> int:
    """Record one search batch and return the new count."""
    key = _search_budget_key(root, chat_id)
    if key not in _SEARCH_BATCH_GENERATIONS:
        try:
            _SEARCH_BATCH_GENERATIONS[key] = int(_search_generations.get(str(root or ""), 0) or 0)
        except Exception:  # noqa: BLE001 - generation check never breaks search
            _SEARCH_BATCH_GENERATIONS[key] = 0
    count = int(_SEARCH_BATCHES.get(key, 0) or 0) + 1
    _SEARCH_BATCHES[key] = count
    return count


def _search_budget_message(count: int) -> str:
    """Mandatory message when the search batch budget is exceeded."""
    return (
        f"SEARCH BUDGET EXCEEDED: {count} search batches used without an edit "
        f"(max {_MAX_SEARCH_BATCHES_WITHOUT_EDIT}). Stop searching. Read specific "
        "files with read(symbols=[...]/ranges=[...]) in ONE call or make an edit "
        "before searching again. Search rule: LSP first, else ONE scoped grep "
        "path=backend include=*.py, then read symbols/ranges only. "
        "Batch searches, no blind scans."
    )

# Live checklist per chat (in-memory, mirrored to disk while open).
# update_plan merges the incoming full list with the stored one so a mid-run
# steer EDITS the open plan instead of replacing it, and completed steps are
# never reverted to pending/in_progress (the todo-redo bug). Frontend replaces
# its view with the emitted merged list (single source of truth here).
_PLAN_BY_CHAT: dict[str, list[dict]] = {}
# Mutating tool calls since the last update_plan, per chat (module-global so
# it survives across turns/callback rebuilds, unlike _plan_nudge_state).
# Powers the no-progress-repeat guard in update_plan: re-sending an unchanged
# checklist after real tool work ran means the panel is stuck.
_PLAN_MUTATING_SINCE_UPDATE: dict[str, int] = {}
# Last successful terminal run per chat for duplicate suppression.
_TERMINAL_LAST_RUN: dict[str, dict] = {}
# Read windows already delivered to a chat this session: (tool, abs_target,
# offset, limit). A repeat read of an unchanged window returns a tiny
# "unchanged" stub pointing at the earlier result instead of resending full
# bytes — saves tokens without an extra round-trip. Per chat so one chat's
# history never hides content from another; cleared with the chat and on edit
# of the file.
_READ_SEEN_BY_CHAT: dict[str, set[tuple]] = {}
# Served line ranges for the CURRENT turn: chat_id -> {abs_target ->
# [(start, end), ...]}. A read whose requested window lies fully inside an
# already-served range of the same unchanged file returns a one-line stub
# instead of resending bytes (live traces re-read overlapping windows of
# one file step after step). Reset per turn in make_tool_callbacks:
# cross-turn re-reads stay full because turn-start trimming may have
# replaced the earlier result with a placeholder.
_READ_RANGES_BY_CHAT: dict[str, dict[str, list[tuple[int, int]]]] = {}
# Lone single-window read CALLS per file this turn: chat_id -> {abs_target ->
# count}. A 3rd+ lone call on one file in one turn returns a batch-gate stub
# (no content) demanding ONE ranges=[...] batch — live traces paged one
# window per round-trip, each re-sending the whole context. Multi-window or
# multi-file calls never count; reset per turn and on edit like the map above.
_READ_LONE_CALLS_BY_CHAT: dict[str, dict[str, int]] = {}
# Files surfaced by a search (grep/glob/LSP) this turn: chat_id -> set of
# workspace-relative paths. A lone single-window read of a file never
# surfaced this turn is a blind read — it guesses paths and burns a full
# round-trip each. Reset per turn and on edit like the maps above.
_SEARCH_SURFACED_BY_CHAT: dict[str, set[str]] = {}


def _note_search_surfaced(chat_id: str, paths: Any) -> None:
    """Mark workspace-relative paths as surfaced by a search this turn."""
    cid = (chat_id or "").strip()
    if not cid:
        return
    try:
        bucket = _SEARCH_SURFACED_BY_CHAT.setdefault(cid, set())
        items = list(paths) if isinstance(paths, (list, tuple, set)) else [paths]
        for p in items:
            s = str(p or "").strip()
            if not s:
                continue
            while s.startswith("./"):
                s = s[2:].strip()
            if s and s != "/":
                bucket.add(s.rstrip("/"))
    except Exception:  # noqa: BLE001, S110 - surfacing never breaks search
        pass


def _read_range_covered(chat_id: str, target: str, start: int, end: int) -> tuple[int, int] | None:
    """Covering (start, end) served this turn for ``target``, if any."""
    try:
        ranges = _READ_RANGES_BY_CHAT.get((chat_id or "").strip(), {}).get(target)
    except Exception:  # noqa: BLE001 - lookup never breaks a read
        return None
    for s, e in ranges or []:
        if start >= s and end <= e:
            return (s, e)
    return None


def _note_read_range(chat_id: str, target: str, start: int, end: int) -> None:
    """Record a served window, merging overlaps/adjacency to keep it small."""
    cid = (chat_id or "").strip()
    if not cid or end < start:
        return
    try:
        ranges = _READ_RANGES_BY_CHAT.setdefault(cid, {}).setdefault(target, [])
        merged: list[tuple[int, int]] = []
        for s, e in ranges:
            if e < start - 1 or s > end + 1:
                merged.append((s, e))
                continue
            start = min(start, s)
            end = max(end, e)
        merged.append((start, end))
        merged.sort()
        _READ_RANGES_BY_CHAT[cid][target] = merged
    except Exception:  # noqa: BLE001, S110 - range mark never breaks a read
        pass


# Per-turn per-file served-line cap: past this many served lines of ONE
# file in ONE turn, further windows of that file return a stub pointing at
# grep/lsp_symbols — live traces paged a whole 8300-line file in 29 windows
# (~70K tokens in a single step) where a targeted lookup was the right
# move. Cleared with the served ranges on edit and at every new turn.
_READ_TURN_FILE_LINE_CAP = 3000


def _read_lines_served(chat_id: str, target: str) -> int:
    """Lines of ``target`` already served this turn (from merged ranges)."""
    ranges = _READ_RANGES_BY_CHAT.get((chat_id or "").strip(), {}).get(target)
    return sum(e - s + 1 for s, e in ranges or [])


def _read_uncovered_intervals(chat_id: str, target: str, start: int, end: int) -> list[tuple[int, int]]:
    """Not-yet-served sub-intervals of [start, end] for ``target`` this turn."""
    try:
        served = sorted(_READ_RANGES_BY_CHAT.get((chat_id or "").strip(), {}).get(target) or [])
    except Exception:  # noqa: BLE001 - lookup never breaks a read
        return [(start, end)]
    uncovered: list[tuple[int, int]] = []
    cur = start
    for s, e in served:
        if e < cur or s > end:
            continue
        if s > cur:
            uncovered.append((cur, min(s - 1, end)))
        cur = max(cur, e + 1)
        if cur > end:
            break
    if cur <= end:
        uncovered.append((cur, end))
    # Gap bridging: swallow small unserved slivers next to served ranges so a
    # shifted re-read leaves nothing for yet another round-trip. Bounded by gap cap.
    if uncovered:
        try:
            gap = int(_READ_JOIN_GAP)
        except Exception:  # noqa: BLE001 - bridging never breaks a read
            gap = 0
        if gap > 0:
            bridged: list[tuple[int, int]] = []
            for us, ue in uncovered:
                ns, ne = us, ue
                prev = max((e for s, e in served if e < us), default=None)
                if prev is not None and us - prev - 1 <= gap:
                    ns = prev + 1
                nxt = min((s for s, e in served if s > ue), default=None)
                if nxt is not None and nxt - ue - 1 <= gap:
                    ne = nxt - 1
                bridged.append((ns, ne))
            bridged.sort()
            merged: list[list[int]] = [[bridged[0][0], bridged[0][1]]]
            for a, b in bridged[1:]:
                if a <= merged[-1][1] + 1:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            uncovered = [(a, b) for a, b in merged]
    return uncovered


# Background terminal jobs: job_id -> {pid, command, log_file, started_at,
# status, returncode}. Module-global so stop/logs work across turns.
_TERMINAL_BG_JOBS: dict[str, dict] = {}
_TERMINAL_BG_LOCK = threading.Lock()
_TERMINAL_BG_LOG_DIRNAME = "codifa-terminal"


def clear_chat_state(chat_id: str) -> None:
    """Drop per-chat in-memory state so a deleted chat never leaks."""
    cid = (chat_id or "").strip()
    if not cid:
        return
    _PLAN_BY_CHAT.pop(cid, None)
    _PLAN_MUTATING_SINCE_UPDATE.pop(cid, None)
    _TERMINAL_LAST_RUN.pop(cid, None)
    _READ_SEEN_BY_CHAT.pop(cid, None)
    _READ_RANGES_BY_CHAT.pop(cid, None)
    _READ_LONE_CALLS_BY_CHAT.pop(cid, None)
    _SEARCH_SURFACED_BY_CHAT.pop(cid, None)
    for k in [k for k in list(_SEARCH_BATCHES.keys()) if isinstance(k, tuple) and k[0] == cid]:
        _SEARCH_BATCHES.pop(k, None)
    for k in [k for k in list(_SEARCH_BATCH_GENERATIONS.keys()) if isinstance(k, tuple) and k[0] == cid]:
        _SEARCH_BATCH_GENERATIONS.pop(k, None)


async def _shared_search(
    root: str,
    key: tuple[str, ...],
    generation: int,
    scan: Callable[..., dict],
    *args: Any,
) -> dict:
    """Share raw I/O only; each caller owns formatting, permissions and events."""
    flight_key = (asyncio.get_running_loop(), root, generation, key)
    task = _search_inflight.get(flight_key)
    if task is None:
        task = asyncio.create_task(asyncio.to_thread(scan, *args))
        _search_inflight[flight_key] = task

        def finished(done: asyncio.Task) -> None:
            if _search_inflight.get(flight_key) is done:
                del _search_inflight[flight_key]
            # Retrieve exceptions even if every waiter was cancelled.
            if not done.cancelled():
                done.exception()

        task.add_done_callback(finished)
    # Cancelling one invocation must not cancel another invocation's scan.
    return await asyncio.shield(task)


def _invalidate_read_cache_for(path: str, root: str) -> None:
    """Drop cached read/grep/glob results affected by an edit under ``root``.

    Called after edit_file/write_file so a re-read/re-search reflects new
    content instead of returning stale cached bytes.

    - ``read`` entries are keyed by the normalized absolute path ("read",
      target, offset, limit) — see ``_read_target`` — so only the touched
      file's cached reads are dropped.
    - ``grep``/``glob`` entries are keyed by pattern/path, not by which files
      they matched, so we can't tell which cached searches this specific edit
      would affect. Instead every grep/glob entry scoped to this ``root`` is
      dropped — cheap (they lazily re-populate on next use) and guarantees a
      stale match never survives an edit.
    """
    try:
        norm = resolve_safe(root, path, allow_coder=True)
    except PathEscapeError:
        # Path escapes the sandbox: read_tool never cached it under this path,
        # but grep/glob entries for this root may still exist — fall through.
        norm = None
    _search_generations[root] = _search_generations.get(root, 0) + 1
    # Search budget: an edit resets the counter for every chat scoped to
    # this root (scoped keys are (chat_id, root) tuples).
    try:
        _gen = int(_search_generations.get(root, 0) or 0)
        for k in list(_SEARCH_BATCHES.keys()):
            if isinstance(k, tuple) and len(k) == 2 and k[1] == str(root or ""):
                _SEARCH_BATCHES[k] = 0
        for k in list(_SEARCH_BATCH_GENERATIONS.keys()):
            if isinstance(k, tuple) and len(k) == 2 and k[1] == str(root or ""):
                _SEARCH_BATCH_GENERATIONS[k] = _gen
        _SEARCH_BATCHES.pop(str(root or ""), None)
        _SEARCH_BATCH_GENERATIONS.pop(str(root or ""), None)
    except Exception:  # noqa: BLE001, S110 - budget reset never breaks edit
        pass
    stale = [
        k
        for k in _parent_search_cache
        if (k[0] == "read" and norm is not None and k[1] == norm)
        or (k[0] in ("grep", "glob") and len(k) > 4 and k[4] == root)
    ]
    for k in stale:
        del _parent_search_cache[k]
    if norm is not None:
        # The file changed: any chat that already saw it must get full bytes
        # on the next read, not the "unchanged" stub.
        try:
            for _seen in _READ_SEEN_BY_CHAT.values():
                for _k in [k for k in _seen if len(k) > 1 and k[0] == "read" and k[1] == norm]:
                    _seen.discard(_k)
        except Exception:  # noqa: BLE001, S110 - seen purge never breaks edit
            pass
        try:
            for _ranges in _READ_RANGES_BY_CHAT.values():
                _ranges.pop(norm, None)
        except Exception:  # noqa: BLE001, S110 - range purge never breaks edit
            pass
        try:
            for _lone in _READ_LONE_CALLS_BY_CHAT.values():
                _lone.pop(norm, None)
        except Exception:  # noqa: BLE001, S110 - lone-call purge never breaks edit
            pass
        # Edited file is known fresh: post-edit verification reads must pass
        # the search-first gate without a redundant search round-trip.
        if norm is not None:
            try:
                _rel = os.path.relpath(str(norm), str(root or ""))
            except Exception:  # noqa: BLE001 - relpath never breaks edit
                _rel = ""
            if _rel:
                try:
                    for _bucket in _SEARCH_SURFACED_BY_CHAT.values():
                        try:
                            _bucket.add(_rel)
                        except Exception:  # noqa: BLE001, S110 - one bucket never breaks edit
                            pass
                except Exception:  # noqa: BLE001, S110 - surfacing never breaks edit
                    pass


def _normalize_search_scope(path: str) -> str:
    """Normalize a grep/glob scope so near-duplicate ranges share one scan.

    Strips whitespace, a leading "./", and trailing slashes: "backend/",
    "./backend" and "backend" are the same directory. Empty (or "/") stays
    the whole-workspace scope. Case is preserved (paths are case-sensitive).
    """
    p = str(path or "").strip()
    while p.startswith("./"):
        p = p[2:].strip()
    if p == "/":
        return ""
    if len(p) > 1:
        p = p.rstrip("/")
    return p

# Sub-agent model calls (web distiller)
# share the parent turn's retry policy so a free-tier rate limit or connection
# blip on the gateway retries the sub-agent instead of failing the whole turn
# and re-burning parent tokens. Flat 30s cadence, up to 10 attempts, then the
# caller's existing fallback path runs (raw output / error message).
_SUBAGENT_RETRY_SECONDS = 5
_SUBAGENT_MAX_ATTEMPTS = 3

# Set by agents.py before each agent run: the AUTO-SCOUTED WORKSPACE OVERVIEW
# text (root listing — _AUTO_SCOUT_KEY_FILES is empty, so it's just the tiny
# root-entries line). The agent reads it to know the root is already listed,
# so it doesn't re-glob the root to orient itself (a duplicate of the main
# agent's auto-scout).
_SCOUT_CTX: contextvars.ContextVar[str] = contextvars.ContextVar(
    "coder_scout_ctx", default=""
)

# Sub-agent depth limit (opencode's `subagent_depth`, default 1): the parent can
# spawn a sub-agent, but a sub-agent cannot spawn another. The `task` tool
# checks this before running; the sub-agent's tools exclude `task` so
# nesting is impossible anyway — this is a belt-and-suspenders guard.
_SUBAGENT_DEPTH_LIMIT = 1
_TASK_DEPTH_CTX: contextvars.ContextVar[int] = contextvars.ContextVar(
    "coder_task_depth", default=0
)

# Set while a background sub-agent runs: its tool calls reuse the PARENT's
# tool functions (which emit into the same stream), and these flags make
# `_emit` tag them `sub=True` and stamp the task card's branch id on them, so
# they nest under the task card and never count against the parent's
# deterministic tool-step budget (they run in an isolated transcript).
_SUB_AGENT_CTX: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "coder_sub_agent_ctx", default=False
)
_SUB_AGENT_BRANCH_CTX: contextvars.ContextVar[int] = contextvars.ContextVar(
    "coder_sub_agent_branch", default=0
)

# Set by agents.py after per-mode capability filtering: the parent agent's
# ACTUAL toolset for this run (write tools stripped in plan/ask, read-only
# terminal, etc.). The sub-agent builds its tools from THIS instead of
# the full registry, so a `task` call can never hand a read-only mode's
# sub-agent write_file/edit_file/confirm_action (the "edited files while in
# plan mode" bypass). None = fall back to the full registry (task invoked
# outside a normal agent run).
_PARENT_TOOLS_CTX: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "coder_parent_tools", default=None
)

def _is_content_gathering(text: str) -> bool:
    """Heuristic for whether a task needs substantial verbatim content from
    several files (styling / refactor / rewrite) rather than a narrow lookup.

    Drives one behavior: ``task_tool`` gives content-heavy tasks a bigger
    report budget and allows verbatim code blocks. Keyword-based on purpose —
    cheap and stable — not a full classifier. ``path_hint``/``hints`` presence
    alone does NOT count: a scoped question can still be a short fact-lookup.
    """
    if not text:
        return False
    low = text.lower()
    return any(
        k in low
        for k in (
            "restyle",
            "redesign",
            "restructure",
            "rewrite",
            "styling",
            "styles",
            "css",
            "jsx",
            "tsx",
            "scss",
            "border",
            "borders",
            "read the full",
            "full content",
            "verbatim",
            "entire component",
            "entire file",
            "get the css",
            "get the jsx",
            "get the code",
            "refactor",
            "migrate",
            "extract",
            "inline",
            "reflow",
        )
    )


def _parse_json_list(text: str) -> list[str]:
    """Best-effort parse of a JSON array (possibly wrapped in markdown fences
    or prose) into a list of strings. Returns [] when nothing parseable."""
    if not text:
        return []
    _m = re.search(r"\[.*\]", text, re.DOTALL)
    if _m:
        text = _m.group(0)
    try:
        _data = json.loads(text)
        if isinstance(_data, list):
            return [str(x) for x in _data]
    except Exception:  # noqa: BLE001, S110
        pass
    _lines = re.split(r"[\n•\-]+", text)
    return [
        l.strip().strip('"').strip("'").strip()
        for l in _lines
        if l.strip() and not l.strip().startswith(("```", "json"))
    ]


# --- ask_user option cleaning ----------------------------------------------
# مدل‌های ضعیف گاهی آرایهٔ options ابزار ask_user را خراب تولید می‌کنند:
# کوتیشن‌های خام دور گزینه‌ها («"git integration"»)، تکرار یک گزینه، یا
# چسبیدن چند گزینه داخل یک رشته با کوتیشن‌های جداکننده. پاک‌سازِ زیر
# خروجی تمیز برای کارت سؤال می‌سازد و پاسخی که کاربر می‌زند هم متنِ
# پاک‌شده را به مدل برمی‌گرداند.

_ASK_QUOTE_PAIRS = {'"': '"', "'": "'", "«": "»", "“": "”", "„": "“", "‹": "›"}
# سقف ضدسیل — خود ابزار ۲ تا ۵ گزینه می‌خواهد؛ بیشتر از این نشانهٔ گلیچ است.
_ASK_MAX_OPTIONS = 8
# حداقل کوتیشنِ داخلی برای بازکردن گزینهٔ چسبیده؛ کمتر از این، احتمالاً یک
# عبارت کوتیشن‌دارِ عادی داخل گزینه است (مثل Use "strict" mode) و نباید بشکند.
_ASK_GLUE_MIN_QUOTES = 3
# مدل گاهی به‌جای رشته، آبجکت می‌فرستد (مثل {"description": "..."})؛ مقدار
# خوانا از این کلیدها برداشته می‌شود و خرده‌ریزهای بلاب دور ریخته می‌شوند.
_ASK_DICT_VALUE_KEYS = ("description", "label", "text", "title", "option", "value", "name")
_ASK_JUNK_KEYS = frozenset({"description", "label", "text", "title", "option", "value", "name", "options", "question"})
_ASK_JUNK_SINGLE = frozenset('{}[]():;,.،"\'«»“”„‹›')


def _strip_outer_quotes(text: str) -> str:
    """حذف جفت‌کوتیشن‌های متقارن دور متن — مثل "گزینه" یا «گزینه» (تودرتو هم)."""
    out = text.strip()
    while len(out) >= 2 and out[-1] == _ASK_QUOTE_PAIRS.get(out[0]):
        out = out[1:-1].strip()
    return out


def _is_ask_junk(text: str) -> bool:
    """تشخیص خرده‌ریز بلاب JSON-ish — آکولاد/کروشه/کولن تنها یا کلیدهایی مثل description."""
    s = text.strip().strip(",;،:[]{}").strip().strip("\"'«»“”„‹›").strip()
    if not s:
        return True
    if len(s) == 1 and (s in _ASK_JUNK_SINGLE or not s.isalnum()):
        return True
    return s.casefold() in _ASK_JUNK_KEYS


def _split_glued_option(text: str) -> list[str]:
    """بازکردن گزینه‌های به‌هم‌چسبیده به سگمنت‌های بین کوتیشن‌ها.

    وقتی مدل JSON آرگومان را خراب می‌نویسد، چند گزینه داخل «یک» رشته با
    کوتیشن‌های جداکننده می‌آیند (مثل a"b"c"d"e). هر سگمنتِ ناصفر یک گزینهٔ
    مجزاست؛ ویرگول/سمی‌کول/آکولاد/کولن ابتدا و انتهای سگمنت هم پاک می‌شود و
    خرده‌ریزهای بلاب JSON-ish (مثل { و } و : و description) دور ریخته می‌شوند.
    """
    if text.count('"') >= _ASK_GLUE_MIN_QUOTES:
        segments: list[str] = []
        for part in text.split('"'):
            part = part.strip().strip(",;،:[]{}").strip().strip("\"'«»“”„‹›").strip()
            if part and not _is_ask_junk(part):
                segments.append(part)
        return segments or [text]
    # بلاب شبه‌JSON بدون کوتیشن کافی (مثل {description: ...}) — با آکولاد و کولن بشکن.
    # اما JSON معتبر (مثل {"x": 1}) دست‌نخورده می‌ماند تا تست coerce نشکند.
    if "{" in text and "}" in text and ":" in text:
        try:
            json.loads(text)
            return [text]
        except (ValueError, TypeError):
            pass
        blob = text
        for ch in "{}[]:\n":
            blob = blob.replace(ch, '"')
        segments = []
        for part in blob.split('"'):
            for sub in re.split(r"[,;،؛]+", part):
                sub = sub.strip().strip(",;،:[]{}").strip().strip("\"'«»“”„‹›").strip()
                if sub and not _is_ask_junk(sub):
                    segments.append(sub)
        if segments:
            return segments
    return [text]


def _clean_ask_options(raw: Any) -> list[str]:
    """نرمال‌سازی options ابزار ask_user به فهرست تمیز از رشته‌ها.

    آیتم غیررشته‌ای (object/number/…) به رشته تبدیل می‌شود، کوتیشن‌های دورِ
    هر گزینه حذف می‌شود، گزینه‌های چسبیده باز می‌شوند، تکراری‌ها (بدون
    حساسیت به بزرگی/کوچکی حرف) حذف می‌شوند و سقف تعداد اعمال می‌شود.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = _parse_json_list(raw) or [raw]
    if not isinstance(raw, (list, tuple)):
        raw = [raw]
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if item is None:
            continue
        if isinstance(item, str):
            text = item
        elif isinstance(item, dict):
            text = ""
            for k in _ASK_DICT_VALUE_KEYS:
                v = item.get(k)
                if isinstance(v, str) and v.strip():
                    text = v
                    break
            if not text:
                for v in item.values():
                    if isinstance(v, str) and v.strip():
                        text = v
                        break
            if not text:
                text = json.dumps(item, ensure_ascii=False)
        elif isinstance(item, (list, tuple)):
            text = json.dumps(list(item), ensure_ascii=False)
        else:
            text = str(item)
        for opt in _split_glued_option(_strip_outer_quotes(text)):
            opt = opt.strip()
            if not opt or _is_ask_junk(opt):
                continue
            key = opt.casefold()
            if key not in seen:
                seen.add(key)
                cleaned.append(opt)
    return cleaned[:_ASK_MAX_OPTIONS]


async def _run_subagent_call(
    factory: Callable[[], Any],
    label: str,
    *,
    emit: Callable[[dict], None] | None = None,
    model_name: str = "",
) -> Any:
    """Run a sub-agent model call (``factory`` → coroutine) exactly ONCE with
    NO retry backoff: a transient throttle, retryable, or empty-output error
    propagates immediately so the caller's per-call fallback handles it FAST.
    The old 30s x 10 retry policy (up to 5 minutes of silent backoff per call)
    is what made a sub-agent run feel like it searched for half an hour.
    Resilience is instead provided per-call by the callers: _run_distill's
    main-model fallback. Returns the coroutine's result.
    """
    # NO RETRY: a transient throttle, retryable, or empty-output error
    # propagates immediately so the caller's per-call fallback handles it fast.
    # The old 30s x 10 backoff (up to 5 minutes of silent stalling per call) is
    # what made a sub-agent run feel like it searched for half an hour.
    return await factory()


# --- Adaptive sub-agent output cap ---------------------------------------
# We want a hard upper bound on how many tokens a sub-agent may generate even
# when there is no external timeout (a slow local model otherwise produces
# unbounded output and the turn stalls indefinitely).  But we must never set a
# cap larger than the model's real context window — that is exactly what caused
# the old "Model token limit (400) exceeded" crash on small-window local
# models.  So the cap is derived as a fraction of the window, with a safe
# headroom, and falls back to "no cap" (None) when we cannot learn the window.
_SUBAGENT_MT_CACHE: dict[int, object] = {}
_MISSING = object()


async def _subagent_max_tokens(model, *, narrow: bool = True):
    """Bounded-but-safe max_tokens for a sub-agent run.

    `narrow=True` for cheap sub-agents (distillers) that only need a short
    answer; `narrow=False` for sub-agents whose prompt is larger.
    Returns None when the model's window is unknown (caller then sends no cap).
    """
    key = id(model)
    cached = _SUBAGENT_MT_CACHE.get(key, _MISSING)
    if cached is not _MISSING:
        return cached
    val = await _resolve_subagent_max_tokens(model, narrow=narrow)
    _SUBAGENT_MT_CACHE[key] = val
    return val


async def _resolve_subagent_max_tokens(model, *, narrow: bool) -> int | None:
    ctx = await _model_context_window(model)
    if not ctx or ctx <= 0:
        return None
    headroom = 512  # room for the (often large) sub-agent prompt + history
    raw = (ctx // 4) if narrow else (ctx // 8)
    # Cap at a value that is safely under any model's *output* limit (most
    # providers reject max_tokens above their max output, often ~8K) while still
    # bounding runaway generation when no external timeout is in force.
    cap = min(raw, 8000, max(64, ctx - headroom))
    return max(cap, 64)


async def _model_context_window(model) -> int:
    """Best-effort context-window lookup. 0 when unknown."""
    info = getattr(model, "model_info", None)
    cw = int(getattr(info, "context_window", 0) or 0)
    if cw:
        return cw
    m = getattr(model, "_model", model)
    name = getattr(m, "model_name", "") or getattr(model, "model_name", "") or ""
    if not name:
        return 0
    base_url = ""
    prov_obj = getattr(m, "provider", None) or getattr(model, "provider", None)
    if prov_obj is not None:
        bu = getattr(prov_obj, "base_url", None)
        if bu is not None:
            base_url = str(bu)
    low = base_url.lower()
    if "ollama" in low:
        prov = "ollama"
    elif "openrouter" in low:
        prov = "openrouter"
    else:
        prov = "openai"
    try:
        from providers import model_context as _mc

        return await _mc(prov, name, base_url)
    except Exception:  # noqa: BLE001
        return 0




def _subagent_fail_note(agent: str, model: str, exc: Exception) -> str:
    """A short, actionable note for when a subagent fails — names BOTH the
    subagent and the model it ran on so the user can change the right one in
    Settings → Tools. Returns '' when there's nothing useful to say."""
    text = str(exc).strip()
    if model:
        return (
            f"Note: the {agent} sub-agent model ({model}) failed — change it in "
            f"Settings → Tools. ({text})"
        )
    if text:
        return f"Note: the {agent} sub-agent failed. ({text})"
    return ""


def _subagent_fail_scope_note(agent: str, model: str, exc: Exception) -> str:
    """A structured failure note for the background sub-agent that steers the
    Main Agent AWAY from reading the whole codebase manually. Instead of a raw
    error that triggers 'find the bug yourself' behavior, it tells the Main
    Agent to re-delegate with a NARROWER scope (a specific folder/pattern/symbol)
    so the sub-agent can succeed cheaply on the retry."""
    text = str(exc).strip()
    return (
        f"ERROR: the {agent} sub-agent failed ({model}): {text}. "
        "Do NOT read the whole codebase manually. Re-delegate with a NARROWER "
        "scope (name the folder/pattern/symbol) via task(subagent_type='subagent')."
    )


_explore_fail_note = _subagent_fail_scope_note


# Web-search backends are pluggable via Settings → Plugins. Each engine is a
# function ``(query, max_results, cfg) -> list[dict]`` where ``cfg`` is that
# plugin's saved row; a new engine later = add its function here + one entry in
# ``SEARCH_BACKENDS``, nothing else touches. ``duckduckgo`` needs no key and is
# the built-in fallback. Private imports stay lazy so a missing/old package
# degrades to a friendly message instead of failing at import time.
def _active_search_engines() -> list[dict]:
    try:
        cfg = (_state_db.get_settings() or {}).get("searchPlugins") or []
    except Exception:  # noqa: BLE001
        return [{"kind": "duckduckgo"}]
    enabled = [p for p in cfg if isinstance(p, dict) and p.get("enabled")]
    if not enabled:
        return [{"kind": "duckduckgo"}]
    return sorted(enabled, key=lambda p: int(p.get("order", 99)))


def _ddg_search(query: str, max_results: int, cfg: dict) -> list[dict]:
    from ddgs import DDGS

    with DDGS(timeout=WEB_SEARCH_TIMEOUT) as ddgs:
        raw = ddgs.text(query, max_results=max_results)
    out = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "title": str(item.get("title", "")).strip(),
                "url": str(item.get("href", "") or item.get("url", "")).strip(),
                "snippet": str(item.get("body", "") or item.get("snippet", "")).strip(),
            }
        )
    return out


def _tavily_search(query: str, max_results: int, cfg: dict) -> list[dict]:
    """Tavily search API. Needs the plugin's ``apiKey`` set in Settings → Plugins."""
    import httpx

    key = decrypt_secret(cfg.get("apiKey") or "")
    if not key:
        raise RuntimeError("tavily search needs an API key")
    with httpx.Client(timeout=WEB_SEARCH_TIMEOUT) as client:
        resp = client.post(
            "https://api.tavily.com/search",
            json={"api_key": key, "query": query, "max_results": max_results},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"tavily {resp.status_code}: {resp.text[:200]}")
        results = resp.json().get("results") or []
    return [
        {
            "title": str(item.get("title", "")).strip(),
            "url": str(item.get("url", "")).strip(),
            "snippet": str(
                item.get("content", "") or item.get("snippet", "") or ""
            ).strip(),
        }
        for item in results
        if isinstance(item, dict)
    ]


SEARCH_BACKENDS: dict[str, Callable[[str, int, dict], list[dict]]] = {
    "duckduckgo": _ddg_search,
    "tavily": _tavily_search,
}

_TEXT_EXTENSIONS = {
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".md",
    ".mdx",
    ".txt",
    ".html",
    ".css",
    ".scss",
    ".less",
    ".vue",
    ".svelte",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".rs",
    ".go",
    ".java",
    ".kt",
    ".swift",
    ".rb",
    ".php",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".sql",
    ".xml",
    ".ini",
    ".cfg",
    ".conf",
    ".env",
    ".csv",
    ".tsv",
    ".ipynb",
}

_BINARY_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".svg",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".rar",
    ".7z",
    ".exe",
    ".dmg",
    ".dll",
    ".so",
    ".dylib",
    ".o",
    ".a",
    ".bin",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp4",
    ".mp3",
    ".wav",
    ".mov",
    ".avi",
    ".db",
    ".sqlite",
    ".pyc",
    ".pyo",
    ".class",
    ".jar",
    ".wasm",
}

_SKIP_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    "dist",
    "dist-electron",
    "release",
    "build",
    "coverage",
    ".cache",
    ".idea",
    ".vscode",
    ".DS_Store",
    "target",
    "vendor",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".github",
    ".playwright",
    ".playwright-mcp",
    "out",
    "bin",
    "obj",
}

# ripgrep globs that exclude the deny-list dirs even when `--hidden` is passed
# (rg would otherwise search inside `.git`/`node_modules` once hidden files are
# enabled). `.DS_Store` is a file, so it needs its own negation glob.
# `.tmp-*` are the user's own scratch/throwaway files & folders (e.g.
# `.tmp-codemap.mjs`, `.tmp-dedupe.mjs`) — never real workspace content, so
# they're excluded the same way; a name-only glob (no leading path) matches
# at any depth and, for a directory, stops rg from descending into it at all.
_RG_EXCLUDE_GLOBS = [
    "!{" + ",".join(sorted(_SKIP_DIRS)) + "}/**",
    "!.DS_Store",
    "!.tmp-*",
]

_TERMINAL_BLOCK = [
    (r"^\s*sudo\b", "sudo (privilege escalation) is blocked"),
    (r"^\s*su\b", "su (user switch) is blocked"),
    (
        r"\b(mkfs|fdisk|parted|mkpart|gparted)\b",
        "disk partitioning commands are blocked",
    ),
    (r"\b(shutdown|reboot|poweroff|halt)\b", "system control commands are blocked"),
    (r"rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/?\*", "destructive rm is blocked"),
    (r"rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/?\s", "destructive rm is blocked"),
    (
        r"rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+~",
        "destructive rm on the home directory is blocked",
    ),
    (r"(^\s*|[;&|]\s*|\$\s*\(\s*)open\b", "the macOS `open` launcher is blocked"),
    (r"dd\s+if=", "dd is blocked"),
    (r"(>|>>)\s*/dev/(sd|disk)", "raw disk access is blocked"),
    (r":\(\)\{", "fork bombs are blocked"),
    (r"\|\s*(sh|bash|zsh)\b", "piping into a shell is blocked"),
]

_TERMINAL_BLOCK_RE = [
    (re.compile(pat, re.IGNORECASE), msg) for pat, msg in _TERMINAL_BLOCK
]


def _blocked_terminal(command: str) -> str | None:
    """Return a reason string if ``command`` is dangerous, else None."""
    for pattern, msg in _TERMINAL_BLOCK_RE:
        if pattern.search(command):
            return msg
    return None


def _exec_terminal(command: str, root: str, timeout: int) -> tuple[int, str]:
    """Run ``command`` in ``root`` via the shell; returns (exit_code, output).

    ``shell=True`` is INTENTIONAL here and not an injection risk: this is the
    terminal tool — the whole ``command`` string IS the tool's input (the agent
    builds it itself), so there is no trusted prefix being concatenated with
    untrusted data and no injection boundary to cross. The command runs as the
    same user, sandboxed to ``root`` by ``_blocked_terminal``/``_escapes_root``.
    A list-based exec (no shell) would break pipes/redirects/``&&`` that
    build/test/lint commands legitimately need. Every OTHER subprocess call in
    this file (MCP probe, tsc, rg) passes an argument list with no shell.
    """
    try:
        # The sidecar inherits CODER_DATA_DIR (the real user data root) from
        # Electron. Agent-run commands (pytest, scripts) must not see it, or a
        # test/cleanup run could read or wipe the user's real ~/.codifa.
        term_env = {k: v for k, v in os.environ.items() if k != "CODER_DATA_DIR"}
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",  # tolerate non-UTF-8 bytes in terminal output
            start_new_session=True,
            env={**term_env, "PYTHONUNBUFFERED": "1"},
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            stdout, stderr = proc.communicate()
            output = (
                f"[command timed out after {timeout}s and was killed — do NOT "
                f"re-run the same command; pass a larger `timeout` (max "
                f"{TERMINAL_TIMEOUT_MAX}s) or run a narrower target]\n"
                + (stdout or "")
                + (stderr or "")
            )
            return -1, output
        code = proc.returncode
        output = (stdout or "") + (stderr or "")
    except OSError as exc:
        return -1, str(exc)
    if len(output) > MAX_TERMINAL_OUTPUT:
        _head = MAX_TERMINAL_OUTPUT // 3
        _tail = MAX_TERMINAL_OUTPUT - _head
        output = (
            output[:_head]
            + f"\n...({len(output) - MAX_TERMINAL_OUTPUT} chars truncated)...\n"
            + output[-_tail:]
        )
    return code, output


def _escapes_root(command: str, root: str, permit: dict | None = None) -> str | None:
    """Return a reason string if ``command`` references paths outside ``root``.

    The file tools are already sandboxed through ``resolve_safe``; this gives the
    terminal the same guarantee so the agent can't drift into ``~/.config``,
    ``/Users/...`` or any other path outside the selected workspace on its own.

    Per-folder grants (``permit["folders"]``) allow paths under the exact
    folders the user approved; ``permit["outside"]`` allows everything.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    folders = _permit_folders(permit)
    # Home / $HOME expansions point outside the workspace.
    # Home / $HOME expansions point outside the workspace. `$` is not a word
    # char, so a leading `\b` can't anchor `$HOME` after a space/`=` — anchor on
    # the preceding non-word char (or start) instead.
    if re.search(
        r"~\s*(/|\\)?|(?:^|[^\w])\$HOME\b|(?:^|[^\w])\$\{HOME\}|(?:^|[^\w])\{HOME\}",
        command,
        re.IGNORECASE,
    ):
        # `~`/`$HOME` alone can't tell WHICH folder is meant — allow only when
        # the home dir itself (or everything) is granted, else block.
        home = os.path.realpath(os.path.expanduser("~"))
        if not _path_in_folders(home, folders):
            return "references paths outside the project root (~ / $HOME)"
    # `..` can climb out of root.
    if re.search(r"(^|[\s;|&])\.\.(/|\s|$)", command):
        return "references paths outside the project root (..)"
    # Absolute paths must lie inside the workspace (or a safe system sink).
    _os_tmp = tempfile.gettempdir().rstrip("/\\") + os.sep
    _SAFE_ABS = ("/dev/null", _os_tmp, "/tmp/", "/dev/std", "/dev/fd")
    for m in re.finditer(r"(?:^|[\s;|&])(/[^\s;|&'\"`]*)", command):
        p = m.group(1)
        # توکنِ فقط-اسلش (مثل `//` در `width // 2`) عملگر تقسیم صحیح پایتون
        # است، نه مسیر — realpath آن می‌شود `/` و به‌دروغ بلاک می‌کند.
        if not p.strip("/"):
            continue
        if p == "/tmp" or p.rstrip("/\\") == _os_tmp.rstrip("/\\") or p.startswith(_SAFE_ABS):
            continue
        try:
            real = os.path.realpath(p)
        except Exception:  # noqa: BLE001
            real = p
        if real != root_real and not real.startswith(root_real + os.sep):
            if _path_in_folders(real, folders):
                continue
            return f"references path outside the project root: {p}"
    return None


def _writes_outside_root(command: str) -> str | None:
    """Return a reason string if ``command`` installs/modifies system state.

    Package managers (brew/apt/port/pip --user/npm -g/...) write OUTSIDE the
    workspace even though the command text itself contains no outside path —
    so ``_escapes_root`` alone can't catch them. Without this guard the agent
    could run e.g. ``brew install tree-sitter`` right after the user DENIED
    ``request_permission`` for it, because the bare command text looks
    workspace-local.
    """
    _INSTALLERS = [
        (r"(^|[\s;|&])(brew|apt|apt-get|port|nix-env|pacman|dnf|yum|zypper)\b", "system package manager"),
        (r"(^|[\s;|&])pip3?\s+install\b", "pip install"),
        (r"(^|[\s;|&])uv\s+(pip|tool)\s+install\b", "uv install"),
        (r"(^|[\s;|&])uv\s+add\b", "uv add"),
        (r"(^|[\s;|&])uv\s+sync\b", "uv sync"),
        (r"(^|[\s;|&])npm\s+(-\S+\s+)*install\s+(-\S+\s+)*-g\b", "global npm install"),
        (r"(^|[\s;|&])npm\s+(-\S+\s+)*i\s+(-\S+\s+)*-g\b", "global npm install"),
        (r"(^|[\s;|&])pnpm\s+(-\S+\s+)*(-g|--global)\b", "global pnpm install"),
        (r"(^|[\s;|&])yarn\s+global\b", "global yarn install"),
        (r"(^|[\s;|&])cargo\s+install\b", "cargo install"),
        (r"(^|[\s;|&])gem\s+install\b", "gem install"),
        (r"(^|[\s;|&])go\s+install\b", "go install"),
        (r"(^|[\s;|&])rustup\b", "rustup"),
        (r"(^|[\s;|&])choco\b", "choco"),
        (r"(^|[\s;|&])winget\b", "winget"),
        (r"(^|[\s;|&])scoop\b", "scoop"),
    ]
    for pattern, label in _INSTALLERS:
        if re.search(pattern, command):
            return (
                f"runs {label}, which installs/modifies state outside the workspace. "
                "Do NOT report 'not installed' and stop. "
                "Ask the user for permission (request_permission) before installing anything "
                "and WAIT for the grant, then retry this same command."
            )
    return None


def _is_install_action(action: str) -> bool:
    """True when a permission/confirm action is really an install request."""
    text = str(action or "").lower()
    return "install" in text or "uv add" in text or "uv sync" in text


_MISSING_DEP_RE = re.compile(
    r"(modulenotfounderror|no module named|command not found|not installed|"
    r"cannot find module|no such package|package not found)",
    re.IGNORECASE,
)


def _terminal_bg_log_dir() -> str:
    """Directory for background terminal log files (OS temp dir only)."""
    base = tempfile.gettempdir()
    path = os.path.join(str(base), _TERMINAL_BG_LOG_DIRNAME)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        path = os.path.join(tempfile.gettempdir(), _TERMINAL_BG_LOG_DIRNAME)
        os.makedirs(path, exist_ok=True)
    return path


# Background routing is generic on purpose: every detached launch goes
# through the dev_server registry first (fallback: plain Popen). No
# per-stack command list is kept here, so any project type works.





def _terminal_bg_start(command: str, root: str, log_file: str | None = None) -> dict:
    """Spawn ``command`` detached; stream output to a log file; return at once."""
    job_id = uuid.uuid4().hex[:8]
    if log_file:
        # Logs always stay in the OS temp dir, never in codifa logs or the
        # workspace: keep only the basename of a caller-supplied path.
        log_path = os.path.join(
            _terminal_bg_log_dir(),
            os.path.basename(str(log_file)) or f"terminal-{job_id}.log",
        )
        try:
            os.makedirs(_terminal_bg_log_dir(), exist_ok=True)
        except OSError:
            pass
    else:
        log_path = os.path.join(_terminal_bg_log_dir(), f"terminal-{job_id}.log")
    # Generic registry path: when a dev_server registry is available, let it
    # own the detached process lifecycle for any background command. The
    # dangerous-command blacklist above still applies; only the spawn path
    # differs.
    try:
        import dev_server as _dev_server  # type: ignore
    except ImportError:
        _dev_server = None  # type: ignore
    if _dev_server is not None:
        try:
            handle = _dev_server.start(  # type: ignore
                f"terminal-{job_id}", command, port=0, cwd=root, log_file=log_path
            )
            if isinstance(handle, dict):
                pid = int(handle.get("pid") or 0)
                # dev_server reduces log_file to its basename inside the OS
                # temp dir, so adopt the actual path it created.
                log_path = str(handle.get("log_path") or log_path)
            else:
                pid = int(getattr(handle, "pid", 0) or 0)
                _handle_log = getattr(handle, "log_path", None)
                if _handle_log:
                    log_path = str(_handle_log)
            with _TERMINAL_BG_LOCK:
                _TERMINAL_BG_JOBS[job_id] = {
                    "pid": pid,
                    "command": command,
                    "log_file": log_path,
                    "started_at": time.time(),
                    "status": "running",
                    "returncode": None,
                    "via": "dev_server",
                }
            return {
                "command": command,
                "background": True,
                "job_id": job_id,
                "pid": pid,
                "log_file": log_path,
                "message": (
                    f"started in background via dev_server (job {job_id}, pid {pid}). "
                    f"Logs: {log_path}. Use run_terminal with "
                    f"`terminal_logs {job_id}` to read output and "
                    f"`terminal_stop {job_id}` to stop it."
                ),
            }
        except Exception:  # noqa: BLE001, S110 — fall through to plain Popen
            pass
    term_env = {k: v for k, v in os.environ.items() if k != "CODER_DATA_DIR"}
    with open(log_path, "a", encoding="utf-8", errors="replace") as _head:
        try:
            _head.write(f"$ {command}\n")
            _head.flush()
        except OSError:
            pass
    log_fh = open(log_path, "a", encoding="utf-8", errors="replace")  # noqa: SIM115 — owned by job, closed on stop/reap
    try:
        log_fh.write(f"$ {command}\n")
        log_fh.flush()
    except OSError:
        pass
    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=root,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            start_new_session=True,
            env={**term_env, "PYTHONUNBUFFERED": "1"},
        )
    except OSError as exc:
        try:
            log_fh.close()
        except OSError:
            pass
        return {"command": command, "error": str(exc)}
    with _TERMINAL_BG_LOCK:
        _TERMINAL_BG_JOBS[job_id] = {
            "pid": proc.pid,
            "command": command,
            "log_file": log_path,
            "started_at": time.time(),
            "status": "running",
            "returncode": None,
            "via": "popen",
        }

    def _reap(pid: int, jid: str, fh) -> None:
        try:
            proc.wait()
            code = proc.returncode
        except Exception:  # noqa: BLE001 — reap is best-effort
            code = None
        try:
            fh.close()
        except OSError:
            pass
        with _TERMINAL_BG_LOCK:
            job = _TERMINAL_BG_JOBS.get(jid)
            if job is not None and job.get("status") == "running":
                job["status"] = f"exited ({code})"
                job["returncode"] = code

    threading.Thread(target=_reap, args=(proc.pid, job_id, log_fh), daemon=True).start()
    return {
        "command": command,
        "background": True,
        "job_id": job_id,
        "pid": proc.pid,
        "log_file": log_path,
        "message": (
            f"started in background (job {job_id}, pid {proc.pid}). "
            f"Logs: {log_path}. Use run_terminal with "
            f"`terminal_logs {job_id}` to read output and "
            f"`terminal_stop {job_id}` to stop it."
        ),
    }


def terminal_stop(job_id: str) -> dict:
    """Stop a background terminal job started via ``_terminal_bg_start``."""
    jid = (job_id or "").strip()
    with _TERMINAL_BG_LOCK:
        job = _TERMINAL_BG_JOBS.get(jid)
    if job is None:
        return {"job_id": jid, "error": f"no such background job: {jid!r}"}
    if job.get("status") != "running":
        return {"job_id": jid, "status": job.get("status"), "message": "already finished"}
    pid = int(job.get("pid") or 0)
    try:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        time.sleep(1.0)
        alive = True
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError, OSError):
            alive = False
        if alive:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
    except Exception as exc:  # noqa: BLE001
        return {"job_id": jid, "error": str(exc)}
    with _TERMINAL_BG_LOCK:
        job["status"] = "stopped"
        via = str(job.get("via") or "")
        log_file = job.get("log_file")
    # Registry cleanup: drop the dev_server entry so no stale handle lingers.
    if via == "dev_server":
        try:
            import dev_server as _dev_server_stop  # type: ignore

            _dev_server_stop.stop(f"terminal-{jid}", grace_s=2.0)  # type: ignore
        except Exception:  # noqa: BLE001, S110 — cleanup is best-effort
            pass
    return {"job_id": jid, "status": "stopped", "log_file": log_file}


def terminal_logs(job_id: str, tail_chars: int = MAX_TERMINAL_OUTPUT) -> dict:
    """Read the log file of a background terminal job."""
    jid = (job_id or "").strip()
    with _TERMINAL_BG_LOCK:
        job = _TERMINAL_BG_JOBS.get(jid)
        snapshot = dict(job) if job is not None else None
    if snapshot is None:
        return {"job_id": jid, "error": f"no such background job: {jid!r}"}
    log_path = str(snapshot.get("log_file") or "")
    try:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    except OSError:
        # The dev_server registry historically stripped custom log dirs to
        # the temp-dir basename, so jobs started before the path-unification
        # fix point at a file that was actually created next door. Try the
        # registry entry and the basename fallback before giving up, and adopt
        # whichever path actually exists so later reads succeed.
        _resolved = ""
        _candidates: list[str] = []
        try:
            import dev_server as _dev_server_logs  # type: ignore

            for _entry in _dev_server_logs.status():
                if _entry.get("name") == f"terminal-{jid}":
                    _reg_path = str(_entry.get("log_path") or "")
                    if _reg_path and _reg_path not in _candidates:
                        _candidates.append(_reg_path)
                    break
        except Exception:  # noqa: BLE001, S110 — registry is best-effort
            pass
        _basename_fallback = os.path.join(
            tempfile.gettempdir(), os.path.basename(log_path)
        )
        if _basename_fallback and _basename_fallback not in _candidates:
            _candidates.append(_basename_fallback)
        for _cand in _candidates:
            if not _cand or _cand == log_path:
                continue
            try:
                with open(_cand, encoding="utf-8", errors="replace") as _fh:
                    content = _fh.read()
                _resolved = _cand
                break
            except OSError:
                continue
        if not _resolved:
            return {
                "job_id": jid,
                "error": (
                    f"No such log file: {log_path}. The server may still be "
                    "starting — retry shortly. Read the log path directly "
                    "with the read tool; do not run terminal_logs as a shell binary."
                ),
                "log_file": log_path,
            }
        log_path = _resolved
        with _TERMINAL_BG_LOCK:
            _job = _TERMINAL_BG_JOBS.get(jid)
            if _job is not None:
                _job["log_file"] = log_path
    if len(content) > tail_chars:
        content = content[-tail_chars:]
    # Refresh liveness: the reaper thread marks exit, but a directly-killed
    # pid may still read as running until reaped.
    pid = int(snapshot.get("pid") or 0)
    status = str(snapshot.get("status") or "running")
    if status == "running" and pid:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            status = "exited"
        except (PermissionError, OSError):
            pass
    return {
        "job_id": jid,
        "status": status,
        "log_file": log_path,
        "output": content,
    }


def run_terminal(
    root: str, command: str, timeout: int = TERMINAL_TIMEOUT, permit: dict | None = None,
    background: bool = False, log_file: str | None = None,
) -> dict:
    """Run a shell command in the workspace root and capture its output.

    Background mode (for long-lived servers): pass ``background=True`` (with
    optional ``log_file``) or prefix the command with ``bg:``. The process is
    spawned detached via ``start_new_session`` with output streaming to a log
    file and this call returns immediately with a ``job_id`` plus a
    stop/logs hint. Control commands ``terminal_stop <job_id>`` and
    ``terminal_logs <job_id>`` manage those jobs.
    """
    raw = (command or "")
    stripped = raw.strip()
    # Control-plane commands for background jobs. Intercepted before the
    # dangerous-command blacklist so `terminal_stop`/`terminal_logs` (which
    # are not shell commands) never hit shell validation.
    low = stripped.lower()
    if low.startswith("terminal_stop"):
        parts = stripped.split(None, 1)
        if len(parts) == 2 and parts[1].strip():
            return {"command": stripped, **terminal_stop(parts[1].strip())}
        return {"command": stripped, "error": "usage: terminal_stop <job_id>"}
    if low.startswith("terminal_logs"):
        parts = stripped.split(None, 2)
        if len(parts) >= 2 and parts[1].strip():
            tail = MAX_TERMINAL_OUTPUT
            if len(parts) == 3:
                try:
                    tail = max(500, min(MAX_TERMINAL_OUTPUT * 2, int(parts[2])))
                except (TypeError, ValueError):
                    tail = MAX_TERMINAL_OUTPUT
            return {"command": stripped, **terminal_logs(parts[1].strip(), tail)}
        return {"command": stripped, "error": "usage: terminal_logs <job_id> [tail_chars]"}
    real_command = stripped
    want_bg = bool(background) or bool(log_file)
    if stripped.lower().startswith("bg:"):
        want_bg = True
        real_command = stripped[3:].strip()
    if not real_command:
        return {"command": command, "error": "empty command"}
    reason = _blocked_terminal(real_command)
    if reason:
        return {"command": real_command, "error": reason}
    _permit = permit or {}
    if not _permit.get("outside"):
        reason = _escapes_root(real_command, root, permit)
        if reason is None and not _permit.get("install"):
            reason = _writes_outside_root(real_command)
        if reason:
            return {
                "command": real_command,
                "error": f"{reason}. Ask the user for permission (request_permission) before accessing anything outside the workspace.",
            }
    if want_bg:
        return _terminal_bg_start(real_command, root, log_file)
    try:
        code, output = _exec_terminal(real_command, root, min(timeout, TERMINAL_TIMEOUT_MAX))
    except OSError as exc:
        return {"command": real_command, "error": str(exc)}
    return {"command": real_command, "exit_code": code, "output": output}


class PathEscapeError(ValueError):
    """Raised when a path attempts to escape the sandboxed root."""


def _permit_folders(permit: dict | None) -> list[str]:
    """پوشه‌های مجازِ خارج از ریشه (realpath شده) از permit.

    permit["folders"] لیست پوشه‌هایی است که کاربر برایشان مجوز داده؛
    permit["outside"] = True یعنی مجوز کامل خارج از ریشه (legacy /
    «Always allow» قدیمی) — در آن حالت همه‌جا مجاز است.
    """
    if not isinstance(permit, dict):
        return []
    if permit.get("outside"):
        return []
    folders = permit.get("folders")
    if not isinstance(folders, list):
        return []
    out: list[str] = []
    for f in folders:
        if isinstance(f, str) and f:
            out.append(f)
    return out


def _path_in_folders(target: str, folders: list[str]) -> bool:
    """آیا ``target`` (realpath شده) زیر یکی از ``folders`` است؟"""
    for f in folders:
        if target == f or target.startswith(f + os.sep):
            return True
    return False


def _requested_folder(path: str) -> str:
    """نزدیک‌ترین والدِ موجودِ ``path`` — پوشه‌ای که مجوز برایش ثبت می‌شود.

    مسیر درخواستی ممکن است هنوز وجود نداشته باشد (مثلاً فایلی که قرار است
    ساخته شود)؛ مجوز باید روی پوشه‌ی موجودِ والدش ثبت شود تا realpath معتبر
    باشد و resolve_safe بتواند عضویت را چک کند.
    """
    raw = path.strip()
    if raw.startswith("~"):
        raw = os.path.expanduser(raw)
    if not os.path.isabs(raw):
        return ""
    cur = os.path.realpath(raw)
    while cur and cur != os.sep:
        if os.path.isdir(cur):
            return cur
        cur = os.path.dirname(cur)
    return ""


def resolve_safe(
    root: str,
    rel_path: str,
    allow_coder: bool = False,
    permit: dict | None = None,
) -> str:
    """Resolve ``rel_path`` against ``root`` and reject any escape.

    Accepts both relative paths (``src/main.py``) and absolute paths that lie
    inside the root (``/home/user/proj/src/main.py``). Absolute paths under the
    user-level data folder (``user_coder_dir()`` — Data path in Settings) are
    also allowed when ``allow_coder`` is set — reading them must never require
    a permission prompt (writing still goes through the strict path).

    Paths OUTSIDE the root are allowed only when they lie under one of the
    per-folder grants in ``permit["folders"]`` (the user approved that exact
    folder via request_permission) — or when ``permit["outside"]`` is set
    (full outside-workspace permission). The OS temp dir is always allowed
    without permission (background terminal logs live there by design).
    """
    root_real = os.path.realpath(os.path.abspath(root))
    if not os.path.isdir(root_real):
        raise PathEscapeError(f"root does not exist: {root}")

    raw = rel_path.strip()
    if raw.startswith("~"):
        raw = os.path.expanduser(raw)
    if os.path.isabs(raw):
        target = os.path.realpath(raw)
    else:
        rel = raw.lstrip("/").lstrip("\\")
        target = os.path.realpath(os.path.join(root_real, rel))

    if target != root_real and not target.startswith(root_real + os.sep):
        if allow_coder:
            coder = os.path.realpath(user_coder_dir())
            if target == coder or target.startswith(coder + os.sep):
                return target
        # OS temp dir is always accessible without permission: background
        # terminal logs and other transient files live there by design.
        try:
            tmp_real = os.path.realpath(tempfile.gettempdir())
            if target == tmp_real or target.startswith(tmp_real + os.sep):
                return target
        except Exception:  # noqa: BLE001, S110 — temp check never breaks resolution
            pass
        if permit is not None and _path_in_folders(
            target, _permit_folders(permit)
        ):
            return target
        raise PathEscapeError(f"path escapes project root: {rel_path}")

    return target


def _is_text_path(path: str) -> bool:
    ext = os.path.splitext(path)[1].lower()
    if ext in _BINARY_EXTENSIONS:
        return False
    if ext in _TEXT_EXTENSIONS:
        return True
    return True  # unknown extensions are attempted as text


def _read_text(path: str) -> tuple[str, bool]:
    with open(path, "rb") as fh:
        data = fh.read(MAX_READ_BYTES + 1)
    truncated = len(data) > MAX_READ_BYTES
    data = data[:MAX_READ_BYTES]
    try:
        return data.decode("utf-8"), truncated
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace"), truncated


# Cache of _walk_files listings per root, so consecutive glob / search calls
# inside one turn reuse the same file list instead of re-walking the tree each
# time (a large repo walk can cost hundreds of ms and is pure repeated work
# across sibling tool calls). Keyed on root, bounded TTL.
_walk_cache: dict[str, tuple[float, Sequence[str]]] = {}
_WALK_CACHE_TTL = 10.0  # seconds


def _walk_files(root: str) -> Sequence[str]:
    now = time.time()
    cached = _walk_cache.get(root)
    if cached is not None and now - cached[0] < _WALK_CACHE_TTL:
        return cached[1]
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Keep hidden config dirs like `.config` visible (real workspace
        # content the agent must see) but skip the deny-list (`.git`,
        # `.cache`, `node_modules`, `.github`, `.ruff_cache`, …) — mirrors
        # the renderer's quick-open walk so Ctrl+P and the agent agree on
        # what is visible.
        # `.tmp-*` are the user's own scratch/throwaway files & folders (e.g.
        # `.tmp-codemap.mjs`), never real workspace content — skipped the same
        # way rg's `!.tmp-*` glob skips them (see _RG_EXCLUDE_GLOBS).
        dirnames[:] = [
            d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".tmp-")
        ]
        for name in filenames:
            if name == ".DS_Store" or name.startswith(".tmp-"):
                continue
            found.append(os.path.join(dirpath, name))
            if len(found) >= MAX_FILES:
                break
        if len(found) >= MAX_FILES:
            break
    if len(_walk_cache) > 8:
        _walk_cache.clear()
    _walk_cache[root] = (now, found)
    return found


def _display_path(root: str, file: str) -> str:
    """Return a path string the agent can feed straight back into the tools.

    Files under the workspace root show as their tree-relative path (``src/a``);
    files under the user data folder show their real absolute path. Skills,
    plans and MCP connectors are given to the agent inline instead.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    coder = os.path.realpath(user_coder_dir())
    if file == coder or file.startswith(coder + os.sep):
        return file
    return os.path.relpath(file, root_real).replace(os.sep, "/")


def list_files(root: str, path: str = "", permit: dict | None = None) -> dict:
    """List the directory contents of ``path`` (relative to root)."""
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    if not os.path.isdir(target):
        return {"path": path, "error": "not a directory"}

    entries: list[dict] = []
    try:
        names = sorted(os.listdir(target), key=lambda n: (n.lower(),))
    except PermissionError:
        return {"path": path, "error": "permission denied"}

    for name in names:
        if name == ".DS_Store":
            continue
        full = os.path.join(target, name)
        try:
            if os.path.islink(full):
                kind = "link"
            elif os.path.isdir(full):
                if name in _SKIP_DIRS:
                    continue
                kind = "dir"
            else:
                kind = "file"
        except OSError:
            kind = "file"
        entries.append(
            {"name": name, "kind": kind, "path": f"{path}/{name}".strip("/")}
        )

    return {"path": path, "entries": entries}


def read_file(root: str, path: str, permit: dict | None = None) -> dict:
    """Read the text content of ``path`` (relative to root).

    Paths under the user data folder are readable without permission.
    PDF / Word / Excel documents are auto-extracted as text (via the document
    reader) instead of failing as "binary", so the model never needs to pick
    the right tool first.
    """
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    if not os.path.exists(target):
        return {"path": path, "error": "file not found"}
    if os.path.isdir(target):
        return {"path": path, "error": "path is a directory"}
    ext = os.path.splitext(target)[1].lower()
    if ext in (".pdf", ".docx", ".xlsx", ".xlsm", ".xls", ".doc", ".csv"):
        # Document formats BEFORE the text check: .docx/.xlsx/.xls are zip
        # or binary containers that _is_text_path would happily "read" as
        # mojibake. .csv goes through doc_tools for the shared char cap.
        try:
            content = _doc_tools.read_document(target)
            if len(content) > _doc_tools.MAX_DOC_READ_CHARS + 256:
                content = content[: _doc_tools.MAX_DOC_READ_CHARS] + (
                    f"\n[truncated at {_doc_tools.MAX_DOC_READ_CHARS} chars]"
                )
            return {
                "path": path,
                "content": content,
                "truncated": False,
                "note": "text auto-extracted from the document",
            }
        except _doc_tools.DocError as exc:
            return {"path": path, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 — degrade to an error string
            return {"path": path, "error": f"document extraction failed: {exc}"}
    if not _is_text_path(target):
        return {
            "path": path,
            "error": (
                "binary file (read skipped) — for PDF / Word / Excel / CSV use the "
                "read_document tool instead"
            ),
        }
    try:
        content, truncated = _read_text(target)
    except OSError as exc:
        return {"path": path, "error": str(exc)}
    return {"path": path, "content": content, "truncated": truncated}


MAX_LINE_LENGTH = 2000  # chars; lines longer are truncated like opencode's read tool
MAX_READ_EXCERPT_BYTES = 50_000  # total read-tool output cap, like opencode's read tool (50 KB)

# Block-snapped reads: a window ending mid-block forces a follow-up read, so
# every file window is extended (up to _SNAP_LOOKAHEAD lines past the
# requested limit) to the first block boundary: a closing bracket at column
# 0, or a blank line followed by a column-0 line (top-level def boundary).
# Files at or under _SMALL_FILE_LINES are returned whole from the offset.
_SNAP_LOOKAHEAD = 40
_SMALL_FILE_LINES = 300
# Paging auto-join: when a requested window starts/ends within this many lines
# of an already-fetched window of the same file, bridge the gap (fetch it too).
# Mirrors llm._READ_ADJACENT_GAP — the advisory "read ONE wide window" nudge
# for that case is routinely ignored, so the join is enforced here instead.
_READ_JOIN_GAP = 100
# Repeat-file prefetch: a second window of the SAME file in the SAME turn
# signals paging (one window per step = one round-trip each). The fresh serve
# path extends beyond the request by this many lines so the next page is
# already in context. Bounded by the per-turn per-file cap; small enough to
# cost less than another full round-trip re-sending the whole context.
_READ_PREFETCH_LINES = 400
# File map for blind head reads: a head read (offset 1) of more than
# _HEAD_MAP_MIN_LINES lines with a bulk limit returns structure instead of a
# 12k-token import dump — the first _HEAD_MAP_ROWS lines plus the symbol
# index (name + line range per definition) with a copy-pasteable symbols=
# example. Files without indexable symbols get _HEAD_MAP_ROWS_NO_SYMBOLS
# head lines and a grep pointer instead. Explicit per-file windows
# (ranges=/symbols= jobs) and small head windows are never mapped.
_HEAD_MAP_MIN_LINES = 400
_HEAD_MAP_MIN_LIMIT = 400
_HEAD_MAP_ROWS = 40
_HEAD_MAP_ROWS_NO_SYMBOLS = 60
_HEAD_MAP_MAX_SYMBOLS = 50
_CLOSER_RE = re.compile(r"^[}\])]+[;,)]*$")


def _snap_end(
    rows: list[dict], limit: int, lookahead: int = _SNAP_LOOKAHEAD
) -> list[dict]:
    """Trim over-read ``rows`` to the requested ``limit`` snapped to a boundary.

    ``rows`` holds at most ``limit + lookahead`` ``{"line", "text"}`` dicts.
    Returns ``rows`` unchanged when the file ended within the limit; otherwise
    scans from ``limit - 1`` for the first block boundary and cuts there.
    Falls back to exactly ``limit`` rows when no boundary is in range.
    """
    if len(rows) <= limit:
        return rows
    end = len(rows)
    for i in range(limit - 1, end):
        text = rows[i].get("text", "")
        if _CLOSER_RE.match(text):
            return rows[: i + 1]
        if not text.strip() and i + 1 < end:
            nxt = rows[i + 1].get("text", "")
            if nxt.strip() and not nxt[0].isspace():
                return rows[: i + 1]
    return rows[:limit]


def _read_lines_excerpt(path: str, offset: int, limit: int) -> dict:
    """Read a slice of ``path``'s lines, opencode ``read``-style.

    Returns ``{"path", "lines": [{line, text}], "start", "total", "cut", "more"}``.
    ``offset`` is 1-indexed; ``limit`` caps the number of lines returned (both
    defaulted by the caller). Long lines are truncated to ``MAX_LINE_LENGTH``.
    Reads the file streaming (line by line) so it works on big files.

    ``cut`` is True when the 50 KB byte cap (``MAX_READ_EXCERPT_BYTES``) was hit
    -- the file is bigger than what fits in one read even with a large ``limit``.
    ``more`` is True when the ``limit`` line cap was hit -- there are more lines
    beyond the returned window. The caller uses these to pick the right footer,
    exactly like opencode's ``flags.cut`` / ``flags.more``.
    """
    return _read_lines_excerpts(path, [(offset, limit)])[0]


def _read_lines_excerpts(path: str, windows: list[tuple[int, int]]) -> list[dict]:
    """Scan a file once, preserving the byte/line budget of every window."""
    results = [
        {
            "path": path, "lines": [], "start": max(1, int(offset or 1)),
            "total": 0, "cut": False, "more": False,
        }
        for offset, _ in windows
    ]
    caps = [max(1, int(limit or 0)) for _, limit in windows]
    sizes = [0] * len(windows)
    total = 0
    # Upper bound of lines any window can need. Once past it every window is
    # either full (more) or byte-capped (cut), so collecting can stop and the
    # remaining line count is done with a fast C-level count instead of a
    # per-line Python loop over the whole file.
    try:
        max_need = max(r["start"] + caps[i] for i, r in enumerate(results))
    except ValueError:
        max_need = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, raw in enumerate(fh, 1):
                total = lineno
                if lineno > max_need and all(
                    r["cut"] or r["more"] or len(r["lines"]) >= caps[i]
                    for i, r in enumerate(results)
                ):
                    rest = fh.read()
                    if rest:
                        total += rest.count("\n")
                        if not rest.endswith("\n"):
                            total += 1
                    break
                active = [
                    i for i, result in enumerate(results)
                    if lineno >= result["start"] and not result["cut"] and not result["more"]
                ]
                if not active:
                    continue
                text = raw.rstrip("\n")
                if len(text) > MAX_LINE_LENGTH:
                    keep = MAX_LINE_LENGTH - 1
                    head = keep // 2
                    text = text[:head] + "…" + text[-(keep - head):]
                size = len(text.encode("utf-8", errors="replace")) + 1
                for i in active:
                    result = results[i]
                    if sizes[i] + size > MAX_READ_EXCERPT_BYTES:
                        result["cut"] = True
                        continue
                    result["lines"].append({"line": lineno, "text": text})
                    sizes[i] += size
                    if len(result["lines"]) >= caps[i]:
                        result["more"] = True
    except (OSError, UnicodeError) as exc:
        for result in results:
            result.update(error=str(exc), lines=[], total=0, cut=False, more=False)
        return results
    for result in results:
        result["total"] = total
    return results


def write_file(root: str, path: str, content: str, permit: dict | None = None) -> dict:
    """Write ``content`` to ``path`` (relative to root). Creates parent dirs."""
    target = resolve_safe(root, path, permit=permit)
    if _is_workspace_coder_dir(root, target):
        return {
            "path": path,
            "error": "the workspace .coder/ folder is reserved — the agent's config (plans, skills, MCP) lives in the user data folder (Settings → Data path), not in the project — do not write here",
        }
    if os.path.isdir(target):
        return {"path": path, "error": "path is a directory"}
    # محتوای قبلی را قبل از بازنویسی نگه می‌داریم تا خروجی با edit_file
    # یک قرارداد واحد داشته باشد و فرانت‌اند یک DiffView واحد بسازد.
    old_content = ""
    if os.path.exists(target) and not os.path.isdir(target) and _is_text_path(target):
        try:
            old_content, _ = _read_text(target)
        except OSError:
            old_content = ""
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(content)
    except OSError as exc:
        return {"path": path, "error": str(exc)}
    return {
        "path": path,
        "ok": True,
        "old_content": old_content,
        "new_content": content,
        "occurrences": 1,
    }


def user_coder_dir() -> str:
    """Return the user-level data root (default ``~/.codifa``), creating it.

    App data (settings, chats, skills, MCP connectors, plans) and the vector
    stores live here (global, shared across all workspaces), not inside each
    project's ``.coder/`` folder. The root is configurable from
    Settings → Data path: Electron sets ``CODER_DATA_DIR`` on the sidecar env,
    which the desktop app reads to locate the same folder the app data lives in.
    """
    # Single source of truth for the data root: state_db.data_root() reads the
    # same CODER_DATA_DIR (set by Electron) and owns the whole file layout.
    return _state_db.data_root()


# Name of the app-level log file written into the user data dir (see
# user_coder_dir). All best-effort error/diagnostic logging lands here.
LOG_FILENAME = "codifa.log"

_cache: Cache | None = None


def _get_result_cache() -> Cache:
    """Lazy-once result cache (search / web lookups with TTL)."""
    global _cache
    if _cache is not None:
        return _cache
    _cache = Cache(cache_path_for(_state_db.data_root()))
    return _cache


def _web_cache_ttl() -> int:
    """TTL کش متنی وب‌سرچ (ثانیه) — از ragWebTtlDays می‌خونه.
    پیش‌فرض ۹۰ روز (همون پیش‌فرض RAG)."""
    try:
        s = (_state_db.get_settings() or {})
        days = int(s.get("ragWebTtlDays", 90))
        days = max(1, days)
    except (TypeError, ValueError):
        days = 90
    return days * 86400


def _fetch_cache_ttl() -> int:
    """TTL کش متنی fetch_url (ثانیه) — از ragWebTtlDays می‌خونه.
    پیش‌فرض ۹۰ روز. کش متنی و RAG حالا TTL یکسان دارن (ساده‌سازی تنظیمات)."""
    return _web_cache_ttl()


def _web_search_auto_fetch() -> int:
    """تعداد نتایج بالای web_search که واقعاً fetch می‌شن (نه فقط snippet)، از
    تنظیمات — پیش‌فرض WEB_SEARCH_AUTO_FETCH (3). صفر یعنی غیرفعال‌شدن کامل
    (برگشت به رفتار snippet-only قدیمی). سقف بالا 10 تا هر سرچ یک سرچ فچش بیش از حد
    نشه.
    """
    try:
        s = (_state_db.get_settings() or {})
        n = int(s.get("webSearchAutoFetch", WEB_SEARCH_AUTO_FETCH))
    except (TypeError, ValueError):
        n = WEB_SEARCH_AUTO_FETCH
    return max(0, min(10, n))


def _rag_web_enabled() -> bool:
    """آیا RAG برای وب/fetch فعاله؟ (مدل embedding دانلود شده باشه)."""
    try:
        from embeddings import is_available

        return is_available()
    except Exception:  # noqa: BLE001
        return False


# Shared web RAG store: one sqlite connection reused across searches/fetches
# so every web_search does not open a fresh VectorStore (connection + schema
# work). Guarded by a lock; reopened when the DB path or TTL changes.
_WEB_STORE: VectorStore | None = None
_WEB_STORE_PATH: str | None = None
_WEB_STORE_TTL: int | None = None
_WEB_STORE_LOCK = threading.Lock()


def _get_web_store(root: str = "") -> VectorStore | None:
    """باز کردن lazy vector store سراسری برای RAG وب/fetch.

    این store بین همهٔ ورک‌اسپیس‌ها share می‌شه (فایل ``web-rag.vectors.sqlite``).
    چون RAG وب ذاتاً سراسریه — اگه React docs رو یه بار فچ کردی، همه
    ورک‌اسپیس‌ها باید بتونن recall کنن. ``root`` صرفاً برای logging نگه داشته می‌شه.

    The instance is cached and reused (never closed by callers) so repeated
    searches do not churn sqlite connections.
    """
    global _WEB_STORE, _WEB_STORE_PATH, _WEB_STORE_TTL
    try:
        db_path = web_rag_path_for(_state_db.vector_db_dir())
        # TTL از ragWebTtlDays بیاد نه مقدار hardcode پیش‌فرض
        s = (_state_db.get_settings() or {})
        ttl = max(1, int(s.get("ragWebTtlDays", 90)))
    except Exception:  # noqa: BLE001
        return None
    try:
        with _WEB_STORE_LOCK:
            if (
                _WEB_STORE is not None
                and _WEB_STORE_PATH == db_path
                and _WEB_STORE_TTL == ttl
            ):
                return _WEB_STORE
            # Path/TTL changed (or first open): drop the old connection.
            old, _WEB_STORE = _WEB_STORE, None
            if old is not None:
                try:
                    old.close()
                except Exception:  # noqa: BLE001, S110 — best-effort
                    pass
            config = {"ttl_days": ttl}
            _WEB_STORE = VectorStore(db_path, StoreConfig.from_dict(config))
            _WEB_STORE_PATH = db_path
            _WEB_STORE_TTL = ttl
            return _WEB_STORE
    except Exception:  # noqa: BLE001
        return None


def close_web_store() -> None:
    """Close the shared web store (tests / shutdown)."""
    global _WEB_STORE, _WEB_STORE_PATH, _WEB_STORE_TTL
    with _WEB_STORE_LOCK:
        old, _WEB_STORE = _WEB_STORE, None
        _WEB_STORE_PATH = None
        _WEB_STORE_TTL = None
    if old is not None:
        try:
            old.close()
        except Exception:  # noqa: BLE001, S110 — best-effort
            pass


async def _rag_web_lookup(key: str, store: VectorStore | None = None, root: str = "") -> str | None:
    """اگه قبلاً نتیجه‌ی این وب‌سرچ/fetch توی RAG ذخیره شده بود، برگردون.

    فقط وقتی مدل embedding در دسترس باشه (RAG فعال) کار می‌کنه؛ وگرنه
    ``None`` برمی‌گردونه تا مدل بره سراغ وب/فچ واقعی. هیت‌ها رو به هم
    می‌چسبونه و برمی‌گردونه. اگه چیزی نبود یا خطا داد، ``None``.
    """
    if store is None:
        if not _rag_web_enabled():
            return None
        # مسیر fallback نادر: باز کردن sqlite رو هم offload می‌کنیم تا
        # event loop اصلاً بلاک نشه (معمولاً store از قبل پاس داده می‌شه).
        # Shared store is never closed here (reused across calls).
        store = await asyncio.to_thread(_get_web_store, root)
    if store is None:
        return None
    try:
        hits = await asyncio.to_thread(store.search, key, KIND_WEB, 3, 0.6)
        if not hits:
            return None
        parts = []
        for h in hits:
            text = (h.get("txt") or "").strip()
            if text:
                parts.append(text)
        if not parts:
            return None
        return "\n\n".join(parts)
    except Exception:  # noqa: BLE001 — RAG lookup must never break the tool
        return None


def _is_workspace_coder_dir(root: str, target: str) -> bool:
    """True if ``target`` resolves inside ``<root>/.coder``.

    The workspace ``.coder/`` folder is reserved/forbidden: the agent's user-level
    config lives in the user data folder, and skills/plans/MCP connectors live
    there too — never in the project.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    coder_dir = os.path.join(root_real, ".coder")
    return target == coder_dir or target.startswith(coder_dir + os.sep)


def slugify(name: str) -> str:
    """Turn a name into a safe folder slug (e.g. 'Code Review' -> 'code-review').

    Returns "" when nothing slugifiable remains (e.g. a fully non-ASCII
    name); every caller applies its own fallback (workspace/note/...).
    """
    return re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")


def _skill_name_error(name: str) -> str:
    """Return an error message when ``name`` is not a valid English skill name.

    Skill names must be English (ASCII): the storage folder slug is derived
    from the name, and a non-ASCII (e.g. Persian) name used to collapse into
    the shared fallback folder ``skills/skill/``, silently overwriting earlier
    skills. Returns "" when the name is fine.
    """
    name = (name or "").strip()
    if not name:
        return "skill needs a name"
    if not name.isascii():
        return (
            f"skill name must be English (ASCII) — got {name!r}. "
            "Use an English name and retry"
        )
    if not slugify(name):
        return f"skill name must contain English letters or digits — got {name!r}"
    return ""


_HAS_PERSIAN_RE = re.compile(r"[\u0600-\u06FF]")


def _skill_content_error(description: str, content: str) -> str:
    """HARD English-only for skills: reject Persian script in description/content.

    Skills are always English, even when the chat is Persian — this is the
    runtime enforcement behind the prompt hard rule. The ``fa_keywords:``
    frontmatter metadata line is exempt: it carries Persian match keywords
    (data for the generic skill matcher), not prose.
    """
    for label, text in (("description", description), ("content", content)):
        if not text:
            continue
        if label == "content":
            text = "\n".join(
                line for line in text.splitlines()
                if not line.strip().lower().startswith("fa_keywords:")
            )
        if text and _HAS_PERSIAN_RE.search(text):
            return (
                f"skill {label} must be English — Persian script detected. "
                "Rewrite it entirely in English and retry (hard rule: skills are always English)"
            )
    return ""


MEMORY_SEARCH_MAX_RESULTS = 15
DEFAULT_VECTOR_DB_DIR = "vector-db"


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _memory_key(note: str) -> str:
    """Stable vector-store key for a memory note (from its normalized text)."""
    slug = slugify(note[:60]) or "note"
    return f"memory:{slug}"


def open_vector_store(
    root: str, base_dir: str = "", config: dict | None = None
) -> VectorStore | None:
    """Open (or create) the workspace's RAG vector store for durable memory.

    One sqlite file per workspace under ``base_dir`` (default
    ``~/.codifa/vector-db``). Returns ``None`` when it can't be opened so
    callers degrade gracefully — never raises.
    """
    base_dir = base_dir or _state_db.vector_db_dir()
    try:
        os.makedirs(base_dir, exist_ok=True)
        slug = _state_db.workspace_slug_for_root(root)
        db_path = db_path_for(base_dir, slug)
        return VectorStore(db_path, StoreConfig.from_dict(config))
    except Exception as exc:  # noqa: BLE001
        # Surface the failure instead of returning None silently, so a broken
        # vector store / missing embedding model is visible in the sidecar log.
        try:
            with open(
                os.path.join(user_coder_dir(), LOG_FILENAME),
                "a",
                encoding="utf-8",
            ) as fh:
                fh.write(f"[vector-store] open failed for {root!r}: {exc!r}\n")
        except OSError:
            pass
        print(f"[vector-store] open failed for {root!r}: {exc!r}", flush=True)
        return None



def _parse_skill_markdown(raw: str) -> tuple[str, str, str]:
    """Pull ``name`` and ``description`` from a skill's markdown frontmatter.

    Returns ``(name, description, body)``. The name falls back to the slug
    when the frontmatter omits it.
    """
    raw = (raw or "").strip()
    fm = ""
    body = raw
    m = re.match(r"^---\n([\s\S]*?)\n---\n?", raw)
    if m:
        fm = m.group(1)
        body = raw[m.end() :]
    name = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
    description = re.search(r"^description:\s*(.+)$", fm, re.MULTILINE)
    return (
        (name.group(1).strip() if name else "") or "",
        (description.group(1).strip() if description else "") or "",
        body.strip(),
    )


def _parse_skill_fa_keywords(raw: str) -> list[str]:
    """Extract ``fa_keywords`` from a skill markdown frontmatter block.

    Comma-separated match keywords (data for the skill matcher),
    e.g. ``fa_keywords: film, cinema``. Returns [] when absent.
    """
    m = re.match(r"^---\n([\s\S]*?)\n---\n?", (raw or "").strip())
    if not m:
        return []
    for line in m.group(1).splitlines():
        if line.strip().lower().startswith("fa_keywords:"):
            _, _, val = line.partition(":")
            return [k.strip() for k in val.split(",") if k.strip()]
    return []


def _resolve_skill_match(skills: list[dict], wanted: str) -> dict | None:
    """Staged skill matcher: exact name/slug, slugified, substring, keywords.

    Cheap ordered checks so near-name or keyword requests resolve with one
    load_skill call instead of erroring on an exact-match miss.
    """
    w = (wanted or "").strip().casefold()
    if not w:
        return None
    for s in skills or []:
        _name = (s.get("name") or "").strip().casefold()
        _slug = (s.get("slug") or "").strip().casefold()
        if _name == w or _slug == w:
            return s
    try:
        sw = slugify(w)
    except Exception:  # noqa: BLE001
        sw = ""
    if sw:
        for s in skills or []:
            if (s.get("slug") or "").strip().casefold() == sw:
                return s
            if slugify(s.get("name") or "") == sw:
                return s
    if len(w) >= 3:
        for s in skills or []:
            n = (s.get("name") or "").strip().casefold()
            sl = (s.get("slug") or "").strip().casefold()
            if (n or sl) and (w in n or w in sl or n in w or sl in w):
                return s
        for s in skills or []:
            desc = (s.get("description") or "").strip().casefold()
            if desc and (w in desc or desc in w):
                return s
            for kw in (s.get("fa_keywords") or []):
                k = str(kw or "").strip().casefold()
                if k and (w in k or k in w):
                    return s
    return None


_PLACEHOLDER_SKILL_NAMES = frozenset(
    {"new-skill", "new_skill", "skill", "new skill", "untitled"}
)


def _is_placeholder_skill_name(name: str) -> bool:
    """True when ``name`` is a template placeholder rather than a real name."""
    return (name or "").strip().lower() in _PLACEHOLDER_SKILL_NAMES


def _skill_title_fallback(body: str) -> str:
    """First ``# Heading`` in the body (e.g. ``# Market-Analysis``)."""
    m = re.search(r"^#\s+(.+)$", body or "", re.MULTILINE)
    return (m.group(1).strip() if m else "") or ""


def _resolve_skill_name(parsed_name: str, body: str, fallback_name: str) -> str:
    """Prefer a real name over template placeholders.

    Order: frontmatter ``name`` → first ``# Title`` → explicit fallback.
    When everything is empty/placeholder, keep the original value so the
    untouched template still saves as ``new-skill``.
    """
    title = _skill_title_fallback(body)
    fallback = (fallback_name or "").strip()
    for candidate in (parsed_name, title, fallback):
        candidate = (candidate or "").strip()
        if candidate and not _is_placeholder_skill_name(candidate):
            return candidate
    return (parsed_name or title or fallback).strip()


def persist_skill(
    raw: str,
    fallback_name: str = "",
    previous_name: str = "",
    fa_keywords: list[str] | str | None = None,
    extra_files: dict | None = None,
    deleted_files: list[str] | None = None,
) -> dict:
    """Persist a skill as ``skills/<slug>/skill.md`` in the user data folder.

    ``raw`` is the full skill markdown (frontmatter + body); the name and
    description are parsed from the frontmatter. The name must be English
    (ASCII) — it becomes the storage folder slug. Optional ``extra_files``
    maps filename -> content and is written alongside skill.md; rewriting
    skill.md never deletes existing extra files except those listed in
    ``deleted_files``. Returns
    ``{"ok", "name", "slug", "path", "note", "files"}`` on success.
    """
    name, description, body = _parse_skill_markdown(raw)
    if fa_keywords is None:
        fa_list = _parse_skill_fa_keywords(raw)
    elif isinstance(fa_keywords, str):
        fa_list = [k.strip() for k in fa_keywords.split(",") if k.strip()]
    else:
        fa_list = [str(k or "").strip() for k in fa_keywords if str(k or "").strip()]
    name = _resolve_skill_name(name, body, fallback_name)
    error = _skill_name_error(name)
    if error:
        return {"ok": False, "note": error}
    c_err = _skill_content_error(description, body)
    if c_err:
        return {"ok": False, "note": c_err}
    slug = slugify(name)
    if not body:
        body = f"Write step-by-step instructions for {name}."
    try:
        _state_db.save_skill(name, slug, description, raw or body, fa_list)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "note": f"could not save skill: {exc}"}
    if previous_name and previous_name != name:
        _state_db.delete_skill(previous_name)
    files: list[str] = []
    try:
        for _gone in deleted_files or []:
            try:
                _state_db.delete_skill_extra_file(slug, str(_gone or ""))
            except Exception:  # noqa: BLE001, S112
                continue
        if extra_files:
            _state_db.write_skill_extra_files(slug, extra_files)
        files = _state_db.list_skill_files(name) or _state_db.list_skill_files(slug)
    except Exception:  # noqa: BLE001
        files = []
    return {
        "ok": True,
        "name": name,
        "slug": slug,
        "path": os.path.join(_state_db.skills_dir(), slug, "skill.md"),
        "note": f"skill '{name}' saved",
        "files": files,
    }


def remove_skill(name: str) -> dict:
    """Delete a skill from the app's skill store."""
    try:
        removed = _state_db.delete_skill(name)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "note": f"could not remove skill: {exc}"}
    return {"ok": True, "removed": removed, "note": f"skill '{name}' removed"}



def _builtin_skills_dir() -> str:
    """Directory of the built-in skill markdown files shipped with the app."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")


def sync_builtin_skills() -> list[str]:
    """Seed/re-sync built-in skills from ``backend/skills/*.md`` on every startup.

    Scans the shipped skills folder and seeds any skill that is not already in
    the user's skill store, and re-seeds a built-in whose shipped ``.md`` has
    changed — body OR frontmatter (e.g. an updated description) — so official
    fixes propagate without manual deletion. Adding a new ``.md`` file to the
    folder makes it a built-in skill on the next startup, with no code change
    required. Returns the names that were seeded or re-synced.

    Note: built-ins are superseded by shipped updates even if a user edited the
    stored copy — personal edits should live in user-created skills, not
    built-ins. Deletions are re-seeded on next startup (built-ins always ship).
    Rewriting skill.md never deletes extra files in the skill folder, so
    user-added sidecar files survive re-syncs.
    """
    folder = _builtin_skills_dir()
    if not os.path.isdir(folder):
        return []
    try:
        existing = _state_db.list_skills()
    except Exception:  # noqa: BLE001
        existing = []
    existing_slugs = {s.get("slug") for s in existing}
    existing_names = {s.get("name") for s in existing}
    # Map name/slug -> (description, body, fa_keywords) — the stored content is
    # frontmatter-stripped by list_skills — so a shipped change to the body,
    # description OR keywords triggers a re-sync below.
    existing_meta: dict[str, tuple[str, str, tuple[str, ...]]] = {}
    for s in existing:
        meta = (
            (s.get("description") or "").strip(),
            (s.get("content") or "").strip(),
            tuple(sorted(str(k or "").strip() for k in (s.get("fa_keywords") or []) if str(k or "").strip())),
        )
        if s.get("name"):
            existing_meta[s["name"]] = meta
        if s.get("slug"):
            existing_meta[s["slug"]] = meta
    seeded: list[str] = []
    for path in sorted(_pyglob.glob(os.path.join(folder, "*.md"))):
        try:
            with open(path, encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            continue
        name, description, body = _parse_skill_markdown(raw)
        fa_list = _parse_skill_fa_keywords(raw)
        if not name:
            name = os.path.splitext(os.path.basename(path))[0]
        if name in existing_names or slugify(name) in existing_slugs:
            # Built-in already present: re-sync only when the shipped file
            # changed, so official updates take effect. Identical copies are
            # left untouched.
            stored = existing_meta.get(name) or existing_meta.get(slugify(name))
            if stored == (
                description.strip(),
                body.strip(),
                tuple(sorted(fa_list)),
            ):
                continue
        result = persist_skill(raw, fallback_name=name)
        if result.get("ok"):
            seeded.append(result.get("name") or name)
    _retire_renamed_builtins()
    return seeded


# Built-ins whose shipped display name changed in an update (old -> new).
# ``sync_builtin_skills`` retires a stored copy still carrying the old name
# once the renamed skill is in the store, so the catalog never lists both.
_RENAMED_BUILTINS: dict[str, str] = {
    # Persian-named builtin from before skill names were required to be
    # English/ASCII.
    "یادگیری زبان از روی داکیومنت": "Learn from Docs",
}


def _retire_renamed_builtins() -> None:
    """Delete stored relics of renamed built-ins (see ``_RENAMED_BUILTINS``)."""
    try:
        stored = {s.get("name") for s in _state_db.list_skills()}
    except Exception:  # noqa: BLE001
        return
    for old_name, new_name in _RENAMED_BUILTINS.items():
        if old_name in stored and new_name in stored:
            _state_db.delete_skill(old_name)


# Built-in MCP connectors shipped with the app. They are seeded on first run
# and exempt from startup validation (which would otherwise delete them on
# machines where the underlying tool isn't installed) — a broken builtin only
# surfaces if the model actually calls one of its tools.
_BUILTIN_MCP_SERVERS: dict[str, dict] = {
    "docker": {
        "command": "docker",
        "args": ["mcp", "gateway", "run"],
    },
    "playwright": {
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest"],
    },
}


def seed_builtin_mcp() -> list[str]:
    """Install built-in MCP connectors that are missing (no-op otherwise).

    Seeds every builtin whose name is NOT already stored under ``mcp/`` —
    existing entries (user edits) are never overwritten, and NEW builtins
    (e.g. playwright added after docker) are seeded on the next start even
    when the table already has entries.
    """
    try:
        existing = _state_db.list_mcp()
    except Exception:  # noqa: BLE001
        return []
    existing_names = set(existing or {})
    seeded: list[str] = []
    for name, cfg in _BUILTIN_MCP_SERVERS.items():
        if name in existing_names:
            continue
        try:
            _state_db.save_mcp(name, json.dumps(cfg, ensure_ascii=False))
            seeded.append(name)
        except Exception:  # noqa: BLE001, S112
            continue
    return seeded


# e5 cosine similarity sits in a compressed band overall — even unrelated
# short sentences (esp. Persian) score ~0.88-0.89, so a cosine-alone cutoff
# cannot tell duplicates apart from merely-different notes. A genuine
# duplicate is a near word-for-word restatement: it clears a much higher bar
# (~0.97+) AND usually shares a substring. We require EITHER cosine >= 0.985
# OR a long shared substring, so new-but-different facts are never swallowed.
_MEMORY_DEDUP_THRESHOLD = 0.90
_MEMORY_DEDUP_SUBSTR_MIN = 24  # chars — a shared run this long = same restatement


def _project_slug(root: str) -> str:
    """Workspace slug used to scope memory notes (same as the vector store)."""
    try:
        return slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep)))
    except Exception:  # noqa: BLE001
        return "workspace"


def search_web_docs(
    query: str, store: VectorStore | None, max_results: int = 8, min_score: float = 0.2
) -> list[dict]:
    """Semantic search over saved web documents. Returns top chunks with sources."""
    if store is None or not query:
        return []
    return store.search(query, KIND_WEB, top_k=max_results, min_score=min_score)


def create_skill(
    root: str,
    name: str,
    description: str,
    content: str,
    fa_keywords: list[str] | str | None = None,
    extra_files: dict | None = None,
) -> dict:
    """Create or edit (overwrite) a user skill (global, shared across workspaces).

    ``name`` is the display name — it must be English (ASCII) because the
    storage folder slug is derived from it. ``description`` is indexed for
    the system prompt, and ``content`` is the full markdown body. The skill
    is stored as ``skills/<slug>/skill.md`` in the user data folder with
    optional ``extra_files`` (filename -> content) alongside it. Calling
    with an existing skill's SAME ``name`` overwrites skill.md but keeps
    existing extra files. The ``root`` argument is kept for API compatibility
    and is not used.
    """
    body = content.strip()
    if not body:
        body = f"Write step-by-step instructions for {name}."
    if isinstance(fa_keywords, str):
        fa_list = [k.strip() for k in fa_keywords.split(",") if k.strip()]
    else:
        fa_list = [str(k or "").strip() for k in (fa_keywords or []) if str(k or "").strip()]
    markdown = (
        "---\n"
        f"name: {name}\n"
        f"description: {description or ''}\n"
        + (f"fa_keywords: {', '.join(fa_list)}\n" if fa_list else "")
        + "---\n\n"
        f"# {name}\n\n{body}\n"
    )
    result = persist_skill(markdown, fallback_name=name, fa_keywords=fa_list or None, extra_files=extra_files)
    if not result.get("ok"):
        return {"error": result.get("note", "save failed")}
    return {
        "path": result["path"],
        "name": result["name"],
        "ok": True,
        "note": result["note"],
        "files": result.get("files", []),
    }


def _format_skill_body(row: dict) -> str:
    """Format a skill record as the full body ``read_skill`` returns: name,
    description, and the markdown body with frontmatter stripped."""
    body = str(row.get("content") or "").strip()
    if body.startswith("---"):
        end = body.find("\n---", 3)
        if end != -1:
            body = body[end + 4 :].lstrip("\n").strip()
    desc = str(row.get("description") or "").strip()
    files = [str(f or "").strip() for f in (row.get("files") or []) if str(f or "").strip()]
    if not files:
        try:
            files = _state_db.list_skill_files(str(row.get("name") or "")) or _state_db.list_skill_files(str(row.get("slug") or ""))
        except Exception:  # noqa: BLE001
            files = []
    out = f"# {row.get('name')}\n"
    if desc:
        out += f"\n{desc}\n"
    if files:
        out += f"\nExtra files: {', '.join(files)} — load a specific file with load_skill(file=<name>) only when needed.\n"
    out += f"\n{body}\n"
    return out


def upsert_mcp_server(root: str, name: str, cfg: dict) -> dict:
    """Add or replace one MCP connector (shared globally).

    Stores ``cfg`` as ``mcp/<name>.json`` in the user data folder. ``root``
    is kept for API compatibility and is not used.
    """
    try:
        _state_db.save_mcp(name, json.dumps(cfg or {}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "error": str(exc)}
    return {"name": name, "ok": True}


def _probe_stdio_server(cmd: list[str], timeout: float = 2.5) -> str | None:
    """Try launching a stdio MCP command; return an error message, or None if it
    started (stayed alive) or there's nothing to run.

    Broken configs (bad flags, missing binary, immediate crash) exit quickly
    with a non-zero code, so we capture that to detect them. A server that stays
    alive waiting on stdin is considered fine and is terminated.
    """
    if not cmd:
        return None
    try:
        if shutil.which(cmd[0]) is None:
            return f"command not found: {cmd[0]}"
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _, err = proc.communicate(timeout=timeout)
            if proc.returncode not in (0, None):
                msg = (err or b"").decode("utf-8", errors="replace").strip()
                return (
                    f"exit {proc.returncode}: {msg[:200]}"
                    if msg
                    else f"exit {proc.returncode}"
                )
            return None
        except subprocess.TimeoutExpired:
            # Still running — looks healthy. Kill the probe.
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return None
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def validate_mcp_servers() -> list[str]:
    """Check every stdio connector in the app data folder and remove the ones
    that fail to start (bad command, wrong flags, immediate crash).

    Returns the names of the servers that were removed so the app can warn the
    user. HTTP/SSE (url) connectors are not probed at startup.
    """
    servers = _state_db.list_mcp()
    if not servers:
        return []

    removed: list[str] = []
    for name, cfg in list(servers.items()):
        if not isinstance(cfg, dict):
            continue
        if name in _BUILTIN_MCP_SERVERS:
            # Builtin connectors (e.g. the Docker MCP) survive startup
            # validation even when the tool isn't installed — the failure only
            # surfaces if the model calls one of its tools.
            continue
        if cfg.get("url"):
            continue  # remote — validated lazily on use
        cmd = [str(cfg.get("command", ""))]
        if not cmd or not cmd[0]:
            continue
        for a in cfg.get("args") or []:
            if isinstance(a, str):
                cmd.append(a)
        err = _probe_stdio_server(cmd)
        if err:
            removed.append(name)
            _state_db.delete_mcp(name)
            print(f"[coder] MCP server {name!r} disabled at startup: {err}", flush=True)
    return removed


class EditAmbiguousError(ValueError):
    """Raised when ``old_string`` matches zero or multiple times unexpectedly."""


# --------------------------------------------------------------------------- #
# Tolerant old_string matching
# --------------------------------------------------------------------------- #
# The read tool renders every line as "2096 | text" (grep as "path:123: text")
# and wraps output in <path>/<content> with trailing notes like
# "(End of file - total N lines)". The model often copies those decorations —
# or stray trailing whitespace / CRLF — into old_string, so a byte-exact
# search misses and the edit fails with "old_string not found" even though the
# target is right there. The helpers below retry with the decorations removed
# and map the hit back to the ORIGINAL byte offsets, so the replacement still
# lands byte-precisely.

_TOOL_LINE_PREFIX_RE = re.compile(r"[ \t>]*?(?:[^\s:<>]+:\s*\d+|\d+)[ \t]*[:|][ \t]?")
_TOOL_GREP_ANNOTATION_RE = re.compile(r"^\s*in\s+\S.*\(L\d+(?:-\d+)?\)\s*[:|]?\s*")
_TOOL_WRAP_RE = re.compile(
    r"^<(?:path>.*</path|type>.*</type|content|entries)>$|^</(?:content|entries)>$"
)
_TOOL_NOTE_RE = re.compile(
    r"^\((?:End of file|Output capped|Joined to|file map:|Batch complete|"
    r"symbols not found|offset\s+\d+\s+is\s+past|empty directory|"
    r"Per-file cap|\d+\s+definition\s+bodies?\s+omitted|\d+\s+matches\s+found|"
    r"\d+\s+pattern\(s\)\s+failed|\d+\s+entries?|"
    r"Showing\s+(?:lines|the first|\d+|\d+\s+of)).*\)$"
)
_TOOL_PAREN_POS_RE = re.compile(r"^\([^()]*:\s*lines\s+\d+-\d+\s+of\s+\d+[^()]*\)$")
_TOOL_SQUARE_MARKER_RE = re.compile(
    r"^\[(?:lines?\s+\d+-\d+\s+identical\s+to\s+an\s+earlier\s+read|"
    r"identical\s+to\s+an\s+earlier\s+read|line\s+read\s+above)[^]]*\]$",
    re.IGNORECASE,
)
_TOOL_HISTORY_PREFIX_RE = re.compile(r"^[^\s:<>]+:\s*\d+\s*\|\s?")
_TOOL_DUP_REF_RE = re.compile(
    "عیناً با پاسخ ابزار|متن کامل همان پاسخ"
    "|byte-identical to tool result|use that full text"
)
_TOOL_HEADER_LINE_RE = re.compile(
    r"^(?:MATCHES\s+for\s+|GLOB\s+MATCHES\s+for\s+|No\s+(?:matches|files\s+match)\s+"
    r"|Found\s+\d+\s+matches?\.|Showing\s+the\s+first\s+\d+"
    r"|Use\s+a\s+narrower\s+|Use\s+(?:'offset'|grep|offset)\s"
    r"|Read\s+(?:them\s+directly|all\s+needed|the\s+needed|any\s+definition)"
    r"|The\s+`in\s+Name|\[batch\]\s"
    r"|Successfully\s+edited\s|ERROR\s+(?:reading|searching|running|editing)\s"
    r"|\s*\.\.\.\s*\(\+\d+\s+more\s+lines"
    r"|\s*-\s*\w+\s+\S+\s*\(L\d+(?:-\d+)?\)"
    r"|\s*-?\s*\(\+\d+\s+more\s+definitions\)"
    r"|\s*[│├└─].*)"
)


def _undecorate_tool_text(text: str) -> str:
    """Strip read/grep tool decorations a model copied into an edit string.

    Drops wrapper/note/header/fence lines anywhere in ``text`` and removes the
    leading ``2096 | `` / ``> 2096 | `` / ``path:2096: `` prefix (plus an
    optional grep ``in Name (L..)`` annotation) from every line carrying
    one; undecorated lines pass through untouched. Blank lines that only
    separated kept content from dropped decorations at the very start/end
    are removed too — otherwise a copied window ending in
    ``\n\n(path: lines X-Y of N)`` would match with one extra trailing
    newline and glue the last kept line onto the following one.
    """
    rows: list[str | None] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            rows.append(line)
            continue
        if (
            _TOOL_WRAP_RE.match(stripped)
            or _TOOL_NOTE_RE.match(stripped)
            or _TOOL_PAREN_POS_RE.match(stripped)
            or _TOOL_HEADER_LINE_RE.match(stripped)
            or _TOOL_SQUARE_MARKER_RE.match(stripped)
            or _TOOL_DUP_REF_RE.search(stripped)
            or stripped.startswith("```")
        ):
            rows.append(None)
            continue
        work = line
        # A collapsed single-line grep head ("path:12:[line read above]")
        # carries no code text — drop the marker suffix; a bare head left
        # behind is dropped below like any other pure-decoration line.
        if work.rstrip().endswith("[line read above]"):
            work = work.rstrip()[: -len("[line read above]")].rstrip()
        saw_prefix = False
        while True:
            m = _TOOL_LINE_PREFIX_RE.match(work)
            if m:
                work = work[m.end():]
                saw_prefix = True
                continue
            m = _TOOL_HISTORY_PREFIX_RE.match(work)
            if m:
                work = work[m.end():]
                saw_prefix = True
                continue
            # A grep "in Name (L..)" annotation only ever follows a
            # "path:line:" / "N | " prefix — never strip it from a plain
            # code line that happens to start with "in ...".
            if saw_prefix:
                a = _TOOL_GREP_ANNOTATION_RE.match(work)
                if a:
                    work = work[a.end():]
                    continue
            break
        # A line that was pure decoration once stripped (e.g. a grep entry
        # header "path:12:in foo (L1-3):") is dropped, not kept as blank.
        rows.append(None if (work is not line and not work.strip()) else work)
    if any(r is None for r in rows):
        start, end = 0, len(rows)
        if rows[0] is None:
            while start < end and rows[start] is None:
                start += 1
            while start < end and not (rows[start] or "").strip():
                start += 1
        if rows[end - 1] is None:
            while end > start and rows[end - 1] is None:
                end -= 1
            while end > start and not (rows[end - 1] or "").strip():
                end -= 1
        rows = rows[start:end]
    return "\n".join(r for r in rows if r is not None)


def _normalize_for_match(text: str) -> tuple[str, list[int]]:
    """Comparison view of ``text``: CRLF reduced to LF, per-line trailing
    whitespace dropped. Returns ``(normalized, origin)`` where ``origin[i]``
    is the offset of ``normalized[i]`` in the original string."""
    norm: list[str] = []
    origin: list[int] = []
    pos = 0
    for i, line in enumerate(text.split("\n")):
        if i:
            norm.append("\n")
            origin.append(pos - 1)
        body = line.rstrip()
        norm.append(body)
        origin.extend(range(pos, pos + len(body)))
        pos += len(line) + 1
    return "".join(norm), origin


def _normalize_indent_insensitive(text: str) -> tuple[str, list[int]]:
    """Comparison view ignoring leading indent as well as trailing whitespace.

    Returns ``(normalized, origin)`` like ``_normalize_for_match`` but each
    line is stripped on both sides, so an old_string copied without its
    original leading spaces still locates. Origin maps every kept char back
    to its original offset, so the splice preserves the file's indent prefix
    on the first matched line."""
    norm: list[str] = []
    origin: list[int] = []
    pos = 0
    for i, line in enumerate(text.split("\n")):
        if i:
            norm.append("\n")
            origin.append(pos - 1)
        stripped = line.strip()
        leading = len(line) - len(line.lstrip())
        norm.append(stripped)
        origin.extend(range(pos + leading, pos + leading + len(stripped)))
        pos += len(line) + 1
    return "".join(norm), origin


_CANONICAL_DASH_MAP = {
    "\u2014": "--",
    "\u2015": "--",
    "\u2013": "-",
    "\u2212": "-",
    "\u2010": "-",
    "\u2011": "-",
}
_CANONICAL_QUOTE_MAP = {
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u201f": '"',
    "\u00ab": '"',
    "\u00bb": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\u201a": "'",
    "\u2039": "'",
    "\u203a": "'",
    "\u02bc": "'",
}
_ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\ufeff]")
_CANON_WS_CHARS = (
    " \t\x0b\x0c\r\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u202f\u205f\u3000"
)


def _expand_unicode_char(ch: str) -> str:
    """ASCII-tolerant expansion of a single character for matching only."""
    if ch == "\x08":
        # JSON "\\b" decodes to BACKSPACE (0x08) while the file holds a
        # literal backslash + "b" (e.g. r"\\b" in a regex). Recover it so
        # a model copy carrying the decoded control char still matches.
        return "\\b"
    if ch in _CANONICAL_DASH_MAP:
        return _CANONICAL_DASH_MAP[ch]
    if ch in _CANONICAL_QUOTE_MAP:
        return _CANONICAL_QUOTE_MAP[ch]
    if ch == "\u2026":
        return "..."
    return ch


# HTML character references (entities) that decode to plain ASCII text —
# the model often copies a line from rendered HTML output (browser tool,
# fetch_url, a web page) where '&' appears as '&' (or a numeric
# reference like '&#38;'), then uses it as old_string against a file that
# holds the raw '&'. Matching must tolerate BOTH directions, so both the
# file view and the needle are decoded to the same canonical form.
_HTML_ENTITY_RE = re.compile(
    r"&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});"
)


def _decode_html_entities(text: str) -> tuple[str, list[int], list[int]]:
    """Decode HTML character references, mapping each output char back to
    its ORIGINAL offset (the reference's start) so splicing stays
    byte-precise on the file's real text.

    Returns ``(decoded, origin, origin_end)``: ``origin[i]`` is the start
    offset of the source range that produced output char ``i`` and
    ``origin_end[i]`` is its end (exclusive). Plain chars span one byte;
    a decoded reference spans the WHOLE reference, so a needle ending on
    a decoded char splices the full ``&...;`` run out of the file.

    Unknown/invalid references pass through untouched (html.unescape
    semantics); a bare '&' without a ';' never matches the pattern.
    """
    out: list[str] = []
    origin: list[int] = []
    origin_end: list[int] = []
    pos = 0
    while pos < len(text):
        m = _HTML_ENTITY_RE.match(text, pos)
        if m:
            decoded = html.unescape(m.group(0))
            if decoded and decoded != m.group(0):
                # Every decoded char maps to the WHOLE reference range;
                # the splice replaces the entire reference with new_string.
                for ch in decoded:
                    out.append(ch)
                    origin.append(m.start())
                    origin_end.append(m.end())
                pos = m.end()
                continue
        out.append(text[pos])
        origin.append(pos)
        origin_end.append(pos + 1)
        pos += 1
    return "".join(out), origin, origin_end


def _expand_spans_over_entities(
    content: str, spans: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    """Widen spans that cut through an HTML character reference.

    A byte-exact (or whitespace-tolerant) hit can end — or start — in
    the middle of a ``&...;`` reference when the needle carries the
    decoded char; splicing such a span leaves a dangling ``amp;`` tail
    behind and corrupts the file. Expand any boundary strictly inside
    a decodable reference to the reference's edge. Files without
    ``&``/``;`` skip the scan entirely.
    """
    if not spans or "&" not in content or ";" not in content:
        return spans
    refs = [
        (m.start(), m.end())
        for m in _HTML_ENTITY_RE.finditer(content)
        if html.unescape(m.group(0)) != m.group(0)
    ]
    if not refs:
        return spans
    out: list[tuple[int, int]] = []
    for s, e in spans:
        for rs, re_ in refs:
            if rs < s < re_:
                s = rs
            if rs < e < re_:
                e = re_
        out.append((s, e))
    return out


def _normalize_canonical(text: str) -> tuple[str, list[int], list[int]]:
    """Line-preserving canonical view: unicode + interior-whitespace tolerant.

    Each line is NFKC-normalized, zero-width chars removed, smart quotes and
    dashes expanded to ASCII, interior horizontal-whitespace runs collapsed
    to a single space, and leading/trailing whitespace stripped - like
    ``_normalize_indent_insensitive`` but also tolerant to ``...`` vs
    ``…``, ``--`` vs em-dash, smart quotes, NBSP/tabs. Origin maps every
    kept char back to its original offset so splicing stays byte-precise;
    ``origin_end`` carries the end of each char's source range so a
    needle ending on a decoded HTML entity splices the whole reference.
    """
    norm: list[str] = []
    origin: list[int] = []
    origin_end: list[int] = []
    pos = 0
    for i, raw_line in enumerate(text.split("\n")):
        if i:
            norm.append("\n")
            origin.append(pos - 1)
            origin_end.append(pos)
        line = unicodedata.normalize("NFKC", raw_line)
        line = _ZERO_WIDTH_RE.sub("", line)
        line, line_origin, line_origin_end = _decode_html_entities(line)
        # line_origin is relative to this line; shift to absolute file
        # offsets (exact when NFKC/zero-width removal is identity, which
        # holds for plain ASCII code; exotic unicode may drift by a char).
        base = pos
        expanded: list[str] = []
        expanded_origin: list[int] = []
        expanded_origin_end: list[int] = []
        for idx, ch in enumerate(line):
            for ech in _expand_unicode_char(ch):
                expanded.append(ech)
                expanded_origin.append(base + line_origin[idx])
                expanded_origin_end.append(base + line_origin_end[idx])
        # Collapse horizontal runs to one space, then strip both ends.
        collapsed: list[str] = []
        collapsed_origin: list[int] = []
        collapsed_origin_end: list[int] = []
        k = 0
        while k < len(expanded):
            if expanded[k] in _CANON_WS_CHARS:
                if collapsed and collapsed[-1] != " ":
                    collapsed.append(" ")
                    collapsed_origin.append(expanded_origin[k])
                    collapsed_origin_end.append(expanded_origin_end[k])
                elif not collapsed:
                    pass
                while k < len(expanded) and expanded[k] in _CANON_WS_CHARS:
                    k += 1
                continue
            collapsed.append(expanded[k])
            collapsed_origin.append(expanded_origin[k])
            collapsed_origin_end.append(expanded_origin_end[k])
            k += 1
        while collapsed and collapsed[-1] == " ":
            collapsed.pop()
            collapsed_origin.pop()
            collapsed_origin_end.pop()
        while collapsed and collapsed[0] == " ":
            collapsed.pop(0)
            collapsed_origin.pop(0)
            collapsed_origin_end.pop(0)
        norm.append("".join(collapsed))
        origin.extend(collapsed_origin)
        origin_end.extend(collapsed_origin_end)
        pos += len(raw_line) + 1
    return "".join(norm), origin, origin_end


def _normalize_reflow(text: str) -> tuple[str, list[int], list[int]]:
    """Whole-text reflow view: all whitespace runs collapse to one space.

    Used when the model re-wrapped a block (joined lines or split one line
    into several) - the token sequence is identical but ``\\n`` placement
    differs. Unicode is expanded like ``_normalize_canonical``. Origin maps
    back so the splice still covers the file's original lines;
    ``origin_end`` carries each char's source-range end (HTML entities).
    """
    flat = unicodedata.normalize("NFKC", text)
    flat = _ZERO_WIDTH_RE.sub("", flat)
    flat, flat_origin, flat_origin_end = _decode_html_entities(flat)
    expanded: list[str] = []
    expanded_origin: list[int] = []
    expanded_origin_end: list[int] = []
    for idx, ch in enumerate(flat):
        for ech in _expand_unicode_char(ch):
            expanded.append(ech)
            expanded_origin.append(flat_origin[idx])
            expanded_origin_end.append(flat_origin_end[idx])
    norm: list[str] = []
    origin: list[int] = []
    origin_end: list[int] = []
    k = 0
    ws_all = _CANON_WS_CHARS + "\n"
    while k < len(expanded):
        if expanded[k] in ws_all:
            if norm and norm[-1] != " ":
                norm.append(" ")
                origin.append(expanded_origin[k])
                origin_end.append(expanded_origin_end[k])
            while k < len(expanded) and expanded[k] in ws_all:
                k += 1
            continue
        norm.append(expanded[k])
        origin.append(expanded_origin[k])
        origin_end.append(expanded_origin_end[k])
        k += 1
    while norm and norm[-1] == " ":
        norm.pop()
        origin.pop()
        origin_end.pop()
    while norm and norm[0] == " ":
        norm.pop(0)
        origin.pop(0)
        origin_end.pop(0)
    return "".join(norm), origin, origin_end


def _at_line_start(norm: str, j: int) -> bool:
    """True when only whitespace separates position ``j`` from its line start."""
    k = j
    while k > 0 and norm[k - 1] in " \t":
        k -= 1
    return k == 0 or norm[k - 1] == "\n"


def _spans_in(
    norm: str,
    origin: list[int],
    needle: str,
    *,
    line_anchored: bool,
    origin_end: list[int] | None = None,
) -> list[tuple[int, int]]:
    """Original byte spans of every non-overlapping hit of ``needle`` in the
    normalized view, mapped back through ``origin``.

    ``origin_end`` (optional) carries the END of each normalized char's
    source range; when given, a hit's end maps through it so a needle
    ending on a decoded HTML entity splices the WHOLE reference out of
    the file instead of leaving a dangling ``amp;`` tail behind.
    """
    spans: list[tuple[int, int]] = []
    if not needle:
        return spans
    i = 0
    while True:
        j = norm.find(needle, i)
        if j < 0:
            break
        if not line_anchored or _at_line_start(norm, j):
            end = (
                origin_end[j + len(needle) - 1]
                if origin_end is not None
                else origin[j + len(needle) - 1] + 1
            )
            spans.append((origin[j], end))
        i = j + len(needle)
    return spans


def _match_old_string(content: str, old: str) -> tuple[list[tuple[int, int]], str]:
    """Locate ``old`` inside ``content``, tolerating copied tool decorations.

    Returns ``(spans, mode)``: byte spans in the original ``content`` (empty
    when not found) and the match mode — ``""`` for a plain match,
    ``"decorated"`` when tool decorations were stripped from ``old`` (the
    caller must strip the same decorations from ``new_string``), or
    ``"literal"`` when ``old`` was the DECODED value of a source string
    literal (the caller must re-encode ``new_string`` via
    ``_encode_string_literal`` before splicing).
    Tiers: byte-exact, then HTML-entity tolerant (references decoded on
    both sides), then CRLF/trailing-whitespace tolerant, then with
    read/grep prefixes and wrapper/note lines removed (line-anchored so a
    stripped fragment can never match mid-line), then indent/unicode
    tolerant, then decoded string-literal, then reflow tolerant (reflow
    spans overlapping a string literal without covering it are rejected).
    """
    if not old:
        return [], ""
    # 1) byte-exact — the common path.
    spans: list[tuple[int, int]] = []
    i = 0
    while True:
        j = content.find(old, i)
        if j < 0:
            break
        spans.append((j, j + len(old)))
        i = j + len(old)
    if spans:
        return _expand_spans_over_entities(content, spans), ""
    # 1b) HTML-entity tolerant — the model often copies a line from rendered
    # HTML output where '&' appears as a character reference (or vice
    # versa). Decode references on BOTH sides to the same form and
    # byte-match; spans map back through origin_end so a needle ending on
    # a decoded char splices the WHOLE reference. Runs before the
    # whitespace tiers so an entity prefix can never match mid-reference
    # and leave a dangling tail behind.
    _dc, _dc_origin, _dc_origin_end = _decode_html_entities(content)
    _do, _, _ = _decode_html_entities(old)
    if _dc != content or _do != old:
        spans = _spans_in(
            _dc, _dc_origin, _do,
            line_anchored=False, origin_end=_dc_origin_end,
        )
        if spans:
            return spans, ""
    # 2) same text modulo CRLF / trailing whitespace.
    c_norm, c_origin = _normalize_for_match(content)
    o_norm, _ = _normalize_for_match(old)
    spans = _expand_spans_over_entities(
        content, _spans_in(c_norm, c_origin, o_norm, line_anchored=False)
    )
    if spans:
        return spans, ""
    # 3) decorations stripped — only runs when stripping changed something.
    decorated = _undecorate_tool_text(old)
    if decorated != old:
        o_norm, _ = _normalize_for_match(decorated)
        spans = _expand_spans_over_entities(
            content,
            _spans_in(c_norm, c_origin, o_norm, line_anchored=True),
        )
        if spans:
            return spans, "decorated"
    # 4) leading-indent insensitive — the model often retypes a block at
    # column 0 (or with the wrong indent) after copying it from a read
    # excerpt. Stripping leading whitespace on both sides still locates the
    # block; spans exclude the file's indent and the caller reindents via
    # _splice_reindented. Line-anchored so "foo" never matches inside
    # "xfoo".
    c_stripped, c_stripped_origin = _normalize_indent_insensitive(content)
    o_stripped, _ = _normalize_indent_insensitive(old)
    spans = _expand_spans_over_entities(
        content,
        _spans_in(
            c_stripped, c_stripped_origin, o_stripped, line_anchored=True
        ),
    )
    if spans:
        return spans, ""
    if decorated != old:
        o_stripped, _ = _normalize_indent_insensitive(decorated)
        spans = _expand_spans_over_entities(
            content,
            _spans_in(
                c_stripped, c_stripped_origin, o_stripped,
                line_anchored=True,
            ),
        )
        if spans:
            return spans, "decorated"
    # 5) unicode + interior-whitespace tolerant, line-preserving.
    c_canon, c_canon_origin, c_canon_origin_end = _normalize_canonical(content)
    o_canon, _, _ = _normalize_canonical(old)
    spans = _spans_in(
        c_canon, c_canon_origin, o_canon,
        line_anchored=True, origin_end=c_canon_origin_end,
    )
    if spans:
        return spans, ""
    if decorated != old:
        o_canon, _, _ = _normalize_canonical(decorated)
        spans = _spans_in(
            c_canon, c_canon_origin, o_canon,
            line_anchored=True, origin_end=c_canon_origin_end,
        )
        if spans:
            return spans, "decorated"
    # 6) decoded string-literal — the model copied the VALUE of a source
    # string literal (quotes dropped, "\\n" already a real newline), which
    # never byte-matches the quoted source. Match against the decoded
    # literals in the file instead; the caller re-encodes the replacement.
    # Runs BEFORE reflow: reflow would otherwise match a value prefix
    # INSIDE the quoted literal and corrupt its escapes on splice.
    spans = _match_string_literal(content, old)
    if spans:
        return spans, "literal"
    if decorated != old:
        spans = _match_string_literal(content, decorated)
        if spans:
            return spans, "literal"
    # 7) reflow tolerant — same tokens, different line breaks, including a
    # multi-line block retyped as a single line (no "\n" left in old).
    # Spans overlapping a string literal without covering it are rejected:
    # they are decoded-value prefixes, not code — splicing them would
    # corrupt the literal's escapes.
    c_flow, c_flow_origin, c_flow_origin_end = _normalize_reflow(content)
    o_flow, _, _ = _normalize_reflow(old)
    if len(o_flow) >= 10:
        spans = _spans_outside_literals(
            content, c_flow, c_flow_origin, o_flow, origin_end=c_flow_origin_end,
        )
        if spans:
            return spans, ""
    if decorated != old:
        o_flow, _, _ = _normalize_reflow(decorated)
        if len(o_flow) >= 10:
            spans = _spans_outside_literals(
                content, c_flow, c_flow_origin, o_flow, origin_end=c_flow_origin_end,
            )
            if spans:
                return spans, "decorated"
    return [], ""


_STRING_LITERAL_RE = re.compile(
    r'"(?:[^"\\\n]|\\.)*"'  # double-quoted, single line
    r"|'(?:[^'\\\n]|\\.)*'"  # single-quoted, single line
)


def _decode_string_literal(token: str) -> str | None:
    """Decode a quoted source token to its runtime value (None on failure)."""
    try:
        value = ast.literal_eval(token)
    except (ValueError, SyntaxError):
        return None
    return value if isinstance(value, str) else None


def _match_string_literal(content: str, old: str) -> list[tuple[int, int]]:
    """Match ``old`` against the DECODED value of string literals in ``content``.

    The model often copies the runtime value of a source string literal
    (quotes dropped, ``\\n`` already a real newline) — e.g. a prompt line
    from ``agents.py``. That text never byte-matches the quoted source, so
    every other tier fails. Adjacent literals (implicit concatenation) are
    grouped and compared as one combined value; only a FULL-value match
    (exact or stripped) is accepted, so a substring never wipes the
    surrounding text on splice — the caller replaces the whole run with a
    single re-encoded literal holding the same combined value.
    """
    keys = {old}
    if old.strip() != old:
        keys.add(old.strip())
    keys = {k for k in keys if len(k) >= 10}
    if not keys:
        return []
    tokens: list[tuple[int, int, str]] = []
    for m in _STRING_LITERAL_RE.finditer(content):
        decoded = _decode_string_literal(m.group(0))
        if decoded is not None:
            tokens.append((m.start(), m.end(), decoded))
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(tokens):
        j = i
        combined = tokens[i][2]
        while (
            j + 1 < len(tokens)
            and content[tokens[j][1] : tokens[j + 1][0]].strip() == ""
        ):
            j += 1
            combined += tokens[j][2]
        if any(k == combined or k == combined.strip() for k in keys):
            spans.append((tokens[i][0], tokens[j][1]))
        i = j + 1
    return spans


def _encode_string_literal(value: str, quote: str) -> str:
    """Re-encode a runtime string as source text for the given quote char."""
    out: list[str] = []
    for ch in value:
        if ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\\":
            out.append("\\\\")
        elif ch == quote:
            out.append("\\" + quote)
        else:
            out.append(ch)
    return quote + "".join(out) + quote


def _spans_outside_literals(
    content: str,
    norm: str,
    origin: list[int],
    needle: str,
    *,
    origin_end: list[int] | None = None,
) -> list[tuple[int, int]]:
    """Reflow hits that do not partially overlap a string literal.

    A hit overlapping a quoted literal without covering it fully is a
    decoded-value prefix, not code — splicing it would corrupt the
    literal's escapes. Fully-covered literals (a reflowed block that
    happens to contain a whole string) are kept.
    """
    spans = _spans_in(norm, origin, needle, line_anchored=False, origin_end=origin_end)
    if not spans:
        return []
    literals = [(m.start(), m.end()) for m in _STRING_LITERAL_RE.finditer(content)]
    kept: list[tuple[int, int]] = []
    for s, e in spans:
        if any(s < le and ls < e and not (s <= ls and le <= e) for ls, le in literals):
            continue
        kept.append((s, e))
    return kept


def _edit_copy_hints(old: str) -> list[str]:
    """Short actionable hints for an old_string carrying tool output."""
    hints: list[str] = []
    if "identical to an earlier read" in old:
        hints.append(
            "parts of the copied window were collapsed to "
            "'[lines X-Y identical to an earlier read ...; omitted]' — that "
            "sentence is not in the file; re-read the omitted line range and "
            "copy it verbatim"
        )
    if "[line read above]" in old:
        hints.append(
            "'[line read above]' is a pointer, not file content — re-read the "
            "file and copy the actual code lines"
        )
    if "\u2026" in old or "... (+" in old:
        hints.append(
            "the copied text is truncated ('…' / '... (+N more lines ...)'); "
            "read the full lines with symbols=[...] or ranges=[...] and copy "
            "them completely"
        )
    if _TOOL_DUP_REF_RE.search(old):
        hints.append(
            "a duplicate-reference note is not file content — copy the actual "
            "code from the original tool result"
        )
    return hints


def _edit_not_found_error(path: str, old: str, content: str, *, prefix: str = "") -> dict:
    """Actionable old_string-not-found error with a real file excerpt."""
    file_lines = content.split("\n")
    if file_lines and file_lines[-1] == "":
        file_lines = file_lines[:-1]
    total = len(file_lines)
    first = next(
        (ln.strip() for ln in _undecorate_tool_text(old).split("\n") if ln.strip()),
        "",
    )
    start = 0
    if first:
        matches = difflib.get_close_matches(
            first, [ln.strip() for ln in file_lines], n=1, cutoff=0.4
        )
        if matches:
            idx = next(
                (i for i, ln in enumerate(file_lines) if ln.strip() == matches[0]),
                0,
            )
            start = max(0, idx - 2)
    window = file_lines[start : start + 8]
    excerpt = "\n".join(window)[:800]
    head = (
        f"{prefix}old_string not found — it must match the file's current "
        "content exactly (whitespace included). Copy clean text from read: "
        "no 'NNN | ' prefixes, no 'path:NN:' heads, no <path>/<content> "
        "wrappers, no '(... lines X-Y of N)' or '[...]' markers."
    )
    hints = _edit_copy_hints(old)
    detail = f" {'; '.join(hints)}." if hints else ""
    where = (
        f" File '{path}' has {total} lines; actual content around line "
        f"{start + 1} (copy verbatim, without adding line numbers):\n{excerpt}"
    )
    return {"path": path, "error": head + detail + where}


def _edit_not_unique_error(
    path: str, content: str, spans: list[tuple[int, int]], *, prefix: str = ""
) -> dict:
    """Actionable old_string-not-unique error listing every occurrence."""
    file_lines = content.split("\n")
    if file_lines and file_lines[-1] == "":
        file_lines = file_lines[:-1]
    total = len(file_lines)
    shown = min(len(spans), 5)
    parts: list[str] = []
    for num in range(shown):
        start, end = spans[num]
        start_line = content.count("\n", 0, start) + 1
        end_line = content.count("\n", 0, max(start, end - 1)) + 1
        lo = max(0, start_line - 2)
        hi = min(total, end_line + 1)
        window = "\n".join(f"L{i + 1}: {file_lines[i][:120]}" for i in range(lo, hi))
        parts.append(f"occurrence {num + 1}: lines {start_line}-{end_line}\n{window}")
    body = "\n---\n".join(parts)[:1500]
    extra = f" (showing {shown} of {len(spans)})" if len(spans) > shown else ""
    return {
        "path": path,
        "error": (
            f"{prefix}old_string is not unique ({len(spans)} occurrences){extra} — "
            "include more surrounding context to make it unique, or pass "
            "replace_all=true (call-level or per-edit) to replace every occurrence. "
            f"Occurrences in '{path}' (line numbers are metadata — copy clean text "
            "from read without adding line numbers):\n" + body
        ),
    }


def _splice_spans(content: str, spans: list[tuple[int, int]], replacement: str) -> str:
    """Replace every ``spans`` region of ``content`` with ``replacement``
    (applied right-to-left so earlier offsets stay valid)."""
    for start, end in reversed(spans):
        content = content[:start] + replacement + content[end:]
    return content


def _splice_reindented(
    content: str,
    spans: list[tuple[int, int]],
    old_text: str,
    replacement: str,
) -> str:
    """Splice ``replacement`` into each span, preserving the file's indent.

    Indent-insensitive matches exclude the file's leading indent from the
    span, so splicing verbatim would keep the first line's indent (still
    present before the span) but de-indent every following line. When the
    file's indent prefix is wider than the old text's base indent, expand
    the span to the line start and shift every non-blank replacement line
    by the difference. Exact matches are unaffected (no indent gap).
    """
    old_base = ""
    for line in old_text.split("\n"):
        if line.strip():
            old_base = line[: len(line) - len(line.lstrip())]
            break
    for start, end in reversed(spans):
        line_start = content.rfind("\n", 0, start) + 1
        file_indent = content[line_start:start]
        repl = replacement
        if (
            file_indent
            and not file_indent.strip()
            and file_indent.startswith(old_base)
            and len(file_indent) > len(old_base)
        ):
            delta = file_indent[len(old_base) :]
            repl = "\n".join(
                (delta + ln) if ln.strip() else ln
                for ln in replacement.split("\n")
            )
            start = line_start
        content = content[:start] + repl + content[end:]
    return content


def edit_file(
    root: str,
    path: str,
    old_string: str,
    new_string: str,
    replace_all: bool = False,
    permit: dict | None = None,
) -> dict:
    """Replace an exact substring in ``path`` (relative to root).

    Unlike ``write_file`` (which overwrites the whole file), this performs a
    targeted patch: locate ``old_string``, swap it for ``new_string``, write
    back. This is far cheaper on tokens for large files and removes the
    failure mode where a full-file rewrite silently drops unrelated content.

    ``old_string`` is matched byte-exact first; when the model copied
    decorations from a read/grep result (``2096 | `` line prefixes, wrapper
    or note lines, CRLF, trailing spaces) the match is retried with those
    removed and mapped back to the original offsets — see
    ``_match_old_string``. Returns an error dict when nothing matches, or
    when the match is not unique while ``replace_all`` is False (the caller
    must supply enough surrounding context to make the match unique).
    """
    target = resolve_safe(root, path, permit=permit)
    if _is_workspace_coder_dir(root, target):
        return {
            "path": path,
            "error": "the workspace .coder/ folder is reserved — the agent's config (plans, skills, MCP) lives in the user data folder (Settings → Data path), not in the project — do not write here",
        }
    if not os.path.exists(target):
        return {"path": path, "error": "file not found"}
    if os.path.isdir(target):
        return {"path": path, "error": "path is a directory"}
    if not _is_text_path(target):
        return {"path": path, "error": "binary file (edit skipped)"}
    if old_string == new_string:
        return {"path": path, "error": "old_string and new_string are identical"}

    try:
        content, truncated = _read_text(target)
    except OSError as exc:
        return {"path": path, "error": str(exc)}
    if truncated:
        return {
            "path": path,
            "error": "file too large to edit safely (use read with offset/limit to inspect it in parts instead)",
        }

    spans, mode = _match_old_string(content, old_string)
    if not spans:
        return _edit_not_found_error(path, old_string, content)
    if len(spans) > 1 and not replace_all:
        return _edit_not_unique_error(path, content, spans)

    # Strip read/grep decorations from new_string ONLY when old_string itself
    # matched in decorated form. A plain (byte-exact / whitespace-tolerant)
    # match means the model typed real file text, so a line such as
    # `    1: (429, "x"),` (dict key) must be written verbatim, not mistaken for
    # a `N:` line-number prefix and silently stripped.
    _clean_new = _undecorate_tool_text(new_string) if mode == "decorated" else new_string
    replacement = _clean_new if mode == "decorated" else new_string
    apply = spans if replace_all else spans[:1]
    if mode == "literal":
        # The span covers the whole quoted literal; the replacement must be
        # re-encoded as source text with the same quote character. Use
        # new_string VERBATIM here — undecorating would drop lines that
        # look like tool notes (e.g. "Use grep ...") but are real content.
        quote = content[apply[0][0]]
        replacement = _encode_string_literal(new_string, quote)
        new_content = _splice_spans(content, apply, replacement)
    else:
        old_base_text = _undecorate_tool_text(old_string) if mode else old_string
        new_content = _splice_reindented(content, apply, old_base_text, replacement)
    count = len(apply)

    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(new_content)
    except OSError as exc:
        return {"path": path, "error": str(exc)}

    return {
        "path": path,
        "ok": True,
        "old_content": content,
        "new_content": new_content,
        "occurrences": count,
    }


def edit_file_batch(
    root: str,
    path: str,
    edits: list[dict] | str,
    permit: dict | None = None,
    replace_all: bool = False,
) -> dict:
    """Apply several old_string->new_string replacements to ``path`` atomically.

    All edits run on the in-memory content in list order and the file is
    written ONCE, so N changes to the same file cost one tool call, one
    checkpoint, one diff and one verify instead of N sequential read/write
    cycles. Either every edit applies or nothing is written (atomic).
    Each item is ``{"old_string": ..., "new_string": ..., "replace_all": bool}``;
    an item without its own flag inherits the call-level ``replace_all`` (an
    explicit per-item flag always wins).
    Matching is tolerant per edit like ``edit_file`` (copied read/grep
    decorations are stripped and mapped back); when an edit fails because an
    earlier edit in the same batch rewrote its target, the error says so
    instead of a bare "old_string not found".
    """
    # The model sometimes sends `edits` as a JSON-encoded STRING
    # ('[{...}, {...}]') instead of a real list — calling list() on that
    # would split it into characters and every item would fail with
    # "edit N/M: must be an object" (M = string length). Parse it first;
    # likewise an item that is itself a JSON-encoded object string. (Same
    # stringification the grep args already guard with `_coerce_str_list`.)
    # Unparseable values pass through untouched so the validators below
    # still report exactly which item is bad.
    if isinstance(edits, str):
        try:
            _parsed = json.loads(edits.strip())
        except ValueError:
            _parsed = None
        edits = _parsed if isinstance(_parsed, list) else []
    if isinstance(edits, (list, tuple)):
        _items: list = []
        for _item in edits:
            if isinstance(_item, str):
                try:
                    _obj = json.loads(_item.strip())
                except ValueError:
                    _obj = None
                _items.append(_obj if isinstance(_obj, dict) else _item)
            else:
                _items.append(_item)
        edits = _items
    target = resolve_safe(root, path, permit=permit)
    if _is_workspace_coder_dir(root, target):
        return {
            "path": path,
            "error": "the workspace .coder/ folder is reserved — the agent's config (plans, skills, MCP) lives in the user data folder (Settings → Data path), not in the project — do not write here",
        }
    if not os.path.exists(target):
        return {"path": path, "error": "file not found"}
    if os.path.isdir(target):
        return {"path": path, "error": "path is a directory"}
    if not _is_text_path(target):
        return {"path": path, "error": "binary file (edit skipped)"}
    if not isinstance(edits, list) or not edits:
        return {"path": path, "error": "edits must be a non-empty list"}
    try:
        content, truncated = _read_text(target)
    except OSError as exc:
        return {"path": path, "error": str(exc)}
    if truncated:
        return {
            "path": path,
            "error": "file too large to edit safely (use read with offset/limit to inspect it in parts instead)",
        }
    new_content = content
    total_occ = 0
    for idx, item in enumerate(edits):
        if not isinstance(item, dict):
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: must be an object"}
        old_string = item.get("old_string", "")
        new_string = item.get("new_string", "")
        item_replace_all = bool(item.get("replace_all", replace_all))
        if not isinstance(old_string, str) or not isinstance(new_string, str):
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: old_string/new_string must be strings"}
        if not old_string:
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: old_string is empty"}
        if old_string == new_string:
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: old_string and new_string are identical"}
        spans, mode = _match_old_string(new_content, old_string)
        if not spans:
            if _match_old_string(content, old_string)[0]:
                return {
                    "path": path,
                    "error": f"edit {idx + 1}/{len(edits)}: old_string was already changed by an earlier edit in this "
                    "same batch (the edits overlap). Re-read the file after the earlier edits, or apply "
                    "overlapping edits in separate calls.",
                }
            return _edit_not_found_error(
                path, old_string, new_content,
                prefix=f"edit {idx + 1}/{len(edits)}: ",
            )
        if len(spans) > 1 and not item_replace_all:
            return _edit_not_unique_error(
                path, new_content, spans, prefix=f"edit {idx + 1}/{len(edits)}: "
            )
        # See edit_file: only a decorated old_string match strips new_string.
        _clean_new = _undecorate_tool_text(new_string) if mode == "decorated" else new_string
        replacement = _clean_new if mode == "decorated" else new_string
        apply = spans if item_replace_all else spans[:1]
        if mode == "literal":
            quote = new_content[apply[0][0]]
            replacement = _encode_string_literal(new_string, quote)
            new_content = _splice_spans(new_content, apply, replacement)
        else:
            old_base_text = _undecorate_tool_text(old_string) if mode else old_string
            new_content = _splice_reindented(new_content, apply, old_base_text, replacement)
        total_occ += len(apply)
    if new_content == content:
        return {
            "path": path,
            "error": "edits leave the file unchanged — every old_string already equals its "
            "new_string in the current file (check for HTML-entity decoding, e.g. '&' "
            "vs '&', or re-read the file and copy the exact current text)",
        }
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(new_content)
    except OSError as exc:
        return {"path": path, "error": str(exc)}
    return {
        "path": path,
        "ok": True,
        "old_content": content,
        "new_content": new_content,
        "occurrences": total_occ,
        "edits_applied": len(edits),
    }


# --------------------------------------------------------------------------- #
# Automatic post-edit verification (Build mode)
# --------------------------------------------------------------------------- #
# Cheap, best-effort syntax/type checks run right after write_file/edit_file
# succeeds, with the result appended INLINE to that same tool's return string.
# This is deliberately narrow in scope (not a full lint/test run — the system
# prompt's QUALITY GATE already asks the model to run those explicitly after a
# logically-complete change): the goal here is to catch a broken edit the
# INSTANT it happens, for free, without costing the model a separate
# run_terminal tool call (and the full-turn resend that call would trigger).

_TS_VERIFY_DEBOUNCE_SECONDS = 15
# Keyed by realpath(root) so concurrent sessions on different workspaces never
# share a debounce window, but rapid edits within ONE workspace only pay for
# one project-wide tsc pass per window instead of one per edit_file call.
_last_ts_verify: dict[str, float] = {}


def _verify_python_syntax(target: str) -> str | None:
    """Instant, subprocess-free syntax check for a .py file via ast.parse.

    Returns "OK", a short ``SyntaxError: ...`` message, or ``None`` if the file
    can't be read (never raises).
    """
    try:
        with open(target, "r", encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return None
    try:
        ast.parse(src, filename=target)
    except SyntaxError as exc:
        return f"SyntaxError: {exc.msg} (line {exc.lineno}, col {exc.offset})"
    except (ValueError, TypeError) as exc:
        return f"could not parse: {exc}"
    return "OK"


def _verify_json_syntax(target: str) -> str | None:
    """Instant, subprocess-free syntax check for a .json file via json.loads.

    Returns "OK", a short ``JSONDecodeError: ...`` message, or ``None`` if the
    file can't be read (never raises).
    """
    try:
        with open(target, "r", encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return None
    try:
        json.loads(src)
    except json.JSONDecodeError as exc:
        return f"JSONDecodeError: {exc.msg} (line {exc.lineno}, col {exc.colno})"
    return "OK"


def _find_tsc(root: str) -> str | None:
    """Prefer the project's own local tsc (its exact configured version) over
    any globally-installed one; return None if neither exists."""
    local = os.path.join(root, "node_modules", ".bin", "tsc")
    if os.path.isfile(local) and os.access(local, os.X_OK):
        return local
    return shutil.which("tsc")


def _verify_typescript(root: str) -> str | None:
    """Project-wide ``tsc --noEmit``, debounced per workspace.

    Only runs when the project has a ``tsconfig.json`` (otherwise a bare tsc
    invocation reports meaningless global-scope errors) and a resolvable tsc
    binary. Debounced to ``_TS_VERIFY_DEBOUNCE_SECONDS`` so a burst of several
    edit_file calls in the same turn triggers at most one full typecheck
    instead of one per call — later edits in the same burst silently skip
    (return ``None``) rather than re-paying the whole-project cost.
    Returns "OK", a compact error summary, or ``None`` when skipped/unavailable
    (never raises).
    """
    if not os.path.isfile(os.path.join(root, "tsconfig.json")):
        return None
    root_real = os.path.realpath(root)
    now = time.monotonic()
    last = _last_ts_verify.get(root_real, 0.0)
    if now - last < _TS_VERIFY_DEBOUNCE_SECONDS:
        return None
    tsc = _find_tsc(root)
    if not tsc:
        return None
    _last_ts_verify[root_real] = now
    try:
        proc = subprocess.run(  # noqa: PLW1510 — returncode checked below
            [tsc, "--noEmit", "--pretty", "false"],
            cwd=root,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode == 0:
        return "OK"
    out = (proc.stdout or proc.stderr or "").strip()
    error_lines = [ln for ln in out.splitlines() if ": error TS" in ln]
    if not error_lines:
        return (
            None  # tsc failed for some other reason (config issue etc.) — stay silent
        )
    count = len(error_lines)
    preview = "\n".join(error_lines[:8])
    more = f"\n…({count - 8} more)" if count > 8 else ""
    return f"{count} TypeScript error(s):\n{preview}{more}"


def _verify_lsp_diagnostics(root: str, target: str) -> str | None:
    """Blocking LSP diagnostics for one file, or None when clean/unavailable.

    Only ``error``/``warning`` severities are reported: ``info``/``hint``
    (e.g. unused-variable hints) never turned a successful edit into
    ``AUTO-VERIFY FAILED`` — that mislabel sent the model into a
    fix-and-re-verify loop over pre-existing notes instead of moving on.
    Real type errors still surface via tsc/syntax checks.
    """
    try:
        from lsp_manager import get_manager as _get_lsp_mgr_verify

        mgr = _get_lsp_mgr_verify(root)
        if not mgr.is_server_running(target):
            return None
        diags = mgr.diagnostics(target)
    except Exception:  # noqa: BLE001 - diagnostics never break verify
        return None
    if not diags:
        return None
    blocking = [d for d in diags if str(d.get("severity") or "").lower() in ("error", "warning")]
    if not blocking:
        return None
    suppressed = len(diags) - len(blocking)
    lines = []
    for d in blocking[:8]:
        line = f"{d.get('path')}:{d.get('line')} [{d.get('severity')}] {d.get('message')}"
        if d.get("source"):
            line += f" ({d.get('source')})"
        lines.append(line)
    more = f"\n\u2026({len(blocking) - 8} more)" if len(blocking) > 8 else ""
    suffix = f" (+{suppressed} hint/info suppressed, non-blocking)" if suppressed else ""
    return f"{len(blocking)} LSP diagnostic(s){suffix}:\n" + "\n".join(lines) + more


def verify_edit(root: str, path: str, permit: dict | None = None) -> str | None:
    """Best-effort post-write verification for Build mode's write_file/edit_file.

    Dispatches by extension: .py gets an instant AST syntax check; .json gets an
    instant json.loads check; .ts/.tsx get a debounced project-wide typecheck.
    LSP diagnostics are then appended deterministically (no extra tool call)
    so the model never needs a separate lsp_diagnostics call after an edit.
    Every other extension (and any error resolving the path) returns ``None`` so
    the caller adds nothing to the tool result — this must never turn a
    successful write into a reported failure.
    """
    ext = os.path.splitext(path)[1].lower()
    try:
        target = resolve_safe(root, path, permit=permit)
    except PathEscapeError:
        return None
    base: str | None = None
    if ext == ".py":
        base = _verify_python_syntax(target)
        if base is not None and base != "OK":
            return base
    elif ext == ".json":
        base = _verify_json_syntax(target)
        if base is not None and base != "OK":
            return base
    elif ext in (".ts", ".tsx"):
        base = _verify_typescript(root)
    lsp_note = _verify_lsp_diagnostics(root, target)
    if lsp_note:
        if base and base != "OK":
            return base + "\n" + lsp_note
        return lsp_note
    return base


def _format_verify_suffix(note: str | None) -> str:
    """Turn a ``verify_edit`` result into the suffix appended to a tool reply."""
    if not note:
        return ""
    if note == "OK":
        return "\n\n✓ auto-verify: no syntax/type errors."
    return f"\n\n⚠️ AUTO-VERIFY FAILED:\n{note}\nFix this before moving on to the next step."


# Backstop for the 'forgets to check off a finished checklist step' failure mode.
# Prompt instructions alone ('call update_plan again marking it completed') are
# not reliably followed, so make_tool_callbacks tracks how many mutating tool
# calls have happened since the plan was last updated while the checklist still
# has open steps, and a due nudge is piggybacked onto that tool's OWN reply
# (same trick as AUTO-VERIFY) so no extra message-injection machinery is needed.
def _format_plan_nudge_suffix(due: bool) -> str:
    if not due:
        return ""
    return (
        "\n\n💡 Reminder: your checklist still has open steps after "
        "tool calls — batch update_plan with your NEXT tool calls in the SAME step "
        "(never solo just for a tick), marking finished steps 'completed' "
        "(and the next one 'in_progress'). Done work already stays in context "
        "via the tool results above."
    )


def _search_python(
    root: str, query: str, path: str, ctx: int, include: str = "", permit: dict | None = None
) -> dict:
    """Python fallback for ``search_in_files`` when ripgrep is unavailable.

    Walks the tree and matches line-by-line with the same semantics as rg:
    case-insensitive regex, ``ctx`` lines of surrounding context. Slower and
    does not honour ``.gitignore``, but returns the same result shape.
    """
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    if not os.path.isdir(target) and not os.path.isfile(target):
        return {
            "query": query,
            "matches": [],
            "truncated": False,
            "error": f"path not found: {path}",
        }

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", FutureWarning)
            pattern = re.compile(query, re.IGNORECASE)
    except (re.error, FutureWarning):
        pattern = re.compile(re.escape(query), re.IGNORECASE)

    include_re = _include_glob_to_re(include)

    matches: list[dict] = []
    # Same fix as `_rg_search`: a `path` that names a single file searches only
    # that file, instead of silently widening to its parent directory.
    files = [target] if os.path.isfile(target) else _walk_files(target)
    for file in files:
        if not _is_text_path(file):
            continue
        rel = _display_path(root, file)
        if include_re is not None and not include_re.search(rel):
            continue
        try:
            with open(file, "r", encoding="utf-8", errors="ignore") as fh:
                lines = [ln.rstrip("\n") for ln in fh]
        except (OSError, UnicodeError):
            continue
        total = len(lines)
        for index, line in enumerate(lines):
            if pattern.search(line):
                entry: dict = {
                    "file": rel,
                    "line": index + 1,
                    "text": line[:500],
                }
                if ctx > 0:
                    lo = max(0, index - ctx)
                    hi = min(total, index + ctx + 1)
                    entry["context_lines"] = [
                        {"line": i + 1, "text": lines[i][:500]} for i in range(lo, hi)
                    ]
                matches.append(entry)
                if len(matches) >= MAX_SEARCH_RESULTS:
                    return {"query": query, "matches": matches, "truncated": True}
    return {"query": query, "matches": matches, "truncated": False}


def _include_glob_to_re(include: str) -> re.Pattern | None:
    """Convert an opencode-style ``include`` glob (``*.js``, ``*.{ts,tsx}``) to a
    regex matching relative paths, or ``None`` when there's no filter. Used by the
    pure-Python search fallback (ripgrep applies ``-g`` natively)."""
    inc = (include or "").strip()
    if not inc:
        return None
    parts = [
        i.strip() for i in inc.replace("{", "").replace("}", "").split(",") if i.strip()
    ]
    chunks: list[str] = []
    for part in parts:
        esc = ""
        i = 0
        while i < len(part):
            ch = part[i]
            if ch == "*":
                esc += "[^/]*"
            elif ch == "?":
                esc += "[^/]"
            else:
                esc += re.escape(ch)
            i += 1
        chunks.append(esc)
    return re.compile(r"(?:^|/)(" + "|".join(chunks) + r")$")


def _rg_search(
    root: str, query: str, path: str, ctx: int, include: str = "", permit: dict | None = None
) -> dict | None:
    """Claude-Code-style ripgrep search; returns None when rg is unusable."""
    rg = shutil.which("rg")
    if not rg:
        return None
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    root_real = os.path.realpath(os.path.abspath(root))
    coder = os.path.realpath(user_coder_dir())
    in_coder = target == coder or target.startswith(coder + os.sep)
    # IMPORTANT: when `path` names a single FILE, search that file only. This
    # used to silently widen to the file's parent directory whenever the path
    # wasn't itself a directory, so "search X inside path/to/File.tsx" quietly
    # searched the whole containing folder instead — the agent kept getting
    # matches from unrelated sibling files, couldn't tell why, and burned many
    # extra tool calls re-querying to figure out which file something was
    # actually in. A path that resolves to neither a file nor a directory (a
    # typo) is now reported as a clean error instead of guessing.
    if not os.path.isdir(target) and not os.path.isfile(target):
        return {
            "query": query,
            "matches": [],
            "truncated": False,
            "error": f"path not found: {path}",
        }

    cwd = coder if in_coder else root_real
    search_arg = os.path.relpath(target, cwd).replace(os.sep, "/")
    if search_arg in (".", ""):
        search_arg = "."

    # rg itself skips binary files, respects .gitignore and skips hidden files
    # unless --hidden is passed; exit codes: 0 = matches, 1 = none, 2 = error.
    # --hidden makes hidden config files (`.config`, `.env`, …) searchable;
    # the deny-list globs keep `.git`/`node_modules`/`.github`/`.ruff_cache`/…
    # out even when hidden.
    cmd = [
        rg,
        "--json",
        "--line-number",
        "--smart-case",
        "--color",
        "never",
        "--hidden",
    ]
    cmd += _RG_EXCLUDE_GLOBS
    if ctx > 0:
        cmd += ["--context", str(ctx)]
    include = (include or "").strip()
    if include:
        cmd += ["-g", include.replace("{", "{").replace("}", "}")]
    cmd += ["-e", query, search_arg]

    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=SEARCH_TIMEOUT,
            check=False,  # rg's non-zero exit (1 = no matches) is handled below
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode == 2:
        return None  # invalid regex or scan error -> let the Python fallback try

    matches: list[dict] = []
    # Context lines arrive interleaved with matches in the JSON stream. rg
    # emits the match line itself as a separate ``"match"`` event — NOT as
    # ``"context"`` — so the previous parser dropped the actual matching line
    # from ``context_lines``, leaving ``grep_tool`` unable to render the ``>``
    # marker and forcing the model to ``read`` the file just to see what
    # matched. We buffer context lines in ``pending`` so a match can pull its
    # before-context out of the buffer; context lines that arrive AFTER a
    # match are appended to that match as after-context.
    pending: list[dict] = []
    for line in proc.stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        data = obj.get("data") or {}
        if obj.get("type") == "match":
            path_text = (data.get("path") or {}).get("text") or ""
            file = path_text.removeprefix("./")
            if in_coder:
                file = os.path.join(coder, file)
            match_line = data.get("line_number")
            match_text = ((data.get("lines") or {}).get("text") or "").rstrip("\n")[
                :500
            ]
            entry: dict = {"file": file, "line": match_line, "text": match_text}
            if ctx > 0:
                ctx_lines: list[dict] = []
                lo = (match_line or 0) - ctx
                # Pull before-context from pending: only lines in
                # [match_line - ctx, match_line). Any line whose number
                # equals the match line itself is dropped (we add the real
                # match line below with the canonical text).
                ctx_lines.extend(
                    c
                    for c in pending
                    if c.get("line") is not None
                    and lo <= c["line"] < (match_line or 0)
                )
                # The match line itself, so the `>` marker in grep_tool
                # (which checks cl['line'] == m['line']) actually fires.
                ctx_lines.append({"line": match_line, "text": match_text})
                entry["context_lines"] = ctx_lines
                # Anything older than match_line - ctx can never become
                # before-context for a future match, so it's safe to drop.
                pending = []
            matches.append(entry)
            if len(matches) >= MAX_SEARCH_RESULTS:
                return {"query": query, "matches": matches, "truncated": True}
        elif obj.get("type") == "context":
            if ctx <= 0:
                continue
            ctx_line = {
                "line": data.get("line_number"),
                "text": ((data.get("lines") or {}).get("text") or "").rstrip("\n")[
                    :500
                ],
            }
            cl_line = ctx_line["line"]
            if matches and cl_line is not None and matches[-1]["line"] is not None:
                m_line = matches[-1]["line"]
                # After-context for the last match: in range
                # (m_line, m_line + ctx]. Anything beyond that is a gap
                # whose context belongs to a future match → pending.
                if m_line < cl_line <= m_line + ctx:
                    matches[-1].setdefault("context_lines", []).append(ctx_line)
                else:
                    # Either before-context (cl_line <= m_line) or beyond
                    # the last match's after-context window — both belong
                    # in the pending buffer for a future match.
                    pending.append(ctx_line)
            else:
                # Before the first match — keep in pending so the first
                # match can use it as before-context (previously these
                # were dropped entirely because ``and matches`` failed).
                pending.append(ctx_line)
    return {"query": query, "matches": matches, "truncated": False}


def search_in_files(
    root: str,
    query: str,
    path: str = "",
    context: int = 0,
    include: str = "",
    permit: dict | None = None,
) -> dict:
    """Search for ``query`` (case-insensitive regex) under ``path``.

    Uses ripgrep when available (respecting ``.gitignore``, skipping hidden and
    binary files, ``--smart-case`` casing) with a pure-Python walker as a
    fallback. When ``context > 0``, each match also includes the ``context``
    lines before and after the matching line (returned in the ``context_lines``
    field), so the agent can see surrounding code without reading the whole
    file. ``include`` optionally restricts to files matching a glob (e.g.
    ``*.ts`` / ``*.{ts,tsx}``).
    """
    ctx = max(0, int(context or 0))
    result = _rg_search(root, query, path, ctx, include, permit)
    if result is not None:
        return result
    return _search_python(root, query, path, ctx, include, permit)


def _search_literal_batch(
    root: str, queries: list[str], path: str, context: int, include: str,
    permit: dict | None,
) -> list[dict]:
    """Union simple lowercase literals, then project raw hits to each query.

    Complex regexes retain their original engine semantics via the caller's
    single-scan path. A truncated union cannot prove any query's full result,
    so fall back rather than silently starving a less frequent query.
    """
    unique = list(dict.fromkeys(queries))
    combined = "|".join(unique)
    result = search_in_files(root, combined, path, context, include, permit)
    matches = result.get("matches", [])
    if len(unique) == 1:
        return [result for _ in queries]
    if result.get("error"):
        return [dict(result, query=query) for query in queries]
    overlapping = any(
        left["file"] == right["file"] and abs(left["line"] - right["line"]) <= context * 2
        for i, left in enumerate(matches)
        for right in matches[i + 1:]
    )
    if (
        result.get("truncated") or overlapping
        or any(len(m.get("text", "")) >= 500 for m in matches)
    ):
        individual = {
            query: search_in_files(root, query, path, context, include, permit)
            for query in unique
        }
        return [individual[query] for query in queries]
    return [
        dict(
            result, query=query,
            matches=[m for m in matches if re.search(query, m.get("text", ""), re.IGNORECASE)],
        )
        for query in queries
    ]


async def _coalesced_search(
    root: str, query: str, path: str, context: int, include: str,
    permit: dict | None, generation: int,
) -> dict:
    async def single() -> dict:
        return await _shared_search(
            root, ("grep", query, path, include, str(context)), generation,
            search_in_files, root, query, path, context, include, permit,
        )

    # Only literals whose case behavior agrees in both search engines are safe.
    if not re.fullmatch(r"[a-z0-9_ ]{1,80}", query):
        return await single()

    async def batch(queries: list[str]) -> list[dict]:
        return await asyncio.to_thread(
            _search_literal_batch, root, queries, path, context, include, permit,
        )

    return await coalesce_io(
        ("grep", root, path, context, include, id(permit), generation, id(search_in_files)),
        query, single, batch,
    )


def _expand_brace_pattern(pattern: str) -> list[str]:
    """Expand a single `{a,b,c}` brace group into separate glob patterns.

    stdlib ``glob`` does not handle braces, so ``**/*.{tsx,ts,css}`` is split
    into ``**/*.tsx``, ``**/*.ts``, ``**/*.css`` before matching. Only the
    first brace group is split per recursion level; remaining/nested groups
    expand recursively. Returns ``[pattern]`` unchanged when no brace
    alternation is present.
    """
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    prefix = pattern[: m.start()]
    suffix = pattern[m.end() :]
    alts = [a.strip() for a in m.group(1).split(",")]
    if len(alts) <= 1:
        return [pattern]
    out: list[str] = []
    for alt in alts:
        for rest in _expand_brace_pattern(prefix + alt + suffix):
            if rest not in out:
                out.append(rest)
    return out or [pattern]


def _has_brace_alternation(pattern: str) -> bool:
    return bool(re.search(r"\{[^{}]*,[^{}]*\}", pattern))


def _glob_python(root: str, pattern: str, target: str, path: str) -> dict:
    """Python fallback for :func:`glob_files` when ripgrep is unavailable.

    Uses the stdlib ``glob`` with ``recursive=True`` so ``**`` works, then clips
    results to our usual limits (skips hidden dirs, honours ``_SKIP_DIRS``).
    """
    expanded = _expand_brace_pattern(pattern)
    all_matches: list[str] = []
    for sub in expanded:
        try:
            all_matches.extend(_pyglob.glob(os.path.join(target, sub), recursive=True))
        except (ValueError, re.error, OSError):
            return {"pattern": pattern, "matches": [], "error": f"invalid glob: {pattern}"}
    matches = all_matches

    # glob may return directories too; keep files.
    files: list[str] = []
    for match in matches:
        if not os.path.isfile(match):
            continue
        rel = _display_path(root, match)
        files.append(rel)
        if len(files) >= MAX_SEARCH_RESULTS:
            break
    files = _clip_glob_results(files)
    return {
        "pattern": pattern,
        "matches": files,
        "truncated": len(matches) > len(files),
    }


def _clip_glob_results(paths: list[str]) -> list[str]:
    """Sort + de-dupe glob matches (rg orders by mtime; Python sort is fine)."""
    unique: dict[str, None] = dict.fromkeys(paths)
    return list(unique)


def _rg_glob(root: str, pattern: str, target: str, path: str) -> dict | None:
    """Ripgrep-backed glob file listing; returns None when rg is unusable."""
    rg = shutil.which("rg")
    if not rg:
        return None
    root_real = os.path.realpath(os.path.abspath(root))
    coder = os.path.realpath(user_coder_dir())
    cwd = coder if target.startswith(coder + os.sep) else root_real
    search_arg = os.path.relpath(target, cwd).replace(os.sep, "/")
    if search_arg in (".", ""):
        search_arg = "."

    # `rg --files -g <pattern>` lists files whose path matches the glob, still
    # respecting .gitignore and skipping hidden/binary files. --hidden + the
    # deny-list globs make config files findable without exposing `.git` etc.
    cmd = [rg, "--files", "--hidden", "-g", pattern, *_RG_EXCLUDE_GLOBS, search_arg]
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=SEARCH_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None  # invalid glob or scan error -> let the Python fallback try

    files: list[str] = []
    for raw in proc.stdout.splitlines():
        rel = raw.removeprefix("./")
        if target.startswith(coder + os.sep):
            rel = os.path.join(coder, rel)
            files.append(_display_path(root, rel))
        else:
            files.append(rel)
        if len(files) >= MAX_SEARCH_RESULTS:
            break
    return {
        "pattern": pattern,
        "matches": _clip_glob_results(files),
        "truncated": len(files) >= MAX_SEARCH_RESULTS,
    }


def glob_files(root: str, pattern: str, path: str = "", permit: dict | None = None) -> dict:
    """Find files by glob pattern under ``path`` (relative to root).

    Matches opencode's ``glob`` tool: ``pattern`` is a glob like ``**/*.js`` or
    ``src/**/*.ts``. Brace alternations like ``**/*.{tsx,ts,css}`` are expanded
    into separate patterns before matching. Uses ripgrep when available
    (respecting ``.gitignore``, skipping hidden/binary files) with a stdlib
    ``glob`` fallback. Returns a list of relative paths (``matches``), sorted.
    """
    pattern = (pattern or "").strip()
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    if not os.path.isdir(target):
        return {"pattern": pattern, "matches": [], "error": "not a directory"}
    if not pattern:
        return {"pattern": pattern, "matches": []}
    expanded = _expand_brace_pattern(pattern)
    if len(expanded) > 1:
        seen: set[str] = set()
        merged: list[str] = []
        truncated = False
        for sub in expanded:
            result = _rg_glob(root, sub, target, path)
            if result is None:
                result = _glob_python(root, sub, target, path)
            if result.get("error") and not result.get("matches"):
                continue
            truncated = truncated or bool(result.get("truncated"))
            for m in result.get("matches", []):
                if m not in seen:
                    seen.add(m)
                    merged.append(m)
        return {
            "pattern": pattern,
            "matches": _clip_glob_results(merged),
            "truncated": truncated,
        }
    result = _rg_glob(root, pattern, target, path)
    if result is not None:
        return result
    return _glob_python(root, pattern, target, path)


def summarize_value(value: str) -> str:
    if not value:
        return "<empty>"
    compact = unicodedata.normalize("NFKC", value)
    compact = re.sub(r"\s+", " ", compact).strip()
    if len(compact) > 600:
        return compact[:600] + " …"
    return compact


def web_search(query: str, max_results: int = 5) -> dict:
    """Search the web using the enabled engines from Settings → Plugins, in
    ``order`` (order 0 = primary, higher = fallback). DuckDuckGo needs no API
    key; Tavily uses the plugin's stored key. Only the engines the user
    explicitly enabled are tried, in order, until one returns results — a
    disabled engine (DuckDuckGo included) is never used, and a mis-configured
    key surfaces as an error instead of being silently masked.

    Returns a list of ``{"title", "url", "snippet"}`` results. Never raises.
    """
    query = query.strip()
    if not query:
        return {"query": query, "results": []}
    max_results = max(1, min(int(max_results or 5), MAX_WEB_SEARCH_RESULTS))
    engines = _active_search_engines()
    tried: list[str] = []
    fallbacks: list[str] = []
    for eng in engines:
        kind = (eng.get("kind") or "").strip()
        fn = SEARCH_BACKENDS.get(kind)
        if not fn:
            continue
        try:
            results = fn(query, max_results, eng)
        except ImportError:
            return {
                "query": query,
                "error": (
                    f"{kind} backend not installed; run `uv sync --project backend` "
                    f"to install the required package"
                ),
            }
        except Exception as exc:  # noqa: BLE001 — degrade per-engine
            tried.append(f"{kind}: {exc}")
            fallbacks.append(kind)
            continue
        if results:
            return {
                "query": query,
                "results": results,
                "engine": kind,
                "fallbacks": fallbacks,
            }
        tried.append(f"{kind}: no results")
        fallbacks.append(kind)
    reason = "; ".join(tried) if tried else "no search engines enabled"
    return {"query": query, "error": f"web search failed: {reason}"}


MAX_FETCH_BYTES = 1_000_000
FETCH_TIMEOUT = 30
# Cap applied to a fetched page before it is handed to the model. Matches
# codex's web_fetch (100k chars) so one call returns the full page like codex;
# callers that need more page the rest via `offset`. It is not the context
# budget (that comes from the model's reported window via `tool_out_chars`)
# — it only bounds a single page so one fetch can never flood the window.
FETCH_EXCERPT_CHARS = 100_000


def fetch_url(
    url: str, max_chars: int = FETCH_EXCERPT_CHARS, offset: int = 0
) -> dict:
    """Fetch a web page and return its extracted text.

    Returns ``{"url", "title", "content"}`` on success or ``{"url", "error"}``
    with a friendly reason otherwise. HTML is converted to Markdown (like
    opencode's webfetch) so headings/links/code/tables survive; binary /
    non-text responses are rejected; content is capped at ``max_chars`` so a
    single page can never flood the context window. Pass ``offset`` to page
    past an earlier excerpt (the truncation marker reports the next offset).
    The response is streamed and reads at most ``MAX_FETCH_BYTES``, so
    oversized pages are truncated rather than rejected wholesale. On a
    Cloudflare 403 the request is retried once with an honest User-Agent.
    Never raises.
    """
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"url": url, "error": "url must start with http:// or https://"}
    max_chars = max(500, min(int(max_chars or FETCH_EXCERPT_CHARS), MAX_FETCH_BYTES))
    offset = max(0, int(offset or 0))
    try:
        import httpx

        browser_ua = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
        )
        honest_ua = "curl/8.7.1"
        body = b""
        ct = ""
        for ua in (browser_ua, honest_ua):
            with (
                httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True) as client,
                client.stream("GET", url, headers={"User-Agent": ua}) as resp,
            ):
                if resp.status_code == 403 and ua != honest_ua:
                    # Cloudflare challenge — retry once with an honest UA.
                    continue
                if resp.status_code >= 400:
                    return {
                        "url": url,
                        "error": f"server returned HTTP {resp.status_code}",
                    }
                ct = resp.headers.get("content-type", "")
                if not (
                    "text/" in ct
                    or "application/json" in ct
                    or "application/xml" in ct
                    or ct.startswith("text/html")
                    or ct == ""
                ):
                    return {"url": url, "error": f"unsupported content-type {ct!r}"}
                chunks: list[bytes] = []
                size = 0
                for chunk in resp.iter_bytes(65_536):
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= MAX_FETCH_BYTES:
                        break
                body = b"".join(chunks)
                break
        body = body.decode("utf-8", errors="replace")
        title = ""
        text = body
        if "text/html" in ct or ct == "":
            title, text = _html_to_markdown(body)
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "error": f"fetch failed: {exc}"}

    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    total = len(text)
    if offset or total > max_chars:
        end = min(total, offset + max_chars)
        text = text[offset:end]
        if end < total:
            text += (
                f"\n…(truncated {total - end} chars remain — "
                f"re-fetch with offset={end} for more)"
            )
    return {
        "url": url,
        "title": title,
        "content": text,
        "offset": offset,
        "total_chars": total,
    }


def _fetch_for_search(url: str, max_chars: int = WEB_SEARCH_FETCH_CHARS) -> str | None:
    """Fetch a result's real page content for use inside web_search itself.

    Shares the same 24h fetch cache as fetch_url_tool (keyed by URL), so a
    page already fetched once — via search or an explicit fetch_url call —
    is never fetched twice. Returns the page text, or None on any failure;
    never raises, so one broken/slow URL never breaks the rest of a search.
    """
    cache = _get_result_cache()
    cache_key = f"fetch:{url}"
    cached = cache.get(cache_key)
    if cached:
        try:
            data = json.loads(cached)
            body = data.get("content", "")
            if body:
                return body
        except (ValueError, TypeError):
            pass
    result = fetch_url(url, max_chars)
    if "error" in result:
        return None
    body = result.get("content", "")
    if body:
        try:
            cache.set(
                cache_key,
                json.dumps(
                    {"content": body, "title": result.get("title", "")},
                    ensure_ascii=False,
                ),
                _fetch_cache_ttl(),
            )
        except Exception:  # noqa: BLE001, S110
            pass
    return body or None


def _html_to_text(html: str) -> tuple[str, str]:
    """Best-effort HTML → plain text conversion (title + body text)."""
    from html.parser import HTMLParser

    title = ""
    title_done = False
    out: list[str] = []

    class _P(HTMLParser):
        nonlocal_skip = 0
        nonlocal_chrome = 0

        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style", "noscript"):
                self.nonlocal_skip += 1
            elif tag in ("nav", "aside", "footer", "header"):
                self.nonlocal_chrome += 1
            elif (tag == "div" and self.nonlocal_chrome == 0) or tag in (
                "p",
                "br",
                "li",
                "tr",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "pre",
                "blockquote",
            ):
                out.append("\n")
            elif tag == "a":
                pass
            elif tag == "img":
                d = dict(attrs)
                alt = d.get("alt", "").strip()
                if alt:
                    out.append(f"[image: {alt}]")

        def handle_endtag(self, tag):
            if tag in ("script", "style", "noscript"):
                self.nonlocal_skip = max(0, self.nonlocal_skip - 1)
            elif tag in ("nav", "aside", "footer", "header"):
                self.nonlocal_chrome = max(0, self.nonlocal_chrome - 1)
            elif (tag == "div" and self.nonlocal_chrome == 0) or tag in (
                "p",
                "div",
                "li",
                "tr",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "pre",
                "blockquote",
            ):
                out.append("\n")

        def handle_data(self, data):
            nonlocal title, title_done
            if not title_done and self.nonlocal_skip == 0:
                # capture the first <title> text
                pass
            if self.nonlocal_skip > 0 or self.nonlocal_chrome > 0:
                return
            s = data.strip()
            if s:
                out.append(s + " ")

    parser = _P()
    parser.feed(html)
    text = "".join(out)
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()
    return title, text


def _html_to_markdown(html: str) -> tuple[str, str]:
    """HTML → Markdown conversion (title + body), like opencode's webfetch.

    Uses ``markdownify`` (with BeautifulSoup to drop script/style/nav chrome
    first, matching opencode's jsdom pre-clean) when installed; falls back to
    the plain-text parser otherwise.
    """
    try:
        from bs4 import BeautifulSoup
        from markdownify import markdownify as _md

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(
            ["script", "style", "noscript", "nav", "aside", "footer", "header"]
        ):
            tag.decompose()
        title = soup.title.get_text(strip=True) if soup.title else ""
        text = _md(str(soup), heading_style="ATX")
        return title, text
    except Exception:  # noqa: BLE001 — fall back to the plain-text parser
        return _html_to_text(html)


# --------------------------------------------------------------------------- #
# Tool registrations (LangGraph nodes read these from the registry)
# --------------------------------------------------------------------------- #


def _validate_mcp_url(url: str, timeout: int = 15) -> dict:
    """Verify that ``url`` is a working MCP endpoint before saving it.

    Sends an MCP ``initialize`` JSON-RPC request over the streamable-HTTP
    transport and, if that is rejected, falls back to checking for an SSE
    transport. Returns ``{"ok": True}`` on success or ``{"ok": False, "error":
    ...}`` with a human-readable reason otherwise.
    """
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "url must start with http:// or https://"}
    import httpx

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "coder", "version": "1.0"},
        },
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.post(url, json=payload, headers=headers)
            if resp.status_code in (401, 403):
                # Auth required, but the server recognized the request as MCP —
                # the URL is a real MCP endpoint; the user may add a header/API key.
                return {"ok": True, "auth_required": True}
            if resp.status_code in (200, 202):
                ct = resp.headers.get("content-type", "")
                if "application/json" in ct or "text/event-stream" in ct:
                    return {"ok": True}
                return {
                    "ok": False,
                    "error": (
                        f"endpoint returned {resp.status_code} with content-type "
                        f"{ct!r}, not the MCP protocol — this does not look like an "
                        "MCP server URL"
                    ),
                }
            if resp.status_code in (404, 405):
                # Possibly an SSE transport: GET should open an event stream.
                sse = client.get(url, headers={"Accept": "text/event-stream"})
                ct = sse.headers.get("content-type", "")
                if sse.status_code == 200 and "text/event-stream" in ct:
                    return {"ok": True}
                return {
                    "ok": False,
                    "error": (
                        f"endpoint rejected MCP requests (HTTP {resp.status_code}). "
                        "The server responded with a web page, not the MCP protocol — "
                        "check that this is a real MCP server URL (see its docs)."
                    ),
                }
            return {
                "ok": False,
                "error": f"endpoint returned HTTP {resp.status_code} to an MCP initialize request",
            }
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"could not reach the endpoint: {exc}"}


def _is_terminal_search(command: str) -> bool:
    """Heuristic: is this run_terminal call a read-only search/inspection of
    the codebase (so it should be handled by the dedicated "search" subagent
    model when one is configured) rather than build/run/git/package work?

    The agent usually prefixes commands with ``cd <root> && …`` and often
    labels sections with ``echo "=== … ==="``, so we scan every
    ``&&``/``;``/``|``/newline segment, skip those label/prefix segments, and
    classify as search when the first *meaningful* command is a read-only
    search/inspection command. Stopping at the first meaningful command also
    keeps build pipelines (``npm run build && cat dist/…``) from being
    misclassified as search.
    """
    cmd = (command or "").strip()
    if not cmd:
        return False
    # Commands that only set up the environment or print labels — never the
    # actual operation, so they don't decide the classification.
    _SKIP = {"cd", "echo", "pwd", "export", "env", "set", "source", "clear", "time"}
    _SEARCH = {
        "grep",
        "egrep",
        "fgrep",
        "rg",
        "ripgrep",
        "find",
        "sed",
        "awk",
        "cat",
        "ls",
        "head",
        "tail",
        "wc",
        "sort",
        "uniq",
        "type",
        "which",
        "nl",
        "tree",
        "file",
        "stat",
        "cut",
        "tr",
        "diff",
        "strings",
        "xxd",
        "od",
        "less",
        "more",
        "fold",
        "fmt",
        "paste",
        "join",
        "tac",
        "rev",
        "shuf",
        "seq",
        "xargs",
        "jq",
        "sqlite3",
    }
    _GIT_PREFIXES = ("git grep", "git log", "git diff", "git show", "git blame")
    for seg in re.split(r"&&|;|\||\n", cmd):
        seg = seg.strip()
        if not seg:
            continue
        first = seg.split()[0].lower() if seg.split() else ""
        if first in _SKIP:
            continue
        if first in _SEARCH:
            return True
        # First meaningful command is not a search — stop here.
        return seg.startswith(_GIT_PREFIXES)
    return False


# Commands that MUTATE the filesystem / system state. Used to keep the
# background sub-agent read-only: it may inspect the codebase but must never
# write, delete, move, install, or otherwise change state (matching opencode's
# explore agent, which is allowed to run bash only for read-only inspection).
_TERMINAL_WRITE = {
    "rm", "mv", "cp", "dd", "mkfs", "touch", "mkdir", "rmdir", "chmod", "chown",
    "chgrp", "ln", "truncate", "shred", "install", "rename", "tee", "sudo", "su",
    "doas", "kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff",
    "mount", "umount", "insmod", "rmmod", "modprobe", "iptables", "systemctl",
    "service", "crontab", "useradd", "userdel", "usermod", "groupadd", "passwd",
    "chpasswd", "npm", "yarn", "pnpm", "pip", "pip3", "uv", "cargo", "go", "make",
    "cmake", "gradle", "mvn", "npx", "bundle", "gem", "apt", "apt-get", "dnf",
    "yum", "brew", "docker", "podman", "kubectl", "helm", "terraform", "ansible",
    "rsync", "scp", "wget", "curl", "patch", "python", "python3", "node", "ruby",
    "perl", "bash", "sh", "zsh", "source", "eval", "exec", "xargs", "env",
    "export", "set", "alias", "printf", "echo",
}

# git subcommands that mutate the repo (git read commands like log/show/diff/
# grep/status are allowed for exploration). NOTE: `branch`/`tag` are intentionally
# excluded here — plain `git branch`/`git tag` (list) are read-only and allowed;
# only their delete forms (`git branch -d`, `git tag -d`) are blocked below.
_GIT_WRITE = {
    "commit", "push", "checkout", "add", "reset", "rm", "mv", "merge", "rebase",
    "clean", "stash", "clone", "init", "am", "cherry-pick",
    "revert", "fetch", "pull",
}


def _is_terminal_write(command: str) -> bool:
    """Heuristic: does ``command`` mutate the filesystem or system state?

    Scans every ``&&``/``;``/``|``/newline segment; if any *meaningful* command
    is a write/mutate operation (or a shell/interpreter that could write), the
    whole command is treated as a write. Used to keep the background sub-agent
    strictly read-only.
    """
    cmd = (command or "").strip()
    if not cmd:
        return False
    _SKIP = {"cd", "pwd", "clear", "time"}
    for seg in re.split(r"&&|;|\||\n", cmd):
        seg = seg.strip()
        if not seg:
            continue
        parts = seg.split()
        first = parts[0].lower() if parts else ""
        if first in _SKIP:
            continue
        # Bare output redirects to a real file are writes; redirect to /dev/null
        # is a no-op (allowed), and fd-to-fd redirects like `2>&1` don't write a
        # file either. After stripping those, any remaining `>` is a real write.
        if re.search(r">>?", seg):
            _stripped = re.sub(r">>?\s*/dev/null\b", " ", seg)
            _stripped = re.sub(r"\d*>&\d+", " ", _stripped)
            if re.search(r">>?", _stripped):
                return True
        if first == "git":
            sub = parts[1].lower() if len(parts) > 1 else ""
            # `git branch -d/-D`, `git tag -d` delete; plain `git branch`/`git tag`
            # (list) are read-only.
            return bool(sub in _GIT_WRITE or sub in ("branch", "tag") and "-d" in parts)
        # First meaningful command is not a write — stop here.
        return first in _TERMINAL_WRITE
    return False


def _tool_event(ev: dict) -> dict:
    """Shape a tool event for the SSE stream: whitelist the fields the UI can
    render. LIVES HERE (not in agents.py) so the backend tests can import it
    without pulling in agents' heavy dependencies.

    IMPORTANT: the whitelist MUST include ``branch`` — the frontend routes a
    task call's sub-events to ITS OWN card by this id (Chat.tsx). When it was
    missing, ``branch`` was stripped from every event, and the frontend fell
    back to nesting every sub-event into EVERY running task card — three
    parallel sub-agents all showed the same stats ("116 calls · 109.5s" on
    each card)."""
    kind = ev.get("kind", "tool_result")
    if kind == "usage":
        # Usage events carry token/cost/model fields the UI needs verbatim —
        # they are NOT tool activity, so pass them through untouched (the
        # background sub-agent emits them through the same emit callback).
        return dict(ev)
    if kind not in ("tool", "tool_result", "diff", "plan", "permission", "ask"):
        kind = "tool_result"
    out: dict = {"kind": kind, "tool": ev.get("tool", "")}
    for key in (
        "args",
        "summary",
        "path",
        "diff",
        "content",
        "items",
        "results",
        "engine",
        "call_id",
        "id",
        "action",
        "reason",
        "sub",
        "question",
        "options",
        "scope",
        "status",
        "model",
        "branch",
        "task_id",
    ):
        val = ev.get(key)
        if val is not None:
            out[key] = val
    return out


def _load_skills_for_tool() -> list[dict]:
    """Lazy wrapper around ``agents._load_skills``.

    ``agents`` imports ``tools`` at module level, so importing it back must
    stay inside a function to avoid a circular import. Skills live in the app
    DB (the ``root`` argument of ``_load_skills`` is API-compat only).
    """
    from agents import _load_skills

    return _load_skills("")


def _def_body_text(abs_path: str, match_line: int, start: int, end: int) -> str | None:
    """Render a definition body (``start``..``end``) in grep-snippet style.

    Only called when the match IS the definition's first line, so the model
    sees the whole body inline and needs no follow-up ``read``. Capped at
    ``_DEF_BODY_MAX_LINES`` with a pointer to the remaining lines. Never raises.
    """
    try:
        count = min(end, start + _DEF_BODY_MAX_LINES - 1) - start + 1
        if count <= 0:
            return None
        excerpt = _read_lines_excerpt(abs_path, start, count)
        blines = excerpt.get("lines") or []
        if not blines:
            return None
        out = "\n".join(
            f"{'>' if cl['line'] == match_line else ' '} {cl['line']} | {(cl.get('text') or '')[:SNIPPET_LINE_WIDTH]}"
            for cl in blines
        )
        rest = end - (start + len(blines) - 1)
        if rest > 0:
            out += (
                f"\n  ... (+{rest} more lines to L{end} — "
                f"read lines {start}-{end} for the rest)"
            )
        return out
    except Exception:  # noqa: BLE001 — body expansion never breaks grep
        return None


def make_tool_callbacks(
    root: str,
    emit: Callable[[dict], None],
    context_window: int = 0,
    web_model: Any = None,
    main_model: Any = None,
    vision_model: Any = None,
    explore_model: Any = None,
    image_uris: list[str] | None = None,
    reserved: int | None = None,
    permission_gates: dict | None = None,
    ask_gates: dict | None = None,
    permit: dict | None = None,
    store: VectorStore | None = None,
    chat_id: str = "",
    history: list[dict] | None = None,
    permission_gate_chat: dict | None = None,
    ask_gate_chat: dict | None = None,
) -> dict[str, Callable]:
    # Bind chat_id into the closure so tools (e.g. update_plan) can persist
    # per-chat state to disk via state_db. Previously chat_id was accepted but
    # never captured, so update_plan could only emit to the UI — never save.
    _chat_id = chat_id
    # Restart-proof memory: reload the persisted checklist into the session
    # store so the nudge backstop and completion gate keep working after a
    # process restart wiped the in-memory copy.
    if _chat_id and not _PLAN_BY_CHAT.get(_chat_id):
        try:
            _ws0 = _state_db.workspace_slug_for_root(root)
            _disk0 = _state_db.get_checklist(_ws0, _chat_id)
            if _disk0 and not all(
                isinstance(it, dict) and it.get("status") == "completed"
                for it in _disk0
            ):
                _PLAN_BY_CHAT[_chat_id] = [dict(it) for it in _disk0]
        except Exception:  # noqa: BLE001, S110 — hydration never breaks tools
            pass
    # Per-turn reset of the advisory search budget for this (chat, root).
    # Callbacks are rebuilt every turn, so a workspace-global counter must
    # not leak across turns and block Ask/Plan after 3 calls. Sub-agent
    # turns reuse the parent scope and must not wipe it.
    try:
        if not _SUB_AGENT_CTX.get():
            _turn_key = (str(chat_id or ""), str(root or ""))
            _SEARCH_BATCHES[_turn_key] = 0
            _SEARCH_BATCH_GENERATIONS[_turn_key] = int(_search_generations.get(str(root or ""), 0) or 0)
            if _chat_id:
                _READ_RANGES_BY_CHAT[_chat_id] = {}
                _READ_LONE_CALLS_BY_CHAT[_chat_id] = {}
                _SEARCH_SURFACED_BY_CHAT[_chat_id] = set()
                # The chat-lifetime 'exact window already returned' ledger must
                # reset per turn too, for the same reason as the ranges above:
                # turn-start trimming / history budgeting replaces earlier read
                # results with `[truncated ... re-issue if still needed]`, so a
                # re-issued read of that window must return real bytes. Keeping
                # the old ledger answered with 'unchanged: already returned' and
                # no content -> the model re-read the same window step after step.
                _READ_SEEN_BY_CHAT[_chat_id] = set()
    except Exception:  # noqa: BLE001, S110 - turn reset never breaks tools
        pass
    # Open snapshot for this turn: the first write in a turn creates a new
    # checkpoint seq and the rest of the writes in the same turn append to it
    # (per-turn aggregation). make_tool_callbacks is called again per turn, so
    # this state is automatically per-turn with no manual reset.
    _ckpt_open: dict = {}
    # Chat history snapshot from memory (passed from graph.py).
    """Build the agent tools bound to ``root`` with an emit callback.

    ``emit`` receives a dict like ``{"kind": "tool"|"tool_result", "tool": name,
    "args": ..., "summary": ...}`` so the UI can render live tool activity.

    ``context_window`` (when > 0) makes the agent budget its tool output so each
    result stays well within a small model's context window across a multi-step
    run — avoiding context overflow that truncates the session.

    Tools are async so the LangGraph orchestrator can execute them on the
    event loop, keeping the shared emit callback aligned with the streaming
    loop.
    """

    # Correlate every tool call with its result via a per-invocation `call_id`.
    # The UI previously matched tool_results to running cards by (tool name +
    # status) alone, which breaks when the SAME tool runs multiple times in a
    # turn (e.g. 8× grep) or when the sub-agent emits identically-named
    # tool events into the same stream — results could resolve the wrong card,
    # leaving a genuinely-started card stuck on "running" forever.
    #
    # Parent AND sub-agent tools carry their pairing through a
    # `contextvars.ContextVar` set per invocation: LangGraph runs parallel
    # same-name tool calls as SEPARATE async tasks (each with a copied
    # context), and each task emits its own `tool` then its own
    # `tool_result`. Threading the id through the context keeps tool→result
    # correct even when parallel calls finish OUT of order — a name-based
    # FIFO (pop the oldest pending id) would otherwise swap the results
    # and, on a Stop, make the retried model think work was never done,
    # re-running duplicate tools. Sub-agent tools use the same mechanism
    # (their functions are `_invoke`-wrapped too), so no FIFO is needed.
    _call_seq = 0
    # Unique id per task CALL: stamped on the task card, its tool_result
    # and every sub-event so the frontend routes a call's sub-events to ITS OWN
    # card even when two task calls run concurrently (the parent can issue
    # several in one parallel-tool-calls response). Without it, both calls'
    # sub-events nest into the first running task card ("all parallel
    # sub-agents show the same sub-searches"). One id per call — each call
    # spawns its own background sub-agent job.
    _task_call_seq = 0
    _cur_call_id: contextvars.ContextVar[int] = contextvars.ContextVar(
        "coder_tool_call_id", default=0
    )
    # آخرین شاتِ see برای تبدیل خودکار پیکسلِ تصویر → نقطه‌ی منطقی.
    # هر اپ/هر ناحیه (window/selector/region) را پوشش می‌دهد؛ بدون آن، مدل
    # باید دستی origin+pixel/scale حساب می‌کرد و روی رتینا/ downscale خطا می‌داد.
    _computer_last_shot: dict[str, Any] = {}
    # کش یک‌-entry تحلیل see: اگر PNG + سؤال + مدل بینایی عیناً تکرار شد
    # (مثلاً مدل دوباره وضعیت صفحه را می‌پرسد بی‌آنکه اکشنی زده باشد)،
    # فراخوانی vision (تا چند ثانیه) رد می‌شود. تغییر پیکسل → کلید جدید.
    _see_cache: dict[str, Any] = {"key": None, "result": None}
    # راه فرار دروازه see: بعد از یک رد، همان سؤال+اپ در همین نوبت
    # از دروازه معاف است تا بینایی برای آن سؤال قفل نشود.
    _see_gate_rejected: set[str] = set()

    def _convert_pixel_to_logical(x: int | None, y: int | None) -> tuple[int | None, int | None]:
        """اگر x,y داخل آخرین تصویرِ see باشد، به فضای منطقی تبدیل کن.

        مدل بینایی مختصات را داخل تصویرِ ارسالی (image_width×image_height) می‌دهد؛
        InputSim در فضای logical (bounds عناصر) کار می‌کند. این تابع با
        origin+pixel/scale تبدیل را اتومات می‌کند تا LLM نیاز به محاسبه نداشته
        باشد. اگر x,y خارج از تصویر یا شاتی ثبت نشده، دست‌نخورده برمی‌گردد
        (پس کلیک‌های منطقی از targets هم سالم می‌مانند).
        """
        if x is None or y is None:
            return x, y
        # LLM گاهی عدد را به‌صورت رشته می‌فرستد ("342") — به عدد تبدیل کن وگرنه مقایسه <= خطا می‌دهد
        try:
            xv: int | float = int(float(str(x).strip())) if isinstance(x, str) else x
            yv: int | float = int(float(str(y).strip())) if isinstance(y, str) else y
        except Exception:  # noqa: BLE001
            return x, y
        if not isinstance(xv, (int, float)) or not isinstance(yv, (int, float)):
            return x, y
        if not _computer_last_shot:
            return xv, yv
        iw = _computer_last_shot.get("image_width")
        ih = _computer_last_shot.get("image_height")
        if not isinstance(iw, int) or not isinstance(ih, int):
            return xv, yv
        if not (0 <= xv <= iw and 0 <= yv <= ih):
            return xv, yv
        # از اینجا به بعد با xv/yv کار می‌کنیم
        x, y = xv, yv
        # خارج از تصویر → فرض بر منطقی بودن؛ تبدیل نکن
        ox = int(_computer_last_shot.get("origin_x", 0) or 0)
        oy = int(_computer_last_shot.get("origin_y", 0) or 0)
        sx = _computer_last_shot.get("image_scale_x", _computer_last_shot.get("image_scale", 1.0))
        sy = _computer_last_shot.get("image_scale_y", sx)
        try:
            sx_f = float(sx or 1.0)
            sy_f = float(sy or 1.0)
        except Exception:  # noqa: BLE001
            return x, y
        if sx_f == 0 or sy_f == 0:
            return x, y
        return round(ox + x / sx_f), round(oy + y / sy_f)

    def _emit(event: dict) -> None:
        nonlocal _call_seq
        ev = dict(event)
        kind = ev.get("kind")
        tool = ev.get("tool") or ""
        if kind == "usage":
            # Every usage event emitted from tools.py is a SUB-AGENT model call
            # (search/web/subagent distill + summarizers) — the parent's own
            # usage is emitted from agents.py, never here. Tag it `sub=True` so
            # the frontend keeps sub-agent usage out of the message badge /
            # context meter (it runs in isolated transcripts that never enter
            # the parent's context) while still accruing it into the chat-wide
            # session totals.
            ev["sub"] = True
        if _SUB_AGENT_CTX.get():
            # A sub-agent is running: its tool calls reuse the PARENT's
            # tool functions, so tag them `sub=True` (they run in an isolated
            # transcript — never count against the parent's tool-step budget)
            # and stamp the task card's branch id so the frontend nests them
            # under that card.
            ev["sub"] = True
            _br = _SUB_AGENT_BRANCH_CTX.get()
            if _br:
                ev["branch"] = _br
            # Stamp the background job id so trace entries can be filtered
            # per sub-agent (Trace viewer opens one filtered view per task).
            try:
                _tid = str(_subagent_jobs.RUNNING_TASK_CTX.get() or "").strip()
            except Exception:  # noqa: BLE001 — trace tagging never breaks tools
                _tid = ""
            if _tid:
                ev["task_id"] = _tid
        # Tool→result pairing: read the per-invocation id. The `_invoke`
        # wrapper below reset it to 0 so the first `tool` emit allocates a
        # fresh id and the matching `tool_result` (same invocation/context)
        # reuses it. Parallel same-name calls run as separate async tasks
        # with copied contexts, so out-of-order completion can never swap
        # ids — for parent and sub-agent calls alike.
        if kind == "tool":
            cid = _cur_call_id.get()
            if not cid:
                _call_seq += 1
                cid = _call_seq
                _cur_call_id.set(cid)
            ev["call_id"] = cid
        elif kind == "tool_result":
            cid = _cur_call_id.get()
            if cid:
                ev["call_id"] = cid
        orig_emit(ev)
        # Live Trace panel log (LangSmith-style) — best-effort, never breaks tools.
        try:
            import json as _trace_json

            import trace_store as _trace_store

            if kind == "tool":
                try:
                    _args_text = _trace_json.dumps(ev.get("args") or {}, ensure_ascii=False, sort_keys=True)[:8000]
                except Exception:  # noqa: BLE001
                    _args_text = str(ev.get("args") or "")[:8000]
                # The main loop already appended a running entry with the step
                # number for this same call — claim it instead of logging twice.
                _ev_tid = str(ev.get("task_id") or "").strip()
                _claimed = _trace_store.claim_running_tool(
                    str(_chat_id or ""),
                    str(tool or ""),
                    bool(ev.get("sub")),
                    {
                        "ev_call_id": str(ev.get("call_id") or ""),
                        "branch": str(ev.get("branch") or ""),
                        "sub": bool(ev.get("sub")),
                        "task_id": _ev_tid,
                    },
                )
                if _claimed is None:
                    _trace_store.append(
                        str(_chat_id or ""),
                        "tool",
                        str(tool or "tool"),
                        detail={
                            "name": str(tool or ""),
                            "args": ev.get("args") or {},
                            "call_id": str(ev.get("call_id") or ""),
                            "ev_call_id": str(ev.get("call_id") or ""),
                            "model": str(ev.get("model") or ""),
                            "branch": str(ev.get("branch") or ""),
                            "sub": bool(ev.get("sub")),
                            "task_id": _ev_tid,
                            "status": "running",
                        },
                        model=str(ev.get("model") or ""),
                        prompt=_args_text,
                        task_id=_ev_tid,
                    )
            elif kind == "tool_result":
                _res = ev.get("results")
                if _res is None:
                    _res = ev.get("content")
                if _res is None:
                    _res = ev.get("summary")
                try:
                    _res_text = _trace_json.dumps(_res, ensure_ascii=False, sort_keys=True)[:20000] if not isinstance(_res, str) else str(_res)[:20000]
                except Exception:  # noqa: BLE001
                    _res_text = str(_res or "")[:20000]
                _is_err = str(ev.get("status") or "").lower() == "error" or str(_res_text).startswith("ERROR")
                _trace_store.finish_tool(
                    str(_chat_id or ""),
                    ev.get("call_id") or "",
                    _res_text,
                    error=str(ev.get("summary") or _res_text)[:2000] if _is_err else "",
                    task_id=str(ev.get("task_id") or ""),
                )
        except Exception:  # noqa: BLE001, S110 — trace must never break tools
            pass

    orig_emit = emit
    emit = _emit

    # Sub-agent fallback state: when a sub-agent model (explore / web / search)
    # hard-fails (bad key / invalid model / quota exhaustion), the tool re-runs
    # the call on the MAIN model instead of degrading to a raw-output note.
    # Sticky per slot per turn: once a slot falls back, the rest of the turn's
    # calls for that slot go straight to the main model (no point re-hitting a
    # broken model).
    _fallback_state: dict[str, bool] = {}

    def _emit_fallback(
        slot: str,
        agent_label: str,
        failed_model: Any,
        fallback_model: Any,
        exc: Exception,
    ) -> None:
        """Mark a sub-agent slot as fallen back (sticky for the rest of the turn)
        and surface a ``retry``-family event so the UI shows a distinct
        'sub-agent failed — using main model' banner instead of a spinner."""
        _fallback_state[slot] = True
        failed_name = str(getattr(failed_model, "model_name", "") or "")
        fallback_name = str(getattr(fallback_model, "model_name", "") or "")
        text = str(exc).strip()
        try:
            emit(
                {
                    "kind": "retry",
                    "attempt": 1,
                    "max_attempts": 1,
                    "delay": 0,
                    "reason": f"{agent_label} model ({failed_name}) failed: {text}",
                    "model": fallback_name,
                    "agent": agent_label,
                    "fallback": True,
                }
            )
        except Exception:  # noqa: BLE001, S110 — cosmetic only
            pass

    async def _run_distill(
        slot: str,
        sub_model: Any,
        label: str,
        system_prompt: str,
        make_prompt: Callable[[], str],
        timeout_total: int = 60,
        main_model: Any = None,
    ) -> tuple[Any, Any]:
        """Run a one-shot sub-agent distillation call (web distiller / page
        summarizer / terminal-search reader) with the shared retry policy,
        falling back to the MAIN model on a hard failure (bad key / invalid
        model / quota exhaustion). Returns ``(result, model_that_ran)`` so the
        caller can label usage + tool_result with the model that ACTUALLY ran.
        Sticky per slot per turn: a slot that already fell back skips the
        sub-agent model and goes straight to the main model.

        Uses a LangChain model."""
        from llm import llm_generate

        model = main_model if _fallback_state.get(slot) else sub_model
        while True:
            try:
                text, usage = await llm_generate(
                    model, system=system_prompt, user=make_prompt(), sub=True,
                    chat_id=str(_chat_id or ""),
                )
                if usage:
                    emit(usage)
                return text, model
            except Exception as exc:  # fall back to main model
                if model is main_model or main_model is None:
                    raise
                # Hard failure on the sub-agent model → re-run on the main model
                # for the rest of this turn (sticky).
                _emit_fallback(slot, label, model, main_model, exc)
                model = main_model

    def _invoke(fn: Callable) -> Callable:
        import functools as _functools

        @_functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            token = _cur_call_id.set(0)
            try:
                return await fn(*args, **kwargs)
            finally:
                _cur_call_id.reset(token)

        return wrapped

    # Reserve headroom so tool outputs + accumulated turn history + reply still fit.
    # Budgets scale with the context window so small models (e.g. 8k) get tight caps
    # that prevent overflow / mid-task truncation.
    if context_window and context_window > 0:
        ctx = int(context_window)
        tool_out_chars = max(400, min(ctx // 6, 8_000))
        max(15, ctx // 600)
        max(10, ctx // 500)
        terminal_out_chars = min(MAX_TERMINAL_OUTPUT, max(1_000, tool_out_chars * 1))
    else:
        tool_out_chars = min(MAX_READ_BYTES, 8_000)
        terminal_out_chars = MAX_TERMINAL_OUTPUT
    tool_out_chars = min(tool_out_chars, MAX_READ_BYTES)

    # Shared state for the update_plan nudge backstop (see _format_plan_nudge_suffix
    # above) — lives for this run only, reset each time make_tool_callbacks is called.
    _plan_nudge_state = {"since_update": 0, "has_in_progress": False}
    # Was 5: a task that finishes in only 1-4 mutating tool calls after the last
    # update_plan (the common case for small tasks) never hit the threshold, so
    # the model could write its final reply with a step still stuck 'in_progress'
    # and no nudge ever fired. 1 nudges after EVERY mutating call while stuck, so
    # even a single-tool-call task gets reminded before the model's final reply.
    _PLAN_NUDGE_EVERY = 1

    # Read-window hygiene (code-enforced, not prompt-only). Session telemetry
    # showed ~70% of tool calls were `read`, one call per model step, and most
    # windows either overlapped an earlier one or slid a few lines past it —
    # every extra step re-sends the whole context. Overlapping/adjacent/nearby
    # (gap under _READ_JOIN_GAP) windows of the SAME file inside one call are
    # merged into one block, bridging the gap so no follow-up read is needed
    # for the sliver between them. Small files / EOF are unaffected (the
    # excerpt reader stops at EOF).
    def _widen_and_merge_windows(
        wins: list[tuple[str, int, int]],
    ) -> list[tuple[str, int, int]]:
        spans: dict[str, list[list[int]]] = {}
        for p, off, lim in wins:
            off = max(1, int(off or 1))
            lim = max(1, int(lim or 2000))
            spans.setdefault(p, []).append([off, off + lim - 1])
        out: list[tuple[str, int, int]] = []
        for p, ss in spans.items():  # dict keeps first-seen path order
            ss.sort()
            merged = [ss[0]]
            for a, b in ss[1:]:
                # Bridge near-adjacent windows (gap <= _READ_JOIN_GAP): fetch
                # the gap too — each extra read call costs a full round-trip.
                if a <= merged[-1][1] + 1 + _READ_JOIN_GAP:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            for a, b in merged:
                out.append((p, a, b - a + 1))
        return out

    def _plan_open_count() -> int:
        """Number of non-completed items on this chat's stored checklist.

        Read from the module-global store (not the per-turn
        ``_plan_nudge_state``) so the backstop works across turns and also
        covers all-pending lists — previously only an ``in_progress``-stuck
        list was reminded, and an all-pending checklist went stale silently
        while edits ran (todos never ticked).
        """
        if not _chat_id:
            return 0
        try:
            stored = _PLAN_BY_CHAT.get(_chat_id, [])
        except Exception:  # noqa: BLE001 — backstop must never break a tool
            return 0
        return sum(
            1
            for s in stored
            if isinstance(s, dict) and s.get("status") != "completed"
        )

    def _plan_nudge_due() -> bool:
        """Call once per mutating tool call. Returns True (and resets the counter)
        once every `_PLAN_NUDGE_EVERY` calls made while the checklist still has
        open steps — fires repeatedly, not just once, until the model actually
        updates the plan."""
        # Cross-turn work meter for the no-progress-repeat guard in update_plan
        # (module-global: survives callback rebuilds between turns).
        if _chat_id:
            _PLAN_MUTATING_SINCE_UPDATE[_chat_id] = (
                _PLAN_MUTATING_SINCE_UPDATE.get(_chat_id, 0) + 1
            )
        if _plan_open_count() == 0:
            return False
        _plan_nudge_state["since_update"] += 1
        if _plan_nudge_state["since_update"] >= _PLAN_NUDGE_EVERY:
            _plan_nudge_state["since_update"] = 0
            return True
        return False

    def _error_result(tool: str, msg: str) -> dict:
        """Build a tool_result event for a FAILED tool call.

        ``status: "error"`` is what drives the UI's red ✗ badge (see
        Chat.tsx's status mapping in ToolCallView: only 'error' renders the
        cross, anything else renders ✓). Every failure path must go through
        this so a failed fetch/search/write is never shown as a success tick.
        """
        return {"kind": "tool_result", "tool": tool, "summary": msg, "status": "error"}

    def _lsp_announce_start(target: str) -> str:
        """Emit a status event when the LSP server binary is missing.

        Installs can take minutes (package managers); the status event is sent
        synchronously BEFORE the blocking install so the UI shows *why* the
        tool call is waiting instead of a stuck spinner. The install itself
        runs in a worker thread via asyncio.to_thread, so the event loop stays
        responsive and this event flushes first. Returns the language being
        installed ("" when nothing needs installing). Best-effort: never
        breaks the tool.
        """
        try:
            from lsp_manager import get_manager as _get_lsp_mgr_prog

            lang = _get_lsp_mgr_prog(root).pending_install_language(target)
            if lang:
                emit(
                    {
                        "kind": "status",
                        "stage": "lsp",
                        "content": f"installing language server for {lang}...",
                    }
                )
                return lang
        except Exception:  # noqa: BLE001, S110 - progress never breaks tools
            pass
        return ""

    def _lsp_announce_done(lang: str, ok: bool) -> None:
        """Emit the closing status event for an announced LSP install."""
        if not lang:
            return
        try:
            emit(
                {
                    "kind": "status",
                    "stage": "lsp",
                    "content": (
                        f"language server for {lang} ready"
                        if ok
                        else f"language server install failed for {lang}"
                    ),
                }
            )
        except Exception:  # noqa: BLE001, S110 - progress never breaks tools
            pass

    def _read_line_text(path: str, ln: int) -> str:
        """One line's text (1-indexed), or "" when unreadable/out of range."""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for i, raw in enumerate(fh, start=1):
                    if i == ln:
                        return raw.rstrip("\n")
                    if i > ln:
                        break
        except OSError:
            pass
        return ""

    async def _lsp_resolve_position(target: str, line: int, character: int, symbol: str) -> tuple[int, int]:
        """Resolve the LSP position (line + column) for a symbol request.

        Column guesses are the top failure mode: when `symbol` is given, read
        that line and use the symbol offset instead of the raw `character`.
        When the symbol is NOT on that line (e.g. the model guessed line 1),
        resolve it from the file's document symbols instead — answering the
        request directly instead of returning empty and costing a full LLM
        round-trip. Without a usable symbol the column snaps to the nearest
        identifier on the line that is NOT a language keyword — a position on
        "async"/"def" answers empty. Falls back to the raw `character` when
        nothing resolves.
        """
        want = str(symbol or "").strip()
        try:
            ln = max(1, int(line or 1))
        except (TypeError, ValueError):
            return int(line or 1), int(character or 0)
        try:
            text = await asyncio.to_thread(_read_line_text, target, ln)
        except Exception:  # noqa: BLE001 - read never breaks resolution
            text = ""
        if text and want:
            idx = text.find(want)
            if idx < 0:
                idx = text.lower().find(want.lower())
            if idx >= 0:
                return ln, idx
        # Symbol not on the given line (or no line text): resolve it from the
        # file's document symbols so the call still answers directly.
        if want:
            try:
                from lsp_manager import get_manager as _get_lsp_mgr_pos

                _pm = _get_lsp_mgr_pos(root)
                _syms = await asyncio.to_thread(_pm.document_symbols_if_running, target)
                _exact: tuple[int, int] | None = None
                _fuzzy: tuple[int, int] | None = None
                for _sn, _sv in (_syms or {}).items():
                    try:
                        _ss = int(_sv[0])
                    except (TypeError, ValueError, IndexError):
                        continue
                    if _sn == want and _exact is None:
                        _exact = (_ss, 0)
                    elif _fuzzy is None and want.lower() in str(_sn).lower():
                        _fuzzy = (_ss, 0)
                _resolved = _exact or _fuzzy
                if _resolved is not None:
                    # Re-resolve the column on the symbol's own line (finds the
                    # name there; no further recursion).
                    return await _lsp_resolve_position(target, _resolved[0], 0, want)
            except Exception:  # noqa: BLE001, S110 - fallback never breaks the call
                pass
        if not text:
            return ln, int(character or 0)
        # Snap to the nearest non-keyword identifier on the line.
        want_col = int(character or 0)
        best: tuple[int, int] | None = None
        for m in re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", text):
            if m.group(0) in _LSP_SKIP_WORDS:
                continue
            col = max(m.start(), min(want_col, m.end() - 1))
            dist = abs(col - want_col)
            if best is None or dist < best[0]:
                best = (dist, col)
        if best is not None:
            return ln, best[1]
        return ln, want_col

    async def _lsp_call_with_wait(target: str, method: str, *args):
        """Call an LspManager method, absorbing lazy-start latency in-process.

        The first LSP call for a language returns a 'server starting' error
        while a daemon thread runs the initialize handshake. Waiting here
        (bounded by _LSP_START_WAIT_S) and retrying once lets the SAME tool
        call succeed, instead of returning a retry error that costs a full
        LLM round-trip (every request re-sends the whole context). A
        transient timeout (server busy indexing) is retried once in-tool
        for the same reason.
        """
        from lsp_manager import get_manager as _get_lsp_mgr_wait

        mgr = _get_lsp_mgr_wait(root)
        fn = getattr(mgr, method, None)
        if fn is None:
            raise AttributeError(f"lsp manager has no method {method}")
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception as exc:
            _txt = str(exc or "").lower()
            if "starting" in _txt or "retry shortly" in _txt:
                try:
                    ready = await asyncio.to_thread(
                        mgr.wait_for_server, target, _LSP_START_WAIT_S
                    )
                except Exception:  # noqa: BLE001 — wait is best-effort
                    ready = False
                if not ready:
                    raise
                return await asyncio.to_thread(fn, *args)
            # Transient timeout: the server is up but busy (workspace
            # indexing, queued didOpen). One in-tool retry absorbs it
            # instead of returning an error that costs a full LLM
            # round-trip to redo. A SECOND timeout means the server is
            # wedged: evict it so later calls start fresh instead of every
            # LSP call for this language burning double the timeout.
            def _is_timeout(e: BaseException) -> bool:
                try:
                    from lsp_manager import classify_lsp_error as _classify_wait

                    return _classify_wait(e) == "timeout"
                except Exception:  # noqa: BLE001 — classification is best-effort
                    return "timed out" in str(e or "").lower()

            if not _is_timeout(exc):
                raise
            try:
                return await asyncio.to_thread(fn, *args)
            except Exception as exc2:  # classified below
                if not _is_timeout(exc2):
                    raise
                try:
                    await asyncio.to_thread(mgr.evict_server, target)
                except Exception:  # noqa: BLE001, S110 — eviction is best-effort
                    pass
                from lsp_manager import LspError as _LspErr

                raise _LspErr(
                    f"{method} timed out twice — wedged server evicted, "
                    f"a fresh one starts on the next call",
                    kind="wedged",
                ) from exc2

    def _lsp_error_text(tool: str, filePath: str, line: int, character: int, exc: Exception) -> str:
        """Precise LSP failure message so the model never falls back to blind grep.

        Empty, timeout, missing binary, and dead server are distinct: timeout
        is a retry (never "no results"), the install hint appears only when
        the binary is truly missing, and every branch names the exact next
        action instead of a generic workspace grep.
        """
        try:
            from lsp_manager import classify_lsp_error as _classify

            kind = _classify(exc)
        except Exception:  # noqa: BLE001 - classification never fails
            kind = "error"
        base = f"{filePath}:{line}:{character}"
        # Never suggest lsp_symbols when lsp_symbols itself failed (circular).
        _alt = (
            "grep scoped to this file for exact names"
            if tool == "lsp_symbols"
            else "lsp_symbols for exact names"
        )
        if kind == "timeout":
            return (
                f"ERROR {tool} {base}: request timed out ({exc}). "
                f"The server is running but slow - retry this same call once; "
                f"do NOT report no results and do NOT fall back to a blind workspace grep."
            )
        if kind == "wedged":
            return (
                f"ERROR {tool} {base}: the language server wedged (timed out "
                f"twice) and was stopped; a fresh server starts on the next "
                f"call. Retry this same call once; if it still times out, "
                f"read the file directly - never a blind workspace grep."
            )
        if kind == "dead":
            return (
                f"ERROR {tool} {base}: language server died ({exc}). "
                f"Retry this same call once (the server restarts on demand); "
                f"if it persists, use {_alt}, not a blind grep."
            )
        if kind == "missing":
            try:
                from lsp_manager import LspManager as _LangMgr

                _lang = _LangMgr.language_for(str(filePath)) or ""
            except Exception:  # noqa: BLE001 - language lookup never fails
                _lang = ""
            if _lang:
                return (
                    f"ERROR {tool} {base}: {exc}. "
                    f"This is the only case where the install hint applies. "
                    f"Do NOT report 'not installed' and stop. "
                    f"Ask the user with confirm_action(action='install language server for {_lang}', "
                    f"reason='needed for {tool} on this file type') and WAIT. "
                    f"If CONFIRMED, retry this same {tool} call shortly (install runs in background); "
                    f"if DENIED, explain what is unavailable and continue without it. "
                    f"Do NOT blind-grep the workspace for the definition."
                )
            return (
                f"ERROR {tool} {base}: {exc}. "
                f"This is the only case where the install hint applies; "
                f"global installs need one-time confirmation "
                f"(pre-approve with CODIFA_LSP_INSTALL_CONSENT=1). "
                f"Do NOT blind-grep the workspace for the definition."
            )
        _exc_text = str(exc or "").lower()
        if "starting" in _exc_text or "retry shortly" in _exc_text:
            return (
                f"ERROR {tool} {base}: language server is starting in background ({exc}). "
                f"Retry the same {tool} call shortly; do NOT fall back to a blind workspace grep."
            )
        if "32601" in _exc_text or "unhandled method" in _exc_text or "method not found" in _exc_text:
            return (
                f"ERROR {tool} {base}: pull diagnostics not supported by this server ({exc}). "
                f"Do NOT retry the pull - the pushed batch (possibly empty = clean) is authoritative; "
                f"use {_alt}, never a blind workspace grep."
            )
        if kind == "unavailable":
            return (
                f"ERROR {tool} {base}: {exc}. "
                f"No server covers this language - use grep scoped to the file, "
                f"not a workspace-wide scan."
            )
        return (
            f"ERROR {tool} {base}: {exc}. "
            f"Retry once; if it persists use {_alt}."
        )

    async def write_file_tool(path: str, content: str) -> str:
        """Replace the ENTIRE file at ``path`` with ``content`` (existing content is overwritten). Prefer edit_file to modify an existing file; only use this for brand-new files or an explicit full rewrite — you must supply the complete new content yourself since there is no whole-file read tool."""
        emit({"kind": "tool", "tool": "write_file", "args": {"path": path}})
        # Read the previous contents BEFORE writing so we can render an inline
        # diff of what changed for the Code Writer UI.
        old: str | None = None
        try:
            before = read_file(root, path, permit)
            old = before.get("content")
        except (PathEscapeError, OSError):
            old = None
        # Checkpoint: محتوای قبل از تغییر را snapshot کن تا Undo مطمئن ممکن باشد
        # (best-effort — شکست checkpoint هرگز write اصلی را نمی‌شکند).
        _ckpt_seq: int | None = None
        if old is not None and old != content and _chat_id:
            _ckpt_seq = _checkpoints.save_pre_edit(
                _chat_id, root, path, old, _ckpt_open
            )
        try:
            result = write_file(root, path, content, permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("write_file", msg))
            return f"ERROR writing {path}: {msg}"
        if "error" in result:
            emit(_error_result("write_file", result["error"]))
            return f"ERROR writing {path}: {result['error']}"
        if (old or "") != content:
            # فایل جدید (old=None) هم دیف می‌خواهد تا در DiffView/Review
            # به‌صورت full-add نشان داده شود، نه فقط بازنویسی فایل‌های موجود.
            diff = "".join(
                difflib.unified_diff(
                    (old or "").splitlines(keepends=True),
                    content.splitlines(keepends=True),
                    fromfile=path,
                    tofile=path,
                )
            )
            adds = sum(
                1
                for l in diff.splitlines()
                if l.startswith("+") and not l.startswith("+++")
            )
            dels = sum(
                1
                for l in diff.splitlines()
                if l.startswith("-") and not l.startswith("---")
            )
            emit(
                {
                    "kind": "diff",
                    "tool": "write_file",
                    "path": path,
                    "diff": diff,
                    "summary": f"{len(content)} chars · +{adds}/-{dels}",
                    "checkpoint": _ckpt_seq,
                }
            )
        emit(
            {
                "kind": "tool_result",
                "tool": "write_file",
                "summary": f"{len(content)} chars",
            }
        )
        # Invalidate any cached read_tool result for this path so a re-read
        # reflects the new content instead of returning stale cached bytes.
        _invalidate_read_cache_for(path, root)
        try:
            from lsp_manager import get_manager as _get_lsp_mgr_sync
            _sync_path = path if os.path.isabs(path) else os.path.join(root, path)
            _get_lsp_mgr_sync(root).notify_change(_sync_path)
        except Exception:  # noqa: BLE001, S110 - lsp sync never breaks edit
            pass
        verify_note = await asyncio.to_thread(verify_edit, root, path, permit)
        return (
            f"Successfully wrote {len(content)} characters to {path}."
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    async def update_plan(items: list[dict]) -> str:
        """Set/update your step-by-step live checklist for the CURRENT multi-step task. For trivial single-step changes skip it. Call with the full list (status='pending'), then re-call with the SAME list marking finished 'completed' and current 'in_progress'. Item: 'content' (short imperative phrase) + 'status' ('pending'|'in_progress'|'completed'). Write items in the SAME language the user is writing in. If a checklist already exists (from history or a previous update_plan), EDIT it: resend the SAME items with updated statuses, adding/removing only what the new message changed — never start a fresh duplicate list. NEVER revert a 'completed' step back to pending/in_progress. Display-only for the user panel — your own memory of done work is the tool results already in context, not this list. NEVER send update_plan alone for a tick: only batch it with the next real tool calls in the SAME step (parallel calls), or skip it."""
        emit({"kind": "tool", "tool": "update_plan", "args": {}})
        normalized: list[dict] = []
        for it in items or []:
            if not isinstance(it, dict):
                continue
            content = str(
                it.get("content", "")
                or it.get("text", "")
                or it.get("title", "")
                or it.get("name", "")
            ).strip()
            status = str(it.get("status", "pending")).strip().lower()
            if status not in ("pending", "in_progress", "completed"):
                status = "pending"
            if content:
                normalized.append(
                    {
                        # Positional id (NOT a content hash): the tool's own contract
                        # requires the model to resend the SAME full list on every
                        # call, so the item at index i IS step i even if its wording
                        # was reworded slightly between calls. A content-hash id
                        # changes the moment the text drifts even one character,
                        # which made the frontend's id-based merge treat the reworded
                        # step as a brand-new item and append a duplicate alongside
                        # the stale one — the 'multiple tasks flash together' bug.
                        "id": f"step-{len(normalized)}",
                        "content": content[:200],
                        "status": status,
                    }
                )
        if not normalized:
            emit(_error_result("update_plan", "empty plan"))
            return (
                "ERROR: plan must contain at least one item with non-empty 'content'."
            )
        # Enforce the single-active-step invariant. The model sometimes marks more
        # than one item 'in_progress' in the same call (e.g. forgets to flip the
        # previous step to 'completed' when starting the next one) — the frontend
        # then rendered several checklist items pulsing at once ('multiple tasks
        # blink together'). Only the LAST in_progress item (by list order — the
        # step actually being worked on now) stays in_progress; any earlier one is
        # treated as already finished and normalized to 'completed'.
        in_progress_idx = [
            i for i, it in enumerate(normalized) if it["status"] == "in_progress"
        ]
        for i in in_progress_idx[:-1]:
            normalized[i]["status"] = "completed"
        # No-progress repeat guard: re-sending the checklist with zero status
        # movement after real tool work ran means the todos panel is stuck
        # (the repeat-0/N pattern). Computed BEFORE the merge overwrites the
        # store; the note goes into the result string the model reads at once.
        _repeat_without_progress = False
        if _chat_id:
            _prev_plan = _PLAN_BY_CHAT.get(_chat_id, [])
            if (
                _prev_plan
                and len(_prev_plan) == len(normalized)
                and not all(
                    i.get("status") == "completed" for i in normalized
                )
                and all(
                    (a.get("status") if isinstance(a, dict) else None)
                    == (b.get("status") if isinstance(b, dict) else None)
                    for a, b in zip(_prev_plan, normalized)
                )
                and _PLAN_MUTATING_SINCE_UPDATE.get(_chat_id, 0) > 0
            ):
                _repeat_without_progress = True
        # Merge with the stored open plan so a mid-run steer EDITS instead of
        # replacing, and completed steps are never reverted (todo-redo fix).
        # Match by normalized content (not positional id): the model rewords
        # slightly between calls, but the same step keeps its status.
        if _chat_id:
            _stored = _PLAN_BY_CHAT.get(_chat_id, [])
            if _stored and not all(s.get("status") == "completed" for s in _stored):
                def _norm_key(s: str) -> str:
                    return " ".join(str(s or "").strip().lower().split())[:200]

                _stored_by_key = {_norm_key(s.get("content")): s for s in _stored if isinstance(s, dict)}
                for it in normalized:
                    _prev = _stored_by_key.get(_norm_key(it.get("content")))
                    if _prev is None and len(normalized) == len(_stored):
                        # Same length, likely same step reworded: match by index.
                        try:
                            _idx = int(str(it.get("id", "")).split("-")[-1])
                            if 0 <= _idx < len(_stored):
                                _prev = _stored[_idx]
                        except Exception:  # noqa: BLE001 — index parse is best-effort
                            _prev = None
                    if _prev is not None and _prev.get("status") == "completed" and it.get("status") != "completed":
                        it["status"] = "completed"
                _PLAN_BY_CHAT[_chat_id] = [dict(it) for it in normalized]
            else:
                _PLAN_BY_CHAT[_chat_id] = [dict(it) for it in normalized]
            try:
                _ws = _state_db.workspace_slug_for_root(root)
                if all(it.get("status") == "completed" for it in normalized):
                    # Finished lists need no restart memory; keep the disk clean.
                    _state_db.delete_checklist(_ws, _chat_id)
                else:
                    _state_db.save_checklist(_ws, _chat_id, normalized)
            except Exception:  # noqa: BLE001, S110 — persistence never breaks tools
                pass
            if all(it.get("status") == "completed" for it in normalized):
                # Turn continuity: keep the completed checklist as evidence so
                # the next turn can report from it instead of re-executing.
                # (_plan_reuse_note already returns "" for all-completed lists,
                # so keeping it never triggers a re-run.)
                _PLAN_MUTATING_SINCE_UPDATE.pop(_chat_id, None)
                try:
                    import trace_store as _ts

                    if _chat_id:
                        _done = sum(1 for i in normalized if i.get("status") == "completed")
                        _ts.record_turn_outcome(
                            _chat_id,
                            "completed",
                            evidence=f"plan {_done}/{len(normalized)} done",
                            mode="",
                        )
                except Exception:  # noqa: BLE001, S110 — outcome must never break tools
                    pass
        # Feed the plan-nudge backstop (see _format_plan_nudge_suffix): reset the
        # since-last-update counter now that the plan was just touched, and record
        # whether a step is still open so mutating tools know whether to nudge.
        _plan_nudge_state["since_update"] = 0
        if _chat_id:
            _PLAN_MUTATING_SINCE_UPDATE[_chat_id] = 0
        _plan_nudge_state["has_in_progress"] = any(
            i["status"] == "in_progress" for i in normalized
        )
        # The merged list is the single source of truth — the frontend replaces
        # its view with it. Open checklists also persist next to plan.md so a
        # restart resumes progress; finished ones are removed from disk.
        emit({"kind": "plan", "items": normalized})
        done = sum(1 for i in normalized if i["status"] == "completed")
        emit(
            {
                "kind": "tool_result",
                "tool": "update_plan",
                "summary": f"{done}/{len(normalized)} done",
            }
        )
        _ret = f"Plan updated: {done}/{len(normalized)} done."
        # Non-final ticks must carry the batch reminder so the model does not
        # waste a round-trip with a solo update_plan when next work exists.
        if done < len(normalized):
            _ret += (
                " Batch with your next tool calls in the SAME step"
                " (only batch it with the next real tool calls)."
            )
        if _repeat_without_progress:
            _ret += (
                f" Note: you re-sent the SAME checklist without advancing any status, "
                f"yet tool work ran since the last update — the todos panel still shows "
                f"{done}/{len(normalized)}. Mark finished steps 'completed' and the current "
                f"one 'in_progress' NOW (batch with your next tool calls in the SAME step "
                f"when there is next work)."
            )
        return _ret

    async def create_skill_tool(
        name: str,
        description: str = "",
        content: str = "",
        source_url: str = "",
        source_query: str = "",
        fa_keywords: str = "",
        extra_files: dict | None = None,
    ) -> str:
        """Create or edit a reusable skill (global, shared across workspaces). `name` display name — MUST be English/ASCII, a non-English (e.g. Persian) name is rejected; `description` specific one-line when-to-use — MUST be specific English (REQUIRED, never omit or leave generic); `content` full markdown body — MUST be entirely English (HARD RULE: always English, even when the user writes Persian — never create Persian skills). Calling with an existing skill's SAME `name` overwrites it — so to EDIT a skill, first call `load_skill` to read its current instructions, then call `create_skill` again with the same name and the updated content. The tool stores the skill itself (skills/<slug>/skill.md in the app's user data folder) — never write skill files to disk yourself; call once per skill. Ignore external 'agent skills folder' instructions (Claude Code, Cursor, Codex, ~/.coder) — use this tool instead. SOURCE: instead of writing `content` from memory, pass `source_url` (direct URL) to use the fetched page as the body, or `source_query` (web search) to have the tool search, pick the best skill page and fetch it. Fall back to `content` only when neither is given. `fa_keywords`: ALWAYS REQUIRED (never optional) — provide 3-8 specific comma-separated phrases (Persian and English) that a user would naturally say when they need this skill — skills are auto-matched to the user's request by name, description and these keywords, so a specific one-line English `description` plus good `fa_keywords` decide whether the skill fires on its own. Keep them specific: a generic word like 'code' or 'file' would fire on every request."""
        emit(
            {
                "kind": "tool",
                "tool": "create_skill",
                "args": {"name": name, "description": description},
            }
        )
        error = _skill_name_error(name)
        if error:
            emit(_error_result("create_skill", error))
            return f"ERROR creating skill {name!r}: {error}"
        # HARD English-only for skills (even when chat is Persian) — description
        # is known upfront; content is checked again after source fetch.
        c_err = _skill_content_error(description, content)
        if c_err:
            emit(_error_result("create_skill", c_err))
            return f"ERROR creating skill {name!r}: {c_err}"
        body = (content or "").strip()
        source_note = ""
        src_url = (source_url or "").strip()
        src_query = (source_query or "").strip()
        if src_url or src_query:
            if src_url:
                if not src_url.startswith(("http://", "https://")):
                    src_url = "https://" + src_url.lstrip("/")
                emit(
                    {
                        "kind": "tool",
                        "tool": "create_skill",
                        "args": {"source_fetch": src_url},
                    }
                )
                fetched = await asyncio.to_thread(
                    fetch_url, src_url, FETCH_EXCERPT_CHARS
                )
            else:
                emit(
                    {
                        "kind": "tool",
                        "tool": "create_skill",
                        "args": {"source_search": src_query},
                    }
                )
                search = await asyncio.to_thread(
                    web_search, src_query, MAX_WEB_SEARCH_RESULTS
                )
                if "error" in search:
                    msg = f"web search failed: {search['error']}"
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "create_skill",
                            "summary": msg,
                            "status": "error",
                        }
                    )
                    return f"ERROR creating skill {name!r}: {msg}"
                results = search.get("results", [])
                if not results:
                    msg = f"web search for {src_query!r} returned no results"
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "create_skill",
                            "summary": msg,
                            "status": "error",
                        }
                    )
                    return f"ERROR creating skill {name!r}: {msg}"
                # Prefer a result that looks like an actual skill/markdown source
                # (github / raw / SKILL.md / .md) over generic pages; otherwise
                # fall back to the first result.
                picked = results[0]
                for r in results:
                    u = (r.get("url") or "").lower()
                    if (
                        "github.com" in u
                        or "raw.githubusercontent" in u
                        or "skill" in u
                        or u.rstrip("/").endswith(".md")
                    ):
                        picked = r
                        break
                src_url = picked.get("url", "")
                emit(
                    {
                        "kind": "tool",
                        "tool": "create_skill",
                        "args": {"source_fetch": src_url},
                    }
                )
                fetched = await asyncio.to_thread(
                    fetch_url, src_url, FETCH_EXCERPT_CHARS
                )
            if "error" in fetched:
                msg = f"could not fetch source {src_url!r}: {fetched['error']}"
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "create_skill",
                        "summary": msg,
                        "status": "error",
                    }
                )
                return f"ERROR creating skill {name!r}: {msg}"
            real = (fetched.get("content") or "").strip()
            if len(real) < 50:
                msg = f"source {src_url!r} contained almost no readable text"
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "create_skill",
                        "summary": msg,
                        "status": "error",
                    }
                )
                return f"ERROR creating skill {name!r}: {msg}"
            body = real
            source_note = (
                f"built from real content fetched from {src_url} ({len(body)} chars)"
            )
            if not (description or "").strip():
                # Derive a one-line description from the fetched file so the
                # skill stays searchable even when the model omits it.
                _desc = ""
                _fm = re.match(r"^---\n([\s\S]*?)\n---\n?", body)
                if _fm:
                    _d = re.search(r"^description:\s*(.+)$", _fm.group(1), re.MULTILINE)
                    if _d:
                        _desc = _d.group(1).strip()
                if not _desc:
                    _first_line = next(
                        (
                            l.strip()
                            for l in body.splitlines()
                            if l.strip() and not l.lstrip().startswith("#")
                        ),
                        "",
                    )
                    _title = next(
                        (
                            l.lstrip("#").strip()
                            for l in body.splitlines()
                            if l.lstrip().startswith("#")
                        ),
                        "",
                    )
                    _desc = _first_line or _title or f"Skill about {name}."
                description = _desc[:300]
        if not body:
            body = f"Write step-by-step instructions for {name}."
        # Final HARD English check — covers fetched source bodies too.
        c_err = _skill_content_error(description, body)
        if c_err:
            emit(_error_result("create_skill", c_err))
            return f"ERROR creating skill {name!r}: {c_err}"
        if isinstance(fa_keywords, str):
            _fa_list = [k.strip() for k in (fa_keywords or "").split(",") if k.strip()]
        else:
            _fa_list = [
                str(k or "").strip() for k in (fa_keywords or []) if str(k or "").strip()
            ]
        try:
            result = create_skill(root, name, description, body, _fa_list or None, extra_files=extra_files)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("create_skill", msg))
            return f"ERROR creating skill {name!r}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit(_error_result("create_skill", msg))
            return f"ERROR creating skill {name!r}: {msg}"
        summary = f"saved skill {name!r}"
        emit(
            {
                "kind": "tool_result",
                "tool": "create_skill",
                "summary": summary,
            }
        )
        note = result.get("note", "")
        extra = f" {source_note}." if source_note else "."
        return (
            f"Skill {name!r} saved. {note}{extra} It will be offered on future runs. "
            "Tell the user the skill was created."
        )

    async def load_skill_tool(name: str, file: str = "") -> str:
        """Load the full body of a skill from the app's skill store by its display name (case-insensitive). Call this ONLY when the task clearly needs a skill listed in the AVAILABLE SKILLS catalog in your prompt, or when the user asks to follow/apply a skill — including short or non-English requests: judge by the task's meaning, not its wording. A single shared word is NOT enough (e.g. LSP / Language Server does NOT match learning a programming language); when in doubt, load none. Load EVERY skill the task needs (one call each) and follow their instructions; when nothing matches, load none. Pass `file` with one of the skill's listed extra file names to load that file instead of skill.md (use the "Extra files" list in the prompt; load a specific file only when needed). Returns the skill's complete instructions; follow them for this task. If the name matches nothing, returns an error listing the available skill names."""
        emit({"kind": "tool", "tool": "load_skill", "args": {"name": name}})
        wanted = (name or "").strip().casefold()
        skills: list[dict] = []
        try:
            skills = _agents_load_skills_for_tool()
        except Exception:  # noqa: BLE001
            skills = []
        match = _resolve_skill_match(skills, wanted)
        if match is None:
            available = ", ".join(s["name"] for s in skills) or "(none)"
            suggestion = ""
            try:
                import difflib as _difflib

                close = _difflib.get_close_matches(
                    (name or "").strip(),
                    [(s.get("name") or "") for s in skills],
                    n=3,
                    cutoff=0.5,
                )
                if close:
                    suggestion = f" Did you mean: {', '.join(close)}?"
            except Exception:  # noqa: BLE001 — suggestions are best-effort
                suggestion = ""
            summary = f"skill {name!r} not found"
            emit(
                {
                    "kind": "tool_result",
                    "tool": "load_skill",
                    "summary": summary,
                    "status": "error",
                }
            )
            return f"ERROR: skill {name!r} not found.{suggestion} Available skills: {available}"
        desc = (match.get("description") or "").strip()
        body = (match.get("content") or "").strip()
        fa = [str(k or "").strip() for k in (match.get("fa_keywords") or []) if str(k or "").strip()]
        wanted_file = (file or "").strip()
        if wanted_file:
            try:
                extra = _state_db.read_skill_extra_file(match.get("name") or name, wanted_file)
            except Exception:  # noqa: BLE001
                extra = None
            if extra is None:
                try:
                    available_files = _state_db.list_skill_files(match.get("name") or name)
                except Exception:  # noqa: BLE001
                    available_files = []
                summary = f"file {wanted_file!r} not found in skill {match['name']!r}"
                emit({"kind": "tool_result", "tool": "load_skill", "summary": summary, "status": "error"})
                listing = ", ".join(available_files) or "(none)"
                return f"ERROR: file {wanted_file!r} not found in skill {match['name']!r}. Extra files: {listing}"
            summary = f"loaded skill {match['name']!r} file {wanted_file!r}"
            emit({"kind": "tool_result", "tool": "load_skill", "summary": summary})
            return f"===== SKILL: {match['name']} / {wanted_file} =====\n\n{extra.strip()}\n===== END SKILL: {match['name']} / {wanted_file} ====="
        summary = f"loaded skill {match['name']!r}"
        emit(
            {
                "kind": "tool_result",
                "tool": "load_skill",
                "summary": summary,
            }
        )
        out = f"===== SKILL: {match['name']} =====\n"
        if desc:
            out += f"Description: {desc}\n"
        if fa:
            out += f"Persian match keywords (resend as fa_keywords when editing): {', '.join(fa)}\n"
        try:
            _extra = _state_db.list_skill_files(match.get("name") or name) or _state_db.list_skill_files(match.get("slug") or "")
        except Exception:  # noqa: BLE001
            _extra = []
        if _extra:
            out += f"Extra files: {', '.join(_extra)} — call load_skill with file=<name> for a specific file only when needed.\n"
        out += f"\n{body}\n===== END SKILL: {match['name']} ====="
        return out

    async def create_mcp_tool(
        name: str,
        command: str = "",
        cmd_args: list[str] | None = None,
        url: str = "",
        env: dict[str, str] | None = None,
    ) -> str:
        """Add or update an MCP tool connector (global). `name` = connector id shown in Settings → MCP. Local server: `command` (e.g. "npx") + optional `cmd_args` (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]) + `env` (supports ${VAR}). Remote: `url` instead (verified as a real MCP endpoint). Takes effect next message. The tool stores the connector itself (mcp/<name>.json in the app's user data folder) — never write mcp.json/config files yourself; call once per connector."""
        emit({"kind": "tool", "tool": "create_mcp", "args": {"name": name}})
        cfg: dict = {}
        if url:
            cfg["url"] = url
        else:
            cfg["command"] = command
            if cmd_args:
                cfg["args"] = cmd_args
        if env:
            cfg["env"] = env
        if url:
            check = await asyncio.to_thread(_validate_mcp_url, url)
            if not check.get("ok"):
                msg = check.get("error", "endpoint validation failed")
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "create_mcp",
                        "summary": msg,
                    }
                )
                return (
                    f"ERROR: {msg}. The connector was NOT saved. Ask the user for "
                    "the correct MCP server URL, or for a local server provide the "
                    "`command` to run instead."
                )
            if check.get("auth_required"):
                auth_note = (
                    " NOTE: the server requires authentication (HTTP 401/403) — the "
                    "user may need to add an API key/header in Settings → MCP."
                )
            else:
                auth_note = ""
        else:
            auth_note = ""
        try:
            result = upsert_mcp_server(root, name, cfg)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("create_mcp", msg))
            return f"ERROR creating MCP connector {name!r}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit(_error_result("create_mcp", msg))
            return f"ERROR creating MCP connector {name!r}: {msg}"
        emit(
            {
                "kind": "tool_result",
                "tool": "create_mcp",
                "summary": f"updated {name} in the app's user data folder",
            }
        )
        return (
            f"MCP connector {name!r} saved to the app's user data folder "
            "(user-level, shared across all workspaces). It will be loaded on "
            "the next message. Tell the user it was added and what tools it exposes."
            f"{auth_note}"
        )

    async def edit_file_tool(
        path: str = "",
        old_string: str = "",
        new_string: str = "",
        replace_all: bool = False,
        edits: list[dict] | None = None,
        filePath: str = "",
        file_path: str = "",
    ) -> str:
        """Replace an exact piece of text in an existing file with new text. `old_string` must match the file's current content exactly (including whitespace/indentation) and, by default, must be unique in the file — include enough surrounding lines to make it unique. Prefer this over write_file for any change to an existing file; only use write_file for brand-new files or a full intentional rewrite. Decorations copied from read/grep output (`2096 | ` line prefixes, trailing spaces, wrapper notes) are stripped automatically when they block the match — copying clean text still works best.

        BATCH: to apply several changes to the SAME file, pass `edits` (a list of {"old_string","new_string","replace_all"} objects) instead of firing one edit_file call per change — all edits apply atomically in list order with ONE checkpoint/diff/verify. Either every edit applies or nothing is written. The call-level `replace_all` is the default for every edit that does not set its own flag, so replace_all=true + edits=[...] replaces ALL occurrences of each old_string (no 'not unique' error)."""
        # Normalize path aliases and validate early with a friendly error
        # instead of a schema validation failure with no guidance.
        if not path:
            path = filePath or file_path or ""
        if not str(path or "").strip():
            msg = "missing required 'path' argument (e.g. path='src/x.ts')"
            emit(_error_result("edit_file", msg))
            return f"ERROR editing: {msg}"
        emit(
            {
                "kind": "tool",
                "tool": "edit_file",
                "args": {"path": path, "replace_all": replace_all},
            }
        )
        try:
            if edits:
                result = edit_file_batch(root, path, edits, permit, replace_all=replace_all)
            else:
                result = edit_file(root, path, old_string, new_string, replace_all, permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("edit_file", msg))
            return f"ERROR editing {path}: {msg}"
        if "error" in result:
            emit(_error_result("edit_file", result["error"]))
            return f"ERROR editing {path}: {result['error']}"
        old = result["old_content"]
        content = result["new_content"]
        # Checkpoint: محتوای قبل از edit را snapshot کن (best-effort).
        _ckpt_seq: int | None = None
        if old != content and _chat_id:
            _ckpt_seq = _checkpoints.save_pre_edit(
                _chat_id, root, path, old, _ckpt_open
            )
        diff = "".join(
            difflib.unified_diff(
                old.splitlines(keepends=True),
                content.splitlines(keepends=True),
                fromfile=path,
                tofile=path,
            )
        )
        adds = sum(
            1
            for l in diff.splitlines()
            if l.startswith("+") and not l.startswith("+++")
        )
        dels = sum(
            1
            for l in diff.splitlines()
            if l.startswith("-") and not l.startswith("---")
        )
        emit(
            {
                "kind": "diff",
                "tool": "edit_file",
                "path": path,
                "diff": diff,
                "summary": f"+{adds}/-{dels}",
                "checkpoint": _ckpt_seq,
            }
        )
        occ = result.get("occurrences", 1)
        emit(
            {"kind": "tool_result", "tool": "edit_file", "summary": f"+{adds}/-{dels}"}
        )
        # Invalidate any cached read_tool result for this path so a re-read
        # reflects the new content instead of returning stale cached bytes.
        _invalidate_read_cache_for(path, root)
        try:
            from lsp_manager import get_manager as _get_lsp_mgr_sync
            _sync_path = path if os.path.isabs(path) else os.path.join(root, path)
            _get_lsp_mgr_sync(root).notify_change(_sync_path)
        except Exception:  # noqa: BLE001, S110 - lsp sync never breaks edit
            pass
        verify_note = await asyncio.to_thread(verify_edit, root, path, permit)
        _n_edits = int(result.get("edits_applied", 0) or 0)
        _head = (
            f"Successfully edited {path} ({_n_edits} edits, {occ} replacement{'s' if occ != 1 else ''} total)."
            if _n_edits > 1
            else f"Successfully edited {path} ({occ} occurrence{'s' if occ != 1 else ''} replaced)."
        )
        return (
            _head
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    def _coerce_str_list(value: list[str] | str | None) -> list[str]:
        """Normalize a batch list arg that may arrive as a JSON-encoded string.

        The model sometimes sends e.g. patterns='["a", "b"]' (a string)
        instead of patterns=["a", "b"]. Iterating that string would silently
        split it into characters and search garbage — so a JSON-array string
        is parsed, any other string becomes a single item, and real lists
        pass through unchanged.
        """
        if value is None:
            return []
        if isinstance(value, (list, tuple)):
            return list(value)
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                try:
                    parsed = json.loads(text)
                except ValueError:
                    parsed = None
                if isinstance(parsed, list):
                    return [str(x) for x in parsed]
            return [value] if text else []
        return [value]

    def _dedup_patterns(primary: str, extra: list[str] | str | None) -> list[str]:
        """«pattern» + «patterns» را به یک لیست مرتب و بدون تکرار تبدیل می‌کند.

        ورودی‌های خالی حذف می‌شوند؛ اگر همه خالی بودند خودِ primary
        برمی‌گردد تا رفتار تک‌الگوی فعلی دست‌نخورده بماند.
        """
        seen: set[str] = set()
        out: list[str] = []
        for p in (primary, *_coerce_str_list(extra)):
            if p and p not in seen:
                seen.add(p)
                out.append(p)
        return out or [primary]

    def _dedup_scopes(primary: str, extra: list[str] | str | None) -> list[str]:
        """«path» + «paths» را به لیست scope های یکتا تبدیل می‌کند.

        «» یعنی کل workspace؛ اگر کنار scope های مشخص بیاید حذف می‌شود
        (کل workspace بقیه را در بر می‌گیرد). خروجی هیچ‌وقت خالی نیست.
        """
        seen: set[str] = set()
        out: list[str] = []
        for p in (str(primary or "").strip(), *(str(x or "").strip() for x in _coerce_str_list(extra))):
            if p and p not in seen:
                seen.add(p)
                out.append(p)
        return out or [""]

    async def grep_tool(
        pattern: str = "",
        patterns: list[str] | None = None,
        path: str = "",
        paths: list[str] | None = None,
        include: str = "",
        includes: list[str] | None = None,
        max_results: int = 50,
    ) -> str:
        """Search file CONTENTS using a regular expression. `pattern` is a REGEX (matched case-insensitively, per line), so combine alternatives with `foo|bar` (full syntax like `function\\s+\\w+` works). BATCH: pass every extra alternative via `patterns` (a list) so they all run in the SAME call — e.g. pattern='foo', patterns=['bar','baz'] is ONE grep for 'foo|bar|baz' — NEVER fire one grep per term; `pattern` may be omitted when `patterns` is non-empty. `path` optionally restricts to a subdirectory (omit = whole workspace); pass `paths` (a list of extra subdirectories) to scan SEVERAL scopes in the SAME call — e.g. path='src', paths=['backend','tools'] — NEVER fire one grep per scope. `include` optionally filters files by glob, e.g. `*.ts` or `*.{ts,tsx}`; pass `includes` (a list of extra file filters) to scan SEVERAL filters in the SAME call — e.g. include='*.ts', includes=['*.py'] — NEVER fire one grep per file filter. `max_results` caps how many matches are returned (default 50). Respects .gitignore; skips hidden/binary files. You have full workspace access; prefer targeted lookups with path/include. Order is LSP first, else ONE targeted grep, then symbols read. If you know a filename fragment or extension, use glob first, never grep for filenames. Filename-fragment search must use glob first, never grep for filenames; an UNSCOPED pattern with >3 top-level alternatives is REFUSED — scope it with path/include or split into targeted greps instead (pipes inside (...) groups count as ONE alternative). If you know a function/class/method NAME, do NOT grep — use lsp_symbols or read(symbols=[...]) instead.

Returns each match with ±3 lines of surrounding code (the matching line marked with `>`), so you usually do NOT need a follow-up `read` just to see context. When the hit list is small (6 or fewer shown) the full enclosing definition body (up to 60 lines, via LSP) is inlined instead of the snippet — do NOT follow up with `read` for those; the body is already above. Only read when you need more than the shown body or need to edit the file. If you know a function/class/method NAME, do NOT grep for it — use lsp_symbols(filePath) or read(filePath, symbols=[...]) instead (or read(symbols=[...]) without filePath for a project-wide lookup). Output is capped by `max_results` and the context budget; if there are more matches a truncation note tells you to read the shown files instead of re-grepping. Use this tool (NOT shell `grep`/`rg`) to find files containing specific patterns — see the SEARCH STRATEGY rule for targeted-vs-broad guidance. For an open-ended search that may require multiple rounds of grepping, batch them into ONE call via patterns/paths/includes instead of firing one call per term."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        # Batch args sometimes arrive as JSON-encoded strings — coerce first
        # so nothing downstream iterates a string character-by-character.
        patterns = _coerce_str_list(patterns)
        paths = _coerce_str_list(paths)
        includes = _coerce_str_list(includes)
        # همه‌ی الگوها در یک regex ترکیبی → یک اسکن دیسک، یک ToolMessage.
        combined = "|".join(_dedup_patterns(pattern, patterns))
        if not str(combined or "").strip():
            # Batch-only calls omit `pattern`; with nothing to search for,
            # fail friendly — a TypeError here burns a full retry step
            # (~22K tokens in a live trace).
            msg = "empty pattern: pass pattern='...' or patterns=[...]"
            emit(_error_result("grep", msg))
            return f"ERROR searching: {msg}"
        # Search enforcement: an UNSCOPED >3-alternative OR spray scans the
        # whole workspace and dumps a match list the model then re-greps
        # instead of converging (live trace: 9-alternative greps returning
        # 176/148-match dumps step after step). Refuse it — the refusal IS
        # the guidance and costs one cheap step instead of a broad scan.
        # A SCOPED broad grep (path/include present) still runs with a warn:
        # the scope already targets it.
        _alt_count = _count_grep_alternatives(combined)
        if _alt_count > _MAX_GREP_ALTERNATIVES:
            _scope_given = any(
                str(_s or "").strip()
                for _s in (path, include, *(paths or []), *(includes or []))
            )
            if not _scope_given:
                msg = (
                    f"broad pattern refused: {combined!r} has {_alt_count} "
                    f"top-level alternatives (max {_MAX_GREP_ALTERNATIVES}) and "
                    "no path/include scope. Target it: pass path='subdir' and/or "
                    "include='*.ext' (batched patterns are fine once scoped), or "
                    "narrow to <=3 alternatives of ONE concept. For a known "
                    "function/class name use lsp_symbols or read(symbols=[...]) "
                    "instead; for a filename use glob."
                )
                emit(_error_result("grep", msg))
                return f"ERROR searching: {msg}"
            _id_like = all(
                re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(alt))
                for alt in combined.split("|")
            )
            _hint = (
                f"Identifier grep ({_alt_count} names): lsp_symbols(filePath='...', query='Name') "
                "or read(symbols=[...]) resolves each name to its definition "
                "with line ranges in ONE call — grep only finds text mentions."
                if _id_like
                else "Prefer LSP/read(symbols=[...]) for names, glob for "
                "filenames, or split into <=3-alternative greps."
            )
            emit(
                {
                    "kind": "warn",
                    "content": (
                        f"Broad grep ({_alt_count} alternatives, scoped). {_hint}"
                    ),
                }
            )
        # Warn-only budget: this tool never hard-blocks grep (Ask/Plan/
        # subagents must not be blocked). Coder discipline is enforced by
        # the per-turn gate in graph.py (_search_gate_text). Sub-agent
        # searches do not consume the parent budget.
        if not _SUB_AGENT_CTX.get():
            _budget_count = _sync_search_budget(root, _chat_id)
            if _budget_count >= _MAX_SEARCH_BATCHES_WITHOUT_EDIT:
                emit({"kind": "warn", "content": _search_budget_message(_budget_count)})
            _note_search_batch(root, _chat_id)
        # Symbol-first fast path: plain identifier -> workspace/symbol first
        # so a simple name lookup merges grep+LSP into one call.
        _sym_generation = _search_generations.get(root, 0)
        try:
            _single = _dedup_patterns(pattern, patterns)
            _is_simple_name = (
                len(_single) == 1
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{1,64}", _single[0] or "") is not None
            )
        except Exception:  # noqa: BLE001 - pattern check never fails
            _single = []
            _is_simple_name = False
        if _is_simple_name:
            try:
                from lsp_manager import get_manager as _get_lsp_mgr_symfirst

                _sym_mgr = _get_lsp_mgr_symfirst(root)
                _sym_hits = await asyncio.to_thread(_sym_mgr.find_symbols, _single)
                _sym_list = _sym_hits.get(_single[0], []) if isinstance(_sym_hits, dict) else []
                if _sym_list and len(_sym_list) <= _DEF_BODY_MAX_COUNT:
                    _sym_lines: list[str] = []
                    _sym_total = 0
                    for _sp, _sl, _sk, _rn in _sym_list[:_DEF_BODY_MAX_COUNT]:
                        try:
                            _s_abs = os.path.join(root, str(_sp))
                            _s_syms = await asyncio.to_thread(_sym_mgr.document_symbols_if_running, _s_abs)
                        except Exception:  # noqa: BLE001, S112 - one bad file never breaks grep
                            continue
                        if not _s_syms:
                            continue
                        _best = None
                        for _nm, (_ss, _se, _kk) in _s_syms.items():
                            try:
                                _ssi, _sei = int(_ss), int(_se)
                            except (TypeError, ValueError):
                                continue
                            if _ssi <= int(_sl or 0) <= _sei and (
                                _best is None or (_sei - _ssi) < (_best[2] - _best[1])
                            ):
                                _best = (_nm, _ssi, _sei)
                        if _best is None:
                            continue
                        _bn, _bs, _be = _best
                        try:
                            _ex = await asyncio.to_thread(
                                _read_lines_excerpt, _s_abs, _bs,
                                min(_be - _bs + 1, _DEF_BODY_MAX_LINES),
                            )
                        except Exception:  # noqa: BLE001, S112 - read never breaks grep
                            continue
                        if _ex.get("error") or not _ex.get("lines"):
                            continue
                        _body = "\n".join(f"{_r['line']} | {_r['text']}" for _r in _ex["lines"])
                        if _sym_total + len(_body) + 2 > tool_out_chars:
                            break
                        _sym_total += len(_body) + 2
                        _sym_lines.append(f"{_sp}:{_sl} in {_bn} ({_sk})\n{_body}")
                    if _sym_lines:
                        _sym_raw = f"SYMBOL MATCHES for {_single[0]!r}\n" + "\n\n".join(_sym_lines)
                        emit(
                            {
                                "kind": "tool_result",
                                "tool": "grep",
                                "summary": f"{len(_sym_lines)} symbol match(es)",
                                "model": _main_name,
                            }
                        )
                        _sym_cache_key = ("grep-sym", _single[0], root, str(tool_out_chars))
                        if _search_generations.get(root, 0) == _sym_generation:
                            _parent_search_cache[_sym_cache_key] = _sym_raw
                        return _sym_raw
            except Exception:  # noqa: BLE001, S110 - symbol-first is best-effort
                pass
        # چند scope در همان فراخوانی: path + paths=[...] → یک grep برای همه.
        # Near-duplicate scopes ("backend/" vs "backend") merge into one so
        # they share a single scan and cache entry — same results, less cost.
        _normed_paths: list[str] = []
        for _p in _dedup_patterns(path, paths):
            _np = _normalize_search_scope(_p)
            if _np not in _normed_paths:
                _normed_paths.append(_np)
        # Drop nested scopes ("backend" + "backend/tools.py"): the broader
        # scan already covers the narrower one, so keep one scan per file.
        _deduped_paths: list[str] = []
        for _np in sorted(_normed_paths, key=len):
            _covered = False
            for _kept in _deduped_paths:
                if _np == _kept or _np.startswith(_kept.rstrip("/") + "/"):
                    _covered = True
                    break
            if not _covered:
                _deduped_paths.append(_np)
        all_paths = _deduped_paths
        scope = "|".join(all_paths) if len(all_paths) > 1 else (all_paths[0] if all_paths else "")
        # چند فیلتر فایل در همان فراخوانی: include + includes=[...].
        all_includes = _dedup_patterns(include, includes)
        inc_disp = "|".join(all_includes) if len(all_includes) > 1 else include
        generation = _search_generations.get(root, 0)
        cache_key = ("grep", combined, scope, inc_disp, root, str(max_results), str(tool_out_chars))
        cached = _parent_search_cache.get(cache_key)
        if cached is not None:
            emit(
                {
                    "kind": "tool",
                    "tool": "grep",
                    "args": {"pattern": combined, "path": scope, "include": inc_disp},
                    "model": _main_name,
                }
            )
            emit(
                {
                    "kind": "tool_result",
                    "tool": "grep",
                    "summary": "cached",
                    "model": _main_name,
                }
            )
            return cached

        emit(
            {
                "kind": "tool",
                "tool": "grep",
                "args": {"pattern": combined, "path": scope, "include": inc_disp},
                "model": _main_name,
            }
        )
        try:
            results = await asyncio.gather(
                *(
                    _coalesced_search(
                        root, combined, p, SNIPPET_CONTEXT, inc, permit, generation,
                    )
                    for p in all_paths
                    for inc in all_includes
                )
            )
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("grep", msg))
            return f"ERROR searching {scope}: {msg}"
        except asyncio.CancelledError:
            emit(_error_result("grep", "جست‌وجو لغو شد"))
            raise
        except Exception as exc:
            emit(_error_result("grep", str(exc)))
            raise
        errors = [r["error"] for r in results if r.get("error")]
        if results and len(errors) == len(results):
            # همه‌ی scope ها خطا دادند → مثل حالت تک‌اسکوپی خطا برگردان.
            emit(_error_result("grep", errors[0]))
            return f"ERROR searching {scope}: {errors[0]}"
        # merge + dedupe بر اساس (file, line) — ترتیب حفظ می‌شود.
        seen: set[tuple[str, int]] = set()
        matches: list[dict] = []
        for r in results:
            for m in r.get("matches", []):
                key = (m["file"], m["line"])
                if key not in seen:
                    seen.add(key)
                    matches.append(m)
        if not matches:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "grep",
                    "summary": "no matches",
                    "model": _main_name,
                }
            )
            return f"No matches for {combined!r} under {scope or '/'}"
        # Output contract (spec §3, revised): each hit shows the match line plus
        # surrounding code (already computed by search_in_files above).
        # Adaptive context: full ±3 lines for up to 5 results, ±1 line when
        # more are shown, so a broad search stays within the char budget
        # without forcing a repeat grep. Capped by max_results and the
        # context budget; when truncated by EITHER cap, always note how many
        # matches were hidden so the model never mistakes a cut list for all.
        lines: list[str] = []
        total = 0
        _adaptive = 3 if min(len(matches), max_results) <= 5 else 1
        # Enclosing-symbol labels via a lightweight AST fallback (no LSP
        # import). Only def-line matches get `in Name (L..)` + inlined body;
        # body matches keep the plain snippet so `path:line:` consumers and
        # the plain-form test keep matching.
        def _enclosing_symbol(abs_path: str, line: int):
            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as _fh:
                    _src = _fh.read()
                _tree = ast.parse(_src)
                _best = None
                for _node in ast.walk(_tree):
                    if isinstance(_node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        _s = int(getattr(_node, "lineno", 0) or 0)
                        _e = int(getattr(_node, "end_lineno", _s) or _s)
                        if _s <= int(line or 0) <= _e and (
                            _best is None or (_e - _s) < (_best[2] - _best[1])
                        ):
                            _best = (_node.name, _s, _e)
                return _best
            except Exception:
                return None
        # Pre-initialized so the footers below never hit UnboundLocalError
        # when the annotation branch above is skipped.
        _expanded = 0
        _omitted_n = 0
        _omitted: list[tuple[str, str]] = []
        # Phase 1: pick shown matches and render bodies (budget check on the
        # unsuffixed text; the ~30-char annotation cannot flip it).
        # Diversity cap: when the dump truncates across many files, one noisy
        # file (docs, generated code) eats all slots and buries the signal the
        # model then re-greps for. Cap per-file hits so the first page spans
        # files; skipped hits fold into the hidden count with a pointer.
        # Focused searches (few files) keep full depth — no cap.
        _cap_per_file = False
        if len(matches) > max_results:
            try:
                _cap_per_file = len({str(m.get("file")) for m in matches}) > 5
            except Exception:  # noqa: BLE001 — fall back to uncapped
                _cap_per_file = False
        _file_counts: dict[str, int] = {}
        _capped_files: set[str] = set()
        _shown_ms: list[dict] = []
        _bodies: list[str] = []
        _shown_n = 0
        for m in matches:
            if _shown_n >= max_results:
                break
            if _cap_per_file:
                _fc = _file_counts.get(str(m.get("file")), 0)
                if _fc >= _GREP_PER_FILE_CAP:
                    _capped_files.add(str(m.get("file")))
                    continue
                _file_counts[str(m.get("file"))] = _fc + 1
            ctx_lines = m.get("context_lines") or []
            if _adaptive < SNIPPET_CONTEXT and ctx_lines:
                _match = m.get("line")
                ctx_lines = [
                    cl for cl in ctx_lines
                    if cl.get("line") is not None and abs(int(cl["line"]) - int(_match or 0)) <= _adaptive
                ]
            if ctx_lines:
                body = "\n".join(
                    f"{'>' if cl['line'] == m['line'] else ' '} {cl['line']} | {(cl.get('text') or '')[:SNIPPET_LINE_WIDTH]}"
                    for cl in ctx_lines
                )
            else:
                body = (m.get("text") or "")[:SNIPPET_LINE_WIDTH]
            entry = f"{m['file']}:{m['line']}:\n{body}" if ctx_lines else f"{m['file']}:{m['line']}:{body}"
            # +64 headroom: the phase-2 ` in Name (L..)` suffix (~35 chars)
            # must not push a capped budget over.
            if lines and total + len(entry) + 2 + 64 > tool_out_chars:
                break
            _shown_ms.append(m)
            _bodies.append(body)
            lines.append(entry)
            total += len(entry) + 2
            _shown_n += 1
        # Phase 2: enclosing-symbol annotations off the event loop. The first
        # parse of a file compiles the grammar (~seconds once), later hits
        # are mtime-cached (~ms) — either way never block the tool loop.
        # Kept after the `file:line:` prefix so existing `path:line:`
        # consumers keep matching.
        # Expansion counters: initialized before the annotation branch so
        # the deterministic LSP expansion and the footer below can use
        # them even when annotations are disabled.
        _expanded = 0
        _omitted_n = 0
        _omitted: list[tuple[str, str]] = []
        if _enclosing_symbol is not None and _shown_ms:
            def _annotate_one(mm: dict) -> tuple[str, str | None]:
                try:
                    _abs = os.path.join(root, str(mm["file"]))
                    _hit = _enclosing_symbol(_abs, mm["line"])
                    if _hit is not None and int(_hit[1]) == int(mm["line"]):
                        _suffix = f" in {_hit[0]} (L{_hit[1]}-{_hit[2]})"
                        # The match IS the definition's first line: inline the
                        # body so no follow-up read is needed to see it.
                        _body: str | None = None
                        try:
                            if int(_hit[1]) == int(mm["line"]):
                                _body = _def_body_text(
                                    _abs, int(mm["line"]), int(_hit[1]), int(_hit[2])
                                )
                        except (TypeError, ValueError):
                            _body = None
                        return _suffix, _body
                except Exception:  # noqa: BLE001, S110 — annotation never breaks grep
                    pass
                return "", None

            try:
                _annotated = await asyncio.gather(
                    *(asyncio.to_thread(_annotate_one, mm) for mm in _shown_ms)
                )
            except Exception:  # noqa: BLE001
                _annotated = [("", None)] * len(_shown_ms)
            # Phase 3: stitch suffixes + definition bodies. Bodies replace the
            # ±3-line snippet (they contain it) while the output budget lasts;
            # leftovers keep the snippet + its `in Name (L..)` line pointer.
            # (Expansion counters initialized before the annotation branch.)
            for _i, (_mm, (_suffix, _dbody)) in enumerate(zip(_shown_ms, _annotated)):
                if _suffix:
                    _old = lines[_i]
                    _head, _sep, _rest = _old.partition(":")
                    _ln, _sep2, _body = _rest.partition(":")
                    lines[_i] = f"{_head}:{_ln}:{_suffix}{_sep2}{_body}"
                if _dbody is None:
                    continue
                if (
                    _expanded >= _DEF_BODY_MAX_COUNT
                    or total + len(_dbody) + 2 > tool_out_chars
                ):
                    _omitted_n += 1
                    _on = _suffix.strip().removeprefix("in ")
                    _on = _on.split(" (L")[0].strip()
                    if _on:
                        _omitted.append((str(_mm.get("file")), _on))
                    continue
                _old_body = _bodies[_i]
                if _old_body and lines[_i].endswith(_old_body):
                    lines[_i] = lines[_i][: -len(_old_body)] + _dbody
                else:
                    lines[_i] = lines[_i] + "\n" + _dbody
                total += len(_dbody) + 2 - len(_old_body)
                _expanded += 1
        # Deterministic grep+read: small targeted hit lists carry the full
        # enclosing definition body (via LSP, no extra model call), so no
        # follow-up read is needed. Broad searches keep snippets only.
        if _shown_ms and len(_shown_ms) <= _DEF_BODY_MAX_COUNT:
            try:
                from lsp_manager import get_manager as _get_lsp_mgr_grep
                _lsp_grep = _get_lsp_mgr_grep(root)
            except Exception:  # noqa: BLE001 - expansion is best-effort
                _lsp_grep = None
            if _lsp_grep is not None:
                _g_sym_cache: dict[str, dict] = {}
                for _gi, _gm in enumerate(_shown_ms):
                    if _expanded >= _DEF_BODY_MAX_COUNT:
                        break
                    try:
                        _g_abs = os.path.join(root, str(_gm.get("file")))
                        if _g_abs in _g_sym_cache:
                            _g_syms = _g_sym_cache[_g_abs]
                        else:
                            # Background expansion never starts or installs a server:
                            # reuse an already-running one, else skip the file.
                            _g_syms = await asyncio.to_thread(_lsp_grep.document_symbols_if_running, _g_abs)
                            _g_sym_cache[_g_abs] = _g_syms
                    except Exception:  # noqa: BLE001, S112 - one bad file never breaks grep
                        continue
                    if not _g_syms:
                        continue
                    try:
                        _g_ln = int(_gm.get("line") or 0)
                    except (TypeError, ValueError):
                        continue
                    _g_best = None
                    for _g_nm, (_g_s, _g_e, _g_k) in _g_syms.items():
                        try:
                            _g_si, _g_ei = int(_g_s), int(_g_e)
                        except (TypeError, ValueError):
                            continue
                        if _g_si <= _g_ln <= _g_ei and (
                            _g_best is None or (_g_ei - _g_si) < (_g_best[2] - _g_best[1])
                        ):
                            _g_best = (_g_nm, _g_si, _g_ei)
                    if _g_best is None:
                        continue
                    _g_nm, _g_si, _g_ei = _g_best
                    try:
                        _g_ex = await asyncio.to_thread(
                            _read_lines_excerpt, _g_abs, _g_si,
                            min(_g_ei - _g_si + 1, _DEF_BODY_MAX_LINES),
                        )
                    except Exception:  # noqa: BLE001, S112 - read never breaks grep
                        continue
                    if _g_ex.get("error") or not _g_ex.get("lines"):
                        continue
                    _g_body = "\n".join(f"{_r['line']} | {_r['text']}" for _r in _g_ex["lines"])
                    if total + len(_g_body) + 2 > tool_out_chars:
                        _omitted_n += 1
                        _omitted.append((str(_gm.get("file")), _g_nm))
                        continue
                    _g_old = _bodies[_gi]
                    if _g_old and lines[_gi].endswith(_g_old):
                        lines[_gi] = lines[_gi][: -len(_g_old)] + _g_body
                    else:
                        lines[_gi] = lines[_gi] + "\n" + _g_body
                    if f" in {_g_nm} (L" not in lines[_gi]:
                        _g_head, _g_sep, _g_rest = lines[_gi].partition(":")
                        _g_ln2, _g_sep2, _g_body2 = _g_rest.partition(":")
                        lines[_gi] = f"{_g_head}:{_g_ln2}: in {_g_nm} (L{_g_si}-{_g_ei}){_g_sep2}{_g_body2}"
                    total += len(_g_body) + 2 - len(_g_old)
                    _expanded += 1
        _shown = len(lines)
        _hidden = len(matches) - _shown
        if _hidden > 0:
            note = (
                f"\nFound {len(matches)} matches.\n"
                f"Showing the first {_shown} relevant matches ({_hidden} more not shown).\n"
                "Read the specific files above with read(symbols=[...]/ranges=[...]) in ONE call — do NOT re-grep the same pattern."
            )
        else:
            note = ""
        if _capped_files:
            _capped_list = sorted(_capped_files)[:3]
            _extra = f" (+{len(_capped_files) - 3} more)" if len(_capped_files) > 3 else ""
            note += (
                f"\n(Per-file cap ({_GREP_PER_FILE_CAP}/file) hid more hits in "
                f"{', '.join(_capped_list)}{_extra} — narrow the pattern to see "
                f"more of one file.)"
            )
        if _omitted_n:
            _by_file: dict[str, list[str]] = {}
            for _of, _on in _omitted:
                if _on not in _by_file.setdefault(_of, []):
                    _by_file[_of].append(_on)
            if _by_file:
                _ef, _en = next(iter(_by_file.items()))
                _more_files = len(_by_file) - 1
                _more = (
                    f" (+{_more_files} more file{'s' if _more_files != 1 else ''})"
                    if _more_files else ""
                )
                note += (
                    f"\n({_omitted_n} definition "
                    f"{'body' if _omitted_n == 1 else 'bodies'} omitted — output budget. "
                    f"Read them directly: read(filePath='{_ef}', "
                    f"symbols={_en[:4]!r}){_more}.)"
                )
            else:
                note += (
                    f"\n({_omitted_n} definition "
                    f"{'body' if _omitted_n == 1 else 'bodies'} omitted — output budget. "
                    "The `in Name (L..)` tag above has the exact lines; "
                    "read them or use symbols=[...].)"
                )
        raw = f"MATCHES for {combined!r}\n" + "\n\n".join(lines) + note
        if _search_generations.get(root, 0) == generation:
            _parent_search_cache[cache_key] = raw
        # Fire-and-forget LSP warmup: start servers for matched files in a
        # background daemon thread (no install, no blocking) so follow-up
        # read/symbol calls hit warm servers.
        try:
            from lsp_manager import get_manager as _get_lsp_mgr_warmup

            _warm_mgr = _get_lsp_mgr_warmup(root)
            _warm_paths = [
                os.path.join(root, str(m.get("file")))
                for m in matches[:20]
                if isinstance(m.get("file"), str) and m.get("file")
            ]
            if _warm_paths:
                _warm_mgr.warmup(_warm_paths)
        except Exception:  # noqa: BLE001, S110 - warmup never breaks grep
            pass
        # Send the structured results too (not just the summary) so a reconnect
        # can replay the tool without re-executing it (re-execution wastes
        # context). `items` carries the actual rows the model needs to see.
        ui_items = [
            {"file": m["file"], "line": m["line"], "text": m.get("text", "")}
            for m in matches[:max_results]
        ]
        emit(
            {
                "kind": "tool_result",
                "tool": "grep",
                "summary": f"{len(matches)} matches",
                "results": ui_items,
                "model": _main_name,
            }
        )
        try:
            _note_search_surfaced(
                _chat_id,
                [str(m.get("file") or "") for m in matches[:max_results] if isinstance(m, dict)],
            )
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks grep
            pass
        return raw

    async def terminal_tool(command: str, timeout: int = TERMINAL_TIMEOUT) -> str:
        """Run a shell command in the workspace root and return its output. The command runs with the project folder as the working directory, is killed after `timeout` seconds (default 120), and privileged/system-destructive commands (sudo, rm -rf /, mkfs, reboot, piping into a shell, ...) are blocked. Use this for git, package managers, build/run/lint/test commands and other project operations. NEVER use it to create, edit or delete files — use write_file for brand-new files and edit_file for changes to existing files (sed -i, patch, tee, redirects and python heredocs that write files are NOT acceptable substitutes). Runs on the MAIN model — raw output is returned directly (capped to `terminal_out_chars`) so the agent can read it itself. BATCH: chain independent commands in ONE call with `;` or `&&` (e.g. lint then tests: `ruff check x.py; pytest -q`) — NEVER one call per command, and never re-run a command just to see it with a different `| head`/`| tail`; test/build commands (npm test, pytest, vitest, tsc, ...) already get the maximum timeout by default. LONG-LIVED SERVERS (any stack): prefix the project's own start command (found in its manifest, never assumed) with `bg:` (e.g. `bg: <project launch command>`) — it starts detached and returns immediately with a job_id; logs go to the OS temp dir; read output with `terminal_logs <job_id>` and stop it with `terminal_stop <job_id>`. If a dependency is missing, do NOT report 'not installed' and stop — ask permission with request_permission (explain why), WAIT, then retry the install and the original command."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        _stripped_cmd = (command or "").strip()
        _low_cmd = _stripped_cmd.lower()
        _is_bg_ctrl = _low_cmd.startswith(("bg:", "terminal_stop", "terminal_logs"))
        # Parent search cache for terminal search commands
        if not _is_bg_ctrl and _is_terminal_search(command):
            cache_key = ("terminal", command, "", "")
            cached = _parent_search_cache.get(cache_key)
            if cached is not None:
                emit(
                    {
                        "kind": "tool",
                        "tool": "run_terminal",
                        "args": {"command": command},
                        "model": _main_name,
                    }
                )
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "run_terminal",
                        "summary": "cached",
                        "model": _main_name,
                    }
                )
                return cached

        _is_search_cmd = _is_terminal_search(command) and not _is_bg_ctrl
        # Duplicate suppression: a short follow-up like "done?" makes the
        # model re-issue the exact same verification command. When the last
        # successful run for this chat used the identical command, return the
        # cached success instead of spending another terminal execution.
        _cmd_key = str(command or "").strip()
        if not _is_bg_ctrl and _cmd_key and _chat_id:
            _last_run = _TERMINAL_LAST_RUN.get(_chat_id)
            if _last_run and _last_run.get("command") == _cmd_key:
                _cached_out = str(_last_run.get("output") or "")
                emit(
                    {
                        "kind": "tool",
                        "tool": "run_terminal",
                        "args": {"command": command},
                        "model": _main_name if _is_search_cmd else "",
                    }
                )
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "run_terminal",
                        "summary": "duplicate-suppressed · already ran last turn",
                        "results": [{"content": _cached_out[:8000]}],
                    }
                )
                return (
                    _cached_out
                    + "\n[duplicate-suppressed: identical command already succeeded "
                    "— reported from cached result, not re-executed]"
                )
        _emit_args: dict = {"command": command}
        emit(
            {
                "kind": "tool",
                "tool": "run_terminal",
                "args": _emit_args,
                "model": _main_name if _is_search_cmd else "",
            }
        )
        # Test / build / typecheck runs routinely exceed the 120s default;
        # they were killed (exit -1) and re-run identically, burning a full
        # round trip each time. Give them the maximum window up front.
        if timeout == TERMINAL_TIMEOUT and not _is_bg_ctrl and _LONG_RUNNING_CMD_RE.search(command):
            timeout = TERMINAL_TIMEOUT_MAX
        result = await asyncio.to_thread(run_terminal, root, command, timeout, permit)
        if "error" in result:
            msg = result["error"]
            emit(_error_result("run_terminal", msg))
            return f"ERROR running {command!r}: {msg}"
        if result.get("background"):
            _job_id = str(result.get("job_id") or "")
            _summary = f"background job {_job_id} · pid {result.get('pid')}"
            _msg = str(result.get("message") or "")
            emit({"kind": "tool_result", "tool": "run_terminal", "summary": _summary, "results": [{"content": f"$ {command}\n{_msg}"}]})
            return f"$ {command}\n{_msg}" + _format_plan_nudge_suffix(_plan_nudge_due())
        if "exit_code" not in result:
            _status = str(result.get("status") or result.get("message") or result)
            _detail = str(result.get("log_file") or "")
            _logged_out = str(result.get("output") or "").strip()
            _text = f"$ {command}\n{_status}" + (f"\nLog: {_detail}" if _detail else "") + (f"\n{_logged_out}" if _logged_out else "")
            emit({"kind": "tool_result", "tool": "run_terminal", "summary": _status[:200], "results": [{"content": _text[:8000]}]})
            return _text
        output = result["output"].strip()
        # Truncate from the MIDDLE, not the tail: test runners (pytest, jest,
        # vitest, npm test...) print their pass/fail summary and failure
        # tracebacks at the END of output, so a tail-cut used to discard exactly
        # the part that proves a test failed, leaving the model with only
        # head-of-run progress noise and no way to tell success from failure.
        if len(output) > terminal_out_chars:
            _head_chars = terminal_out_chars // 3
            _tail_chars = terminal_out_chars - _head_chars
            output = (
                output[:_head_chars]
                + f"\n…({len(output) - terminal_out_chars} chars truncated)…\n"
                + output[-_tail_chars:]
            )
        summary = f"exit {result['exit_code']} · {len(output)} chars"
        nudge = _format_plan_nudge_suffix(_plan_nudge_due())
        if not output:
            emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary, "results": [{"content": f"$ {command}\n(exit {result['exit_code']})"}]})
            return f"$ {command}\n(no output, exit code {result['exit_code']})" + nudge
        emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary, "results": [{"content": f"$ {command}\nEXIT CODE: {result['exit_code']}\n{output[:8000]}"}]})
        # Exit code used to live ONLY in the emit() summary (UI-only) — the
        # model never saw it in the text it actually reads, so it had to guess
        # pass/fail purely from output text. Prepending it explicitly gives the
        # model a hard, unambiguous signal to check before declaring success.
        _final = f"$ {command}\nEXIT CODE: {result['exit_code']}\n{output}" + nudge
        if _chat_id and _cmd_key and int(result.get("exit_code", -1)) == 0:
            _TERMINAL_LAST_RUN[_chat_id] = {"command": _cmd_key, "output": _final}
            try:
                import trace_store as _ts

                _ts.record_turn_outcome(
                    _chat_id,
                    "completed",
                    evidence=f"terminal exit 0: {_cmd_key[:300]}",
                    mode="",
                )
            except Exception:  # noqa: BLE001, S110 — outcome must never break tools
                pass
        return _final

    async def glob_tool(
        pattern: str = "",
        patterns: list[str] | None = None,
        path: str = "",
        paths: list[str] | None = None,
        max_results: int = 100,
    ) -> str:
        """Find FILES by glob pattern. `pattern` is a glob like `**/*.js`, `src/**/*.ts`, or `*.test.py` (use `**` to match across directories). BATCH: pass every extra glob via `patterns` (a list) so they all run in the SAME call — e.g. pattern='**/*.test.py', patterns=['**/*.spec.ts'] is ONE glob — NEVER fire one glob per pattern when they share a path; `pattern` may be omitted when `patterns` is non-empty. `path` optionally narrows the subtree (omit = whole workspace); pass `paths` (a list of extra subtrees) to scan SEVERAL scopes in the SAME call — e.g. path='src', paths=['backend','tools'] — NEVER fire one glob per scope. `max_results` caps how many paths are returned (default 100). Returns matching relative paths only (no file contents). Respects .gitignore; skips hidden/binary files. You have full workspace access; prefer targeted lookups with path/include. Order is LSP first in build mode, else ONE targeted glob/grep, then symbols read. Runs on the MAIN model — matches are returned directly so the agent can read them itself. Do your file lookup (glob + grep) FIRST, then read only the files you need — do NOT alternate search and read. Use this tool when you need to find files by name patterns; filename-fragment search must use glob first, never grep for filenames; forbid broad OR patterns with >3 alternatives mixing languages — split into targeted globs via patterns=[...] instead; for an open-ended search that may require multiple rounds of globbing and grepping, combine alternatives with `foo|bar` to collapse multiple searches into one. When you already know the patterns you need, speculatively fire several globs in the SAME turn (parallel tool calls) rather than one at a time; for an open-ended search that may require multiple rounds of globbing and grepping, batch them into ONE call via patterns/paths/includes instead of firing one call per term."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        patterns = _coerce_str_list(patterns)
        paths = _coerce_str_list(paths)
        all_patterns = _dedup_patterns(pattern, patterns)
        if not [p for p in all_patterns if str(p or "").strip()]:
            # Batch-only calls omit `pattern`; with no glob at all, fail
            # friendly — a TypeError here burns a full retry step.
            msg = "empty pattern: pass pattern='...' or patterns=[...]"
            emit(_error_result("glob", msg))
            return f"ERROR globbing: {msg}"
        # نمایش تک‌الگویی برای سازگاری پیام‌ها؛ برای batch همه‌ی الگوها با |.
        disp = all_patterns[0] if len(all_patterns) == 1 else "|".join(all_patterns)
        # چند scope در همان فراخوانی: path + paths=[...] → یک glob برای همه.
        # Near-duplicate scopes share one scan/cache entry (same as grep_tool).
        _normed_paths: list[str] = []
        for _p in _dedup_patterns(path, paths):
            _np = _normalize_search_scope(_p)
            if _np not in _normed_paths:
                _normed_paths.append(_np)
        # Drop nested scopes ("backend" + "backend/tools.py"): the broader
        # scan already covers the narrower one, so keep one scan per file.
        _deduped_paths: list[str] = []
        for _np in sorted(_normed_paths, key=len):
            _covered = False
            for _kept in _deduped_paths:
                if _np == _kept or _np.startswith(_kept.rstrip("/") + "/"):
                    _covered = True
                    break
            if not _covered:
                _deduped_paths.append(_np)
        all_paths = _deduped_paths
        scope = "|".join(all_paths) if len(all_paths) > 1 else (all_paths[0] if all_paths else "")
        # Search enforcement: reject workspace-wide glob, a scope is required.
        if not scope:
            _scope_msg = (
                "Workspace-wide glob is not allowed. Provide path=... to scope "
                "the search (e.g. path=backend) and batch patterns via "
                "patterns=[...]. Search rule: LSP first, else ONE scoped grep "
                "path=backend include=*.py, then read symbols/ranges only."
            )
            emit(_error_result("glob", _scope_msg))
            return f"ERROR running glob {disp!r}: {_scope_msg}"
        # Advisory-only budget (same as grep_tool): never hard-block glob.
        if not _SUB_AGENT_CTX.get():
            _glob_budget = _sync_search_budget(root, _chat_id)
            if _glob_budget >= _MAX_SEARCH_BATCHES_WITHOUT_EDIT:
                emit({"kind": "warn", "content": _search_budget_message(_glob_budget)})
            _note_search_batch(root, _chat_id)
        generation = _search_generations.get(root, 0)
        cache_key = ("glob", "|".join(all_patterns), scope, "", root, str(max_results))
        cached = _parent_search_cache.get(cache_key)
        if cached is not None:
            emit(
                {
                    "kind": "tool",
                    "tool": "glob",
                    "args": {"pattern": disp, "path": scope},
                    "model": _main_name,
                }
            )
            emit(
                {
                    "kind": "tool_result",
                    "tool": "glob",
                    "summary": "cached",
                    "model": _main_name,
                }
            )
            return cached

        emit(
            {
                "kind": "tool",
                "tool": "glob",
                "args": {"pattern": disp, "path": scope},
                "model": _main_name,
            }
        )
        try:
            # glob برخلاف regex عملگر | ندارد، پس هر ترکیبِ الگو×اسکوپ جداگانه
            # (اما همزمان و با کش per-key در _shared_search) اسکن می‌شود و
            # نتایج merge می‌شوند — همچنان یک فراخوانی ابزار و یک ToolMessage.
            results = await asyncio.gather(
                *(
                    _shared_search(
                        root, ("glob", p, sp), generation, glob_files, root, p, sp, permit,
                    )
                    for p in all_patterns
                    for sp in all_paths
                )
            )
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("glob", msg))
            return f"ERROR running glob {disp!r} under {scope or '/'}: {msg}"
        errors = [r["error"] for r in results if r.get("error")]
        # merge + dedupe — ترتیب حفظ می‌شود (مثل _clip_glob_results).
        seen: set[str] = set()
        matches: list[str] = []
        for r in results:
            for m in r.get("matches", []):
                if m not in seen:
                    seen.add(m)
                    matches.append(m)
        if not matches:
            if errors:
                # همه‌ی الگوها/اسکوپ‌ها خطا دادند → مثل حالت تک‌الگویی خطا برگردان.
                emit(_error_result("glob", errors[0]))
                return f"ERROR running glob {disp!r} under {scope or '/'}: {errors[0]}"
            emit(
                {
                    "kind": "tool_result",
                    "tool": "glob",
                    "summary": "no matches",
                    "model": _main_name,
                }
            )
            _brace_hint = (
                " Brace patterns like **/*.{tsx,ts,css} are expanded into separate patterns;"
                " prefer patterns=['**/*.tsx', '**/*.ts', '**/*.css'] batching instead."
                if any(_has_brace_alternation(p) for p in all_patterns)
                else ""
            )
            return f"No files match {disp!r} under {scope or '/'}.{_brace_hint}"
        lines = list(matches[:max_results])
        note = (
            f"\n({len(matches)} matches found, showing the first {max_results})"
            if len(matches) > max_results
            else ""
        )
        if errors:
            note += f"\n({len(errors)} pattern(s) failed: {errors[0]})"
        raw = f"GLOB MATCHES for {disp!r}\n" + "\n".join(lines) + note
        if _search_generations.get(root, 0) == generation:
            _parent_search_cache[cache_key] = raw
        # Send the structured results too (not just the summary) so a reconnect
        # can replay the tool without re-executing it (re-execution wastes
        # context). `items` carries the actual paths the model needs to see.
        ui_items = [{"path": p} for p in lines]
        emit(
            {
                "kind": "tool_result",
                "tool": "glob",
                "summary": f"{len(matches)} matches",
                "results": ui_items,
                "model": _main_name,
            }
        )
        try:
            _note_search_surfaced(_chat_id, list(lines[:max_results]))
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks glob
            pass
        return raw

    def _did_you_mean(target: str, filePath: str) -> str:
        """Suggest close matches when a read path doesn't exist, so the model
        self-corrects a hallucinated filename (e.g. a guessed test name)
        instead of failing blind. Best-effort: never raises, empty on no match.
        Same-directory only: lists the missing file's parent dir once, never
        scans the workspace."""
        try:
            parent = os.path.dirname(target)
            if not parent or not os.path.isdir(parent):
                return ""
            # Same-dir bound: only suggest inside the project root. No
            # recursive or workspace-wide scan, no LSP, no symbol index.
            try:
                _proot = os.path.realpath(os.path.abspath(root))
                _ppar = os.path.realpath(parent)
                if _ppar != _proot and not _ppar.startswith(_proot + os.sep):
                    return ""
            except Exception:  # noqa: BLE001, S110 — bound check never breaks read
                pass
            want = os.path.basename(target)
            if not want or len(want) > 128:
                return ""
            try:
                names = os.listdir(parent)
            except OSError:
                return ""
            if len(names) > 500:
                # Large dirs (e.g. node_modules): cap the scan to keep
                # first-read fast.
                names = names[:500]
            names = [n for n in names if len(n) <= 128][:500]
            if not names:
                return ""
            close = difflib.get_close_matches(want, names, n=3, cutoff=0.6)
            if not close:
                return ""
            rels = []
            for n in close:
                try:
                    rels.append(os.path.relpath(os.path.join(parent, n), root))
                except ValueError:
                    rels.append(n)
            return " — did you mean: " + ", ".join(rels) + "?"
        except Exception:  # noqa: BLE001 — suggestions never break the read
            return ""

    async def _serve_head_map(
        filePath: str, target: str, head_lines: list[dict], total: int,
        _main_name: str, quiet: bool, cache_key: tuple,
    ) -> str:
        """File map instead of a blind head dump (see _HEAD_MAP_* above).

        Best-effort symbol index via document_symbols_if_running (never
        starts a server): head lines plus name + line-range per definition
        so the model can read exact symbols next. Falls back to head lines
        plus a grep pointer when no server is running. Envelope matches
        normal read blocks.
        """
        _map_syms: dict = {}
        try:
            from lsp_manager import get_manager as _get_lsp_mgr_map
            _map_mgr = _get_lsp_mgr_map(root)
            _map_syms = await asyncio.to_thread(_map_mgr.document_symbols_if_running, target) or {}
        except Exception:  # noqa: BLE001 - map never breaks on LSP
            _map_syms = {}
        if _map_syms:
            try:
                _map_items: list[tuple[str, int, int]] = []
                for _mn, _mv in _map_syms.items():
                    try:
                        _ms, _me = int(_mv[0]), int(_mv[1])
                    except (TypeError, ValueError, IndexError):
                        continue
                    _map_items.append((_mn, _ms, _me))
                _map_items.sort(key=lambda t: (t[1], t[2] - t[1]))
                _map_shown = _map_items[:_HEAD_MAP_MAX_SYMBOLS]
                _rows = head_lines[:_HEAD_MAP_ROWS]
                _head = "\n".join(f"{ln['line']} | {ln['text']}" for ln in _rows)
                _idx = "\n".join(f"{_n} L{_s}-{_e}" for _n, _s, _e in _map_shown)
                _ex = ", ".join(f"'{_n}'" for _n, _, _ in _map_shown[:4])
                _body = (
                    f"{_head}\n\n(file map: {filePath} has {total} lines. "
                    f"Symbols:\n{_idx}\n"
                    f"Read definitions with symbols=[{_ex}] or "
                    f"ranges=[\"{filePath}:start:count\", ...] in one call.)"
                )
                if len(_map_items) > len(_map_shown):
                    _body += f"\n(+{len(_map_items) - len(_map_shown)} more symbols — grep for exact names.)"
            except Exception:  # noqa: BLE001 — fall back to plain map
                _rows = head_lines[:_HEAD_MAP_ROWS_NO_SYMBOLS]
                _body = (
                    "\n".join(f"{ln['line']} | {ln['text']}" for ln in _rows)
                    + f"\n\n(file map: {filePath} has {total} lines, no indexable "
                    f"symbols. Use grep to locate what you need, then read exact "
                    f"ranges with ranges=[\"{filePath}:start:count\", ...] or "
                    f"symbols=[...] in one call.)"
                )
        else:
            _rows = head_lines[:_HEAD_MAP_ROWS_NO_SYMBOLS]
            _body = (
                "\n".join(f"{ln['line']} | {ln['text']}" for ln in _rows)
                + f"\n\n(file map: {filePath} has {total} lines, no indexable "
                f"symbols. Use grep to locate what you need, then read exact "
                f"ranges with ranges=[\"{filePath}:start:count\", ...] or "
                f"symbols=[...] in one call.)"
            )
        _summary = f"file map · {total} lines"
        _last = int(_rows[-1]["line"])
        if not quiet:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": _summary,
                    "model": _main_name,
                    "results": [{"path": filePath, "content": _body[:8000]}],
                }
            )
        raw = f"<path>{filePath}</path>\n<type>file</type>\n<content>\n{_body}\n</content>"
        try:
            if _chat_id:
                _READ_SEEN_BY_CHAT.setdefault(_chat_id, set()).add(cache_key)
        except Exception:  # noqa: BLE001, S110 - seen mark never breaks read
            pass
        _note_read_range(_chat_id, target, 1, _last)
        try:
            _parent_search_cache[cache_key] = raw
        except Exception:  # noqa: BLE001, S110 — cache never breaks a read
            pass
        return raw

    async def _read_target(
        filePath: str, offset: int, limit: int, _main_name: str,
        quiet: bool = False, allow_head_map: bool = True,
        _cache_hits: list[str] | None = None,
        _cap_exempt: bool = False,
    ) -> str:
        """Read ONE file/dir path and emit its own tool_result/error event.
        Shared by the single-path and batch branches of read_tool below so
        both paths get identical per-file behavior (error messages, paging
        notes, directory listing) — batch just calls this once per path
        concurrently instead of the caller looping one read_tool call at a
        time. `quiet=True` suppresses the per-file events: the batch branch
        emits ONE aggregate card instead, so a fast-failing missing file can
        no longer hijack the whole batch card to red "file not found" while
        the other files succeeded."""
        if str(filePath or "").strip() in (".", "", "/"):
            msg = (
                "reading the workspace root is not allowed — use glob with a "
                "filename pattern (e.g. pattern='*Composer*') or grep scoped "
                "with path+include, never list the root"
            )
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath or '.'}: {msg}"
        try:
            target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        # Cache keyed by the normalized absolute path (tool, target, offset,
        # limit). A re-read of the same region (the standard post-edit pattern)
        # returns the cached bytes instead of re-scanning the file — no CPU
        # cost, just a cache hit. Normalizing means the key matches regardless
        # of how the model spelled the path, and lines up with the key
        # _invalidate_read_cache_for() computes after edit/write.
        cache_key = ("read", target, str(offset), str(limit))
        cached = _parent_search_cache.get(cache_key)
        if cached is not None:
            if _cache_hits is not None:
                _cache_hits.append(filePath)
            try:
                _seen_before = _READ_SEEN_BY_CHAT.get(_chat_id or "")
            except Exception:  # noqa: BLE001 - stub never breaks a read
                _seen_before = None
            if _seen_before is not None and cache_key in _seen_before:
                if not quiet:
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "read",
                            "summary": "cached-unchanged",
                            "model": _main_name,
                        }
                    )
                return " ".join(
                    [
                        f"<path>{filePath}</path>",
                        "(unchanged: this exact window was already returned",
                        "earlier in this chat - reuse that result instead of",
                        f"re-reading: {filePath} offset {offset} limit {limit})",
                    ]
                )
            try:
                if _chat_id:
                    _READ_SEEN_BY_CHAT.setdefault(_chat_id, set()).add(cache_key)
            except Exception:  # noqa: BLE001, S110 - seen mark never breaks read
                pass
            if not quiet:
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "read",
                        "summary": "cached",
                        "model": _main_name,
                    }
                )
            return cached
        try:
            _root_real = os.path.realpath(os.path.abspath(root))
        except Exception:  # noqa: BLE001 - root check never breaks read
            _root_real = ""
        if target == _root_real or str(filePath or "").strip() in (".", "", "/"):
            msg = (
                "reading the workspace root is not allowed — use glob with a "
                "filename pattern (e.g. pattern='*Composer*') or grep scoped "
                "with path+include, never list the root"
            )
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath or '.'}: {msg}"
        if os.path.isdir(target):
            raw = await _read_dir_tool(target, filePath, offset, limit, _main_name, quiet=quiet)
            _parent_search_cache[cache_key] = raw
            try:
                if _chat_id:
                    _READ_SEEN_BY_CHAT.setdefault(_chat_id, set()).add(cache_key)
            except Exception:  # noqa: BLE001, S110 - seen mark never breaks read
                pass
            return raw
        if not os.path.exists(target):
            msg = "file not found" + _did_you_mean(target, filePath)
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        if not _is_text_path(target):
            msg = "binary file (read skipped)"
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        offset = int(offset or 1)
        limit = int(limit or 2000)
        # Covering-window dedup (this turn, unchanged file): a window fully
        # inside an already-served range returns a one-line stub — live
        # traces re-read overlapping windows of the same file step after
        # step and every re-send cost bytes on each later request.
        # Partial overlap is trimmed: only the not-yet-served intervals are
        # fetched in one scan, so shifted re-reads (e.g. 1-200 then 150-350)
        # serve just the new lines instead of the full window again.
        _req_end = offset + limit - 1
        _covered = _read_range_covered(_chat_id or "", target, offset, _req_end)
        if _covered is not None:
            if _cache_hits is not None:
                _cache_hits.append(filePath)
            if not quiet:
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "read",
                        "summary": "cached-unchanged",
                        "model": _main_name,
                    }
                )
            return " ".join(
                [
                    f"<path>{filePath}</path>",
                    f"(unchanged: lines {offset}-{_req_end} were already",
                    f"returned earlier in this turn (served lines {_covered[0]}-{_covered[1]}",
                    "of this file) - reuse that result instead of re-reading.",
                    "Each separate read call costs a full round-trip:",
                    "batch ALL remaining windows of this file in ONE read call with",
                    'ranges=["path:start:count", ...], never one window per step.)',
                ]
            )

        # Partial-overlap dedup: serve only not-yet-served intervals so a
        # shifted re-read of one file never resends the overlap.
        if not (allow_head_map and offset == 1 and limit >= _HEAD_MAP_MIN_LIMIT):
            try:
                _uncovered = _read_uncovered_intervals(_chat_id or "", target, offset, offset + limit - 1)
            except Exception:  # noqa: BLE001 - dedup never breaks a read
                _uncovered = [(offset, offset + limit - 1)]
            if _uncovered != [(offset, offset + limit - 1)]:
                if not _uncovered:
                    if _cache_hits is not None:
                        _cache_hits.append(filePath)
                    if not quiet:
                        emit(
                            {
                                "kind": "tool_result",
                                "tool": "read",
                                "summary": "cached-unchanged",
                                "model": _main_name,
                            }
                        )
                    return " ".join(
                        [
                            f"<path>{filePath}</path>",
                            f"(unchanged: lines {offset}-{offset + limit - 1} were already",
                            "returned earlier in this turn - reuse that result instead of re-reading)",
                        ]
                    )
                if (
                    not _cap_exempt
                    and _read_lines_served(_chat_id or "", target) >= _READ_TURN_FILE_LINE_CAP
                ):
                    if not quiet:
                        emit(
                            {
                                "kind": "tool_result",
                                "tool": "read",
                                "summary": "read-cap",
                                "model": _main_name,
                            }
                        )
                    return " ".join(
                        [
                            f"<path>{filePath}</path>",
                            f"(read cap: ~{_READ_TURN_FILE_LINE_CAP} lines of this file were",
                            "already served this turn - do NOT page the rest of the file.",
                            "Reuse the windows already in this conversation; for anything",
                            "else locate it with grep (path+include) or lsp_symbols, then",
                            "read(symbols=[...]) the exact definitions in one call.)",
                        ]
                    )
                _delta_parts: list[str] = []
                for _us, _ue in _uncovered:
                    try:
                        _ex = await asyncio.to_thread(_read_lines_excerpt, target, _us, _ue - _us + 1)
                    except Exception:  # noqa: BLE001, S112 - one bad interval never breaks read
                        continue
                    if _ex.get("error") or not _ex.get("lines"):
                        continue
                    _delta_parts.append("\n".join(f"{_r['line']} | {_r['text']}" for _r in _ex["lines"]))
                    _note_read_range(_chat_id, target, _us, _ue)
                if _delta_parts:
                    try:
                        _served_ranges = _READ_RANGES_BY_CHAT.get((_chat_id or "").strip(), {}).get(target) or []
                        _served_desc = ", ".join(f"{_s}-{_e}" for _s, _e in sorted(_served_ranges)[:6])
                    except Exception:  # noqa: BLE001 - note never breaks read
                        _served_desc = ""
                    _new_desc = ", ".join(f"{_s}-{_e}" for _s, _e in _uncovered)
                    _body = "\n\n...\n".join(_delta_parts)
                    _body += (
                        f"\n\n({filePath}: serving only new lines {_new_desc}; "
                        f"overlap already served this turn ({_served_desc}) is reused from earlier result - "
                        "do not re-read it. Each separate read call costs a full round-trip: "
                        "batch ALL remaining windows of this file in ONE read call with "
                        "ranges=[\"path:start:count\", ...], never one window per step.)"
                    )
                    if not quiet:
                        emit(
                            {
                                "kind": "tool_result",
                                "tool": "read",
                                "summary": f"{sum(_e - _s + 1 for _s, _e in _uncovered)} new lines",
                                "model": _main_name,
                                "results": [{"path": filePath, "content": _body[:8000]}],
                            }
                        )
                    _raw = f"<path>{filePath}</path>\n<type>file</type>\n<content>\n{_body}\n</content>"
                    try:
                        if _chat_id:
                            _READ_SEEN_BY_CHAT.setdefault(_chat_id, set()).add(cache_key)
                    except Exception:  # noqa: BLE001, S110 - seen mark never breaks read
                        pass
                    try:
                        _parent_search_cache[cache_key] = _raw
                    except Exception:  # noqa: BLE001, S110 - cache never breaks a read
                        pass
                    return _raw
        # Block-snapped over-read: fetch up to _SNAP_LOOKAHEAD lines past the
        # requested limit (bulk reads >= 1000 lines are exempt — they already
        # cover whole regions) so the window can end on a block boundary
        # instead of mid-function. The byte cap still bounds total output.
        want = limit + _SNAP_LOOKAHEAD if limit < 1000 else limit
        # Repeat-file prefetch (cross-step round-trip saver): a second window
        # of the SAME file in the SAME turn means the model is paging one
        # window per step. Extend this serve forward (bounded) so the next
        # page arrives now instead of costing another full round-trip.
        try:
            _already = (_READ_RANGES_BY_CHAT.get((_chat_id or "").strip(), {}).get(target) or [])
        except Exception:  # noqa: BLE001 - prefetch never breaks a read
            _already = []
        if _already and limit < 1000:
            try:
                _pref = int(_READ_PREFETCH_LINES)
            except Exception:  # noqa: BLE001 - prefetch never breaks a read
                _pref = 0
            if _pref > 0:
                try:
                    _served_total = sum(e - s + 1 for s, e in _already)
                except Exception:  # noqa: BLE001 - prefetch never breaks a read
                    _served_total = 0
                if _served_total < _READ_TURN_FILE_LINE_CAP:
                    want = min(want + _pref, _served_total + want + _pref)
                    want = min(want, limit + _SNAP_LOOKAHEAD + _pref)

        # Cold-miss fast path: serve file bytes directly with one streaming
        # read. No coalesce delay, no workspace scan, no LSP/symbol work.
        excerpt = await asyncio.to_thread(_read_lines_excerpt, target, offset, want)
        if excerpt.get("error"):
            msg = excerpt["error"]
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        lines = excerpt["lines"]
        start = excerpt["start"]
        total = excerpt["total"]
        cut = bool(excerpt.get("cut"))
        if not lines:
            msg = f"line offset {start} is past the end of the file ({total} lines)"
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        if allow_head_map and offset == 1 and limit >= _HEAD_MAP_MIN_LIMIT:
            # Cheap probe: reuse the excerpt already fetched above. Big files
            # serve a map; small files fall through. No second I/O, no LSP.
            _htotal = int(excerpt.get("total") or 0)
            if _htotal > _HEAD_MAP_MIN_LINES and excerpt.get("lines"):
                return await _serve_head_map(
                    filePath, target, excerpt["lines"][:_HEAD_MAP_ROWS_NO_SYMBOLS],
                    _htotal, _main_name, quiet, cache_key,
                )
            # Small after all: fall through to the normal path below.
        # Per-turn per-file served-line cap: past the cap, further windows
        # of this file return a stub — the model should locate code with
        # grep/lsp_symbols instead of paging a whole large file window by
        # window. Symbol windows (_cap_exempt) always serve: they ARE the
        # targeted lookup this stub points at.
        if (
            not _cap_exempt
            and _read_lines_served(_chat_id or "", target) >= _READ_TURN_FILE_LINE_CAP
        ):
            if not quiet:
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "read",
                        "summary": "read-cap",
                        "model": _main_name,
                    }
                )
            return " ".join(
                [
                    f"<path>{filePath}</path>",
                    f"(read cap: ~{_READ_TURN_FILE_LINE_CAP} lines of this file were",
                    "already served this turn - do NOT page the rest of the file.",
                    "Reuse the windows already in this conversation; for anything",
                    "else locate it with grep (path+include) or lsp_symbols, then",
                    "read(symbols=[...]) the exact definitions in one call.)",
                ]
            )
        # Small files come back whole from the offset: one read instead of
        # offset/limit paging across two or more round-trips. Larger files
        # snap to the first block boundary past the requested limit.
        if not cut and total <= _SMALL_FILE_LINES:
            if lines[-1]["line"] < total:
                tail = await asyncio.to_thread(
                    _read_lines_excerpt, target, lines[-1]["line"] + 1, total
                )
                if not tail.get("error") and tail.get("lines"):
                    lines = [*lines, *tail["lines"]]
                    cut = bool(tail.get("cut"))
        else:
            lines = _snap_end(lines, limit)
        body = "\n".join(f"{ln['line']} | {ln['text']}" for ln in lines)
        last = lines[-1]["line"]
        more = last < total
        # Offset-read enrichment: enclosing symbol(s) with line ranges so
        # the model knows which definition the window sits in (e.g. in
        # read_tool L6963-7271). Best-effort via document_symbols_if_running
        # which never starts a server and never breaks the read.
        _read_enclosing = ""
        try:
            from lsp_manager import get_manager as _get_lsp_mgr_read
            _read_mgr = _get_lsp_mgr_read(root)
            _read_syms = await asyncio.to_thread(_read_mgr.document_symbols_if_running, target) or {}
            if _read_syms:
                _read_over: list[tuple[str, int, int]] = []
                for _rn, _rv in _read_syms.items():
                    try:
                        _rsi, _rei = int(_rv[0]), int(_rv[1])
                    except (TypeError, ValueError, IndexError):
                        continue
                    if _rei < start or _rsi > last:
                        continue
                    _read_over.append((_rn, _rsi, _rei))
                if _read_over:
                    _read_over.sort(key=lambda t: (t[1], t[2] - t[1]))
                    _read_over = _read_over[:3]
                    _read_enclosing = ", ".join(f"{_n} L{_s}-{_e}" for _n, _s, _e in _read_over)
        except Exception:  # noqa: BLE001 - enrichment never breaks read
            _read_enclosing = ""
        if quiet:
            # Batch member: one compact position marker. The batch call
            # carries the paging guidance once at the end, so per-block
            # guidance is not repeated for every file.
            body += f"\n\n({filePath}: lines {start}-{last} of {total}" + (f"; in {_read_enclosing}" if _read_enclosing else "") + ")"
        elif cut:
            body += (
                f"\n\n(Output capped at {MAX_READ_EXCERPT_BYTES // 1024} KB. "
                f"Showing lines {start}-{last}."
                + (f" In {_read_enclosing}." if _read_enclosing else "")
                + " Read the needed sections with "
                "symbols=[...] or ranges=[\"path:start:count\", ...] in one call.)"
            )
        elif more:
            body += (
                f"\n\n(Showing lines {start}-{last} of {total}."
                + (f" In {_read_enclosing}." if _read_enclosing else "")
                + " Read all needed sections with symbols=[...] or "
                + "ranges=[\"path:start:count\", ...] in one call, "
                + "or locate them with grep first.)"
            )
        else:
            body += f"\n\n(End of file - total {total} lines" + (f"; in {_read_enclosing}" if _read_enclosing else "") + ")"
        if not quiet:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": f"{len(lines)} lines",
                    "model": _main_name,
                    "results": [{"path": filePath, "content": body[:8000]}],
                }
            )
        raw = f"<path>{filePath}</path>\n<type>file</type>\n<content>\n{body}\n</content>"
        try:
            if _chat_id:
                _READ_SEEN_BY_CHAT.setdefault(_chat_id, set()).add(cache_key)
        except Exception:  # noqa: BLE001, S110 - seen mark never breaks read
            pass
        _note_read_range(_chat_id, target, start, last)
        _parent_search_cache[cache_key] = raw
        return raw

    async def read_tool(
        filePath: str = "",
        offset: int = 1,
        limit: int = 2000,
        filePaths: list[str] | None = None,
        ranges: list[str] | None = None,
        symbols: list[str] | None = None,
    ) -> str:
        """Read a file (verbatim code) or, if `filePath` is a directory, list its entries. `filePath` is workspace-relative. For FILES: `offset` is the 1-indexed line to start at (default 1) and `limit` caps the number of lines returned (default 2000) — page large files with offset/limit. For DIRECTORIES: lists entries one per line (subdirs marked with a trailing `/`), paged by offset/limit. Use AFTER you know the exact path (from LSP or targeted glob/grep) — not to search for files. You have full workspace access; read any workspace file via symbols=[...] or ranges=[...]. Runs on the MAIN model — contents are returned directly so the agent can read them itself.

        BATCH: pass `filePaths` (a list of additional workspace-relative paths) to read multiple independent files in parallel — read several files in ONE call instead of one read_tool call per file — e.g. filePath="a.ts", filePaths=["a.test.ts", "a.stories.ts"] reads all three together, in parallel. offset/limit apply to every path in the batch equally; for a path that needs a DIFFERENT window, pass `ranges` (a list of "path:offset:limit" strings, e.g. ranges=["tools.py:3380:220", "agents.py:810:80"]) — every listed path is read with its own window in the SAME call. Shorthand forms "start:end" (an inclusive line range on the single file being read; "start:count" when count < start) and "[start,end]" are accepted too. Prefer batching related files (a component + its test + its types) instead of one call per file — same effect as firing several reads in parallel, but a single tool call. Avoid tiny repeated slices (e.g. 30-line chunks) — if you need more context, read a larger window (limit=300+) instead of paging 30 lines at a time; only narrow offset/limit when you truly need a small, specific region. Every read — single-file or multi-file — runs this same batch pipeline (one position marker per file, one guidance footer). Repeated lone single-window reads of one file in a turn are batch-gated from the 3rd call on — collect every window you still need and re-issue them as ONE ranges=[...] call.

SYMBOLS: pass `symbols` (a list of function/class/method names, e.g. symbols=["DiffView", "parseSideBySide"]) to read those definitions from `filePath` in ONE call instead of guessing line numbers — names come from LSP. OMIT `filePath` and each name is looked up across the whole project: one definition is read directly (no grep needed); a name defined in several files returns the candidate list — then pass filePath. Each window snaps to its block end and small files (<=300 lines) come back whole, so no follow-up read is needed. `symbols` wins over offset/limit for `filePath`. `symbols` and `ranges` combine in the SAME call when you need both definitions and raw windows — never a ranges call plus a separate symbols call on the same file.

WINDOWS: every window is extended past the requested limit to its block end (closing bracket at column 0, max 40 extra lines) and files with <=300 lines are returned whole — a window never ends mid-function. A head read (offset 1, limit 400+) of a file over 400 lines returns a FILE MAP (first 40 lines + definition list) instead of a bulk dump — read definitions via symbols=[...] in one call, never re-read the head for content. Past ~3000 served lines of one file in a turn, further windows of it return a read-cap stub — locate with grep/lsp_symbols and read(symbols=[...]) instead of paging the whole file. Make the FIRST read of a file decisive — never open with a narrow slice and page forward one window per step (read 1-200, then 217-350, …). When you need more lines beyond the window, read all needed sections with `symbols=[...]` or `ranges=[...]` in ONE call, or locate them with grep first.

When you need to read several files, read multiple independent files in parallel (pass them all in one call) rather than one at a time."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        filePaths = _coerce_str_list(filePaths)
        ranges = _coerce_str_list(ranges)
        symbols = _coerce_str_list(symbols)
        # Per-path windows ("path:offset:limit") map to each file's own window.
        # The global offset/limit still applies to paths without a dedicated window.
        # jobs is a list (not a dict keyed by path) so repeated same-file ranges
        # (e.g. ["tools.py:640:60","tools.py:2089:80"]) both run.
        jobs: list[tuple[str, int, int]] = []
        _bad_ranges: list[str] = []
        # Live traces showed two off-spec forms the strict "path:offset:limit"
        # parser silently dropped — each drop cost a full retry round
        # (~25K tokens): "[start, end]" (a JSON-array window) and
        # "offset:limit" with no path. Both now resolve against the
        # single target file; anything still unparseable is REPORTED so
        # the model corrects in one step instead of re-reading blind.
        _range_target = str(filePath or "").strip() or (
            filePaths[0] if len(filePaths) == 1 else ""
        )
        for spec in ranges or []:
            if isinstance(spec, dict):
                # Live trace (build mode): the model emitted JSON-object
                # windows ({"start": 790, "end": 830}) instead of
                # "path:start:count" strings; the strict parser dropped all
                # of them and the retry round tripped the search budget.
                # Accept the dict form against the single target file (or
                # the dict's own path/filePath key), same as the other
                # off-spec forms below.
                _dp = str(spec.get("path") or spec.get("filePath") or "").strip()
                _do = spec.get("start") if spec.get("start") is not None else spec.get("offset")
                _de = spec.get("end")
                _dl = spec.get("limit")
                _tgt = _dp or _range_target
                if _do is None or not str(_do).strip().isdigit() or not _tgt:
                    _bad_ranges.append(json.dumps(spec, ensure_ascii=False))
                    continue
                _o = int(str(_do).strip())
                if _de is not None and str(_de).strip().isdigit() and int(_de) >= _o:
                    jobs.append((_tgt, _o, int(_de) - _o + 1))
                elif _dl is not None and str(_dl).strip().isdigit() and int(_dl) > 0:
                    jobs.append((_tgt, _o, int(_dl)))
                else:
                    _bad_ranges.append(json.dumps(spec, ensure_ascii=False))
                continue
            s = str(spec).strip()
            m_pair = re.fullmatch(r"\[\s*(\d+)\s*,\s*(\d+)\s*\]", s)
            if m_pair:
                _o, _e = int(m_pair.group(1)), int(m_pair.group(2))
                if _range_target and _e >= _o:
                    jobs.append((_range_target, _o, _e - _o + 1))
                else:
                    _bad_ranges.append(s)
                continue
            parts = s.split(":")
            if len(parts) == 2:
                # Live traces show the model writes "start:end" (an inclusive
                # line range, e.g. "3930:3985") far more often than
                # "start:count". Disambiguate by order: end >= start means an
                # inclusive range; count < start means offset:count.
                if (
                    _range_target
                    and parts[0].strip().isdigit()
                    and parts[1].strip().isdigit()
                ):
                    _a, _b = int(parts[0]), int(parts[1])
                    if _b >= _a:
                        jobs.append((_range_target, _a, _b - _a + 1))
                    else:
                        jobs.append((_range_target, _a, _b))
                else:
                    _bad_ranges.append(s)
                continue
            if len(parts) != 3:
                _bad_ranges.append(s)
                continue
            p, o, l = parts[0].strip(), parts[1].strip(), parts[2].strip()
            if not p or not o.isdigit() or not l.isdigit():
                _bad_ranges.append(s)
                continue
            jobs.append((p, int(o), int(l)))
        # Bare-path fallback (live trace): the model dropped the directory
        # prefix ("tools.py" for "backend/tools.py") when every batch member
        # lives in the same directory. Retry unresolvable range paths against
        # the parent dirs of the known batch files before reporting missing.
        if jobs:
            _known_dirs: list[str] = []
            for _kp in ([filePath] if str(filePath or "").strip() else []) + [
                str(x) for x in (filePaths or []) if str(x).strip()
            ]:
                _kd = str(_kp).rsplit("/", 1)[0] if "/" in str(_kp) else ""
                if _kd and _kd not in _known_dirs:
                    _known_dirs.append(_kd)
            for _ji, (_jp, _jo, _jl) in enumerate(jobs):
                if _jp in (str(filePath or "").strip(), *(str(x) for x in (filePaths or []))):
                    continue
                if not _known_dirs:
                    continue
                try:
                    resolve_safe(root, _jp, allow_coder=True, permit=permit)
                    continue  # resolves fine as-is
                except PathEscapeError:
                    _bad_ranges.append(_jp)
                    continue
                except Exception:  # noqa: BLE001, S110 - probe only
                    pass
                for _kd in _known_dirs:
                    _cand = f"{_kd}/{_jp}"
                    try:
                        resolve_safe(root, _cand, allow_coder=True, permit=permit)
                        jobs[_ji] = (_cand, _jo, _jl)
                        break
                    except Exception:  # noqa: BLE001, S112 - probe only
                        continue
        # `symbols=[...]` resolves to concrete windows on filePath via the
        # LSP manager — one call instead of guessing line numbers.
        _symbol_missing: list[str] = []
        _symbol_ambiguous: list[str] = []
        # Paths whose windows came from symbols= resolution: targeted
        # lookups stay exempt from the per-turn read cap.
        _sym_paths: set[str] = set()
        if symbols and not str(filePath or "").strip() and not filePaths:
            # No filePath: look each name up across the project via the symbol
            # index. A unique definition becomes a window in ITS file (one
            # call instead of grep + read); several definitions are listed so
            # the model can re-ask with filePath — nothing is guessed.
            try:
                from lsp_manager import get_manager as _get_lsp_manager_for_symbols
            except ImportError:
                return "ERROR reading symbols=: symbols= is unavailable (LSP manager missing)"
            _lsp_mgr_g = _get_lsp_manager_for_symbols(root)
            _want = [str(s) for s in symbols]
            _found = await asyncio.to_thread(_lsp_mgr_g.find_symbols, _want)
            for _nm in _want:
                _hits = _found.get(_nm) or []
                if not _hits:
                    _symbol_missing.append(_nm)
                    continue
                # workspace/symbol is fuzzy: an exact name match wins, so a
                # unique name is never reported as ambiguous.
                _exact = [h for h in _hits if len(h) > 3 and h[3] == _nm]
                if _exact:
                    _hits = _exact
                else:
                    _lower_nm = _nm.lower()
                    _ci = [h for h in _hits if len(h) > 3 and str(h[3]).lower() == _lower_nm]
                    _hits = _ci if _ci else []
                if not _hits:
                    _symbol_missing.append(_nm)
                    continue
                if len(_hits) > 1:
                    _symbol_ambiguous.append(
                        f"{_nm}: " + ", ".join(f"{h[0]}:{h[1]}" for h in _hits[:6])
                        + (f" (+{len(_hits) - 6} more)" if len(_hits) > 6 else "")
                    )
                    continue
                _rel, _ln, _kd, _real = _hits[0]
                try:
                    _abs_hit = resolve_safe(root, _rel, allow_coder=True, permit=permit)
                except PathEscapeError:
                    _symbol_missing.append(_nm)
                    continue
                _w_hit, _ = await asyncio.to_thread(
                    _lsp_mgr_g.symbol_ranges, _abs_hit, [_real]
                )
                if not _w_hit:
                    _symbol_missing.append(_nm)
                    continue
                jobs.extend((_rel, _o, _l) for _o, _l in _w_hit)
                _sym_paths.add(_rel)
            if not jobs:
                _msg = "ERROR reading symbols=: "
                if _symbol_ambiguous:
                    _msg += "defined in several files — re-call with filePath: " + "; ".join(_symbol_ambiguous) + ". "
                if _symbol_missing:
                    _msg += "no such symbol(s): " + ", ".join(_symbol_missing) + ". Try grep for the name."
                return _msg
        elif symbols:
            if not str(filePath or "").strip():
                # symbols= resolves inside ONE file. A single-entry `filePaths`
                # is unambiguous: use it instead of burning a whole round-trip
                # on an error (live trace: filePaths + symbols -> error step).
                _fp_list = [str(x).strip() for x in (filePaths or []) if str(x).strip()]
                if len(_fp_list) == 1:
                    filePath = _fp_list[0]
                else:
                    _ex = _fp_list[0] if _fp_list else "path/to/file"
                    _names = ", ".join(repr(str(s)) for s in list(symbols)[:4])
                    return (
                        "ERROR reading symbols=: symbols= belongs to ONE file (`filePath`) and "
                        "cannot be combined with a multi-file `filePaths`. Re-call in ONE step "
                        f"with one read per file, e.g. read(filePath={_ex!r}, symbols=[{_names}]) "
                        "(several read calls in the same step run in parallel), or use "
                        'ranges=["path:start:count", ...] to window several files in one call.'
                    )
            try:
                _sym_target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
            except PathEscapeError as exc:
                return f"ERROR reading {filePath}: invalid path: {exc}"
            if os.path.isdir(_sym_target):
                return f"ERROR reading {filePath}: symbols= needs a file, not a directory"
            try:
                from lsp_manager import get_manager as _get_lsp_manager_for_ranges
            except ImportError:
                return f"ERROR reading {filePath}: symbols= is unavailable (LSP manager missing)"
            _wins, _symbol_missing = await asyncio.to_thread(
                _get_lsp_manager_for_ranges(root).symbol_ranges,
                _sym_target,
                [str(s) for s in symbols],
            )
            if not _wins:
                return (
                    f"ERROR reading {filePath}: no such symbol(s): "
                    f"{', '.join(_symbol_missing)}. Use lsp_symbols or grep for exact names."
                )
            jobs.extend((filePath, _o, _l) for _o, _l in _wins)
            _sym_paths.add(filePath)
        base_paths = ([filePath] if str(filePath or "").strip() else []) + [
            p for p in (filePaths or []) if p and p != filePath
        ]
        # Paths that only appear inside ranges join the batch (deduplicated
        # for logging) — actual execution comes from tasks to keep duplicates.
        for p, _, _ in jobs:
            if p not in base_paths:
                base_paths.append(p)
        if not base_paths and not jobs:
            return "ERROR reading: no file specified — pass `filePath` (single file), `filePaths` (batch), or `ranges` (per-file windows)."
        # No single fast-path: EVERY read — even one file, one window — runs
        # the batch pipeline below (widen+merge, quiet position markers, EOF
        # refill, one aggregate card + footer). A separate single branch kept
        # re-growing its own one-off behaviors (own footers, own events);
        # uniformity kills that whole class of drift.
        job_paths = {p for p, _, _ in jobs}
        tasks: list[tuple[str, int, int]] = [
            (p, offset, limit) for p in base_paths if p not in job_paths
        ]
        tasks.extend(jobs)
        # Byte-identical members twice in ONE call (same path in filePaths
        # twice, same ranges entry twice) would serve the same block twice.
        # Same-file DIFFERENT windows are kept — each is its own job.
        _seen_tasks: set[tuple[str, int, int]] = set()
        _uniq_tasks: list[tuple[str, int, int]] = []
        for _t in tasks:
            if _t in _seen_tasks:
                continue
            _seen_tasks.add(_t)
            _uniq_tasks.append(_t)
        tasks = _uniq_tasks
        # Window count BEFORE merging: two near windows of one file merge
        # into one task, but the CALL was still a batch — the lone-read
        # gate below judges the call, not the merged task list.
        _pre_merge_windows = len(tasks)
        # Every requested window is served in full; re-reads re-serve.
        tasks = _widen_and_merge_windows(tasks)
        emit(
            {
                "kind": "tool",
                "tool": "read",
                "args": {
                    "filePaths": base_paths,
                    "offset": offset,
                    "limit": limit,
                    **({"ranges": list(ranges)} if ranges else {}),
                    **({"symbols": list(symbols)} if symbols else {}),
                },
                "model": _main_name,
            }
        )
        # Same-turn lone-read batch gate: a 3rd+ single-window call on one
        # file in one turn is the paging anti-pattern the user reported —
        # one window per round-trip, each re-sending the whole context. The
        # first two lone calls serve (the 2nd via the delta path); from the
        # 3rd on, only a real batch (2+ windows in ONE call) serves.
        _cid = (_chat_id or "").strip()
        if _cid and _pre_merge_windows <= 1 and not symbols:
            _gp = tasks[0][0]
            try:
                _gt = resolve_safe(root, _gp, allow_coder=True, permit=permit)
                # Search-first ordering: a lone single-window read of a file no
                # search has surfaced this turn is blind — demand one targeted
                # search first instead of burning a round-trip guessing paths.
                # symbols=/batch/directory reads are themselves targeted, exempt.
                try:
                    _surfaced = _SEARCH_SURFACED_BY_CHAT.get(_cid, set())
                except Exception:  # noqa: BLE001 - lookup never breaks a read
                    _surfaced = set()
                try:
                    _root_real = os.path.realpath(root)
                    _gt_real = os.path.realpath(_gt)
                    _rel_gt = os.path.relpath(_gt_real, _root_real) if os.path.isabs(str(_gt or "")) else str(_gt or "")
                except Exception:  # noqa: BLE001 - relpath never breaks a read
                    _rel_gt = str(_gt or "")
                try:
                    _gt_is_dir = os.path.isdir(_gt)
                except Exception:  # noqa: BLE001 - isdir never breaks a read
                    _gt_is_dir = False
                _search_first_nudge = False
                if _rel_gt and _rel_gt not in (_surfaced or set()) and not _gt_is_dir:
                    try:
                        _known = _READ_RANGES_BY_CHAT.get(_cid, {})
                    except Exception:  # noqa: BLE001 - lookup never breaks a read
                        _known = {}
                    if _gt not in (_known or {}):
                        # Non-blocking: serve this read (blocking forces a retry
                        # round-trip, which is worse than one blind serve). Nudge
                        # toward search-first for the NEXT read instead.
                        _search_first_nudge = True
                        emit(
                            {
                                "kind": "warn",
                                "content": (
                                    "Blind read served once — next time run ONE targeted search first "
                                    "(lsp_symbols for a name, glob for a filename, or grep with path/include), "
                                    "then read with symbols=[...] or ranges=[...] in ONE call."
                                ),
                            }
                        )
                _lone_n = _READ_LONE_CALLS_BY_CHAT.get(_cid, {}).get(_gt, 0)
                _gt_ok = os.path.isfile(_gt)
            except Exception:  # noqa: BLE001 - gate never breaks read
                _gt, _lone_n, _gt_ok = None, 0, False
            if _gt is not None and _gt_ok:
                if _lone_n >= 2:
                    # Non-blocking: a stub here forces a retry round-trip, which
                    # costs MORE than serving. Serve and nudge toward batching.
                    emit(
                        {
                            "kind": "warn",
                            "content": (
                                f"{_gp} read {_lone_n}x this turn one window per call. "
                                "Served this time — next time batch ALL remaining windows in ONE "
                                "ranges=[\"path:start:count\", ...] call."
                            ),
                        }
                    )
                _READ_LONE_CALLS_BY_CHAT.setdefault(_cid, {})[_gt] = _lone_n + 1
        # Read every target concurrently — same asyncio.gather pattern used for
        # parallel read-only tool calls elsewhere in the graph, just applied
        # WITHIN one tool call instead of across several parallel tool calls.
        # tasks keeps same-file duplicates (each ranges entry is its own job).
        # Per-file events are suppressed (quiet=True): the batch emits ONE
        # aggregate card below, so a fast-failing missing file can no longer
        # win the race and paint the whole batch red while siblings succeed.
        # Cache hits are collected (not per-member events — quiet stays
        # quiet) so a fully-cached batch can report one "cached" card, the
        # same signal the old single branch emitted per read.
        _cache_hit_paths: list[str] = []
        results = await asyncio.gather(
            *(
                _read_target(p, o, l, _main_name, quiet=True,
                             allow_head_map=(p not in job_paths),
                             _cache_hits=_cache_hit_paths,
                             _cap_exempt=(p in _sym_paths))
                for p, o, l in tasks
            )
        )
        # Shared-offset guard: one offset/limit across files of different
        # sizes past-EOFs on the short ones. Instead of burning another step
        # on an error, serve each short file from line 1 with a note — the
        # model almost always wanted "the file", not "an error".
        _eof_tasks: list[tuple[int, str, int]] = []
        for _i, _r in enumerate(results):
            if "past the end of the file" not in str(_r):
                continue
            _m = re.search(r"past the end of the file \((\d+) lines\)", str(_r))
            if _m and int(_m.group(1)) > 0:
                _p, _o, _l = tasks[_i]
                _eof_tasks.append((_i, _p, _l))
        if _eof_tasks:
            _refills = await asyncio.gather(
                *(
                    _read_target(p, 1, l, _main_name, quiet=True,
                                 allow_head_map=False)
                    for _, p, l in _eof_tasks
                )
            )
            _results = list(results)
            for (_i, _p, _l), _rr in zip(_eof_tasks, _refills):
                if str(_rr).startswith("ERROR"):
                    continue
                _o = tasks[_i][1]
                _results[_i] = (
                    f"(offset {_o} is past the end of {_p}; "
                    f"showing from line 1 instead)\n\n{_rr}"
                )
            results = _results
        # Summary footer: when some files error but the rest succeed, the model
        # must not treat the whole batch as failed. Errors and successes return
        # separately plus one summary line at the end.
        _errs = [
            (p, r)
            for (p, _, _), r in zip(tasks, results)
            if str(r).startswith("ERROR")
        ]
        _oks = [
            (p, r)
            for (p, _, _), r in zip(tasks, results)
            if not str(r).startswith("ERROR")
        ]
        if _errs and len(_errs) < len(results):
            _foot = (
                f"[batch] {len(_oks)}/{len(results)} files read OK; "
                + "; ".join(f"{p}: {str(r).split(':', 1)[-1].strip()}" for p, r in _errs)
            )
            # Broadcast-window guard: one shared offset/limit across files of
            # different sizes past-EOFs on the short ones. Steer to per-file
            # windows instead of another broadcast guess.
            if any("past the end of the file" in str(r) for _, r in _errs):
                _foot += (
                    " Files differ in size — use ranges=[\"path:start:count\", ...] "
                    "with a per-file window, not one shared offset/limit."
                )
            _ok_paths = list(dict.fromkeys(p for p, _ in _oks))
            _total_paths = list(dict.fromkeys(p for p, _, _ in tasks))
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": f"{len(_ok_paths)}/{len(_total_paths)} files · missing: "
                    + ", ".join(dict.fromkeys(p for p, _ in _errs)),
                    "model": _main_name,
                    "results": [{"path": p} for p in _ok_paths],
                }
            )
            _partial = "\n\n".join(r for _, r in _oks) + "\n\n" + _foot
            if _bad_ranges:
                _partial += (
                    "\n\n(unparsed ranges ignored: "
                    + ", ".join(_bad_ranges)
                    + ")"
                )
            return _partial
        if not _errs:
            # One assembly point for fresh and fully-cached serves: the cache
            # holds pre-footer member bytes, so rebuilding identically keeps
            # r1 == r2 for repeats (the cache contract the tests pin).
            _out = "\n\n".join(results)
            _out += (
                "\n\n(Batch complete — page further windows with "
                "ranges=[\"path:start:count\", ...] in one call.)"
            )
            if _bad_ranges:
                _out += (
                    "\n\n(unparsed ranges ignored: "
                    + ", ".join(_bad_ranges)
                    + ' — use "path:start:count", "start:count" for the'
                    + " single file, or \"[start,end]\".)"
                )
            if _symbol_missing:
                _out += (
                    "\n\n(symbols not found: "
                    + ", ".join(_symbol_missing)
                    + ". Use lsp_symbols or grep for exact names.)"
                )
            if _symbol_ambiguous:
                _out += (
                    "\n\n(symbols defined in several files — re-call with filePath: "
                    + "; ".join(_symbol_ambiguous)
                    + ")"
                )
            if tasks and len(_cache_hit_paths) == len(tasks):
                # Everything came from cache: one "cached" card, exactly what
                # a repeated single read used to emit (no aggregate card).
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "read",
                        "summary": "cached",
                        "model": _main_name,
                    }
                )
                return _out
            _unique_paths = list(dict.fromkeys(p for p, _, _ in tasks))
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": f"{len(_unique_paths)} file" + ("s" if len(_unique_paths) != 1 else ""),
                    "model": _main_name,
                    # Single-file reads keep the old content preview on the
                    # card (used to come from the single branch's per-file
                    # event); multi-file batches stay path-only so one card
                    # can't balloon to N×8KB in the trace.
                    # Same-file multi-window reads emit one entry per unique
                    # path so RESULTS never lists the same file N times.
                    "results": [
                        {"path": p, **({"content": results[0][:8000]} if len(results) == 1 else {})}
                        for p in _unique_paths
                    ],
                }
            )
            return _out
        emit(
            _error_result(
                "read",
                "; ".join(f"{p}: {str(r).split(':', 1)[-1].strip()}" for p, r in _errs),
            )
        )
        return "\n\n".join(results)

    async def _read_dir_tool(
        target: str, filePath: str, offset: int, limit: int, _model: str = "",
        quiet: bool = False,
    ) -> str:
        """Directory branch of the read tool (opencode-style listing)."""
        try:
            names = await asyncio.to_thread(
                lambda: sorted(os.listdir(target), key=lambda n: (n.lower(),))
            )
        except PermissionError:
            msg = "permission denied"
            if not quiet:
                emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        entries: list[str] = []
        for name in names:
            if name.startswith(".") and name not in (".gitignore", ".env"):
                continue
            full = os.path.join(target, name)
            marker = "/" if os.path.isdir(full) else ""
            entries.append(f"{name}{marker}")
        start = max(1, int(offset or 1))
        count = max(1, min(int(limit or 2000), 2000))
        window = entries[start - 1 : start - 1 + count]
        truncated = start - 1 + len(window) < len(entries)
        footer = (
            f"\n(Showing {len(window)} of {len(entries)} entries. "
            f"Use 'offset' parameter to read beyond entry {start + len(window) - 1})"
            if truncated
            else f"\n({len(entries)} entries)"
        )
        body = "\n".join(window) if window else "(empty directory)"
        if not quiet:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": f"directory · {len(entries)} entries",
                    "model": _model,
                    "results": [{"path": filePath or "/", "content": "\n".join(window[:100])}],
                }
            )
        return f"<path>{filePath or '/'}</path>\n<type>directory</type>\n<entries>\n{body}\n{footer}\n</entries>"

    async def task_tool(
        description: str, prompt: str, subagent_type: str = "subagent", task_id: str = ""
    ) -> str:
        """Delegate a task to the background sub-agent (opencode-style `task` tool). The sub-agent is a read-only researcher (search/read/web only — no edits, no terminal) running in an isolated context; it returns a compact report. Use it ONLY for several parallel chunks needing DIFFERENT research (sub-agents NEVER run tests — the main agent edits and runs all tests after merging reports); launch one task per chunk in ONE parallel block with different prompts. `description`: 3-5 word summary of the task (shown in the UI). `prompt`: the full task description. `subagent_type`: optional, defaults to 'subagent' (legacy 'general'/'explore' are accepted as aliases). `task_id`: optional, to resume a previous task (sessions are ephemeral — ignored)."""
        # --- opencode-style task tool dispatch ---
        # Assign the branch id up-front so the task card itself carries it; the
        # sub-agent's internal grep/glob/read events are tagged with the same
        # branch (via _SUB_AGENT_BRANCH_CTX) and the frontend nests them under
        # THIS card. Without it the card has branch=undefined while its children
        # carry branch=1, so the frontend drops them and the sub-agent card shows
        # nothing but "N chars".
        nonlocal _task_call_seq
        _ecall = _task_call_seq + 1
        _task_call_seq = _ecall
        # Validate the subagent_type against the agent registry (opencode:
        # "Unknown agent type: X is not a valid agent type").
        subagent_type = resolve_agent(subagent_type)
        if subagent_type not in AGENTS:
            _valid = ", ".join(repr(n) for n in agent_names())
            emit(
                {
                    "kind": "tool",
                    "tool": "task",
                    "args": {
                        "description": description,
                        "subagent_type": subagent_type,
                    },
                    "branch": _ecall,
                    "model": "",
                }
            )
            emit(
                _error_result(
                    "task",
                    f"Unknown agent type: {subagent_type} is not a valid agent type. Valid types: {_valid}",
                )
            )
            return (
                f"ERROR: Unknown agent type: {subagent_type} is not a valid agent type. Valid types: {_valid}"
            )
        # Sub-agent depth limit (opencode's subagent_depth, default 1): a
        # sub-agent cannot spawn another sub-agent.
        if _TASK_DEPTH_CTX.get() >= _SUBAGENT_DEPTH_LIMIT:
            emit(
                {
                    "kind": "tool",
                    "tool": "task",
                    "args": {
                        "description": description,
                        "subagent_type": subagent_type,
                    },
                    "branch": _ecall,
                    "model": "",
                }
            )
            emit(_error_result("task", "subagent depth limit reached"))
            return (
                f"ERROR: subagent depth limit reached ({_SUBAGENT_DEPTH_LIMIT}) — "
                "a sub-agent cannot spawn another sub-agent."
            )
        # Background dispatch: register the job, emit the task card with its
        # task_id/branch, then run the isolated sub-agent loop as an
        # asyncio.Task so the main agent keeps working in parallel. The final
        # report is stored on the job and injected into the main transcript
        # when done (graph.py holds the turn open until every job for the
        # chat ends). The returned string only acknowledges the spawn — it is
        # NOT the report. Steer via task_steer(task_id=...), stop via
        # task_stop(task_id=...). The legacy `task_id` argument (resume id)
        # is ignored: every spawn gets a fresh registry id for steer/stop.
        if subagent_type in AGENTS:
            job = _subagent_jobs.create_job(_chat_id, _ecall, description, subagent_type)
            _new_tid = str(job.get("task_id") or "")
            emit(
                {
                    "kind": "tool",
                    "tool": "task",
                    "args": {
                        "description": description,
                        "subagent_type": subagent_type,
                        "task_id": _new_tid,
                    },
                    "model": "",
                    "branch": _ecall,
                    "task_id": _new_tid,
                    "status": "running",
                }
            )
            coro = _run_subagent_task(description, prompt, _new_tid, subagent_type, _ecall)
            try:
                _bg = asyncio.create_task(coro)
            except RuntimeError:
                # No running loop (synchronous unit-test context): run inline
                # so callers that await task() still get the final report.
                _report = await coro
                return str(_report)
            _subagent_jobs.set_task(_new_tid, _bg)

            def _done_cb(done: asyncio.Task, _cb_tid: str = _new_tid) -> None:
                try:
                    _rep = (
                        done.result()
                        if not done.cancelled()
                        else "Stopped by the main agent before producing a report."
                    )
                except Exception:  # noqa: BLE001 — result already stored by runner
                    _rep = ""
                try:
                    _j = _subagent_jobs.get_job(_cb_tid)
                    if _j is not None and _j.get("status") == "running":
                        _subagent_jobs.finish_job(
                            _cb_tid, "stopped" if done.cancelled() else "completed", str(_rep or "")
                        )
                except Exception:  # noqa: BLE001, S110 — bookkeeping only
                    pass

            _bg.add_done_callback(_done_cb)
            return (
                f"Sub-agent started in background (task_id={_new_tid}, branch={_ecall}, "
                f"type={subagent_type}): {str(description or '')[:120]}. "
                "You are its manager: do NOT write the final answer until its "
                "report arrives and you have verified the task is done — "
                "do only UNRELATED parallel work meanwhile (never the same "
                "scope). Do NOT repeat the "
                "delegated work yourself (no grep/glob/read over the same scope); "
                "trust the report and do only targeted follow-ups for files it names. "
                "Its compact report will be "
                "delivered automatically when it finishes. Use "
                f"task_steer(task_id='{_new_tid}', message='...') to send a follow-up "
                f"or task_stop(task_id='{_new_tid}') to stop it."
            )
        # No other subagent types supported
        _valid = ", ".join(repr(n) for n in agent_names())
        emit(
            {
                "kind": "tool",
                "tool": "task",
                "args": {
                    "description": description,
                    "subagent_type": subagent_type,
                },
                "branch": _ecall,
                "model": "",
            }
        )
        emit(
            _error_result(
                "task",
                f"Unknown agent type: {subagent_type} is not a valid agent type. Valid types: {_valid}",
            )
        )
        return (
            f"ERROR: Unknown agent type: {subagent_type} is not a valid agent type. Valid types: {_valid}"
        )

    async def task_steer_tool(task_id: str, message: str) -> str:
        """Send a follow-up message to a RUNNING background sub-agent. The sub-agent picks it up between rounds and its next report reflects it. `task_id`: the id from the task spawn acknowledgement. `message`: the follow-up instruction (1-2 sentences)."""
        emit({"kind": "tool", "tool": "task_steer", "args": {"task_id": task_id}})
        job = _subagent_jobs.enqueue_steer(task_id, message)
        if job is None:
            emit(_error_result("task_steer", f"no such sub-agent: {task_id!r}"))
            return f"ERROR: no such background sub-agent task_id={task_id!r}."
        if job.get("status") != "running":
            emit(_error_result("task_steer", f"task {task_id} already {job.get('status')}"))
            return f"Task {task_id} is already {job.get('status')} — steer ignored."
        if not str(message or "").strip():
            emit(_error_result("task_steer", "empty message"))
            return "ERROR: steer message is empty."
        emit({"kind": "tool_result", "tool": "task_steer", "summary": f"steered {task_id}"})
        return f"Steered {task_id}: follow-up queued; the sub-agent will reflect it in its report."

    async def task_stop_tool(task_id: str) -> str:
        """Stop a RUNNING background sub-agent. `task_id`: the id from the task spawn acknowledgement. The sub-agent ends as stopped and a short note is delivered instead of a report."""
        emit({"kind": "tool", "tool": "task_stop", "args": {"task_id": task_id}})
        job = _subagent_jobs.get_job(task_id)
        if job is None:
            emit(_error_result("task_stop", f"no such sub-agent: {task_id!r}"))
            return f"ERROR: no such background sub-agent task_id={task_id!r}."
        if job.get("status") != "running":
            return f"Task {task_id} is already {job.get('status')} — nothing to stop."
        _subagent_jobs.request_stop(task_id)
        emit({"kind": "tool_result", "tool": "task_stop", "summary": f"stopped {task_id}"})
        return f"Stopping {task_id}: it will end as stopped and deliver a short note."

    async def _run_subagent_task(
        description: str, prompt: str, task_id: str, subagent_type: str, branch: int = 0
    ) -> str:
        """Run a registered sub-agent (opencode's `task` + agent registry).

        The sub-agent runs in an isolated context. Its tool events are tagged
        ``sub=True`` via ``_SUB_AGENT_CTX`` and routed to this task card via
        ``_SUB_AGENT_BRANCH_CTX``, so they never count against the parent's
        deterministic tool-step budget (they run in an isolated transcript) and
        never enter the parent's context. Its final reply is the only thing the
        Main Agent sees (context isolation, spec §9/§11).

        The system prompt and tool set come from ``agent_registry``: a `tools`
        list pins an exact (read-only) tool set; ``None`` inherits the parent's
        tools minus ``task`` (the ``general`` agent).
        """
        from llm import langchain_tool_loop

        # Tee: every event this loop emits also lands on the job registry's
        # bounded activity trail so the per-chat right-panel view can show
        # live progress as tool-call-like rows. The parent stream contract is
        # untouched. Built in a factory so the enclosing ``emit`` is captured
        # cleanly (no local rebinding of the captured name).
        def _make_tee_emit(parent_emit, tid):
            def tee_emit(ev: dict) -> None:
                parent_emit(ev)
                try:
                    _kind = str((ev or {}).get("kind") or "")
                    _tool = str(ev.get("tool") or "")
                    if _kind == "tool":
                        _subagent_jobs.append_event(
                            str(tid or ""), _tool, tool=_tool, kind="tool"
                        )
                    elif _kind == "tool_result":
                        _subagent_jobs.append_event(
                            str(tid or ""),
                            str(ev.get("summary") or "")[:120],
                            tool=_tool,
                            kind="tool_result",
                        )
                    elif _kind == "status":
                        # Drop per-step heartbeat noise ("sub-agent started:",
                        # "sub-agent step N/M") — retries repeat them and the
                        # panel renders tool rows, not progress spam. The
                        # loop's → / ✓ activity markers become tool rows.
                        _c = str(ev.get("content") or "")[:120]
                        if _c.startswith(("sub-agent started:", "sub-agent step ")):
                            return
                        if _c.startswith(("→ ", "✓ ")):
                            _done = _c.startswith("✓ ")
                            _name = _c[2:].strip()
                            if _name:
                                _subagent_jobs.append_event(
                                    str(tid or ""),
                                    "done" if _done else _name,
                                    tool=_name,
                                    kind="tool_result" if _done else "tool",
                                )
                        else:
                            _subagent_jobs.append_event(
                                str(tid or ""), _c, tool=_tool, kind="status"
                            )
                except Exception:  # noqa: BLE001, S110 — tee must never break the stream
                    pass

            return tee_emit

        _tee_emit = _make_tee_emit(emit, task_id)

        _model = main_model
        if resolve_agent(subagent_type) == "subagent" and explore_model is not None:
            _model = explore_model
        if _model is None:
            _tee_emit(_error_result("task", "unavailable"))
            try:
                _subagent_jobs.finish_job(
                    str(task_id or ""), "failed",
                    "ERROR: the sub-agent is unavailable (no model configured for this session).",
                )
            except Exception:  # noqa: BLE001, S110 — bookkeeping only
                pass
            return "ERROR: the sub-agent is unavailable (no model configured for this session)."
        _model_name = str(getattr(_model, "model_name", "") or "")
        # Background job: `task_id` is the registry id created up-front in
        # task_tool (the card was already emitted there with branch/task_id),
        # so only emit a status line here — never a second task card.
        _tid = str(task_id or "")
        try:
            _early = _subagent_jobs.get_job(_tid)
            if _early is not None and _early.get("stop_requested"):
                _subagent_jobs.finish_job(_tid, "stopped", "Stopped before start.")
                _tee_emit(_error_result("task", f"sub-agent {_tid} stopped before start"))
                return f'<task id="{_tid}" state="stopped">\n<task_result>\nStopped before start.\n</task_result>\n</task>'
        except Exception:  # noqa: BLE001, S110 — stop check never breaks spawn
            pass
        # Inherit the PARENT's actual (mode-filtered) toolset — set by agents.py
        # after capability filtering — so a plan/ask-mode `task` call cannot hand
        # the sub-agent write tools (the read-only bypass). Fall back to the full
        # registry only when no parent toolset was recorded. The source mixes
        # plain callbacks with live MCP tools (ready BaseTool instances merged
        # into the parent dict by merge_mcp_tools): BaseTool instances must be
        # passed through UNWRAPPED — _invoke's functools.wraps would copy the
        # instance __dict__ and langchain_tool_loop would then try to rebuild a
        # StructuredTool from a BaseTool, crashing with "descriptor '__call__'
        # for 'type' objects doesn't apply to a 'StructuredTool' object".
        def _sub_wrap(name: str, fn: Any):
            return fn if isinstance(fn, BaseTool) else _invoke(fn)

        _parent_tools = _PARENT_TOOLS_CTX.get()
        _tool_source = _parent_tools if _parent_tools is not None else _tools
        _reg_tools = agent_tools(subagent_type)
        # Code guarantee (not just prompt): sub-agents are read-only
        # researchers, even when the parent is coder. They report evidence;
        # the main agent applies edits and runs tests.
        if _reg_tools is not None:
            _allowed = set(_reg_tools) - _SUBAGENT_STRIPPED_TOOLS
            _sub_tools = {
                name: _sub_wrap(name, fn)
                for name, fn in _tool_source.items()
                if name in _allowed
            }
        else:
            _sub_tools = {
                name: _sub_wrap(name, fn)
                for name, fn in _tool_source.items()
                if name not in ("task", "update_plan", "vision", *sorted(_SUBAGENT_STRIPPED_TOOLS))
            }
        # Defense in depth: strip even if a future registry/parent set re-adds them.
        for _stripped in _SUBAGENT_STRIPPED_TOOLS:
            _sub_tools.pop(_stripped, None)
        # Web research stays available: re-add from the full registry when the
        # allowlist wants it but the mode-filtered parent dropped it.
        for _web_tool in ("web_search", "fetch_url"):
            if _web_tool in _allowed and _web_tool not in _sub_tools and _web_tool in _tools:
                _sub_tools[_web_tool] = _sub_wrap(_web_tool, _tools[_web_tool])
        # Sub-agents have no terminal at all: run_terminal is stripped above,
        # so no shell search/test path exists to guard. Research uses
        # grep/glob/read/LSP plus web_search/fetch_url; the main agent runs
        # all tests after merging reports.
        _token = _SUB_AGENT_CTX.set(True)
        _branch_token = _SUB_AGENT_BRANCH_CTX.set(branch)
        _depth_token = _TASK_DEPTH_CTX.set(_TASK_DEPTH_CTX.get() + 1)
        # Per-agent hard step budget (opencode's `agent.steps`). Falls back to
        # the loop's default when the registry entry omits it.
        _agent_steps = AGENTS.get(subagent_type, {}).get("steps")
        # Hand the sub-agent the parent's context window so its isolated
        # transcript can auto-compact mid-run (llm._auto_compact_subagent)
        # instead of overflowing and failing the whole task when it reads
        # many large files. 0 means "no budget" -> no compaction (legacy
        # behavior for sessions without a known window).
        _ctx = int(context_window) if context_window and context_window > 0 else 0
        _attempts = 0
        _last_exc: Exception | None = None
        # No history snapshot needed here.
        # Route mid-run steers (task_steer) to THIS job: llm.py drains
        # RUNNING_TASK_CTX between steps so a follow-up lands while the
        # sub-agent is still working, not only after its whole run.
        _steer_token = _subagent_jobs.RUNNING_TASK_CTX.set(_tid)
        # Skills: the sub-agent's registry prompt has no skills catalog, so
        # it could neither see nor load_skill any user skill — a delegation
        # like "apply the X skill to ..." made it stall or guess. Append the
        # compact catalog (once — the retry loop below must not re-append)
        # and make sure load_skill is bound: a general agent inherits it
        # from the parent toolset, but an explicit registry tool list may
        # omit it. Capped block; "" when no skills exist.
        try:
            from graph import skills_catalog_block as _skills_catalog

            _catalog_block = _skills_catalog()
        except Exception:  # noqa: BLE001 — catalog is best-effort
            _catalog_block = ""
        if _catalog_block:
            prompt = prompt + _catalog_block
        if "load_skill" not in _sub_tools and "load_skill" in _tool_source:
            _sub_tools["load_skill"] = _invoke(_tool_source["load_skill"])
        while _attempts < _SUBAGENT_MAX_ATTEMPTS:
            _attempts += 1
            try:
                # No code-map injection: explore uses on-demand LSP and symbols.
                _sys = agent_system(subagent_type) or (
                    "You are a sub-agent. Work through the task independently with "
                    "your tools, then reply with a concise final result. Do not ask the "
                    "user questions; do not call the task tool."
                )
                _sys += (
                    "\n\nSEARCH DISCIPLINE: targeted search only — LSP first in build mode, "
                    "then ONE targeted grep, then symbols/ranges read only; NEVER "
                    "blind-scan. BATCH like the main agent: ONE grep via "
                    "patterns/paths/includes, ONE read via filePaths, ONE read via "
                    "ranges+symbols. NEVER run tests — report files changed and "
                    "let the main agent run all tests after merging reports."
                )
                # No code-map injection: explore uses on-demand LSP tools.
                try:
                    _tee_emit(
                        {
                            "kind": "status",
                            "stage": "subagent",
                            "content": f"sub-agent started: {str(description or '')[:80]}",
                        }
                    )
                except Exception:  # noqa: BLE001, S110 — progress never breaks subagent
                    pass
                _explore_t0 = time.monotonic()
                _output = await langchain_tool_loop(
                    _model,
                    system=_sys,
                    user=prompt,
                    tools=_sub_tools,
                    max_steps=_agent_steps if _agent_steps else 24,
                    ctx=_ctx,
                    compact_model=_model,
                    reserved=reserved if reserved is not None else 20_000,
                    emit=_tee_emit,
                    task_id=_tid,
                )
                try:
                    logger.info(
                        "[subagent-timing] done subagent=%.1fs desc=%s",
                        time.monotonic() - _explore_t0,
                        str(description or "")[:80],
                    )
                except Exception:  # noqa: BLE001, S110 — timing never breaks subagent
                    pass
                break
            except Exception as exc:  # noqa: BLE001 — degrade instead of killing the turn
                _last_exc = exc
                if _model is main_model or main_model is None:
                    # Already on the main model (or no fallback) — give up.
                    break
                if _attempts < _SUBAGENT_MAX_ATTEMPTS:
                    # Transient blip on the sub-agent model: retry on the same
                    # model before falling back to the main model. Emit a
                    # retry event so the UI shows a banner instead of silence
                    # during the backoff sleep.
                    try:
                        _tee_emit(
                            {
                                "kind": "retry",
                                "attempt": _attempts,
                                "max_attempts": _SUBAGENT_MAX_ATTEMPTS,
                                "delay": _SUBAGENT_RETRY_SECONDS,
                                "reason": f"sub-agent model ({_model_name}) failed: {exc} — retrying",
                                "model": _model_name,
                                "agent": "subagent",
                                "fallback": False,
                                "reconnecting": True,
                            }
                        )
                    except Exception:  # noqa: BLE001, S110 — cosmetic only
                        pass
                    await asyncio.sleep(_SUBAGENT_RETRY_SECONDS)
                    continue
                # Retries on the sub-agent model are exhausted: fall back to the
                # main model for one final attempt (sticky, like _run_distill).
                _emit_fallback("subagent", "subagent", _model, main_model, exc)
                _model = main_model
                _model_name = str(getattr(_model, "model_name", "") or "")
                try:
                    _output = await langchain_tool_loop(
                        _model,
                        system=agent_system(subagent_type)
                        or "You are a sub-agent. Work through the task independently "
                        "with your tools, then reply with a concise final result. Do "
                        "not ask the user questions; do not call the task tool.",
                        user=prompt,
                        tools=_sub_tools,
                        max_steps=_agent_steps if _agent_steps else 24,
                        ctx=_ctx,
                        compact_model=_model,
                        reserved=reserved if reserved is not None else 20_000,
                        emit=_tee_emit,
                        task_id=_tid,
                    )
                    _last_exc = None  # fallback succeeded — clear the prior error
                    break
                except Exception as exc2:  # noqa: BLE001
                    _last_exc = exc2
                    break
        if _last_exc is not None:
            # Either the main model also failed, or we exhausted retries and
            # fell back but still failed. Return a structured note that steers
            # the Main Agent to re-delegate with a narrower scope instead of
            # reading the whole codebase manually. Direct grep/glob/read stay
            # available — the note only suggests a cheaper retry, it never
            # claims direct search is unavailable.
            _tee_emit(_error_result("task", f"sub-agent failed: {_last_exc}"))
            _SUB_AGENT_CTX.reset(_token)
            _SUB_AGENT_BRANCH_CTX.reset(_branch_token)
            _TASK_DEPTH_CTX.reset(_depth_token)
            _note = _explore_fail_note(subagent_type, _model_name, _last_exc)
            try:
                _subagent_jobs.finish_job(_tid, "failed", _note)
            except Exception:  # noqa: BLE001, S110 — bookkeeping only
                pass
            return _note
        _SUB_AGENT_CTX.reset(_token)
        _SUB_AGENT_BRANCH_CTX.reset(_branch_token)
        _TASK_DEPTH_CTX.reset(_depth_token)
        _subagent_jobs.RUNNING_TASK_CTX.reset(_steer_token)
        _output = (_output or "").strip()
        # Steer follow-ups: messages the main agent queued via task_steer
        # while this job ran are answered as extra rounds (bounded) so a
        # steer is reflected instead of dropped. Stop wins immediately.
        try:
            _follow = 0
            while _follow < 3:
                _j = _subagent_jobs.get_job(_tid)
                if _j is None or _j.get("stop_requested"):
                    break
                _inbox = list(_j.get("steer_inbox") or [])
                _j["steer_inbox"] = []
                if not _inbox:
                    break
                _follow += 1
                _steer_text = "\n\n".join(str(s.get("message") or "") for s in _inbox if str(s.get("message") or "").strip())
                if not _steer_text.strip():
                    break
                _extra = await langchain_tool_loop(
                    _model,
                    system=_sys,
                    user=f"Follow-up from the main agent (task {_tid}):\n{_steer_text}\n\nOriginal task: {prompt}\n\nPrevious report:\n{_output}\n\nUpdate the report to reflect the follow-up.",
                    tools=_sub_tools,
                    max_steps=_agent_steps if _agent_steps else 24,
                    ctx=_ctx,
                    compact_model=_model,
                    reserved=reserved if reserved is not None else 20_000,
                    emit=_tee_emit,
                    task_id=_tid,
                )
                _extra = (_extra or "").strip()
                if _extra:
                    _output = f"{_output}\n\n[follow-up {_follow}:\n{_extra}]" if _output else _extra
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001, S110 — follow-ups are best-effort
            pass
        try:
            _j = _subagent_jobs.get_job(_tid)
            if _j is not None and _j.get("stop_requested"):
                _subagent_jobs.finish_job(_tid, "stopped", (_output or "Stopped.")[:8000])
                _tee_emit(
                    {
                        "kind": "tool_result",
                        "tool": "task",
                        "summary": "stopped",
                        "model": _model_name,
                        "branch": branch,
                        "task_id": _tid,
                    }
                )
                return f'<task id="{_tid}" state="stopped">\n<task_result>\n{(_output or "Stopped.")}\n</task_result>\n</task>'
        except Exception:  # noqa: BLE001, S110 — stop check never breaks delivery
            pass
        _tee_emit(
            {
                "kind": "tool_result",
                "tool": "task",
                "summary": (
                    f"report {len(_output) / 1000:.1f}K chars"
                    if len(_output) >= 1000
                    else f"report {len(_output)} chars"
                ),
                "model": _model_name,
                "branch": branch,
                "task_id": _tid,
                "results": [{"content": _output[:8000]}],
            }
        )
        _final = f'<task id="{_tid}" state="completed">\n<task_result>\n{_output}\n</task_result>\n</task>'
        try:
            _subagent_jobs.finish_job(_tid, "completed", _final)
        except Exception:  # noqa: BLE001, S110 — bookkeeping only
            pass
        return _final

    def _is_vision_image_rejection(exc: BaseException) -> bool:
        """True when the provider rejected the image content parts (a text-only
        "vision" model, or one that doesn't accept base64 image_url)."""
        text = str(exc)
        status_match = re.search(r"status[_ ]code[:=]?\s*(\d{3})", text, re.IGNORECASE)
        if status_match:
            try:
                if int(status_match.group(1)) not in (400, 422):
                    return False
            except ValueError:
                pass
        low = text.lower()
        return (
            "unknown variant" in low
            and "image_url" in low
            and ("expected" in low or "forgot to set a default message" in low)
        ) or (
            "image_url" in low
            and (
                "field is required" in low
                or "not supported" in low
                or "does not support" in low
                or "unexpected" in low
                or "unrecognized" in low
            )
        )

    def _log_vision_error(exc: BaseException) -> str:
        """Write the full traceback to ~/coder_vision_error.log and return a
        concise ``Type: message`` string so the real cause is inspectable."""
        import traceback as _tb

        summary = f"{type(exc).__name__}: {exc}"
        try:
            _path = os.path.expanduser("~/coder_vision_error.log")
            with open(_path, "a", encoding="utf-8") as _f:
                _f.write("\n=== vision sub-agent error ===\n" + _tb.format_exc() + "\n")
        except Exception:  # noqa: BLE001, S110
            pass
        return summary

    async def vision_tool(prompt: str) -> str:
        """Analyze the image(s) attached to the current message using the
        vision sub-agent (Settings → Subagents → Vision model).

        The main model cannot see the images directly (they are kept out of its
        request when a vision model is configured), so it delegates to this
        tool: a tool-less sub-agent runs on the configured vision model with
        the images + this prompt, and its analysis is returned as the tool
        result. The main model then writes the final answer.
        """
        from llm import llm_generate

        nonlocal _task_call_seq
        _imgs = [u for u in (image_uris or []) if u]
        _vmodel = vision_model if vision_model is not None else main_model
        _vname = (
            str(getattr(_vmodel, "model_name", "") or "") if _vmodel is not None else ""
        )
        _ecall = _task_call_seq + 1
        _task_call_seq = _ecall
        emit(
            {
                "kind": "tool",
                "tool": "vision",
                "args": {"prompt": prompt},
                "model": _vname,
                "branch": _ecall,
            }
        )
        if not _imgs:
            emit(_error_result("vision", "no images"))
            return "ERROR: no image is attached to this message — nothing to analyze."
        if _vmodel is None:
            emit(_error_result("vision", "unavailable"))
            return "ERROR: the vision model is unavailable (no model configured for this session)."
        _tid = f"vision-{uuid.uuid4().hex[:8]}"
        _token = _SUB_AGENT_CTX.set(True)
        _branch_token = _SUB_AGENT_BRANCH_CTX.set(_ecall)
        _depth_token = _TASK_DEPTH_CTX.set(_TASK_DEPTH_CTX.get() + 1)
        _sys = (
            "You are a vision analysis sub-agent. The main agent delegated an "
            "image analysis task to you. Look carefully at the attached "
            "image(s) and reply with a precise, concise analysis (under ~300 "
            "words) that answers the task. Include the exact details (text, "
            "numbers, layout, colors, UI elements, errors) the main agent "
            "needs — it cannot see the image, your report is its only view."
        )
        _used_model = _vname
        try:
            _output, usage = await llm_generate(
                _vmodel, system=_sys, user=prompt, images=_imgs, sub=True,
                chat_id=str(_chat_id or ""),
            )
            if usage:
                emit(usage)
        except Exception as exc:  # noqa: BLE001
            emit(_error_result("vision", f"failed: {_log_vision_error(exc)}"))
            if _is_vision_image_rejection(exc):
                return (
                    f"ERROR: the configured vision model ('{_vname}') rejected the image "
                    f"— it does not support image input. Set a vision-capable model in "
                    f"Settings → Subagents → Vision. Detail: {_log_vision_error(exc)}"
                )
            return (
                f"ERROR: the vision sub-agent failed ('{_vname}' model): "
                f"{_log_vision_error(exc)}. "
                f"Try a different vision model in Settings → Subagents → Vision."
            )
        finally:
            _SUB_AGENT_CTX.reset(_token)
            _SUB_AGENT_BRANCH_CTX.reset(_branch_token)
            _TASK_DEPTH_CTX.reset(_depth_token)
        _output = (_output or "").strip()
        emit(
            {
                "kind": "tool_result",
                "tool": "vision",
                "summary": f"{len(_output)} chars",
                "model": _used_model,
                "branch": _ecall,
                "results": [{"content": _output[:8000]}],
            }
        )
        if not _output:
            emit(_error_result("vision", "no report"))
            return "ERROR: the vision sub-agent produced no usable analysis."
        return f'<task id="{_tid}" state="completed">\n<task_result>\n{_output}\n</task_result>\n</task>'

    async def web_search_tool(query: str, max_results: int = 5) -> str:
        """Search the web AND fetch the full page content of the top results (not just a snippet) before answering. Results are cached for 24h, so repeating the exact same query costs no extra call. If you need several searches, fire all `web_search` calls in the SAME turn (parallel tool calls) — combine alternatives with `foo|bar` to collapse several searches into one. Only reach for `fetch_url` afterward for a specific URL that wasn't among the top results. NEVER use this tool when the user asks (in any language) to open/show/visit a site (e.g. 'open digikala') — those requests MUST use browser_navigate instead."""
        # The model that will distill the results: the web sub-agent, or the
        # MAIN model once this slot has fallen back earlier in the turn.
        _web_runner = main_model if _fallback_state.get("web") else web_model
        _web_runner_name = (
            str(getattr(_web_runner, "model_name", "") or "")
            if _web_runner is not None
            else ""
        )
        emit(
            {
                "kind": "tool",
                "tool": "web_search",
                "args": {"query": query},
                "model": _web_runner_name,
            }
        )
        # اول توی RAG چک کن — اگه قبلاً ذخیره شده بود، از همون برگردون
        # (بدون صدا زدن وب). وگرنه ادامه بده و بعدش ذخیره کن.
        # فقط وقتی RAG فعاله store رو باز کن (lazy واقعی) — و خودمان بستنش
        # رو هم به عهده بگیریم تا connection sqlite + sqlite_vec نشت نکنه.
        _ws_for_lookup = store
        if _ws_for_lookup is None and _rag_web_enabled():
            _ws_for_lookup = _get_web_store(root)
        rag_hit = await _rag_web_lookup(query, _ws_for_lookup, root)
        if rag_hit:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "web_search",
                    "summary": "rag recall",
                }
            )
            return f"WEB RESULTS for {query!r} (from saved RAG)\n{rag_hit}"
        cache = _get_result_cache()
        ck = f"web:{query}"
        cached = cache.get(ck)
        if cached:
            emit({"kind": "tool_result", "tool": "web_search", "summary": "cached"})
            return cached
        result = await asyncio.to_thread(web_search, query, max_results)
        if "error" in result:
            msg = result["error"]
            emit(
                {
                    "kind": "tool_result",
                    "tool": "web_search",
                    "summary": msg,
                    "status": "error",
                }
            )
            return f"WEB SEARCH ERROR for {query!r}: {msg}"
        results = result.get("results", [])
        if not results:
            emit({"kind": "tool_result", "tool": "web_search", "summary": "no results"})
            return f"No web results for {query!r}."
        # Auto-fetch the top N results' real page content — a bare snippet
        # (title/URL/200-char excerpt) is rarely enough to actually answer the
        # query. Fetched in parallel; a failed/slow fetch for one URL just
        # falls back to its snippet instead of failing the whole search.
        fetch_targets = results[: _web_search_auto_fetch()]
        fetched_pages: dict[str, str] = {}
        if fetch_targets:
            fetched = await asyncio.gather(
                *[
                    asyncio.to_thread(_fetch_for_search, r["url"], WEB_SEARCH_FETCH_CHARS)
                    for r in fetch_targets
                ],
                return_exceptions=True,
            )
            for r, body in zip(fetch_targets, fetched):
                if isinstance(body, str) and body:
                    fetched_pages[r["url"]] = body
        lines = []
        ui_items: list[dict] = []
        for r in results:
            snippet = r["snippet"]
            if len(snippet) > WEB_SEARCH_SNIPPET_MAX:
                snippet = snippet[:WEB_SEARCH_SNIPPET_MAX] + " …"
            full_body = fetched_pages.get(r["url"])
            body_for_lines = full_body if full_body else snippet
            lines.append(f"- {r['title']}\n  {r['url']}\n  {body_for_lines}")
            ui_items.append(
                {
                    "title": r["title"],
                    "url": r["url"],
                    "snippet": snippet,
                    "fetched": bool(full_body),
                }
            )
            # Persist each hit into the workspace vector store (KIND_WEB) so
            # later retrieval can recall it without re-fetching the web.
            # اختیاری: فقط اگه مدل embedding در دسترس باشه (RAG فعال).
            _ws = store
            if _ws is None and _rag_web_enabled():
                _ws = _get_web_store(root)
            if _ws is not None and _rag_web_enabled():
                try:
                    # upsert_doc → upsert_many → embed_passages (blocking inference)
                    # + sqlite writes. Offload to a thread so the event loop never
                    # blocks on embedding (same pattern as _rag_web_lookup).
                    await asyncio.to_thread(
                        _ws.upsert_doc,
                        f"web:{r['url']}",
                        KIND_WEB,
                        r.get("title", r["url"]),
                        [body_for_lines],
                        {"source_url": r["url"], "source_type": "web"},
                    )
                except Exception:  # noqa: BLE001, S110 — vector write must never break the tool
                    pass
        summary = f"{len(results)} results ({len(fetched_pages)} fetched)"
        fallbacks = result.get("fallbacks") or []
        engine = result.get("engine") or ""
        if fallbacks:
            summary += f" — fell back to {engine} after {', '.join(fallbacks)}"
        raw_results = f"WEB RESULTS for {query!r}\n" + "\n".join(lines)
        # If a dedicated "web" subagent model is configured, distill the raw
        # results into a concise answer so the main context stays lean
        # (Claude-Code-style). Otherwise return the raw results as before. On a
        # hard sub-agent failure the call falls back to the MAIN model (see
        # _run_distill) — raw results are only returned when BOTH models fail.
        if _web_runner is not None:
            try:
                res, ran_model = await _run_distill(
                    "web",
                    _web_runner,
                    "web-search distiller",
                    (
                        "You are a web-search reader. Read the quoted search results "
                        "and answer the user's query with a CONCISE summary (under "
                        "150 words) that cites the most relevant result URLs inline. "
                        "If the results cannot answer the query, say so."
                    ),
                    lambda: f"QUERY: {query}\n\nSEARCH RESULTS:\n" + "\n".join(lines),
                    timeout_total=60,
                )
                distilled = (res or "").strip()
                if distilled:
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "web_search",
                            "summary": f"{len(results)} results (distilled)",
                            "engine": engine,
                            "results": ui_items,
                            "model": str(getattr(ran_model, "model_name", "") or ""),
                        }
                    )
                    _result = f"WEB RESULTS for {query!r} (distilled)\n{distilled}"
                    cache.set(ck, _result, _web_cache_ttl())
                    return _result
            except Exception as exc:  # noqa: BLE001 — fall back to raw results
                # Both the web subagent AND the main model failed — tell the user
                # which one to fix in Settings → Subagents, then return raw
                # results as fallback.
                _ran_name = str(
                    getattr(
                        main_model if _fallback_state.get("web") else web_model,
                        "model_name",
                        "",
                    )
                    or ""
                )
                _web_note = _subagent_fail_note("web", _ran_name, exc)
                if _web_note:
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "web_search",
                            "summary": summary,
                            "engine": engine,
                            "results": ui_items,
                            "model": _ran_name,
                        }
                    )
                    return raw_results + "\n\n" + _web_note
        emit(
            {
                "kind": "tool_result",
                "tool": "web_search",
                "summary": summary,
                "engine": engine,
                "results": ui_items,
                "model": _web_runner_name,
            }
        )
        cache.set(ck, raw_results, _web_cache_ttl())
        return raw_results

    async def fetch_url_tool(url: str, full: bool = False, offset: int = 0) -> str:
        """Fetch a web page / raw file and return its extracted text (Markdown). Returns the FULL page content — no summarization, exactly like codex's `webfetch` (capped at 100k chars so one fetch can never flood the context window); pass `full=True` to lift the cap for copying source files (SKILL.md/docs/raw.githubusercontent/jsdelivr/gist URLs), or `offset=N` to page past an earlier excerpt (the truncation marker reports the next offset). Every call re-sends the whole conversation, so it costs real tokens. If you need several URLs, fire all `fetch_url` calls in the SAME turn (parallel tool calls). Before `fetch_url`, run `web_search` to find the right URL; then fetch only the URLs you actually need — not every result."""
        effective_full = bool(full)
        try:
            _fetch_offset = max(0, int(offset or 0))
        except (TypeError, ValueError):
            _fetch_offset = 0
        emit(
            {
                "kind": "tool",
                "tool": "fetch_url",
                "args": {"url": url, "full": effective_full, "offset": _fetch_offset},
            }
        )
        # fetch_url is for WEB pages / raw URLs only. The model sometimes hands
        # it a local workspace path (e.g. /Users/.../package.json) instead of the
        # `read` tool. Reject those early so it never wastes a token-expensive
        # web fetch on a file it could read directly — and steer it to the right
        # tool.
        _u = (url or "").strip()
        _parsed = urlparse(_u)
        _is_local = (
            _parsed.scheme in ("", "file")
            and (
                _u.startswith(("/", "./", "../", "~", "file:")) or os.path.isabs(_u)
            )
        )
        if _is_local:
            msg = (
                "fetch_url only fetches web pages/URLs. To read or search a LOCAL "
                "workspace file use the `read` tool (or `grep`/`glob` to search). "
                f"Received a local path instead: {_u!r}."
            )
            emit(_error_result("fetch_url", msg))
            return f"ERROR: {msg}"
        # AUTO-DETECT source files regardless of the model's `full` flag: a URL
        # that points at a raw file (markdown / text / source-code extension, or
        # a raw.githubusercontent / jsdelivr / gist host) is ALWAYS returned in
        # full. Relying on the model to remember full=True is fragile — without
        # this, a skill-install fetch would silently come back as a tiny excerpt
        # and the agent would re-fetch the same file (token blow-up, truncated
        # skills), which is exactly the bug this fixes.
        _probe = url.split("?", 1)[0].rstrip("/")
        _ext = (
            _probe.rsplit(".", 1)[-1].lower()
            if "." in _probe.rsplit("/", 1)[-1]
            else ""
        )
        _raw_hosts = (
            "raw.githubusercontent.com",
            "cdn.jsdelivr.net",
            "gist.github.com",
            "raw.fastgit.org",
        )
        _ext_full = {
            "md",
            "markdown",
            "txt",
            "text",
            "json",
            "yaml",
            "yml",
            "toml",
            "py",
            "ts",
            "tsx",
            "js",
            "jsx",
            "css",
            "html",
            "htm",
            "sh",
            "bash",
            "pdf",
            "xml",
            "svg",
            "csv",
            "r",
            "sql",
            "env",
            "ini",
            "conf",
            "cfg",
        }
        if effective_full or _ext in _ext_full or _probe.startswith(_raw_hosts):
            effective_full = True
        # اول توی RAG چک کن — اگه قبلاً ذخیره شده بود، از همون برگردون
        # (بدون صدا زدن وب). وگرنه ادامه بده و بعدش ذخیره کن.
        # فقط وقتی RAG فعاله store رو باز کن (lazy واقعی) — و خودمان بستنش
        # رو هم به عهده بگیریم تا connection sqlite + sqlite_vec نشت نکنه.
        _ws_for_lookup = store
        if _ws_for_lookup is None and _rag_web_enabled():
            _ws_for_lookup = _get_web_store(root)
        rag_hit = await _rag_web_lookup(url, _ws_for_lookup, root)
        if rag_hit and not _fetch_offset:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "fetch_url",
                    "summary": f"{len(rag_hit)} chars (rag recall)",
                }
            )
            return f"FETCHED {url} (from saved RAG)\n{rag_hit}"
        cache = _get_result_cache()
        cache_key = f"fetch:{url}"
        # Return cached page if fresh (TTL: 24h). Offset pages always
        # re-fetch so pagination slices the full text, not the cached excerpt.
        cached = cache.get(cache_key)
        if cached and not _fetch_offset:
            body = ""
            title = ""
            try:
                data = json.loads(cached)
                body = data.get("content", "")
                title = data.get("title", "")
            except (ValueError, TypeError):
                pass
            if body:
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "fetch_url",
                        "summary": f"{len(body)} chars (cached)",
                    }
                )
                return f"FETCHED {url} (cached)\nTitle: {title or 'unknown'}\n\n{body}"
        # full=True (or auto-detected source file) lifts the cap so one call is
        # enough for copying source files (SKILL.md / docs).
        _page_size = MAX_FETCH_BYTES if effective_full else FETCH_EXCERPT_CHARS
        result = await asyncio.to_thread(fetch_url, url, _page_size, _fetch_offset)
        if "error" in result:
            msg = result["error"]
            emit(_error_result("fetch_url", msg))
            return f"ERROR fetching {url}: {msg}"
        body = result.get("content", "")
        title = result.get("title", "")
        # Cache the first page only (TTL from settings — default 7 days);
        # offset pages are slices, never the cache source.
        if body and not _fetch_offset:
            try:
                cache.set(
                    cache_key,
                    json.dumps({"content": body, "title": title}, ensure_ascii=False),
                    _fetch_cache_ttl(),
                )
            except Exception:  # noqa: BLE001, S110
                pass
        # Persist the fetched page into the workspace vector store (KIND_WEB)
        # so later retrieval can recall it without re-fetching the web.
        # اختیاری: فقط اگه مدل embedding در دسترس باشه (RAG فعال).
        _ws = store
        if _ws is None and _rag_web_enabled():
            _ws = _get_web_store(root)
        if _ws is not None and body and _rag_web_enabled():
            try:
                # upsert_doc → upsert_many → embed_passages (blocking inference)
                # + sqlite writes. Offload to a thread so the event loop never
                # blocks on embedding (same pattern as _rag_web_lookup).
                await asyncio.to_thread(
                    _ws.upsert_doc,
                    f"web:{url}",
                    KIND_WEB,
                    title or url,
                    [body[: WEB_SEARCH_SNIPPET_MAX * 4]],
                    {"source_url": url, "source_type": "web"},
                )
            except Exception:  # noqa: BLE001, S110 — vector write must never break the tool
                pass

        # Return the FULL page verbatim — no summarizer, no excerpt. This is the
        # opencode/codex behavior: the tool returns raw content and the model
        # decides what to do with it. The body is already bounded by fetch_url
        # (FETCH_EXCERPT_CHARS, or MAX_FETCH_BYTES when full=True).
        emit(
            {
                "kind": "tool_result",
                "tool": "fetch_url",
                "summary": (
                    f"{len(body)} chars (offset={_fetch_offset})"
                    if _fetch_offset
                    else f"{len(body)} chars"
                ),
                "results": [{"title": title or url, "url": url, "snippet": body[:4000]}],
            }
        )
        _page_head = f"PAGE {url} (offset={_fetch_offset})\n" if _fetch_offset else f"PAGE {url}\n"
        return _page_head + (f"TITLE: {title}\n" if title else "") + body

    async def request_permission_tool(
        action: str, path: str = "", reason: str = ""
    ) -> str:
        """Request permission to read, search or act OUTSIDE the workspace root (e.g. ~/.config, /Users/..., $HOME, system paths). Call and WAIT BEFORE touching anything outside the project folder. (Skills/plans/MCP connectors come inline — never call this for them.) Also use it BEFORE installing any missing dependency (even workspace-local like `uv add`) — never just report 'not installed' and stop: ask, WAIT, then retry. GRANTED → proceed; DENIED → MUST NOT access — explain what you needed and why, then continue inside the workspace. `action` = short phrase like 'read config', 'run command'."""
        # Paths INSIDE the workspace root need no outside-workspace permission
        # prompt — the agent can read, search and act there freely. Auto-grant
        # so the UI never pops a needless dialog for in-workspace work; only
        # genuinely OUTSIDE paths (including the user data folder — writing
        # skills/plans there needs a real grant, since write_file/edit_file
        # check permit["folders"], not the read-only allow_coder bypass)
        # require the user's approval below.
        if path:
            try:
                target = resolve_safe(root, path, permit=permit)
                ws = os.path.realpath(root)
                if target == ws or target.startswith(ws + os.sep):
                    return (
                        f"PERMISSION GRANTED for {path!r}. This path is inside the workspace root, so no "
                        f"permission is needed — you may read/search/act on it directly without calling "
                        f"request_permission."
                    )
                # resolve_safe با permit موفق شد یعنی مسیر زیر یکی از پوشه‌های
                # مجازِ قبلی است — دیالوگ تکراری نشان نده، بی‌صدا مجاز کن.
                return (
                    f"PERMISSION GRANTED for {path!r}. The user already approved this folder — you may "
                    f"read/search/act under it without asking again."
                )
            except PathEscapeError:
                pass
        emit(
            {
                "kind": "tool",
                "tool": "request_permission",
                "args": {"action": action, "path": path},
            }
        )
        if permission_gates is None:
            emit(_error_result("request_permission", "permission system unavailable"))
            return "ERROR: permission system is not available."
        pid = f"p{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        permission_gates[pid] = fut
        if permission_gate_chat is not None:
            permission_gate_chat[pid] = _chat_id
        # The normalized requested folder (nearest existing parent) is computed
        # on the backend and sent along. The frontend has no filesystem access,
        # so "always allow" must record exactly this folder.
        emit(
            {
                "kind": "permission",
                "id": pid,
                "action": action,
                "path": path,
                "reason": reason,
                "folder": _requested_folder(path) if path else "",
            }
        )
        try:
            granted = await fut
        finally:
            permission_gates.pop(pid, None)
            if permission_gate_chat is not None:
                permission_gate_chat.pop(pid, None)
        if granted:
            try:
                _low_perm_action = str(action or "").lower()
                if "language server" in _low_perm_action:
                    from lsp_manager import LANGUAGE_SERVERS as _perm_lang_servers
                    from lsp_manager import grant_install_consent as _perm_grant_lsp

                    for _perm_lang in _perm_lang_servers:
                        if str(_perm_lang).lower() in _low_perm_action:
                            _perm_grant_lsp(_perm_lang)
            except Exception:  # noqa: BLE001, S110 - consent grant never breaks permission
                pass
            try:
                if permit is not None and _is_install_action(action):
                    permit["install"] = True
            except Exception:  # noqa: BLE001, S110 - install flag never breaks permission
                pass
            # Per-folder grant: instead of opening the whole outside-root space,
            # only the requested folder (nearest existing parent of the path)
            # is added to the allowed list. Other folders still need separate
            # approval.
            if permit is not None and path:
                folder = _requested_folder(path)
                if folder:
                    folders = permit.setdefault("folders", [])
                    if folder not in folders:
                        folders.append(folder)
            emit(
                {
                    "kind": "tool_result",
                    "tool": "request_permission",
                    "summary": "granted",
                }
            )
            if path:
                return (
                    f"PERMISSION GRANTED for {path!r}. The user approved THIS folder — you may now "
                    f"read/write/edit/search and run commands under it. Other outside-workspace "
                    f"folders still need a fresh request_permission."
                )
            return (
                f"PERMISSION GRANTED for {action!r}. The user approved it — you may now "
                f"complete this outside-workspace action (other outside actions still need a fresh "
                f"permission)."
            )
        emit({"kind": "tool_result", "tool": "request_permission", "summary": "denied"})
        return (
            f"PERMISSION DENIED for {path or action!r}. Do NOT access anything outside the workspace. "
            f"Tell the user what you needed and why, then continue with what you can do inside."
        )

    async def confirm_action_tool(action: str, reason: str = "") -> str:
        """Ask the user to confirm an IMPORTANT or hard-to-reverse action and WAIT: deleting/overwriting a real file, force-push/reset/rebase, dropping/truncating a DB, destructive shell (rm -rf, DROP TABLE, data-losing migration), anything not cleanly undoable. `action` = exactly what you'll do, specific (e.g. 'delete src/legacy/old-router.ts'); `reason` = one-line why. CONFIRMED → proceed. DENIED → stop, say so, ask what they'd prefer — never silently skip. Not for routine reversible edits."""
        emit({"kind": "tool", "tool": "confirm_action", "args": {"action": action}})
        if permission_gates is None:
            emit(_error_result("confirm_action", "confirmation system unavailable"))
            return "ERROR: confirmation system is not available. Do NOT proceed with the action; ask the user directly in your reply instead."
        pid = f"c{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        permission_gates[pid] = fut
        if permission_gate_chat is not None:
            permission_gate_chat[pid] = _chat_id
        emit(
            {
                "kind": "permission",
                "id": pid,
                "action": action,
                "reason": reason,
                "scope": "confirm",
            }
        )
        try:
            granted = await fut
        finally:
            permission_gates.pop(pid, None)
            if permission_gate_chat is not None:
                permission_gate_chat.pop(pid, None)
        if granted:
            try:
                _low_action = str(action or "").lower()
                if "language server" in _low_action:
                    from lsp_manager import LANGUAGE_SERVERS as _lang_servers
                    from lsp_manager import grant_install_consent as _grant_lsp

                    for _lname in _lang_servers:
                        if str(_lname).lower() in _low_action:
                            _grant_lsp(_lname)
            except Exception:  # noqa: BLE001, S110 - consent grant never breaks confirm
                pass
            try:
                if permit is not None and _is_install_action(action):
                    permit["install"] = True
            except Exception:  # noqa: BLE001, S110 - install flag never breaks confirm
                pass
            emit(
                {
                    "kind": "tool_result",
                    "tool": "confirm_action",
                    "summary": "confirmed",
                }
            )
            return f"CONFIRMED by the user: {action!r}. Proceed with it now."
        emit({"kind": "tool_result", "tool": "confirm_action", "summary": "denied"})
        return (
            f"DENIED by the user: {action!r}. Do NOT do this — stop, tell the user you stopped, and ask "
            f"what they'd like instead."
        )

    async def ask_user_tool(question: str, options: list[str] | None = None) -> str:
        """Ask the user a question mid-task and WAIT for the answer instead of guessing. Use when the request is ambiguous, has conflicting instructions, or misses a detail you can't infer — and it's your FIRST action when intent is genuinely unclear. Pass 2-5 short, mutually-exclusive `options` (few words) for multiple-choice; omit/empty for free text. Order the options by YOUR OWN preference: put the option you recommend and think is best FIRST (it becomes option #1 the user sees), then the rest in decreasing preference. One clear `question`. Not for things you can find out yourself; one question per call. Returns the user's exact answer."""
        clean_options = _clean_ask_options(options)
        emit(
            {
                "kind": "tool",
                "tool": "ask_user",
                "args": {"question": question, "options": clean_options},
            }
        )
        if ask_gates is None:
            emit(_error_result("ask_user", "ask system unavailable"))
            return "ERROR: the ask-the-user system is not available. Ask the question directly in your reply instead and wait for the user's next message."
        aid = f"a{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        ask_gates[aid] = fut
        if ask_gate_chat is not None:
            ask_gate_chat[aid] = _chat_id
        emit({"kind": "ask", "id": aid, "question": question, "options": clean_options})
        try:
            answer = await fut
        finally:
            ask_gates.pop(aid, None)
            if ask_gate_chat is not None:
                ask_gate_chat.pop(aid, None)
        if not answer:
            emit(_error_result("ask_user", "no answer"))
            return "The user submitted an empty answer. Proceed with your best judgment, note the assumption you're making, and mention you can adjust it if wrong."
        emit(
            {
                "kind": "tool_result",
                "tool": "ask_user",
                "summary": f"answered: {answer[:80]}",
            }
        )
        return f"USER ANSWERED: {answer}"

    async def _list_sites(headers: dict) -> list[dict] | str:
        """لیست سایت‌های حساب متصل؛ در صورت خطا رشتهٔ پیام خطا برمی‌گرداند."""
        import httpx

        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(
                "https://www.googleapis.com/webmasters/v3/sites",
                headers=headers,
            )
        if r.status_code >= 400:
            try:
                data = r.json()
                msg = data.get("error", {}).get("message", r.text[:200])
            except Exception:  # noqa: BLE001
                msg = r.text[:200]
            return f"Search Console sites error {r.status_code}: {msg}"
        return r.json().get("siteEntry") or []

    async def _resolve_site(
        site: str, sc_cfg: dict, headers: dict
    ) -> tuple[list[str], str | None]:
        """انتخاب کاندیدای سایت با اولویت: ۱) site گفته‌شده، ۲) siteUrl تنظیمات، ۳) auto-discover.

        خروجی: (candidates, error). اگر error پر باشد فراخواننده همان را برگرداند."""
        site_url = (sc_cfg.get("siteUrl") or "").strip()
        if site.strip():
            rows = await _list_sites(headers)
            if isinstance(rows, str):
                return [], rows
            if not rows:
                return (
                    [],
                    "No sites accessible with this account — add a verified property in Google Search Console first.",
                )
            matched = _match_site(site, rows)
            if not matched:
                available = "\n".join(f"- {s.get('siteUrl', '')}" for s in rows)
                return (
                    [],
                    (
                        f"Site '{site}' was not found among the sites this "
                        f"Google account can access. Available sites:\n{available}"
                    ),
                )
            return [matched], None
        if site_url:
            return [site_url], None
        rows = await _list_sites(headers)
        if isinstance(rows, str):
            return [], rows
        if not rows:
            return (
                [],
                "No sites accessible with this account — add a verified property in Google Search Console first.",
            )
        candidates = sorted(
            (str(s.get("siteUrl", "")).strip() for s in rows if s.get("siteUrl")),
            key=lambda u: (not u.startswith("https://"), u),
        )
        if not candidates:
            return [], "Could not determine a site URL from the connected account."
        return candidates, None

    async def _search_console_impl(
        action: str = "sites",
        start_date: str = "",
        end_date: str = "",
        row_limit: int = 10,
        url: str = "",
        site: str = "",
        feedpath: str = "",
    ) -> str:
        """Query the user's Google Search Console data.

        ACTIONS:
          - "query": search analytics (top queries, clicks, impressions, CTR,
            position) for a site over [start_date, end_date] (YYYY-MM-DD; default
            = last 28 days).
          - "inspect": URL Inspection for ``url`` — index/coverage state and WHY
            a page is/isn't indexed (noindex, robots.txt block, 404, soft-404,
            duplicate canonical, crawl errors), last crawl time.
          - "sites": ONLY when the user explicitly asks to LIST their sites, or
            you do not yet know which site to use.
          - "sitemaps": list the sitemaps submitted for a site (path, status,
            submitted/indexed URL counts).
          - "sitemap": details of ONE sitemap — pass its path via ``feedpath``
            (e.g. "https://example.com/sitemap.xml"); reports per-type submitted
            vs indexed counts, last download/submission, and any warnings/errors.

        HOW TO PICK THE SITE (IMPORTANT — read before calling):
          When the user names a domain in chat (e.g. "check the SEO of
          hamemigan.com", "inspect hamemigan.com/about", "show me queries for
          healerglobal.com"), call "query" or "inspect" DIRECTLY with
          ``site="hamemigan.com"`` — do NOT call "sites" first. The tool matches
          that domain against the connected account's verified properties
          automatically, so you never need to pre-set the site in Settings.
          ``site`` accepts "hamemigan.com", "sc-domain:hamemigan.com", or a full
          URL like "https://www.hamemigan.com/".
          Only fall back to "sites" if the user never names a site and you must
          discover which properties the account can access.

        Examples (call these directly, no "sites" step first):
          - "سئوی hamemigan.com رو ببین"  -> action="query",  site="hamemigan.com"
          - "inspect hamemigan.com/about" -> action="inspect", url="https://hamemigan.com/about", site="hamemigan.com"
          - "چه سایت‌هایی وصله؟"          -> action="sites"

        Uses the Google account signed in under Settings → Auth. Without a
        signed-in account this returns a setup hint instead of failing."""
        client_id = ""
        client_secret = ""
        refresh = ""
        try:
            settings = _state_db.get_settings() or {}
        except Exception:  # noqa: BLE001
            settings = {}
        # The Search Console config under Settings → Auth (searchConsole) is
        # the single source of the OAuth trio. Gemini models authenticate with
        # an API key only, so no provider fallback exists.
        sc_cfg = settings.get("searchConsole") or {}
        client_id = decrypt_secret(sc_cfg.get("clientId") or "")
        client_secret = decrypt_secret(sc_cfg.get("clientSecret") or "")
        refresh = decrypt_secret(sc_cfg.get("refreshToken") or "")
        if not (client_id and client_secret and refresh):
            return "Google Search Console is not signed in — connect your Google account in Settings → Auth."
        try:
            token = await _providers.google_access_token(
                client_id, client_secret, refresh
            )
        except Exception as exc:  # noqa: BLE001
            return f"Search Console auth failed: {exc} — reconnect the Google account in Settings → Auth."
        import httpx

        headers = {"Authorization": f"Bearer {token}"}
        try:
            if action == "sites":
                async with httpx.AsyncClient(timeout=20.0) as client:
                    r = await client.get(
                        "https://www.googleapis.com/webmasters/v3/sites",
                        headers=headers,
                    )
                data = r.json()
                if r.status_code >= 400:
                    return f"Search Console sites error {r.status_code}: {data.get('error', {}).get('message', r.text[:200])}"
                rows = data.get("siteEntry") or []
                lines = [f"- {s.get('siteUrl', '')}" for s in rows]
                return (
                    (f"Search Console sites ({len(lines)}):\n" + "\n".join(lines))
                    if lines
                    else "No sites accessible with this account."
                )
            if action == "query":
                import datetime
                import urllib.parse

                today = datetime.datetime.now(datetime.timezone.utc).date()
                try:
                    e = datetime.date.fromisoformat(end_date) if end_date else today
                except ValueError:
                    return "Invalid end_date — use YYYY-MM-DD."
                try:
                    s = (
                        datetime.date.fromisoformat(start_date)
                        if start_date
                        else e - datetime.timedelta(days=27)
                    )
                except ValueError:
                    return "Invalid start_date — use YYYY-MM-DD."
                candidates, site_err = await _resolve_site(site, sc_cfg, headers)
                if site_err:
                    return site_err
                body = {
                    "startDate": s.isoformat(),
                    "endDate": e.isoformat(),
                    "dimensions": ["query"],
                    "rowLimit": max(1, min(int(row_limit or 10), 25)),
                }
                # The GSC API expects `sites/{siteUrl}` to be URL-encoded — the
                # value is "https://example.com/" or "sc-domain:example.com",
                # whose `:` and `/` must be percent-encoded in the path.
                errors: list[str] = []
                rows: list[dict] = []
                for cand in candidates:
                    site_url_enc = urllib.parse.quote(cand, safe="")
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        r = await client.post(
                            f"https://www.googleapis.com/webmasters/v3/sites/{site_url_enc}/searchAnalytics/query",
                            headers=headers,
                            json=body,
                        )
                    if r.status_code >= 400:
                        try:
                            data = r.json()
                            msg = data.get("error", {}).get("message", r.text[:200])
                        except Exception:  # noqa: BLE001
                            msg = r.text[:200]
                        errors.append(f"{cand}: {msg}")
                        continue
                    rows = r.json().get("rows") or []
                    if rows:
                        site_url = cand
                        break
                if not rows and len(errors) == len(candidates):
                    return "Search Console query error:\n" + "\n".join(errors)
                if not rows:
                    return f"No search analytics for {site_url} between {s} and {e}."
                lines = []
                for row in rows:
                    q = (row.get("keys") or [""])[0]
                    lines.append(
                        f"- {q}: {row.get('clicks', 0)} clicks, {row.get('impressions', 0)} impressions, "
                        f"CTR {round((row.get('ctr', 0) or 0) * 100, 1)}%, pos {round(row.get('position', 0) or 0, 1)}"
                    )
                return f"Search Console ({site_url}, {s} → {e}):\n" + "\n".join(lines)
            if action == "inspect":
                import urllib.parse

                target_url = (url or "").strip()
                if not target_url:
                    return "Invalid url — the 'inspect' action needs a full page URL (e.g. https://example.com/page)."
                candidates, site_err = await _resolve_site(site, sc_cfg, headers)
                if site_err:
                    return site_err
                errors: list[str] = []
                for cand in candidates:
                    site_url_enc = urllib.parse.quote(cand, safe="")
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        r = await client.post(
                            "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
                            headers=headers,
                            json={"inspectionUrl": target_url, "siteUrl": cand},
                        )
                    if r.status_code >= 400:
                        try:
                            data = r.json()
                            msg = data.get("error", {}).get("message", r.text[:200])
                        except Exception:  # noqa: BLE001
                            msg = r.text[:200]
                        errors.append(f"{cand}: {msg}")
                        continue
                    data = r.json()
                    insp = data.get("inspectionResult") or {}
                    index = insp.get("indexStatusResult") or {}
                    verdict = insp.get("verdict", "")
                    cov_state = index.get("coverageState", "")
                    robots = index.get("robotsTxtState", "")
                    indexing_state = index.get("indexingState", "")
                    page_fetch = index.get("pageFetchState", "")
                    last_crawl = index.get("lastCrawlTime", "") or ""
                    # Map the coverageState codes to user-readable verdicts
                    # (Google's enum: notInIndex, webpageWithUserTraffic,
                    # webpageWithGoogleTraffic, webpageWithHistory, webpageInIndex,
                    # pageWithSoft404, pageWithDuplicateWithoutUserChosenCanonical,
                    # discoveredNotCrawled, crawledCurrentlyNotIndexed).
                    lines = [
                        f"URL: {target_url}",
                        f"(site: {site})",
                        f"verdict: {verdict}",
                        f"coverage: {cov_state}",
                        f"indexing: {indexing_state}",
                        f"page fetch: {page_fetch}",
                        f"robots.txt: {robots}",
                    ]
                    if last_crawl:
                        lines.append(f"last crawl: {last_crawl}")
                    # If the page isn't indexed, surface WHY (noindex/robots/404/
                    # soft-404/duplicate canonical) instead of a bare enum.
                    low_cov = cov_state.lower()
                    low_verdict = verdict.lower()
                    reasons: list[str] = []
                    if "noindex" in robots.lower():
                        reasons.append("blocked by noindex")
                    if (
                        robots.lower() == "bloqueado"
                        or "not crawled" in page_fetch.lower()
                    ):
                        reasons.append("robots.txt block / not crawled")
                    if "soft404" in low_cov or "soft 404" in low_verdict:
                        reasons.append("soft-404")
                    if "duplicate" in low_cov and "canonical" in low_cov:
                        reasons.append("duplicate without user-chosen canonical")
                    if "discovered" in low_cov and "crawl" in low_cov:
                        reasons.append("discovered but not yet crawled")
                    if "crawled" in low_cov and "not indexed" in low_cov:
                        reasons.append("crawled but not yet indexed")
                    if reasons:
                        lines.append("not-indexed reasons: " + ", ".join(reasons))
                    return "\n".join(lines)
                return "Search Console inspect error:\n" + "\n".join(errors)
            if action in ("sitemaps", "sitemap"):
                import urllib.parse

                candidates, site_err = await _resolve_site(site, sc_cfg, headers)
                if site_err:
                    return site_err
                errors: list[str] = []
                for cand in candidates:
                    site_url_enc = urllib.parse.quote(cand, safe="")
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        r = await client.get(
                            f"https://www.googleapis.com/webmasters/v3/sites/{site_url_enc}/sitemaps",
                            headers=headers,
                        )
                    if r.status_code >= 400:
                        try:
                            data = r.json()
                            msg = data.get("error", {}).get("message", r.text[:200])
                        except Exception:  # noqa: BLE001
                            msg = r.text[:200]
                        errors.append(f"{cand}: {msg}")
                        continue
                    feeds = r.json().get("sitemap") or []
                    if action == "sitemap":
                        want = (feedpath or "").strip()
                        if not want:
                            return "Invalid feedpath — the 'sitemap' action needs the sitemap path (e.g. https://example.com/sitemap.xml)."
                        feed = next(
                            (f for f in feeds if str(f.get("path", "")).strip() == want),
                            None,
                        )
                        if not feed:
                            paths = (
                                "\n".join(f"- {f.get('path', '')}" for f in feeds)
                                or "(none)"
                            )
                            return f"Sitemap '{want}' not found for {cand}. Submitted sitemaps:\n{paths}"
                        types = feed.get("contents") or []
                        type_lines = [
                            f"    - {t.get('type', '')}: {t.get('submitted', 0)} submitted, {t.get('indexed', 0)} indexed"
                            for t in types
                        ]
                        lines = [
                            f"Sitemap: {feed.get('path', '')}",
                            f"(site: {cand})",
                            f"status: {feed.get('status', '')}",
                            f"submitted: {feed.get('submitted', 0)}",
                            f"indexed (parsed): {feed.get('indexed', 0)}",
                            f"last downloaded: {feed.get('lastDownloaded', '') or 'n/a'}",
                            f"last submitted: {feed.get('lastSubmitted', '') or 'n/a'}",
                            f"warnings: {feed.get('warnings', '') or 'n/a'}",
                            f"errors: {feed.get('errors', '') or 'n/a'}",
                        ]
                        if type_lines:
                            lines.append("per-type URL counts:")
                            lines.extend(type_lines)
                        return "\n".join(lines)
                    # action == "sitemaps"
                    if not feeds:
                        return f"No sitemaps submitted for {cand}."
                    lines = [f"Sitemaps for {cand} ({len(feeds)}):"]
                    for f in feeds:
                        lines.append(
                            f"- {f.get('path', '')}: status={f.get('status', '')}, "
                            f"{f.get('submitted', 0)} submitted, {f.get('indexed', 0)} indexed"
                        )
                    return "\n".join(lines)
                return "Search Console sitemaps error:\n" + "\n".join(errors)
            return f"Unknown search_console action {action!r} — use 'sites', 'query', 'inspect', 'sitemaps' or 'sitemap'."
        except Exception as exc:  # noqa: BLE001
            return f"Search Console request failed: {exc}"

    async def search_console_tool(
        action: str = "sites",
        start_date: str = "",
        end_date: str = "",
        row_limit: int = 10,
        url: str = "",
        site: str = "",
        feedpath: str = "",
    ) -> str:
        """Query the user's Google Search Console data (see ``_search_console_impl``)."""
        emit(
            {
                "kind": "tool",
                "tool": "search_console",
                "args": {
                    "action": action,
                    "start_date": start_date,
                    "end_date": end_date,
                    "url": url,
                    "site": site,
                    "feedpath": feedpath,
                },
            }
        )
        result = await _search_console_impl(
            action=action,
            start_date=start_date,
            end_date=end_date,
            row_limit=row_limit,
            url=url,
            site=site,
            feedpath=feedpath,
        )
        is_err = result.startswith(
            (
                "Google Search Console is not signed in",
                "Search Console auth failed",
                "Search Console sites error",
                "Search Console query error",
                "Search Console request failed",
                "Search Console sitemaps error",
                "Invalid ",
                "Unknown search_console",
            )
        )
        emit(
            {
                "kind": "tool_result",
                "tool": "search_console",
                "summary": (result[:400] + "…") if len(result) > 400 else result,
                "status": "error" if is_err else "done",
            }
        )
        return result

    # ——— Git tools ———
    # Narrow, argument-validated git wrappers (no shell, list-argv subprocess
    # only — see git_tools.py). They bypass the terminal's git-write blacklist
    # on purpose: the model can commit without shelling out, and the mode
    # filter (graph.filter_tools_for_mode) keeps git_commit build-only.
    async def git_status_tool() -> str:
        """Show the git working-tree status: current branch and every modified/staged/untracked file. Use this before committing or when the user asks what changed."""
        emit({"kind": "tool", "tool": "git_status", "args": {}})
        result = _git.git_status(root)
        text = json.dumps(result, ensure_ascii=False, default=str)
        emit({"kind": "tool_result", "tool": "git_status", "summary": text[:400], "status": "error" if "error" in result else "done"})
        return text

    async def git_diff_tool(path: str = "", staged: bool = False) -> str:
        """Show the unified diff of the workspace's uncommitted changes (or the staged changes when `staged` is true). Optionally restrict to one `path`."""
        emit({"kind": "tool", "tool": "git_diff", "args": {"path": path, "staged": staged}})
        result = _git.git_diff(root, path, staged)
        text = json.dumps(result, ensure_ascii=False, default=str)
        emit({"kind": "tool_result", "tool": "git_diff", "summary": f"{len(result.get('diff', ''))} chars of diff", "status": "error" if "error" in result else "done"})
        return text

    async def git_commit_tool(message: str, add_all: bool = False) -> str:
        """Commit the staged changes with `message` (required, non-empty). When `add_all` is true, stage every change first (git add -A). Returns the new commit hash. Never push."""
        emit({"kind": "tool", "tool": "git_commit", "args": {"message": message, "add_all": add_all}})
        result = _git.git_commit(root, message, add_all)
        text = json.dumps(result, ensure_ascii=False, default=str)
        emit({"kind": "tool_result", "tool": "git_commit", "summary": result.get("commit") or result.get("error", ""), "status": "error" if "error" in result else "done"})
        return text

    async def git_log_tool(limit: int = 20) -> str:
        """List the most recent git commits (hash, date, subject), newest first. Use this when the user asks about commit history."""
        emit({"kind": "tool", "tool": "git_log", "args": {"limit": limit}})
        result = _git.git_log(root, limit)
        text = json.dumps(result, ensure_ascii=False, default=str)
        emit({"kind": "tool_result", "tool": "git_log", "summary": f"{len(result.get('commits', []))} commits", "status": "error" if "error" in result else "done"})
        return text

    async def current_time_tool() -> str:
        """Return the current UTC date and time. Call this when the user asks about 'today', 'now', 'current date', 'recent', 'latest', or any time-sensitive question where you need the actual current timestamp."""
        import datetime as _dt

        emit({"kind": "tool", "tool": "current_time", "args": {}})
        now = _dt.datetime.now(_dt.timezone.utc)
        text = json.dumps(
            {
                "utc": now.isoformat(),
                "utc_date": now.strftime("%Y-%m-%d"),
                "utc_time": now.strftime("%H:%M:%S"),
                "weekday": now.strftime("%A"),
                "unix": int(now.timestamp()),
            }
        )
        emit({"kind": "tool_result", "tool": "current_time", "summary": now.strftime("%Y-%m-%d %H:%M UTC"), "status": "done"})
        return text

    async def computer_tool(
        action: str,
        app: str = "",
        selector: str = "",
        do: str = "",
        value: str = "",
        x: int | None = None,
        y: int | None = None,
        x2: int | None = None,
        y2: int | None = None,
        key: str = "",
        held: str = "",
        text: str = "",
        dx: int = 0,
        dy: int = 0,
        depth: int = 14,
        steps: list | None = None,
        annotate: bool = False,
        selector2: str = "",
        region: list | None = None,
    ) -> str:
        """Control desktop apps on macOS/Windows/Linux through the OS Accessibility Tree (the same approach the Codex app uses — element-based, not screenshots). Read actions need no permission; MUTATING actions (act / input / sequence) ask the user once per turn.

        ACTIONS:
          - "read_screen": dump the accessibility tree of the target app as an
            indented, model-readable text. Use ``app`` to target a named app;
            default = the foreground app. ``depth`` caps tree depth (default 14)
            to keep the output lean. Read this FIRST when you don't know where
            an element is; the dump stays in context so one read serves many
            later actions on the same screen.
          - "read_element": dump ONLY the subtree of the element matched by
            ``selector`` (``depth`` caps subtree depth, default 6) — much
            cheaper than read_screen when you already know the container.
          - "list_apps": list running apps (to pick an ``app`` target).
          - "open_app": activate (or launch) the app named ``app`` — brings
            its window to front without moving the mouse.
          - "act": run a semantic action on an element matched by ``selector``.
            ``do`` is one of: press, focus, toggle, expand, collapse, select,
            show_menu, scroll_into_view, increment, decrement, set_value,
            set_numeric_value, type_text, minimize, maximize, restore, close.
            do='click' is also accepted here as an alias for 'press' (clicking
            a button/item IS pressing it semantically) — you do not need to
            switch to "input" just because the instruction says "click".
            ``set_value``/``type_text`` need ``value``. For do='type_text' you
            MUST set ``app`` (keyboard events go to the focused app); prefer
            do='set_value' when the element accepts direct value writes.
          - "input": synthesized mouse/keyboard fallback — use ONLY when no
            semantic action fits (drag, scroll, global shortcut, canvas).
            ``do`` is one of: click, double_click, right_click, move_to, drag,
            scroll, press_key, chord, type_text. For click/double_click/
            right_click/move_to/drag/scroll pass ``selector`` — the element's
            OWN bounds centre is used, so it lands exactly on target with no
            coordinate math at all (WORKS FOR ANY APP with an AX tree). Coordinates
            are only for points that are not an element (a canvas pixel, empty
            desktop, or any app's arbitrary point): x/y are LOGICAL screen points
            (same space as element bounds and the ``center=`` values in
            read_screen/read_element output). If you just called ``see``, you may
            ALSO pass raw pixels from that image — they are auto-converted via
            ``origin + pixel/image_scale_x/y`` using the last screenshot's metadata,
            so no manual division is needed. Omitting a needed target is an
            error, never a silent click at (0,0). For ``drag`` the end point is
            ``selector2`` or x2/y2. If ``app`` is set it is activated first so
            events reach the right app; for keyboard kinds (type_text/
            press_key/chord) ``app`` is REQUIRED. Non-ASCII text (e.g. Persian)
            is typed via the clipboard automatically. KEY NAMES: named keys use
            their Pascal name ('Enter', 'Tab', 'Escape', 'ArrowUp', 'F5');
            printable characters are literal and lowercase ('a', '1') — NEVER
            'command+t' or 'cmd+n'. For combos use do='chord' with key='t' and
            held='Meta' (valid modifiers: Meta, Ctrl, Alt, Shift).
          - "sequence": run MULTIPLE input steps back-to-back in ONE call —
            click then type then press Enter, without losing focus between
            steps. Works for ANY app/window. If ``app`` is set it is activated
            first so events reach the right app; for keyboard steps
            (type_text/press_key/chord) ``app`` is REQUIRED. ``steps`` is a list
            of dicts, each with "kind" (click, double_click, right_click,
            move_to, drag, scroll, press_key, chord, type_text, wait) plus that
            kind's params — pointer kinds take "selector" (preferred; "selector2"
            for the drag end) or x/y (x2/y2 for drag) in LOGICAL points OR raw
            pixels from the last ``see`` (auto-converted as in ``input``);
            keyboard kinds take key/held/text; scroll takes dx/dy; wait takes
            "ms". Key names are Pascal for named keys ('Enter', 'ArrowUp') and
            literal lowercase for characters ('t'); combos go through
            kind='chord' with key='t' held='Meta' (modifiers: Meta, Ctrl, Alt,
            Shift). A 150ms gap is inserted between steps by default; override
            per-step with "gap_ms". If a step fails, the rest are skipped and
            "failed_at" is returned. IMPORTANT: multiple input steps must go
            through ONE sequence call — separate calls lose focus between steps.
          - "see": capture a screenshot and analyze it with the user's vision
            model (Settings → Tools → Vision model). With no ``selector``/``region``,
            ``app`` alone captures that app's window (works for ANY app — Finder,
            Chrome, VSCode, Terminal, Word — via window/dialog fallback); otherwise
            captures the selector element or ``region``. ``value`` is the analysis
            prompt (default: describe visible text, UI elements and positions).
            ``region`` is ``[x, y, width, height]`` in LOGICAL screen points
            (same space as element bounds) — mutually exclusive with
            ``selector``. ``annotate=True`` draws numbered boxes over all
            interactive elements and returns a legend mapping each number to its
            selector plus its logical bounds/centre — use it to bridge pixel view
            and the accessibility tree and then click via selector (precise for any
            app). The result reports ``image_width``/``image_height`` (pixels the
            vision model saw), ``image_scale_x/y`` (and legacy ``image_scale``) and
            ``origin_x/y``: next ``input``/``sequence`` may pass raw pixels and
            they are auto-converted to logical via ``origin + pixel/scale``.
            Use "see" when the tree cannot answer (terminals, canvases, images,
            video) or to verify any app visually.
          - "check_access": verify accessibility permissions; returns a
            per-OS setup hint when access is missing.

        SELECTORS are CSS-like (xa11y syntax), scoped to the target app:
          button[name='OK']          — button named exactly OK
          text_field[name^='Search'] — text field whose name starts with Search
          window >> tab              — descendant combinator
          list_item:nth(2)           — 2nd match (1-based)
        Roles are snake_case: text_field, check_box, radio_button, combo_box,
        list_item, menu_item (NOT textfield/checkbox).

        STRATEGY (important):
          1. If you can guess the element (e.g. "click the OK button"), call
             "act" DIRECTLY with a selector — no read_screen needed first.
          2. Only read_screen when you don't know the app's structure, or
             after a failed/errored action.
          3. Prefer semantic "act" over coordinate "input" — it is precise and
             doesn't move the user's mouse. When you must use "input", still
             pass a ``selector`` rather than coordinates.
          4. Multiple input steps (click → type → Enter) MUST go through ONE
             "sequence" call — separate calls lose focus between steps AND
             each separate call is a full model round-trip (hours of waste on
             long tasks). Plan the whole flow, then fire it as one sequence.
          5. Do NOT call "open_app" between steps on the same app —
             input/act/sequence activate ``app`` automatically and skip
             activation when it is already frontmost.
          6. Use "see" only when the tree cannot answer: terminals, canvases,
             images, video, or a visual check the tree cannot do. Each see is
             an extra vision-model round-trip; prefer read_screen/read_element.
          7. Never click a pixel you estimated from a screenshot when the same
             spot is an element in the tree — read_screen/read_element return
             ``targets`` with each element's exact logical centre.
          8. After an action that can reveal NEW elements (show_menu, opening
             a dropdown/combo_box/dialog/popup), call read_screen or
             read_element on that app BEFORE reaching for "see" — native
             menus/dropdowns are almost always menu_item/list_item nodes in
             the tree, so the newly-revealed options can usually be acted on
             by selector too, not just the control that opened them.
        """
        import computer_use as cu

        # The model sometimes serializes `steps` as a JSON string instead of a
        # list (the same coercion grep/glob list args already have). Parse it
        # BEFORE the emit payload and the dispatch iterate it — iterating the
        # raw string splits it into chars and `s.get(...)` raises AttributeError
        # on each of them. Unparseable/non-list input degrades to None so the
        # dispatch returns its friendly "non-empty steps list" error instead.
        if isinstance(steps, str):
            try:
                parsed = json.loads(steps)
            except (TypeError, ValueError):
                parsed = None
            steps = (
                [s for s in parsed if isinstance(s, dict)]
                if isinstance(parsed, list)
                else None
            )

        emit(
            {
                "kind": "tool",
                "tool": "computer",
                "args": {
                    "action": action,
                    "app": app,
                    "selector": selector,
                    "do": do,
                    "x": x,
                    "y": y,
                    "key": key,
                    "value": value[:100],
                    "selector2": selector2,
                    "steps": (
                        [s.get("kind", "") for s in steps] if steps else []
                    ),
                    "annotate": annotate,
                    "region": region,
                },
            }
        )

        async def _ask_permission(desc: str) -> bool:
            """نمایش دیالوگ تأیید و انتظار برای پاسخ کاربر (یک‌بار در هر turn)."""
            if permission_gates is None:
                return False
            pid = f"cp{uuid.uuid4().hex[:8]}"
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            permission_gates[pid] = fut
            emit(
                {
                    "kind": "permission",
                    "id": pid,
                    "action": desc,
                    "reason": "اجازهٔ کنترل اپ‌های دسکتاپ از طریق Accessibility Tree",
                    "scope": "computer",
                }
            )
            try:
                return await fut
            finally:
                permission_gates.pop(pid, None)

        result: dict = {}
        try:
            if action == "check_access":
                result = await asyncio.to_thread(cu.check_access)
            elif action == "read_screen":
                try:
                    _depth = cu.suggest_tree_depth(app, value or "", chat_id=_chat_id, emit=emit)
                except Exception:  # noqa: BLE001 — عمق هوشمند اختیاری است
                    _depth = depth
                if not isinstance(_depth, int) or _depth <= 0:
                    _depth = depth
                try:
                    _depth_int = int(_depth)
                except Exception:  # noqa: BLE001
                    _depth_int = int(depth)
                try:
                    _want_int = int(depth)
                except Exception:  # noqa: BLE001
                    _want_int = 14
                _use_depth = _depth_int if _want_int == 14 else _want_int
                result = await asyncio.to_thread(
                    cu.read_screen, app_name=app, max_depth=_use_depth
                )
                try:
                    _targets = result.get("targets") if isinstance(result, dict) else None
                    if isinstance(_targets, list) and _targets and (value or "").strip():
                        result["targets"] = cu.rank_actionable_targets(value or "", _targets, chat_id=_chat_id, emit=emit)
                        result["targets_ranked"] = True
                except Exception:  # noqa: BLE001, S110 — رتبه‌بندی اختیاری است
                    pass
            elif action == "read_element":
                if not selector.strip():
                    result = {"error": "read_element needs a selector."}
                else:
                    result = await asyncio.to_thread(
                        cu.read_element,
                        selector=selector,
                        app_name=app,
                        max_depth=depth,
                    )
            elif action == "list_apps":
                result = await asyncio.to_thread(cu.list_apps)
            elif action == "open_app":
                if not app.strip():
                    result = {"error": "open_app needs an app name."}
                else:
                    result = await asyncio.to_thread(cu.open_app, app_name=app)
            elif action == "see":
                from llm import llm_generate

                _vmodel = vision_model if vision_model is not None else main_model
                _vname = (
                    str(getattr(_vmodel, "model_name", "") or "")
                    if _vmodel is not None
                    else ""
                )
                question = (
                    value.strip()
                    or "Describe this screen precisely: visible text, UI "
                    "elements, their approximate positions."
                )
                _gate_key = f"{app}|{value or ''}"
                try:
                    if selector or region or _gate_key in _see_gate_rejected:
                        _tree_first = None
                    else:
                        _tree_first = await asyncio.to_thread(
                            cu.prefer_tree_over_see, value or "", app, _chat_id, emit
                        )
                except Exception:  # noqa: BLE001 — گیت اختیاری است
                    _tree_first = None
                if _tree_first is True:
                    _see_gate_rejected.add(_gate_key)
                    result = {
                        "error": (
                            "The accessibility tree is enough for this "
                            "question — call read_screen (or read_element) first; use "
                            "see only if the tree cannot answer (terminals, canvases, "
                            "images, video)."
                        )
                    }
                elif _vmodel is None:
                    result = {
                        "error": (
                            "No vision model configured — set a vision-capable "
                            "model in Settings → Tools → Vision model."
                        )
                    }
                else:
                    try:
                        shot = await asyncio.wait_for(
                            asyncio.to_thread(
                                cu.capture_screenshot,
                                app_name=app,
                                selector=selector,
                                region=tuple(region) if region else None,
                                annotate=annotate,
                            ),
                            timeout=SEE_CAPTURE_TIMEOUT,
                        )
                    except (TimeoutError, asyncio.TimeoutError):
                        shot = {
                            "error": (
                                f"screenshot capture exceeded {SEE_CAPTURE_TIMEOUT}s "
                                "and was aborted — ScreenCaptureKit likely lacks "
                                "Screen Recording consent. Grant Screen & System "
                                "Audio Recording to this app in System Settings → "
                                "Privacy & Security, then fully quit with ⌘Q and restart."
                            )
                        }
                        _log_vision_error(
                            TimeoutError(
                                f"see: capture_screenshot exceeded "
                                f"{SEE_CAPTURE_TIMEOUT}s (app={app!r}, "
                                f"region={region!r})"
                            )
                        )
                    except Exception as exc:  # noqa: BLE001
                        shot = {
                            "error": f"screenshot capture failed: "
                            f"{_log_vision_error(exc)}"
                        }
                    if "error" in shot:
                        result = shot
                    else:
                        # ذخیره برای تبدیل خودکار پیکسلِ see → منطقی در input/sequence بعدی (هر اپ، هر ناحیه)
                        _computer_last_shot.clear()
                        _computer_last_shot.update(
                            {
                                "image_width": shot.get("image_width"),
                                "image_height": shot.get("image_height"),
                                "image_scale": shot.get("image_scale"),
                                "image_scale_x": shot.get("image_scale_x", shot.get("image_scale")),
                                "image_scale_y": shot.get("image_scale_y", shot.get("image_scale")),
                                "logical_width": shot.get("logical_width"),
                                "logical_height": shot.get("logical_height"),
                                "origin_x": shot.get("origin_x", 0),
                                "origin_y": shot.get("origin_y", 0),
                            }
                        )
                        _annotate_hint = ""
                        if shot.get("legend"):
                            _annotate_hint = (
                                " Numbered boxes are drawn on interactive elements — "
                                "mention the box tag (e.g. '[1]') together with the pixel so the main agent can click via selector."
                            )
                        _sys = (
                            "You are a screen-analysis sub-agent. The main agent "
                            "captured a screenshot of the user's screen and needs "
                            "your analysis. The image you were given is EXACTLY "
                            f"{shot.get('image_width')}x{shot.get('image_height')} "
                            "pixels, origin (0,0) at the top-left corner. Reply "
                            "with a precise, concise description (under ~300 "
                            "words): exact visible text, UI elements, colors, "
                            "errors. For EVERY element the main agent might need "
                            "to click, you MUST give its approximate center as a "
                            "pixel coordinate within that exact image — e.g. "
                            "'Save button ~(342,118)'. A vague direction with no "
                            "number ('top-right', 'near the toolbar') is USELESS "
                            "to the main agent — it cannot see the image itself "
                            "and can only click the numbers you give it."
                            + _annotate_hint
                        )
                        try:
                            import hashlib as _hashlib

                            _see_payload = (
                                shot["data_uri"].encode("utf-8")
                                + b"\0"
                                + question.encode("utf-8")
                                + b"\0"
                                + _vname.encode("utf-8")
                                + (b"\1" if annotate else b"\0")
                            )
                            _see_key = _hashlib.sha256(_see_payload).hexdigest()
                        except Exception:  # noqa: BLE001 — کش best-effort
                            _see_key = None
                        _cached = (
                            _see_cache.get("result")
                            if _see_key and _see_cache.get("key") == _see_key
                            else None
                        )
                        if _cached is not None:
                            result = dict(_cached)
                            result["cached"] = True
                        else:
                            try:
                                _output, usage = await llm_generate(
                                    _vmodel,
                                    system=_sys,
                                    user=question,
                                    images=[shot["data_uri"]],
                                    sub=True,
                                    chat_id=str(_chat_id or ""),
                                )
                                if usage:
                                    emit(usage)
                            except Exception as exc:  # noqa: BLE001
                                _rejected = _is_vision_image_rejection(exc)
                                _detail = _log_vision_error(exc)
                                if _rejected:
                                    result = {
                                        "error": (
                                            f"vision model '{_vname}' rejected the "
                                            f"image: {_detail} — it is not "
                                            "vision-capable. Pick another model in "
                                            "Settings → Tools → Vision model."
                                        )
                                    }
                                else:
                                    result = {
                                        "error": f"vision analysis failed: "
                                        f"{_detail} — check Settings → Tools → "
                                        "Vision model."
                                    }
                                _output = ""
                            if "error" not in result:
                                _output = (_output or "").strip()
                                if not _output:
                                    result = {
                                        "error": "the vision model produced no analysis."
                                    }
                                else:
                                    result = {
                                        "ok": True,
                                        "analysis": _output,
                                        # ابعاد تصویرِ واقعاً دیده‌شده توسط مدل
                                        # بینایی + ضریب تبدیل به نقطهٔ منطقی
                                        "image_width": shot.get("image_width"),
                                        "image_height": shot.get("image_height"),
                                        "image_scale": shot.get("image_scale"),
                                        "image_scale_x": shot.get("image_scale_x", shot.get("image_scale")),
                                        "image_scale_y": shot.get("image_scale_y", shot.get("image_scale")),
                                        "logical_width": shot.get("logical_width"),
                                        "logical_height": shot.get("logical_height"),
                                        # مبدأ برش نسبت به کل صفحه (۰ برای full screen)
                                        "origin_x": shot.get("origin_x"),
                                        "origin_y": shot.get("origin_y"),
                                    }
                                    if shot.get("legend"):
                                        result["legend"] = shot["legend"]
                                    if shot.get("omitted"):
                                        result["omitted"] = shot["omitted"]
                                    result["hint"] = shot.get("hint", "")
                                    if _see_key and "error" not in result:
                                        _see_cache["key"] = _see_key
                                        _see_cache["result"] = dict(result)
            elif action == "act":
                if not selector.strip():
                    result = {"error": "act needs a selector — see read_screen output."}
                elif not app.strip():
                    # همیشه باید app مشخص باشد تا روی اپ اشتباهی کلیک/اکشن نشود
                    result = {
                        "error": "act needs the target app in ``app`` — always set "
                        "app (e.g. app='Google Chrome', app='Notes') so the action "
                        "runs on the correct app via its selector. First select the app, then the element."
                    }
                elif not (permit and permit.get("computer")):
                    granted = await _ask_permission(
                        f"computer: {do} {selector}" + (f" = {value[:80]}" if value else "")
                    )
                    if not granted:
                        result = {
                            "error": "permission denied — the user declined desktop control."
                        }
                    elif permit is not None:
                        # کش بلافاصله بعد از تأیید کاربر — نه بعد از موفقیت اکشن؛
                        # اکشن شکست‌خورده نباید گرانت «Always allow» را باطل کند.
                        permit["computer"] = True
                if "error" not in result and selector.strip():
                    result = await asyncio.to_thread(
                        cu.find_and_act,
                        selector=selector,
                        action=do,
                        value=value,
                        app_name=app,
                    )
            elif action == "input":
                if not app.strip():
                    # هر input (حتی click) روی اپ فوکوس‌شده می‌رود — بدون app، روی اپ اشتباهی می‌نشیند
                    result = {
                        "error": f"input with do={do!r} needs the target app in "
                        "``app`` — always set app (e.g. app='Google Chrome') so the "
                        "tool activates the correct app first. Selector (if any) is then scoped to that app."
                    }
                elif not (permit and permit.get("computer")):
                    # توصیف مقصد: selector دقیق‌تر از مختصات است و کاربر باید
                    # بفهمد قرار است روی چه چیزی کنترل داده شود
                    where = f"on {selector}" if selector.strip() else ""
                    if not where and x is not None and y is not None:
                        where = f"at ({x},{y})"
                    granted = await _ask_permission(
                        f"computer: {do} {where}".strip()
                        + (f" = {key or text[:60]}" if key or text else "")
                    )
                    if not granted:
                        result = {
                            "error": "permission denied — the user declined desktop control."
                        }
                    elif permit is not None:
                        permit["computer"] = True
                if "error" not in result:
                    # تبدیل خودکار پیکسلِ see → منطقی (هر اپ/هر ناحیه)
                    # فقط وقتی selector خالی است؛ وگرنه xa11y خودش مرکز bounds را می‌زند
                    conv_x, conv_y = x, y
                    conv_x2, conv_y2 = x2, y2
                    if not selector.strip():
                        conv_x, conv_y = _convert_pixel_to_logical(x, y)
                    if not selector2.strip():
                        conv_x2, conv_y2 = _convert_pixel_to_logical(x2, y2)
                    result = await asyncio.to_thread(
                        cu.input_action,
                        kind=do,
                        x=conv_x,
                        y=conv_y,
                        x2=conv_x2,
                        y2=conv_y2,
                        key=key,
                        held=held,
                        text=text,
                        dx=dx,
                        dy=dy,
                        app_name=app,
                        selector=selector,
                        selector2=selector2,
                    )
            elif action == "sequence":
                if not steps:
                    result = {"error": "sequence needs a non-empty steps list."}
                elif not app.strip():
                    # کل sequence روی اپ فوکوس‌شده اجرا می‌شود — همیشه app بده
                    result = {
                        "error": "sequence needs the target app in ``app`` — always set "
                        "app (e.g. app='Google Chrome') so the whole sequence runs on "
                        "the correct app. Select app first, then elements/coordinates."
                    }
                else:
                    kinds = [s.get("kind", "") for s in steps]
                    desc = f"sequence of {len(steps)} steps: {', '.join(kinds)}"
                    if not (permit and permit.get("computer")):
                        granted = await _ask_permission(desc)
                        if not granted:
                            result = {
                                "error": "permission denied — the user declined desktop control."
                            }
                        elif permit is not None:
                            permit["computer"] = True
                    if "error" not in result:
                        # تبدیل پیکسلِ see برای هر step مختصاتی (هر اپ)
                        _converted_steps: list[dict] = []
                        for _s in steps:
                            _ns = dict(_s)
                            _kind = str(_ns.get("kind", ""))
                            if _kind in ("click", "double_click", "right_click", "move_to", "drag", "scroll"):
                                if not str(_ns.get("selector", "") or "").strip():
                                    _cx, _cy = _convert_pixel_to_logical(_ns.get("x"), _ns.get("y"))
                                    # فقط وقتی x/y اصلی داده شده بود، مقدار تبدیل‌شده را بنویس
                                    if _ns.get("x") is not None or _ns.get("y") is not None:
                                        _ns["x"], _ns["y"] = _cx, _cy
                                if _kind == "drag" and not str(_ns.get("selector2", "") or "").strip():
                                    _cx2, _cy2 = _convert_pixel_to_logical(_ns.get("x2"), _ns.get("y2"))
                                    if _ns.get("x2") is not None or _ns.get("y2") is not None:
                                        _ns["x2"], _ns["y2"] = _cx2, _cy2
                            _converted_steps.append(_ns)
                        result = await asyncio.to_thread(
                            cu.run_sequence, steps=_converted_steps, app_name=app
                        )
            else:
                result = {
                    "error": (
                        f"Unknown action {action!r} — use read_screen, "
                        "read_element, list_apps, open_app, act, input, "
                        "sequence, see or check_access."
                    )
                }
        except Exception as exc:  # noqa: BLE001
            result = {"error": f"computer tool failed: {exc}"}
        text_result = json.dumps(result, ensure_ascii=False, default=str)
        emit(
            {
                "kind": "tool_result",
                "tool": "computer",
                "summary": (
                    (text_result[:400] + "…") if len(text_result) > 400 else text_result
                ),
                "status": "error" if "error" in result else "done",
            }
        )
        return text_result

    _agents_load_skills_for_tool = _load_skills_for_tool

    async def read_document_tool(path: str, sheet: str = "", pages: str = "") -> str:
        """Read a document's text. Handles PDF (per-page extraction — pass `pages` like "1-3,5" for big files), Word .docx (paragraphs and tables as markdown), Excel .xlsx/.xlsm (sheets as TSV — pass `sheet` to pick one), CSV, and any text file (txt, md, json, code). Returns the extracted text; large results are capped, so narrow with `pages`/`sheet` and read again. Scanned/image-only PDF pages contain no extractable text."""
        emit({"kind": "tool", "tool": "read_document", "args": {"path": path}})
        try:
            target = resolve_safe(root, path, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            emit(_error_result("read_document", f"invalid path: {exc}"))
            return f"ERROR reading {path}: invalid path: {exc}"
        try:
            out = await asyncio.to_thread(
                _doc_tools.read_document, target, sheet=sheet, pages=pages
            )
        except _doc_tools.DocError as exc:
            emit(_error_result("read_document", str(exc)))
            return f"ERROR reading {path}: {exc}"
        except Exception as exc:  # noqa: BLE001
            emit(_error_result("read_document", f"{type(exc).__name__}: {exc}"))
            return f"ERROR reading {path}: {type(exc).__name__}: {exc}"
        emit(
            {
                "kind": "tool_result",
                "tool": "read_document",
                "summary": f"{len(out)} chars",
            }
        )
        return out

    async def write_document_tool(
        action: str,
        path: str,
        content: str = "",
        dest: str = "",
        sheet: str = "",
        cell: str = "",
        value: str = "",
        find: str = "",
        replace: str = "",
        font: str = "",
        size: float = 0,
        bold: bool | None = None,
        color: str = "",
        rng: str = "",
        pages: str = "",
        source: str = "",
    ) -> str:
        """Create, edit or style a document file (PDF / Word / Excel / text). Actions:
        **create** — write `content` into `path`; the extension decides the format: .pdf (markdown-lite text → PDF, Persian/Arabic supported), .docx (markdown-lite: '# ' headings, '- ' bullets, '**bold**'), .xlsx (JSON rows like [["col",...],[...]] or a TSV/CSV table; `sheet` names the sheet), txt/md/csv/json/code (plain text). Creates parent folders and OVERWRITES an existing file.
        **edit** — .docx: replace every `find` with `replace` (fails loudly when `find` is not found), or append `content` (markdown-lite) when `find` is empty. .xlsx: set `cell` (e.g. "B3") to `value` on `sheet` (default first sheet), or append `content` rows (JSON/TSV/CSV) to `sheet`. .pdf: extract `pages` ("1-3,5") into `dest`, append pages of `source` into `path`, or delete `pages` from `path`.
        **style** — change formatting: .docx applies `font` (family name), `size` (pt), `bold` (true/false) and/or `color` (hex "FF0000") to the WHOLE document, or only to paragraphs containing `find`. .xlsx applies them to `cell`, a range `rng` (e.g. "A1:C10"), or the whole `sheet`. PDF styling is not supported (recreate it instead).
        Editing uploaded files (absolute paths under the app data root) is allowed. For plain text files prefer write_file/edit_file. Returns a one-line summary; errors mean NOTHING was changed."""
        emit(
            {
                "kind": "tool",
                "tool": "write_document",
                "args": {"action": action, "path": path},
            }
        )
        if action not in ("create", "edit", "style"):
            msg = "action must be 'create', 'edit' or 'style'"
            emit(_error_result("write_document", msg))
            return f"ERROR: {msg}"
        # allow_coder: editing UPLOADED documents in the app data root is a
        # first-class flow ("change the font of my Word file"); other paths
        # outside the workspace still need the permit policy.
        try:
            target = resolve_safe(root, path, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            emit(_error_result("write_document", f"invalid path: {exc}"))
            return f"ERROR writing {path}: invalid path: {exc}"
        kwargs: dict = {"path": target}
        if action == "create":
            fn = _doc_tools.create_document
            kwargs.update(content=content, sheet=sheet)
        elif action == "style":
            fn = _doc_tools.style_document
            kwargs.update(
                font=font,
                size=size,
                bold=bold,
                color=color,
                find=find,
                sheet=sheet,
                cell=cell,
                rng=rng,
            )
        else:
            fn = _doc_tools.edit_document
            kwargs.update(
                content=content,
                dest=dest,
                sheet=sheet,
                cell=cell,
                value=value,
                find=find,
                replace=replace,
                pages=pages,
                source=(
                    resolve_safe(root, source, allow_coder=True, permit=permit)
                    if source
                    else ""
                ),
            )
        try:
            summary = await asyncio.to_thread(fn, **kwargs)
        except _doc_tools.DocError as exc:
            emit(_error_result("write_document", str(exc)))
            return f"ERROR: {exc}"
        except Exception as exc:  # noqa: BLE001
            emit(_error_result("write_document", f"{type(exc).__name__}: {exc}"))
            return f"ERROR: {type(exc).__name__}: {exc}"
        emit(
            {
                "kind": "tool_result",
                "tool": "write_document",
                "summary": summary,
                # The viewer live-refreshes on this path (store.bumpDocRev).
                "path": path,
            }
        )
        return summary

    async def lsp_definition_tool(filePath: str, line: int = 1, character: int = 0, symbol: str = "") -> str:
        """Jump to the definition of the symbol at a position (LSP).

        Uses the lazily-started language server for the file type — no
        workspace scan. `line` is 1-based, `character` is 0-based. Pass
        `symbol` (identifier text on that line) to resolve the column from
                the line text instead of guessing `character`; without a symbol the
                column snaps to the nearest identifier on the line (keywords
                skipped), so an approximate `character` still resolves.
        Returns `path:line:character` locations (small hit lists inline the definition body so no follow-up read is needed). Empty means the server
        answered with no locations (genuine miss); timeout/dead/missing are
        ERRORs with a precise next action, never a silent empty."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        emit(
            {
                "kind": "tool",
                "tool": "lsp_definition",
                "args": {"filePath": filePath, "line": line, "character": character, "symbol": symbol},
                "model": _main_name,
            }
        )
        try:
            target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("lsp_definition", msg))
            return f"ERROR: {msg}"
        _lsp_lang = _lsp_announce_start(target)
        try:
            _note_search_surfaced(_chat_id, [str(filePath or "")])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        _line_no, _char_no = await _lsp_resolve_position(target, int(line or 1), int(character or 0), str(symbol or ""))
        try:
            hits = await _lsp_call_with_wait(target, "definition", target, _line_no, _char_no)
        except Exception as exc:  # noqa: BLE001
            _lsp_announce_done(_lsp_lang, False)
            _msg = _lsp_error_text("lsp_definition", filePath, _line_no, _char_no, exc)
            emit(_error_result("lsp_definition", _msg))
            return _msg
        _lsp_announce_done(_lsp_lang, True)
        if not hits:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "lsp_definition",
                    "summary": "no definition found",
                    "model": _main_name,
                }
            )
            try:
                from lsp_manager import get_manager as _get_lsp_mgr_hint

                _mgr = _get_lsp_mgr_hint(root)
                _state = _mgr.server_state(target)
                _lang = _mgr.language_for(target) or ""
                _hint = _mgr.install_hint(_lang) if _state == "missing" and _lang else ""
            except Exception:  # noqa: BLE001 - hint is best-effort
                _hint = ""
            if _hint:
                return (
                    f"No definition found for {filePath}:{_line_no}:{_char_no} "
                    f"(server answered empty). Install hint (binary truly missing): {_hint}."
                )
            return (
                f"No definition found for {filePath}:{_line_no}:{_char_no} "
                f"(server answered empty - no definition here; try lsp_symbols for exact names, not a workspace-wide grep.)"
            )
        emit(
            {
                "kind": "tool_result",
                "tool": "lsp_definition",
                "summary": f"{len(hits)} location(s)",
                "model": _main_name,
            }
        )
        _loc_lines = [
            f"{h.get('path')}:{h.get('line')}:{h.get('character', 0)}" for h in hits
        ]
        try:
            _note_search_surfaced(_chat_id, [str(h.get("path") or "") for h in hits])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        # Inline bodies for few hits so the follow-up read is skipped.
        if len(hits) <= 3:
            try:
                from lsp_manager import get_manager as _get_lsp_mgr_defbody

                _db_mgr = _get_lsp_mgr_defbody(root)
                _db_out: list[str] = []
                for _h in hits[:3]:
                    try:
                        _h_abs = os.path.join(root, str(_h.get("path") or ""))
                        _h_ln = int(_h.get("line") or 0)
                    except (TypeError, ValueError):
                        continue
                    try:
                        _h_syms = await asyncio.to_thread(_db_mgr.document_symbols_if_running, _h_abs)
                    except Exception:  # noqa: BLE001 - one bad file never breaks definition
                        _h_syms = {}
                    _h_best = None
                    for _hn, (_hs, _he, _hk) in (_h_syms or {}).items():
                        try:
                            _hsi, _hei = int(_hs), int(_he)
                        except (TypeError, ValueError):
                            continue
                        if _hsi <= _h_ln <= _hei and (
                            _h_best is None or (_hei - _hsi) < (_h_best[2] - _h_best[1])
                        ):
                            _h_best = (_hn, _hsi, _hei)
                    if _h_best is None:
                        continue
                    _hbn, _hbs, _hbe = _h_best
                    try:
                        _h_ex = await asyncio.to_thread(
                            _read_lines_excerpt, _h_abs, _hbs,
                            min(_hbe - _hbs + 1, _DEF_BODY_MAX_LINES),
                        )
                    except Exception:  # noqa: BLE001, S112 - read never breaks definition
                        continue
                    if _h_ex.get("error") or not _h_ex.get("lines"):
                        continue
                    _h_body = "\n".join(f"{_r['line']} | {_r['text']}" for _r in _h_ex["lines"])
                    _db_out.append(
                        f"{_h.get('path')}:{_h.get('line')}:{_h.get('character', 0)} in {_hbn}\n{_h_body}"
                    )
                if _db_out:
                    return "\n\n".join(_db_out)
            except Exception:  # noqa: BLE001, S110 - inline bodies are best-effort
                pass
        return "\n".join(_loc_lines)

    async def lsp_references_tool(filePath: str, line: int = 1, character: int = 0, symbol: str = "") -> str:
        """Find references (including the declaration) for a position (LSP).

        Uses the lazily-started language server for the file type — no
        workspace scan. `line` is 1-based, `character` is 0-based. Pass
        `symbol` (identifier text on that line) to resolve the column from
                the line text instead of guessing `character`; without a symbol the
                column snaps to the nearest identifier on the line (keywords
                skipped), so an approximate `character` still resolves.
        Timeout is an ERROR with retry (never "No references found"); empty
        means the server answered with no locations. At most 40 locations
        are returned, grouped by file with a "+N more" footer; each shown
        hit carries its source line inline so no follow-up read is needed."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        emit(
            {
                "kind": "tool",
                "tool": "lsp_references",
                "args": {"filePath": filePath, "line": line, "character": character, "symbol": symbol},
                "model": _main_name,
            }
        )
        try:
            target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("lsp_references", msg))
            return f"ERROR: {msg}"
        _lsp_lang = _lsp_announce_start(target)
        try:
            _note_search_surfaced(_chat_id, [str(filePath or "")])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        _line_no, _char_no = await _lsp_resolve_position(target, int(line or 1), int(character or 0), str(symbol or ""))
        try:
            hits = await _lsp_call_with_wait(target, "references", target, _line_no, _char_no)
        except Exception as exc:  # noqa: BLE001
            _lsp_announce_done(_lsp_lang, False)
            _msg = _lsp_error_text("lsp_references", filePath, _line_no, _char_no, exc)
            emit(_error_result("lsp_references", _msg))
            return _msg
        _lsp_announce_done(_lsp_lang, True)
        if not hits:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "lsp_references",
                    "summary": "no references found",
                    "model": _main_name,
                }
            )
            return f"No references found for {filePath}:{_line_no}:{_char_no} (server answered empty)."
        _by_file: dict[str, list[dict]] = {}
        for _h in hits:
            _by_file.setdefault(str(_h.get("path") or ""), []).append(_h)
        try:
            _note_search_surfaced(_chat_id, [str(h.get("path") or "") for h in hits])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        _shown_hits = hits[:_LSP_REF_CAP]
        _hidden_n = len(hits) - len(_shown_hits)
        emit(
            {
                "kind": "tool_result",
                "tool": "lsp_references",
                "summary": f"{len(hits)} location(s) in {len(_by_file)} file(s)",
                "model": _main_name,
            }
        )
        # Inline each shown hit's source line so the model can verify the
        # call sites WITHOUT a follow-up read per file — every saved read is
        # a saved LLM round-trip (each request re-sends the whole context).
        _ref_rows: list[str] = []
        for _h in _shown_hits[:_LSP_REF_INLINE_CAP]:
            _line_txt = ""
            try:
                _h_abs = os.path.join(root, str(_h.get("path") or ""))
                _ex = await asyncio.to_thread(
                    _read_lines_excerpt, _h_abs, int(_h.get("line") or 1), 1
                )
                if not _ex.get("error") and _ex.get("lines"):
                    _line_txt = str(_ex["lines"][0].get("text") or "").strip()
            except Exception:  # noqa: BLE001 - inline text is best-effort
                _line_txt = ""
            _row = f"{_h.get('path')}:{_h.get('line')}:{_h.get('character', 0)}"
            if _line_txt:
                _row += f"  |  {_line_txt[:_LSP_REF_INLINE_MAX_CHARS]}"
            _ref_rows.append(_row)
        _out = "\n".join(_ref_rows)
        if _hidden_n > 0:
            _groups = ", ".join(f"{p} ({len(v)})" for p, v in sorted(_by_file.items())[:8])
            _out += (
                f"\n(+{_hidden_n} more across {len(_by_file)} files: {_groups} — "
                f"narrow with symbol= or read specific files.)"
            )
        return _out

    async def lsp_hover_tool(filePath: str, line: int = 1, character: int = 0, symbol: str = "") -> str:
        """Hover text (signature/docs) for a position (LSP).

        Uses the lazily-started language server for the file type — no
        workspace scan. `line` is 1-based, `character` is 0-based. Pass
        `symbol` (identifier text on that line) to resolve the column from
                the line text instead of guessing `character`; without a symbol the
                column snaps to the nearest identifier on the line (keywords
                skipped), so an approximate `character` still resolves."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        emit(
            {
                "kind": "tool",
                "tool": "lsp_hover",
                "args": {"filePath": filePath, "line": line, "character": character, "symbol": symbol},
                "model": _main_name,
            }
        )
        try:
            target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("lsp_hover", msg))
            return f"ERROR: {msg}"
        _lsp_lang = _lsp_announce_start(target)
        try:
            _note_search_surfaced(_chat_id, [str(filePath or "")])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        _line_no, _char_no = await _lsp_resolve_position(target, int(line or 1), int(character or 0), str(symbol or ""))
        try:
            text = await _lsp_call_with_wait(target, "hover", target, _line_no, _char_no)
        except Exception as exc:  # noqa: BLE001
            _lsp_announce_done(_lsp_lang, False)
            _msg = _lsp_error_text("lsp_hover", filePath, _line_no, _char_no, exc)
            emit(_error_result("lsp_hover", _msg))
            return _msg
        _lsp_announce_done(_lsp_lang, True)
        if not text:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "lsp_hover",
                    "summary": "no hover info",
                    "model": _main_name,
                }
            )
            return f"No hover info for {filePath}:{_line_no}:{_char_no} (server answered empty)."
        emit(
            {
                "kind": "tool_result",
                "tool": "lsp_hover",
                "summary": f"{len(text)} chars",
                "model": _main_name,
            }
        )
        return text

    async def lsp_symbols_tool(filePath: str, query: str = "") -> str:
        """List definitions in one file via LSP document symbols.

        Uses the lazily-started language server for the file type — no
        workspace scan. Returns `- kind name (Lstart-end)` lines. Pass
        `query` (case-insensitive name substring) to filter: big files
        return at most 400 rows plus a `(+N more)` footer, so re-call with
        a query instead of paging the whole list. When the server binary
        is missing it is installed automatically on first use — WAIT for
        the install (retry this same call) instead of searching files
        without LSP."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        emit(
            {
                "kind": "tool",
                "tool": "lsp_symbols",
                "args": {"filePath": filePath, "query": query},
                "model": _main_name,
            }
        )
        try:
            target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("lsp_symbols", msg))
            return f"ERROR: {msg}"
        _lsp_lang = _lsp_announce_start(target)
        try:
            _note_search_surfaced(_chat_id, [str(filePath or "")])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        try:
            syms = await _lsp_call_with_wait(target, "document_symbols", target)
        except Exception as exc:  # noqa: BLE001
            _lsp_announce_done(_lsp_lang, False)
            _msg = _lsp_error_text("lsp_symbols", filePath, 1, 0, exc)
            emit(_error_result("lsp_symbols", _msg))
            return _msg
        _lsp_announce_done(_lsp_lang, True)
        if not syms:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "lsp_symbols",
                    "summary": "no symbols",
                    "model": _main_name,
                }
            )
            try:
                from lsp_manager import get_manager as _get_lsp_mgr_hint_sym

                _mgr_sym = _get_lsp_mgr_hint_sym(root)
                _state_sym = _mgr_sym.server_state(target)
                _lang_sym = _mgr_sym.language_for(target) or ""
                _hint_sym = _mgr_sym.install_hint(_lang_sym) if _state_sym == "missing" and _lang_sym else ""
            except Exception:  # noqa: BLE001 - hint is best-effort
                _hint_sym = ""
            if _hint_sym:
                return (
                    f"No symbols reported for {filePath} "
                    f"(server answered empty). Install hint (binary truly missing): {_hint_sym}."
                )
            return (
                f"No symbols reported for {filePath} "
                f"(server answered empty - try grep scoped to the file for exact names.)"
            )
        rows = sorted(syms.items(), key=lambda kv: (kv[1][0], kv[1][1]))
        _want = str(query or "").strip().lower()
        if _want:
            rows = [(n, v) for n, v in rows if _want in str(n).lower()]
        _total = len(rows)
        _shown = rows[:_LSP_SYMBOLS_CAP]
        _hidden = _total - len(_shown)
        _label = f" matching {query!r}" if _want else ""
        emit(
            {
                "kind": "tool_result",
                "tool": "lsp_symbols",
                "summary": f"{_total} symbol(s){_label}",
                "model": _main_name,
            }
        )
        if not _shown:
            return (
                f"No symbols matching {query!r} in {filePath} "
                f"(file has {len(syms)} symbols). Re-call without query, or "
                f"grep scoped to this file for the exact name."
            )
        _out = "\n".join(
            f"- {kind} {name} (L{start}-{end})" for name, (start, end, kind) in _shown
        )
        if _hidden > 0:
            _out += (
                f"\n(+{_hidden} more symbols not shown — re-call with query= "
                f"to filter by name substring.)"
            )
        return _out

    async def lsp_diagnostics_tool(filePath: str) -> str:
        """Diagnostics for one file via LSP (pull, else last pushed batch).

        Uses the lazily-started language server for the file type — no
        workspace scan. Returns `path:line [severity] message` lines.
        NOTE: after write_file/edit_file this is already inlined
        deterministically in that tool's reply — do NOT call it again
        just to re-check the file you edited."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        emit(
            {
                "kind": "tool",
                "tool": "lsp_diagnostics",
                "args": {"filePath": filePath},
                "model": _main_name,
            }
        )
        try:
            target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("lsp_diagnostics", msg))
            return f"ERROR: {msg}"
        _lsp_lang = _lsp_announce_start(target)
        try:
            _note_search_surfaced(_chat_id, [str(filePath or "")])
        except Exception:  # noqa: BLE001, S110 - surfacing never breaks LSP
            pass
        try:
            diags = await _lsp_call_with_wait(target, "diagnostics", target)
        except Exception as exc:  # noqa: BLE001
            _lsp_announce_done(_lsp_lang, False)
            _msg = _lsp_error_text("lsp_diagnostics", filePath, 1, 0, exc)
            emit(_error_result("lsp_diagnostics", _msg))
            return _msg
        _lsp_announce_done(_lsp_lang, True)
        if not diags:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "lsp_diagnostics",
                    "summary": "no diagnostics",
                    "model": _main_name,
                }
            )
            return f"No diagnostics for {filePath}."
        emit(
            {
                "kind": "tool_result",
                "tool": "lsp_diagnostics",
                "summary": f"{len(diags)} diagnostic(s)",
                "model": _main_name,
            }
        )
        return "\n".join(
            f"{d.get('path')}:{d.get('line')} [{d.get('severity')}] {d.get('message')}"
            + (f" ({d.get('source')})" if d.get("source") else "")
            for d in diags
        )

    _tools = {
        "request_permission": request_permission_tool,
        "confirm_action": confirm_action_tool,
        "ask_user": ask_user_tool,
        "write_file": write_file_tool,
        "edit_file": edit_file_tool,
        "update_plan": update_plan,
        "create_skill": create_skill_tool,
        "load_skill": load_skill_tool,
        "create_mcp": create_mcp_tool,
        "grep": grep_tool,
        "glob": glob_tool,
        "read": read_tool,
        "read_document": read_document_tool,
        "write_document": write_document_tool,
        "task": task_tool,
        "task_steer": task_steer_tool,
        "task_stop": task_stop_tool,
        "web_search": web_search_tool,
        "search_console": search_console_tool,
        "fetch_url": fetch_url_tool,
        "run_terminal": terminal_tool,
        "current_time": current_time_tool,
        "computer": computer_tool,
        "git_status": git_status_tool,
        "git_diff": git_diff_tool,
        "git_commit": git_commit_tool,
        "git_log": git_log_tool,
        "lsp_definition": lsp_definition_tool,
        "lsp_references": lsp_references_tool,
        "lsp_hover": lsp_hover_tool,
        "lsp_symbols": lsp_symbols_tool,
        "lsp_diagnostics": lsp_diagnostics_tool,
    }
    # The `vision` tool is only meaningful when a dedicated vision model is
    # configured AND this turn actually carries images — otherwise the main
    # model sees the images directly (or there is nothing to analyze), so the
    # tool would only clutter the schema.
    if vision_model is not None and any(u for u in (image_uris or [])):
        _tools["vision"] = vision_tool
    # Wrap every parent tool so each invocation gets its own `call_id` context
    # (see `_emit` above) — robust to parallel same-name tools finishing out of
    # order. Sub-agent internal tools are separate `_Tool` instances, so only
    # these first-class tools are threaded per-invocation.
    return {name: _invoke(fn) for name, fn in _tools.items()}


def _normalize_site_key(value: str) -> str:
    """پاک‌سازی یک نشانی سایت/دامنه برای تطبیق یکسان.

    هر دو فرم ``sc-domain:hamemigan.com`` و ``https://www.hamemigan.com/``
    را به ``hamemigan.com`` تقلیل می‌دهد تا مقایسهٔ دامنه‌ها نیازمند تطابق
    دقیق رشته نباشد."""
    v = value.strip().lower()
    v = v.removeprefix("sc-domain:")
    v = v.removeprefix("https://").removeprefix("http://")
    v = v.removesuffix("/")
    v = v.removeprefix("www.")
    return v


def _match_site(site: str, rows: list[dict]) -> str | None:
    """تطبیق دامنهٔ خواسته‌شده با لیست سایت‌های حساب متصل.

    ``site`` می‌تواند دامنهٔ خام (``hamemigan.com``)، فرم دامنه‌ای
    (``sc-domain:hamemigan.com``) یا نشانی کامل (``https://hamemigan.com/``)
    باشد. اگر تطبیقی یافت شود، ``siteUrl`` دقیقِ ثبت‌شده در GSC را برمی‌گرداند
    (مثلاً ``sc-domain:hamemigan.com``) وگرنه ``None``."""
    want = _normalize_site_key(site)
    if not want:
        return None
    for s in rows:
        u = str(s.get("siteUrl", "")).strip()
        if not u:
            continue
        key = _normalize_site_key(u)
        if key == want or key.endswith("." + want) or want.endswith("." + key):
            return u
    return None
