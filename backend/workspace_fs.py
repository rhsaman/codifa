"""Sandboxed path resolution and workspace-scoped resources.

Extracted from the old ``tools.py`` agent registry (now dead — the agent
engine lives in Rust) so that the sidecar's remaining helpers no longer drag
``langchain_core`` into the dependency tree.

Only pure-stdlib and local ``state_db``/``vector_store`` imports live here:
this module must stay importable without any LLM framework installed.
"""

from __future__ import annotations

import os
import tempfile

import state_db as _state_db
from vector_store import StoreConfig, VectorStore, db_path_for

# Name of the sidecar log file inside the data root (``~/.codifa``).
LOG_FILENAME = "sidecar.log"


class PathEscapeError(ValueError):
    """Raised when a path attempts to escape the sandboxed root."""


def _permit_folders(permit: dict | None) -> list[str]:
    """Folders explicitly permitted outside the root (realpath'd) from permit.

    ``permit["folders"]`` is the list of folders the user granted; a truthy
    ``permit["outside"]`` is the legacy "always allow" flag and clears the
    list (in that mode every path is permitted, handled by the caller).
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
    """Is ``target`` (realpath'd) inside one of ``folders``?"""
    for f in folders:
        if target == f or target.startswith(f + os.sep):
            return True
    return False


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
