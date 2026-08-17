"""Sandboxed filesystem tools for the Pydantic AI agent.

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
import time
import unicodedata
import uuid
from collections.abc import Callable, Sequence
from typing import Any

import providers as _providers
import state_db as _state_db
from cache import Cache, cache_path_for
from embeddings import EmbedderUnavailableError
from memory_manager import MEM_SHORT_TERM, MemoryConfig, MemoryManager
from secret_utils import decrypt_secret
from vector_store import (
    KIND_MEMORY,
    KIND_SKILL,
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
SEARCH_TIMEOUT = 20  # seconds for a ripgrep search

# Sub-agent model calls (explore / terminal-search reader / web distiller)
# share the parent turn's retry policy so a free-tier rate limit or connection
# blip on the gateway retries the sub-agent instead of failing the whole turn
# and re-burning parent tokens. Flat 30s cadence, up to 10 attempts, then the
# caller's existing fallback path runs (raw output / error message).
_SUBAGENT_RETRY_SECONDS = 30
_SUBAGENT_MAX_ATTEMPTS = 10

# Set by agents.py before each agent run: the AUTO-SCOUTED WORKSPACE OVERVIEW
# text (root listing — _AUTO_SCOUT_KEY_FILES is empty, so it's just the tiny
# root-entries line). explore_tool reads it to tell the sub-agent the root is
# already listed, so it doesn't re-glob the root to orient itself (a duplicate
# of the main agent's auto-scout).
_SCOUT_CTX: contextvars.ContextVar[str] = contextvars.ContextVar(
    "coder_scout_ctx", default=""
)


def _is_content_gathering(text: str) -> bool:
    """Heuristic for whether a task needs substantial verbatim content from
    several files (styling / refactor / rewrite) rather than a narrow lookup.

    Drives two behaviors: (1) ``explore_tool`` gives content-heavy tasks a bigger
    report budget and allows verbatim code blocks; (2) the plan/coder agent's
    own-search quota is bumped so it can gather content from known files itself
    instead of looping explore. Keyword-based on purpose — cheap and stable —
    not a full classifier. ``path_hint``/``hints`` presence alone does NOT count:
    a scoped question can still be a short fact-lookup.
    """
    if not text:
        return False
    low = text.lower()
    return any(k in low for k in ("restyle", "redesign", "restructure", "rewrite",
                               "styling", "styles", "css", "jsx", "tsx", "scss",
                               "border", "borders", "read the full", "full content",
                               "verbatim", "entire component", "entire file",
                               "get the css", "get the jsx", "get the code",
                               "refactor", "migrate", "extract", "inline", "reflow"))


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


def _thoroughness_prompt(thoroughness: str) -> str:
    """Return the explore sub-agent THOROUGHNESS instruction for the given
    level ('quick' | 'medium' | 'very thorough'; anything else -> medium).
    Ported from opencode's explore subagent thoroughness control: the caller
    picks how deep to sweep, and the sub-agent prompt adapts — quick = minimal
    targeted searches, very thorough = exhaustive multi-convention sweep."""
    return {
        "quick": (
            "THOROUGHNESS: quick — do the MINIMUM searches needed for a "
            "confident answer (1-2 targeted searches), then report "
            "immediately. Do not exhaustively enumerate files or chase "
            "every naming convention."
        ),
        "medium": (
            "THOROUGHNESS: medium — search the obvious locations and "
            "naming conventions, confirm what you find, then report. "
            "Don't over-explore, but don't stop at the very first match "
            "either."
        ),
        "very thorough": (
            "THOROUGHNESS: very thorough — this is a COMPREHENSIVE sweep. "
            "Search MULTIPLE naming conventions, locations and file types "
            "(src, tests, docs, configs); try substrings, word fragments "
            "and adjacent terms; verify absence before reporting 'not "
            "found'; enumerate ALL relevant files with exact file:line "
            "references. Be exhaustive — do not stop early."
        ),
    }.get(
        (thoroughness or "medium").strip().lower(),
        (
            "THOROUGHNESS: medium — search the obvious locations and "
            "naming conventions, confirm what you find, then report. "
            "Don't over-explore, but don't stop at the very first match "
            "either."
        ),
    )


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
    is what made an explore run feel like it searched for half an hour.
    Resilience is instead provided per-call by the callers: the explore
    sub-agent's _PerStepFallbackModel (per-sub-search fallback to the main
    model) and _run_distill's main-model fallback. Returns the coroutine's
    result.
    """
    # NO RETRY: a transient throttle, retryable, or empty-output error
    # propagates immediately so the caller's per-call fallback handles it fast.
    # The old 30s x 10 backoff (up to 5 minutes of silent stalling per call) is
    # what made an explore run feel like it searched for half an hour.
    return await factory()


class _PerStepFallbackModel:
    """A pydantic-ai model wrapper that gives the EXPLORE sub-agent PER-SUB-SEARCH
    fallback: EVERY model request first tries the primary (sub-agent) model; if
    that request fails, the SAME request re-runs on the fallback (main) model.
    Non-sticky — the NEXT request goes back to the primary, so a failing
    grep/read/glob step falls back individually instead of flipping the whole
    explore run (or the whole turn) onto the main model.

    ``on_fallback(exc)`` fires when a request moves to the fallback model;
    ``on_primary()`` fires when a request succeeds on the primary model — the
    explore tool uses these to label each sub-search's events with the model
    that ACTUALLY ran. Every other attribute delegates to the primary model so
    pydantic-ai treats the wrapper like the real model it wraps.
    """

    def __init__(
        self,
        primary: Any,
        fallback: Any,
        on_fallback: Callable[[Exception], None] | None = None,
        on_primary: Callable[[], None] | None = None,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self._on_fallback = on_fallback
        self._on_primary = on_primary

    @property
    def model_name(self) -> str:
        return str(getattr(self._primary, "model_name", "") or "")

    def __getattr__(self, name: str) -> Any:
        # Delegate every other attribute (part types, provider, client, ...)
        # to the primary model so pydantic-ai treats the wrapper like the real
        # model it wraps. object.__getattribute__ avoids recursion if the
        # attribute is looked up before __init__ finished assigning _primary.
        return getattr(object.__getattribute__(self, "_primary"), name)

    async def request(
        self,
        messages: list[Any],
        model_settings: Any = None,
        model_request_parameters: Any = None,
        **kwargs: Any,
    ) -> Any:
        try:
            response = await self._primary.request(
                messages,
                model_settings=model_settings,
                model_request_parameters=model_request_parameters,
                **kwargs,
            )
            if self._on_primary is not None:
                try:
                    self._on_primary()
                except Exception:  # noqa: BLE001, S110 — cosmetic only
                    pass
            return response
        except Exception as exc:  # noqa: BLE001 — any primary failure → try the fallback model
            if self._on_fallback is not None:
                try:
                    self._on_fallback(exc)
                except Exception:  # noqa: BLE001, S110 — cosmetic only
                    pass
            return await self._fallback.request(
                messages,
                model_settings=model_settings,
                model_request_parameters=model_request_parameters,
                **kwargs,
            )

    # request_stream is intentionally NOT defined here: the sub-agents run
    # non-streaming, so __getattr__ delegates it to the primary model as-is
    # (a streaming fallback would need an async-context-manager dance that
    # the sub-agents never exercise).


# pydantic-ai's Agent(...) resolves its model through `models.infer_model`,
# which returns the model unchanged only when `isinstance(model, Model)`.
# Register the wrapper as a VIRTUAL subclass of the Model ABC so Agent(...)
# accepts it instead of parsing it as a model-id string — which crashed with
# "argument of type '_PerStepFallbackModel' is not iterable" (the `in` check
# in parse_model_id iterates a non-string). Virtual subclassing keeps the
# wrapper a plain class, so __getattr__ still delegates every attribute
# (provider, settings, request_stream, ...) to the primary model.
try:
    from pydantic_ai.models import Model as _PAIModel

    _PAIModel.register(_PerStepFallbackModel)
except Exception:  # noqa: BLE001, S110 — pydantic-ai is a hard dependency; degrade gracefully
    pass


def _subagent_fail_note(agent: str, model: str, exc: Exception) -> str:
    """A short, actionable note for when a subagent fails — names BOTH the
    subagent and the model it ran on so the user can change the right one in
    Settings → Subagents. Returns '' when there's nothing useful to say."""
    text = str(exc).strip()
    if model:
        return (
            f"Note: the {agent} sub-agent model ({model}) failed — change it in "
            f"Settings → Subagents. ({text})"
        )
    if text:
        return f"Note: the {agent} sub-agent failed. ({text})"
    return ""


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
            "snippet": str(item.get("content", "") or item.get("snippet", "") or "").strip(),
        }
        for item in results
        if isinstance(item, dict)
    ]


SEARCH_BACKENDS: dict[str, Callable[[str, int, dict], list[dict]]] = {
    "duckduckgo": _ddg_search,
    "tavily": _tavily_search,
}

_TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".yaml", ".yml",
    ".toml", ".md", ".mdx", ".txt", ".html", ".css", ".scss", ".less", ".vue",
    ".svelte", ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".java",
    ".kt", ".swift", ".rb", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql",
    ".xml", ".ini", ".cfg", ".conf", ".env", ".csv", ".tsv", ".ipynb",
}

_BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
    ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z", ".exe", ".dmg", ".dll",
    ".so", ".dylib", ".o", ".a", ".bin", ".woff", ".woff2", ".ttf", ".otf",
    ".mp4", ".mp3", ".wav", ".mov", ".avi", ".db", ".sqlite", ".pyc", ".pyo",
    ".class", ".jar", ".wasm",
}

_SKIP_DIRS = {
    "node_modules", ".git", ".venv", "venv", "__pycache__", ".next",
    ".nuxt", "dist", "dist-electron", "release", "build", "coverage",
    ".cache", ".idea", ".vscode", ".DS_Store", "target", "vendor",
    ".tox", ".mypy_cache", ".pytest_cache", "out", "bin", "obj",
}

_TERMINAL_BLOCK = [
    (r"^\s*sudo\b", "sudo (privilege escalation) is blocked"),
    (r"^\s*su\b", "su (user switch) is blocked"),
    (r"\b(mkfs|fdisk|parted|mkpart|gparted)\b", "disk partitioning commands are blocked"),
    (r"\b(shutdown|reboot|poweroff|halt)\b", "system control commands are blocked"),
    (r"rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/?\*", "destructive rm is blocked"),
    (r"rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/?\s", "destructive rm is blocked"),
    (r"rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+~", "destructive rm on the home directory is blocked"),
    (r"\bopen\b", "the macOS `open` launcher is blocked"),
    (r"dd\s+if=", "dd is blocked"),
    (r"(>|>>)\s*/dev/(sd|disk)", "raw disk access is blocked"),
    (r":\(\)\{", "fork bombs are blocked"),
    (r"\|\s*(sh|bash|zsh)\b", "piping into a shell is blocked"),
]

_TERMINAL_BLOCK_RE = [(re.compile(pat, re.IGNORECASE), msg) for pat, msg in _TERMINAL_BLOCK]


def _blocked_terminal(command: str) -> str | None:
    """Return a reason string if ``command`` is dangerous, else None."""
    for pattern, msg in _TERMINAL_BLOCK_RE:
        if pattern.search(command):
            return msg
    return None


def _exec_terminal(command: str, root: str, timeout: int) -> tuple[int, str]:
    """Run ``command`` in ``root`` via the shell; returns (exit_code, output)."""
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
            output = f"[command timed out after {timeout}s]\n" + (stdout or "") + (stderr or "")
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
    _SAFE_ABS = ("/dev/null", "/tmp/", "/dev/std", "/dev/fd")
    for m in re.finditer(r"(?:^|[\s;|&])(/[^\s;|&'\"`]*)", command):
        p = m.group(1)
        if p == "/tmp" or p.startswith(_SAFE_ABS):
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
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d not in _SKIP_DIRS
        ]
        for name in filenames:
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
        if name.startswith(".") and name not in (".gitignore", ".env"):
            continue
        full = os.path.join(target, name)
        try:
            if os.path.islink(full):
                kind = "link"
            elif os.path.isdir(full):
                kind = "dir"
            else:
                kind = "file"
        except OSError:
            kind = "file"
        entries.append({"name": name, "kind": kind, "path": f"{path}/{name}".strip("/")})

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


def _read_lines_excerpt(path: str, offset: int, limit: int) -> dict:
    """Read a slice of ``path``'s lines, opencode ``read``-style.

    Returns ``{"path", "lines": [{line, text}], "start", "total", "truncated"}``.
    ``offset`` is 1-indexed; ``limit`` caps the number of lines returned (both
    defaulted by the caller). Long lines are truncated to ``MAX_LINE_LENGTH``.
    Reads the file streaming (line by line) so it works on big files.
    """
    start = max(1, int(offset or 1))
    cap = max(1, int(limit or 0))
    lines: list[dict] = []
    total = 0
    truncated = False
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, raw in enumerate(fh, 1):
                total = lineno
                if lineno < start:
                    continue
                text = raw.rstrip("\n")
                if len(text) > MAX_LINE_LENGTH:
                    text = text[:MAX_LINE_LENGTH] + f"… (line truncated to {MAX_LINE_LENGTH} chars)"
                lines.append({"line": lineno, "text": text})
                if len(lines) >= cap:
                    truncated = True
                    # keep scanning to count total lines (cheap) so the footer is right
                    for _extra in fh:
                        total += 1
                    break
    except (OSError, UnicodeError) as exc:
        return {"path": path, "error": str(exc), "lines": [], "start": start, "total": 0, "truncated": False}
    return {"path": path, "lines": lines, "start": start, "total": total, "truncated": truncated}


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
    """Return the user-level data root (default ``~/.codefa``), creating it.

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
LOG_FILENAME = "codefa.log"

_cache: Cache | None = None


def _get_result_cache() -> Cache:
    """Lazy-once result cache (search / web lookups with TTL)."""
    global _cache
    if _cache is not None:
        return _cache
    _cache = Cache(cache_path_for(_state_db.data_root()))
    return _cache


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
    ``~/.codefa/vector-db``). Returns ``None`` when it can't be opened so
    callers degrade gracefully — never raises.
    """
    base_dir = base_dir or _state_db.vector_db_dir()
    try:
        os.makedirs(base_dir, exist_ok=True)
        slug = (
            slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep))) or "workspace"
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


def open_skill_store(base_dir: str = "") -> VectorStore | None:
    """Open (or create) the global skill vector store (``skills.vectors.sqlite``).

    Skills are indexed globally (not per workspace), so they live in one
    sqlite file under ``base_dir`` (default ``~/.codefa/vector-db``). Returns
    ``None`` when it can't be opened so callers degrade gracefully.
    """
    base_dir = base_dir or _state_db.vector_db_dir()
    try:
        os.makedirs(base_dir, exist_ok=True)
        return VectorStore(os.path.join(base_dir, "skills.vectors.sqlite"))
    except Exception:  # noqa: BLE001
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
        body = raw[m.end():]
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
    store: VectorStore | None = None,
) -> dict:
    """Persist a skill to the app database and re-embed it in the vector store.

    ``raw`` is the full skill markdown (frontmatter + body). The name and
    description are parsed from the frontmatter; the whole skill is embedded
    (name/description + body) under the synthetic id ``db://skills/<slug>`` so
    auto-selection keeps working. The id is a virtual key — skills live in the
    app database and the vector store, never as files on disk.
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

    indexed = False
    note = f"skill '{name}' saved to the app database"
    if store is None:
        store = open_skill_store()
    if store is not None:
        try:
            store.upsert_doc(
                path, KIND_SKILL, name,
                [f"{name}. {description}", body[:2000]],
            )
            if previous_name and previous_name != name:
                prev_slug = slugify(previous_name)
                # Drop any legacy ~/.coder/... vector ids for the old name.
                store.remove(f"~/.coder/skills/{prev_slug}/SKILL.md")
                store.remove(f"db://skills/{prev_slug}")
            indexed = True
        except EmbedderUnavailableError as exc:
            note = f"{note} (not indexed yet: {exc})"
        except Exception as exc:  # noqa: BLE001
            note = f"{note} (vector update failed: {exc})"
    return {"ok": True, "name": name, "slug": slug, "indexed": indexed, "note": note}


def remove_skill(name: str, store: VectorStore | None = None) -> dict:
    """Delete a skill from the app database and its vectors."""
    try:
        removed = _state_db.delete_skill(name)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "note": f"could not remove skill: {exc}"}
    if store is None:
        store = open_skill_store()
    if store is not None:
        try:
            store.remove(f"db://skills/{slugify(name)}")
            store.remove(f"~/.coder/skills/{slugify(name)}/SKILL.md")
        except Exception:  # noqa: BLE001, S110 — vector removal is best-effort
            pass
    return {"ok": True, "removed": removed, "note": f"skill '{name}' removed"}


def skill_store_status() -> tuple[VectorStore | None, str]:
    """Open the global skill store, returning it plus a status note."""
    store = open_skill_store()
    if store is None:
        return None, "skill index unavailable"
    return store, ""


def _builtin_skills_dir() -> str:
    """Directory of the built-in skill markdown files shipped with the app."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")


def sync_builtin_skills() -> list[str]:
    """Seed built-in skills from ``backend/skills/*.md`` on every startup.

    Scans the shipped skills folder and seeds any skill that is not already in
    the app database. Existing skills are never overwritten, so user edits and
    deletions are respected — adding a new ``.md`` file to the folder makes it a
    built-in skill on the next startup, with no code change required. Returns
    the names that were seeded.
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
    seeded: list[str] = []
    for path in sorted(_pyglob.glob(os.path.join(folder, "*.md"))):
        try:
            with open(path, encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            continue
        name, _description, _body = _parse_skill_markdown(raw)
        if not name:
            name = os.path.splitext(os.path.basename(path))[0]
        if name in existing_names or slugify(name) in existing_slugs:
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


def _memory_manager(root: str, store: VectorStore | None = None) -> MemoryManager:
    """Shared memory manager bound to the workspace vector store (if any)."""
    try:
        mm = MemoryManager(data_root=user_coder_dir(), config=MemoryConfig.from_settings(None))
        if store is not None:
            mm.bind_store(store)
        return mm
    except Exception:  # noqa: BLE001 — never let memory setup break the tool
        return MemoryManager(data_root=user_coder_dir())


def remember(
    root: str,
    note: str,
    store: VectorStore | None = None,
    memory_type: str = "long_term",
) -> dict:
    """Save a short, durable note to the project's RAG memory.

    Notes are stored in ``<data>/memory/memories.jsonl`` (source of truth),
    indexed in FTS5, and written through to the workspace vector store
    (``memory`` kind) for semantic recall. Deduped two ways: an exact
    substring match (cheap, catches identical restatements) and — when the
    embedder is available — a semantic near-duplicate check via cosine
    similarity (catches the SAME fact reworded in different words, which the
    substring check misses).

    ``memory_type`` selects the retention class; pass ``"short_term"`` for
    ~24h ephemeral notes (e.g. compact summaries) so they don't pollute the
    durable long-term memory.
    """
    note = (note or "").strip()
    if not note:
        return {"error": "empty note"}
    if len(note) > 4000:
        note = note[:4000] + "…"
    if store is None:
        return {"error": "memory store not available"}
    project = _project_slug(root)
    near = []
    try:
        # Always reach the nearest existing note (low bar) so we can judge it.
        near = store.search(note, KIND_MEMORY, top_k=1, min_score=0.5)
    except EmbedderUnavailableError:
        near = []  # no semantic dedup possible — save anyway
    except Exception:  # noqa: BLE001
        near = []
    dup = None
    if near:
        cand = near[0]
        score = float(cand.get("score") or 0)
        title = str(cand.get("title") or "")
        shared = _longest_shared_substring(note.lower(), title.lower())
        if score >= _MEMORY_DEDUP_THRESHOLD or shared >= _MEMORY_DEDUP_SUBSTR_MIN:
            dup = cand
    if dup is not None:
        return {
            "path": KIND_MEMORY,
            "ok": True,
            "skipped": "duplicate",
            "matched": dup["key"],
        }
    mm = _memory_manager(root, store)
    if memory_type == "short_term":
        memory_type = MEM_SHORT_TERM
    res = mm.add(note, memory_type=memory_type, project_id=project)
    if "error" in res:
        return {"path": KIND_MEMORY, "error": res["error"]}
    return {"path": KIND_MEMORY, "ok": True}


def _longest_shared_substring(a: str, b: str) -> int:
    """Length of the longest common substring (space-insensitive)."""
    a = " ".join(a.split())
    b = " ".join(b.split())
    if not a or not b:
        return 0
    n, m = len(a), len(b)
    best = 0
    prev = [0] * (m + 1)
    cur = [0] * (m + 1)
    for i in range(1, n + 1):
        prev, cur = cur, [0] * (m + 1)
        for j in range(1, m + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                best = max(best, cur[j])
            else:
                cur[j] = 0
    return best


def replace_memory(
    root: str, subject: str, new_text: str, store: VectorStore | None = None
) -> dict:
    """Hermes-style ``replace``: update the stored note that contains ``subject``
    so it now reads ``new_text``. If nothing matches, it appends ``new_text`` as
    an add instead, so ``replace`` is always safe to call.
    """
    subject = (subject or "").strip()
    new_text = (new_text or "").strip()
    if not subject:
        return {"error": "empty subject"}
    if not new_text:
        return {"error": "empty replacement text"}
    if len(new_text) > 500:
        new_text = new_text[:500] + "…"
    if store is None:
        return {"error": "memory store not available"}

    mm = _memory_manager(root, store)
    res = mm.replace(subject, new_text, project_id=_project_slug(root))
    if "error" in res:
        return {"path": KIND_MEMORY, "error": res["error"]}
    return {"path": KIND_MEMORY, "ok": True}


def remove_memory(root: str, subject: str, store: VectorStore | None = None) -> dict:
    """Hermes-style ``remove``: delete the stored note that contains ``subject``.
    Returns ok (as a no-op) if nothing matches.
    """
    subject = (subject or "").strip()
    if not subject:
        return {"error": "empty subject"}
    if store is None:
        return {"error": "memory store not available"}

    mm = _memory_manager(root, store)
    res = mm.remove(subject, project_id=_project_slug(root))
    if "error" in res:
        return {"path": KIND_MEMORY, "error": res["error"]}
    return {"path": KIND_MEMORY, "ok": True, "skip": "not found" if not res.get("removed") else False}


def search_memory(
    root: str,
    query: str,
    max_results: int = MEMORY_SEARCH_MAX_RESULTS,
    store: VectorStore | None = None,
) -> dict:
    """Search the project's RAG memory for notes relevant to ``query``.

    Notes are retrieved via a cascade (FTS5 lexical + vector semantic, with
    sliding TTL on matched notes). An empty query returns the most recently
    added notes instead.
    """
    query = (query or "").strip()
    if store is None:
        return {"query": query, "notes": [], "total": 0, "error": "memory store not available"}
    mm = _memory_manager(root, store)
    project = _project_slug(root)
    total = len(mm.list(project_id=project))
    if not query:
        notes = [m["content"] for m in mm.list(project_id=project)[:max_results]]
        return {"query": query, "notes": notes, "total": total}
    try:
        results = mm.search(query, project_id=project, top_k=max_results, min_score=0.2)
    except EmbedderUnavailableError as exc:
        return {"query": query, "notes": [], "total": total, "error": str(exc)}
    return {
        "query": query,
        "notes": [m["content"] for m in results],
        "total": total,
        "matched": len(results),
    }


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
    instructions). The skill is stored in the state DB and embedded into the
    global skill vector store; an existing skill of the same name is replaced.
    The ``root`` argument is kept for API compatibility and is not used.
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
        return {"path": f"db://skills/{slugify(name)}", "error": result.get("note", "save failed")}
    return {
        "path": f"db://skills/{slugify(name)}",
        "name": result["name"],
        "ok": True,
        "indexed": result["indexed"],
        "note": result["note"],
    }


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
                return f"exit {proc.returncode}: {msg[:200]}" if msg else f"exit {proc.returncode}"
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
        return None  # tsc failed for some other reason (config issue etc.) — stay silent
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


# --------------------------------------------------------------------------- #
# Plan self-check (Plan mode's save_plan)
# --------------------------------------------------------------------------- #
# A common plan-mode failure: the plan references a file path that doesn't
# actually exist (hallucinated, misremembered, or a stale name from an older
# search) but isn't flagged as a NEW file to create. Coder mode then either
# fails to find it or silently creates a stray duplicate. This is a pure
# filesystem check (no extra LLM call) run right before the plan is saved, so
# it costs nothing in tokens while catching a real class of plan errors.

_PLAN_PATH_RE = re.compile(r"`([\w./-]+\.[A-Za-z0-9]{1,8})`")
_PLAN_NEW_FILE_MARKERS = ("new file", "create", "new:", "add a new", "to be created")

# `path:line` citations in a sub-agent explore report. Deliberately narrow
# (a dot-extension path followed by a colon + digits) so prose like "it was
# fixed in v1.2: done" and `scheme://` URLs aren't caught.
_CITATION_RE = re.compile(
    r"(?<![\w/.])([\w][\w./\-]+\.[A-Za-z0-9]{1,8}):(\d+)"
)


def _self_check_plan_paths(root: str, content: str) -> str:
    """Flag backtick-quoted file paths in a plan that don't exist on disk and
    aren't described nearby as a new file.

    Deliberately conservative (only backtick-quoted, extension-bearing paths;
    skips anything near a "new file"-style marker) so it flags likely mistakes
    without nagging on every intentionally-new file. Returns a short warning
    suffix, or ``""`` when nothing looks wrong (never raises).
    """
    try:
        candidates = {m.group(1) for m in _PLAN_PATH_RE.finditer(content or "")}
    except Exception:  # noqa: BLE001
        return ""
    if not candidates:
        return ""
    missing: list[str] = []
    for rel in sorted(candidates):
        if rel.startswith(("http:", "https:")):
            continue
        try:
            target = resolve_safe(root, rel)
        except PathEscapeError:
            continue
        if os.path.exists(target):
            continue
        idx = content.find(f"`{rel}`")
        window = content[max(0, idx - 60) : idx].lower() if idx >= 0 else ""
        if any(marker in window for marker in _PLAN_NEW_FILE_MARKERS):
            continue
        missing.append(rel)
    if not missing:
        return ""
    preview = ", ".join(missing[:6])
    more = f" (+{len(missing) - 6} more)" if len(missing) > 6 else ""
    return (
        f"\n\n⚠️ SELF-CHECK: {len(missing)} path(s) in the plan don't exist in the workspace and "
        f"weren't marked as new: {preview}{more}. Before finishing, confirm these are correct — either "
        "they're typos/wrong paths (fix them) or genuinely new files (say so explicitly in the plan)."
    )


def _search_python(root: str, query: str, path: str, ctx: int, include: str = "") -> dict:
    """Python fallback for ``search_in_files`` when ripgrep is unavailable.

    Walks the tree and matches line-by-line with the same semantics as rg:
    case-insensitive regex, ``ctx`` lines of surrounding context. Slower and
    does not honour ``.gitignore``, but returns the same result shape.
    """
    target = resolve_safe(root, path, allow_coder=True)
    if not os.path.isdir(target) and not os.path.isfile(target):
        return {"query": query, "matches": [], "truncated": False, "error": f"path not found: {path}"}

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
                        {"line": i + 1, "text": lines[i][:500]}
                        for i in range(lo, hi)
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
    parts = [i.strip() for i in inc.replace("{", "").replace("}", "").split(",") if i.strip()]
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


def _rg_search(root: str, query: str, path: str, ctx: int, include: str = "") -> dict | None:
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
        return {"query": query, "matches": [], "truncated": False, "error": f"path not found: {path}"}

    cwd = coder if in_coder else root_real
    search_arg = os.path.relpath(target, cwd).replace(os.sep, "/")
    if search_arg in (".", ""):
        search_arg = "."

    # rg itself skips binary files, respects .gitignore and skips hidden files
    # unless --hidden is passed; exit codes: 0 = matches, 1 = none, 2 = error.
    cmd = [rg, "--json", "--line-number", "--smart-case", "--color", "never"]
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
            entry = {
                "file": file,
                "line": data.get("line_number"),
                "text": ((data.get("lines") or {}).get("text") or "").rstrip("\n")[:500],
            }
            if ctx > 0:
                entry["context_lines"] = []
            matches.append(entry)
            if len(matches) >= MAX_SEARCH_RESULTS:
                return {"query": query, "matches": matches, "truncated": True}
        elif obj.get("type") == "context" and ctx > 0 and matches:
            matches[-1]["context_lines"].append({
                "line": data.get("line_number"),
                "text": ((data.get("lines") or {}).get("text") or "").rstrip("\n")[:500],
            })
    return {"query": query, "matches": matches, "truncated": False}


def search_in_files(root: str, query: str, path: str = "", context: int = 0, include: str = "") -> dict:
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
    return {"pattern": pattern, "matches": files, "truncated": len(matches) > len(files)}


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
    # respecting .gitignore and skipping hidden/binary files.
    cmd = [rg, "--files", "-g", pattern, search_arg]
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
    return {"pattern": pattern, "matches": _clip_glob_results(files), "truncated": len(files) >= MAX_SEARCH_RESULTS}


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
FETCH_TIMEOUT = 15
# Intermediate cap applied to a fetched page BEFORE it is handed to the
# summarizer model. It is not the context budget (that comes from the model's
# reported window via `tool_out_chars`) — it only bounds the summarizer input.
FETCH_EXCERPT_CHARS = 24_000


def fetch_url(url: str, max_chars: int = FETCH_EXCERPT_CHARS) -> dict:
    """Fetch a web page and return its extracted text.

    Returns ``{"url", "title", "content"}`` on success or ``{"url", "error"}``
    with a friendly reason otherwise. HTML is stripped to plain text; binary /
    non-text responses are rejected; content is capped at ``max_chars`` so a
    single page can never flood the context window. The response is streamed
    and reads at most ``MAX_FETCH_BYTES``, so oversized pages are truncated
    rather than rejected wholesale. Never raises.
    """
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"url": url, "error": "url must start with http:// or https://"}
    max_chars = max(500, min(int(max_chars or FETCH_EXCERPT_CHARS), MAX_FETCH_BYTES))
    try:
        import httpx

        with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True) as client:
            with client.stream(
                "GET",
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
                    )
                },
            ) as resp:
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
            body = b"".join(chunks).decode("utf-8", errors="replace")
            title = ""
            text = body
            if "text/html" in ct or ct == "":
                title, text = _html_to_text(body)
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "error": f"fetch failed: {exc}"}

    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) > max_chars:
        text = text[:max_chars] + "\n…(truncated)"
    return {"url": url, "title": title, "content": text}


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


# --------------------------------------------------------------------------- #
# Pydantic AI tool registrations
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
                sse = client.get(
                    url, headers={"Accept": "text/event-stream"}
                )
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
        "grep", "egrep", "fgrep", "rg", "ripgrep", "find", "sed", "awk",
        "cat", "ls", "head", "tail", "wc", "sort", "uniq", "type", "which",
        "nl", "tree", "file", "stat", "cut", "tr", "diff", "strings",
        "xxd", "od", "less", "more", "fold", "fmt", "paste", "join",
        "tac", "rev", "shuf", "seq", "xargs", "jq", "sqlite3",
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


def _explore_task_similar(a: str, b: str) -> float:
    """Similarity of two explore task strings: containment of the SMALLER token
    set in the larger one (inter / min). Unlike Dice, this separates "show me
    a.go" vs "show me b.go" (0.75 — different files, NOT deduped) from "find app
    logic" vs "find app logic in detail" (1.0 — same area rephrased, deduped).
    Tokens cover Latin + Persian words."""
    ta = set(re.findall(r"[\w\u0600-\u06FF]+", (a or "").lower()))
    tb = set(re.findall(r"[\w\u0600-\u06FF]+", (b or "").lower()))
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return inter / min(len(ta), len(tb))


def _explore_paths_compat(a: str, b: str) -> bool:
    """True when two explore path_hints constrain the same area: equal, one empty
    (unconstrained), or one is a sub-path of the other."""
    a = (a or "").strip().strip("/")
    b = (b or "").strip().strip("/")
    if not a or not b:
        return True
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def make_tool_callbacks(
    root: str,
    emit: Callable[[dict], None],
    context_window: int = 0,
    explore_model: Any = None,
    web_model: Any = None,
    search_model: Any = None,
    main_model: Any = None,
    permission_gates: dict | None = None,
    ask_gates: dict | None = None,
    permit: dict | None = None,
    store: VectorStore | None = None,
    chat_id: str = "",
    explore_seed: dict | None = None,
) -> dict[str, Callable]:
    """Build the agent tools bound to ``root`` with an emit callback.

    ``emit`` receives a dict like ``{"kind": "tool"|"tool_result", "tool": name,
    "args": ..., "summary": ...}`` so the UI can render live tool activity.

    ``context_window`` (when > 0) makes the agent budget its tool output so each
    result stays well within a small model's context window across a multi-step
    run — avoiding context overflow that truncates the session.

    Tools are async so pydantic-ai executes them on the event loop, keeping the
    shared emit callback aligned with the streaming loop.
    """

    # Correlate every tool call with its result via a per-invocation `call_id`.
    # The UI previously matched tool_results to running cards by (tool name +
    # status) alone, which breaks when the SAME tool runs multiple times in a
    # turn (e.g. 8× grep) or when explore's sub-agent emits identically-named
    # tool events into the same stream — results could resolve the wrong card,
    # leaving a genuinely-started card stuck on "running" forever.
    #
    # Parent tools carry their pairing through a `contextvars.ContextVar` set per
    # invocation: pydantic-ai runs parallel same-name tool calls as SEPARATE
    # async tasks (each with a copied context), and each task emits its own
    # `tool` then its own `tool_result`. Threading the id through the context
    # keeps tool→result correct even when parallel calls finish OUT of order — a
    # name-based FIFO (pop the oldest pending id) would otherwise swap the
    # results and, on a Stop, make the retried model think work was never done,
    # re-running duplicate tools.
    _call_seq = 0
    # Unique id per explore CALL: stamped on the explore card, its tool_result
    # and every sub-event so the frontend routes a call's sub-events to ITS OWN
    # card even when two explore calls run concurrently (the parent can issue
    # several in one parallel-tool-calls response). Without it, both calls'
    # sub-events nest into the first running explore card ("all parallel
    # explores show the same sub-searches"). One id per call — there is no
    # fan-out into multiple sub-agents anymore.
    _explore_call_seq = 0
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
        make_agent: Callable[[Any], Any],
        make_prompt: Callable[[], str],
        timeout_total: int = 60,
    ) -> tuple[Any, Any]:
        """Run a one-shot sub-agent distillation call (web distiller / page
        summarizer / terminal-search reader) with the shared retry policy,
        falling back to the MAIN model on a hard failure (bad key / invalid
        model / quota exhaustion). Returns ``(result, model_that_ran)`` so the
        caller can label usage + tool_result with the model that ACTUALLY ran.
        Sticky per slot per turn: a slot that already fell back skips the
        sub-agent model and goes straight to the main model."""
        from pydantic_ai.settings import ModelSettings as _MS

        model = main_model if _fallback_state.get(slot) else sub_model
        while True:
            try:
                agent = make_agent(model)
                res = await _run_subagent_call(
                    # Bind loop vars as defaults so the closure stays correct
                    # even if the callable is invoked after the loop advances.
                    lambda agent=agent, model=model: agent.run(
                        make_prompt(),
                        model_settings=_MS(
                            timeout=_providers.model_timeout(
                                model=model,
                                total=timeout_total,
                                connect=15,
                                read=timeout_total,
                            )
                        ),
                    ),
                    label,
                    emit=emit,
                    model_name=str(getattr(model, "model_name", "") or ""),
                )
                return res, model
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
        listing_count = max(15, ctx // 600)
        search_count = max(10, ctx // 500)
        terminal_out_chars = min(MAX_TERMINAL_OUTPUT, max(1_000, tool_out_chars * 1))
    else:
        tool_out_chars = MAX_READ_BYTES
        listing_count = 200
        search_count = 50
        terminal_out_chars = MAX_TERMINAL_OUTPUT
    tool_out_chars = min(tool_out_chars, MAX_READ_BYTES)

    # Shared state for the update_plan nudge backstop (see _format_plan_nudge_suffix
    # above) — lives for this run only, reset each time make_tool_callbacks is called.
    _plan_nudge_state = {"since_update": 0, "has_in_progress": False}
    # Cross-call explore memory: dict cache_key -> body of every tool result the
    # explore sub-agent(s) produced SO FAR this turn. Each new explore call seeds
    # its own _sub_result_cache from this and prepends an "already explored"
    # digest to its task_text, so repeated explore calls in one turn build on
    # earlier findings instead of each starting from zero (the observed 10-15
    # round re-discovery loop for broad styling tasks).
    _explore_turn_digest: dict[str, str] = dict(explore_seed or {})
    # Turn-level SHARED dedup state for CONCURRENT explore calls. The parent
    # model emits N explore tool calls in ONE response and pydantic-ai runs
    # them CONCURRENTLY (agents.py parallel_tool_calls=True) — so each call
    # used to seed its own per-call seen-sets from the digest at start, which
    # is EMPTY for all of them (none has finished yet), and every parallel call
    # re-discovered the same files/searches from zero (the "5 explores with
    # identical sub-searches" symptom). These sets/locks live at TURN level so
    # the first call to touch a file/search does the work and the others reuse
    # the cached result instead of re-running it.
    _explore_seen_listings: set[tuple[str, str]] = set()
    _explore_locks: dict[str, asyncio.Lock] = {}
    # Turn-level dedup of explore CALLS (the "چند تا اکسپلور با ساب ایجنت های
    # مثل هم" symptom): the parent model often fires SEVERAL explore calls in one
    # parallel-tool-calls response with near-identical tasks (same area
    # rephrased, or the same task with a different thoroughness). Each used to
    # spawn its own sub-agent card. `_explore_call_log` holds COMPLETED calls
    # (sequential dedup); `_explore_inflight` holds calls still running — a
    # concurrent near-duplicate awaits the matching in-flight call's report
    # instead of spawning its own sub-agent.
    _explore_call_log: list[dict] = []
    _explore_inflight: list[dict] = []
    # Was 5: a task that finishes in only 1-4 mutating tool calls after the last
    # update_plan (the common case for small tasks) never hit the threshold, so
    # the model could write its final reply with a step still stuck 'in_progress'
    # and no nudge ever fired. 1 nudges after EVERY mutating call while stuck, so
    # even a single-tool-call task gets reminded before the model's final reply.
    _PLAN_NUDGE_EVERY = 1

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
            adds = sum(1 for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))
            dels = sum(1 for l in diff.splitlines() if l.startswith("-") and not l.startswith("---"))
            emit({
                "kind": "diff",
                "tool": "write_file",
                "path": path,
                "diff": diff,
                "summary": f"{len(content)} chars · +{adds}/-{dels}",
            })
        emit({"kind": "tool_result", "tool": "write_file", "summary": f"{len(content)} chars"})
        verify_note = await asyncio.to_thread(verify_edit, root, path)
        return (
            f"Successfully wrote {len(content)} characters to {path}."
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    async def save_plan_tool(title: str, content: str) -> str:
        """PLAN MODE ONLY. Save the implementation plan you just wrote as markdown in the user data folder (per-chat, never inside the workspace), so the user or Coder mode can pick it up. Each call OVERWRITES this chat's plan — call ONCE after your '## Plan' text is final, with `title` (short) and `content` (the full plan markdown). The ONE write capability plan mode has; never writes workspace files."""
        emit({"kind": "tool", "tool": "save_plan", "args": {"title": title}})
        workspace_slug = slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep))) or "workspace"
        try:
            _state_db.save_plan(workspace_slug, title, content, chat_id=chat_id)
        except Exception as exc:  # noqa: BLE001
            msg = f"could not save plan: {exc}"
            emit(_error_result("save_plan", msg))
            return f"ERROR saving plan: {msg}"
        check_note = _self_check_plan_paths(root, content)
        emit({
            "kind": "tool_result",
            "tool": "save_plan",
            "summary": "saved" + (" (self-check flagged paths)" if check_note else ""),
        })
        return (
            "Saved the plan to the app database for this workspace. "
            "It will be offered again automatically on the next run in this workspace."
            + check_note
        )

    async def memory_tool(action: str, subject: str, text: str = "") -> str:
        """Curate the project's durable memory (RAG notes, loaded every future session). If the user asks to remember/keep something (any language), call with action='add' THIS SAME turn — the tool call IS the save; saying "I'll remember" saves nothing. action: 'add' (text), 'replace' (subject= find, text= new wording), 'remove' (subject= in the note). Also remember durable facts yourself (conventions, gotchas, build quirks, stated preferences). ENGLISH. No secrets, personal data, one-offs, or AGENTS.md content. Near cap prefer replace/remove."""
        emit({"kind": "tool", "tool": "memory", "args": {"action": action, "subject": subject, "text": text}})
        action = (action or "").strip().lower()
        try:
            if action == "replace":
                result = replace_memory(root, subject, text, store)
            elif action == "remove":
                result = remove_memory(root, subject, store)
            elif action in ("add", "remember", ""):
                result = remember(root, text or subject, store)
            else:
                msg = f"unknown action {action!r} (use add|replace|remove)"
                emit(_error_result("memory", msg))
                return f"ERROR: {msg}"
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("memory", msg))
            return f"ERROR updating memory: {msg}"
        if "error" in result:
            msg = result["error"]
            emit(_error_result("memory", msg))
            return f"ERROR updating memory: {msg}"
        if result.get("skipped") == "duplicate":
            emit({"kind": "tool_result", "tool": "memory", "summary": "already known"})
            return "Already remembered — a matching note already exists, nothing new was saved."
        if result.get("skip") == "not found":
            emit({"kind": "tool_result", "tool": "memory", "summary": "not found"})
            return "No matching memory found to remove; nothing changed."
        emit({"kind": "tool_result", "tool": "memory", "summary": f"ok ({action})"})
        return f"Memory updated ({action}). It will be loaded automatically in future sessions for this project."

    async def search_memory_tool(query: str = "", max_results: int = MEMORY_SEARCH_MAX_RESULTS) -> str:
        """Search this project's durable memory (RAG notes) for notes relevant to `query`. The most relevant notes to the current message are auto-injected every run, so you usually don't need this. Call when you need MORE: a different angle, older notes, or a mid-task check (e.g. a recurring error). Pass a few keywords (e.g. "port config", "auth flow"); leave query empty for the most recently added notes."""
        emit({"kind": "tool", "tool": "search_memory", "args": {"query": query}})
        try:
            result = search_memory(root, query, max_results, store)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("search_memory", msg))
            return f"ERROR searching memory: {msg}"
        if "error" in result:
            msg = result["error"]
            emit(_error_result("search_memory", msg))
            return f"ERROR searching memory: {msg}"
        notes = result.get("notes", [])
        total = result.get("total", 0)
        if total == 0:
            emit({"kind": "tool_result", "tool": "search_memory", "summary": "no notes yet"})
            return "No memory notes saved yet for this project."
        if not notes:
            emit({"kind": "tool_result", "tool": "search_memory", "summary": "no matches"})
            return f"No saved notes matched {query!r} (out of {total} total notes). Proceed without them."
        emit({"kind": "tool_result", "tool": "search_memory", "summary": f"{len(notes)}/{total} notes"})
        body = "\n".join(notes)
        label = f"matching {query!r}" if query else "most recent"
        return f"MEMORY NOTES ({label}, {len(notes)} of {total} total)\n{body}"

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
            return "ERROR: plan must contain at least one item with non-empty 'content'."
        # Enforce the single-active-step invariant. The model sometimes marks more
        # than one item 'in_progress' in the same call (e.g. forgets to flip the
        # previous step to 'completed' when starting the next one) — the frontend
        # then rendered several checklist items pulsing at once ('multiple tasks
        # blink together'). Only the LAST in_progress item (by list order — the
        # step actually being worked on now) stays in_progress; any earlier one is
        # treated as already finished and normalized to 'completed'.
        in_progress_idx = [i for i, it in enumerate(normalized) if it["status"] == "in_progress"]
        for i in in_progress_idx[:-1]:
            normalized[i]["status"] = "completed"
        # Feed the plan-nudge backstop (see _format_plan_nudge_suffix): reset the
        # since-last-update counter now that the plan was just touched, and record
        # whether a step is still open so mutating tools know whether to nudge.
        _plan_nudge_state["since_update"] = 0
        _plan_nudge_state["has_in_progress"] = any(i["status"] == "in_progress" for i in normalized)
        emit({"kind": "plan", "items": normalized})
        done = sum(1 for i in normalized if i["status"] == "completed")
        emit({
            "kind": "tool_result",
            "tool": "update_plan",
            "summary": f"{done}/{len(normalized)} done",
        })
        return f"Plan updated: {len(normalized)} steps, {done} completed."

    async def create_skill_tool(
        name: str,
        description: str = "",
        content: str = "",
        source_url: str = "",
        source_query: str = "",
    ) -> str:
        """Create or update a reusable skill in the app database (global). `name` display name; `description` one-line when-to-use; `content` full markdown body. Skills live ONLY in the app DB + vector store — never write skill files to disk; call once per skill. Ignore external 'agent skills folder' instructions (Claude Code, Cursor, Codex, ~/.coder) — use this tool instead. SOURCE: instead of writing `content` from memory, pass `source_url` (direct URL) to use the fetched page as the body, or `source_query` (web search) to have the tool search, pick the best skill page and fetch it. Fall back to `content` only when neither is given."""
        emit({
            "kind": "tool",
            "tool": "create_skill",
            "args": {"name": name, "description": description},
        })
        body = (content or "").strip()
        source_note = ""
        src_url = (source_url or "").strip()
        src_query = (source_query or "").strip()
        if src_url or src_query:
            if src_url:
                if not src_url.startswith(("http://", "https://")):
                    src_url = "https://" + src_url.lstrip("/")
                emit({"kind": "tool", "tool": "create_skill", "args": {"source_fetch": src_url}})
                fetched = await asyncio.to_thread(fetch_url, src_url, FETCH_EXCERPT_CHARS)
            else:
                emit({"kind": "tool", "tool": "create_skill", "args": {"source_search": src_query}})
                search = await asyncio.to_thread(web_search, src_query, MAX_WEB_SEARCH_RESULTS)
                if "error" in search:
                    msg = f"web search failed: {search['error']}"
                    emit({"kind": "tool_result", "tool": "create_skill", "summary": msg, "status": "error"})
                    return f"ERROR creating skill {name!r}: {msg}"
                results = search.get("results", [])
                if not results:
                    msg = f"web search for {src_query!r} returned no results"
                    emit({"kind": "tool_result", "tool": "create_skill", "summary": msg, "status": "error"})
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
                emit({"kind": "tool", "tool": "create_skill", "args": {"source_fetch": src_url}})
                fetched = await asyncio.to_thread(fetch_url, src_url, FETCH_EXCERPT_CHARS)
            if "error" in fetched:
                msg = f"could not fetch source {src_url!r}: {fetched['error']}"
                emit({"kind": "tool_result", "tool": "create_skill", "summary": msg, "status": "error"})
                return f"ERROR creating skill {name!r}: {msg}"
            real = (fetched.get("content") or "").strip()
            if len(real) < 50:
                msg = f"source {src_url!r} contained almost no readable text"
                emit({"kind": "tool_result", "tool": "create_skill", "summary": msg, "status": "error"})
                return f"ERROR creating skill {name!r}: {msg}"
            body = real
            source_note = f"built from real content fetched from {src_url} ({len(body)} chars)"
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
                    _first_line = next((l.strip() for l in body.splitlines() if l.strip() and not l.lstrip().startswith("#")), "")
                    _title = next((l.lstrip("#").strip() for l in body.splitlines() if l.lstrip().startswith("#")), "")
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
        indexed = result.get("indexed")
        summary = f"saved to the app database as skill {name!r}"
        if indexed is False:
            summary += " (not indexed — no embedding model available)"
        emit({
            "kind": "tool_result",
            "tool": "create_skill",
            "summary": summary,
        })
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
                emit({
                    "kind": "tool_result",
                    "tool": "create_mcp",
                    "summary": msg,
                })
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
        emit({
            "kind": "tool_result",
            "tool": "create_mcp",
            "summary": f"updated {name} in the app database",
        })
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
        emit({
            "kind": "tool",
            "tool": "edit_file",
            "args": {"path": path, "replace_all": replace_all},
        })
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
        adds = sum(1 for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))
        dels = sum(1 for l in diff.splitlines() if l.startswith("-") and not l.startswith("---"))
        emit({
            "kind": "diff",
            "tool": "edit_file",
            "path": path,
            "diff": diff,
            "summary": f"+{adds}/-{dels}",
        })
        occ = result.get("occurrences", 1)
        emit({"kind": "tool_result", "tool": "edit_file", "summary": f"+{adds}/-{dels}"})
        verify_note = await asyncio.to_thread(verify_edit, root, path)
        return (
            f"Successfully edited {path} ({occ} occurrence{'s' if occ != 1 else ''} replaced)."
            + _format_verify_suffix(verify_note)
            + _format_plan_nudge_suffix(_plan_nudge_due())
        )

    async def grep_tool(pattern: str, path: str = "", include: str = "") -> str:
        """Search file CONTENTS using a regular expression. `pattern` is a REGEX (matched case-insensitively, per line), so combine alternatives with `foo|bar` (full syntax like `function\\s+\\w+` works). `path` optionally restricts to a subdirectory (omit = whole workspace). `include` optionally filters files by glob, e.g. `*.ts` or `*.{ts,tsx}`. Respects .gitignore; skips hidden/binary files. Returns `file:line: text` blocks, truncated to fit context."""
        # The search sub-agent model is the one configured for search tools
        # (grep / glob / list_files). Label the event with it so the UI badge
        # shows which model this search slot runs on — the main model once the
        # slot has fallen back earlier in the turn.
        _search_runner = main_model if _fallback_state.get("search") else search_model
        _search_runner_name = str(getattr(_search_runner, "model_name", "") or "")
        emit({
            "kind": "tool",
            "tool": "grep",
            "args": {"pattern": pattern, "path": path, "include": include},
            "model": _search_runner_name,
        })
        try:
            result = search_in_files(root, pattern, path, 0, include)
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
            emit({"kind": "tool_result", "tool": "grep", "summary": "no matches", "model": _search_runner_name})
            return f"No matches for {pattern!r} under {path or '/'}."
        # Hard cap on the total characters returned so a broad search can't
        # flood the context window.
        lines: list[str] = []
        total = 0
        shown = 0
        for m in matches:
            if shown >= search_count:
                break
            block = [f"{m['file']}:{m['line']}: {m['text']}"]
            block_size = sum(len(b) + 1 for b in block)
            if lines and total + block_size > tool_out_chars:
                break
            lines.extend(block)
            shown += 1
            total += block_size
            if total >= tool_out_chars:
                break
        note = (
            f"\n({len(matches)} matches found, {shown} shown)"
            if len(matches) > shown
            else ""
        )
        raw = f"MATCHES for {pattern!r}\n" + "\n".join(lines) + note
        # When a dedicated "search" subagent model is configured, pass the raw
        # matches through the search subagent so it does the interpretation work
        # (and its tokens are accounted to the search model), instead of the
        # parent model reading the raw matches directly. On a hard sub-agent
        # failure the call falls back to the MAIN model (see _run_distill) —
        # the raw matches are only returned when BOTH models fail.
        _search_runner = main_model if _fallback_state.get("search") else search_model
        # NOTE: no `not _fallback_state` guard here — _run_distill itself picks
        # the main model once the slot has fallen back (sticky), so a later
        # grep in the same turn still gets distilled (by the main model) instead
        # of dumping raw matches into the parent context.
        if _search_runner is not None:
            try:
                from pydantic_ai import Agent as _SA
                from pydantic_ai.settings import ModelSettings as _SMS

                res, ran_model = await _run_distill(
                    "search",
                    _search_runner,
                    "search distiller",
                    lambda m: _SA(
                        m,
                        system_prompt=(
                            "You are a code-search reader. A regex search of the "
                            "codebase produced the raw matches below. Distill them "
                            "into a CONCISE answer (under ~150 words): what was found, "
                            "exact file paths and line numbers, and a one-line note on "
                            "the most relevant match. Do not restate the whole raw output."
                        ),
                        model_settings=_SMS(temperature=0.2, max_tokens=400),
                    ),
                    lambda: f"PATTERN: {pattern}\n\nMATCHES:\n" + "\n".join(lines),
                    timeout_total=60,
                )
                distilled = str(getattr(res, "output", "") or "").strip()
                if distilled:
                    from agents import _usage_event  # local import (circular-safe)

                    _usage_ev = _usage_event(
                        getattr(res, "usage", None),
                        model=str(getattr(ran_model, "model_name", "") or ""),
                    )
                    if _usage_ev:
                        emit(_usage_ev)
                    emit({
                        "kind": "tool_result",
                        "tool": "grep",
                        "summary": f"{len(matches)} matches (distilled)",
                        "model": str(getattr(ran_model, "model_name", "") or ""),
                    })
                    return f"SEARCH RESULTS for {pattern!r} (distilled)\n{distilled}"
            except Exception as exc:  # noqa: BLE001 — fall back to raw output
                _ran_name = str(
                    getattr(
                        main_model if _fallback_state.get("search") else search_model,
                        "model_name",
                        "",
                    )
                    or ""
                )
                _search_note = _subagent_fail_note("search", _ran_name, exc)
                if _search_note:
                    emit({
                        "kind": "tool_result",
                        "tool": "grep",
                        "summary": "search subagent failed — raw matches below",
                        "status": "error",
                        "model": _ran_name,
                    })
                    return f"SEARCH RESULTS for {pattern!r}\n{_search_note}\n" + "\n".join(lines)
        emit({"kind": "tool_result", "tool": "grep", "summary": f"{len(matches)} matches", "model": _search_runner_name})
        return raw

    async def terminal_tool(command: str, timeout: int = TERMINAL_TIMEOUT) -> str:
        """Run a shell command in the workspace root and return its output. The command runs with the project folder as the working directory, is killed after `timeout` seconds (default 120), and privileged/system-destructive commands (sudo, rm -rf /, mkfs, reboot, piping into a shell, ...) are blocked. Use this for git, package managers, build/run/lint/test commands and other project operations. NEVER use it to create, edit or delete files — use write_file for brand-new files and edit_file for changes to existing files (sed -i, patch, tee, redirects and python heredocs that write files are NOT acceptable substitutes)."""
        _reader_model = main_model if _fallback_state.get("search") else search_model
        _reader_model_name = (
            str(getattr(_reader_model, "model_name", "") or "")
            if _reader_model is not None
            else ""
        )
        _is_search_cmd = _is_terminal_search(command)
        emit({
            "kind": "tool",
            "tool": "run_terminal",
            "args": {"command": command},
            "model": _reader_model_name if _is_search_cmd else "",
        })
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
        # When a dedicated "search" subagent model is configured and this is a
        # codebase search (grep/rg/find/sed...), pass the raw output through the
        # search subagent so it does the interpretation work (and its tokens are
        # accounted to the search model in MODEL USAGE), instead of the parent
        # model reading the raw output directly. On a hard sub-agent failure the
        # call falls back to the MAIN model (see _run_distill) — the raw output
        # is only returned when BOTH models fail.
        _reader_model = main_model if _fallback_state.get("search") else search_model
        if _reader_model is not None and _is_terminal_search(command) and len(output) >= 600:
            try:
                from pydantic_ai import Agent as _SA
                from pydantic_ai.settings import ModelSettings as _SMS

                res, ran_model = await _run_distill(
                    "search",
                    _reader_model,
                    "terminal-search reader",
                    lambda m: _SA(
                        m,
                        system_prompt=(
                            "You are a code-search reader. A shell command searched the "
                            "codebase and produced the raw output below. Distill it into a "
                            "CONCISE answer (under ~150 words): what was found, exact file "
                            "paths and line numbers, and a one-line note on the most "
                            "relevant match. Do not restate the whole raw output."
                        ),
                        model_settings=_SMS(temperature=0.2, max_tokens=400),
                    ),
                    lambda: f"COMMAND: {command}\n\nOUTPUT:\n{output}",
                    timeout_total=60,
                )
                distilled = str(getattr(res, "output", "") or "").strip()
                if distilled:
                    from agents import _usage_event  # local import (circular-safe)

                    _usage_ev = _usage_event(
                        getattr(res, "usage", None),
                        model=str(getattr(ran_model, "model_name", "") or ""),
                    )
                    if _usage_ev:
                        emit(_usage_ev)
                    emit({
                        "kind": "tool_result",
                        "tool": "run_terminal",
                        "summary": f"search distilled · {len(distilled)} chars",
                        "model": str(getattr(ran_model, "model_name", "") or ""),
                    })
                    return (
                        f"$ {command}\n\nSEARCH SUBAGENT SUMMARY:\n{distilled}" + nudge
                    )
            except Exception as exc:  # noqa: BLE001 — fall back to raw output
                # Both the search subagent AND the main model failed. Say so with
                # the model name so the user can fix it in Settings → Subagents,
                # THEN provide the raw output as fallback.
                _ran_name = str(
                    getattr(
                        main_model if _fallback_state.get("search") else search_model,
                        "model_name",
                        "",
                    )
                    or ""
                )
                _search_note = _subagent_fail_note("search", _ran_name, exc)
                if _search_note:
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "run_terminal",
                            "summary": "search subagent failed — raw output below",
                            "status": "error",
                            "model": _ran_name,
                        }
                    )
                    return f"$ {command}\n{_search_note}\n{output}" + nudge
        emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary})
        # Exit code used to live ONLY in the emit() summary (UI-only) — the
        # model never saw it in the text it actually reads, so it had to guess
        # pass/fail purely from output text. Prepending it explicitly gives the
        # model a hard, unambiguous signal to check before declaring success.
        return f"$ {command}\nEXIT CODE: {result['exit_code']}\n{output}" + nudge

    async def glob_tool(pattern: str, path: str = "") -> str:
        """Find FILES by glob pattern. `pattern` is a glob like `**/*.js`, `src/**/*.ts`, or `*.test.py` (use `**` to match across directories). `path` optionally narrows the subtree (omit = whole workspace). Returns matching relative paths, truncated at 50. Respects .gitignore; skips hidden/binary files."""
        # Search-slot model label (same as grep): the search sub-agent, or the
        # main model once the slot has fallen back earlier in the turn.
        _search_runner = main_model if _fallback_state.get("search") else search_model
        _search_runner_name = str(getattr(_search_runner, "model_name", "") or "")
        emit({"kind": "tool", "tool": "glob", "args": {"pattern": pattern, "path": path}, "model": _search_runner_name})
        try:
            result = glob_files(root, pattern, path)
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
            emit({"kind": "tool_result", "tool": "glob", "summary": "no matches", "model": _search_runner_name})
            return f"No files match {pattern!r} under {path or '/'}."
        lines = list(matches[:50])
        note = f"\n({len(matches)} matches shown)" if len(matches) > 50 else ""
        raw = f"GLOB MATCHES for {pattern!r}\n" + "\n".join(lines) + note
        # When a dedicated "search" subagent model is configured, pass the raw
        # matches through the search subagent so it does the interpretation work
        # (and its tokens are accounted to the search model), instead of the
        # parent model reading the raw matches directly. On a hard sub-agent
        # failure the call falls back to the MAIN model (see _run_distill) —
        # the raw matches are only returned when BOTH models fail.
        _search_runner = main_model if _fallback_state.get("search") else search_model
        # NOTE: no `not _fallback_state` guard here — _run_distill itself picks
        # the main model once the slot has fallen back (sticky), so a later
        # glob in the same turn still gets distilled (by the main model) instead
        # of dumping raw matches into the parent context.
        if _search_runner is not None:
            try:
                from pydantic_ai import Agent as _SA
                from pydantic_ai.settings import ModelSettings as _SMS

                res, ran_model = await _run_distill(
                    "search",
                    _search_runner,
                    "search distiller",
                    lambda m: _SA(
                        m,
                        system_prompt=(
                            "You are a code-search reader. A glob search of the "
                            "codebase produced the raw file matches below. Distill them "
                            "into a CONCISE answer (under ~150 words): what files were found, "
                            "exact file paths, and a one-line note on the most relevant match. "
                            "Do not restate the whole raw output."
                        ),
                        model_settings=_SMS(temperature=0.2, max_tokens=400),
                    ),
                    lambda: f"PATTERN: {pattern}\n\nMATCHES:\n" + "\n".join(lines),
                    timeout_total=60,
                )
                distilled = str(getattr(res, "output", "") or "").strip()
                if distilled:
                    from agents import _usage_event  # local import (circular-safe)

                    _usage_ev = _usage_event(
                        getattr(res, "usage", None),
                        model=str(getattr(ran_model, "model_name", "") or ""),
                    )
                    if _usage_ev:
                        emit(_usage_ev)
                    emit({
                        "kind": "tool_result",
                        "tool": "glob",
                        "summary": f"{len(matches)} matches (distilled)",
                        "model": str(getattr(ran_model, "model_name", "") or ""),
                    })
                    return f"SEARCH RESULTS for {pattern!r} (distilled)\n{distilled}"
            except Exception as exc:  # noqa: BLE001 — fall back to raw output
                _ran_name = str(
                    getattr(
                        main_model if _fallback_state.get("search") else search_model,
                        "model_name",
                        "",
                    )
                    or ""
                )
                _search_note = _subagent_fail_note("search", _ran_name, exc)
                if _search_note:
                    emit({
                        "kind": "tool_result",
                        "tool": "glob",
                        "summary": "search subagent failed — raw matches below",
                        "status": "error",
                        "model": _ran_name,
                    })
                    return f"SEARCH RESULTS for {pattern!r}\n{_search_note}\n" + "\n".join(lines)
        emit({"kind": "tool_result", "tool": "glob", "summary": f"{len(matches)} matches", "model": _search_runner_name})
        return raw

    async def read_tool(filePath: str, offset: int = 1, limit: int = 2000) -> str:
        """Read a file (verbatim code) or, if `filePath` is a directory, list its entries. `filePath` is workspace-relative. For FILES: `offset` is the 1-indexed line to start at (default 1) and `limit` caps the number of lines returned (default 2000) — page large files with offset/limit. For DIRECTORIES: lists entries one per line (subdirs marked with a trailing `/`), paged by offset/limit. Use AFTER you know the exact path (from glob/grep/explore) — not for discovery."""
        # Search-slot model label (same as grep/glob): the search sub-agent, or
        # the main model once the slot has fallen back earlier in the turn.
        _search_runner = main_model if _fallback_state.get("search") else search_model
        _search_runner_name = str(getattr(_search_runner, "model_name", "") or "")
        emit({"kind": "tool", "tool": "read", "args": {"filePath": filePath, "offset": offset, "limit": limit}, "model": _search_runner_name})
        try:
            target = resolve_safe(root, filePath, allow_coder=True)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        if os.path.isdir(target):
            raw = await _read_dir_tool(target, filePath, offset, limit, _search_runner_name)
            # When a dedicated "search" subagent model is configured, pass the raw
            # directory listing through the search subagent so it does the interpretation work
            # (and its tokens are accounted to the search model). On a hard sub-agent
            # failure the call falls back to the MAIN model (see _run_distill).
            _search_runner = main_model if _fallback_state.get("search") else search_model
            # NOTE: no `not _fallback_state` guard here — _run_distill itself
            # picks the main model once the slot has fallen back (sticky), so a
            # later directory read in the same turn still gets distilled (by the
            # main model) instead of dumping raw entries into the parent context.
            if _search_runner is not None:
                try:
                    from pydantic_ai import Agent as _SA
                    from pydantic_ai.settings import ModelSettings as _SMS

                    res, ran_model = await _run_distill(
                        "search",
                        _search_runner,
                        "search distiller",
                        lambda m: _SA(
                            m,
                            system_prompt=(
                                "You are a code-search reader. A directory listing of the "
                                "codebase produced the raw entries below. Distill them "
                                "into a CONCISE answer (under ~150 words): what files/directories "
                                "were found, and a one-line note on the most relevant entries. "
                                "Do not restate the whole raw output."
                            ),
                            model_settings=_SMS(temperature=0.2, max_tokens=400),
                        ),
                        lambda: f"DIRECTORY: {filePath}\n\nENTRIES:\n" + raw.split("\n", 1)[1] if "\n" in raw else raw,
                        timeout_total=60,
                    )
                    distilled = str(getattr(res, "output", "") or "").strip()
                    if distilled:
                        from agents import _usage_event  # local import (circular-safe)

                        _usage_ev = _usage_event(
                            getattr(res, "usage", None),
                            model=str(getattr(ran_model, "model_name", "") or ""),
                        )
                        if _usage_ev:
                            emit(_usage_ev)
                        emit({
                            "kind": "tool_result",
                            "tool": "read",
                            "summary": f"directory distilled · {len(distilled)} chars",
                            "model": str(getattr(ran_model, "model_name", "") or ""),
                        })
                        return f"DIRECTORY {filePath} (distilled)\n{distilled}"
                except Exception as exc:  # noqa: BLE001 — fall back to raw output
                    _ran_name = str(
                        getattr(
                            main_model if _fallback_state.get("search") else search_model,
                            "model_name",
                            "",
                        )
                        or ""
                    )
                    _search_note = _subagent_fail_note("search", _ran_name, exc)
                    if _search_note:
                        emit({
                            "kind": "tool_result",
                            "tool": "read",
                            "summary": "search subagent failed — raw listing below",
                            "status": "error",
                            "model": _ran_name,
                        })
                        return f"DIRECTORY {filePath}\n{_search_note}\n" + raw.split("\n", 1)[1] if "\n" in raw else raw
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
        truncated = excerpt["truncated"]
        if not lines:
            msg = f"line offset {start} is past the end of the file ({total} lines)"
            emit(_error_result("read", msg))
            return f"ERROR reading {filePath}: {msg}"
        body = "\n".join(f"{ln['line']}: {ln['text']}" for ln in lines)
        if truncated:
            next_line = lines[-1]["line"] + 1
            body = f"{body}\n\n(Showing lines {start}-{lines[-1]['line']} of {total}. Use offset={next_line} to continue.)"
        else:
            body = f"{body}\n\n(End of file — total {total} lines)"
        emit({"kind": "tool_result", "tool": "read", "summary": f"{len(lines)} lines", "model": _search_runner_name})
        return f"{filePath}\n{body}"

    async def _read_dir_tool(target: str, filePath: str, offset: int, limit: int, _model: str = "") -> str:
        """Directory branch of the read tool (opencode-style listing)."""
        try:
            names = sorted(os.listdir(target), key=lambda n: (n.lower(),))
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
        window = entries[start - 1: start - 1 + count]
        footer = (
            f"({len(entries)} entries, showing {start}-{start - 1 + len(window)})"
            if start - 1 + len(window) < len(entries)
            else f"({len(entries)} entries)"
        )
        body = "\n".join(window) if window else "(empty directory)"
        emit({"kind": "tool_result", "tool": "read", "summary": f"directory · {len(entries)} entries", "model": _model})
        return f"DIRECTORY {filePath or '/'}\n{body}\n{footer}"

    async def explore_tool(task: str, path_hint: str = "", hints: str = "", thoroughness: str = "medium") -> str:
        """Delegate a broad, read-only investigation to ONE ISOLATED sub-agent (its own search loop/context; only a short report reaches you). Use instead of a long chain of your own grep/glob/read when a question spans MANY files or an unfamiliar area. The sub-agent is a file-search specialist (like opencode's `explore`): it searches with glob/grep/read itself, in parallel tool calls, and hands back a compact structured report. Pass a clear, SPECIFIC `task`; optionally `path_hint` (subdir, e.g. 'src/components'), `hints` (known symbols/files), and `thoroughness` ('quick' | 'medium' | 'very thorough' — how deep to sweep; default 'medium'). Not for a single lookup — search yourself."""
        # The model that will run this explore call: ALWAYS the explore
        # sub-agent. Per-sub-search fallback to the MAIN model happens INSIDE
        # _run_explore (the _PerStepFallbackModel wrapper), so a failed search
        # never flips the whole explore — or the rest of the turn — onto the
        # main model (non-sticky).
        _run_model = explore_model
        _run_model_name = str(getattr(_run_model, "model_name", "") or "")
        if explore_model is None:
            emit({"kind": "tool", "tool": "explore", "args": {"task": task}, "model": ""})
            emit(_error_result("explore", "unavailable"))
            return "ERROR: explore is unavailable (no model configured for this session)."

        # CODE-LEVEL DEDUP of explore CALLS: the parent model often fires several
        # explore calls in ONE parallel-tool-calls response with near-identical
        # tasks (same area rephrased, or the same task with a different
        # thoroughness). Each used to spawn its own sub-agent card — the
        # "چند تا اکسپلور با ساب ایجنت های مثل هم" symptom. A near-duplicate
        # (containment >= 0.8 on the task text + compatible path_hint) reuses the
        # earlier report instead of spawning another sub-agent — unless the NEW
        # call explicitly asks for deeper thoroughness than the earlier one ran.
        def _explore_reuse(prior: dict) -> str:
            return (
                "[NOTE: this explore task is nearly identical to an explore already "
                "run this turn — reusing its report instead of spawning another "
                "sub-agent.]\n\n"
                + str(prior.get("report") or "")
            )

        def _explore_sig_matches(ent: dict) -> bool:
            if not _explore_paths_compat(ent.get("path_hint", ""), path_hint):
                return False
            if _explore_task_similar(ent.get("task", ""), task) < 0.8:
                return False
            prior_thorough = str(ent.get("thoroughness") or "medium")
            # the new call explicitly wants a deeper sweep
            return not (
                thoroughness == "very thorough" and prior_thorough != "very thorough"
            )

        for _prior in reversed(_explore_call_log):
            if _explore_sig_matches(_prior):
                return _explore_reuse(_prior)
        for _ent in _explore_inflight:
            if _explore_sig_matches(_ent):
                _report = await asyncio.shield(_ent["future"])
                return _explore_reuse({"report": _report})

        # Sub-agent-specific tighter limits — keeps tool output compact
        # so the sub-agent model sees only relevant data, never megabytes.
        _sub_listing_count = min(listing_count, 15)
        _sub_search_count = min(search_count, 15)
        _sub_tool_out_chars = max(400, min(tool_out_chars, 5_000))

        # The model name stamped on the sub-agent's internal tool events. Updated
        # per _run_explore(model) so a fallback run on the main model labels its
        # read/grep/glob events with the main model, not the failed sub-agent's.
        _sub_emit_model_name = _run_model_name
 
        # Per-branch emit state: with a PARALLEL fan-out each branch runs in its
        # own asyncio task, so a shared mutable model-name variable would race
        # (one branch fallback would mislabel another branch events). Each
        # _run_explore branch sets its OWN emit closure into this contextvar —
        # contextvars are per-task, so the shared sub-tools pick up the right
        # branch closure (and branch id) automatically.
        _sub_emit_ctx: contextvars.ContextVar = contextvars.ContextVar(
            "explore_sub_emit", default=None
        )

        # Per-branch dedup for SEARCHES only. READS dedup against the SHARED
        # turn-level _explore_seen_listings (defined in make_tool_callbacks): a
        # read is idempotent — same
        # path+offset+limit always yields the same bytes — so sharing is safe
        # and lets every parallel branch reuse the first branch's reads instead
        # of each re-reading the same files (the "all parallel explores show
        # the same sub-searches" symptom). SEARCHES stay per-branch: a SHARED
        # search seen-set would fold branch B's broader query into branch A's
        # more-specific one ("fastapi" folded into "fastapiroutes"), making
        # every branch reuse the first branch's cached findings and converge on
        # the same searches. Each _run_explore branch sets its OWN search-set
        # copy (seeded from the turn-level digest = prior work) into this
        # contextvar; the shared sub-tools read per-branch searches + the
        # SHARED listings, so branches stay independent on searches while
        # never re-reading files another branch already read this call.
        _sub_seen_searches_ctx: contextvars.ContextVar = contextvars.ContextVar(
            "explore_sub_seen_searches", default=None
        )

        def _sub_seen() -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
            searches = _sub_seen_searches_ctx.get()
            if searches is None:
                searches = _sub_seen_searches
            return searches, _explore_seen_listings
 
        def _sub_emit(event: dict) -> None:
            branch_emit = _sub_emit_ctx.get()
            if branch_emit is not None:
                branch_emit(event)
                return
            # Forward to the same UI stream (so the user sees live sub-agent
            # activity) but tagged `sub=True` so the PARENT's deterministic
            # tool-step budget (see agents.py) does not count these steps —
            # they never enter the parent model's own resent transcript, only
            # the sub-agent's, which is discarded once explore_tool returns.
            event = dict(event)
            event["sub"] = True
            event.setdefault("model", _sub_emit_model_name)
            emit(event)

        # Code-enforced dedup for the sub-agent's search tools. The sub-agent
        # model repeatedly re-searches the same area with only minor keyword
        # variation ("FastAPI" then "FastAPI" again, "@app" then "@app." then
        # "@app.get") — each is a fresh model request that re-resends its whole
        # isolated transcript, the single biggest token burn in an explore run.
        # A prompt instruction to "not repeat" is not enough; this makes an
        # exact repeat return a short stop-signal instead of burning another
        # round-trip, and near-duplicate prefixes are folded in too.
        #
        # Each tool's ACTUAL result is also cached (keyed the same way). That
        # serves two purposes: (1) a dedup hit returns the real findings — with
        # an "ALREADY" prefix — instead of a memory-based stop-signal, and (2)
        # when the run is retried after a step-budget / context overflow (see
        # the widen loop below), a FRESH sub-agent model has no memory of the
        # prior attempt, so its re-issued queries get the cached results back
        # instead of a dead-end "use the result you already have" it never got.
        _sub_seen_searches: set[tuple[str, str]] = set()
        _sub_result_cache: dict[str, str] = dict(_explore_turn_digest)

        def _sub_search_key(query: str, path: str) -> tuple[str, str]:
            q = re.sub(r"[^a-z0-9_.@]+", "", (query or "").lower())
            p = re.sub(r"[^a-z0-9_.@/]+", "", (path or "").lower())
            return (q, p)

        # Seed the seen-sets from the turn-level digest so a NEW explore call
        # (fresh sub-agent, no memory) treats earlier calls' searches/listings as
        # already done: a re-issued query gets the cached result back instead of
        # burning a real search. Digest keys are "tool|query|path" — rebuild the
        # (query, path) tuples for grep/glob/read entries.
        for _ckey in list(_explore_turn_digest.keys()):
            _parts = _ckey.split("|", 2)
            if len(_parts) != 3:
                continue
            _ctool, _cq, _cp = _parts
            if _ctool in ("grep", "glob") and _cq:
                _sub_seen_searches.add((_cq, _cp))
            elif _ctool == "read":
                _explore_seen_listings.add((_cq or _cp, _cp))

        def _sub_cache_key(tool: str, key: tuple[str, str]) -> str:
            return f"{tool}|{key[0]}|{key[1]}"

        def _sub_cached(tool: str, key: tuple[str, str]) -> str | None:
            ckey = _sub_cache_key(tool, key)
            body = _sub_result_cache.get(ckey)
            if body is None:
                # Live cross-call check: parallel explore calls each snapshot
                # the digest at start, so a read another call completed AFTER
                # this call's seed is not in _sub_result_cache yet — check the
                # shared turn-level digest directly.
                body = _explore_turn_digest.get(ckey)
            return body

        def _sub_cache_put(tool: str, key: tuple[str, str], body: str) -> None:
            """Store a tool result in BOTH the per-call cache and the turn-level
            digest, so a later explore call in the same turn can reuse it."""
            ckey = _sub_cache_key(tool, key)
            _sub_result_cache[ckey] = body
            _explore_turn_digest[ckey] = body
            _persist_explore_digest()

        def _persist_explore_digest() -> None:
            """Persist the turn-level explore digest to disk (same resume file
            the agent's tool-resume uses), so an explore call AFTER a disconnect /
            app restart still dedups against what was already explored instead of
            re-discovering from zero. Best-effort + throttled: never raises, and
            never clobbers the agent's own `tools` resume records — it merges."""
            if not chat_id:
                return
            try:
                _prev = _state_db.load_turn_resume(root, chat_id) or {}
                _prev["explore_digest"] = dict(_explore_turn_digest)
                _state_db.save_turn_resume(root, chat_id, _prev)
            except Exception:  # noqa: BLE001, S110 — best-effort, never fails the tool
                pass

        def _sub_resume_note() -> str:
            """Distilled summary of the sub-agent's completed tool work, fed back
            on a widen/overflow retry so a fresh model continues from the cached
            findings instead of re-exploring from zero. Stays small (tail only)."""
            if not _sub_result_cache:
                return ""
            items = list(_sub_result_cache.items())[-30:]
            omitted = len(_sub_result_cache) - len(items)
            lines = []
            for cache_key, body in items:
                parts = cache_key.split("|", 2)
                tool = parts[0]
                label = parts[1] if len(parts) > 1 and parts[1] else (parts[2] if len(parts) > 2 else "/")
                snippet = body[:300].replace("\n", " ")
                if len(body) > 300:
                    snippet += "…"
                lines.append(f"- {tool}({label}): {snippet}")
            note = "\n".join(lines)
            if omitted:
                note += f"\n({omitted} earlier results omitted)"
            return (
                "Exploration work already completed in earlier attempts — do NOT redo it. "
                "Use these cached results and continue where the investigation stopped:\n"
                f"{note}"
            )

        def _sub_verify_report_paths(report: str) -> list[str]:
            """Find `path:line` references in a sub-agent report that point at
            files that do not exist under `root`. Returns a short list of bad
            refs (capped) or [] when everything cited exists. Purely disk-based —
            no model calls, so accuracy is verified without burning tokens."""
            if not report:
                return []
            root_real = os.path.realpath(os.path.abspath(root))
            bad: list[str] = []
            seen: set[tuple[str, str]] = set()
            for m in _CITATION_RE.finditer(report):
                rel = m.group(1)
                line = m.group(2)
                key = (rel, line)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    cand = os.path.realpath(os.path.join(root, rel.lstrip("/")))
                except Exception:  # noqa: BLE001, S112 — unreadable entry just isn't flagged
                    continue
                if cand == root_real or not cand.startswith(root_real + os.sep):
                    continue
                if not os.path.isfile(cand):
                    bad.append(f"{rel}:{line}")
                    if len(bad) >= 15:
                        break
            return bad

        def _sub_check_seen(tool: str, key: tuple[str, str], query: str, path: str) -> str | None:
            # LIVE cross-call check FIRST: a PARALLEL explore call (same turn)
            # may have already run this exact search — its result is in the
            # SHARED turn-level digest, but this branch's per-branch search-set
            # was seeded at START (when the digest was still empty for all
            # concurrent calls), so it's not in _seen_searches yet. Checking the
            # shared digest here is what makes the 2nd..Nth concurrent explore
            # call reuse the first call's findings instead of re-searching the
            # same area from scratch. Exact-key only — no broader/narrower
            # folding across calls (that stays per-branch below, so branches
            # don't converge on the first branch's queries).
            cached = _sub_cached(tool, key)
            if cached is not None:
                _sub_emit(
                    {
                        "kind": "tool_result",
                        "tool": tool,
                        "summary": "already searched",
                    }
                )
                return (
                    f"ALREADY SEARCHED: you ran this exact search "
                    f"({query!r} under {path or '/'}) earlier. Result from earlier:\n"
                    f"{cached}"
                )
            _seen_searches, _ = _sub_seen()
            for seen_key in _seen_searches:
                # Exact repeat: return the cached result (real data, even for a
                # fresh model on retry), not a dead-end "use your memory".
                if key == seen_key:
                    cached = _sub_cached(tool, key)
                    body = (
                        cached
                        if cached
                        else f"(no stored result for {query!r} under {path or '/'})"
                    )
                    _sub_emit(
                        {
                            "kind": "tool_result",
                            "tool": "grep",
                            "summary": "already searched",
                        }
                    )
                    return (
                        f"ALREADY SEARCHED: you ran this exact search "
                        f"({query!r} under {path or '/'}) earlier. Result from earlier:\n"
                        f"{body}"
                    )
                # Broader re-search of a more-specific earlier one: the specific
                # result already contains the useful signal — return it.
                if path == seen_key[1] and key[0] and seen_key[0].startswith(key[0]):
                    cached = _sub_cached(tool, seen_key)
                    body = cached or "(no stored result)"
                    _sub_emit(
                        {
                            "kind": "tool_result",
                            "tool": "grep",
                            "summary": "already searched",
                        }
                    )
                    return (
                        f"ALREADY SEARCHED: you previously searched a more specific term "
                        f"({seen_key[0]!r}) under {path or '/'}. Result from earlier:\n"
                        f"{body}"
                    )
            return None

        async def _sub_read(filePath: str = "", offset: int = 1, limit: int = 2000) -> str:
            """Sub-agent read: one file (line-paged) or one directory (listing)."""
            _sub_emit({
                "kind": "tool", "tool": "read",
                "args": {"filePath": filePath, "offset": offset, "limit": limit},
            })
            lkey = _sub_search_key(f"o{int(offset or 1)}l{int(limit or 2000)}", filePath) or (filePath, "")
            # Listing a directory is idempotent: re-listing the SAME directory
            # later in a run returns the same tree and only re-resends the whole
            # sub-agent transcript for nothing. Fold repeats (the sub-agent
            # re-listed backend/, the root and scripts/ three times during a
            # retry). The key includes offset/limit so a DIFFERENT line range of
            # the same file is NOT folded into an earlier read — otherwise the
            # sub-agent asking for agents.py:3250-3269 after agents.py:3240-3339
            # gets the old range back forever and loops re-requesting it.
            #
            # Per-key lock across CONCURRENT explore calls: the parent emits N
            # explore calls in one response and pydantic-ai runs them at the
            # same time, so two calls can reach this read before EITHER has
            # cached it — without the lock both re-read the file from scratch.
            # The lock serializes them: first does the work + caches, the rest
            # re-check the digest and get "already read/listed".
            _lock = _explore_locks.setdefault(
                _sub_cache_key("read", lkey), asyncio.Lock()
            )
            async with _lock:
                if lkey in _sub_seen()[1] or _sub_cache_key("read", lkey) in _explore_turn_digest:
                    cached = _sub_cached("read", lkey)
                    body = cached or f"(no stored result for {filePath or '/'})"
                    _sub_emit(
                        {
                            "kind": "tool_result",
                            "tool": "read",
                            "summary": "already read/listed",
                        }
                    )
                    return (
                        f"ALREADY READ: you read {filePath or '/'} earlier. Result from earlier:\n"
                        f"{body}"
                    )
                try:
                    target = resolve_safe(root, filePath, allow_coder=True)
                except PathEscapeError as exc:
                    msg = f"invalid path: {exc}"
                    _sub_emit(_error_result("read", msg))
                    return f"ERROR reading {filePath}: {msg}"
                if os.path.isdir(target):
                    result = list_files(root, filePath)
                    if "error" in result:
                        _sub_emit(_error_result("read", result["error"]))
                        return f"ERROR reading {filePath}: {result['error']}"
                    lines = []
                    for entry in result["entries"][:_sub_listing_count]:
                        marker = "/" if entry["kind"] == "dir" else "  "
                        lines.append(f"{marker}{entry['name']}")
                    if len(result["entries"]) > _sub_listing_count:
                        lines.append(f"…({len(result['entries']) - _sub_listing_count} more entries)")
                    body = "\n".join(lines) if lines else "(empty directory)"
                    out = f"DIRECTORY {filePath or '/'}\n{body}"
                else:
                    if not os.path.exists(target):
                        out = f"ERROR reading {filePath}: file not found"
                    elif not _is_text_path(target):
                        out = f"ERROR reading {filePath}: binary file (read skipped)"
                    else:
                        excerpt = _read_lines_excerpt(target, offset, limit)
                        if excerpt.get("error"):
                            out = f"ERROR reading {filePath}: {excerpt['error']}"
                        elif not excerpt["lines"]:
                            out = f"ERROR reading {filePath}: line offset {offset} is past the end"
                        else:
                            rows = [f"{ln['line']}: {ln['text']}" for ln in excerpt["lines"]]
                            if excerpt["truncated"]:
                                rows.append(
                                    f"\n(Showing lines {excerpt['start']}-{excerpt['lines'][-1]['line']}"
                                    f" of {excerpt['total']}. Use offset={excerpt['lines'][-1]['line'] + 1} to continue.)"
                                )
                            else:
                                rows.append(f"\n(End of file — total {excerpt['total']} lines)")
                            out = f"{filePath}\n" + "\n".join(rows)
                _sub_seen()[1].add(lkey)
                _sub_cache_put("read", lkey, out)
                _sub_emit({"kind": "tool_result", "tool": "read", "summary": "read"})
                return out

        async def _sub_grep(pattern: str, path: str = "", include: str = "") -> str:
            _sub_emit({"kind": "tool", "tool": "grep", "args": {"pattern": pattern, "path": path, "include": include}})
            key = _sub_search_key(pattern, path)
            # Per-key lock across CONCURRENT explore calls (see _sub_read): the
            # parent emits N explore calls in one response and they run at the
            # same time, so two calls can issue the SAME grep before either has
            # cached it. Serialize them: first searches + caches, the rest
            # re-check the digest via _sub_check_seen and get the cached result.
            _lock = _explore_locks.setdefault(
                _sub_cache_key("grep", key), asyncio.Lock()
            )
            async with _lock:
                if key[0]:
                    stop = _sub_check_seen("grep", key, pattern, path)
                    if stop is not None:
                        return stop
                    _sub_seen()[0].add(key)
                try:
                    result = search_in_files(root, pattern, path, 0, include)
                except PathEscapeError as exc:
                    msg = f"invalid path: {exc}"
                    _sub_emit(_error_result("grep", msg))
                    return f"ERROR searching {path}: {msg}"
                if result.get("error"):
                    msg = result["error"]
                    _sub_emit(_error_result("grep", msg))
                    return f"ERROR searching {path}: {msg}"
                matches = result.get("matches", [])
                if not matches:
                    out = f"No matches for {pattern!r} under {path or '/'}."
                    if key[0]:
                        _sub_cache_put("grep", key, out)
                    _sub_emit({"kind": "tool_result", "tool": "grep", "summary": "no matches"})
                    return out
                lines: list[str] = []
                total = 0
                shown = 0
                for m in matches:
                    if shown >= _sub_search_count:
                        break
                    block = [f"{m['file']}:{m['line']}: {m['text']}"]
                    block_size = sum(len(b) + 1 for b in block)
                    if lines and total + block_size > _sub_tool_out_chars:
                        break
                    lines.extend(block)
                    shown += 1
                    total += block_size
                    if total >= _sub_tool_out_chars:
                        break
                note = f"\n({len(matches)} matches found, {shown} shown)" if len(matches) > shown else ""
                out = f"MATCHES for {pattern!r}\n" + "\n".join(lines) + note
                if key[0]:
                    _sub_cache_put("grep", key, out)
                _sub_emit({"kind": "tool_result", "tool": "grep", "summary": f"{len(matches)} matches"})
                return out

        async def _sub_glob(pattern: str, path: str = "") -> str:
            _sub_emit({"kind": "tool", "tool": "glob", "args": {"pattern": pattern, "path": path}})
            key = _sub_search_key(pattern, path)
            # Per-key lock across CONCURRENT explore calls (see _sub_read/_sub_grep).
            _lock = _explore_locks.setdefault(
                _sub_cache_key("glob", key), asyncio.Lock()
            )
            async with _lock:
                if key[0]:
                    stop = _sub_check_seen("glob", key, pattern, path)
                    if stop is not None:
                        return stop
                    _sub_seen()[0].add(key)
                try:
                    result = glob_files(root, pattern, path)
                except PathEscapeError as exc:
                    msg = f"invalid path: {exc}"
                    _sub_emit(_error_result("glob", msg))
                    return f"ERROR running glob {pattern!r} under {path or '/'}: {msg}"
                matches = result.get("matches", [])
                if not matches:
                    out = f"No files match glob {pattern!r} under {path or '/'}."
                    if key[0]:
                        _sub_cache_put("glob", key, out)
                    _sub_emit({"kind": "tool_result", "tool": "glob", "summary": "no matches"})
                    return out
                lines = list(matches[:50])
                out = f"GLOB MATCHES for {pattern!r}\n" + "\n".join(lines)
                if key[0]:
                    _sub_cache_put("glob", key, out)
                _sub_emit({"kind": "tool_result", "tool": "glob", "summary": f"{len(matches)} matches"})
                return out

        from pydantic_ai.exceptions import UsageLimitExceeded as _UsageLimitExceeded

        async def _run_explore_inner(
            model: Any, task_text: str, state: dict,
            branch_index: int = 0, branch_total: int = 1,
            thoroughness: str = "medium",
        ) -> str:
            """Run the isolated exploration sub-agent on ``model`` with the given
            task text (path_hint/hints already prepended by the caller) and return
            its report. The model is wrapped in a _PerStepFallbackModel, so every
            individual grep/read/glob request first tries the sub-agent model and,
            on a failure, re-runs THAT request on the MAIN model — the next
            sub-search goes back to the sub-agent model (non-sticky per-sub-search
            fallback instead of flipping the whole explore). Reuses the dedup
            caches so a resumed run continues from the failed attempt's findings
            instead of re-exploring from zero. Raises ``_UsageLimitExceeded``
            (step budget — NOT a model failure, so no fallback) or the underlying
            exception when BOTH models fail a step. state["model"] is the per-branch model name stamped on this branch sub-agent events (set by the _run_explore wrapper, updated on per-sub-search fallback)."""
            from pydantic_ai import Agent as _Agent
            from pydantic_ai import Tool as _Tool
            from pydantic_ai.messages import (
                ModelRequest as _ModelRequest,
            )
            from pydantic_ai.messages import (
                SystemPromptPart as _SystemPromptPart,
            )
            from pydantic_ai.settings import ModelSettings as _ModelSettings
            from pydantic_ai.usage import UsageLimits as _UsageLimits

            # PER-SUB-SEARCH FALLBACK (non-sticky): wrap the model so every
            # individual grep/read/glob request first tries the sub-agent model
            # and, on a failure, re-runs THAT request on the MAIN model — the
            # next sub-search goes back to the sub-agent model. The events for
            # each sub-search are labeled with the model that ACTUALLY ran it.
            _primary_name = str(getattr(model, "model_name", "") or "")
            _fallback_model = main_model if main_model is not None else model
            _fallback_name = str(getattr(_fallback_model, "model_name", "") or "")

            def _on_step_fallback(exc: Exception) -> None:
                state["model"] = _fallback_name
                try:
                    emit(
                        {
                            "kind": "retry",
                            "attempt": 1,
                            "max_attempts": 1,
                            "delay": 0,
                            "reason": (
                                f"explore sub-search failed on the {_primary_name} model — "
                                f"using the main model ({_fallback_name}) for THIS search only"
                            ),
                            "model": _fallback_name,
                            "agent": "explore sub-agent",
                            "fallback": True,
                        }
                    )
                except Exception:  # noqa: BLE001, S110 — cosmetic only
                    pass

            def _on_step_primary() -> None:
                state["model"] = _primary_name

            _run_model_wrapped = _PerStepFallbackModel(
                model,
                _fallback_model,
                on_fallback=_on_step_fallback,
                on_primary=_on_step_primary,
            )
            # Cross-call memory: if earlier explore calls this turn already
            # discovered files/areas, feed them to this fresh sub-agent so it
            # builds on that work instead of re-listing/re-searching from zero.
            if _explore_turn_digest:
                items = list(_explore_turn_digest.items())[-20:]
                omitted = len(_explore_turn_digest) - len(items)
                digest_lines = []
                for ckey, body in items:
                    parts = ckey.split("|", 2)
                    tool = parts[0]
                    label = parts[1] if len(parts) > 1 and parts[1] else (parts[2] if len(parts) > 2 else "/")
                    snippet = body[:200].replace("\n", " ")
                    if len(body) > 200:
                        snippet += "…"
                    digest_lines.append(f"- {tool}({label}): {snippet}")
                digest_note = "\n".join(digest_lines)
                if omitted:
                    digest_note += f"\n({omitted} earlier results omitted)"
                task_text = (
                    "Another explore call this turn already searched these — read "
                    "them BEFORE re-searching, and only dig deeper where needed:\n"
                    f"{digest_note}\n\nNOW answer this:\n{task_text}"
                )

            # Content-heavy tasks (restyle/refactor/rewrite, style-relevant
            # keywords) genuinely need verbatim JSX/CSS/function bodies from
            # several files, which a compressed ≤3-line-excerpt report can't
            # carry. For those, relax the report to allow verbatim blocks and
            # raise the sub-agent's max output so the parent gets the actual
            # code in ONE call instead of looping explore for more detail.
            # Narrow fact-lookups keep the cheap concise-report style/1200 cap.
            if _is_content_gathering(task_text):
                _sub_report_style = (
                    "REPORT FORMAT: reply with a single COMPACT STRUCTURED block.\n"
                    "<results>\n"
                    "<files>\n"
                    "One line per relevant file: `path:line` — the verbatim code "
                    "blocks the task needs (full JSX/CSS/function bodies relevant to "
                    "the question, each prefixed by its exact file:line).\n"
                    "</files>\n"
                    "<answer>\n"
                    "One short paragraph on how the code fits together (under ~150 "
                    "words — the code blocks are the deliverable, not padding).\n"
                    "</answer>\n"
                    "<next_steps>\n"
                    "Optional: 1-2 follow-up paths the parent could take.\n"
                    "</next_steps>\n"
                    "</results>"
                )
                _sub_max_tokens = 3000
            else:
                _sub_report_style = (
                    "REPORT FORMAT: reply with a single COMPACT STRUCTURED block.\n"
                    "<results>\n"
                    "<files>\n"
                    "One line per relevant file: `path:line` (use the exact paths "
                    "from your tool results).\n"
                    "</files>\n"
                    "<answer>\n"
                    "The direct answer to the task in 1-3 sentences (under ~100 "
                    "words).\n"
                    "</answer>\n"
                    "<next_steps>\n"
                    "Optional: 1-2 suggested follow-ups, or leave empty.\n"
                    "</next_steps>\n"
                    "</results>"
                )
                _sub_max_tokens = 1200

            # Cross-call dedup seed: earlier explore calls this turn already
            # read/searched these paths. Feed them into the sub-agent's SYSTEM
            # PROMPT (not just the task text) so the model KNOWS not to re-issue
            # those calls — a dedup hit after the fact still costs a full model
            # round-trip (the whole transcript re-sends), so preventing the call
            # up front is what actually saves tokens.
            _sub_prior_note = _sub_resume_note()
            # Thoroughness control (ported from opencode's explore subagent):
            # the caller picks how deep to sweep, and the sub-agent prompt
            # adapts — quick = minimal targeted searches, very thorough =
            # exhaustive multi-convention sweep.
            _thoroughness_note = _thoroughness_prompt(thoroughness)
            sub_agent = _Agent(
                _run_model_wrapped,
                system_prompt=(
                    # opencode's explore agent framing
                    # (packages/opencode/src/agent/prompt/explore.txt): a single
                    # read-only "file search specialist" sub-agent that searches
                    # with glob/grep/read itself — no sibling branches.
                    "You are a file search specialist. You excel at thoroughly navigating "
                    "and exploring codebases: rapidly finding files with glob patterns, "
                    "searching code and text with powerful regex, and reading file "
                    "contents. Adapt your search approach to the thoroughness level "
                    "specified by the caller. Return file paths as absolute paths in "
                    "your final response; avoid emojis; do not create or modify any files.\n"
                    "You are also a read-only exploration sub-agent — find the answer "
                    "FAST and CHEAPLY and hand back a compact structured report. TIME IS "
                    "PRECIOUS — every search round-trip re-sends your whole transcript, "
                    "so do not over-explore.\n"
                    + _thoroughness_note
                    + "\n"
                    + (
                        "WORKSPACE ROOT ALREADY LISTED — do NOT glob the root "
                        "again; the top-level entries are already known:\n"
                        f"{_SCOUT_CTX.get()}\n"
                        if _SCOUT_CTX.get()
                        else ""
                    )
                    + (
                        "ALREADY EXPLORED THIS TURN — do NOT re-read or re-search these; "
                        "the results are already known. Only dig deeper where the task "
                        "genuinely needs more than what is listed:\n"
                        f"{_sub_prior_note}\n"
                        if _sub_prior_note
                        else ""
                    )
                    + "INTENT (do this before your first search): state in one sentence "
                    "what you are actually looking for (the literal request vs. the real "
                    "underlying need) so your searches are targeted, not scattershot.\n"
                    "PARALLEL-FIRST ACTION: on your very first turn launch 3+ tool calls "
                    "SIMULTANEOUSLY — fire the glob / grep / read "
                    "calls you already know you need in ONE response (batch related terms "
                    "with regex alternation foo|bar|baz). Do NOT do a serial "
                    "search→read→decide-next loop.\n"
                    "TOOL CHOICE: use glob to locate FILES by name pattern like '**/*.py' "
                    "or 'src/**/*.ts', use read on a directory to see its contents, "
                    "and use grep only to find CONTENT INSIDE already-identified files "
                    "or to confirm a symbol/string exists. Do NOT grep to discover which "
                    "files exist — that returns hundreds of noisy matches. Never repeat a search "
                    "with only a minor keyword variation. Do NOT search for overly generic terms "
                    "like 'class', 'function', 'def', 'import' or punctuation — use specific, "
                    "project-relevant keywords.\n"
                    "HARD STOP CONDITIONS — stop as soon as ANY applies: "
                    "(1) you have enough context to answer the task confidently; "
                    "(2) the same information keeps appearing across searches (diminishing returns); "
                    "(3) the last 2 search iterations yielded no new useful information; "
                    "(4) you found a direct answer. Then report immediately. "
                    "When done, report your findings "
                    + _sub_report_style
                    + "\nACCURACY RULES: copy file paths EXACTLY as they appear in tool results — never "
                    "invent, guess or abbreviate a path. If a search returns no matches, say so "
                    "explicitly instead of assuming it exists. If you are unsure a file exists, "
                    "confirm it with glob before citing it. Only cite facts that appear in "
                    "your tool results; never rely on memory of files you did not actually see. "
                    "PERSISTENCE: before concluding something 'does not exist' or 'is not handled "
                    "anywhere', try MULTIPLE search phrasings and several likely locations — the "
                    "exact literal string often differs from natural phrasing (try substrings, word "
                    "fragments, adjacent terms), and a single search returning no matches is NOT "
                    "proof of absence. When the task asks for exact file:line references and your "
                    "first searches come up empty, keep investigating rather than reporting "
                    "'not found' immediately."
                ),
                tools=[
                    _Tool(_sub_read, name="read"),
                    _Tool(_sub_grep, name="grep"),
                    _Tool(_sub_glob, name="glob"),
                ],
                model_settings=_ModelSettings(
                    temperature=0.2,
                    max_tokens=_sub_max_tokens,
                    parallel_tool_calls=True,
                ),
            )

            # Widen-and-resume retry loop (mirrors the PARENT agent's handling in
            # agents.py: a pydantic-ai UsageLimitExceeded or a provider context
            # overflow is NOT a hard failure — raise the budget / resume from the
            # cached tool results so a broad-but-legitimate investigation finishes
            # in this isolated run instead of telling the PARENT to split the task
            # (which then re-pays full discovery overhead in its OWN context).
            # Each retry keeps the result cache (built above), so the fresh model
            # gets its earlier findings back via the dedup instead of re-exploring.
            _sub_model_name = str(getattr(model, "model_name", "") or "")
            # Start content-gathering tasks (broad/verbatim-code investigations,
            # same classifier that already drives _sub_max_tokens above) with a
            # BIGGER initial budget instead of the narrow-lookup default. The
            # narrow default routinely wasn't enough for a genuinely broad task,
            # forcing a UsageLimitExceeded → widen → resume round trip: a full
            # extra sequential sub-agent request purely to discover "the budget
            # was too small", before the actual widened run even starts. Sizing
            # the STARTING budget correctly for the task kind skips that wasted
            # round trip for the common broad-task case; narrow lookups keep the
            # tight default since they rarely need more.
            if _is_content_gathering(task_text):
                _sub_request_limit = 12
                _sub_tool_calls_limit = 24
            else:
                _sub_request_limit = 6
                _sub_tool_calls_limit = 12
            _sub_widen_retries = 0
            _sub_overflow_retries = 0
            _sub_run_prompt = task_text
            _sub_res = None
            while True:
                try:
                    # Direct run, NO _run_subagent_call retry: per-sub-search
                    # fallback to the main model happens inside the wrapped model
                    # (_run_model_wrapped), so a failing grep/read/glob step
                    # re-runs on the main model immediately instead of stalling
                    # on a 30s x 10 backoff.
                    _sub_res = await sub_agent.run(
                        _sub_run_prompt,
                        # Was request_limit=10/tool_calls_limit=20 — too tight for a
                        # genuinely broad investigation in a large codebase, so it hit
                        # UsageLimitExceeded routinely and told the PARENT to split the
                        # task into more explore calls. Each new explore call spins up a
                        # FRESH sub-agent with no memory of what the previous attempt
                        # already found, so that "split it up and retry" pattern was
                        # paying the full discovery overhead (re-listing/re-searching
                        # the same areas) two or three times over for one investigation
                        # — exactly the repeated-tool-call token burn being reported.
                        # Doubling the budget lets most broad-but-reasonable tasks
                        # finish in ONE isolated sub-agent run instead. Still bounded,
                        # so a truly runaway task fails loudly rather than looping
                        # forever — it just needs a materially bigger task to get there.
                        usage_limits=_UsageLimits(
                            request_limit=_sub_request_limit,
                            tool_calls_limit=_sub_tool_calls_limit,
                        ),
                        model_settings=_ModelSettings(
                            timeout=_providers.model_timeout(
                                model=model, total=90, connect=10, read=90
                            ),
                            parallel_tool_calls=True,
                        ),
                    )
                    break
                except _UsageLimitExceeded:
                    # Step/request budget hit, no mutating side effects possible
                    # (read-only sub-agent). Widen the budget and resume with the
                    # cached tool results, mirroring the parent's widen branch.
                    if _sub_widen_retries >= 2:
                        raise
                    _sub_widen_retries += 1
                    _sub_request_limit = min(_sub_request_limit * 2, 24)
                    _sub_tool_calls_limit = min(_sub_tool_calls_limit * 2, 36)
                    resume_note = _sub_resume_note()
                    if resume_note:
                        _sub_run_prompt = f"{task_text}\n\n{resume_note}"
                    emit(
                        {
                            "kind": "retry",
                            "attempt": _sub_widen_retries,
                            "max_attempts": 3,
                            "delay": 0,
                            "reason": (
                                f"explore step budget raised to {_sub_request_limit} requests / "
                                f"{_sub_tool_calls_limit} tool calls, resuming from previous tool results"
                            ),
                            "model": _sub_model_name,
                            "agent": "explore sub-agent",
                        }
                    )
                    continue
                except Exception as exc:
                    # A provider context overflow inside the sub-agent's own
                    # isolated window: its transcript got too big. Resume ONCE
                    # from the cached findings (the prompt + cached results are
                    # far smaller than the raw transcript, so it fits again).
                    # UsageLimitExceeded is handled above; `_is_context_overflow`
                    # matches only real overflow wording.
                    from agents import _is_context_overflow

                    if _is_context_overflow(exc) and _sub_overflow_retries < 1:
                        _sub_overflow_retries += 1
                        resume_note = _sub_resume_note()
                        if resume_note:
                            _sub_run_prompt = f"{task_text}\n\n{resume_note}"
                        emit(
                            {
                                "kind": "retry",
                                "attempt": 1,
                                "max_attempts": 2,
                                "delay": 0,
                                "reason": "explore sub-agent context was full — resuming from previous tool results",
                                "model": _sub_model_name,
                                "agent": "explore sub-agent",
                            }
                        )
                        continue
                    raise
            res = _sub_res
            report = str(getattr(res, "output", "") or "").strip()

            # Citation verification: extract `path:line` references from the
            # report and check each file exists on disk. Sub-agents occasionally
            # fabricate paths/line numbers; if any are bogus, run ONE bounded
            # correction round (sub-agent tokens only) pointing out the bad refs.
            if report:
                bad_refs = _sub_verify_report_paths(report)
                if bad_refs:
                    resume_history: list[_ModelRequest] = []
                    _resume_note = _sub_resume_note()
                    if _resume_note:
                        resume_history = [
                            _ModelRequest(parts=[_SystemPromptPart(content=_resume_note)])
                        ]
                    try:
                        fix_result = await _run_subagent_call(
                            lambda: sub_agent.run(
                                (
                                    "Your exploration report cites file paths that do not exist in "
                                    "the workspace:\n"
                                    + "\n".join(f"- {b}" for b in bad_refs[:15])
                                    + "\n\nCorrect the report: for each, either fix the path to the "
                                    "REAL file (confirm it with glob/grep first) or "
                                    "remove the fabricated reference entirely. Keep the rest of the "
                                    "report unchanged. Reply with ONLY the corrected report."
                                ),
                                message_history=resume_history,
                                usage_limits=_UsageLimits(
                                    request_limit=max(4, _sub_request_limit),
                                    tool_calls_limit=max(8, _sub_tool_calls_limit),
                                ),
                                model_settings=_ModelSettings(
                                    timeout=_providers.model_timeout(
                                        model=model, total=60, connect=10, read=60
                                    ),
                                    parallel_tool_calls=True,
                                ),
                            ),
                            "explore sub-agent",
                            emit=emit,
                            model_name=_sub_model_name,
                        )
                        fixed = str(getattr(fix_result, "output", "") or "").strip()
                        if fixed:
                            report = fixed
                    except Exception:  # noqa: BLE001, S110 — a failed fix is not fatal
                        pass
            # The sub-agent's model requests are billed real tokens, but they ran
            # through a SEPARATE pydantic_ai Agent instance that never passed
            # through _UsageCapability (that's only wired up for the PARENT
            # agent's own model in agents.py) — so this usage was silently
            # missing from both the live context meter and the cost total.
            # Surface it the same way a normal tool-loop step does, via the same
            # _usage_event normalizer, labeled with the model that ACTUALLY ran.
            from agents import _usage_event  # local import (circular-safe)

            _usage_ev = _usage_event(
                getattr(_sub_res, "usage", None), model=_sub_model_name
            )
            if _usage_ev:
                emit(_usage_ev)
            return report

        async def _run_explore(
            model: Any, task_text: str, branch_id: int = 0,
            branch_index: int = 0, branch_total: int = 1,
            thoroughness: str = "medium",
        ) -> str:
            """Per-branch wrapper: stamps every sub-agent event with this
            branch id and the model that ACTUALLY ran it (the sub-agent model,
            or the main model after a per-sub-search fallback). Each branch runs
            in its own asyncio task, so the contextvar keeps the shared sub-tools
            pointed at THIS branch closure — no cross-branch races."""
            state = {"model": str(getattr(model, "model_name", "") or "")}

            def _branch_emit(event: dict) -> None:
                event = dict(event)
                event["sub"] = True
                event["branch"] = branch_id
                event.setdefault("model", state["model"])
                emit(event)

            _token = _sub_emit_ctx.set(_branch_emit)
            # Per-branch dedup for SEARCHES only: copy the digest-seeded shared
            # search set so this branch dedups against its OWN searches + prior
            # explore calls, never against other branches' concurrent searches
            # (a shared search seen-set folded branch B's broader search into
            # branch A's more-specific one, making all branches converge on the
            # same searches). READS are NOT copied: they share the turn-level
            # _explore_seen_listings so parallel branches reuse each other's
            # file reads instead of each reading the same files.
            _seen_token = _sub_seen_searches_ctx.set(set(_sub_seen_searches))
            try:
                return await _run_explore_inner(
                    model, task_text, state,
                    branch_index=branch_index, branch_total=branch_total,
                    thoroughness=thoroughness,
                )
            finally:
                _sub_seen_searches_ctx.reset(_seen_token)
                _sub_emit_ctx.reset(_token)

        def _build_task_text(t: str) -> str:
            text = t
            if path_hint:
                text = f"Search ONLY within {path_hint}. {text}"
            if hints:
                text = f"Known hints: {hints}. {text}"
            return text

        # Run the explore sub-agent. Per-sub-search fallback to the MAIN model
        # happens INSIDE _run_explore (the _PerStepFallbackModel wrapper), so a
        # failing grep/read/glob step never flips the whole explore — or the
        # rest of the turn — onto the main model (non-sticky). Step-budget
        # exhaustion (_UsageLimitExceeded) is deliberately NOT a fallback — it
        # means the task is too broad, not that the model is broken.
        #
        # ONE sub-agent per explore call, exactly like opencode's `explore`
        # agent (mode: subagent, read-only, thoroughness quick|medium|very
        # thorough). The sub-agent does the searching itself with parallel tool
        # calls (glob/grep/read) — there is NO fan-out into multiple sibling
        # sub-agents, which is what produced "چند تا اکسپلور با ساب ایجنت های
        # مثل هم" (several explore cards with near-identical sub-searches).
        nonlocal _explore_call_seq
        _ecall = _explore_call_seq + 1
        _explore_call_seq = _ecall
        emit({"kind": "tool", "tool": "explore", "args": {"task": task}, "model": _run_model_name, "branch": _ecall})
        # Register this call as IN-FLIGHT so a concurrent near-duplicate (parent
        # fires N explore calls in one parallel-tool-calls response) awaits THIS
        # call's report instead of spawning its own sub-agent. Resolved in
        # `_finish` on every exit path so a waiting duplicate never hangs.
        _loop = asyncio.get_running_loop()
        _future: asyncio.Future = _loop.create_future()
        _inflight_ent = {
            "task": task,
            "path_hint": path_hint,
            "thoroughness": thoroughness,
            "future": _future,
        }
        _explore_inflight.append(_inflight_ent)

        def _finish(final: str) -> str:
            if not _future.done():
                _future.set_result(final)
            _explore_inflight[:] = [
                e for e in _explore_inflight if e is not _inflight_ent
            ]
            return final

        try:
            report = await _run_explore(
                _run_model, _build_task_text(task), branch_id=_ecall,
                thoroughness=thoroughness,
            )
        except _UsageLimitExceeded:
            emit(_error_result("explore", "step budget exceeded"))
            return _finish(
                f"EXPLORE for {task!r} did not finish within its step budget — the task was likely too "
                "broad. Split it into smaller, more specific explore calls, or investigate the remaining "
                "part yourself with grep/read."
            )
        except Exception as exc:  # noqa: BLE001
            # Both the sub-agent model AND the main-model fallback failed a
            # step, or the run failed outside a model request — surface it.
            emit(_error_result("explore", f"failed: {exc}"))
            return _finish(
                f"ERROR: explore sub-agent failed"
                f" ({_run_model_name} model, change it in Settings → Subagents): {exc}"
            )
        if not report:
            emit(_error_result("explore", "no report"))
            return _finish(f"The exploration sub-agent found nothing usable for {task!r}.")
        _ran_model_name = str(getattr(_run_model, "model_name", "") or "")
        emit({"kind": "tool_result", "tool": "explore", "summary": f"{len(report)} chars", "model": _ran_model_name, "branch": _ecall})
        _final = f"EXPLORE REPORT for {task!r}\n{report}"
        _explore_call_log.append({
            "task": task,
            "path_hint": path_hint,
            "thoroughness": thoroughness,
            "report": _final,
        })
        return _finish(_final)

    async def web_search_tool(query: str, max_results: int = 5) -> str:
        # The model that will distill the results: the web sub-agent, or the
        # MAIN model once this slot has fallen back earlier in the turn.
        _web_runner = main_model if _fallback_state.get("web") else web_model
        _web_runner_name = (
            str(getattr(_web_runner, "model_name", "") or "")
            if _web_runner is not None
            else ""
        )
        emit({"kind": "tool", "tool": "web_search", "args": {"query": query}, "model": _web_runner_name})
        result = await asyncio.to_thread(web_search, query, max_results)
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "web_search", "summary": msg, "status": "error"})
            return f"WEB SEARCH ERROR for {query!r}: {msg}"
        results = result.get("results", [])
        if not results:
            emit({"kind": "tool_result", "tool": "web_search", "summary": "no results"})
            return f"No web results for {query!r}."
        lines = []
        ui_items: list[dict] = []
        for r in results:
            snippet = r["snippet"]
            if len(snippet) > WEB_SEARCH_SNIPPET_MAX:
                snippet = snippet[:WEB_SEARCH_SNIPPET_MAX] + " …"
            lines.append(f"- {r['title']}\n  {r['url']}\n  {snippet}")
            ui_items.append({"title": r["title"], "url": r["url"], "snippet": snippet})
            # Persist each hit into the workspace vector store (KIND_WEB) so
            # later retrieval can recall it without re-fetching the web.
            if store is not None:
                try:
                    store.upsert_doc(
                        f"web:{r['url']}",
                        KIND_WEB,
                        r.get("title", r["url"]),
                        [snippet],
                        {"source_url": r["url"], "source_type": "web"},
                    )
                except Exception:  # noqa: BLE001, S110 — vector write must never break the tool
                    pass
        summary = f"{len(results)} results"
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
                from pydantic_ai import Agent
                from pydantic_ai.settings import ModelSettings

                res, ran_model = await _run_distill(
                    "web",
                    _web_runner,
                    "web-search distiller",
                    lambda m: Agent(
                        m,
                        system_prompt=(
                            "You are a web-search reader. Read the quoted search results "
                            "and answer the user's query with a CONCISE summary (under "
                            "150 words) that cites the most relevant result URLs inline. "
                            "If the results cannot answer the query, say so."
                        ),
                        model_settings=ModelSettings(temperature=0.2, max_tokens=400),
                    ),
                    lambda: f"QUERY: {query}\n\nSEARCH RESULTS:\n" + "\n".join(lines),
                    timeout_total=60,
                )
                distilled = str(getattr(res, "output", "") or "").strip()
                if distilled:
                    from agents import _usage_event  # local import (circular-safe)

                    _usage_ev = _usage_event(
                        getattr(res, "usage", None),
                        model=str(getattr(ran_model, "model_name", "") or ""),
                    )
                    if _usage_ev:
                        emit(_usage_ev)
                    emit({
                        "kind": "tool_result",
                        "tool": "web_search",
                        "summary": f"{len(results)} results (distilled)",
                        "engine": engine,
                        "results": ui_items,
                        "model": str(getattr(ran_model, "model_name", "") or ""),
                    })
                    return f"WEB RESULTS for {query!r} (distilled)\n{distilled}"
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
                    emit({
                        "kind": "tool_result",
                        "tool": "web_search",
                        "summary": summary,
                        "engine": engine,
                        "results": ui_items,
                        "model": _ran_name,
                    })
                    return raw_results + "\n\n" + _web_note
        emit({"kind": "tool_result", "tool": "web_search", "summary": summary, "engine": engine, "results": ui_items, "model": _web_runner_name})
        return raw_results

    async def fetch_url_tool(url: str, question: str = "", full: bool = False) -> str:
        """Fetch a web page / raw file and return its extracted text. Default returns a bounded excerpt (or a sub-agent summary when `question` is set). For copying source files (SKILL.md/docs/raw.githubusercontent/jsdelivr/gist URLs) the backend auto-returns full text (up to 24k chars) — one call per file is enough; don't pass `full=True` and don't re-fetch the same file via other hosts. Every call re-sends the whole conversation, so it costs real tokens."""
        effective_full = bool(full)
        # The model that will summarize the page: the web/explore sub-agent, or
        # the MAIN model once this slot has fallen back earlier in the turn.
        _sum_model = web_model or explore_model
        _sum_runner = main_model if _fallback_state.get("web") else _sum_model
        _sum_runner_name = (
            str(getattr(_sum_runner, "model_name", "") or "")
            if _sum_runner is not None
            else ""
        )
        emit({"kind": "tool", "tool": "fetch_url", "args": {"url": url, "full": effective_full}, "model": _sum_runner_name})
        # full=True bypasses the default excerpt cap: return the whole page so
        # one call is enough for copying source files (SKILL.md / docs). The
        # extracted body is already bounded by fetch_url (FETCH_EXCERPT_CHARS).
        #
        # AUTO-DETECT source files regardless of the model's `full` flag: a URL
        # that points at a raw file (markdown / text / source-code extension, or
        # a raw.githubusercontent / jsdelivr / gist host) is ALWAYS returned in
        # full. Relying on the model to remember full=True is fragile — without
        # this, a skill-install fetch would silently come back as a tiny excerpt
        # and the agent would re-fetch the same file (token blow-up, truncated
        # skills), which is exactly the bug this fixes.
        _cap = tool_out_chars
        _probe = url.split("?", 1)[0].rstrip("/")
        _ext = _probe.rsplit(".", 1)[-1].lower() if "." in _probe.rsplit("/", 1)[-1] else ""
        _raw_hosts = ("raw.githubusercontent.com", "cdn.jsdelivr.net", "gist.github.com", "raw.fastgit.org")
        _ext_full = {
            "md", "markdown", "txt", "text", "json", "yaml", "yml", "toml",
            "py", "ts", "tsx", "js", "jsx", "css", "html", "htm", "sh", "bash",
            "pdf", "xml", "svg", "csv", "r", "sql", "env", "ini", "conf", "cfg",
        }
        if effective_full or _ext in _ext_full or _probe.startswith(_raw_hosts):
            _cap = FETCH_EXCERPT_CHARS
            effective_full = True
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
                if len(body) > _cap:
                    body = body[: _cap] + "\n…(output truncated to fit context)"
                emit({
                    "kind": "tool_result",
                    "tool": "fetch_url",
                    "summary": f"{len(body)} chars (cached)",
                })
                return f"FETCHED {url} (cached)\nTitle: {title or 'unknown'}\n\n{body}"
        result = await asyncio.to_thread(fetch_url, url)
        if "error" in result:
            msg = result["error"]
            emit(_error_result("fetch_url", msg))
            return f"ERROR fetching {url}: {msg}"
        body = result.get("content", "")
        title = result.get("title", "")
        # Cache the fetch result (24h TTL)
        if body:
            try:
                cache.set(cache_key, json.dumps({"content": body, "title": title}, ensure_ascii=False), 86400)
            except Exception:  # noqa: BLE001, S110
                pass
        # Persist the fetched page into the workspace vector store (KIND_WEB)
        # so later retrieval can recall it without re-fetching the web.
        if store is not None and body:
            try:
                store.upsert_doc(
                    f"web:{url}",
                    KIND_WEB,
                    title or url,
                    [body[:WEB_SEARCH_SNIPPET_MAX * 4]],
                    {"source_url": url, "source_type": "web"},
                )
            except Exception:  # noqa: BLE001, S110 — vector write must never break the tool
                pass

        # full=True (or auto-detected source file) returns the whole page
        # verbatim — no summarizer, no excerpt. This is the skill-install path:
        # the caller needs the complete source.
        if effective_full:
            if len(body) > _cap:
                body = body[: _cap] + "\n…(output truncated to fit context)"
            emit({
                "kind": "tool_result",
                "tool": "fetch_url",
                "summary": f"{len(body)} chars",
            })
            return f"PAGE {url}\n" + (f"TITLE: {title}\n" if title else "") + body

        # Claude-Code-style: the main model receives only a distilled answer,
        # not the raw page. A summarizer model (the same configured model, run
        # with a tiny token budget) answers the `question` from the extracted
        # text, keeping the main context lean. On a hard sub-agent failure the
        # call falls back to the MAIN model (see _run_distill) — the bounded
        # excerpt is only returned when BOTH models fail.
        answer = ""
        _ran_sum_name = _sum_runner_name
        if _sum_runner is not None:
            try:
                from pydantic_ai import Agent
                from pydantic_ai.settings import ModelSettings

                _prompt = question.strip() or "Summarize the key content of this page."
                res, ran_model = await _run_distill(
                    "web",
                    _sum_runner,
                    "web-page summarizer",
                    lambda m: Agent(
                        m,
                        system_prompt=(
                            "You are a web-page reader. Read the quoted page text and "
                            "answer the user's question with a CONCISE summary (under "
                            "120 words). If the page cannot answer the question, say "
                            "so. Ignore navigation menus, sidebars, footers and "
                            "ads."
                        ),
                        model_settings=ModelSettings(temperature=0.2, max_tokens=400),
                    ),
                    lambda: f"QUESTION: {_prompt}\n\nPAGE TEXT:\n{body}",
                    timeout_total=90,
                )
                _ran_sum_name = str(getattr(ran_model, "model_name", "") or "")
                answer = str(getattr(res, "output", "") or "").strip()
                # Surface the summarizer's token usage so it shows in MODEL USAGE
                # (same normalizer the explore sub-agent uses).
                from agents import _usage_event  # local import (circular-safe)

                _usage_ev = _usage_event(
                    getattr(res, "usage", None),
                    model=_ran_sum_name,
                )
                if _usage_ev:
                    emit(_usage_ev)
            except Exception as exc:  # noqa: BLE001
                # Both the web/explore subagent AND the main model failed — note
                # it with the model name so the user can fix Settings →
                # Subagents, then excerpt-fall.
                answer = ""
                _ran_name = str(
                    getattr(
                        main_model if _fallback_state.get("web") else _sum_model,
                        "model_name",
                        "",
                    )
                    or ""
                )
                _web_note = _subagent_fail_note("web", _ran_name, exc)
                if _web_note:
                    answer = _web_note  # becomes the "summary" replaced below

        head = f"PAGE {url}\n" + (f"TITLE: {title}\n" if title else "")
        if answer:
            if answer.startswith("Note: the"):
                emit({
                    "kind": "tool_result",
                    "tool": "fetch_url",
                    "summary": f"{len(body)} chars",
                    "model": _ran_sum_name,
                })
                return head + answer
            emit({
                "kind": "tool_result",
                "tool": "fetch_url",
                "summary": f"summarized · {len(answer)} chars",
                "model": _ran_sum_name,
            })
            return head + "SUMMARY:\n" + answer
        # Fallback: no summarizer (or it failed) — return a bounded excerpt that
        # respects the shared context budget so it can never overflow the window.
        if len(body) > _cap:
            body = body[: _cap] + "\n…(output truncated to fit context)"
        emit({
            "kind": "tool_result",
            "tool": "fetch_url",
            "summary": f"{len(body)} chars",
            "model": _ran_sum_name,
        })
        return head + body

    async def request_permission_tool(action: str, path: str = "", reason: str = "") -> str:
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
            except PathEscapeError:
                pass
        emit({"kind": "tool", "tool": "request_permission", "args": {"action": action, "path": path}})
        if permission_gates is None:
            emit(_error_result("request_permission", "permission system unavailable"))
            return "ERROR: permission system is not available."
        pid = f"p{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        permission_gates[pid] = fut
        emit({"kind": "permission", "id": pid, "action": action, "path": path, "reason": reason})
        try:
            granted = await asyncio.wait_for(fut, timeout=300)
        except asyncio.TimeoutError:
            granted = False
        finally:
            permission_gates.pop(pid, None)
        if granted:
            if permit is not None:
                permit["outside"] = True
            emit({"kind": "tool_result", "tool": "request_permission", "summary": "granted"})
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
        emit({"kind": "permission", "id": pid, "action": action, "reason": reason, "scope": "confirm"})
        try:
            granted = await asyncio.wait_for(fut, timeout=300)
        except asyncio.TimeoutError:
            granted = False
        finally:
            permission_gates.pop(pid, None)
        if granted:
            emit({"kind": "tool_result", "tool": "confirm_action", "summary": "confirmed"})
            return f"CONFIRMED by the user: {action!r}. Proceed with it now."
        emit({"kind": "tool_result", "tool": "confirm_action", "summary": "denied"})
        return (
            f"DENIED by the user: {action!r}. Do NOT do this — stop, tell the user you stopped, and ask "
            f"what they'd like instead."
        )

    async def ask_user_tool(question: str, options: list[str] | None = None) -> str:
        """Ask the user a question mid-task and WAIT for the answer instead of guessing. Use when the request is ambiguous, has conflicting instructions, or misses a detail you can't infer — and it's your FIRST action when intent is genuinely unclear. Pass 2-5 short, mutually-exclusive `options` (few words) for multiple-choice; omit/empty for free text. Order the options by YOUR OWN preference: put the option you recommend and think is best FIRST (it becomes option #1 the user sees), then the rest in decreasing preference. One clear `question`. Not for things you can find out yourself; one question per call. Returns the user's exact answer."""
        emit({"kind": "tool", "tool": "ask_user", "args": {"question": question, "options": options or []}})
        if ask_gates is None:
            emit(_error_result("ask_user", "ask system unavailable"))
            return "ERROR: the ask-the-user system is not available. Ask the question directly in your reply instead and wait for the user's next message."
        aid = f"a{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        ask_gates[aid] = fut
        emit({"kind": "ask", "id": aid, "question": question, "options": options or []})
        try:
            answer = await asyncio.wait_for(fut, timeout=600)
        except asyncio.TimeoutError:
            answer = ""
        finally:
            ask_gates.pop(aid, None)
        if not answer:
            emit(_error_result("ask_user", "no answer (timed out)"))
            return "The user did not answer in time. Proceed with your best judgment, note the assumption you're making, and mention you can adjust it if wrong."
        emit({"kind": "tool_result", "tool": "ask_user", "summary": f"answered: {answer[:80]}"})
        return f"USER ANSWERED: {answer}"

    async def _search_console_impl(
        action: str = "sites",
        start_date: str = "",
        end_date: str = "",
        row_limit: int = 10,
        url: str = "",
    ) -> str:
        """Query the user's Google Search Console data. ``action``:
          - "sites": list the sites the connected Google account can access;
          - "query": search analytics for ``site_url`` from ``start_date`` to
            ``end_date`` (YYYY-MM-DD, default = last 28 days), top queries;
          - "inspect": URL Inspection check for ``url`` — index status, coverage
            state (why a page is/isn't indexed: noindex, robots.txt block, 404,
            soft-404, duplicate canonical, crawl errors), last crawl time.
        Uses the Google account signed in under Settings → Auth (the same OAuth
        client as the Gemini model). No site URL is needed — when none is set,
        the tool lists the account's sites and picks the first one automatically.
        Without a signed-in account this returns a setup hint instead of failing."""
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
                        sc_cfg = {**sc_cfg, "clientId": client_id, "clientSecret": client_secret, "refreshToken": refresh}
                    break
        if not (client_id and client_secret and refresh):
            return "Google Search Console is not signed in — connect your Google account in Settings → Auth."
        try:
            token = await _providers.google_access_token(client_id, client_secret, refresh)
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
                return (f"Search Console sites ({len(lines)}):\n" + "\n".join(lines)) if lines else "No sites accessible with this account."
            if action == "query":
                import datetime
                import urllib.parse

                today = datetime.datetime.now(datetime.timezone.utc).date()
                try:
                    e = datetime.date.fromisoformat(end_date) if end_date else today
                except ValueError:
                    return "Invalid end_date — use YYYY-MM-DD."
                try:
                    s = datetime.date.fromisoformat(start_date) if start_date else e - datetime.timedelta(days=27)
                except ValueError:
                    return "Invalid start_date — use YYYY-MM-DD."
                site_url = (sc_cfg.get("siteUrl") or "").strip()
                candidates: list[str] = []
                if not site_url:
                    # Auto-discover: list the account's sites. GSC returns them in
                    # a non-deterministic order, so sort URL-prefix properties
                    # (https://…) before domain properties (sc-domain:…) and try
                    # them in order — skipping any the account can't query.
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        r = await client.get("https://www.googleapis.com/webmasters/v3/sites", headers=headers)
                    if r.status_code >= 400:
                        data = r.json()
                        return (
                            f"Search Console sites error {r.status_code}: "
                            f"{data.get('error', {}).get('message', r.text[:200])}"
                        )
                    rows = (r.json().get("siteEntry") or [])
                    if not rows:
                        return "No sites accessible with this account — add a verified property in Google Search Console first."
                    candidates = sorted(
                        (str(s.get("siteUrl", "")).strip() for s in rows if s.get("siteUrl")),
                        key=lambda u: (not u.startswith("https://"), u),
                    )
                    if not candidates:
                        return "Could not determine a site URL from the connected account."
                else:
                    candidates = [site_url]
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
                for site in candidates:
                    site_url_enc = urllib.parse.quote(site, safe="")
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
                        errors.append(f"{site}: {msg}")
                        continue
                    rows = r.json().get("rows") or []
                    if rows:
                        site_url = site
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
                site_url = (sc_cfg.get("siteUrl") or "").strip()
                candidates: list[str] = []
                if not site_url:
                    # Auto-discover like the query action: list the account's
                    # sites, preferring URL-prefix properties, and try them in
                    # order until one accepts the inspection.
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        r = await client.get("https://www.googleapis.com/webmasters/v3/sites", headers=headers)
                    if r.status_code >= 400:
                        data = r.json()
                        return (
                            f"Search Console sites error {r.status_code}: "
                            f"{data.get('error', {}).get('message', r.text[:200])}"
                        )
                    rows = (r.json().get("siteEntry") or [])
                    if not rows:
                        return "No sites accessible with this account — add a verified property in Google Search Console first."
                    candidates = sorted(
                        (str(s.get("siteUrl", "")).strip() for s in rows if s.get("siteUrl")),
                        key=lambda u: (not u.startswith("https://"), u),
                    )
                    if not candidates:
                        return "Could not determine a site URL from the connected account."
                else:
                    candidates = [site_url]
                errors: list[str] = []
                for site in candidates:
                    site_url_enc = urllib.parse.quote(site, safe="")
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        r = await client.post(
                            "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
                            headers=headers,
                            json={"inspectionUrl": target_url, "siteUrl": site},
                        )
                    if r.status_code >= 400:
                        try:
                            data = r.json()
                            msg = data.get("error", {}).get("message", r.text[:200])
                        except Exception:  # noqa: BLE001
                            msg = r.text[:200]
                        errors.append(f"{site}: {msg}")
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
                    if robots.lower() == "bloqueado" or "not crawled" in page_fetch.lower():
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
            return f"Unknown search_console action {action!r} — use 'sites', 'query' or 'inspect'."
        except Exception as exc:  # noqa: BLE001
            return f"Search Console request failed: {exc}"

    async def search_console_tool(
        action: str = "sites",
        start_date: str = "",
        end_date: str = "",
        row_limit: int = 10,
        url: str = "",
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
                },
            }
        )
        result = await _search_console_impl(
            action=action,
            start_date=start_date,
            end_date=end_date,
            row_limit=row_limit,
            url=url,
        )
        is_err = result.startswith(
            (
                "Google Search Console is not signed in",
                "Search Console auth failed",
                "Search Console sites error",
                "Search Console query error",
                "Search Console request failed",
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

    _tools = {
        "request_permission": request_permission_tool,
        "confirm_action": confirm_action_tool,
        "ask_user": ask_user_tool,
        "write_file": write_file_tool,
        "edit_file": edit_file_tool,
        "memory": memory_tool,
        "search_memory": search_memory_tool,
        "update_plan": update_plan,
        "create_skill": create_skill_tool,
        "create_mcp": create_mcp_tool,
        "grep": grep_tool,
        "glob": glob_tool,
        "read": read_tool,
        "explore": explore_tool,
        "save_plan": save_plan_tool,
        "web_search": web_search_tool,
        "search_console": search_console_tool,
        "fetch_url": fetch_url_tool,
        "run_terminal": terminal_tool,
    }
    # Wrap every parent tool so each invocation gets its own `call_id` context
    # (see `_emit` above) — robust to parallel same-name tools finishing out of
    # order. Sub-agent internal tools are separate `_Tool` instances, so only
    # these first-class tools are threaded per-invocation.
    return {name: _invoke(fn) for name, fn in _tools.items()}
