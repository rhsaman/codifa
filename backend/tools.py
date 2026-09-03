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
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unicodedata
import uuid
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlparse

import providers as _providers
import state_db as _state_db
from agent_registry import AGENTS, agent_system, agent_tools
from cache import Cache, cache_path_for
from secret_utils import decrypt_secret
from vector_store import (
    KIND_WEB,
    StoreConfig,
    VectorStore,
    db_path_for,
)

MAX_READ_BYTES = 2_000_000  # 2 MB
MAX_SEARCH_RESULTS = 200
MAX_FILES = 10_000
MAX_TERMINAL_OUTPUT = 30_000
TERMINAL_TIMEOUT = 120
TERMINAL_TIMEOUT_MAX = 300
MAX_WEB_SEARCH_RESULTS = 10
WEB_SEARCH_SNIPPET_MAX = 200  # per-result snippet cap to keep search context lean
WEB_SEARCH_TIMEOUT = 15
WEB_SEARCH_AUTO_FETCH = 3  # top-N results to actually fetch full content for, not just snippet
WEB_SEARCH_FETCH_CHARS = 4000  # per-page cap when auto-fetched inside web_search (keeps distill input lean)
SEARCH_TIMEOUT = 20  # seconds for a ripgrep search
SNIPPET_CONTEXT = 3  # surrounding lines (each side) grep returns inline so a `read` is usually unnecessary
SNIPPET_LINE_WIDTH = 240  # per-line cap in grep snippets to keep results compact

# Parent search cache: avoids re-running ripgrep + re-distilling identical
# searches. Module-level (NOT per-closure) so it is SHARED across the main
# agent AND every sub-agent (explore/general) built from this module — and
# across parallel explore agents in the same turn. This keeps tool-call counts
# down (no redundant grep/glob) without any quality loss: the cached result is
# byte-for-byte what a fresh scan would return. Keyed by
# (tool, pattern, path, include, root) for grep/glob — root is included so two
# different projects/workspaces sharing a pattern+path never cross-serve each
# other's cached matches ("read" entries stay 4-tuples: they're keyed by the
# already-root-resolved absolute path, so they can't collide across roots).
_parent_search_cache: dict[tuple[str, ...], str] = {}


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
    "out",
    "bin",
    "obj",
}

# ripgrep globs that exclude the deny-list dirs even when `--hidden` is passed
# (rg would otherwise search inside `.git`/`node_modules` once hidden files are
# enabled). `.DS_Store` is a file, so it needs its own negation glob.
_RG_EXCLUDE_GLOBS = ["!{" + ",".join(sorted(_SKIP_DIRS)) + "}/**", "!.DS_Store"]

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
                f"[command timed out after {timeout}s]\n"
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


def _escapes_root(command: str, root: str) -> str | None:
    """Return a reason string if ``command`` references paths outside ``root``.

    The file tools are already sandboxed through ``resolve_safe``; this gives the
    terminal the same guarantee so the agent can't drift into ``~/.config``,
    ``/Users/...`` or any other path outside the selected workspace on its own.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    # Home / $HOME expansions point outside the workspace.
    # Home / $HOME expansions point outside the workspace. `$` is not a word
    # char, so a leading `\b` can't anchor `$HOME` after a space/`=` — anchor on
    # the preceding non-word char (or start) instead.
    if re.search(
        r"~\s*(/|\\)?|(?:^|[^\w])\$HOME\b|(?:^|[^\w])\$\{HOME\}|(?:^|[^\w])\{HOME\}",
        command,
        re.IGNORECASE,
    ):
        return "references paths outside the project root (~ / $HOME)"
    # `..` can climb out of root.
    if re.search(r"(^|[\s;|&])\.\.(/|\s|$)", command):
        return "references paths outside the project root (..)"
    # Absolute paths must lie inside the workspace (or be a safe system sink).
    _os_tmp = tempfile.gettempdir().rstrip("/\\") + os.sep
    _SAFE_ABS = ("/dev/null", _os_tmp, "/tmp/", "/dev/std", "/dev/fd")
    for m in re.finditer(r"(?:^|[\s;|&])(/[^\s;|&'\"`]*)", command):
        p = m.group(1)
        if p == "/tmp" or p.rstrip("/\\") == _os_tmp.rstrip("/\\") or p.startswith(_SAFE_ABS):
            continue
        try:
            real = os.path.realpath(p)
        except Exception:  # noqa: BLE001
            real = p
        if real != root_real and not real.startswith(root_real + os.sep):
            return f"references path outside the project root: {p}"
    return None


def run_terminal(
    root: str, command: str, timeout: int = TERMINAL_TIMEOUT, permit: dict | None = None
) -> dict:
    """Run a shell command in the workspace root and capture its output."""
    reason = _blocked_terminal(command)
    if reason:
        return {"command": command, "error": reason}
    if not (permit or {}).get("outside"):
        reason = _escapes_root(command, root)
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


def resolve_safe(root: str, rel_path: str, allow_coder: bool = False) -> str:
    """Resolve ``rel_path`` against ``root`` and reject any escape.

    Accepts both relative paths (``src/main.py``) and absolute paths that lie
    inside the root (``/home/user/proj/src/main.py``). Absolute paths under the
    user-level data folder (``user_coder_dir()`` — Data path in Settings) are
    also allowed when ``allow_coder`` is set — reading them must never require
    a permission prompt (writing still goes through the strict path).
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
        # Keep hidden dirs like `.config`/`.github` (config files are real
        # workspace content the agent must see) but skip the deny-list
        # (`.git`, `.cache`, `node_modules`, …) — mirrors the renderer's
        # quick-open walk so Ctrl+P and the agent agree on what is visible.
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for name in filenames:
            if name == ".DS_Store":
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
    plans and MCP connectors live in the app database and are given to the agent
    inline instead.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    coder = os.path.realpath(user_coder_dir())
    if file == coder or file.startswith(coder + os.sep):
        return file
    return os.path.relpath(file, root_real).replace(os.sep, "/")


def list_files(root: str, path: str = "") -> dict:
    """List the directory contents of ``path`` (relative to root)."""
    target = resolve_safe(root, path, allow_coder=True)
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


def read_file(root: str, path: str) -> dict:
    """Read the text content of ``path`` (relative to root).

    Paths under the user data folder are readable without permission.
    """
    target = resolve_safe(root, path, allow_coder=True)
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
    start = max(1, int(offset or 1))
    cap = max(1, int(limit or 0))
    lines: list[dict] = []
    total = 0
    cut = False        # hit the 50 KB byte cap
    more = False       # hit the `limit` line cap
    bytes_used = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, raw in enumerate(fh, 1):
                total = lineno
                if lineno < start:
                    continue
                text = raw.rstrip("\n")
                if len(text) > MAX_LINE_LENGTH:
                    # opencode-style MIDDLE truncation: keep the line's head and
                    # tail (so leading indent/keyword and the closing bracket/paren
                    # survive) and replace the middle with a single ellipsis.
                    _keep = MAX_LINE_LENGTH - 1
                    _head = _keep // 2
                    _tail = _keep - _head
                    text = text[:_head] + "…" + text[-_tail:]
                # opencode-style byte cap: stop once the accumulated output
                # reaches MAX_READ_EXCERPT_BYTES so a huge file can't flood the
                # context even when `limit` is large.
                size = len(text.encode("utf-8", errors="replace")) + 1
                if bytes_used + size > MAX_READ_EXCERPT_BYTES:
                    cut = True
                    # keep scanning to count total lines (cheap) so the footer is right
                    for _extra in fh:
                        total += 1
                    break
                lines.append({"line": lineno, "text": text})
                bytes_used += size
                if len(lines) >= cap:
                    more = True
                    # keep scanning to count total lines (cheap) so the footer is right
                    for _extra in fh:
                        total += 1
                    break
    except (OSError, UnicodeError) as exc:
        return {
            "path": path,
            "error": str(exc),
            "lines": [],
            "start": start,
            "total": 0,
            "cut": False,
            "more": False,
        }
    return {
        "path": path,
        "lines": lines,
        "start": start,
        "total": total,
        "cut": cut,
        "more": more,
    }


def write_file(root: str, path: str, content: str) -> dict:
    """Write ``content`` to ``path`` (relative to root). Creates parent dirs."""
    target = resolve_safe(root, path)
    if _is_workspace_coder_dir(root, target):
        return {
            "path": path,
            "error": "the workspace .coder/ folder is reserved for the agent's own config (plans) and is stored in the app database instead — do not write here",
        }
    if os.path.isdir(target):
        return {"path": path, "error": "path is a directory"}
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(content)
    except OSError as exc:
        return {"path": path, "error": str(exc)}
    return {"path": path, "ok": True}


def user_coder_dir() -> str:
    """Return the user-level data root (default ``~/.codifa``), creating it.

    The state DB (settings, chats, skills, MCP connectors) and the vector
    stores live here (global, shared across all workspaces), not inside each
    project's ``.coder/`` folder. The root is configurable from
    Settings → Data path: Electron sets ``CODER_DATA_DIR`` on the sidecar env,
    which the desktop app reads to locate the same folder the state DB lives in.
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
    """TTL کش وب‌سرچ (ثانیه) از تنظیمات — پیش‌فرض ۷ روز."""
    try:
        s = (_state_db.get_settings() or {})
        days = int(s.get("webSearchTtlDays", 7))
        days = max(1, days)
    except (TypeError, ValueError):
        days = 7
    return days * 86400


def _fetch_cache_ttl() -> int:
    """TTL کش fetch_url (ثانیه) از تنظیمات — پیش‌فرض ۷ روز."""
    try:
        s = (_state_db.get_settings() or {})
        days = int(s.get("fetchUrlTtlDays", 7))
        days = max(1, days)
    except (TypeError, ValueError):
        days = 7
    return days * 86400


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
        from embeddings import embedder_available

        return embedder_available()
    except Exception:  # noqa: BLE001
        return False


def _get_web_store(root: str) -> VectorStore | None:
    """باز کردن lazy vector store فقط وقتی واقعاً لازمه (وب/fetch).

    اینطوری بدون embedding هیچ پوشه‌ای ساخته نمی‌شه — چون open_vector_store
    فقط توی این تابع صدا زده می‌شه که خودش توی web_search_tool/fetch_url_tool
    فراخوانی می‌شه (نه اول چت).
    """
    try:
        return open_vector_store(root, "", None)
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
    config lives in the user data folder, and skills/plans/MCP connectors live in
    the app database — never in the project.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    coder_dir = os.path.join(root_real, ".coder")
    return target == coder_dir or target.startswith(coder_dir + os.sep)


def slugify(name: str) -> str:
    """Turn a skill name into a safe folder slug (e.g. 'Code Review' -> 'code-review')."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "skill"


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


def persist_skill(
    raw: str,
    fallback_name: str = "",
    previous_name: str = "",
) -> dict:
    """Persist a skill to the app database.

    ``raw`` is the full skill markdown (frontmatter + body). The name and
    description are parsed from the frontmatter. The id is a virtual key —
    skills live in the app database, never as files on disk.
    """
    name, description, body = _parse_skill_markdown(raw)
    if not name:
        name = fallback_name.strip()
    if not name:
        return {"ok": False, "note": "skill needs a name"}
    slug = slugify(name)
    path = f"db://skills/{slug}"
    if not body:
        body = f"Write step-by-step instructions for {name}."
    try:
        _state_db.save_skill(name, slug, description, path, raw or body)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "note": f"could not save skill: {exc}"}
    if previous_name and previous_name != name:
        _state_db.delete_skill(previous_name)
    return {
        "ok": True,
        "name": name,
        "slug": slug,
        "note": f"skill '{name}' saved to the app database",
    }


def remove_skill(name: str) -> dict:
    """Delete a skill from the app database."""
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
    the app database, and re-seeds a built-in whose shipped ``.md`` has changed
    (so official fixes propagate without manual deletion). Adding a new ``.md``
    file to the folder makes it a built-in skill on the next startup, with no
    code change required. Returns the names that were seeded or re-synced.

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
    # Map name/slug -> stored body (frontmatter already stripped by list_skills),
    # so we can compare against the shipped ``.md`` body below.
    existing_body: dict[str, str] = {}
    for s in existing:
        body = (s.get("content") or "").strip()
        if s.get("name"):
            existing_body[s["name"]] = body
        if s.get("slug"):
            existing_body[s["slug"]] = body
    seeded: list[str] = []
    for path in sorted(_pyglob.glob(os.path.join(folder, "*.md"))):
        try:
            with open(path, encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            continue
        name, _description, body = _parse_skill_markdown(raw)
        if not name:
            name = os.path.splitext(os.path.basename(path))[0]
        if name in existing_names or slugify(name) in existing_slugs:
            # Built-in already present: re-sync only when the shipped file
            # changed, so official updates take effect. Identical copies are
            # left untouched.
            stored = existing_body.get(name) or existing_body.get(slugify(name), "")
            if stored == body.strip():
                continue
        result = persist_skill(raw, fallback_name=name)
        if result.get("ok"):
            seeded.append(result.get("name") or name)
    return seeded


# Built-in MCP connectors shipped with the app. They are seeded on first run
# and exempt from startup validation (which would otherwise delete them on
# machines where the underlying tool isn't installed) — a broken builtin only
# surfaces if the model actually calls one of its tools.
_BUILTIN_MCP_SERVERS: dict[str, dict] = {
    "docker": {
        "command": "docker",
        "args": ["mcp", "gateway", "run"],
    },
}


def seed_builtin_mcp() -> list[str]:
    """Install the built-in MCP connectors on first run (no-op afterwards).

    Seeds only when the ``mcp`` table is empty, so user edits/deletions are
    never overwritten. Returns the names that were seeded.
    """
    try:
        existing = _state_db.list_mcp()
    except Exception:  # noqa: BLE001
        return []
    if existing:
        return []
    seeded: list[str] = []
    for name, cfg in _BUILTIN_MCP_SERVERS.items():
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
    """Create or overwrite a user skill in the app database (global, shared).

    ``name`` is the display name, ``description`` is indexed for the system
    prompt, and ``content`` is the full markdown body (step-by-step
    instructions). The skill is stored in the state DB; an existing skill of
    the same name is replaced. The ``root`` argument is kept for API
    compatibility and is not used.
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
        return {
            "path": f"db://skills/{slugify(name)}",
            "error": result.get("note", "save failed"),
        }
    return {
        "path": f"db://skills/{slugify(name)}",
        "name": result["name"],
        "ok": True,
        "note": result["note"],
    }


def _format_skill_body(row: dict) -> str:
    """Format a skill DB row as the full body ``read_skill`` returns: name,
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
    """Add or replace one MCP server entry in the app database (shared globally).

    Stores ``cfg`` under ``name`` in the ``mcp`` table. ``root`` is kept for
    API compatibility and is not used.
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
    """Check every stdio connector in the app database and remove the ones
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
    target = resolve_safe(root, path)
    if _is_workspace_coder_dir(root, target):
        return {
            "path": path,
            "error": "the workspace .coder/ folder is reserved for the agent's own config (plans) and is stored in the app database instead — do not write here",
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


def verify_edit(root: str, path: str) -> str | None:
    """Best-effort post-write verification for Coder mode's write_file/edit_file.

    Dispatches by extension: .py gets an instant AST syntax check; .json gets an
    instant json.loads check; .ts/.tsx get a debounced project-wide typecheck.
    Every other extension (and any error resolving the path) returns ``None`` so
    the caller adds nothing to the tool result — this must never turn a
    successful write into a reported failure.
    """
    ext = os.path.splitext(path)[1].lower()
    try:
        target = resolve_safe(root, path)
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
# calls have happened since the plan was last updated while a step is still
# 'in_progress', and a due nudge is piggybacked onto that tool's OWN reply
# (same trick as AUTO-VERIFY) so no extra message-injection machinery is needed.
def _format_plan_nudge_suffix(due: bool) -> str:
    if not due:
        return ""
    return (
        "\n\n💡 Reminder: your checklist still has a step marked 'in_progress' after "
        "several tool calls — call update_plan now with the SAME full list, marking "
        "any step you've actually finished 'completed' (and the next one 'in_progress')."
    )


def _search_python(
    root: str, query: str, path: str, ctx: int, include: str = ""
) -> dict:
    """Python fallback for ``search_in_files`` when ripgrep is unavailable.

    Walks the tree and matches line-by-line with the same semantics as rg:
    case-insensitive regex, ``ctx`` lines of surrounding context. Slower and
    does not honour ``.gitignore``, but returns the same result shape.
    """
    target = resolve_safe(root, path, allow_coder=True)
    if not os.path.isdir(target) and not os.path.isfile(target):
        return {
            "query": query,
            "matches": [],
            "truncated": False,
            "error": f"path not found: {path}",
        }

    try:
        pattern = re.compile(query, re.IGNORECASE)
    except re.error:
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
    root: str, query: str, path: str, ctx: int, include: str = ""
) -> dict | None:
    """Claude-Code-style ripgrep search; returns None when rg is unusable."""
    rg = shutil.which("rg")
    if not rg:
        return None
    target = resolve_safe(root, path, allow_coder=True)
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
    # --hidden makes config files (`.config`, `.github`, …) searchable; the
    # deny-list globs keep `.git`/`node_modules`/… out even when hidden.
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
    root: str, query: str, path: str = "", context: int = 0, include: str = ""
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
    result = _rg_search(root, query, path, ctx, include)
    if result is not None:
        return result
    return _search_python(root, query, path, ctx, include)


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


def glob_files(root: str, pattern: str, path: str = "") -> dict:
    """Find files by glob pattern under ``path`` (relative to root).

    Matches opencode's ``glob`` tool: ``pattern`` is a glob like ``**/*.js`` or
    ``src/**/*.ts``. Uses ripgrep when available (respecting ``.gitignore``,
    skipping hidden/binary files) with a stdlib ``glob`` fallback. Returns a
    list of relative paths (``matches``), sorted.
    """
    pattern = (pattern or "").strip()
    target = resolve_safe(root, path, allow_coder=True)
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
                    model, system=system_prompt, user=make_prompt(), sub=True
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
        tool_out_chars = max(400, min((ctx // 14) - 150, 2_400))
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

    # Narrow-read guard: stop line-by-line probing of one file. A proactive floor
    # widens tiny first reads so the pattern never starts; a reactive hint
    # backstops the case where the model keeps asking for small adjacent windows
    # anyway. Both live for this run only, reset each time make_tool_callbacks
    # is called (same lifetime as _plan_nudge_state above).
    _NARROW_READ_FLOOR = 60          # اگه limit خیلی کوچیک بود، به این گرد می‌کنیم
    _NARROW_READ_HINT_LIMIT = 30     # زیر این حد، مشمول floor می‌شه
    _narrow_read_state = {"last_target": None, "small_adjacent": 0}

    def _narrow_read_floor(target: str, offset: int, limit: int, total: int = 0) -> tuple[int, str | None]:
        """پهنای خواندن رو proactive تنظیم می‌کنه تا probe خط‌به‌خط شروع نشه.

        - فقط برای فایل‌ها و فقط اولین read (offset=1) اعمال می‌شه — نه دایرکتوری‌ها
          (که pagination معنادار دارن) و نه ادامهٔ pagination (offset>1).
        - اگه limit خیلی کوچیکه (< _NARROW_READ_HINT_LIMIT) و این اولین read روی
          این فایل تو این taskـه و فایل بزرگ‌تر از floorـه → به _NARROW_READ_FLOOR
          گرد می‌کنیم (floor)؛ الگو اصلاً شروع نمی‌شه و مدل کل ناحیه رو یه‌جا می‌بینه.
        - اگه باز هم روی همون فایل بازهٔ کوچیک/مجاور زده شد → hint قاطع برمی‌گردونه.
        برمی‌گردونه: (limitِ اصلاح‌شده، hint یا None)
        """
        st = _narrow_read_state
        is_small = 0 < limit < _NARROW_READ_HINT_LIMIT
        is_same = st["last_target"] == target
        if is_small and is_same:
            st["small_adjacent"] += 1
        else:
            st["small_adjacent"] = 0
        st["last_target"] = target
        effective = limit
        hint = None
        # فقط فایل + اولین read (offset=1) + فایل بزرگ‌تر از floor: دایرکتوری،
        # pagination، و فایل‌های کوچیک مستثنی‌اند (برای اونا limit کوچیک بی‌ضرره).
        if (
            is_small
            and st["small_adjacent"] == 0
            and not os.path.isdir(target)
            and offset == 1
            and total > _NARROW_READ_FLOOR
        ):
            # اولین read کوچیک روی این فایل بزرگ → floor بزن (الگو اصلاً شروع نشه)
            effective = _NARROW_READ_FLOOR
        elif st["small_adjacent"] >= 1:
            # دومین/بعدیِ کوچیکِ مجاور → hint قاطع
            hint = (
                "HINT: stop reading tiny adjacent slices of this file. "
                "Read one wide window (limit=100+) covering the whole target "
                "region instead of paging 20-30 lines at a time."
            )
        return effective, hint

    def _plan_nudge_due() -> bool:
        """Call once per mutating tool call. Returns True (and resets the counter)
        once every `_PLAN_NUDGE_EVERY` calls made while the plan still has a step
        stuck 'in_progress' — fires repeatedly, not just once, until the model
        actually updates the plan."""
        if not _plan_nudge_state["has_in_progress"]:
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
            before = read_file(root, path)
            old = before.get("content")
        except (PathEscapeError, OSError):
            old = None
        try:
            result = write_file(root, path, content)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("write_file", msg))
            return f"ERROR writing {path}: {msg}"
        if "error" in result:
            emit(_error_result("write_file", result["error"]))
            return f"ERROR writing {path}: {result['error']}"
        if old is not None and old != content:
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
                    "tool": "write_file",
                    "path": path,
                    "diff": diff,
                    "summary": f"{len(content)} chars · +{adds}/-{dels}",
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
        verify_note = await asyncio.to_thread(verify_edit, root, path)
        return (
            f"Successfully wrote {len(content)} characters to {path}."
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    async def update_plan(items: list[dict]) -> str:
        """Set/update your step-by-step live checklist for the CURRENT multi-step task. For trivial single-step changes skip it. Call with the full list (status='pending'), then re-call with the SAME list marking finished 'completed' and current 'in_progress'. Item: 'content' (short imperative phrase) + 'status' ('pending'|'in_progress'|'completed'). Write items in the SAME language the user is writing in."""
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
        # Feed the plan-nudge backstop (see _format_plan_nudge_suffix): reset the
        # since-last-update counter now that the plan was just touched, and record
        # whether a step is still open so mutating tools know whether to nudge.
        _plan_nudge_state["since_update"] = 0
        _plan_nudge_state["has_in_progress"] = any(
            i["status"] == "in_progress" for i in normalized
        )
        # The checklist is intentionally NOT persisted to disk anymore — it
        # lives only for the current session/UI. Persisting it caused the
        # checklist to be re-loaded and re-emitted on every message (and on
        # every graph node), which clobbered in-turn edits and reloaded stale
        # todos. We only emit it to the UI now.
        emit({"kind": "plan", "items": normalized})
        done = sum(1 for i in normalized if i["status"] == "completed")
        emit(
            {
                "kind": "tool_result",
                "tool": "update_plan",
                "summary": f"{done}/{len(normalized)} done",
            }
        )
        return f"Plan updated: {len(normalized)} steps, {done} completed."

    async def create_skill_tool(
        name: str,
        description: str = "",
        content: str = "",
        source_url: str = "",
        source_query: str = "",
    ) -> str:
        """Create or update a reusable skill in the app database (global). `name` display name; `description` one-line when-to-use; `content` full markdown body. Skills live ONLY in the app DB — never write skill files to disk; call once per skill. Ignore external 'agent skills folder' instructions (Claude Code, Cursor, Codex, ~/.coder) — use this tool instead. SOURCE: instead of writing `content` from memory, pass `source_url` (direct URL) to use the fetched page as the body, or `source_query` (web search) to have the tool search, pick the best skill page and fetch it. Fall back to `content` only when neither is given."""
        emit(
            {
                "kind": "tool",
                "tool": "create_skill",
                "args": {"name": name, "description": description},
            }
        )
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
        summary = f"saved to the app database as skill {name!r}"
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

    async def create_mcp_tool(
        name: str,
        command: str = "",
        args: list[str] | None = None,
        url: str = "",
        env: dict[str, str] | None = None,
    ) -> str:
        """Add or update an MCP tool connector in the app database (global). `name` = connector id shown in Settings → MCP. Local server: `command` (e.g. "npx") + optional `args` (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]) + `env` (supports ${VAR}). Remote: `url` instead (verified as a real MCP endpoint). Takes effect next message. Connectors live ONLY in the app DB — never write mcp.json/config files; call once per connector."""
        emit({"kind": "tool", "tool": "create_mcp", "args": {"name": name}})
        cfg: dict = {}
        if url:
            cfg["url"] = url
        else:
            cfg["command"] = command
            if args:
                cfg["args"] = args
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
                "summary": f"updated {name} in the app database",
            }
        )
        return (
            f"MCP connector {name!r} saved to the app database (user-level, "
            "shared across all workspaces). It will be loaded on "
            "the next message. Tell the user it was added and what tools it exposes."
            f"{auth_note}"
        )

    async def edit_file_tool(
        path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> str:
        """Replace an exact piece of text in an existing file with new text. `old_string` must match the file's current content exactly (including whitespace/indentation) and, by default, must be unique in the file — include enough surrounding lines to make it unique. Prefer this over write_file for any change to an existing file; only use write_file for brand-new files or a full intentional rewrite."""
        emit(
            {
                "kind": "tool",
                "tool": "edit_file",
                "args": {"path": path, "replace_all": replace_all},
            }
        )
        try:
            result = edit_file(root, path, old_string, new_string, replace_all)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("edit_file", msg))
            return f"ERROR editing {path}: {msg}"
        if "error" in result:
            emit(_error_result("edit_file", result["error"]))
            return f"ERROR editing {path}: {result['error']}"
        old = result["old_content"]
        content = result["new_content"]
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
            }
        )
        occ = result.get("occurrences", 1)
        emit(
            {"kind": "tool_result", "tool": "edit_file", "summary": f"+{adds}/-{dels}"}
        )
        # Invalidate any cached read_tool result for this path so a re-read
        # reflects the new content instead of returning stale cached bytes.
        _invalidate_read_cache_for(path, root)
        verify_note = await asyncio.to_thread(verify_edit, root, path)
        return (
            f"Successfully edited {path} ({occ} occurrence{'s' if occ != 1 else ''} replaced)."
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    async def grep_tool(
        pattern: str, path: str = "", include: str = "", max_results: int = 50
    ) -> str:
        """Search file CONTENTS using a regular expression. `pattern` is a REGEX (matched case-insensitively, per line), so combine alternatives with `foo|bar` (full syntax like `function\\s+\\w+` works). `path` optionally restricts to a subdirectory (omit = whole workspace). `include` optionally filters files by glob, e.g. `*.ts` or `*.{ts,tsx}`. `max_results` caps how many matches are returned (default 50). Respects .gitignore; skips hidden/binary files.

Returns each match with ±3 lines of surrounding code (the matching line marked with `>`), so you usually do NOT need a follow-up `read` just to see context — only read when you need more than ±3 lines or need to edit the file. Output is capped by `max_results` and the context budget; if there are more matches a truncation note tells you to narrow the search. Use this tool (NOT shell `grep`/`rg`) to find files containing specific patterns — see the SEARCH STRATEGY rule for targeted-vs-broad guidance. For an open-ended search that may require multiple rounds of grepping, delegate to the explore sub-agent (task with subagent_type='explore') instead of doing it inline."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        # Parent search cache key
        cache_key = ("grep", pattern, path, include, root)
        cached = _parent_search_cache.get(cache_key)
        if cached is not None:
            emit(
                {
                    "kind": "tool",
                    "tool": "grep",
                    "args": {"pattern": pattern, "path": path, "include": include},
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
                "args": {"pattern": pattern, "path": path, "include": include},
                "model": _main_name,
            }
        )
        try:
            # Offload the blocking scan to a worker thread so the event loop is
            # free to run other gathered read-only tools concurrently (the
            # asyncio.gather in graph.py/llm.py otherwise serializes them because
            # a sync call freezes the loop until it returns).
            result = await asyncio.to_thread(
                search_in_files, root, pattern, path, SNIPPET_CONTEXT, include
            )
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("grep", msg))
            return f"ERROR searching {path}: {msg}"
        if result.get("error"):
            msg = result["error"]
            emit(_error_result("grep", msg))
            return f"ERROR searching {path}: {msg}"
        matches = result.get("matches", [])
        if not matches:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "grep",
                    "summary": "no matches",
                    "model": _main_name,
                }
            )
            return f"No matches for {pattern!r} under {path or '/'}"
        # Output contract (spec §3, revised): each hit shows the match line plus
        # ±SNIPPET_CONTEXT lines of surrounding code (already computed by
        # search_in_files above — previously discarded here, forcing an almost-
        # mandatory follow-up `read` just to see context around every match).
        # Capped by max_results and the context budget; when truncated, tell the
        # agent to narrow the search or read files.
        lines: list[str] = []
        total = 0
        for shown, m in enumerate(matches):
            if shown >= max_results:
                break
            ctx_lines = m.get("context_lines") or []
            if ctx_lines:
                body = "\n".join(
                    f"{'>' if cl['line'] == m['line'] else ' '} {cl['line']} | {(cl.get('text') or '')[:SNIPPET_LINE_WIDTH]}"
                    for cl in ctx_lines
                )
                entry = f"{m['file']}:{m['line']}:\n{body}"
            else:
                entry = f"{m['file']}:{m['line']}:{(m.get('text') or '')[:SNIPPET_LINE_WIDTH]}"
            if lines and total + len(entry) + 2 > tool_out_chars:
                break
            lines.append(entry)
            total += len(entry) + 2
        if len(matches) > max_results:
            note = (
                f"\nFound {len(matches)} matches.\n"
                f"Showing the first {max_results} relevant matches.\n"
                "Use a narrower pattern/path or read specific files."
            )
        else:
            note = ""
        raw = f"MATCHES for {pattern!r}\n" + "\n\n".join(lines) + note
        _parent_search_cache[cache_key] = raw
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
        """Run a shell command in the workspace root and return its output. The command runs with the project folder as the working directory, is killed after `timeout` seconds (default 120), and privileged/system-destructive commands (sudo, rm -rf /, mkfs, reboot, piping into a shell, ...) are blocked. Use this for git, package managers, build/run/lint/test commands and other project operations. NEVER use it to create, edit or delete files — use write_file for brand-new files and edit_file for changes to existing files (sed -i, patch, tee, redirects and python heredocs that write files are NOT acceptable substitutes). Runs on the MAIN model — raw output is returned directly (capped to `terminal_out_chars`) so the agent can read it itself."""
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
            emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary})
            return f"$ {command}\n(no output, exit code {result['exit_code']})" + nudge
        emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary})
        # Exit code used to live ONLY in the emit() summary (UI-only) — the
        # model never saw it in the text it actually reads, so it had to guess
        # pass/fail purely from output text. Prepending it explicitly gives the
        # model a hard, unambiguous signal to check before declaring success.
        return f"$ {command}\nEXIT CODE: {result['exit_code']}\n{output}" + nudge

    async def glob_tool(pattern: str, path: str = "", max_results: int = 100) -> str:
        """Find FILES by glob pattern. `pattern` is a glob like `**/*.js`, `src/**/*.ts`, or `*.test.py` (use `**` to match across directories). `path` optionally narrows the subtree (omit = whole workspace). `max_results` caps how many paths are returned (default 100). Returns matching relative paths only (no file contents). Respects .gitignore; skips hidden/binary files. Runs on the MAIN model — matches are returned directly so the agent can read them itself. Do your discovery (glob + grep) FIRST, then read only the files you need — do NOT alternate search and read. Use this tool when you need to find files by name patterns; for an open-ended search that may require multiple rounds of globbing and grepping, combine alternatives with `foo|bar` to collapse multiple searches into one. When you already know the patterns you need, speculatively fire several globs in the SAME turn (parallel tool calls) rather than one at a time; for an open-ended search that may require multiple rounds of globbing and grepping, delegate to the explore sub-agent (task with subagent_type='explore') instead of doing it inline."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        # Parent search cache key
        cache_key = ("glob", pattern, path, "", root)
        cached = _parent_search_cache.get(cache_key)
        if cached is not None:
            emit(
                {
                    "kind": "tool",
                    "tool": "glob",
                    "args": {"pattern": pattern, "path": path},
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
                "args": {"pattern": pattern, "path": path},
                "model": _main_name,
            }
        )
        try:
            # Offload the blocking scan to a worker thread (see grep_tool) so
            # gathered read-only tools actually run in parallel.
            result = await asyncio.to_thread(glob_files, root, pattern, path)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("glob", msg))
            return f"ERROR running glob {pattern!r} under {path or '/'}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit(_error_result("glob", msg))
            return f"ERROR running glob {pattern!r} under {path or '/'}: {msg}"
        matches = result.get("matches", [])
        if not matches:
            emit(
                {
                    "kind": "tool_result",
                    "tool": "glob",
                    "summary": "no matches",
                    "model": _main_name,
                }
            )
            return f"No files match {pattern!r} under {path or '/'}."
        lines = list(matches[:max_results])
        note = (
            f"\n({len(matches)} matches found, showing the first {max_results})"
            if len(matches) > max_results
            else ""
        )
        raw = f"GLOB MATCHES for {pattern!r}\n" + "\n".join(lines) + note
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

    async def _read_target(
        filePath: str, offset: int, limit: int, _main_name: str
    ) -> str:
        """Read ONE file/dir path and emit its own tool_result/error event.
        Shared by the single-path and batch branches of read_tool below so
        both paths get identical per-file behavior (error messages, paging
        notes, directory listing) — batch just calls this once per path
        concurrently instead of the caller looping one read_tool call at a
        time."""
        try:
            target = resolve_safe(root, filePath, allow_coder=True)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
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
            raw = await _read_dir_tool(target, filePath, offset, limit, _main_name)
            _parent_search_cache[cache_key] = raw
            return raw
        if not os.path.exists(target):
            msg = "file not found"
            emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        if not _is_text_path(target):
            msg = "binary file (read skipped)"
            emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        excerpt = await asyncio.to_thread(_read_lines_excerpt, target, offset, limit)
        if excerpt.get("error"):
            msg = excerpt["error"]
            emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        lines = excerpt["lines"]
        start = excerpt["start"]
        total = excerpt["total"]
        # Narrow-read guard: widen tiny first reads (proactive floor) and hint
        # if the model keeps probing small adjacent windows on the same file.
        # Applied AFTER we know `total` so small files keep their exact limit
        # (pagination still works) and only large files get widened.
        offset = int(offset or 1)
        limit = int(limit or 2000)
        limit, _narrow_hint = _narrow_read_floor(target, offset, limit, total)
        if not lines:
            msg = f"line offset {start} is past the end of the file ({total} lines)"
            emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        body = "\n".join(f"{ln['line']} | {ln['text']}" for ln in lines)
        last = lines[-1]["line"]
        next_line = last + 1
        if excerpt["cut"]:
            body += (
                f"\n\n(Output capped at {MAX_READ_EXCERPT_BYTES // 1024} KB. "
                f"Showing lines {start}-{last}. Use offset={next_line} to continue.)"
            )
        elif excerpt["more"]:
            body += (
                f"\n\n(Showing lines {start}-{last} of {total}. "
                f"Use offset={next_line} to continue.)"
            )
        else:
            body += f"\n\n(End of file - total {total} lines)"
        emit(
            {
                "kind": "tool_result",
                "tool": "read",
                "summary": f"{len(lines)} lines",
                "model": _main_name,
            }
        )
        raw = f"<path>{filePath}</path>\n<type>file</type>\n<content>\n{body}\n</content>"
        if _narrow_hint:
            raw += f"\n\n{_narrow_hint}"
        _parent_search_cache[cache_key] = raw
        return raw

    async def read_tool(
        filePath: str,
        offset: int = 1,
        limit: int = 2000,
        filePaths: list[str] | None = None,
    ) -> str:
        """Read a file (verbatim code) or, if `filePath` is a directory, list its entries. `filePath` is workspace-relative. For FILES: `offset` is the 1-indexed line to start at (default 1) and `limit` caps the number of lines returned (default 2000) — page large files with offset/limit. For DIRECTORIES: lists entries one per line (subdirs marked with a trailing `/`), paged by offset/limit. Use AFTER you know the exact path (from glob/grep/explore) — not for discovery. Runs on the MAIN model — contents are returned directly so the agent can read them itself.

BATCH: pass `filePaths` (a list of additional workspace-relative paths) to read multiple independent files in parallel — read several files in ONE call instead of one read_tool call per file — e.g. filePath="a.ts", filePaths=["a.test.ts", "a.stories.ts"] reads all three together, in parallel. offset/limit apply to every path in the batch equally; call read_tool again separately for a path that needs a different range. Prefer batching related files (a component + its test + its types) instead of one call per file — same effect as firing several reads in parallel, but a single tool call. Avoid tiny repeated slices (e.g. 30-line chunks) — if you need more context, read a larger window (limit=300+) instead of paging 30 lines at a time; only narrow offset/limit when you truly need a small, specific region.

NOTE: very small limits (<30 lines) on a first read of a file are auto-widened to ~60 lines to avoid line-by-line probing — ask for a wide window (limit=100+) if you need more context around a region. Repeated tiny adjacent reads of the same file trigger a hint telling you to read one wide window instead.

When you need to read several files, read multiple independent files in parallel (pass them all in one call) rather than one at a time."""
        _main_name = str(getattr(main_model, "model_name", "") or "")
        all_paths = [filePath] + [
            p for p in (filePaths or []) if p and p != filePath
        ]
        if len(all_paths) == 1:
            emit(
                {
                    "kind": "tool",
                    "tool": "read",
                    "args": {"filePath": filePath, "offset": offset, "limit": limit},
                    "model": _main_name,
                }
            )
            return await _read_target(filePath, offset, limit, _main_name)
        emit(
            {
                "kind": "tool",
                "tool": "read",
                "args": {"filePaths": all_paths, "offset": offset, "limit": limit},
                "model": _main_name,
            }
        )
        # Read every target concurrently — same asyncio.gather pattern used for
        # parallel read-only tool calls elsewhere in the graph, just applied
        # WITHIN one tool call instead of across several parallel tool calls.
        results = await asyncio.gather(
            *(_read_target(p, offset, limit, _main_name) for p in all_paths)
        )
        return "\n\n".join(results)

    async def _read_dir_tool(
        target: str, filePath: str, offset: int, limit: int, _model: str = ""
    ) -> str:
        """Directory branch of the read tool (opencode-style listing)."""
        try:
            names = await asyncio.to_thread(
                lambda: sorted(os.listdir(target), key=lambda n: (n.lower(),))
            )
        except PermissionError:
            msg = "permission denied"
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
        emit(
            {
                "kind": "tool_result",
                "tool": "read",
                "summary": f"directory · {len(entries)} entries",
                "model": _model,
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

                        _code_map = (
                            await asyncio.to_thread(
                                format_symbol_map,
                                root,
                                max_map_tokens=1024,
                                mentioned_fnames=_mentioned_fnames,
                                mentioned_idents=_mentioned_idents,
                            )
                            if root
                            else ""
                        )
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
                    # model before falling back to the main model.
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
            }
        )
        return f"PAGE {url}\n" + (f"TITLE: {title}\n" if title else "") + body

    async def request_permission_tool(
        action: str, path: str = "", reason: str = ""
    ) -> str:
        """Request permission to read, search or act OUTSIDE the workspace root (e.g. ~/.config, /Users/..., $HOME, system paths). Call and WAIT BEFORE touching anything outside the project folder. (Skills/plans/MCP connectors live in the app DB and come inline — never read them from disk, never call this for them.) GRANTED → proceed; DENIED → MUST NOT access — explain what you needed and why, then continue inside the workspace. `action` = short phrase like 'read config', 'run command'."""
        # Paths under the always-readable user data folder never need a
        # permission prompt — grant silently with no UI card at all.
        if path:
            try:
                target = resolve_safe(root, path, allow_coder=True)
                coder = os.path.realpath(user_coder_dir())
                if target == coder or target.startswith(coder + os.sep):
                    return (
                        f"PERMISSION GRANTED for {path!r}. This is inside the always-readable "
                        f"user data folder (Data path in Settings) — no permission is needed, you may proceed."
                    )
                # A path INSIDE the workspace root does not need an
                # outside-workspace permission prompt — the agent can read,
                # search and act there freely. Auto-grant so the UI never pops
                # a needless dialog for in-workspace work; only genuinely
                # OUTSIDE paths should require the user's approval.
                ws = os.path.realpath(root)
                if target == ws or target.startswith(ws + os.sep):
                    return (
                        f"PERMISSION GRANTED for {path!r}. This path is inside the workspace root, so no "
                        f"permission is needed — you may read/search/act on it directly without calling "
                        f"request_permission."
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
        emit(
            {
                "kind": "permission",
                "id": pid,
                "action": action,
                "path": path,
                "reason": reason,
            }
        )
        try:
            granted = await fut
        finally:
            permission_gates.pop(pid, None)
        if granted:
            if permit is not None:
                permit["outside"] = True
            emit(
                {
                    "kind": "tool_result",
                    "tool": "request_permission",
                    "summary": "granted",
                }
            )
            return (
                f"PERMISSION GRANTED for {path or action!r}. The user approved it — you may now "
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
        emit(
            {
                "kind": "tool",
                "tool": "ask_user",
                "args": {"question": question, "options": options or []},
            }
        )
        if ask_gates is None:
            emit(_error_result("ask_user", "ask system unavailable"))
            return "ERROR: the ask-the-user system is not available. Ask the question directly in your reply instead and wait for the user's next message."
        aid = f"a{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        ask_gates[aid] = fut
        emit({"kind": "ask", "id": aid, "question": question, "options": options or []})
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

        Uses the Google account signed in under Settings → Auth (the same OAuth
        client as the Gemini model). Without a signed-in account this returns a
        setup hint instead of failing."""
        client_id = ""
        client_secret = ""
        refresh = ""
        try:
            settings = _state_db.get_settings() or {}
        except Exception:  # noqa: BLE001
            settings = {}
        # Primary source: the legacy Search Console config. New installs leave it
        # empty and fall back to the unified google provider OAuth creds.
        sc_cfg = settings.get("searchConsole") or {}
        client_id = decrypt_secret(sc_cfg.get("clientId") or "")
        client_secret = decrypt_secret(sc_cfg.get("clientSecret") or "")
        refresh = decrypt_secret(sc_cfg.get("refreshToken") or "")
        if not (client_id and client_secret and refresh):
            # Fall back to the google provider's OAuth trio WHOLESALE. A client
            # id/secret and a refresh token must come from the SAME OAuth client —
            # mixing the legacy Search Console client with the provider's refresh
            # token yields Google's "OAuth client was not found" 401.
            for p in settings.get("providers") or []:
                if isinstance(p, dict) and p.get("kind") == "google":
                    pc_id = decrypt_secret(p.get("oauthClientId") or "")
                    pc_secret = decrypt_secret(p.get("oauthClientSecret") or "")
                    pc_refresh = decrypt_secret(p.get("oauthRefreshToken") or "")
                    if pc_id and pc_secret and pc_refresh:
                        client_id, client_secret, refresh = pc_id, pc_secret, pc_refresh
                        sc_cfg = {
                            **sc_cfg,
                            "clientId": client_id,
                            "clientSecret": client_secret,
                            "refreshToken": refresh,
                        }
                    break
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

    async def current_time_tool() -> str:
        """Return the current UTC date and time. Call this when the user asks about 'today', 'now', 'current date', 'recent', 'latest', or any time-sensitive question where you need the actual current timestamp."""
        import datetime as _dt

        now = _dt.datetime.now(_dt.timezone.utc)
        return json.dumps(
            {
                "utc": now.isoformat(),
                "utc_date": now.strftime("%Y-%m-%d"),
                "utc_time": now.strftime("%H:%M:%S"),
                "weekday": now.strftime("%A"),
                "unix": int(now.timestamp()),
            }
        )

    _tools = {
        "request_permission": request_permission_tool,
        "confirm_action": confirm_action_tool,
        "ask_user": ask_user_tool,
        "write_file": write_file_tool,
        "edit_file": edit_file_tool,
        "update_plan": update_plan,
        "create_skill": create_skill_tool,
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
