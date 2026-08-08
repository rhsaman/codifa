"""Sandboxed filesystem tools for the Pydantic AI agent.

Every path is resolved through a project ROOT. Absolute paths, `..` escapes and
symlink escapes are rejected by comparing realpaths so the agent can never touch
files outside the selected project folder.
"""

from __future__ import annotations

import asyncio
import difflib
import json
import os
import re
import shutil
import signal
import subprocess
import unicodedata
import uuid
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Any

MAX_READ_BYTES = 2_000_000  # 2 MB
MAX_SEARCH_RESULTS = 200
MAX_FILES = 10_000
MAX_TERMINAL_OUTPUT = 30_000
TERMINAL_TIMEOUT = 120
TERMINAL_TIMEOUT_MAX = 300
MAX_WEB_SEARCH_RESULTS = 5
WEB_SEARCH_SNIPPET_MAX = 200  # per-result snippet cap to keep search context lean
WEB_SEARCH_TIMEOUT = 15
SEARCH_TIMEOUT = 20  # seconds for a ripgrep search

# DuckDuckGo HTML search backend (no API key required). Imported lazily inside
# the function so a missing/old package degrades to a friendly message instead
# of failing at import time.
_BACKEND = "duckduckgo"

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
    user-level ``~/.coder`` config dir are also allowed when ``allow_coder`` is
    set — that is where skills, plans and MCP config live, and reading them
    must never require a permission prompt (writing still goes through the
    strict path).
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


def _walk_files(root: str) -> Sequence[str]:
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d not in _SKIP_DIRS
        ]
        for name in filenames:
            found.append(os.path.join(dirpath, name))
            if len(found) >= MAX_FILES:
                return found
    return found


def _display_path(root: str, file: str) -> str:
    """Return a path string the agent can feed straight back into the tools.

    Files under the workspace root show as their tree-relative path (``src/a``);
    files under ``~/.coder`` (user skills/plans/MCP config) show as
    ``~/.coder/skills/...`` so the agent can read them without permission.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    coder = os.path.realpath(user_coder_dir())
    if file == coder or file.startswith(coder + os.sep):
        return "~/.coder/" + os.path.relpath(file, coder).replace(os.sep, "/")
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

    ``~/.coder`` paths (user skills/plans/MCP config) are always readable
    without permission.
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
            "error": "the workspace .coder/ folder is reserved for the agent's own config (MCP servers, skills, plans) and lives in ~/.coder/ instead — do not write here",
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
    """Return the user-level ``~/.coder`` config directory, creating it if needed.

    Skills and MCP connectors live here (global, shared across all workspaces),
    not inside each project's ``.coder/`` folder.
    """
    base = os.path.join(os.path.expanduser("~"), ".coder")
    os.makedirs(base, exist_ok=True)
    return base


def _is_workspace_coder_dir(root: str, target: str) -> bool:
    """True if ``target`` resolves inside ``<root>/.coder``.

    The workspace ``.coder/`` folder is reserved/forbidden: all agent config
    (MCP servers, skills, plans) belongs in ``~/.coder``, never in the project.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    coder_dir = os.path.join(root_real, ".coder")
    return target == coder_dir or target.startswith(coder_dir + os.sep)


def slugify(name: str) -> str:
    """Turn a skill name into a safe folder slug (e.g. 'Code Review' -> 'code-review')."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "skill"


LEARNED_MEMORY_FILE = "MEMORY.md"
LEARNED_MEMORY_MAX_BYTES = 50_000
MEMORY_SEARCH_MAX_RESULTS = 15
_MEMORY_HEADER = "# Agent Memory\n\n## Important Notes\n"


def _memory_bullets(target: str) -> list[str]:
    """Read the memory file and return its ``## Important Notes`` bullets.

    Data lines are top-level markdown list items (``- ``-prefixed); everything
    else is structural and discarded so the file keeps the canonical format.
    """
    if not os.path.isfile(target):
        return []
    try:
        existing, _truncated = _read_text(target)
    except OSError:
        return []
    return [line for line in existing.splitlines() if line.strip().startswith("- ")]


def _memory_render(bullets: list[str]) -> str:
    if not bullets:
        return _MEMORY_HEADER
    return _MEMORY_HEADER + "\n".join(bullets) + "\n"


def _memory_write(target: str, bullets: list[str]) -> None:
    """Write bullets under the canonical header. If the result exceeds the byte
    cap, drop the OLDEST bullets (from the top) until it fits — recent learnings
    are more likely still relevant.
    """
    # Trimming must be length-aware; reduce candidates until under the cap.
    while bullets and len(_memory_render(bullets)) > LEARNED_MEMORY_MAX_BYTES:
        bullets.pop(0)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(_memory_render(bullets))


def _write_memory(target: str, bullets: list[str]) -> dict:
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        _memory_write(target, bullets)
    except OSError as exc:
        return {"path": LEARNED_MEMORY_FILE, "error": str(exc)}
    return {"path": LEARNED_MEMORY_FILE, "ok": True}


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _bullet_date(line: str) -> str:
    m = re.match(r"-\s*\[(\d{4}-\d{2}-\d{2})\]", line.strip())
    return m.group(1) if m else datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _remember_fill(target: str, note: str, stamp: str) -> dict:
    """Dedupe-and-append a note. Shared by ``remember`` and ``replace_memory``."""
    bullets = _memory_bullets(target)
    norm = _normalize(note)
    for line in bullets:
        if norm in _normalize(line):
            return {"path": LEARNED_MEMORY_FILE, "ok": True, "skipped": "duplicate"}
    bullets.append(f"- [{stamp}] {note}")
    return _write_memory(target, bullets)


def remember(root: str, note: str) -> dict:
    """Append a short, durable note to the project's self-written memory file
    (``<root>/MEMORY.md``), so future sessions in this project start
    with what the agent already learned.

    This file is written by the agent itself across sessions — conventions it
    discovered, gotchas, fixes that worked, preferences the user stated in
    passing. Notes live under a single ``## Important Notes`` section. A
    near-duplicate note is skipped. The file is capped at
    ``LEARNED_MEMORY_MAX_BYTES``: oldest entries are dropped first so it never
    grows unbounded.
    """
    note = (note or "").strip()
    if not note:
        return {"error": "empty note"}
    if len(note) > 500:
        note = note[:500] + "…"

    target = resolve_safe(root, LEARNED_MEMORY_FILE)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return _remember_fill(target, note, stamp)


def replace_memory(root: str, subject: str, new_text: str) -> dict:
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

    target = resolve_safe(root, LEARNED_MEMORY_FILE)
    bullets = _memory_bullets(target)
    subject_norm = _normalize(subject)
    for i, line in enumerate(bullets):
        if subject_norm in _normalize(line):
            bullets[i] = f"- [{_bullet_date(line)}] {new_text}"
            return _write_memory(target, bullets)
    return _remember_fill(
        target, new_text, datetime.now(timezone.utc).strftime("%Y-%m-%d")
    )


def remove_memory(root: str, subject: str) -> dict:
    """Hermes-style ``remove``: delete the stored note that contains ``subject``.
    Returns ok (as a no-op) if nothing matches.
    """
    subject = (subject or "").strip()
    if not subject:
        return {"error": "empty subject"}

    target = resolve_safe(root, LEARNED_MEMORY_FILE)
    bullets = _memory_bullets(target)
    subject_norm = _normalize(subject)
    kept = [b for b in bullets if subject_norm not in _normalize(b)]
    if len(kept) == len(bullets):
        return {"path": LEARNED_MEMORY_FILE, "ok": True, "skip": "not found"}
    return _write_memory(target, kept)


def search_memory(root: str, query: str, max_results: int = MEMORY_SEARCH_MAX_RESULTS) -> dict:
    """Search the project's memory bullets for ones relevant to ``query``.

    Now that the memory file can hold many notes (up to
    ``LEARNED_MEMORY_MAX_BYTES``, no longer small enough to always inline into
    the system prompt), this lets the agent pull in only what's relevant
    instead of the whole file. Ranks bullets by keyword overlap — a whole-word
    match scores higher than a bare substring hit — across every word in
    ``query``. An empty query returns the most recently added notes instead
    (the file is append-only, so recency == tail order).
    """
    query = (query or "").strip()
    try:
        target = resolve_safe(root, LEARNED_MEMORY_FILE)
    except PathEscapeError as exc:
        return {"query": query, "error": str(exc)}
    bullets = _memory_bullets(target)
    total = len(bullets)
    if total == 0:
        return {"query": query, "notes": [], "total": 0}
    if not query:
        top = bullets[-max_results:]
        return {"query": query, "notes": list(reversed(top)), "total": total}

    words = [w for w in re.split(r"\W+", query.lower()) if w]
    scored: list[tuple[int, int, str]] = []
    for i, bullet in enumerate(bullets):
        low = bullet.lower()
        score = 0
        for w in words:
            if re.search(rf"\b{re.escape(w)}\b", low):
                score += 3
            elif w in low:
                score += 1
        if score > 0:
            scored.append((-score, -i, bullet))
    scored.sort()
    top = [b for _, _, b in scored[:max_results]]
    return {"query": query, "notes": top, "total": total, "matched": len(scored)}


def create_skill(root: str, name: str, description: str, content: str) -> dict:
    """Create or overwrite a user skill at ``~/.coder/skills/<slug>/SKILL.md``.

    ``name`` is the display name, ``description`` is indexed for the system
    prompt, and ``content`` is the full markdown body (step-by-step
    instructions). Existing skill of the same name is replaced. The ``root``
    argument is kept for API compatibility and is not used.
    """
    slug = slugify(name)
    rel = f"skills/{slug}/SKILL.md"
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
    path = os.path.join(user_coder_dir(), rel)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(markdown)
    except OSError as exc:
        return {"path": f"~/.coder/{rel}", "error": str(exc)}
    return {"path": f"~/.coder/{rel}", "ok": True}


def upsert_mcp_server(root: str, name: str, cfg: dict) -> dict:
    """Add or replace one MCP server entry in ``~/.coder/mcp.json`` (the Claude
    Code ``mcpServers`` JSON shape), which is shared globally across workspaces.

    Reads the existing config (if any), merges ``cfg`` under ``mcpServers[name]``
    and writes it back, preserving the other connectors. ``root`` is kept for API
    compatibility and is not used.
    """
    base = user_coder_dir()
    path = os.path.join(base, "mcp.json")
    data: dict = {"mcpServers": {}}
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                parsed = json.load(fh)
            if isinstance(parsed, dict) and isinstance(parsed.get("mcpServers"), dict):
                data = parsed
    except (OSError, ValueError):
        data = {"mcpServers": {}}
    data["mcpServers"][name] = cfg
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
    except OSError as exc:
        return {"path": "~/.coder/mcp.json", "error": str(exc)}
    return {"path": "~/.coder/mcp.json", "name": name, "ok": True}


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
    """Check every stdio connector in ``~/.coder/mcp.json`` and remove the ones
    that fail to start (bad command, wrong flags, immediate crash).

    Returns the names of the servers that were removed so the app can warn the
    user. HTTP/SSE (url) connectors are not probed at startup.
    """
    base = user_coder_dir()
    path = os.path.join(base, "mcp.json")
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
    except (OSError, ValueError):
        return []
    servers = parsed.get("mcpServers") if isinstance(parsed, dict) else None
    if not isinstance(servers, dict) or not servers:
        return []

    removed: list[str] = []
    changed = False
    for name, cfg in list(servers.items()):
        if not isinstance(cfg, dict):
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
            del servers[name]
            changed = True
            print(f"[coder] MCP server {name!r} disabled at startup: {err}", flush=True)
    if changed:
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"mcpServers": servers}, fh, ensure_ascii=False, indent=2)
        except OSError:
            pass
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
            "error": "the workspace .coder/ folder is reserved for the agent's own config (MCP servers, skills, plans) and lives in ~/.coder/ instead — do not write here",
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
                file = "~/.coder/" + file
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
    """Search the web (DuckDuckGo HTML, no API key required).

    Returns a list of ``{"title", "url", "snippet"}`` results. Never raises —
    network errors and missing backends degrade to a friendly error message.
    """
    query = query.strip()
    if not query:
        return {"query": query, "results": []}
    max_results = max(1, min(int(max_results or 5), MAX_WEB_SEARCH_RESULTS))
    try:
        if _BACKEND == "duckduckgo":
            from ddgs import DDGS

            with DDGS(timeout=WEB_SEARCH_TIMEOUT) as ddgs:
                raw = ddgs.text(query, max_results=max_results)
        else:
            return {"query": query, "error": f"unknown web search backend: {_BACKEND}"}
    except ImportError:
        return {
            "query": query,
            "error": "web search backend not installed; run `uv sync --project backend` to install ddgs",
        }
    except Exception as exc:  # noqa: BLE001
        return {"query": query, "error": f"web search failed: {exc}"}

    results = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        results.append(
            {
                "title": str(item.get("title", "")).strip(),
                "url": str(item.get("href", "") or item.get("url", "")).strip(),
                "snippet": str(item.get("body", "") or item.get("snippet", "")).strip(),
            }
        )
    return {"query": query, "results": results}


MAX_FETCH_BYTES = 250_000
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
    single page can never flood the context window. Never raises.
    """
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"url": url, "error": "url must start with http:// or https://"}
    max_chars = max(500, min(int(max_chars or FETCH_EXCERPT_CHARS), MAX_FETCH_BYTES))
    try:
        import httpx

        with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True) as client:
            resp = client.get(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
                    )
                },
            )
            if resp.status_code >= 400:
                return {
                    "url": url,
                    "error": f"server returned HTTP {resp.status_code}",
                }
            if len(resp.content) > MAX_FETCH_BYTES:
                return {"url": url, "error": "page too large to fetch"}
            ct = resp.headers.get("content-type", "")
            if not (
                "text/" in ct
                or "application/json" in ct
                or "application/xml" in ct
                or ct.startswith("text/html")
                or ct == ""
            ):
                return {"url": url, "error": f"unsupported content-type {ct!r}"}
            body = resp.content.decode("utf-8", errors="replace")
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


def make_tool_callbacks(
    root: str,
    emit: Callable[[dict], None],
    context_window: int = 0,
    summarizer_model: Any = None,
    permission_gates: dict | None = None,
    ask_gates: dict | None = None,
    permit: dict | None = None,
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

    # Reserve headroom so tool outputs + accumulated turn history + reply still fit.
    # Budgets scale with the context window so small models (e.g. 8k) get tight caps
    # that prevent overflow / mid-task truncation.
    if context_window and context_window > 0:
        ctx = int(context_window)
        tool_out_chars = max(400, min((ctx // 12) - 150, 3_000))
        listing_count = max(15, ctx // 600)
        search_count = max(10, ctx // 500)
        terminal_out_chars = min(MAX_TERMINAL_OUTPUT, max(1_500, tool_out_chars * 1))
    else:
        tool_out_chars = MAX_READ_BYTES
        listing_count = 200
        search_count = 50
        terminal_out_chars = MAX_TERMINAL_OUTPUT
    tool_out_chars = min(tool_out_chars, MAX_READ_BYTES)

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
            emit({"kind": "tool_result", "tool": "write_file", "summary": msg})
            return f"ERROR writing {path}: {msg}"
        if "error" in result:
            emit({"kind": "tool_result", "tool": "write_file", "summary": result["error"]})
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
        return f"Successfully wrote {len(content)} characters to {path}."

    async def save_plan_tool(title: str, content: str) -> str:
        """PLAN MODE ONLY. Save the implementation plan you just wrote to `~/.coder/plans/<workspace>/plan.md` (user-level, outside the project), so the user (or Coder mode, in a later turn) can open it again without you having to retype it. Each call OVERWRITES the previous plan for this workspace — there is only ever one `plan.md` per workspace, always the latest task's plan. This is the ONE exception to plan mode being read-only — it never writes into the workspace, only into `~/.coder/plans/`. Call it ONCE, after your plan text is finalized in your reply, with `title` (short description) and `content` (the full plan in markdown — normally the same '## Plan' text you just wrote in your reply). Do not call this for anything other than the final plan for the current task."""
        emit({"kind": "tool", "tool": "save_plan", "args": {"title": title}})
        workspace_slug = slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep))) or "workspace"
        plans_dir = os.path.join(user_coder_dir(), "plans", workspace_slug)
        rel_path = "plan.md"
        abs_path = os.path.join(plans_dir, rel_path)
        try:
            await asyncio.to_thread(os.makedirs, plans_dir, exist_ok=True)

            def _write_plan() -> None:
                with open(abs_path, "w", encoding="utf-8") as fh:
                    fh.write(content)

            await asyncio.to_thread(_write_plan)
        except OSError as exc:
            msg = f"could not write plan: {exc}"
            emit({"kind": "tool_result", "tool": "save_plan", "summary": msg})
            return f"ERROR saving plan to {abs_path}: {msg}"
        emit({"kind": "tool_result", "tool": "save_plan", "summary": abs_path})
        return f"Saved the plan to {abs_path}."

    async def memory_tool(action: str, subject: str, text: str = "") -> str:
        """Curate the project's durable memory (stored in MEMORY.md at the project root and loaded into every future session for this project). IMPORTANT: if the user explicitly asked you to remember/note/keep something in mind (any language, any phrasing), you MUST call this tool with action='add' in this same turn — replying with words like "I'll remember that" WITHOUT calling this tool saves nothing; the tool call itself is the save. action must be one of: 'add' (text= new note), 'replace' (subject= text to find, text= new wording for that bullet), 'remove' (subject= text contained in the bullet to delete). Beyond explicit requests, also remember durable, reusable facts you learn on your own: project conventions and how the project works, gotchas and bug fixes that worked, build/test quirks, and preferences the user stated. In ENGLISH. Do NOT store secrets, credentials, personal data, one-off details, or anything already in AGENTS.md. If memory is near its cap, prefer replace/remove over adding."""
        emit({"kind": "tool", "tool": "memory", "args": {"action": action, "subject": subject, "text": text}})
        action = (action or "").strip().lower()
        try:
            if action == "replace":
                result = replace_memory(root, subject, text)
            elif action == "remove":
                result = remove_memory(root, subject)
            elif action in ("add", "remember", ""):
                result = remember(root, text or subject)
            else:
                msg = f"unknown action {action!r} (use add|replace|remove)"
                emit({"kind": "tool_result", "tool": "memory", "summary": msg})
                return f"ERROR: {msg}"
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit({"kind": "tool_result", "tool": "memory", "summary": msg})
            return f"ERROR updating memory: {msg}"
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "memory", "summary": msg})
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
        """Search this project's durable memory (MEMORY.md at the project root) for notes relevant to `query`. Memory is NOT pre-loaded into your context anymore (it can hold many notes), so call this to pull in only what's relevant instead of guessing. Use it at the start of non-trivial work, when the request sounds like something covered before, or when stuck on a recurring error — pass a few keywords (e.g. "port config", "auth flow", "test failures"). Leave query empty to see the most recently added notes."""
        emit({"kind": "tool", "tool": "search_memory", "args": {"query": query}})
        try:
            result = search_memory(root, query, max_results)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit({"kind": "tool_result", "tool": "search_memory", "summary": msg})
            return f"ERROR searching memory: {msg}"
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "search_memory", "summary": msg})
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
        """Set or update your step-by-step plan for the CURRENT task, shown to the user as a live checklist. ALWAYS call this FIRST, before touching any files — pass the full list with status='pending' for every item, even for requests that look small. As you work, call it again with the SAME full list (not just the changed item), updating the step you just finished to 'completed' and the step you're starting to 'in_progress'. Each item needs 'content' (a short imperative phrase, e.g. "Add the edit_file tool") and 'status' (one of 'pending', 'in_progress', 'completed'). Never skip this — a live checklist should be visible on every task."""
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
                normalized.append({"content": content[:200], "status": status})
        if not normalized:
            emit({"kind": "tool_result", "tool": "update_plan", "summary": "empty plan"})
            return "ERROR: plan must contain at least one item with non-empty 'content'."
        emit({"kind": "plan", "items": normalized})
        done = sum(1 for i in normalized if i["status"] == "completed")
        emit({
            "kind": "tool_result",
            "tool": "update_plan",
            "summary": f"{done}/{len(normalized)} done",
        })
        return f"Plan updated: {len(normalized)} steps, {done} completed."

    async def create_skill_tool(
        name: str, description: str = "", content: str = ""
    ) -> str:
        """Create or update a reusable user skill in ~/.coder/skills/<slug>/SKILL.md (global, shared across all workspaces). `name` is the skill's display name; `description` is a one-line summary of when to use it (indexed by the system prompt); `content` is the full markdown body — step-by-step instructions the agent follows when the skill matches. Prefer this over write_file when the user asks to add, install or create a skill so the skill is indexed and picked up by future runs."""
        emit({
            "kind": "tool",
            "tool": "create_skill",
            "args": {"name": name, "description": description},
        })
        try:
            result = create_skill(root, name, description, content)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit({"kind": "tool_result", "tool": "create_skill", "summary": msg})
            return f"ERROR creating skill {name!r}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "create_skill", "summary": msg})
            return f"ERROR creating skill {name!r}: {msg}"
        emit({
            "kind": "tool_result",
            "tool": "create_skill",
            "summary": f"saved {result['path']}",
        })
        return (
            f"Skill {name!r} saved to {result['path']}. It is indexed automatically "
            "and will be offered on future runs. Tell the user the skill was created "
            "and where it lives."
        )

    async def create_mcp_tool(
        name: str,
        command: str = "",
        args: list[str] | None = None,
        url: str = "",
        env: dict[str, str] | None = None,
    ) -> str:
        """Add or update an MCP tool connector in the user-level ~/.coder/mcp.json (global, shared across all workspaces). `name` is the connector id shown in Settings → MCP. For a local server use `command` (e.g. "npx") plus optional `args` (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]) and `env` (extra environment variables, supports ${VAR} expansion). For a remote HTTP/SSE server use `url` instead; the url is verified to be a real MCP endpoint before saving. The connector takes effect on the next message in any mode and its tools become available to the agent."""
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
            emit({"kind": "tool_result", "tool": "create_mcp", "summary": msg})
            return f"ERROR creating MCP connector {name!r}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "create_mcp", "summary": msg})
            return f"ERROR creating MCP connector {name!r}: {msg}"
        emit({
            "kind": "tool_result",
            "tool": "create_mcp",
            "summary": f"updated {name} in ~/.coder/mcp.json",
        })
        return (
            f"MCP connector {name!r} saved to ~/.coder/mcp.json (user-level, "
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
            emit({"kind": "tool_result", "tool": "edit_file", "summary": msg})
            return f"ERROR editing {path}: {msg}"
        if "error" in result:
            emit({"kind": "tool_result", "tool": "edit_file", "summary": result["error"]})
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
        return f"Successfully edited {path} ({occ} occurrence{'s' if occ != 1 else ''} replaced)."

    async def list_files_tool(path: str = "") -> str:
        emit({"kind": "tool", "tool": "list_files", "args": {"path": path}})
        try:
            result = list_files(root, path)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit({"kind": "tool_result", "tool": "list_files", "summary": msg})
            return f"ERROR listing {path}: {msg}"
        if "error" in result:
            emit({"kind": "tool_result", "tool": "list_files", "summary": result["error"]})
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
        emit({
            "kind": "tool",
            "tool": "search_in_files",
            "args": {"query": query, "path": path, "context": context},
        })
        try:
            result = search_in_files(root, query, path, context)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit({"kind": "tool_result", "tool": "search_in_files", "summary": msg})
            return f"ERROR searching {path}: {msg}"
        if result.get("error"):
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "search_in_files", "summary": msg})
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
            emit({"kind": "tool_result", "tool": "run_terminal", "summary": msg})
            return f"ERROR running {command!r}: {msg}"
        output = result["output"].strip()
        if len(output) > terminal_out_chars:
            output = output[:terminal_out_chars] + "\n…(output truncated to fit context)"
        summary = f"exit {result['exit_code']} · {len(output)} chars"
        emit({"kind": "tool_result", "tool": "run_terminal", "summary": summary})
        if not output:
            return f"$ {command}\n(no output, exit code {result['exit_code']})"
        return f"$ {command}\n{output}"

    async def fuzzy_find_tool(query: str, path: str = "") -> str:
        emit({"kind": "tool", "tool": "fuzzy_find", "args": {"query": query, "path": path}})
        try:
            result = fuzzy_find_files(root, query, path)
        except PathEscapeError as exc:
            msg = f"invalid path: {exc}"
            emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": msg})
            return f"ERROR finding {query!r} under {path or '/'}: {msg}"
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": msg})
            return f"ERROR finding {query!r} under {path or '/'}: {msg}"
        matches = result.get("matches", [])
        if not matches:
            emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": "no matches"})
            return f"No files match {query!r} under {path or '/'}."
        lines = [m["path"] for m in matches[:50]]
        note = f"\n({len(matches)} matches shown)" if len(matches) > 50 else ""
        emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": f"{len(matches)} matches"})
        return f"FUZZY MATCHES for {query!r}\n" + "\n".join(lines) + note

    async def explore_tool(task: str) -> str:
        """Delegate a broad, read-only investigation to an ISOLATED sub-agent, Claude-Code/opencode style. Use this instead of a long chain of your own list_files/search_in_files/fuzzy_find calls when a question is spread across MANY files or an area you don't know well yet — e.g. 'find where the header layout is defined and how the model badge's state flows into it', or 'find every place that reads or writes chat.mode and how they relate'. The sub-agent runs its OWN search loop in its OWN isolated context: none of ITS intermediate list_files/search_in_files calls or their raw output land in YOUR context — only the short written report below does. This is what actually keeps context usage low on big investigations (a wasted or repeated search inside the sub-agent costs IT context, not you). Pass a clear, SPECIFIC `task` describing exactly what to find and why — the sub-agent has no memory of this conversation, so include any details it needs (e.g. relevant file names or symbols you already know). Do NOT use this for a single file or a location you already know — call search_in_files yourself, it's cheaper for a narrow lookup. The sub-agent has a bounded step budget and may report back partial results if the task was too broad — if that happens, split it into smaller `explore` calls."""
        emit({"kind": "tool", "tool": "explore", "args": {"task": task}})
        if summarizer_model is None:
            emit({"kind": "tool_result", "tool": "explore", "summary": "unavailable"})
            return "ERROR: explore is unavailable (no model configured for this session)."

        def _sub_emit(event: dict) -> None:
            # Forward to the same UI stream (so the user sees live sub-agent
            # activity) but tagged `sub=True` so the PARENT's deterministic
            # tool-step budget (see agents.py) does not count these steps —
            # they never enter the parent model's own resent transcript, only
            # the sub-agent's, which is discarded once explore_tool returns.
            event = dict(event)
            event["sub"] = True
            emit(event)

        async def _sub_list_files(path: str = "") -> str:
            _sub_emit({"kind": "tool", "tool": "list_files", "args": {"path": path}})
            try:
                result = list_files(root, path)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                _sub_emit({"kind": "tool_result", "tool": "list_files", "summary": msg})
                return f"ERROR listing {path}: {msg}"
            if "error" in result:
                _sub_emit({"kind": "tool_result", "tool": "list_files", "summary": result["error"]})
                return f"ERROR listing {path}: {result['error']}"
            lines = []
            for entry in result["entries"][:listing_count]:
                marker = "/" if entry["kind"] == "dir" else "  "
                lines.append(f"{marker}{entry['name']}")
            if len(result["entries"]) > listing_count:
                lines.append(f"…({len(result['entries']) - listing_count} more entries)")
            body = "\n".join(lines) if lines else "(empty directory)"
            _sub_emit({"kind": "tool_result", "tool": "list_files", "summary": f"{len(result['entries'])} entries"})
            return f"DIRECTORY {path or '/'}\n{body}"

        async def _sub_search(query: str, path: str = "", context: int = 0) -> str:
            _sub_emit({"kind": "tool", "tool": "search_in_files", "args": {"query": query, "path": path, "context": context}})
            try:
                result = search_in_files(root, query, path, context)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                _sub_emit({"kind": "tool_result", "tool": "search_in_files", "summary": msg})
                return f"ERROR searching {path}: {msg}"
            if result.get("error"):
                msg = result["error"]
                _sub_emit({"kind": "tool_result", "tool": "search_in_files", "summary": msg})
                return f"ERROR searching {path}: {msg}"
            matches = result.get("matches", [])
            if not matches:
                _sub_emit({"kind": "tool_result", "tool": "search_in_files", "summary": "no matches"})
                return f"No matches for {query!r} under {path or '/'}."
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
            note = f"\n({len(matches)} matches found, {shown} shown)" if len(matches) > shown else ""
            _sub_emit({"kind": "tool_result", "tool": "search_in_files", "summary": f"{len(matches)} matches"})
            return f"MATCHES for {query!r}\n" + "\n".join(lines) + note

        async def _sub_fuzzy_find(query: str, path: str = "") -> str:
            _sub_emit({"kind": "tool", "tool": "fuzzy_find", "args": {"query": query, "path": path}})
            try:
                result = fuzzy_find_files(root, query, path)
            except PathEscapeError as exc:
                msg = f"invalid path: {exc}"
                _sub_emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": msg})
                return f"ERROR finding {query!r} under {path or '/'}: {msg}"
            matches = result.get("matches", [])
            if not matches:
                _sub_emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": "no matches"})
                return f"No files match {query!r} under {path or '/'}."
            lines = [m["path"] for m in matches[:50]]
            _sub_emit({"kind": "tool_result", "tool": "fuzzy_find", "summary": f"{len(matches)} matches"})
            return f"FUZZY MATCHES for {query!r}\n" + "\n".join(lines)

        try:
            from httpx import Timeout as _Timeout
            from pydantic_ai import Agent as _Agent
            from pydantic_ai import Tool as _Tool
            from pydantic_ai.exceptions import UsageLimitExceeded as _UsageLimitExceeded
            from pydantic_ai.settings import ModelSettings as _ModelSettings
            from pydantic_ai.usage import UsageLimits as _UsageLimits

            sub_agent = _Agent(
                summarizer_model,
                system_prompt=(
                    "You are a read-only exploration sub-agent working inside a desktop IDE's project "
                    "workspace. You have NO memory of any other conversation — the TASK below is your "
                    "entire context. Investigate it using list_files, search_in_files and fuzzy_find. Be "
                    "efficient: combine related searches with regex alternation (foo|bar|baz) instead of "
                    "separate calls, pass a generous `context` (5-10) on your first search of an area "
                    "instead of a low-context search followed by a wider one on the same spot, and never "
                    "repeat a search with only a minor keyword variation over the same area. Stop as soon "
                    "as you have enough to answer. When done, reply with a CONCISE report (under ~300 "
                    "words): the exact file paths and line numbers relevant to the task, short code "
                    "excerpts only where they materially help, and a direct answer to what was asked. Do "
                    "not pad with commentary or restate the task."
                ),
                tools=[
                    _Tool(_sub_list_files, name="list_files"),
                    _Tool(_sub_search, name="search_in_files"),
                    _Tool(_sub_fuzzy_find, name="fuzzy_find"),
                ],
                model_settings=_ModelSettings(temperature=0.2, max_tokens=1200),
            )
            res = await sub_agent.run(
                task,
                usage_limits=_UsageLimits(request_limit=16, tool_calls_limit=30),
                model_settings=_ModelSettings(timeout=_Timeout(150, connect=15, read=150)),
            )
            report = str(getattr(res, "output", "") or "").strip()
        except _UsageLimitExceeded:
            emit({"kind": "tool_result", "tool": "explore", "summary": "step budget exceeded"})
            return (
                f"EXPLORE for {task!r} did not finish within its step budget — the task was likely too "
                "broad. Split it into smaller, more specific explore calls, or investigate the remaining "
                "part yourself with search_in_files."
            )
        except Exception as exc:  # noqa: BLE001
            emit({"kind": "tool_result", "tool": "explore", "summary": f"failed: {exc}"})
            return f"ERROR: explore sub-agent failed: {exc}"
        if not report:
            emit({"kind": "tool_result", "tool": "explore", "summary": "no report"})
            return f"The exploration sub-agent found nothing usable for {task!r}."
        emit({"kind": "tool_result", "tool": "explore", "summary": f"{len(report)} chars"})
        return f"EXPLORE REPORT for {task!r}\n{report}"

    async def web_search_tool(query: str, max_results: int = 5) -> str:
        emit({"kind": "tool", "tool": "web_search", "args": {"query": query}})
        result = await asyncio.to_thread(web_search, query, max_results)
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "web_search", "summary": msg})
            return f"WEB SEARCH ERROR for {query!r}: {msg}"
        results = result.get("results", [])
        if not results:
            emit({"kind": "tool_result", "tool": "web_search", "summary": "no results"})
            return f"No web results for {query!r}."
        lines = []
        for r in results:
            snippet = r["snippet"]
            if len(snippet) > WEB_SEARCH_SNIPPET_MAX:
                snippet = snippet[:WEB_SEARCH_SNIPPET_MAX] + " …"
            lines.append(f"- {r['title']}\n  {r['url']}\n  {snippet}")
        emit({"kind": "tool_result", "tool": "web_search", "summary": f"{len(results)} results"})
        return f"WEB RESULTS for {query!r}\n" + "\n".join(lines)

    async def fetch_url_tool(url: str, question: str = "") -> str:
        emit({"kind": "tool", "tool": "fetch_url", "args": {"url": url}})
        result = await asyncio.to_thread(fetch_url, url)
        if "error" in result:
            msg = result["error"]
            emit({"kind": "tool_result", "tool": "fetch_url", "summary": msg})
            return f"ERROR fetching {url}: {msg}"
        body = result.get("content", "")
        title = result.get("title", "")
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
        if summarizer_model is not None:
            try:
                from httpx import Timeout
                from pydantic_ai import Agent
                from pydantic_ai.settings import ModelSettings

                summarizer = Agent(
                    summarizer_model,
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
                res = await summarizer.run(
                    f"QUESTION: {_prompt}\n\nPAGE TEXT:\n{body}",
                    model_settings=ModelSettings(
                        timeout=Timeout(90, connect=15, read=90)
                    ),
                )
                answer = str(getattr(res, "output", "") or "").strip()
            except Exception:  # noqa: BLE001
                answer = ""  # summarizer failed; fall through to excerpt

        head = f"PAGE {url}\n" + (f"TITLE: {title}\n" if title else "")
        if answer:
            return head + "SUMMARY:\n" + answer
        # Fallback: no summarizer (or it failed) — return a bounded excerpt that
        # respects the shared context budget so it can never overflow the window.
        if len(body) > tool_out_chars:
            body = body[:tool_out_chars] + "\n…(output truncated to fit context)"
        return head + body

    async def request_permission_tool(action: str, path: str = "", reason: str = "") -> str:
        """Request the user's permission to read, search or act OUTSIDE the current workspace root. BEFORE touching anything outside the project folder (e.g. ~/.config, /Users/..., $HOME files, system paths), call this and WAIT for the result. (Reading the user-level `~/.coder` config dir — skills, plans, MCP config — is ALWAYS allowed and needs NO permission; do not call this for that.) If it returns PERMISSION GRANTED you may proceed with that outside action; if PERMISSION DENIED you MUST NOT access it — instead explain to the user what you needed and why, and continue with what is possible inside the workspace. `action` is a short phrase like 'read config', 'run command', 'inspect file'."""
        # Paths under the always-readable ~/.coder config dir never need a
        # permission prompt — grant silently with no UI card at all.
        if path:
            try:
                target = resolve_safe(root, path, allow_coder=True)
                coder = os.path.realpath(user_coder_dir())
                if target == coder or target.startswith(coder + os.sep):
                    return (
                        f"PERMISSION GRANTED for {path!r}. This is inside the always-readable "
                        f"~/.coder config dir — no permission is needed, you may proceed."
                    )
            except PathEscapeError:
                pass
        emit({"kind": "tool", "tool": "request_permission", "args": {"action": action, "path": path}})
        if permission_gates is None:
            emit({"kind": "tool_result", "tool": "request_permission", "summary": "permission system unavailable"})
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
        """Ask the user to confirm before an IMPORTANT or hard-to-reverse action, and WAIT for the result. Use this before things like: deleting or overwriting a file that has real content, force-pushing or rewriting git history (git push --force, git reset --hard, git rebase on shared history), dropping/truncating a database or table, running a destructive shell command (rm -rf, DROP TABLE, a migration that loses data), or any step you cannot cleanly undo. Also use it when you're about to commit to one of two genuinely different approaches and the choice meaningfully affects the outcome — in that case prefer ask_user instead if there's more than one reasonable option to present. `action` is a short, specific description of exactly what you're about to do (e.g. 'delete src/legacy/old-router.ts (312 lines, no longer imported)'); `reason` is a one-line why. If CONFIRMED, proceed. If DENIED, STOP that action, tell the user you stopped, and ask what they'd like instead — do not silently skip it and continue as if nothing happened. Do not call this for routine, easily-reversible edits (normal edit_file/write_file calls) — only for the genuinely risky or one-way ones."""
        emit({"kind": "tool", "tool": "confirm_action", "args": {"action": action}})
        if permission_gates is None:
            emit({"kind": "tool_result", "tool": "confirm_action", "summary": "confirmation system unavailable"})
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
        """Ask the user a question mid-task and WAIT for their answer, instead of guessing or picking silently on their behalf. Use this when you hit a genuine fork with no clearly-correct default — e.g. two reasonable but different implementation approaches, which of several matching files they meant, whether to keep or remove something ambiguous, a missing detail you can't infer from the project. Pass 2-5 short, mutually-exclusive `options` (a few words each) when the question is naturally multiple-choice — the user picks one with a tap. Omit `options` (or pass an empty list) for an open-ended question that needs a free-text answer. Keep `question` to one clear sentence. Do NOT use this for things you can just go find out yourself with a tool, and do not ask more than one question per call — if you have several, ask the most important one first. The returned string is the user's exact answer (the option they picked, or their typed text)."""
        emit({"kind": "tool", "tool": "ask_user", "args": {"question": question, "options": options or []}})
        if ask_gates is None:
            emit({"kind": "tool_result", "tool": "ask_user", "summary": "ask system unavailable"})
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
            emit({"kind": "tool_result", "tool": "ask_user", "summary": "no answer (timed out)"})
            return "The user did not answer in time. Proceed with your best judgment, note the assumption you're making, and mention you can adjust it if wrong."
        emit({"kind": "tool_result", "tool": "ask_user", "summary": f"answered: {answer[:80]}"})
        return f"USER ANSWERED: {answer}"

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
        "explore": explore_tool,
        "save_plan": save_plan_tool,
        "web_search": web_search_tool,
        "fetch_url": fetch_url_tool,
        "run_terminal": terminal_tool,
    }
