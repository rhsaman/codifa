"""Detached dev-server registry for agent-driven live development.

Agents need a generic way to launch a live dev server (vite, next, etc.)
without blocking the terminal or the request loop. This module keeps a
small in-process registry of detached child processes:

* ``start`` spawns a detached process (``start_new_session=True``) with
  stdout/stderr redirected to a log file and records it under ``name``.
* ``stop`` terminates a tracked process.
* ``status`` lists tracked servers and whether each is still running.
* ``sweep_idle`` evicts entries idle for longer than ``IDLE_EVICT_S``.

Ports are always caller-supplied (no hard-coded ports here); log files
live in the OS temp dir (tempfile.gettempdir()), never in codifa logs.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any

# Idle window after which an untouched entry is stopped and dropped.
# Mirrors the embeddings idle-eviction pattern (background resource that
# must not pin memory/processes forever in a long-lived sidecar).
IDLE_EVICT_S = 10 * 60


@dataclass
class _Entry:
    name: str
    command: list[str] | str
    port: int
    cwd: str
    log_path: str
    process: subprocess.Popen[str] | Any
    last_used: float = field(default_factory=time.monotonic)
    log_handle: Any = None


_REGISTRY: dict[str, _Entry] = {}
_LOCK = threading.Lock()


def _log_path(name: str, cwd: str = "") -> str:
    safe = "".join(c if c.isalnum() or c in ("-", "_") else "-" for c in name)
    return os.path.join(tempfile.gettempdir(), f"codifa-dev-{safe}.log")


def _info(entry: _Entry) -> dict[str, Any]:
    try:
        running = entry.process.poll() is None
    except Exception:  # noqa: BLE001 — best-effort status probe
        running = False
    try:
        pid = entry.process.pid
    except Exception:  # noqa: BLE001 — best-effort status probe
        pid = None
    return {
        "name": entry.name,
        "command": entry.command,
        "port": entry.port,
        "cwd": entry.cwd,
        "pid": pid,
        "log_path": entry.log_path,
        "running": running,
    }


def touch(name: str) -> bool:
    """Mark an entry as recently used (resets its idle clock)."""
    with _LOCK:
        entry = _REGISTRY.get(name)
        if entry is None:
            return False
        entry.last_used = time.monotonic()
        return True


def start(
    name: str,
    command: list[str] | str,
    port: int = 0,
    cwd: str | None = None,
    log_file: str | None = None,
) -> dict[str, Any]:
    """Start (or reuse) a detached dev server under ``name``.

    Never blocks: the child is spawned with ``subprocess.Popen`` and this
    function returns immediately with the entry info. Reuses the existing
    entry when its process is still alive (and refreshes its idle clock).
    """
    workdir = cwd or os.getcwd()
    os.makedirs(workdir, exist_ok=True)
    with _LOCK:
        existing = _REGISTRY.get(name)
        if existing is not None:
            try:
                alive = existing.process.poll() is None
            except Exception:  # noqa: BLE001 — best-effort status probe
                alive = False
            if alive:
                existing.last_used = time.monotonic()
                return _info(existing)
            # Stale entry: drop it before respawning.
            _REGISTRY.pop(name, None)
        if log_file:
            # Caller paths are reduced to their basename inside the OS temp
            # dir: logs never land in codifa logs or the workspace.
            log_path = os.path.join(
                tempfile.gettempdir(), os.path.basename(str(log_file))
            )
        else:
            log_path = _log_path(name, workdir)
        handle = open(log_path, "ab")  # noqa: SIM115 — owned by entry, closed on stop
        try:
            if isinstance(command, str):
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    cwd=workdir,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            else:
                proc = subprocess.Popen(
                    list(command),
                    cwd=workdir,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
        except Exception:
            try:
                handle.close()
            except Exception:  # noqa: BLE001, S110 — best-effort cleanup
                pass
            raise
        entry = _Entry(
            name=name,
            command=command,
            port=port,
            cwd=workdir,
            log_path=log_path,
            process=proc,
            last_used=time.monotonic(),
            log_handle=handle,
        )
        _REGISTRY[name] = entry
        return _info(entry)


def stop(name: str, *, grace_s: float = 5.0) -> bool:
    """Stop and remove the entry ``name``. Returns False when unknown."""
    with _LOCK:
        entry = _REGISTRY.pop(name, None)
    if entry is None:
        return False
    proc = entry.process
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=grace_s)
            except Exception:  # noqa: BLE001 — fall through to kill
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001, S110 — already exiting
                    pass
    except Exception:  # noqa: BLE001, S110 — best-effort terminate
        pass
    try:
        if entry.log_handle is not None:
            entry.log_handle.close()
    except Exception:  # noqa: BLE001, S110 — best-effort cleanup
        pass
    return True


def status() -> list[dict[str, Any]]:
    """List all tracked dev servers (does not touch idle clocks)."""
    with _LOCK:
        entries = list(_REGISTRY.values())
    return [_info(e) for e in entries]


def sweep_idle(now: float | None = None) -> list[str]:
    """Stop and drop entries idle for longer than ``IDLE_EVICT_S``.

    ``now`` accepts a fake clock value in tests; defaults to
    ``time.monotonic()``. Returns the evicted names.
    """
    current = now if now is not None else time.monotonic()
    with _LOCK:
        stale = [
            name
            for name, entry in _REGISTRY.items()
            if current - entry.last_used >= IDLE_EVICT_S
        ]
    evicted: list[str] = []
    for name in stale:
        if stop(name):
            evicted.append(name)
    return evicted


def shutdown_all() -> None:
    """Stop every tracked server (best-effort, for process exit)."""
    with _LOCK:
        names = list(_REGISTRY.keys())
    for name in names:
        try:
            stop(name, grace_s=2.0)
        except Exception:  # noqa: BLE001, S112 — shutdown never raises
            continue


def _argv(command: list[str] | str) -> list[str] | str:
    """Split a string command for inspection (shell commands run as-is)."""
    if isinstance(command, str):
        return shlex.split(command)
    return list(command)
