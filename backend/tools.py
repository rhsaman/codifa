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
import json
import os
import posixpath
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unicodedata
import uuid
import warnings
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlparse

import checkpoints as _checkpoints
import git_tools as _git
import providers as _providers
import state_db as _state_db
from agent_registry import AGENTS, agent_system, agent_tools
from cache import Cache, cache_path_for
from secret_utils import decrypt_secret
from tool_batching import (
    coalesce_io,
    drop_ledger_path,
    fetched_windows,
    has_served_map,
    note_fetched_window,
    note_served_map,
    note_turn_call,
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
MAX_TERMINAL_OUTPUT = 30_000
TERMINAL_TIMEOUT = 120
TERMINAL_TIMEOUT_MAX = 300
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

# Formatted results include output limits in their keys. In-flight sharing
# covers only raw scans, scoped to a workspace, event loop and edit generation.
_parent_search_cache: dict[tuple[str, ...], str] = {}
_search_generations: dict[str, int] = {}
_search_inflight: dict[tuple, asyncio.Task[dict]] = {}

# Live checklist per chat (session-only, in-memory). update_plan merges the
# incoming full list with the stored one so a mid-run steer EDITS the open
# plan instead of replacing it, and completed steps are never reverted to
# pending/in_progress (the todo-redo bug). Frontend replaces its view with
# the emitted merged list (single source of truth here).
_PLAN_BY_CHAT: dict[str, list[dict]] = {}
# Mutating tool calls since the last update_plan, per chat (module-global so
# it survives across turns/callback rebuilds, unlike _plan_nudge_state).
# Powers the no-progress-repeat guard in update_plan: re-sending an unchanged
# checklist after real tool work ran means the panel is stuck.
_PLAN_MUTATING_SINCE_UPDATE: dict[str, int] = {}


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
    stale = [
        k
        for k in _parent_search_cache
        if (k[0] == "read" and norm is not None and k[1] == norm)
        or (k[0] in ("grep", "glob") and len(k) > 4 and k[4] == root)
    ]
    for k in stale:
        del _parent_search_cache[k]

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
# checks this before running; the general sub-agent's tools exclude `task` so
# nesting is impossible anyway — this is a belt-and-suspenders guard.
_SUBAGENT_DEPTH_LIMIT = 1
_TASK_DEPTH_CTX: contextvars.ContextVar[int] = contextvars.ContextVar(
    "coder_task_depth", default=0
)

# Set while a GENERAL sub-agent runs: its tool calls reuse the PARENT's tool
# functions (which emit into the same stream), and these flags make `_emit` tag
# them `sub=True` and stamp the task card's branch id on them, so they nest
# under the task card and never count against the parent's deterministic
# tool-step budget (they run in an isolated transcript, like explore's).
_SUB_AGENT_CTX: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "coder_sub_agent_ctx", default=False
)
_SUB_AGENT_BRANCH_CTX: contextvars.ContextVar[int] = contextvars.ContextVar(
    "coder_sub_agent_branch", default=0
)

# Set by agents.py after per-mode capability filtering: the parent agent's
# ACTUAL toolset for this run (write tools stripped in plan/ask, read-only
# terminal, etc.). The general sub-agent builds its tools from THIS instead of
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
    answer; `narrow=False` for general/vision sub-agents whose prompt is larger.
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


def _explore_fail_note(agent: str, model: str, exc: Exception) -> str:
    """A structured failure note for the explore sub-agent that steers the Main
    Agent AWAY from reading the whole codebase manually. Instead of a raw error
    that triggers 'find the bug yourself' behavior, it tells the Main Agent to
    re-delegate with a NARROWER scope (a specific folder/pattern/symbol) so the
    explore agent can succeed cheaply on the retry."""
    text = str(exc).strip()
    return (
        f"ERROR: the {agent} sub-agent failed ({model}): {text}. "
        "Do NOT read the whole codebase manually. Re-delegate with a NARROWER "
        "scope (name the folder/pattern/symbol) via task(subagent_type='explore')."
    )


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
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",  # tolerate non-UTF-8 bytes in terminal output
            start_new_session=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
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
        output = output[:MAX_TERMINAL_OUTPUT] + "\n... (output truncated)"
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
                "Ask the user for permission (request_permission) before installing anything."
            )
    return None


def run_terminal(
    root: str, command: str, timeout: int = TERMINAL_TIMEOUT, permit: dict | None = None
) -> dict:
    """Run a shell command in the workspace root and capture its output."""
    reason = _blocked_terminal(command)
    if reason:
        return {"command": command, "error": reason}
    if not (permit or {}).get("outside"):
        reason = _escapes_root(command, root, permit)
        if reason is None:
            reason = _writes_outside_root(command)
        if reason:
            return {
                "command": command,
                "error": f"{reason}. Ask the user for permission (request_permission) before accessing anything outside the workspace.",
            }
    try:
        code, output = _exec_terminal(command, root, min(timeout, TERMINAL_TIMEOUT_MAX))
    except OSError as exc:
        return {"command": command, "error": str(exc)}
    return {"command": command, "exit_code": code, "output": output}


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
    (full outside-workspace permission).
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
    """
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    if not os.path.exists(target):
        return {"path": path, "error": "file not found"}
    if os.path.isdir(target):
        return {"path": path, "error": "path is a directory"}
    if not _is_text_path(target):
        return {"path": path, "error": "binary file (read skipped)"}
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
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, raw in enumerate(fh, 1):
                total = lineno
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


def _laya_tool_gate(tool_name: str, query: str, chat_id: str = "", emit: Any = None) -> bool | None:
    """Score gate for expensive tools (web_search / vision / fetch_url).

    Returns True when laya confidently says the call is worthwhile, False
    when it confidently says skip, None on no-signal (caller keeps old
    behaviour). Never raises. Every handled decision is logged to chat
    trace via report_secondary so laya rows stay visible.
    """
    try:
        import laya_decide
    except Exception:  # noqa: BLE001 — laya is optional
        return None
    try:
        decision = laya_decide.score(
            {"tool": (tool_name or "")[:80], "query": (query or "")[:500]},
            f"call-{tool_name or 'tool'}",
            chat_id=str(chat_id or ""),
        )
    except Exception:  # noqa: BLE001 — gate is best-effort
        return None
    try:
        laya_decide.report_secondary(
            decision,
            route="normal",
            sub=f"tool_gate:{tool_name or 'tool'}",
            chat_id=str(chat_id or ""),
            emit=emit,
            prompt=str(query or "")[:2000],
            options=[f"call-{tool_name or 'tool'}", "skip"],
        )
    except Exception:  # noqa: BLE001, S110 — observability never breaks the gate
        pass
    try:
        if getattr(decision, "handled", False):
            return str(getattr(decision, "value", "") or "").startswith("call-")
    except Exception:  # noqa: BLE001
        return None
    return None


def _laya_distill_choice(query: str, num_results: int, total_chars: int = 0, chat_id: str = "", emit: Any = None) -> str | None:
    """گیت laya روی خلاصه‌سازی وب: «distill» / «raw» / None.

    فقط تصمیم اطراف distill (لزوم خلاصه) گرفته می‌شود، نه تولید متن.
    خروجی ``"raw"`` یعنی laya با اطمینان بالا می‌گوید نتایج خام کافی است و
    فراخواننده باید distill را رد کند؛ هر چیز دیگر یعنی رفتار قبلی ادامه یابد.
    ``total_chars`` طول کل نتایج خام است تا laya با دید کامل تصمیم بگیرد.
    هرگز استثنا بیرون نمی‌دهد.
    """
    try:
        import laya_decide
    except Exception:  # noqa: BLE001 — laya اختیاری است
        return None
    try:
        decision = laya_decide.choice(
            {
                "query": (query or "")[:300],
                "num_results": int(num_results or 0),
                "total_chars": int(total_chars or 0),
            },
            ["distill", "raw"],
            chat_id=str(chat_id or ""),
        )
    except Exception:  # noqa: BLE001 — خطا = ادامه رفتار قبلی
        return None
    try:
        laya_decide.report_secondary(
            decision,
            route="normal",
            sub="web_distill",
            chat_id=str(chat_id or ""),
            emit=emit,
            prompt=str(query or "")[:2000],
            options=["distill", "raw"],
        )
    except Exception:  # noqa: BLE001, S110 — observability never breaks the gate
        pass
    try:
        if decision.handled and str(decision.value or "") in ("distill", "raw"):
            return str(decision.value)
    except Exception:  # noqa: BLE001
        return None
    return None


def _rag_web_enabled() -> bool:
    """آیا RAG برای وب/fetch فعاله؟ (مدل embedding دانلود شده باشه)."""
    try:
        from embeddings import embedder_available

        return embedder_available()
    except Exception:  # noqa: BLE001
        return False


def _get_web_store(root: str = "") -> VectorStore | None:
    """باز کردن lazy vector store سراسری برای RAG وب/fetch.

    این store بین همهٔ ورک‌اسپیس‌ها share می‌شه (فایل ``web-rag.vectors.sqlite``).
    چون RAG وب ذاتاً سراسریه — اگه React docs رو یه بار فچ کردی، همه
    ورک‌اسپیس‌ها باید بتونن recall کنن. ``root`` صرفاً برای logging نگه داشته می‌شه.
    """
    try:
        db_path = web_rag_path_for(_state_db.vector_db_dir())
        # TTL از ragWebTtlDays بیاد نه مقدار hardcode پیش‌فرض
        s = (_state_db.get_settings() or {})
        config = {
            "ttl_days": max(1, int(s.get("ragWebTtlDays", 90))),
        }
        return VectorStore(db_path, StoreConfig.from_dict(config))
    except Exception:  # noqa: BLE001
        return None


async def _rag_web_lookup(key: str, store: VectorStore | None = None, root: str = "") -> str | None:
    """اگه قبلاً نتیجه‌ی این وب‌سرچ/fetch توی RAG ذخیره شده بود، برگردون.

    فقط وقتی مدل embedding در دسترس باشه (RAG فعال) کار می‌کنه؛ وگرنه
    ``None`` برمی‌گردونه تا مدل بره سراغ وب/فچ واقعی. هیت‌ها رو به هم
    می‌چسبونه و برمی‌گردونه. اگه چیزی نبود یا خطا داد، ``None``.
    """
    _local = False
    if store is None:
        if not _rag_web_enabled():
            return None
        # مسیر fallback نادر: باز کردن sqlite رو هم offload می‌کنیم تا
        # event loop اصلاً بلاک نشه (معمولاً store از قبل پاس داده می‌شه).
        store = await asyncio.to_thread(_get_web_store, root)
        _local = store is not None
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
    finally:
        # فقط وقتی خودمان store رو باز کردیم ببندیم؛ اگه از بیرون پاس داده
        # شده باشه مالکیتش با فراخواننده‌ست و نباید اینجا بسته بشه (نشت
        # connection sqlite + sqlite_vec توی RAM می‌مونه تا آخر عمر پروسه).
        if _local:
            store.close()


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
    runtime enforcement behind the prompt hard rule.
    """
    for label, text in (("description", description), ("content", content)):
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
        slug = (
            slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep)))
            or "workspace"
        )
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
) -> dict:
    """Persist a skill as ``skills/<slug>/skill.md`` in the user data folder.

    ``raw`` is the full skill markdown (frontmatter + body); the name and
    description are parsed from the frontmatter. The name must be English
    (ASCII) — it becomes the storage folder slug. Returns
    ``{"ok", "name", "slug", "path", "note"}`` on success.
    """
    name, description, body = _parse_skill_markdown(raw)
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
        _state_db.save_skill(name, slug, description, raw or body)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "note": f"could not save skill: {exc}"}
    if previous_name and previous_name != name:
        _state_db.delete_skill(previous_name)
    return {
        "ok": True,
        "name": name,
        "slug": slug,
        "path": os.path.join(_state_db.skills_dir(), slug, "skill.md"),
        "note": f"skill '{name}' saved",
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
    # Map name/slug -> (description, body) — the stored content is frontmatter-
    # stripped by list_skills — so a shipped change to EITHER the body or the
    # frontmatter (e.g. description) triggers a re-sync below.
    existing_meta: dict[str, tuple[str, str]] = {}
    for s in existing:
        meta = (
            (s.get("description") or "").strip(),
            (s.get("content") or "").strip(),
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
        if not name:
            name = os.path.splitext(os.path.basename(path))[0]
        if name in existing_names or slugify(name) in existing_slugs:
            # Built-in already present: re-sync only when the shipped file
            # changed, so official updates take effect. Identical copies are
            # left untouched.
            stored = existing_meta.get(name) or existing_meta.get(slugify(name))
            if stored == (description.strip(), body.strip()):
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


def create_skill(root: str, name: str, description: str, content: str) -> dict:
    """Create or edit (overwrite) a user skill (global, shared across workspaces).

    ``name`` is the display name — it must be English (ASCII) because the
    storage folder slug is derived from it. ``description`` is indexed for
    the system prompt, and ``content`` is the full markdown body. The skill
    is stored as ``skills/<slug>/skill.md`` in the user data folder. Calling
    with an existing skill's SAME ``name`` overwrites it (edit flow). The
    ``root`` argument is kept for API compatibility and is not used.
    """
    body = content.strip()
    if not body:
        body = f"Write step-by-step instructions for {name}."
    markdown = (
        "---\n"
        f"name: {name}\n"
        f"description: {description or ''}\n"
        "---\n\n"
        f"# {name}\n\n{body}\n"
    )
    result = persist_skill(markdown, fallback_name=name)
    if not result.get("ok"):
        return {"error": result.get("note", "save failed")}
    return {
        "path": result["path"],
        "name": result["name"],
        "ok": True,
        "note": result["note"],
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
    out = f"# {row.get('name')}\n"
    if desc:
        out += f"\n{desc}\n"
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
    targeted patch: read, verify ``old_string`` appears exactly once (unless
    ``replace_all``), swap it for ``new_string``, write back. This is far
    cheaper on tokens for large files and removes the failure mode where a
    full-file rewrite silently drops unrelated content.

    Raises ``EditAmbiguousError`` if ``old_string`` is not found, or is found
    more than once while ``replace_all`` is False (the caller must supply
    enough surrounding context to make the match unique).
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

    count = content.count(old_string)
    if count == 0:
        return {
            "path": path,
            "error": "old_string not found — it must match the file's current content exactly "
            "(whitespace included). Re-read the file (or the relevant lines) and copy the exact text.",
        }
    if count > 1 and not replace_all:
        return {
            "path": path,
            "error": f"old_string is not unique ({count} occurrences) — include more surrounding "
            "context to make it unique, or pass replace_all=true to replace every occurrence.",
        }

    if replace_all:
        new_content = content.replace(old_string, new_string)
    else:
        new_content = content.replace(old_string, new_string, 1)

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
    edits: list[dict],
    permit: dict | None = None,
) -> dict:
    """Apply several old_string->new_string replacements to ``path`` atomically.

    All edits run on the in-memory content in list order and the file is
    written ONCE, so N changes to the same file cost one tool call, one
    checkpoint, one diff and one verify instead of N sequential read/write
    cycles. Either every edit applies or nothing is written (atomic).
    Each item is ``{"old_string": ..., "new_string": ..., "replace_all": bool}``.
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
        replace_all = bool(item.get("replace_all", False))
        if not isinstance(old_string, str) or not isinstance(new_string, str):
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: old_string/new_string must be strings"}
        if not old_string:
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: old_string is empty"}
        if old_string == new_string:
            return {"path": path, "error": f"edit {idx + 1}/{len(edits)}: old_string and new_string are identical"}
        count = new_content.count(old_string)
        if count == 0:
            return {
                "path": path,
                "error": f"edit {idx + 1}/{len(edits)}: old_string not found — it must match the file's current content exactly "
                "(whitespace included). Re-read the file (or the relevant lines) and copy the exact text.",
            }
        if count > 1 and not replace_all:
            return {
                "path": path,
                "error": f"edit {idx + 1}/{len(edits)}: old_string is not unique ({count} occurrences) — include more surrounding "
                "context to make it unique, or pass replace_all=true to replace every occurrence.",
            }
        if replace_all:
            new_content = new_content.replace(old_string, new_string)
            total_occ += count
        else:
            new_content = new_content.replace(old_string, new_string, 1)
            total_occ += 1
    if new_content == content:
        return {"path": path, "error": "edits leave the file unchanged"}
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
# Automatic post-edit verification (Coder mode)
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


def verify_edit(root: str, path: str, permit: dict | None = None) -> str | None:
    """Best-effort post-write verification for Coder mode's write_file/edit_file.

    Dispatches by extension: .py gets an instant AST syntax check; .json gets an
    instant json.loads check; .ts/.tsx get a debounced project-wide typecheck.
    Every other extension (and any error resolving the path) returns ``None`` so
    the caller adds nothing to the tool result — this must never turn a
    successful write into a reported failure.
    """
    ext = os.path.splitext(path)[1].lower()
    try:
        target = resolve_safe(root, path, permit=permit)
    except PathEscapeError:
        return None
    if ext == ".py":
        return _verify_python_syntax(target)
    if ext == ".json":
        return _verify_json_syntax(target)
    if ext in (".ts", ".tsx"):
        return _verify_typescript(root)
    return None


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
        "tool calls — call update_plan now with the SAME full list, marking "
        "any step you've actually finished 'completed' (and the next one 'in_progress')."
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


def _glob_python(root: str, pattern: str, target: str, path: str) -> dict:
    """Python fallback for :func:`glob_files` when ripgrep is unavailable.

    Uses the stdlib ``glob`` with ``recursive=True`` so ``**`` works, then clips
    results to our usual limits (skips hidden dirs, honours ``_SKIP_DIRS``).
    """
    try:
        matches = _pyglob.glob(os.path.join(target, pattern), recursive=True)
    except (ValueError, re.error, OSError):
        return {"pattern": pattern, "matches": [], "error": f"invalid glob: {pattern}"}

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
    ``src/**/*.ts``. Uses ripgrep when available (respecting ``.gitignore``,
    skipping hidden/binary files) with a stdlib ``glob`` fallback. Returns a
    list of relative paths (``matches``), sorted.
    """
    pattern = (pattern or "").strip()
    target = resolve_safe(root, path, allow_coder=True, permit=permit)
    if not os.path.isdir(target):
        return {"pattern": pattern, "matches": [], "error": "not a directory"}
    if not pattern:
        return {"pattern": pattern, "matches": []}
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
# codex's web_fetch (100k chars); opencode returns even more (5MB) and lets the
# model's context window decide. It is not the context budget (that comes from
# the model's reported window via `tool_out_chars`) — it only bounds a single
# page so one fetch can never flood the window.
FETCH_EXCERPT_CHARS = 100_000


def fetch_url(url: str, max_chars: int = FETCH_EXCERPT_CHARS) -> dict:
    """Fetch a web page and return its extracted text.

    Returns ``{"url", "title", "content"}`` on success or ``{"url", "error"}``
    with a friendly reason otherwise. HTML is converted to Markdown (like
    opencode's webfetch) so headings/links/code/tables survive; binary /
    non-text responses are rejected; content is capped at ``max_chars`` so a
    single page can never flood the context window. The response is streamed
    and reads at most ``MAX_FETCH_BYTES``, so oversized pages are truncated
    rather than rejected wholesale. On a Cloudflare 403 the request is retried
    once with an honest User-Agent. Never raises.
    """
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"url": url, "error": "url must start with http:// or https://"}
    max_chars = max(500, min(int(max_chars or FETCH_EXCERPT_CHARS), MAX_FETCH_BYTES))
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
    if len(text) > max_chars:
        text = text[:max_chars] + "\n…(truncated)"
    return {"url": url, "title": title, "content": text}


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


# Commands that MUTATE the filesystem / system state. Used to keep the explore
# sub-agent read-only: it may inspect the codebase but must never write, delete,
# move, install, or otherwise change state (matching opencode's explore agent,
# which is allowed to run bash only for read-only inspection).
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
    whole command is treated as a write. Used to keep the explore sub-agent
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
    parallel explores all showed the same stats ("116 calls · 109.5s" on each
    card)."""
    kind = ev.get("kind", "tool_result")
    if kind == "usage":
        # Usage events carry token/cost/model fields the UI needs verbatim —
        # they are NOT tool activity, so pass them through untouched (the
        # explore sub-agent emits them through the same emit callback).
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


def _duplicate_stub(emit: Callable[[dict], None], tool: str, args: dict, main_name: str, desc: str) -> str:
    """Short-circuit a byte-identical repeat inside one turn (see note_turn_call).

    The full result is already in this turn's transcript, so re-sending it is
    pure token waste. UI events still fire (summary "duplicate") so the trace
    stays intact.
    """
    emit({"kind": "tool", "tool": tool, "args": args, "model": main_name})
    emit(
        {
            "kind": "tool_result",
            "tool": tool,
            "summary": "duplicate (already in context)",
            "model": main_name,
        }
    )
    return (
        f"DUPLICATE of this turn's earlier `{tool}` call ({desc}) — "
        "the full result is already in context above and is NOT re-sent (tokens saved). "
        "Do NOT repeat this call — continue the task."
    )


def _cross_turn_stub(emit: Callable[[dict], None], tool: str, args: dict, main_name: str, desc: str, hint: str) -> str:
    """Short-circuit a repeat of a PREVIOUS turn's call (cross-turn reuse).

    The full result is in the conversation history and every file behind it
    is byte-unchanged since, so re-sending it is pure token waste. UI events
    still fire (summary "reused") so the trace stays intact.
    """
    emit({"kind": "tool", "tool": tool, "args": args, "model": main_name})
    emit(
        {
            "kind": "tool_result",
            "tool": tool,
            "summary": "reused (previous turn, unchanged)",
            "model": main_name,
        }
    )
    return (
        f"REUSED from an earlier `{tool}` call ({desc}) — files unchanged "
        f"since, so the full result is NOT re-sent; reuse the rows in history above. {hint} "
        "Do NOT repeat this call — continue the task."
    )


async def _grep_served_rows_stub(
    root: str, scope: str, matches: list[dict], permit,
) -> str:
    """Pointer when every match of a single-file grep is already served.

    Back-to-back greps on one file (grep, read the body, grep a narrower
    term, ...) re-send rows the model already holds: the match lines sit
    inside windows served earlier this turn or in a previous turn
    (byte-unchanged). The disk scan above still ran (cheap); only the
    re-send is skipped here.

    Soundness: single-file scopes only; every match must be in that file;
    every match line ±SNIPPET_CONTEXT must be covered by served spans; a
    match on a definition's first line additionally requires its inlined
    body span to be covered (otherwise the stub would hide a body never
    shown). Tool edits drop the ledger and external edits trip the
    signature guard, so changed files always serve whole. Map-served
    paths are untrusted and never stub. Returns "" when the grep must
    serve normally. Never raises.
    """
    try:
        if not matches or not (scope or "").strip():
            return ""
        if has_served_map(scope):
            return ""
        try:
            _target = resolve_safe(root, scope, allow_coder=True, permit=permit)
        except PathEscapeError:
            return ""
        if not os.path.isfile(_target):
            return ""
        try:
            from tool_batching import cross_turn_served_spans as _spans
            from tool_batching import cross_turn_sig_changed as _changed
        except ImportError:
            return ""
        try:
            _stale = bool(_changed(root, scope))
        except Exception:  # noqa: BLE001
            _stale = False
        if _stale:
            try:
                drop_ledger_path(scope)
            except Exception:  # noqa: BLE001, S110
                pass
            return ""
        _spans_now: list[tuple[int, int]] = []
        try:
            for _a, _b in fetched_windows(scope) or []:
                _spans_now.append((int(_a), int(_b)))
        except (TypeError, ValueError):
            pass
        try:
            for _a, _b in (_spans(root, scope) or []):
                _spans_now.append((int(_a), int(_b)))
        except (TypeError, ValueError):
            pass
        if not _spans_now:
            return ""
        # Merge to a disjoint union first: summing raw spans double-counts
        # their overlaps and could claim coverage of lines never served.
        try:
            _spans_now.sort()
            _merged: list[list[int]] = []
            for _a, _b in _spans_now:
                if _merged and _a <= _merged[-1][1] + 1:
                    _merged[-1][1] = max(_merged[-1][1], _b)
                else:
                    _merged.append([_a, _b])
            _spans_now = [(int(_a), int(_b)) for _a, _b in _merged]
        except (TypeError, ValueError):
            pass
        try:
            _want = posixpath.normpath(str(scope))
        except Exception:  # noqa: BLE001
            return ""
        _lines: list[int] = []
        for _m in matches:
            try:
                if not isinstance(_m, dict):
                    return ""
                if posixpath.normpath(str(_m.get("file") or "")) != _want:
                    return ""  # a hit outside the single file — serve
                _ln = int(_m.get("line") or 0)
                if _ln <= 0:
                    return ""
                _lines.append(_ln)
            except (TypeError, ValueError):
                return ""
        if not _lines or len(_lines) > 200:
            return ""

        def _covered(_lo: int, _hi: int) -> bool:
            try:
                _lo = max(1, int(_lo))
                _need = max(1, int(_hi)) - _lo + 1
                _got = sum(
                    max(0, min(int(_hi), _b) - max(_lo, _a) + 1)
                    for _a, _b in _spans_now
                )
                return _got >= _need
            except (TypeError, ValueError):
                return False

        for _ln in _lines:
            if not _covered(_ln - SNIPPET_CONTEXT, _ln + SNIPPET_CONTEXT):
                return ""
        # Matches on a definition's first line would inline the body: hide
        # nothing unless that body span was served before too. The symbol
        # parse is mtime-cached (grammar compiles once per process).
        try:
            from symbol_index import enclosing_symbol as _enclosing
        except ImportError:
            return ""
        if _enclosing is not None:
            try:
                _hits = await asyncio.gather(
                    *(asyncio.to_thread(_enclosing, _target, _ln) for _ln in _lines)
                )
            except Exception:  # noqa: BLE001
                return ""
            for _ln, _hit in zip(_lines, _hits):
                try:
                    if _hit is None:
                        continue
                    _hs, _he = int(_hit[1]), int(_hit[2])
                except (TypeError, ValueError, IndexError):
                    continue
                if _hs == _ln and not _covered(
                    _hs, min(_he, _hs + _DEF_BODY_MAX_LINES - 1)
                ):
                    return ""
        _n = len(_lines)
        return (
            f"All {_n} match{'es' if _n != 1 else ''} for this grep under "
            f"{scope or '/'} sit on lines already served in context above — "
            f"full rows NOT re-sent; reuse them. (If those rows are no longer "
            f"in context, re-grep with a wider pattern or read exact "
            f"ranges/symbols — otherwise do NOT re-grep; continue the task.)"
        )
    except Exception:  # noqa: BLE001 — coverage never breaks a search
        return ""


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
) -> dict[str, Callable]:
    # Bind chat_id into the closure so tools (e.g. update_plan) can persist
    # per-chat state to disk via state_db. Previously chat_id was accepted but
    # never captured, so update_plan could only emit to the UI — never save.
    _chat_id = chat_id
    # snapshot بازِ این turn: اولین write در turn یک checkpoint seq جدید می‌سازد
    # و بقیه‌ی writeهای همان turn به همان seq اضافه می‌شوند (تجمیع per-turn).
    # make_tool_callbacks به‌ازای هر turn دوباره صدا زده می‌شود، پس این state
    # خودکار per-turn است و نیازی به reset دستی ندارد.
    _ckpt_open: dict = {}
    # تاریخچهٔ چت از حافظه (از graph.py پاس داده می‌شه) — برای استخراج
    # mentioned_fnames/idents جهت رتبه‌بندی CODE MAP در explore. از خوندن
    # دیسک (get_state) اجتناب می‌کنیم تا event loop بلاک نشه و کل چت‌ها اسکن
    # نشن.
    _history_for_map: list[dict] = list(history or [])
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
    # turn (e.g. 8× grep) or when explore's sub-agent emits identically-named
    # tool events into the same stream — results could resolve the wrong card,
    # leaving a genuinely-started card stuck on "running" forever.
    #
    # Parent tools carry their pairing through a `contextvars.ContextVar` set per
    # invocation: LangGraph runs parallel same-name tool calls as SEPARATE
    # async tasks (each with a copied context), and each task emits its own
    # `tool` then its own `tool_result`. Threading the id through the context
    # keeps tool→result correct even when parallel calls finish OUT of order — a
    # name-based FIFO (pop the oldest pending id) would otherwise swap the
    # results and, on a Stop, make the retried model think work was never done,
    # re-running duplicate tools.
    _call_seq = 0
    # Unique id per explore CALL: stamped on the explore card, its tool_result
    # and every sub-event so the frontend routes a call's sub-events to ITS OWN
    # card even when two task calls run concurrently (the parent can issue
    # several in one parallel-tool-calls response). Without it, both calls'
    # sub-events nest into the first running task card ("all parallel explores
    # show the same sub-searches"). One id per call — there is no fan-out into
    # multiple sub-agents anymore.
    _task_call_seq = 0
    # Sub-agent tool→result correlation: name-based FIFO keyed per
    # (parent call id, tool). Concurrent explore calls each get their own queue,
    # so out-of-order completion across calls can't swap call_ids (call 2's
    # grep result popping call 1's id would resolve the wrong child row).
    _pending_sub_calls: dict[tuple[object, str], list[int]] = {}
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
    # راه فرار دروازه laya روی see: بعد از یک رد، همان سؤال+اپ در همین نوبت
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
            # (search/web/explore distill + summarizers) — the parent's own
            # usage is emitted from agents.py, never here. Tag it `sub=True` so
            # the frontend keeps sub-agent usage out of the message badge /
            # context meter (it runs in isolated transcripts that never enter
            # the parent's context) while still accruing it into the chat-wide
            # session totals.
            ev["sub"] = True
        if _SUB_AGENT_CTX.get():
            # A GENERAL sub-agent is running: its tool calls reuse the PARENT's
            # tool functions, so tag them `sub=True` (they run in an isolated
            # transcript — never count against the parent's tool-step budget)
            # and stamp the task card's branch id so the frontend nests them
            # under that card.
            ev["sub"] = True
            _br = _SUB_AGENT_BRANCH_CTX.get()
            if _br:
                ev["branch"] = _br
        is_sub = bool(ev.get("sub"))
        if not is_sub:
            # Parent tool invocation: read the per-invocation id. The wrapper
            # below reset it to 0 so the first `tool` emit allocates a fresh id
            # and the matching `tool_result` (same invocation/context) reuses it.
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
        else:
            # Sub-agent events flowed through `_sub_emit` (tagged `sub=True`),
            # they can't be threaded per-invocation from here, so keep the
            # name-based FIFO correlation for those — keyed per (parent call id,
            # tool) so TWO concurrent explore calls (the parent can issue several
            # in one parallel-tool-calls response) don't share one FIFO
            # (out-of-order completion would otherwise swap call_ids across
            # calls). `_cur_call_id` is the explore card's own id (set when the
            # parent `tool` event was emitted in THIS call's task context).
            _fifo_key = (_cur_call_id.get() or ev.get("branch"), tool)
            if kind == "tool":
                _call_seq += 1
                ev["call_id"] = _call_seq
                _pending_sub_calls.setdefault(_fifo_key, []).append(_call_seq)
            elif kind == "tool_result":
                if _pending_sub_calls.get(_fifo_key):
                    ev["call_id"] = _pending_sub_calls[_fifo_key].pop(0)
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
                _claimed = _trace_store.claim_running_tool(
                    str(_chat_id or ""),
                    str(tool or ""),
                    bool(ev.get("sub")),
                    {
                        "ev_call_id": str(ev.get("call_id") or ""),
                        "branch": str(ev.get("branch") or ""),
                        "sub": bool(ev.get("sub")),
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
                            "status": "running",
                        },
                        model=str(ev.get("model") or ""),
                        prompt=_args_text,
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
        tool_out_chars = max(400, min(ctx // 6, 16_000))
        max(15, ctx // 600)
        max(10, ctx // 500)
        terminal_out_chars = min(MAX_TERMINAL_OUTPUT, max(1_000, tool_out_chars * 1))
    else:
        tool_out_chars = MAX_READ_BYTES
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
    # every extra step re-sends the whole context. Overlapping/adjacent
    # windows of the SAME file inside one call are merged into one block.
    # Small files / EOF are unaffected (the excerpt reader stops at EOF).
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
                if a <= merged[-1][1] + 1:
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
        # Also drop per-turn served windows: same-turn omission must not omit
        # lines served BEFORE this edit (they are stale now).
        _invalidate_read_cache_for(path, root)
        try:
            drop_ledger_path(path)
        except Exception:  # noqa: BLE001, S110 — invalidation never breaks edit
            pass
        verify_note = await asyncio.to_thread(verify_edit, root, path, permit)
        return (
            f"Successfully wrote {len(content)} characters to {path}."
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    async def update_plan(items: list[dict]) -> str:
        """Set/update your step-by-step live checklist for the CURRENT multi-step task. For trivial single-step changes skip it. Call with the full list (status='pending'), then re-call with the SAME list marking finished 'completed' and current 'in_progress'. Item: 'content' (short imperative phrase) + 'status' ('pending'|'in_progress'|'completed'). Write items in the SAME language the user is writing in. If a checklist already exists (from history or a previous update_plan), EDIT it: resend the SAME items with updated statuses, adding/removing only what the new message changed — never start a fresh duplicate list. NEVER revert a 'completed' step back to pending/in_progress. Batch update_plan with your next tool calls in the SAME step when there IS next work; a solo update_plan is fine when marking steps completed with no further tool work needed (e.g. the final tick) or creating the initial checklist."""
        emit({"kind": "tool", "tool": "update_plan", "args": {}})
        normalized: list[dict] = []
        for it in items or []:
            if not isinstance(it, dict):
                continue
            content = str(it.get("content", "")).strip()
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
            if all(it.get("status") == "completed" for it in normalized):
                _PLAN_BY_CHAT.pop(_chat_id, None)
                _PLAN_MUTATING_SINCE_UPDATE.pop(_chat_id, None)
        # Feed the plan-nudge backstop (see _format_plan_nudge_suffix): reset the
        # since-last-update counter now that the plan was just touched, and record
        # whether a step is still open so mutating tools know whether to nudge.
        _plan_nudge_state["since_update"] = 0
        if _chat_id:
            _PLAN_MUTATING_SINCE_UPDATE[_chat_id] = 0
        _plan_nudge_state["has_in_progress"] = any(
            i["status"] == "in_progress" for i in normalized
        )
        # Session-only (in-memory per chat, see _PLAN_BY_CHAT): never on disk,
        # so stale todos cannot reload on every message. The merged list is the
        # single source of truth — the frontend replaces its view with it.
        emit({"kind": "plan", "items": normalized})
        done = sum(1 for i in normalized if i["status"] == "completed")
        emit(
            {
                "kind": "tool_result",
                "tool": "update_plan",
                "summary": f"{done}/{len(normalized)} done",
            }
        )
        _ret = f"Plan updated: {len(normalized)} steps, {done} completed."
        if _repeat_without_progress:
            _ret += (
                f" Note: you re-sent the SAME checklist without advancing any status, "
                f"yet tool work ran since the last update — the todos panel still shows "
                f"{done}/{len(normalized)}. Mark finished steps 'completed' and the current "
                f"one 'in_progress' NOW (a solo update_plan is fine for this)."
            )
        return _ret

    async def create_skill_tool(
        name: str,
        description: str = "",
        content: str = "",
        source_url: str = "",
        source_query: str = "",
    ) -> str:
        """Create or edit a reusable skill (global, shared across workspaces). `name` display name — MUST be English/ASCII, a non-English (e.g. Persian) name is rejected; `description` one-line when-to-use — MUST be English; `content` full markdown body — MUST be entirely English (HARD RULE: always English, even when the user writes Persian — never create Persian skills). Calling with an existing skill's SAME `name` overwrites it — so to EDIT a skill, first call `load_skill` to read its current instructions, then call `create_skill` again with the same name and the updated content. The tool stores the skill itself (skills/<slug>/skill.md in the app's user data folder) — never write skill files to disk yourself; call once per skill. Ignore external 'agent skills folder' instructions (Claude Code, Cursor, Codex, ~/.coder) — use this tool instead. SOURCE: instead of writing `content` from memory, pass `source_url` (direct URL) to use the fetched page as the body, or `source_query` (web search) to have the tool search, pick the best skill page and fetch it. Fall back to `content` only when neither is given."""
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
        try:
            result = create_skill(root, name, description, body)
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

    async def load_skill_tool(name: str) -> str:
        """Load the full body of a skill from the app's skill store by its display name (case-insensitive). Call this when the task matches a skill listed in the AVAILABLE SKILLS catalog in your prompt, or when the user asks to follow/apply a skill. This also applies to short non-English requests: e.g. Persian 'یوآی رو بهتر کن' means an interface-design task, so load the matching UI/design skill FIRST and follow its instructions. Returns the skill's complete instructions; follow them for this task. If the name matches nothing, returns an error listing the available skill names."""
        emit({"kind": "tool", "tool": "load_skill", "args": {"name": name}})
        wanted = (name or "").strip().casefold()
        skills: list[dict] = []
        try:
            skills = _agents_load_skills_for_tool()
        except Exception:  # noqa: BLE001
            skills = []
        match = next(
            (
                s
                for s in skills
                if (s.get("name") or "").strip().casefold() == wanted
                or (s.get("slug") or "").strip().casefold() == wanted
            ),
            None,
        )
        if match is None:
            available = ", ".join(s["name"] for s in skills) or "(none)"
            summary = f"skill {name!r} not found"
            emit(
                {
                    "kind": "tool_result",
                    "tool": "load_skill",
                    "summary": summary,
                    "status": "error",
                }
            )
            return f"ERROR: skill {name!r} not found. Available skills: {available}"
        desc = (match.get("description") or "").strip()
        body = (match.get("content") or "").strip()
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
        path: str,
        old_string: str = "",
        new_string: str = "",
        replace_all: bool = False,
        edits: list[dict] | None = None,
    ) -> str:
        """Replace an exact piece of text in an existing file with new text. `old_string` must match the file's current content exactly (including whitespace/indentation) and, by default, must be unique in the file — include enough surrounding lines to make it unique. Prefer this over write_file for any change to an existing file; only use write_file for brand-new files or a full intentional rewrite.

        BATCH: to apply several changes to the SAME file, pass `edits` (a list of {"old_string","new_string","replace_all"} objects) instead of firing one edit_file call per change — all edits apply atomically in list order with ONE checkpoint/diff/verify. Either every edit applies or nothing is written."""
        emit(
            {
                "kind": "tool",
                "tool": "edit_file",
                "args": {"path": path, "replace_all": replace_all},
            }
        )
        try:
            if edits:
                result = edit_file_batch(root, path, list(edits), permit)
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
        # Also drop per-turn served windows: same-turn omission must not omit
        # lines served BEFORE this edit (they are stale now).
        _invalidate_read_cache_for(path, root)
        try:
            drop_ledger_path(path)
        except Exception:  # noqa: BLE001, S110 — invalidation never breaks edit
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

    def _grep_word_set(combined: str) -> frozenset:
        """Significant words of a combined grep pattern for overlap checks.

        Splits on non-word characters, lowercases, drops short tokens and
        pure numbers (regex operators like ``\\s`` / ``.*`` carry no signal).
        A later grep whose word set is a subset of a complete earlier search
        on the same scope can only repeat rows already in context.
        """
        try:
            return frozenset(
                w.lower()
                for w in re.split(r"[^A-Za-z0-9_]+", str(combined or ""))
                if len(w) >= 3 and not w.isdigit()
            )
        except Exception:  # noqa: BLE001 — overlap never breaks a search
            return frozenset()

    async def grep_tool(
        pattern: str,
        patterns: list[str] | None = None,
        path: str = "",
        paths: list[str] | None = None,
        include: str = "",
        includes: list[str] | None = None,
        max_results: int = 50,
    ) -> str:
        """Search file CONTENTS using a regular expression. `pattern` is a REGEX (matched case-insensitively, per line), so combine alternatives with `foo|bar` (full syntax like `function\\s+\\w+` works). BATCH: pass every extra alternative via `patterns` (a list) so they all run in the SAME call — e.g. pattern='foo', patterns=['bar','baz'] is ONE grep for 'foo|bar|baz' — NEVER fire one grep per term. `path` optionally restricts to a subdirectory (omit = whole workspace); pass `paths` (a list of extra subdirectories) to scan SEVERAL scopes in the SAME call — e.g. path='src', paths=['backend','tools'] — NEVER fire one grep per scope. `include` optionally filters files by glob, e.g. `*.ts` or `*.{ts,tsx}`; pass `includes` (a list of extra file filters) to scan SEVERAL filters in the SAME call — e.g. include='*.ts', includes=['*.py'] — NEVER fire one grep per file filter. `max_results` caps how many matches are returned (default 50). Respects .gitignore; skips hidden/binary files.

Returns each match with ±3 lines of surrounding code (the matching line marked with `>`), so you usually do NOT need a follow-up `read` just to see context — only read when you need more than ±3 lines or need to edit the file. A match ON a definition line (def/class/...) inlines the full body (up to 60 lines) instead of the snippet — do NOT follow up with `read` for those; the body is already above. Output is capped by `max_results` and the context budget; if there are more matches a truncation note tells you to narrow the search. Use this tool (NOT shell `grep`/`rg`) to find files containing specific patterns — see the SEARCH STRATEGY rule for targeted-vs-broad guidance. For an open-ended search that may require multiple rounds of grepping, delegate to the explore sub-agent (task with subagent_type='explore') instead of doing it inline."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        # Batch args sometimes arrive as JSON-encoded strings — coerce first
        # so nothing downstream iterates a string character-by-character.
        patterns = _coerce_str_list(patterns)
        paths = _coerce_str_list(paths)
        includes = _coerce_str_list(includes)
        # همه‌ی الگوها در یک regex ترکیبی → یک اسکن دیسک، یک ToolMessage.
        combined = "|".join(_dedup_patterns(pattern, patterns))
        # چند scope در همان فراخوانی: path + paths=[...] → یک grep برای همه.
        all_paths = _dedup_patterns(path, paths)
        scope = "|".join(all_paths) if len(all_paths) > 1 else path
        # چند فیلتر فایل در همان فراخوانی: include + includes=[...].
        all_includes = _dedup_patterns(include, includes)
        inc_disp = "|".join(all_includes) if len(all_includes) > 1 else include
        generation = _search_generations.get(root, 0)
        cache_key = ("grep", combined, scope, inc_disp, root, str(max_results), str(tool_out_chars))
        # Exact repeat inside this turn (generation folds in edits, so a
        # post-edit repeat re-executes): stub it, the content is in context.
        if note_turn_call(("dup", "grep", generation, combined, scope, inc_disp, str(max_results))):
            return _duplicate_stub(
                emit, "grep",
                {"pattern": combined, "path": scope, "include": inc_disp},
                _main_name, f"pattern={combined!r} under {scope or '/'}",
            )
        # Same-turn subset repeat: an earlier COMPLETE grep on this scope
        # already showed every row these words can match (subset of its
        # alternatives = subset of its rows). Stub it — re-scanning and
        # re-sending is pure token waste. Broader patterns, other scopes,
        # larger max_results, and post-edit generations still execute.
        from tool_batching import grep_cover_check as _grep_cover_check
        from tool_batching import grep_cover_note as _grep_cover_note

        _words = _grep_word_set(combined)
        _scope_key = (scope, inc_disp)
        _cover = _grep_cover_check(
            generation, _scope_key, _words, max_results, combined
        )
        if _words and _cover:
            return _duplicate_stub(
                emit, "grep",
                {"pattern": combined, "path": scope, "include": inc_disp},
                _main_name,
                f"pattern={combined!r} under {scope or '/'} is covered by "
                f"this turn's earlier grep ({_cover}) — those rows are "
                "already in context above; read exact ranges/symbols instead "
                "of re-grepping",
            )
        # Cross-turn subset repeat: a PREVIOUS turn's COMPLETE grep on this
        # scope already showed every row these words can match, and the
        # matched files are byte-unchanged since (same generation + mtimes).
        # Stub it — the rows are in history. Wider patterns, larger
        # max_results, and edits (ours or external) still execute.
        from tool_batching import cross_turn_grep_check as _cross_grep_check

        _cross_cover = (
            _cross_grep_check(root, generation, _scope_key, _words, max_results)
            if _words else ""
        )
        if _cross_cover:
            return _cross_turn_stub(
                emit, "grep",
                {"pattern": combined, "path": scope, "include": inc_disp},
                _main_name,
                f"pattern={combined!r} under {scope or '/'} was already "
                f"searched ({_cross_cover})",
                "To force a fresh scan, repeat with a wider pattern or larger max_results.",
            )
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
            # A no-match search is trivially complete: a later subset
            # pattern on this scope can match nothing either.
            _grep_cover_note(
                generation, _scope_key, _words, max_results, combined, combined
            )
            return f"No matches for {combined!r} under {scope or '/'}"
        # Single-file repeat of already-served rows (the back-to-back grep
        # ping-pong: grep, read the body, grep a narrower term on the same
        # file). The scan above ran; when every match sits on served lines,
        # only the re-send is skipped. A `tool` event already fired above,
        # so only the result event fires here (same as the cached path).
        if len(all_paths) == 1 and len(all_includes) == 1:
            try:
                _served_stub = await _grep_served_rows_stub(
                    root, all_paths[0], matches, permit,
                )
            except Exception:  # noqa: BLE001 — coverage never breaks a search
                _served_stub = ""
            if _served_stub:
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "grep",
                        "summary": "duplicate (already in context)",
                        "model": _main_name,
                    }
                )
                return _served_stub        # Output contract (spec §3, revised): each hit shows the match line plus
        # surrounding code (already computed by search_in_files above).
        # Adaptive context: full ±3 lines for up to 5 results, ±1 line when
        # more are shown, so a broad search stays within the char budget
        # without forcing a repeat grep. Capped by max_results and the
        # context budget; when truncated by EITHER cap, always note how many
        # matches were hidden so the model never mistakes a cut list for all.
        lines: list[str] = []
        total = 0
        _adaptive = 3 if min(len(matches), max_results) <= 5 else 1
        try:
            from symbol_index import enclosing_symbol as _enclosing_symbol
        except ImportError:
            _enclosing_symbol = None  # type: ignore[assignment]
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
        # Served truth for later repeats: the shown rows are now in context.
        # Record their spans (same-turn + cross-turn) so a later read/grep of
        # the same lines omits them instead of re-sending. Only SHOWN matches
        # (hidden ones were never served). Definition bodies are recorded in
        # Phase 3 where their served extents are known.
        try:
            from tool_batching import note_cross_turn_read as _note_cross_snip

            for _sm in _shown_ms:
                try:
                    _sf = str(_sm.get("file") or "")
                    _sl = int(_sm.get("line") or 0)
                    if not _sf or _sl <= 0:
                        continue
                    _slo, _shi = max(1, _sl - _adaptive), _sl + _adaptive
                    note_fetched_window(_sf, _slo, _shi)
                    _sabs = _sf if os.path.isabs(_sf) else os.path.join(root, _sf)
                    _note_cross_snip(root, _sf, _slo, _shi, _sabs, 0)
                except (TypeError, ValueError):
                    continue
        except Exception:  # noqa: BLE001, S110 — ledger never breaks a search
            pass
        # Phase 2: enclosing-symbol annotations off the event loop. The first
        # parse of a file compiles the grammar (~seconds once), later hits
        # are mtime-cached (~ms) — either way never block the tool loop.
        # Kept after the `file:line:` prefix so existing `path:line:`
        # consumers keep matching.
        if _enclosing_symbol is not None and _shown_ms:
            def _annotate_one(mm: dict) -> tuple[str, str | None]:
                try:
                    _abs = os.path.join(root, str(mm["file"]))
                    _hit = _enclosing_symbol(_abs, mm["line"])
                    if _hit is not None:
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
            _expanded = 0
            _omitted_n = 0
            _omitted: list[tuple[str, str]] = []
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
                # The inlined body is now served: record its span so later
                # repeats know these lines are in context (powers the
                # single-file served-rows stub above).
                try:
                    _bm = re.search(r"\(L(\d+)-(\d+)\)", _suffix or "")
                    _bf = str(_mm.get("file") or "")
                    if _bm and _bf:
                        _bs, _be = int(_bm.group(1)), int(_bm.group(2))
                        _bl = min(_be, _bs + _DEF_BODY_MAX_LINES - 1)
                        if _bl >= _bs:
                            note_fetched_window(_bf, _bs, _bl)
                            _babs = (
                                _bf
                                if os.path.isabs(_bf)
                                else os.path.join(root, _bf)
                            )
                            from tool_batching import (
                                note_cross_turn_read as _note_cross_body,
                            )

                            _note_cross_body(root, _bf, _bs, _bl, _babs, 0)
                except (TypeError, ValueError):
                    pass
                except Exception:  # noqa: BLE001, S110 — ledger never breaks search
                    pass
        _shown = len(lines)
        _hidden = len(matches) - _shown
        if _hidden > 0:
            note = (
                f"\nFound {len(matches)} matches.\n"
                f"Showing the first {_shown} relevant matches ({_hidden} more not shown).\n"
                "Use a narrower pattern/path or read specific files."
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
        # Complete searches (nothing hidden, no per-file cap hid hits) cover
        # later subset greps on this scope — record the word set so they stub
        # out instead of re-sending the same rows.
        if _hidden == 0 and not _capped_files:
            _grep_cover_note(
                generation, _scope_key, _words, max_results, combined, combined
            )
            # Cross-turn reuse: remember the matched files' signatures so a
            # later turn's repeat stubs out while they are unchanged.
            from tool_batching import note_cross_turn_grep as _cross_grep_note

            try:
                _cross_files: list[str] = []
                for _m in matches:
                    _mf = _m.get("file") if isinstance(_m, dict) else None
                    if not _mf:
                        continue
                    _ma = (
                        str(_mf)
                        if os.path.isabs(str(_mf))
                        else os.path.join(root, str(_mf))
                    )
                    if _ma not in _cross_files:
                        _cross_files.append(_ma)
                _cross_grep_note(
                    root, generation, _scope_key, _words, max_results, combined,
                    f"{len(matches)} matches in "
                    f"{len({_m.get('file') for _m in matches if isinstance(_m, dict)})} files",
                    _cross_files,
                )
            except Exception:  # noqa: BLE001, S110 — reuse never breaks a search
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
        return raw

    async def terminal_tool(command: str, timeout: int = TERMINAL_TIMEOUT) -> str:
        """Run a shell command in the workspace root and return its output. The command runs with the project folder as the working directory, is killed after `timeout` seconds (default 120), and privileged/system-destructive commands (sudo, rm -rf /, mkfs, reboot, piping into a shell, ...) are blocked. Use this for git, package managers, build/run/lint/test commands and other project operations. NEVER use it to create, edit or delete files — use write_file for brand-new files and edit_file for changes to existing files (sed -i, patch, tee, redirects and python heredocs that write files are NOT acceptable substitutes). Runs on the MAIN model — raw output is returned directly (capped to `terminal_out_chars`) so the agent can read it itself. BATCH: chain independent commands in ONE call with `;` or `&&` (e.g. lint then tests: `ruff check x.py; pytest -q`) — NEVER one call per command, and never re-run a command just to see it with a different `| head`/`| tail`; test/build commands (npm test, pytest, vitest, tsc, ...) already get the maximum timeout by default."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        # Parent search cache for terminal search commands
        if _is_terminal_search(command):
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

        _is_search_cmd = _is_terminal_search(command)
        emit(
            {
                "kind": "tool",
                "tool": "run_terminal",
                "args": {"command": command},
                "model": _main_name if _is_search_cmd else "",
            }
        )
        # Test / build / typecheck runs routinely exceed the 120s default;
        # they were killed (exit -1) and re-run identically, burning a full
        # round trip each time. Give them the maximum window up front.
        if timeout == TERMINAL_TIMEOUT and _LONG_RUNNING_CMD_RE.search(command):
            timeout = TERMINAL_TIMEOUT_MAX
        result = await asyncio.to_thread(run_terminal, root, command, timeout, permit)
        if "error" in result:
            msg = result["error"]
            emit(_error_result("run_terminal", msg))
            return f"ERROR running {command!r}: {msg}"
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
        return f"$ {command}\nEXIT CODE: {result['exit_code']}\n{output}" + nudge

    async def glob_tool(
        pattern: str,
        patterns: list[str] | None = None,
        path: str = "",
        paths: list[str] | None = None,
        max_results: int = 100,
    ) -> str:
        """Find FILES by glob pattern. `pattern` is a glob like `**/*.js`, `src/**/*.ts`, or `*.test.py` (use `**` to match across directories). BATCH: pass every extra glob via `patterns` (a list) so they all run in the SAME call — e.g. pattern='**/*.test.py', patterns=['**/*.spec.ts'] is ONE glob — NEVER fire one glob per pattern when they share a path. `path` optionally narrows the subtree (omit = whole workspace); pass `paths` (a list of extra subtrees) to scan SEVERAL scopes in the SAME call — e.g. path='src', paths=['backend','tools'] — NEVER fire one glob per scope. `max_results` caps how many paths are returned (default 100). Returns matching relative paths only (no file contents). Respects .gitignore; skips hidden/binary files. Runs on the MAIN model — matches are returned directly so the agent can read them itself. Do your discovery (glob + grep) FIRST, then read only the files you need — do NOT alternate search and read. Use this tool when you need to find files by name patterns; for an open-ended search that may require multiple rounds of globbing and grepping, combine alternatives with `foo|bar` to collapse multiple searches into one. When you already know the patterns you need, speculatively fire several globs in the SAME turn (parallel tool calls) rather than one at a time; for an open-ended search that may require multiple rounds of globbing and grepping, delegate to the explore sub-agent (task with subagent_type='explore') instead of doing it inline."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        patterns = _coerce_str_list(patterns)
        paths = _coerce_str_list(paths)
        all_patterns = _dedup_patterns(pattern, patterns)
        # نمایش تک‌الگویی برای سازگاری پیام‌ها؛ برای batch همه‌ی الگوها با |.
        disp = all_patterns[0] if len(all_patterns) == 1 else "|".join(all_patterns)
        # چند scope در همان فراخوانی: path + paths=[...] → یک glob برای همه.
        all_paths = _dedup_patterns(path, paths)
        scope = "|".join(all_paths) if len(all_paths) > 1 else path
        generation = _search_generations.get(root, 0)
        cache_key = ("glob", "|".join(all_patterns), scope, "", root, str(max_results))
        if note_turn_call(("dup", "glob", generation, cache_key)):
            return _duplicate_stub(
                emit, "glob",
                {"pattern": disp, "path": scope},
                _main_name, f"pattern={disp!r} under {scope or '/'}",
            )
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
            return f"No files match {disp!r} under {scope or '/'}."
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
        return raw

    def _did_you_mean(target: str, filePath: str) -> str:
        """Suggest close matches when a read path doesn't exist, so the model
        self-corrects a hallucinated filename (e.g. a guessed test name)
        instead of failing blind. Best-effort: never raises, empty on no match."""
        try:
            parent = os.path.dirname(target)
            if not parent or not os.path.isdir(parent):
                return ""
            want = os.path.basename(target)
            try:
                names = os.listdir(parent)
            except OSError:
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

        Envelope matches normal read blocks so the projection and the
        step-level ledger parse it; only the shown head rows count as
        fetched (note_served_map keeps coverage checks honest).
        """
        try:
            from symbol_index import get_symbol_ranges as _get_sym_ranges

            _syms = await asyncio.to_thread(_get_sym_ranges, target)
        except Exception:  # noqa: BLE001 — map never breaks a read
            _syms = {}
        _items: list[tuple[str, int, int, str]] = []
        if isinstance(_syms, dict):
            for _name, _span in _syms.items():
                try:
                    _s, _e, _k = int(_span[0]), int(_span[1]), str(_span[2])
                except (TypeError, ValueError, IndexError):
                    continue
                _items.append((str(_name), _s, _e, _k))
        _items.sort(key=lambda t: (t[1], t[2]))
        if _items:
            _rows = head_lines[:_HEAD_MAP_ROWS]
            _shown = _items[:_HEAD_MAP_MAX_SYMBOLS]
            _sym_list = "\n".join(
                f"- {_k} {_n} (L{_s}-{_e})" for _n, _s, _e, _k in _shown
            )
            if len(_items) > len(_shown):
                _sym_list += f"\n- (+{len(_items) - len(_shown)} more definitions)"
            _example = (
                f"read(filePath={filePath!r}, symbols=['{_shown[0][0]}'])"
            )
            _body = (
                "\n".join(f"{ln['line']} | {ln['text']}" for ln in _rows)
                + "\n" + _sym_list
                + f"\n\n(file map: {filePath} has {total} lines — full head "
                f"not shown. Read any definition with {_example} — one call, "
                f"exact range. For other lines use "
                f"ranges=['{filePath}:start:count'] in one call.)"
            )
            _summary = f"file map · {total} lines · {len(_items)} symbols"
        else:
            _rows = head_lines[:_HEAD_MAP_ROWS_NO_SYMBOLS]
            _body = (
                "\n".join(f"{ln['line']} | {ln['text']}" for ln in _rows)
                + f"\n\n(file map: {filePath} has {total} lines, no indexable "
                f"symbols. Use grep to locate what you need, then read exact "
                f"ranges.)"
            )
            _summary = f"file map · {total} lines"
        _last = int(_rows[-1]["line"])
        note_served_map(filePath)
        note_fetched_window(filePath, 1, _last)
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
            _parent_search_cache[cache_key] = raw
        except Exception:  # noqa: BLE001, S110 — cache never breaks a read
            pass
        return raw

    async def _read_target(
        filePath: str, offset: int, limit: int, _main_name: str,
        quiet: bool = False, allow_head_map: bool = True,
        _cache_hits: list[str] | None = None,
        _exclude: list[tuple[int, int]] | None = None,
    ) -> str:
        """Read ONE file/dir path and emit its own tool_result/error event.
        Shared by the single-path and batch branches of read_tool below so
        both paths get identical per-file behavior (error messages, paging
        notes, directory listing) — batch just calls this once per path
        concurrently instead of the caller looping one read_tool call at a
        time. `quiet=True` suppresses the per-file events: the batch branch
        emits ONE aggregate card instead, so a fast-failing missing file can
        no longer hijack the whole batch card to red "file not found" while
        the other files succeeded. `_exclude` (sig-validated already-served
        spans) omits those lines from the body instead of re-sending them."""
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
        # _invalidate_read_cache_for() computes after edit/write. The omission
        # set changes the bytes, so it joins the key (empty omission keeps the
        # legacy 3-tuple key).
        cache_key = ("read", target, str(offset), str(limit))
        if _exclude:
            try:
                cache_key = (
                    "read", target, str(offset), str(limit),
                    repr(sorted((int(_a), int(_b)) for _a, _b in _exclude)),
                )
            except Exception:  # noqa: BLE001, S110 — key never breaks a read
                pass
        cached = _parent_search_cache.get(cache_key)
        if cached is not None:
            if _cache_hits is not None:
                _cache_hits.append(filePath)
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
        if os.path.isdir(target):
            raw = await _read_dir_tool(target, filePath, offset, limit, _main_name, quiet=quiet)
            _parent_search_cache[cache_key] = raw
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
        # Paging auto-join: bridge a small gap (<= _READ_JOIN_GAP) between the
        # requested window and an already-fetched window of the same file, so
        # no sliver is left behind to page. Nearest prior window per side only
        # (provably disjoint from every recorded window, so coverage checks
        # never double-count). Bounded, disclosed below, and only the gap
        # itself is ledger-recorded here (the requested window is recorded by
        # the agent loop as usual).
        _join_note = ""
        try:
            from tool_batching import fetched_windows as _fetched_windows

            _prior_all = _fetched_windows(filePath) or []
        except Exception:  # noqa: BLE001 — join never breaks a read
            _prior_all = []
        if _prior_all:
            _ns, _ne = offset, offset + limit - 1
            _best_back: tuple[int, int] | None = None  # (gap, win_end)
            _best_fwd: tuple[int, int] | None = None  # (gap, win_start)
            for _s0, _s1 in _prior_all:
                try:
                    _s0, _s1 = int(_s0), int(_s1)
                except (TypeError, ValueError):
                    continue
                _gb = _ns - _s1 - 1
                if 0 < _gb <= _READ_JOIN_GAP and (
                    _best_back is None or _gb < _best_back[0]
                ):
                    _best_back = (_gb, _s1)
                _gf = _s0 - _ne - 1
                if 0 < _gf <= _READ_JOIN_GAP and (
                    _best_fwd is None or _gf < _best_fwd[0]
                ):
                    _best_fwd = (_gf, _s0)
            if _best_back is not None:
                note_fetched_window(filePath, _best_back[1] + 1, offset - 1)
                _ns = _best_back[1] + 1
            if _best_fwd is not None:
                note_fetched_window(filePath, offset + limit, _best_fwd[1] - 1)
                _ne = _best_fwd[1] - 1
            if (_ns, _ne) != (offset, offset + limit - 1):
                _join_note = (
                    f"(Joined to lines fetched earlier this turn — returning "
                    f"lines {_ns}-{_ne} with no gap left to page.)"
                )
                offset, limit = _ns, _ne - _ns + 1
        # Block-snapped over-read: fetch up to _SNAP_LOOKAHEAD lines past the
        # requested limit (bulk reads >= 1000 lines are exempt — they already
        # cover whole regions) so the window can end on a block boundary
        # instead of mid-function. The byte cap still bounds total output.
        want = limit + _SNAP_LOOKAHEAD if limit < 1000 else limit

        async def single_excerpt() -> dict:
            return await asyncio.to_thread(_read_lines_excerpt, target, offset, want)

        async def batch_excerpts(windows: list[tuple[int, int]]) -> list[dict]:
            widened = [
                (o, (l + _SNAP_LOOKAHEAD) if l < 1000 else l) for o, l in windows
            ]
            if len(widened) == 1:
                return [await asyncio.to_thread(_read_lines_excerpt, target, *widened[0])]
            return await asyncio.to_thread(_read_lines_excerpts, target, widened)

        excerpt = await coalesce_io(
            ("read", root, target, id(permit), _search_generations.get(root, 0)),
            (offset, want), single_excerpt, batch_excerpts,
        )
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
            # One small probe fetch: big files serve a map (saving the bulk
            # fetch entirely); small files fall through to the normal path
            # below at the cost of one extra 60-line read.
            _head = await asyncio.to_thread(
                _read_lines_excerpt, target, 1, _HEAD_MAP_ROWS_NO_SYMBOLS
            )
            _htotal = int(_head.get("total") or 0)
            if (
                _htotal > _HEAD_MAP_MIN_LINES
                and not _head.get("error")
                and _head.get("lines")
            ):
                return await _serve_head_map(
                    filePath, target, _head["lines"], _htotal,
                    _main_name, quiet, cache_key,
                )
            # Small after all: fall through to the normal path below.
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
        # Sliver-serve: omit already-served lines (sig-validated spans passed
        # as _exclude) instead of re-sending them inside a partially
        # overlapping window. The `line |` rows keep their numbers, so the
        # gapped body stays coherent; the note names the omitted ranges.
        _extent_last = lines[-1]["line"]
        _omit_note = ""
        if _exclude:
            try:
                _excl_set: set[int] = set()
                for _ea, _eb in _exclude:
                    _ea, _eb = int(_ea), int(_eb)
                    if _ea > _eb or _eb - _ea > 200000:
                        continue
                    _excl_set.update(range(max(1, _ea), _eb + 1))
            except Exception:  # noqa: BLE001 — omission never breaks a read
                _excl_set = set()
            if _excl_set:
                _shown = [
                    ln for ln in lines
                    if int(ln.get("line", -1)) not in _excl_set
                ]
                if _shown and len(_shown) < len(lines):
                    _runs: list[str] = []
                    _n = int(start)
                    while _n <= int(_extent_last):
                        if _n in _excl_set:
                            _r0 = _n
                            while _n + 1 <= int(_extent_last) and (_n + 1) in _excl_set:
                                _n += 1
                            _runs.append(f"{_r0}-{_n}" if _n > _r0 else f"{_r0}")
                        _n += 1
                    _omit_note = (
                        "\n\n(lines " + ", ".join(_runs) + " already in "
                        "context above — omitted; showing only new lines.)"
                    )
                    lines = _shown
                    start = int(lines[0]["line"])
                elif not _shown:
                    # Fully covered but missed member-drop (ledger quirk):
                    # stub instead of an empty body, never break the batch.
                    return (
                        f"({filePath}: lines {start}-{_extent_last} already "
                        "in context above — omitted.)"
                    )
        body = "\n".join(f"{ln['line']} | {ln['text']}" for ln in lines)
        last = lines[-1]["line"]
        more = _extent_last < total
        if quiet:
            # Batch member: one compact position marker. The batch call
            # carries the paging guidance once at the end, so per-block
            # guidance is not repeated for every file.
            body += f"\n\n({filePath}: lines {start}-{last} of {total})"
        elif cut:
            body += (
                f"\n\n(Output capped at {MAX_READ_EXCERPT_BYTES // 1024} KB. "
                f"Showing lines {start}-{last}. Read the needed sections with "
                f"symbols=[...] or ranges=[\"path:start:count\", ...] in one call.)"
            )
        elif more:
            body += (
                f"\n\n(Showing lines {start}-{last} of {total}. "
                f"Read all needed sections with symbols=[...] or "
                f"ranges=[\"path:start:count\", ...] in one call, "
                f"or locate them with grep first.)"
            )
        else:
            body += f"\n\n(End of file - total {total} lines)"
        if _join_note:
            body += f"\n\n{_join_note}"
        if _omit_note:
            body += _omit_note
        # NOTE: the per-file "already fetched" reminder used to live here.
        # It is now consolidated into one step-level line (context_ledger_line,
        # sent transiently with the next request) so N blocks no longer repeat
        # N reminders.
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
        _parent_search_cache[cache_key] = raw
        # Record what was ACTUALLY served (post-snap extents, not the request).
        # observe() records requested windows pre-execution and records nothing
        # for symbols= calls — without this, a symbols/ranges batch leaves no
        # trace and the next read of the same lines re-serves them ("duplicate
        # files"). Served truth here makes member-coverage exact. Errors and
        # cache hits return before this point (nothing new served).
        try:
            note_fetched_window(filePath, start, last)
        except Exception:  # noqa: BLE001, S110 — ledger never breaks a read
            pass
        # Cross-turn reuse: remember the served extent + file signature so a
        # repeat in a LATER turn stubs out when the file is unchanged (only
        # a changed file re-serves). Served maps return before this point.
        try:
            from tool_batching import note_cross_turn_read as _note_cross_read

            _note_cross_read(root, filePath, start, last, target, total)
        except Exception:  # noqa: BLE001, S110 — reuse never breaks a read
            pass
        return raw

    async def read_tool(
        filePath: str = "",
        offset: int = 1,
        limit: int = 2000,
        filePaths: list[str] | None = None,
        ranges: list[str] | None = None,
        symbols: list[str] | None = None,
    ) -> str:
        """Read a file (verbatim code) or, if `filePath` is a directory, list its entries. `filePath` is workspace-relative. For FILES: `offset` is the 1-indexed line to start at (default 1) and `limit` caps the number of lines returned (default 2000) — page large files with offset/limit. For DIRECTORIES: lists entries one per line (subdirs marked with a trailing `/`), paged by offset/limit. Use AFTER you know the exact path (from glob/grep/explore) — not for discovery. Runs on the MAIN model — contents are returned directly so the agent can read them itself.

        BATCH: pass `filePaths` (a list of additional workspace-relative paths) to read multiple independent files in parallel — read several files in ONE call instead of one read_tool call per file — e.g. filePath="a.ts", filePaths=["a.test.ts", "a.stories.ts"] reads all three together, in parallel. offset/limit apply to every path in the batch equally; for a path that needs a DIFFERENT window, pass `ranges` (a list of "path:offset:limit" strings, e.g. ranges=["tools.py:3380:220", "agents.py:810:80"]) — every listed path is read with its own window in the SAME call. Prefer batching related files (a component + its test + its types) instead of one call per file — same effect as firing several reads in parallel, but a single tool call. Avoid tiny repeated slices (e.g. 30-line chunks) — if you need more context, read a larger window (limit=300+) instead of paging 30 lines at a time; only narrow offset/limit when you truly need a small, specific region. Every read — single-file or multi-file — runs this same batch pipeline (already-fetched members are skipped, one position marker per file, one guidance footer). Lines served before are omitted from bodies (named in a pointer note), never re-sent.

SYMBOLS: pass `symbols` (a list of function/class/method names, e.g. symbols=["DiffView", "parseSideBySide"]) to read those definitions from `filePath` in ONE call instead of guessing line numbers — names come from the CODE MAP. Each window snaps to its block end and small files (<=300 lines) come back whole, so no follow-up read is needed. `symbols` wins over offset/limit for `filePath`. `symbols` and `ranges` combine in the SAME call when you need both definitions and raw windows — never a ranges call plus a separate symbols call on the same file.

WINDOWS: every window is extended past the requested limit to its block end (closing bracket at column 0, max 40 extra lines) and files with <=300 lines are returned whole — a window never ends mid-function. A head read (offset 1, limit 400+) of a file over 400 lines returns a FILE MAP (first 40 lines + definition list) instead of a bulk dump — read definitions via symbols=[...] in one call, never re-read the head for content. Make the FIRST read of a file decisive — never open with a narrow slice and page forward one window per step (read 1-200, then 217-350, …). When you need more lines beyond the window, read all needed sections with `symbols=[...]` or `ranges=[...]` in ONE call, or locate them with grep first.

When you need to read several files, read multiple independent files in parallel (pass them all in one call) rather than one at a time."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        filePaths = _coerce_str_list(filePaths)
        ranges = _coerce_str_list(ranges)
        symbols = _coerce_str_list(symbols)
        # Exact repeat inside this turn: stub it, the content is in context.
        # Generation folds in edits, so the standard post-edit re-read (same
        # args, bumped generation) always re-executes.
        if note_turn_call(
            (
                "dup", "read", _search_generations.get(root, 0), filePath,
                str(offset), str(limit),
                tuple(filePaths or []), tuple(ranges or []), tuple(symbols or []),
            )
        ):
            return _duplicate_stub(
                emit, "read",
                {"filePath": filePath, "offset": offset, "limit": limit},
                _main_name, f"{filePath} offset={offset} limit={limit}",
            )
        # بازه‌های per-path ("path:offset:limit") → پنجره‌ی اختصاصی هر فایل.
        # offset/limit سراسری همچنان برای مسیرهای بدون بازه‌ی اختصاصی اعمال می‌شود.
        # jobs فهرست است (نه dict روی path) تا ranges تکراری هم‌فایل
        # (مثل ["tools.py:640:60","tools.py:2089:80"]) هر دو اجرا شوند.
        jobs: list[tuple[str, int, int]] = []
        for spec in ranges or []:
            parts = str(spec).split(":")
            if len(parts) != 3:
                continue
            p, o, l = parts[0].strip(), parts[1].strip(), parts[2].strip()
            if not p or not o.isdigit() or not l.isdigit():
                continue
            jobs.append((p, int(o), int(l)))
        # `symbols=[...]` resolves to concrete windows on filePath via the
        # symbol index (CODE MAP) — one call instead of guessing line numbers.
        _symbol_missing: list[str] = []
        if symbols:
            if not str(filePath or "").strip():
                return "ERROR reading symbols=: symbols= needs `filePath` (the file holding the symbols) — pass filePath plus symbols=[...] in the SAME call."
            try:
                _sym_target = resolve_safe(root, filePath, allow_coder=True, permit=permit)
            except PathEscapeError as exc:
                return f"ERROR reading {filePath}: invalid path: {exc}"
            if os.path.isdir(_sym_target):
                return f"ERROR reading {filePath}: symbols= needs a file, not a directory"
            try:
                from symbol_index import resolve_symbol_ranges as _resolve_syms
            except ImportError:
                return f"ERROR reading {filePath}: symbols= is unavailable (symbol index missing)"
            _wins, _symbol_missing = _resolve_syms(_sym_target, [str(s) for s in symbols])
            if not _wins:
                return (
                    f"ERROR reading {filePath}: no such symbol(s): "
                    f"{', '.join(_symbol_missing)}. Check the CODE MAP for exact names."
                )
            jobs.extend((filePath, _o, _l) for _o, _l in _wins)
        base_paths = ([filePath] if str(filePath or "").strip() else []) + [
            p for p in (filePaths or []) if p and p != filePath
        ]
        # مسیرهای فقط داخل ranges هم به batch اضافه می‌شوند (بدون تکرار
        # برای لاگ) — اجرای واقعی از tasks می‌آید تا تکراری‌ها حفظ شوند.
        for p, _, _ in jobs:
            if p not in base_paths:
                base_paths.append(p)
        if not base_paths and not jobs:
            return "ERROR reading: no file specified — pass `filePath` (single file), `filePaths` (batch), or `ranges` (per-file windows)."
        # No single fast-path: EVERY read — even one file, one window — runs
        # the batch pipeline below (member coverage-drop, widen+merge,
        # quiet position markers, EOF refill, one aggregate card + footer).
        # A separate single branch kept re-growing its own one-off behaviors
        # (own footers, own events, no coverage-drop); uniformity kills that
        # whole class of drift.
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
        # Member-level coverage: drop batch members already served this turn.
        # Loop-side stubs cover only single-window reads; a batch re-fetching
        # one covered window among fresh ones would otherwise re-send it.
        # Runs BEFORE widening: pre-widen tasks ARE the requested windows, so
        # coverage is judged on exactly what was asked (widening only ever
        # adds bonus context past the request).
        # Requested windows were recorded pre-execution by observe(), so
        # subtract this call's own requests first — coverage must come from
        # EARLIER serving. Served windows are additionally recorded tool-side
        # post-serve (with true snapped extents), which is what makes
        # symbols=/ranges members droppable even though observe() records
        # nothing for symbols= calls. Map-served paths are untrusted: never
        # drop.
        _requested: dict[str, list[tuple[int, int]]] = {}
        if not symbols:
            for _rp, _ro, _rl in tasks:
                try:
                    _requested.setdefault(str(_rp), []).append(
                        (max(1, int(_ro)), max(1, int(_ro)) + max(1, int(_rl)) - 1)
                    )
                except (TypeError, ValueError):
                    continue

        # Members covered by a PREVIOUS turn (cross-turn keys): routed to the
        # "previous turn, unchanged" message below instead of "this turn".
        _cross_covered_keys: set[tuple[str, int, int]] = set()

        def _member_covered(_mp: str, _mo: int, _ml: int) -> bool:
            try:
                if has_served_map(_mp):
                    return False
                # External-edit guard (same as omission below): stale
                # per-turn spans must not stub a re-serve after an outside
                # edit. Healed here so later members see the dropped ledger.
                try:
                    from tool_batching import cross_turn_sig_changed as _chg

                    if bool(_chg(root, _mp)):
                        try:
                            drop_ledger_path(_mp)
                        except Exception:  # noqa: BLE001, S110 — never breaks
                            pass
                        return False
                except Exception:  # noqa: BLE001, S110 — guard never breaks coverage
                    pass
                _have = fetched_windows(_mp)
                if _have:
                    _rest = [(int(_a), int(_b)) for _a, _b in _have]
                    for _w in _requested.get(_mp, []):
                        try:
                            _rest.remove((int(_w[0]), int(_w[1])))
                        except (ValueError, TypeError):
                            pass
                    _ms, _me = int(_mo), int(_mo) + int(_ml) - 1
                    _got = sum(
                        max(0, min(_me, _b) - max(_ms, _a) + 1) for _a, _b in _rest
                    )
                    if _got >= _me - _ms + 1:
                        return True
                # Cross-turn fallback: served in a PREVIOUS turn and the file
                # is byte-unchanged since (any edit — ours or external —
                # misses and re-serves). observe() only records into the
                # per-turn ledger, so no self-subtraction is needed here.
                from tool_batching import cross_turn_read_covers as _cross_covers

                try:
                    _cs, _ce = int(_mo), int(_mo) + int(_ml) - 1
                except (TypeError, ValueError):
                    return False
                if _cross_covers(root, _mp, _cs, _ce):
                    _cross_covered_keys.add((str(_mp), int(_mo), int(_ml)))
                    return True
                return False
            except Exception:  # noqa: BLE001 — coverage never breaks a read
                return False

        _dropped: list[str] = []
        _dropped_cross: list[str] = []
        _live: list[tuple[str, int, int]] = []
        for _tp, _to, _tl in tasks:
            if _member_covered(_tp, _to, _tl):
                _label = f"{_tp} lines {_to}-{_to + _tl - 1}"
                if (_tp, _to, _tl) in _cross_covered_keys:
                    _dropped_cross.append(_label)
                else:
                    _dropped.append(_label)
            else:
                _live.append((_tp, _to, _tl))
        _drop_note = ""
        if _dropped or _dropped_cross:
            _served_desc: list[str] = []
            if _dropped:
                _served_desc.append(
                    ", ".join(_dropped) + " were already fetched this turn"
                )
            if _dropped_cross:
                _served_desc.append(
                    ", ".join(_dropped_cross)
                    + " were fetched before and the file is "
                    "unchanged since"
                )
            if not _live:
                _msg = (
                    "SKIPPED (already in context): "
                    + "; ".join(_served_desc)
                    + " — reusing that content; full text omitted to save tokens. "
                    "Do NOT re-issue this read — continue the task with the content above."
                    + (
                        " (If those rows are no longer in context, re-read a "
                        "WIDER window to re-serve them.)"
                        if _dropped_cross and not _dropped else ""
                    )
                )
                emit(
                    {
                        "kind": "tool_result",
                        "tool": "read",
                        "summary": "skipped (already in context)",
                        "model": _main_name,
                    }
                )
                return _msg
            tasks = _live
            _drop_note = (
                "(already in context, skipped: "
                + "; ".join(_served_desc)
                + " — serving the rest below)"
            )
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
        # Read every target concurrently — same asyncio.gather pattern used for
        # parallel read-only tool calls elsewhere in the graph, just applied
        # WITHIN one tool call instead of across several parallel tool calls.
        # tasks تکراری‌های هم‌فایل را حفظ می‌کند (هر ranges یک job جدا).
        # Per-file events are suppressed (quiet=True): the batch emits ONE
        # aggregate card below, so a fast-failing missing file can no longer
        # win the race and paint the whole batch red while siblings succeed.
        # Cache hits are collected (not per-member events — quiet stays
        # quiet) so a fully-cached batch can report one "cached" card, the
        # same signal the old single branch emitted per read.
        _cache_hit_paths: list[str] = []
        # Sliver-serve: per-path already-served spans (sig-validated, so an
        # edited file yields none and serves whole). Each target omits those
        # lines from its body instead of re-sending them. Map-served paths
        # stay unfiltered (map coverage is untrusted).
        from tool_batching import cross_turn_served_spans as _served_spans
        from tool_batching import cross_turn_sig_changed as _sig_changed
        from tool_batching import fetched_windows as _fetched_windows_fn

        _excl_by_path: dict[str, list[tuple[int, int]]] = {}
        _sig_changed_paths: set[str] = set()
        for _ep, _eo, _el in tasks:
            if _ep in _excl_by_path or has_served_map(_ep):
                continue
            try:
                # External-edit guard: the per-turn ledger carries no
                # signature, so without this an edit made OUTSIDE edit_file
                # (IDE, git, test) leaves stale same-turn spans that omit
                # lines served BEFORE the edit. The cross-turn store recorded
                # the signature at serve time — a mismatch means changed.
                try:
                    _changed = bool(_sig_changed(root, _ep))
                except Exception:  # noqa: BLE001 — validation never breaks read
                    _changed = False
                if _changed:
                    _sig_changed_paths.add(_ep)
                    try:
                        drop_ledger_path(_ep)
                    except Exception:  # noqa: BLE001, S110 — never breaks read
                        pass
                    continue
                _combined: list[tuple[int, int]] = []
                _sp = _served_spans(root, _ep) or []
                for _a, _b in _sp:
                    try:
                        _combined.append((int(_a), int(_b)))
                    except (TypeError, ValueError):
                        continue
                # Same-turn spans: omit lines already served earlier this
                # turn (e.g. step-2 640-879, step-3 asks 630-649 -> omit
                # 640-649, serve only the 630-639 sliver). observe() records
                # this call's own windows pre-execution, so subtract them
                # first — coverage must come from EARLIER serving only.
                try:
                    _prior = _fetched_windows_fn(_ep) or []
                except Exception:  # noqa: BLE001 — omission never breaks a read
                    _prior = []
                if _prior:
                    _rest: list[tuple[int, int]] = []
                    for _w in _prior:
                        try:
                            _rest.append((int(_w[0]), int(_w[1])))
                        except (TypeError, ValueError, IndexError):
                            continue
                    for _w in _requested.get(_ep, []):
                        try:
                            _rest.remove((int(_w[0]), int(_w[1])))
                        except (ValueError, TypeError):
                            pass
                    _combined.extend(_rest)
                if _combined:
                    _excl_by_path[_ep] = _combined
            except Exception:  # noqa: BLE001, S112 — omission never breaks a read
                continue
        results = await asyncio.gather(
            *(
                _read_target(p, o, l, _main_name, quiet=True,
                             allow_head_map=(p not in job_paths),
                             _cache_hits=_cache_hit_paths,
                             _exclude=_excl_by_path.get(p))
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
                                 allow_head_map=False,
                                 _exclude=_excl_by_path.get(p))
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
        # فوتر خلاصه: اگر بعضی فایل‌ها خطا داده‌اند ولی بقیه موفق بوده‌اند،
        # مدل نباید فکر کند کل batch شکست خورده (رفع «خواندن دسته‌ای خطا
        # داد» — مدل به read های جدا برمی‌گشت). خطاها جدا و موفق‌ها عادی
        # برمی‌گردند + یک خط خلاصه در انتها.
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
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": f"{len(_oks)}/{len(results)} files · missing: "
                    + ", ".join(p for p, _ in _errs),
                    "model": _main_name,
                    "results": [{"path": p} for p, _ in _oks],
                }
            )
            _partial = "\n\n".join(r for _, r in _oks) + "\n\n" + _foot
            return f"{_drop_note}\n\n{_partial}" if _drop_note else _partial
        if not _errs:
            # One assembly point for fresh and fully-cached serves: the cache
            # holds pre-footer member bytes, so rebuilding identically keeps
            # r1 == r2 for repeats (the cache contract the tests pin).
            _out = "\n\n".join(results)
            if _drop_note:
                _out = f"{_drop_note}\n\n{_out}"
            _out += (
                "\n\n(Batch complete — reuse this content, do NOT re-read "
                "these windows. Page further windows with "
                "ranges=[\"path:start:count\", ...] in one call.)"
            )
            if _symbol_missing:
                _out += (
                    "\n\n(symbols not found: "
                    + ", ".join(_symbol_missing)
                    + ". Check the CODE MAP for exact names.)"
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
            emit(
                {
                    "kind": "tool_result",
                    "tool": "read",
                    "summary": f"{len(results)} file" + ("s" if len(results) != 1 else ""),
                    "model": _main_name,
                    # Single-file reads keep the old content preview on the
                    # card (used to come from the single branch's per-file
                    # event); multi-file batches stay path-only so one card
                    # can't balloon to N×8KB in the trace.
                    "results": [
                        {"path": p, **({"content": r[:8000]} if len(results) == 1 else {})}
                        for (p, _, _), r in zip(tasks, results)
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
        description: str, prompt: str, subagent_type: str, task_id: str = ""
    ) -> str:
        """Delegate a task to a specialized sub-agent (opencode-style `task` tool). The sub-agent runs in an isolated context with its own tools and returns a single result. Use this for parallelizable work, complex research, or when a task needs a different tool set than you have. `description`: 3-5 word summary of the task (shown in the UI). `prompt`: the full task description. `subagent_type`: the specialized agent to use — 'general' (general-purpose research / multi-step tasks) or 'explore' (broad, read-only repository research that returns a compact summary of relevant files + findings). `task_id`: optional, to resume a previous task (sessions are ephemeral — ignored)."""
        # --- opencode-style task tool dispatch ---
        # Assign the branch id up-front so the task card itself carries it; the
        # sub-agent's internal grep/glob/read events are tagged with the same
        # branch (via _SUB_AGENT_BRANCH_CTX) and the frontend nests them under
        # THIS card. Without it the card has branch=undefined while its children
        # carry branch=1, so the frontend drops them and the explore card shows
        # nothing but "N chars".
        nonlocal _task_call_seq
        _ecall = _task_call_seq + 1
        _task_call_seq = _ecall
        # Validate the subagent_type against the agent registry (opencode:
        # "Unknown agent type: X is not a valid agent type").
        if subagent_type not in AGENTS:
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
                    f"Unknown agent type: {subagent_type} is not a valid agent type",
                )
            )
            return (
                f"ERROR: Unknown agent type: {subagent_type} is not a valid agent type"
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
        # Dispatch to the registered sub-agent runner. `general` and `explore`
        # are the two opencode-style sub-agents; the runner pulls each one's
        # system prompt + tool set from the registry.
        if subagent_type in AGENTS:
            return await _run_subagent_task(description, prompt, task_id, subagent_type, _ecall)
        # No other subagent types supported
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
                f"Unknown agent type: {subagent_type} is not a valid agent type",
            )
        )
        return (
            f"ERROR: Unknown agent type: {subagent_type} is not a valid agent type"
        )

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

        _model = main_model
        if subagent_type == "explore" and explore_model is not None:
            _model = explore_model
        if _model is None:
            emit(
                {
                    "kind": "tool",
                    "tool": "task",
                    "args": {"description": description, "subagent_type": subagent_type},
                    "branch": branch,
                    "model": "",
                }
            )
            emit(_error_result("task", "unavailable"))
            return "ERROR: the sub-agent is unavailable (no model configured for this session)."
        _model_name = str(getattr(_model, "model_name", "") or "")
        # `branch` (the branch id assigned up-front in task_tool) is passed in so
        # the task card and its sub-events share the same branch; the frontend
        # nests the sub-events under THIS card.
        _tid = task_id or f"task-{uuid.uuid4().hex[:8]}"
        emit(
            {
                "kind": "tool",
                "tool": "task",
                "args": {"description": description, "subagent_type": subagent_type},
                "model": _model_name,
                "branch": branch,
            }
        )
        # Inherit the PARENT's actual (mode-filtered) toolset — set by agents.py
        # after capability filtering — so a plan/ask-mode `task` call cannot hand
        # the sub-agent write tools (the read-only bypass). Fall back to the full
        # registry only when no parent toolset was recorded.
        _parent_tools = _PARENT_TOOLS_CTX.get()
        _tool_source = _parent_tools if _parent_tools is not None else _tools
        _reg_tools = agent_tools(subagent_type)
        if _reg_tools is not None:
            _allowed = set(_reg_tools)
            _sub_tools = {
                name: _invoke(fn)
                for name, fn in _tool_source.items()
                if name in _allowed
            }
        else:
            _sub_tools = {
                name: _invoke(fn)
                for name, fn in _tool_source.items()
                if name not in ("task", "update_plan", "vision")
            }
        # Keep the explore sub-agent strictly read-only: wrap run_terminal so any
        # command that would mutate the filesystem / system state is rejected
        # before it runs (opencode's explore agent is bash-read-only).
        if subagent_type == "explore" and "run_terminal" in _sub_tools:
            _orig_terminal = _tool_source.get("run_terminal")

            async def _readonly_terminal(
                command: str, timeout: int = TERMINAL_TIMEOUT
            ) -> str:
                if _is_terminal_write(command):
                    return (
                        "ERROR: the explore agent is read-only and may not run "
                        "commands that modify the filesystem or system state "
                        f"(blocked: {command!r}). Use grep/glob/read for "
                        "inspection, or delegate mutating work to the main agent "
                        "via the task tool."
                    )
                # The explore agent must search via grep/glob/read, not by
                # shelling out through run_terminal (slow + token-heavy).
                # git working-tree inspection stays allowed (read-only).
                _first = (
                    command.strip().split()[0].lower()
                    if command.strip().split()
                    else ""
                )
                if _first != "git" and _is_terminal_search(command):
                    return (
                        "ERROR: code search/inspection via run_terminal is not "
                        "allowed in the explore agent — use grep/glob/read for "
                        "targeted lookups, or fan out parallel explore calls."
                    )
                return await _orig_terminal(command=command, timeout=timeout)

            _sub_tools["run_terminal"] = _readonly_terminal
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
        # تاریخچه از حافظه (از graph.py پاس داده شد) — نه از دیسک. فقط برای
        # استخراج mentioned_fnames/idents جهت رتبه‌بندی CODE MAP کافیه.
        _hist_for_map: list[dict] = _history_for_map
        while _attempts < _SUBAGENT_MAX_ATTEMPTS:
            _attempts += 1
            try:
                # Inject the live CODE MAP into the explore agent's system
                # prompt so it knows the symbol layout up front and can go
                # straight to read() instead of blind grep/glob sweeps.
                _sys = agent_system(subagent_type) or (
                    "You are a sub-agent. Work through the task independently with "
                    "your tools, then reply with a concise final result. Do not ask the "
                    "user questions; do not call the task tool."
                )
                if subagent_type == "explore":
                    try:
                        from symbol_index import (
                            _looks_like_code_ident,
                            format_symbol_map,
                        )

                        # استخراج فایل‌های ذکرشده از تاریخچه (مثل graph.py)
                        _mentioned_fnames: set[str] = set()
                        _mentioned_idents: set[str] = set()
                        for _turn in _hist_for_map:
                            for _ta in (_turn.get("toolActivity") or []):
                                _p = _ta.get("args", {}).get("path") or _ta.get("args", {}).get("filePath")
                                if _p:
                                    _mentioned_fnames.add(os.path.relpath(_p, root))
                            _content = _turn.get("content") or ""
                            if isinstance(_content, str):
                                for _m in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", _content):
                                    if _looks_like_code_ident(_m):
                                        _mentioned_idents.add(_m)

                        _map_rank_info: dict = {}
                        _code_map = (
                            await asyncio.to_thread(
                                format_symbol_map,
                                root,
                                max_map_tokens=1024,
                                mentioned_fnames=_mentioned_fnames,
                                mentioned_idents=_mentioned_idents,
                                query=prompt,
                                rank_info=_map_rank_info,
                            )
                            if root
                            else ""
                        )
                        try:
                            import laya_decide as _laya_mod

                            _ranked = _map_rank_info.get("ranked") if isinstance(_map_rank_info, dict) else None
                            if isinstance(_ranked, list) and _ranked:
                                _laya_mod.report_secondary(
                                    None,
                                    route="normal",
                                    sub="code_map_rank",
                                    chat_id=str(_chat_id or ""),
                                    emit=emit,
                                    elapsed_ms=int(_map_rank_info.get("elapsed_ms") or 0),
                                    prompt=str(_map_rank_info.get("query") or prompt or ""),
                                    ranked=_ranked,
                                )
                        except Exception:  # noqa: BLE001, S110 — گزارش اختیاری است
                            pass
                    except Exception:  # noqa: BLE001
                        _code_map = ""
                    if _code_map:
                        _code_map_block = (
                            "\n\n===== CODE MAP (live symbol index) =====\n"
                            + _code_map
                            + "\n===== END CODE MAP =====\n"
                            "Use this map to locate symbols/files before reading. "
                            "Go straight to read() with the file:line from the map."
                        )
                        # نقشه رو به user turn اضافه می‌کنیم (نه system prompt) —
                        # چون محتوایش هر بار بر اساس mentioned_fnames/idents عوض
                        # می‌شه؛ اگه بره تو system، prefix cache هیچ‌وقت hit
                        # نمی‌خورد. این دقیقاً همون الگوی main agent تو graph.py هست.
                        prompt = prompt + _code_map_block
                _output = await langchain_tool_loop(
                    _model,
                    system=_sys,
                    user=prompt,
                    tools=_sub_tools,
                    max_steps=_agent_steps if _agent_steps else 24,
                    ctx=_ctx,
                    compact_model=_model,
                    reserved=reserved if reserved is not None else 20_000,
                    emit=emit,
                )
                break
            except Exception as exc:  # noqa: BLE001 — degrade instead of killing the turn
                _last_exc = exc
                if _model is main_model or main_model is None:
                    # Already on the main model (or no fallback) — give up.
                    break
                if _attempts < _SUBAGENT_MAX_ATTEMPTS:
                    # Transient blip on the explore model: retry on the same
                    # model before falling back to the main model. Emit a
                    # retry event so the UI shows a banner instead of silence
                    # during the backoff sleep.
                    try:
                        emit(
                            {
                                "kind": "retry",
                                "attempt": _attempts,
                                "max_attempts": _SUBAGENT_MAX_ATTEMPTS,
                                "delay": _SUBAGENT_RETRY_SECONDS,
                                "reason": f"explore model ({_model_name}) failed: {exc} — retrying",
                                "model": _model_name,
                                "agent": "explore",
                                "fallback": False,
                                "reconnecting": True,
                            }
                        )
                    except Exception:  # noqa: BLE001, S110 — cosmetic only
                        pass
                    await asyncio.sleep(_SUBAGENT_RETRY_SECONDS)
                    continue
                # Retries on the explore model are exhausted: fall back to the
                # main model for one final attempt (sticky, like _run_distill).
                _emit_fallback("explore", "explore", _model, main_model, exc)
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
                        emit=emit,
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
            # reading the whole codebase manually.
            emit(_error_result("task", f"sub-agent failed: {_last_exc}"))
            _SUB_AGENT_CTX.reset(_token)
            _SUB_AGENT_BRANCH_CTX.reset(_branch_token)
            _TASK_DEPTH_CTX.reset(_depth_token)
            return _explore_fail_note(subagent_type, _model_name, _last_exc)
        _SUB_AGENT_CTX.reset(_token)
        _SUB_AGENT_BRANCH_CTX.reset(_branch_token)
        _TASK_DEPTH_CTX.reset(_depth_token)
        _output = (_output or "").strip()
        emit(
            {
                "kind": "tool_result",
                "tool": "task",
                "summary": f"{len(_output)} chars",
                "model": _model_name,
                "branch": branch,
                "results": [{"content": _output[:8000]}],
            }
        )
        return f'<task id="{_tid}" state="completed">\n<task_result>\n{_output}\n</task_result>\n</task>'

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
        """Search the web AND fetch the full page content of the top results (not just a snippet) before answering. Results are cached for 24h, so repeating the exact same query costs no extra call. If you need several searches, fire all `web_search` calls in the SAME turn (parallel tool calls) — combine alternatives with `foo|bar` to collapse several searches into one. Only reach for `fetch_url` afterward for a specific URL that wasn't among the top results."""
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
        try:
            rag_hit = await _rag_web_lookup(query, _ws_for_lookup, root)
        finally:
            if store is None and _ws_for_lookup is not None:
                _ws_for_lookup.close()
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
                finally:
                    # فقط وقتی خودمان بازش کردیم ببندیم (نشت connection).
                    if store is None:
                        _ws.close()
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
        # گیت laya همگام است؛ در نخ جدا تا حلقه بلوکه نشود. ورودی‌اش طول کل
        # نتایج خام هم هست تا تصمیم با دید کامل گرفته شود.
        try:
            _raw_total = sum(len(ln) for ln in lines)
            _laya_skip_distill = await asyncio.to_thread(
                _laya_distill_choice, query, len(results), _raw_total, str(_chat_id or ""), emit
            ) == "raw"
        except Exception:  # noqa: BLE001 — گیت اختیاری است
            _laya_skip_distill = False
        if _web_runner is not None and not _laya_skip_distill:
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

    async def fetch_url_tool(url: str, full: bool = False) -> str:
        """Fetch a web page / raw file and return its extracted text (Markdown). Returns the FULL page content — no summarization, exactly like opencode's `webfetch` and codex's `web_fetch`. Pages are capped at 100k chars (codex's cap) so one fetch can never flood the context window; pass `full=True` to lift the cap for copying source files (SKILL.md/docs/raw.githubusercontent/jsdelivr/gist URLs). Every call re-sends the whole conversation, so it costs real tokens. If you need several URLs, fire all `fetch_url` calls in the SAME turn (parallel tool calls). Before `fetch_url`, run `web_search` to find the right URL; then fetch only the URLs you actually need — not every result."""
        effective_full = bool(full)
        emit(
            {
                "kind": "tool",
                "tool": "fetch_url",
                "args": {"url": url, "full": effective_full},
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
        try:
            rag_hit = await _rag_web_lookup(url, _ws_for_lookup, root)
        finally:
            if store is None and _ws_for_lookup is not None:
                _ws_for_lookup.close()
        if rag_hit:
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
        # Return cached page if fresh (TTL: 24h).
        cached = cache.get(cache_key)
        if cached:
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
        result = await asyncio.to_thread(
            fetch_url, url, MAX_FETCH_BYTES if effective_full else FETCH_EXCERPT_CHARS
        )
        if "error" in result:
            msg = result["error"]
            emit(_error_result("fetch_url", msg))
            return f"ERROR fetching {url}: {msg}"
        body = result.get("content", "")
        title = result.get("title", "")
        # Cache the fetch result (TTL از تنظیمات — پیش‌فرض ۷ روز)
        if body:
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
            finally:
                # فقط وقتی خودمان بازش کردیم ببندیم (نشت connection).
                if store is None:
                    _ws.close()

        # Return the FULL page verbatim — no summarizer, no excerpt. This is the
        # opencode/codex behavior: the tool returns raw content and the model
        # decides what to do with it. The body is already bounded by fetch_url
        # (FETCH_EXCERPT_CHARS, or MAX_FETCH_BYTES when full=True).
        emit(
            {
                "kind": "tool_result",
                "tool": "fetch_url",
                "summary": f"{len(body)} chars",
                "results": [{"title": title or url, "url": url, "snippet": body[:4000]}],
            }
        )
        return f"PAGE {url}\n" + (f"TITLE: {title}\n" if title else "") + body

    async def request_permission_tool(
        action: str, path: str = "", reason: str = ""
    ) -> str:
        """Request permission to read, search or act OUTSIDE the workspace root (e.g. ~/.config, /Users/..., $HOME, system paths). Call and WAIT BEFORE touching anything outside the project folder. (Skills/plans/MCP connectors come inline — never call this for them.) GRANTED → proceed; DENIED → MUST NOT access — explain what you needed and why, then continue inside the workspace. `action` = short phrase like 'read config', 'run command'."""
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
        # پوشه‌ی نرمال‌شده‌ی درخواست (نزدیک‌ترین والد موجود) از سمت بک‌اند
        # محاسبه و ارسال می‌شود — فرانت‌اند به فایل‌سیستم دسترسی ندارد و
        # «همیشه اجازه» باید دقیقاً همین پوشه را ثبت کند.
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
        if granted:
            # مجوز per-folder: به‌جای باز کردن کل فضای بیرون از ریشه، فقط
            # پوشه‌ی درخواستی (نزدیک‌ترین والد موجودِ مسیر) به لیست پوشه‌های
            # مجاز اضافه می‌شود. پوشه‌های دیگر همچنان مجوز جداگانه می‌خواهند.
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
        if granted:
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
        emit({"kind": "ask", "id": aid, "question": question, "options": clean_options})
        try:
            answer = await fut
        finally:
            ask_gates.pop(aid, None)
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
    # filter (graph.filter_tools_for_mode) keeps git_commit coder-only.
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

    async def laya_tool(
        operation: str = "choice",
        state: str | dict | None = None,
        options: list[str] | None = None,
        candidate: str = "",
        candidates: list | None = None,
        top_k: int = 5,
        instructions: str = "",
        threshold: float = 0.65,
    ) -> str:
        """Fast local decision/classification/ranking via laya (System 1 router, not a chatbot). Use for any quick decision with caller-supplied labels — triage, routing, ranking — without hard-coding any domain. `operation` is 'choice' (pick one of `options` given `state` context), 'score' (rate `candidate` 0-1 given `state` context), 'rank' (order `candidates` — names or {name, description} dicts — by relevance to `state` text, at most `top_k`; e.g. to pick which skill or MCP tool fits the task, pass their names+descriptions as candidates and take the top entries; an empty ranked list means no signal — fall back to the full list yourself), or 'status' (laya readiness). `state` is free-form context (text or dict); `threshold` is the confidence cutoff for choice/score (below it the result is not handled — do the task with the main model instead). Returns JSON with handled/value/confidence/abstained/reason (rank returns handled/ranked/count/reason)."""
        op = (operation or "choice").strip().lower()
        emit(
            {
                "kind": "tool",
                "tool": "laya",
                "args": {"operation": op},
            }
        )
        try:
            import laya_decide as _laya
        except Exception as exc:  # noqa: BLE001 — laya is optional
            msg = f"laya unavailable: {exc}"
            emit(_error_result("laya", msg))
            return json.dumps({"operation": op, "handled": False, "value": None, "confidence": 0.0, "abstained": True, "reason": "laya-not-installed"}, ensure_ascii=False)
        try:
            try:
                thr = float(threshold)
            except (TypeError, ValueError):
                thr = 0.65
            if not 0.0 <= thr <= 1.0:
                thr = 0.65
            if op == "status":
                result = await asyncio.to_thread(_laya.status)
                text = json.dumps({"operation": op, **result}, ensure_ascii=False, default=str)
                emit({"kind": "tool_result", "tool": "laya", "summary": str(result.get("reason") or ("ready" if result.get("ready") else "not-ready"))[:400]})
                return text
            if isinstance(state, dict):
                state_dict = dict(state)
            elif state is None or (isinstance(state, str) and not state.strip()):
                state_dict = {}
            elif isinstance(state, str):
                state_dict = {"text": state[:4000]}
            else:
                state_dict = {"text": str(state)[:4000]}
            if op == "rank":
                cands = list(candidates or [])
                try:
                    topk = int(top_k)
                except (TypeError, ValueError):
                    topk = 5
                rtext = state_dict.get("text", "") if isinstance(state_dict, dict) else ""
                if not rtext and isinstance(state_dict, dict):
                    try:
                        rtext = json.dumps(state_dict, ensure_ascii=False, default=str)[:4000]
                    except Exception:  # noqa: BLE001 — empty text means no signal
                        rtext = ""
                ranked = await asyncio.to_thread(
                    _laya.rank, rtext, cands, topk, instructions or ""
                )
                payload = {
                    "operation": op,
                    "handled": bool(ranked),
                    "ranked": ranked,
                    "count": len(ranked),
                    "reason": "rank-ok" if ranked else "rank-no-signal",
                }
                text = json.dumps(payload, ensure_ascii=False, default=str)
                emit({"kind": "tool_result", "tool": "laya", "summary": (text[:400] + "…") if len(text) > 400 else text, "status": "done"})
                return text
            if op == "score":
                decision = await asyncio.to_thread(_laya.score, state_dict, candidate, thr)
            elif op == "choice":
                opts = [str(o) for o in (options or []) if str(o or "").strip()]
                decision = await asyncio.to_thread(_laya.choice, state_dict, opts, thr)
            else:
                msg = f"Unknown operation {operation!r} — use 'choice', 'score', 'rank' or 'status'."
                emit(_error_result("laya", msg))
                return json.dumps({"operation": op, "handled": False, "value": None, "confidence": 0.0, "abstained": True, "reason": "unknown-operation"}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 — never break the main turn
            msg = f"laya tool failed: {exc}"
            emit(_error_result("laya", msg))
            return json.dumps({"operation": op, "handled": False, "value": None, "confidence": 0.0, "abstained": True, "reason": "laya-error"}, ensure_ascii=False)
        usage = getattr(decision, "usage", None)
        if isinstance(usage, dict) and usage.get("kind") == "usage":
            try:
                emit(dict(usage))
            except Exception:  # noqa: BLE001, S110 — usage is best-effort
                pass
        payload = {
            "operation": op,
            "handled": bool(getattr(decision, "handled", False)),
            "value": getattr(decision, "value", None),
            "confidence": float(getattr(decision, "confidence", 0.0) or 0.0),
            "abstained": bool(getattr(decision, "abstained", False)),
            "reason": str(getattr(decision, "reason", "") or ""),
            "provider_id": str(getattr(decision, "provider_id", "") or ""),
            "model": str(getattr(decision, "model", "") or ""),
        }
        text = json.dumps(payload, ensure_ascii=False, default=str)
        emit({"kind": "tool_result", "tool": "laya", "summary": (text[:400] + "…") if len(text) > 400 else text, "status": "done"})
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
                # گیت آزمایشی laya: وقتی درخت به‌احتمال زیاد کافی است، see (کندترین
                # مسیر: اسکرین‌شات + مدل بینایی) را زود رد کن تا هزینه دورریخته نشود.
                # None یعنی laya تصمیم نگرفت → رفتار قبلی ادامه می‌یابد.
                # راه فرار: کپچر هدفمند (selector/region) و سؤالِ یک‌بار-ردشده در
                # همین نوبت از دروازه معاف‌اند تا بینایی قفل نشود.
                _gate_key = f"{app}|{value or ''}"
                try:
                    if selector or region or _gate_key in _see_gate_rejected:
                        _tree_first = None
                    else:
                        _tree_first = await asyncio.to_thread(
                            cu.prefer_tree_over_see, value or "", app, _chat_id, emit
                        )
                        if _tree_first is None:
                            try:
                                import laya_decide as _laya_mod

                                _step = _laya_mod.computer_next_step(value or "", app, chat_id=_chat_id, emit=emit)
                                if _step == "read_first":
                                    _tree_first = True
                            except Exception:  # noqa: BLE001, S110 — میان‌بر اختیاری است
                                pass
                except Exception:  # noqa: BLE001 — گیت اختیاری است
                    _tree_first = None
                if _tree_first is True:
                    _see_gate_rejected.add(_gate_key)
                    result = {
                        "error": (
                            "laya suggests the accessibility tree is enough for this "
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
        "task": task_tool,
        "web_search": web_search_tool,
        "search_console": search_console_tool,
        "fetch_url": fetch_url_tool,
        "run_terminal": terminal_tool,
        "current_time": current_time_tool,
        "laya": laya_tool,
        "computer": computer_tool,
        "git_status": git_status_tool,
        "git_diff": git_diff_tool,
        "git_commit": git_commit_tool,
        "git_log": git_log_tool,
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
