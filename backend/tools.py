"""Sandboxed filesystem tools for the Pydantic AI agent.

Every path is resolved through a project ROOT. Absolute paths, `..` escapes and
symlink escapes are rejected by comparing realpaths so the agent can never touch
files outside the selected project folder.
"""

from __future__ import annotations

import ast
import asyncio
import difflib
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


async def _run_subagent_call(
    factory: Callable[[], Any],
    label: str,
    *,
    emit: Callable[[dict], None] | None = None,
    model_name: str = "",
) -> Any:
    """Run a sub-agent model call (``factory`` → coroutine) with the shared
    retry policy: on a transient throttle / retryable error / empty-output
    error, retry every 30s up to 10 attempts. A hard quota exhaustion or any
    non-retryable failure (bad key, invalid model) is re-raised immediately so
    the caller's existing fallback handles it.

    When ``emit`` is provided, each retry is surfaced as a ``retry`` event so
    the UI shows the sub-agent is retrying (instead of a frozen tool card for
    up to 5 minutes of silent backoff). Returns the coroutine's result.
    """
    from agents import (
        _is_empty_output_error,
        _is_quota_exhausted,
        _is_retryable,
        _is_transient_throttle,
    )

    attempt = 0
    while True:
        try:
            return await factory()
        except Exception as exc:
            retryable = (
                _is_transient_throttle(exc)
                or _is_retryable(exc)
                or _is_empty_output_error(exc)
            )
            if (
                _is_quota_exhausted(exc)
                or not retryable
                or attempt >= _SUBAGENT_MAX_ATTEMPTS
            ):
                raise
            attempt += 1
            if emit is not None:
                try:
                    emit(
                        {
                            "kind": "retry",
                            "attempt": attempt,
                            "max_attempts": _SUBAGENT_MAX_ATTEMPTS + 1,
                            "delay": _SUBAGENT_RETRY_SECONDS,
                            "reason": f"{label} hit a transient error — retrying",
                            "model": model_name,
                            "agent": label,
                        }
                    )
                except Exception:  # noqa: BLE001, S110 — cosmetic only
                    pass
            await asyncio.sleep(_SUBAGENT_RETRY_SECONDS)


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
        if p.startswith(_SAFE_ABS):
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


# Cache of _walk_files listings per root, so consecutive fuzzy_find / list /
# search calls inside one turn reuse the same file list instead of re-walking
# the tree each time (a large repo walk can cost hundreds of ms and is pure
# repeated work across sibling tool calls). Keyed on root, bounded TTL.
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


_STARTER_SKILLS: list[tuple[str, str, str]] = [
    (
        "landing-page-design",
        "Design high-converting landing pages (structure, copy hierarchy, CTA placement).",
        (
            "When asked to design or build a landing page, follow this workflow:\n"
            "1. Define the single conversion goal and the target visitor.\n"
            "2. Structure: hero → social proof → features/benefits → how it works → pricing → FAQ → final CTA.\n"
            "3. Copy hierarchy: one clear headline (H1), one supporting subheadline, scannable benefit bullets.\n"
            "4. Place exactly one primary CTA above the fold and repeat it after the last section.\n"
            "5. Keep visual hierarchy: one accent color for CTAs, generous whitespace, consistent spacing scale.\n"
            "6. Add trust signals near the first CTA (testimonials, logos, ratings)."
        ),
    ),
    (
        "pricing-page",
        "Build persuasive pricing pages with clear plans, comparison and FAQ.",
        (
            "When asked to build a pricing page:\n"
            "1. Show 3 plans by default (Starter / Pro / Enterprise), highlighting the middle one as 'Most popular'.\n"
            "2. Lead with the price anchor (monthly, and annual-with-discount toggle if relevant).\n"
            "3. List 4-6 concrete features per plan, checked icons; never vague marketing words.\n"
            "4. Add a comparison table for the key differentiating features.\n"
            "5. Close with a money-back guarantee + a short FAQ addressing objections."
        ),
    ),
    (
        "threejs-scroll-storytelling",
        "Build scroll-driven 3D storytelling pages with Three.js (React Three Fiber).",
        (
            "When asked to build a scroll-driven 3D scene with Three.js:\n"
            "1. Use React Three Fiber (Canvas) with drei helpers; avoid raw WebGL boilerplate.\n"
            "2. Map page scroll to the scene via useScroll (drei): camera moves or object rotation/position per scroll progress.\n"
            "3. Keep performance: enable antialias, cap pixelRatio at 2, reuse materials and geometries.\n"
            "4. Add scroll sections with the canvas fixed behind; each section triggers a scene state change.\n"
            "5. Fall back gracefully on low-end devices (reduce motion, lower DPR)."
        ),
    ),
    (
        "git-workflow",
        "Follow a clean, safe git workflow: status, branch, staged commits, push.",
        (
            "When doing git work:\n"
            "1. Always run `git status` first; review the diff before staging.\n"
            "2. Work on a descriptive feature branch (git checkout -b <feature>).\n"
            "3. Stage only intended files (git add <paths>), never secrets or build artifacts.\n"
            "4. Commit with a concise message in the repo's style; keep changes focused.\n"
            "5. Pull/merge recent main before pushing to avoid conflicts; push and open a PR when asked."
        ),
    ),
]


def seed_starter_skills() -> list[str]:
    """Install the built-in starter skills on first run (no-op afterwards).

    Seeds only when the skill table is empty, so user edits/deletions are never
    overwritten. Returns the names that were seeded.
    """
    try:
        existing = _state_db.list_skills()
    except Exception:  # noqa: BLE001
        return []
    if existing:
        return []
    seeded: list[str] = []
    for name, description, body in _STARTER_SKILLS:
        markdown = (
            "---\n"
            f"name: {name}\n"
            f"description: {description}\n"
            "---\n\n"
            f"# {name}\n\n{body}\n"
        )
        result = persist_skill(markdown, fallback_name=name)
        if result.get("ok"):
            seeded.append(name)
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
            "error": "file too large to edit safely (use search_in_files to inspect it in parts instead)",
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

    Dispatches by extension: .py gets an instant AST syntax check; .ts/.tsx get
    a debounced project-wide typecheck. Every other extension (and any error
    resolving the path) returns ``None`` so the caller adds nothing to the tool
    result — this must never turn a successful write into a reported failure.
    """
    ext = os.path.splitext(path)[1].lower()
    try:
        target = resolve_safe(root, path)
    except PathEscapeError:
        return None
    if ext == ".py":
        return _verify_python_syntax(target)
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


def _search_python(root: str, query: str, path: str, ctx: int) -> dict:
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

    matches: list[dict] = []
    # Same fix as `_rg_search`: a `path` that names a single file searches only
    # that file, instead of silently widening to its parent directory.
    files = [target] if os.path.isfile(target) else _walk_files(target)
    for file in files:
        if not _is_text_path(file):
            continue
        rel = _display_path(root, file)
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


def _rg_search(root: str, query: str, path: str, ctx: int) -> dict | None:
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


def search_in_files(root: str, query: str, path: str = "", context: int = 0) -> dict:
    """Search for ``query`` (case-insensitive regex) under ``path``.

    Uses ripgrep when available (respecting ``.gitignore``, skipping hidden and
    binary files, ``--smart-case`` casing) with a pure-Python walker as a
    fallback. When ``context > 0``, each match also includes the ``context``
    lines before and after the matching line (returned in the ``context_lines``
    field), so the agent can see surrounding code without reading the whole
    file.
    """
    ctx = max(0, int(context or 0))
    result = _rg_search(root, query, path, ctx)
    if result is not None:
        return result
    return _search_python(root, query, path, ctx)


def _fuzzy_score(pattern: str, text: str) -> int:
    """Return a score for how well ``pattern`` matches ``text`` as a subsequence.

    Higher is better. ``pattern`` chars must appear in ``text`` in order
    (case-insensitive). The match is scored by how much of the pattern matched
    plus a small bonus for aligned characters and a penalty for gaps.
    """
    pattern = pattern.lower()
    text = text.lower()
    if not pattern:
        return 0
    score = 0
    penalty = 0
    prev_idx = -1
    for ch in pattern:
        idx = text.find(ch, prev_idx + 1)
        if idx == -1:
            return 0
        if prev_idx != -1:
            if idx == prev_idx + 1:
                score += 8  # consecutive match
            else:
                penalty += idx - prev_idx
        else:
            penalty += idx  # leading gap
        prev_idx = idx
    score += pattern.__len__() * 3
    return max(1, score - penalty)


def fuzzy_find_files(root: str, query: str, path: str = "") -> dict:
    """Fuzzily find files/dirs by name under ``path`` (relative to root).

    Matches by basename using subsequence fuzzy matching (query chars in order).
    Results are ranked by match score, then by path depth. Useful when the user
    only remembers part of a filename (litmus -> ``Liteform.tsx``).
    """
    target = resolve_safe(root, path, allow_coder=True)
    if not os.path.isdir(target):
        return {"query": query, "matches": [], "error": "not a directory"}

    query = query.strip()
    if not query:
        return {"query": query, "matches": []}

    scored: list[tuple[int, str]] = []
    for file in _walk_files(target):
        base = os.path.basename(file)
        score = _fuzzy_score(query, base)
        if score <= 0:
            continue
        rel = _display_path(root, file)
        depth = rel.count(os.sep)
        # Order by score desc, then depth asc. Encode as sortable tuple.
        scored.append((-score, depth, rel))

    scored.sort()
    matches = [
        {"path": rel, "name": os.path.basename(rel)}
        for _, _, rel in scored[:MAX_SEARCH_RESULTS]
    ]
    return {"query": query, "matches": matches, "truncated": len(scored) > MAX_SEARCH_RESULTS}


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
        if seg.startswith(_GIT_PREFIXES):
            return True
        # First meaningful command is not a search — stop here.
        return False
    return False


def make_tool_callbacks(
    root: str,
    emit: Callable[[dict], None],
    context_window: int = 0,
    summarizer_model: Any = None,
    web_model: Any = None,
    search_model: Any = None,
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

    # Correlate every tool call with its result via a per-turn monotonic
    # `call_id`. The UI previously matched tool_results to running cards by
    # (tool name + status) alone, which breaks when the SAME tool runs multiple
    # times in a turn (e.g. 8× fuzzy_find) or when explore's sub-agent emits
    # identically-named tool events into the same stream — results could resolve
    # the wrong card, leaving a genuinely-started card stuck on "running"
    # forever. Wrapping emit here gives each tool→result pair a stable id that
    # the frontend can match on; sub-agent events (already tagged `sub=True`)
    # flow through the same wrapper and get their own ids.
    _call_seq = 0
    _pending_calls: dict[str, list[int]] = {}
    _pending_sub_calls: dict[str, list[int]] = {}

    def _emit(event: dict) -> None:
        nonlocal _call_seq
        ev = dict(event)
        kind = ev.get("kind")
        tool = ev.get("tool") or ""
        is_sub = bool(ev.get("sub"))
        if kind == "tool":
            _call_seq += 1
            ev["call_id"] = _call_seq
            if is_sub:
                _pending_sub_calls.setdefault(tool, []).append(_call_seq)
            else:
                _pending_calls.setdefault(tool, []).append(_call_seq)
        elif kind == "tool_result":
            queue = _pending_sub_calls if is_sub else _pending_calls
            if queue.get(tool):
                ev["call_id"] = queue[tool].pop(0)
        orig_emit(ev)

    orig_emit = emit
    emit = _emit

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

    async def list_files_tool(path: str = "") -> str:
        """List the entries of one directory. `path` is relative to the workspace root; omit it (or pass \"\") to list the root. Shows ONE level only — not recursive. Directories are marked with a trailing `/`; hidden files are skipped (except .gitignore/.env). Long listings are truncated with an `…(N more)` note."""
        emit({"kind": "tool", "tool": "list_files", "args": {"path": path}})
        try:
            result = list_files(root, path)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("list_files", msg))
            return f"ERROR listing {path}: {msg}"
        if "error" in result:
            emit(_error_result("list_files", result["error"]))
            return f"ERROR listing {path}: {result['error']}"
        lines = []
        for entry in result["entries"][:listing_count]:
            marker = "/" if entry["kind"] == "dir" else "  "
            lines.append(f"{marker}{entry['name']}")
        if len(result["entries"]) > listing_count:
            lines.append(f"…({len(result['entries']) - listing_count} more entries)")
        body = "\n".join(lines) if lines else "(empty directory)"
        emit({"kind": "tool_result", "tool": "list_files", "summary": f"{len(result['entries'])} entries"})
        return f"DIRECTORY {path or '/'}\n{body}"

    async def search_tool(query: str, path: str = "", context: int = 0) -> str:
        """Search file CONTENTS under the workspace. `query` is a REGEX (matched case-insensitively, per line), so combine alternatives with `foo|bar`. `path` is an optional subdirectory to restrict the search to (omit = whole workspace). `context` = number of surrounding lines to return before/after each match (use 5-10 to see code around a hit). Respects .gitignore; skips hidden/binary files. Returns `file:line: text` blocks, truncated to fit context."""
        emit({
            "kind": "tool",
            "tool": "search_in_files",
            "args": {"query": query, "path": path, "context": context},
        })
        try:
            result = search_in_files(root, query, path, context)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("search_in_files", msg))
            return f"ERROR searching {path}: {msg}"
        if result.get("error"):
            msg = result["error"]
            emit(_error_result("search_in_files", msg))
            return f"ERROR searching {path}: {msg}"
        matches = result.get("matches", [])
        if not matches:
            emit({"kind": "tool_result", "tool": "search_in_files", "summary": "no matches"})
            return f"No matches for {query!r} under {path or '/'}."
        # Hard cap on the total characters returned so a broad search can't
        # flood the context window (context lines multiply match size fast).
        lines: list[str] = []
        total = 0
        shown = 0
        for m in matches:
            if shown >= search_count:
                break
            block = [f"{m['file']}:{m['line']}: {m['text']}"]
            if m.get("context_lines"):
                for cl in m["context_lines"]:
                    marker = ">" if cl["line"] == m["line"] else " "
                    block.append(f"{m['file']}:{cl['line']}: {marker} {cl['text']}")
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
        emit({"kind": "tool_result", "tool": "search_in_files", "summary": f"{len(matches)} matches"})
        return f"MATCHES for {query!r}\n" + "\n".join(lines) + note

    async def terminal_tool(command: str, timeout: int = TERMINAL_TIMEOUT) -> str:
        """Run a shell command in the workspace root and return its output. The command runs with the project folder as the working directory, is killed after `timeout` seconds (default 120), and privileged/system-destructive commands (sudo, rm -rf /, mkfs, reboot, piping into a shell, ...) are blocked. Use this for git, package managers, build/run/lint/test commands and other project operations."""
        emit({"kind": "tool", "tool": "run_terminal", "args": {"command": command}})
        result = await asyncio.to_thread(run_terminal, root, command, timeout, permit)
        if "error" in result:
            msg = result["error"]
            emit(_error_result("run_terminal", msg))
            return f"ERROR running {command!r}: {msg}"
        output = result["output"].strip()
        if len(output) > terminal_out_chars:
            output = output[:terminal_out_chars] + "\n…(output truncated to fit context)"
        summary = f"exit {result['exit_code']} · {len(output)} chars"
        emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary})
        nudge = _format_plan_nudge_suffix(_plan_nudge_due())
        if not output:
            return f"$ {command}\n(no output, exit code {result['exit_code']})" + nudge
        # When a dedicated "search" subagent model is configured and this is a
        # codebase search (grep/rg/find/sed...), pass the raw output through the
        # search subagent so it does the interpretation work (and its tokens are
        # accounted to the search model in MODEL USAGE), instead of the parent
        # model reading the raw output directly.
        if search_model is not None and _is_terminal_search(command) and len(output) >= 600:
            try:
                from pydantic_ai import Agent as _SA
                from pydantic_ai.settings import ModelSettings as _SMS

                reader = _SA(
                    search_model,
                    system_prompt=(
                        "You are a code-search reader. A shell command searched the "
                        "codebase and produced the raw output below. Distill it into a "
                        "CONCISE answer (under ~150 words): what was found, exact file "
                        "paths and line numbers, and a one-line note on the most "
                        "relevant match. Do not restate the whole raw output."
                    ),
                    model_settings=_SMS(temperature=0.2, max_tokens=400),
                )
                res = await _run_subagent_call(
                    lambda: reader.run(
                        f"COMMAND: {command}\n\nOUTPUT:\n{output}",
                        model_settings=_SMS(
                            timeout=_providers.model_timeout(
                                model=search_model, total=60, connect=15, read=60
                            )
                        ),
                    ),
                    "terminal-search reader",
                    emit=emit,
                    model_name=str(getattr(search_model, "model_name", "") or ""),
                )
                distilled = str(getattr(res, "output", "") or "").strip()
                if distilled:
                    from agents import _usage_event  # local import (circular-safe)

                    _usage_ev = _usage_event(
                        getattr(res, "usage", None),
                        model=str(getattr(search_model, "model_name", "") or ""),
                    )
                    if _usage_ev:
                        emit(_usage_ev)
                    emit({
                        "kind": "tool_result",
                        "tool": "run_terminal",
                        "summary": f"search distilled · {len(distilled)} chars",
                    })
                    return (
                        f"$ {command}\n\nSEARCH SUBAGENT SUMMARY:\n{distilled}" + nudge
                    )
            except Exception as exc:  # noqa: BLE001 — fall back to raw output
                # The search subagent model failed (bad key / invalid model /
                # quota). Say so with the model name so the user can fix it in
                # Settings → Subagents, THEN provide the raw output as fallback.
                _search_note = _subagent_fail_note(
                    "search", str(getattr(search_model, "model_name", "") or ""), exc
                )
                if _search_note:
                    emit(
                        {
                            "kind": "tool_result",
                            "tool": "run_terminal",
                            "summary": "search subagent failed — raw output below",
                            "status": "error",
                        }
                    )
                    return f"$ {command}\n{_search_note}\n{output}" + nudge
        return f"$ {command}\n{output}" + nudge

    async def fuzzy_find_tool(query: str, path: str = "") -> str:
        """Find FILES/DIRS by partial name. `query` is a plain substring-like match on the file's basename (characters must appear in order, NOT regex) — use when you remember only part of a filename, e.g. `litmus` → `Liteform.tsx`. `path` optionally narrows the subtree (omit = whole workspace). Returns ranked relative paths, truncated at 50."""
        emit({"kind": "tool", "tool": "fuzzy_find", "args": {"query": query, "path": path}})
        try:
            result = fuzzy_find_files(root, query, path)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit(_error_result("fuzzy_find", msg))
            return f"ERROR finding {query!r} under {path or '/'}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit(_error_result("fuzzy_find", msg))
            return f"ERROR finding {query!r} under {path or '/'}: {msg}"
        matches = result.get("matches", [])
        if not matches:
            emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": "no matches"})
            return f"No files match {query!r} under {path or '/'}."
        lines = [m["path"] for m in matches[:50]]
        note = f"\n({len(matches)} matches shown)" if len(matches) > 50 else ""
        emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": f"{len(matches)} matches"})
        return f"FUZZY MATCHES for {query!r}\n" + "\n".join(lines) + note

    async def read_files_tool(paths: list[str], per_file_chars: int = 4000) -> str:
        """Read the content of already-identified files for verbatim code you need (JSX/CSS/functions). `paths` = list of workspace-relative file paths (max 5). `per_file_chars` caps each file's returned content (default 4000) so a read can't flood context. Use AFTER you know the exact paths (from fuzzy_find/search_in_files/explore) — not for discovery. One call can pull several known files; skip what you don't need."""
        emit({"kind": "tool", "tool": "read_files", "args": {"paths": paths}})
        if not paths:
            emit(_error_result("read_files", "no paths given"))
            return "ERROR: pass at least one file path."
        cap = max(200, min(int(per_file_chars or 6000), 40_000))
        blocks: list[str] = []
        shown = 0
        for p in paths[:5]:
            shown += 1
            try:
                result = read_file(root, p)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                emit(_error_result("read_files", msg))
                blocks.append(f"{p}: ERROR {msg}")
                continue
            if result.get("error"):
                blocks.append(f"{p}: ERROR {result['error']}")
                continue
            content = result.get("content", "")
            truncated = result.get("truncated", False)
            if len(content) > cap:
                content = content[:cap] + "\n…(truncated to fit context)"
            blocks.append(f"===== {p} =====\n{content}")
            emit({
                "kind": "tool_result",
                "tool": "read_files",
                "summary": f"{p} · {len(content)} chars" + (" (truncated)" if truncated or len(result.get('content', '')) > cap else ""),
            })
        emit({"kind": "tool_result", "tool": "read_files", "summary": f"{shown} file(s) read"})
        return "\n\n".join(blocks)

    async def explore_tool(task: str, path_hint: str = "", hints: str = "") -> str:
        """Delegate a broad, read-only investigation to an ISOLATED sub-agent (its own search loop/context; only its short report reaches you). Use instead of a long chain of your own list_files/search_in_files/fuzzy_find when a question spans MANY files or an unfamiliar area. Pass a clear, SPECIFIC `task`; optionally `path_hint` (subdir, e.g. 'src/components') and `hints` (known symbols/files). Not for a single lookup — search yourself."""
        emit({"kind": "tool", "tool": "explore", "args": {"task": task}})
        if summarizer_model is None:
            emit(_error_result("explore", "unavailable"))
            return "ERROR: explore is unavailable (no model configured for this session)."

        # Sub-agent-specific tighter limits — keeps tool output compact
        # so the sub-agent model sees only relevant data, never megabytes.
        _sub_listing_count = min(listing_count, 30)
        _sub_search_count = min(search_count, 30)
        _sub_tool_out_chars = max(400, min(tool_out_chars, 5_000))

        def _sub_emit(event: dict) -> None:
            # Forward to the same UI stream (so the user sees live sub-agent
            # activity) but tagged `sub=True` so the PARENT's deterministic
            # tool-step budget (see agents.py) does not count these steps —
            # they never enter the parent model's own resent transcript, only
            # the sub-agent's, which is discarded once explore_tool returns.
            event = dict(event)
            event["sub"] = True
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
        _sub_seen_listings: set[tuple[str, str]] = set()
        _sub_result_cache: dict[str, str] = dict(_explore_turn_digest)

        def _sub_search_key(query: str, path: str) -> tuple[str, str]:
            q = re.sub(r"[^a-z0-9_.@]+", "", (query or "").lower())
            p = re.sub(r"[^a-z0-9_.@/]+", "", (path or "").lower())
            return (q, p)

        def _sub_cache_key(tool: str, key: tuple[str, str]) -> str:
            return f"{tool}|{key[0]}|{key[1]}"

        def _sub_cached(tool: str, key: tuple[str, str]) -> str | None:
            return _sub_result_cache.get(_sub_cache_key(tool, key))

        def _sub_cache_put(tool: str, key: tuple[str, str], body: str) -> None:
            """Store a tool result in BOTH the per-call cache and the turn-level
            digest, so a later explore call in the same turn can reuse it."""
            ckey = _sub_cache_key(tool, key)
            _sub_result_cache[ckey] = body
            _explore_turn_digest[ckey] = body

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
                except Exception:  # noqa: BLE001
                    continue
                if cand == root_real or not cand.startswith(root_real + os.sep):
                    continue
                if not os.path.isfile(cand):
                    bad.append(f"{rel}:{line}")
                    if len(bad) >= 15:
                        break
            return bad

        def _sub_check_seen(tool: str, key: tuple[str, str], query: str, path: str) -> str | None:
            for seen_key in _sub_seen_searches:
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
                            "tool": "search_in_files",
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
                            "tool": "search_in_files",
                            "summary": "already searched",
                        }
                    )
                    return (
                        f"ALREADY SEARCHED: you previously searched a more specific term "
                        f"({seen_key[0]!r}) under {path or '/'}. Result from earlier:\n"
                        f"{body}"
                    )
            return None

        async def _sub_list_files(path: str = "") -> str:
            _sub_emit({"kind": "tool", "tool": "list_files", "args": {"path": path}})
            lkey = _sub_search_key("", path) or (path, "")
            # Listing a directory is idempotent: re-listing the SAME directory
            # later in a run returns the same tree and only re-resends the whole
            # sub-agent transcript for nothing. Fold repeats (the sub-agent
            # re-listed backend/, the root and scripts/ three times during a
            # retry).
            if lkey in _sub_seen_listings:
                cached = _sub_cached("list_files", lkey)
                body = cached or f"(no stored result for {path or '/'})"
                _sub_emit(
                    {
                        "kind": "tool_result",
                        "tool": "list_files",
                        "summary": "already listed",
                    }
                )
                return (
                    f"ALREADY LISTED: you listed {path or '/'} earlier. Listing from earlier:\n"
                    f"{body}"
                )
            _sub_seen_listings.add(lkey)
            try:
                result = list_files(root, path)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                _sub_emit(_error_result("list_files", msg))
                return f"ERROR listing {path}: {msg}"
            if "error" in result:
                _sub_emit(_error_result("list_files", result["error"]))
                return f"ERROR listing {path}: {result['error']}"
            lines = []
            for entry in result["entries"][:_sub_listing_count]:
                marker = "/" if entry["kind"] == "dir" else "  "
                lines.append(f"{marker}{entry['name']}")
            if len(result["entries"]) > _sub_listing_count:
                lines.append(f"…({len(result['entries']) - _sub_listing_count} more entries)")
            body = "\n".join(lines) if lines else "(empty directory)"
            out = f"DIRECTORY {path or '/'}\n{body}"
            _sub_cache_put("list_files", lkey, out)
            _sub_emit({"kind": "tool_result", "tool": "list_files", "summary": f"{len(result['entries'])} entries"})
            return out

        async def _sub_search(query: str, path: str = "", context: int = 0) -> str:
            _sub_emit({"kind": "tool", "tool": "search_in_files", "args": {"query": query, "path": path, "context": context}})
            key = _sub_search_key(query, path)
            if key[0]:
                stop = _sub_check_seen("search_in_files", key, query, path)
                if stop is not None:
                    return stop
                _sub_seen_searches.add(key)
            try:
                result = search_in_files(root, query, path, context)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                _sub_emit(_error_result("search_in_files", msg))
                return f"ERROR searching {path}: {msg}"
            if result.get("error"):
                msg = result["error"]
                _sub_emit(_error_result("search_in_files", msg))
                return f"ERROR searching {path}: {msg}"
            matches = result.get("matches", [])
            if not matches:
                out = f"No matches for {query!r} under {path or '/'}."
                if key[0]:
                    _sub_cache_put("search_in_files", key, out)
                _sub_emit({"kind": "tool_result", "tool": "search_in_files", "summary": "no matches"})
                return out
            lines: list[str] = []
            total = 0
            shown = 0
            for m in matches:
                if shown >= _sub_search_count:
                    break
                block = [f"{m['file']}:{m['line']}: {m['text']}"]
                if m.get("context_lines"):
                    for cl in m["context_lines"]:
                        marker = ">" if cl["line"] == m["line"] else " "
                        block.append(f"{m['file']}:{cl['line']}: {marker} {cl['text']}")
                block_size = sum(len(b) + 1 for b in block)
                if lines and total + block_size > _sub_tool_out_chars:
                    break
                lines.extend(block)
                shown += 1
                total += block_size
                if total >= _sub_tool_out_chars:
                    break
            note = f"\n({len(matches)} matches found, {shown} shown)" if len(matches) > shown else ""
            out = f"MATCHES for {query!r}\n" + "\n".join(lines) + note
            if key[0]:
                _sub_cache_put("search_in_files", key, out)
            _sub_emit({"kind": "tool_result", "tool": "search_in_files", "summary": f"{len(matches)} matches"})
            return out

        async def _sub_fuzzy_find(query: str, path: str = "") -> str:
            _sub_emit({"kind": "tool", "tool": "fuzzy_find", "args": {"query": query, "path": path}})
            key = _sub_search_key(query, path)
            if key[0]:
                stop = _sub_check_seen("fuzzy_find", key, query, path)
                if stop is not None:
                    return stop
                _sub_seen_searches.add(key)
            try:
                result = fuzzy_find_files(root, query, path)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                _sub_emit(_error_result("fuzzy_find", msg))
                return f"ERROR finding {query!r} under {path or '/'}: {msg}"
            matches = result.get("matches", [])
            if not matches:
                out = f"No files match {query!r} under {path or '/'}."
                if key[0]:
                    _sub_cache_put("fuzzy_find", key, out)
                _sub_emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": "no matches"})
                return out
            lines = [m["path"] for m in matches[:50]]
            out = f"FUZZY MATCHES for {query!r}\n" + "\n".join(lines)
            if key[0]:
                _sub_cache_put("fuzzy_find", key, out)
            _sub_emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": f"{len(matches)} matches"})
            return out

        try:
            from pydantic_ai import Agent as _Agent
            from pydantic_ai import Tool as _Tool
            from pydantic_ai.exceptions import UsageLimitExceeded as _UsageLimitExceeded
            from pydantic_ai.messages import (
                ModelRequest as _ModelRequest,
                SystemPromptPart as _SystemPromptPart,
            )
            from pydantic_ai.settings import ModelSettings as _ModelSettings
            from pydantic_ai.usage import UsageLimits as _UsageLimits

            # Prepend path hint and known hints to the task when given.
            task_text = task
            if path_hint:
                task_text = f"Search ONLY within {path_hint}. {task}"
            if hints:
                task_text = f"Known hints: {hints}. {task_text}"
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

            sub_agent = _Agent(
                summarizer_model,
                system_prompt=(
                    "You are a read-only exploration sub-agent. Your job is to find the "
                    "answer FAST and CHEAPLY and hand back a compact structured report. "
                    "TIME IS PRECIOUS — every search round-trip re-sends your whole "
                    "transcript, so do not over-explore.\n"
                    "INTENT (do this before your first search): state in one sentence "
                    "what you are actually looking for (the literal request vs. the real "
                    "underlying need) so your searches are targeted, not scattershot.\n"
                    "PARALLEL-FIRST ACTION: on your very first turn launch 3+ tool calls "
                    "SIMULTANEOUSLY — fire the fuzzy_find / list_files / search_in_files "
                    "calls you already know you need in ONE response (batch related terms "
                    "with regex alternation foo|bar|baz). Do NOT do a serial "
                    "search→read→decide-next loop.\n"
                    "TOOL CHOICE: use fuzzy_find to locate FILES by name (part of a filename, "
                    "or an extension like 'py'), use list_files to see a directory's contents, "
                    "and use search_in_files only to find CONTENT INSIDE already-identified files "
                    "or to confirm a symbol/string exists. Do NOT search_in_files to discover which "
                    "files exist — that returns hundreds of noisy matches. Never repeat a search "
                    "with only a minor keyword variation. Do NOT search for overly generic terms "
                    "like 'class', 'function', 'def', 'import' or punctuation — use specific, "
                    "project-relevant keywords. Pass context=5-10 on your first content search of "
                    "a file.\n"
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
                    "confirm it with fuzzy_find before citing it. Only cite facts that appear in "
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
                    _Tool(_sub_list_files, name="list_files"),
                    _Tool(_sub_search, name="search_in_files"),
                    _Tool(_sub_fuzzy_find, name="fuzzy_find"),
                ],
                model_settings=_ModelSettings(temperature=0.2, max_tokens=_sub_max_tokens),
            )

            # Widen-and-resume retry loop (mirrors the PARENT agent's handling in
            # agents.py: a pydantic-ai UsageLimitExceeded or a provider context
            # overflow is NOT a hard failure — raise the budget / resume from the
            # cached tool results so a broad-but-legitimate investigation finishes
            # in this isolated run instead of telling the PARENT to split the task
            # (which then re-pays full discovery overhead in its OWN context).
            # Each retry keeps the result cache (built above), so the fresh model
            # gets its earlier findings back via the dedup instead of re-exploring.
            _sub_model_name = str(getattr(summarizer_model, "model_name", "") or "")
            _sub_request_limit = 10
            _sub_tool_calls_limit = 24
            _sub_widen_retries = 0
            _sub_overflow_retries = 0
            _sub_run_prompt = task_text
            _sub_res = None
            while True:
                try:
                    _sub_res = await _run_subagent_call(
                        lambda: sub_agent.run(
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
                                    model=summarizer_model, total=90, connect=10, read=90
                                )
                            ),
                        ),
                        "explore sub-agent",
                        emit=emit,
                        model_name=_sub_model_name,
                    )
                    break
                except _UsageLimitExceeded:
                    # Step/request budget hit, no mutating side effects possible
                    # (read-only sub-agent). Widen the budget and resume with the
                    # cached tool results, mirroring the parent's widen branch.
                    if _sub_widen_retries >= 2:
                        raise
                    _sub_widen_retries += 1
                    _sub_request_limit = min(_sub_request_limit * 2, 40)
                    _sub_tool_calls_limit = min(_sub_tool_calls_limit * 2, 72)
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
                except Exception as exc:  # noqa: BLE001
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
                                    "REAL file (confirm it with fuzzy_find/search_in_files first) or "
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
                                        model=summarizer_model, total=60, connect=10, read=60
                                    )
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
        except _UsageLimitExceeded:
            emit(_error_result("explore", "step budget exceeded"))
            return (
                f"EXPLORE for {task!r} did not finish within its step budget — the task was likely too "
                "broad. Split it into smaller, more specific explore calls, or investigate the remaining "
                "part yourself with search_in_files."
            )
        except Exception as exc:  # noqa: BLE001
            _sub_model = str(getattr(summarizer_model, "model_name", "") or "")
            emit(_error_result("explore", f"failed: {exc}"))
            return (
                f"ERROR: explore sub-agent failed"
                f" ({_sub_model} model, change it in Settings → Subagents): {exc}"
            )
        # The sub-agent's model requests are billed real tokens, but they ran
        # through a SEPARATE pydantic_ai Agent instance that never passed through
        # _UsageCapability (that's only wired up for the PARENT agent's own model
        # in agents.py) — so this usage was silently missing from both the live
        # context meter and the cost total. Surface it the same way a normal
        # tool-loop step does, via the same _usage_event normalizer.
        from agents import (
            _usage_event,  # local import: agents.py imports this module at load time
        )

        sub_model_name = str(getattr(summarizer_model, "model_name", "") or "")
        usage_event = _usage_event(getattr(res, "usage", None), model=sub_model_name)
        if usage_event:
            emit(usage_event)
        if not report:
            emit(_error_result("explore", "no report"))
            return f"The exploration sub-agent found nothing usable for {task!r}."
        emit({"kind": "tool_result", "tool": "explore", "summary": f"{len(report)} chars"})
        return f"EXPLORE REPORT for {task!r}\n{report}"

    async def web_search_tool(query: str, max_results: int = 5) -> str:
        emit({"kind": "tool", "tool": "web_search", "args": {"query": query}})
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
        emit({"kind": "tool_result", "tool": "web_search", "summary": summary, "engine": engine, "results": ui_items})
        raw_results = f"WEB RESULTS for {query!r}\n" + "\n".join(lines)
        # If a dedicated "web" subagent model is configured, distill the raw
        # results into a concise answer so the main context stays lean
        # (Claude-Code-style). Otherwise return the raw results as before.
        if web_model is not None:
            try:
                from pydantic_ai import Agent
                from pydantic_ai.settings import ModelSettings

                distiller = Agent(
                    web_model,
                    system_prompt=(
                        "You are a web-search reader. Read the quoted search results "
                        "and answer the user's query with a CONCISE summary (under "
                        "150 words) that cites the most relevant result URLs inline. "
                        "If the results cannot answer the query, say so."
                    ),
                    model_settings=ModelSettings(temperature=0.2, max_tokens=400),
                )
                res = await _run_subagent_call(
                    lambda: distiller.run(
                        f"QUERY: {query}\n\nSEARCH RESULTS:\n" + "\n".join(lines),
                        model_settings=ModelSettings(
                            timeout=_providers.model_timeout(
                                model=web_model, total=60, connect=15, read=60
                            )
                        ),
                    ),
                    "web-search distiller",
                    emit=emit,
                    model_name=str(getattr(web_model, "model_name", "") or ""),
                )
                distilled = str(getattr(res, "output", "") or "").strip()
                if distilled:
                    from agents import _usage_event  # local import (circular-safe)

                    _usage_ev = _usage_event(
                        getattr(res, "usage", None),
                        model=str(getattr(web_model, "model_name", "") or ""),
                    )
                    if _usage_ev:
                        emit(_usage_ev)
                    emit({
                        "kind": "tool_result",
                        "tool": "web_search",
                        "summary": f"{len(results)} results (distilled)",
                        "engine": engine,
                        "results": ui_items,
                    })
                    return f"WEB RESULTS for {query!r} (distilled)\n{distilled}"
            except Exception as exc:  # noqa: BLE001 — fall back to raw results
                # The web subagent model failed — tell the user which one to fix
                # in Settings → Subagents, then return raw results as fallback.
                _web_note = _subagent_fail_note(
                    "web", str(getattr(web_model, "model_name", "") or ""), exc
                )
                if _web_note:
                    return raw_results + "\n\n" + _web_note
        return raw_results

    async def fetch_url_tool(url: str, question: str = "", full: bool = False) -> str:
        """Fetch a web page / raw file and return its extracted text. Default returns a bounded excerpt (or a sub-agent summary when `question` is set). For copying source files (SKILL.md/docs/raw.githubusercontent/jsdelivr/gist URLs) the backend auto-returns full text (up to 24k chars) — one call per file is enough; don't pass `full=True` and don't re-fetch the same file via other hosts. Every call re-sends the whole conversation, so it costs real tokens."""
        effective_full = bool(full)
        emit({"kind": "tool", "tool": "fetch_url", "args": {"url": url, "full": effective_full}})
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

        emit({
            "kind": "tool_result",
            "tool": "fetch_url",
            "summary": f"{len(body)} chars",
        })

        # Claude-Code-style: the main model receives only a distilled answer,
        # not the raw page. A summarizer model (the same configured model, run
        # with a tiny token budget) answers the `question` from the extracted
        # text, keeping the main context lean.
        answer = ""
        if web_model is not None or summarizer_model is not None:
            try:
                from pydantic_ai import Agent
                from pydantic_ai.settings import ModelSettings

                summarizer = Agent(
                    web_model or summarizer_model,
                    system_prompt=(
                        "You are a web-page reader. Read the quoted page text and "
                        "answer the user's question with a CONCISE summary (under "
                        "120 words). If the page cannot answer the question, say "
                        "so. Ignore navigation menus, sidebars, footers and "
                        "ads."
                    ),
                    model_settings=ModelSettings(temperature=0.2, max_tokens=400),
                )
                _prompt = question.strip() or "Summarize the key content of this page."
                res = await _run_subagent_call(
                    lambda: summarizer.run(
                        f"QUESTION: {_prompt}\n\nPAGE TEXT:\n{body}",
                        model_settings=ModelSettings(
                            timeout=_providers.model_timeout(
                                model=web_model or summarizer_model, total=90, connect=15, read=90
                            )
                        ),
                    ),
                    "web-page summarizer",
                    emit=emit,
                    model_name=str(
                        getattr(web_model or summarizer_model, "model_name", "") or ""
                    ),
                )
                answer = str(getattr(res, "output", "") or "").strip()
                # Surface the summarizer's token usage so it shows in MODEL USAGE
                # (same normalizer the explore sub-agent uses).
                from agents import _usage_event  # local import (circular-safe)

                _usage_ev = _usage_event(
                    getattr(res, "usage", None),
                    model=str(
                        getattr(web_model or summarizer_model, "model_name", "") or ""
                    ),
                )
                if _usage_ev:
                    emit(_usage_ev)
            except Exception as exc:  # noqa: BLE001
                # Web summarizer subagent failed — note it with the model name
                # so the user can fix Settings → Subagents, then excerpt-fall.
                answer = ""
                _web_note = _subagent_fail_note(
                    "web",
                    str(getattr(web_model or summarizer_model, "model_name", "") or ""),
                    exc,
                )
                if _web_note:
                    answer = _web_note  # becomes the "summary" replaced below

        head = f"PAGE {url}\n" + (f"TITLE: {title}\n" if title else "")
        if answer:
            if answer.startswith("Note: the"):
                return head + answer
            return head + "SUMMARY:\n" + answer
        # Fallback: no summarizer (or it failed) — return a bounded excerpt that
        # respects the shared context budget so it can never overflow the window.
        if len(body) > _cap:
            body = body[: _cap] + "\n…(output truncated to fit context)"
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

    return {
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
        "list_files": list_files_tool,
        "search_in_files": search_tool,
        "fuzzy_find": fuzzy_find_tool,
        "read_files": read_files_tool,
        "explore": explore_tool,
        "save_plan": save_plan_tool,
        "web_search": web_search_tool,
        "search_console": search_console_tool,
        "fetch_url": fetch_url_tool,
        "run_terminal": terminal_tool,
    }
