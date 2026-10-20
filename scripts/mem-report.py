#!/usr/bin/env python3
"""Measure the REAL memory of a running Codifa instance, the way Activity
Monitor reports it.

Activity Monitor's "Memory" column is the *physical footprint* (dirty +
compressed page count) of a process, and it attributes every CHILD process of
the app to the app. RSS alone is therefore misleading in both directions: it
misses compressed pages (a 1.4 GB rust-analyzer showed 6.7 MB RSS once it was
paged out) and it misses the whole child tree (language servers, the shared
Chromium, tsserver).

This script walks the process tree from the app shell, adds the physical
footprint of the shell, every descendant, and the WebKit renderer that macOS
does NOT parent to the app (it is reparented to launchd), then prints a
per-category breakdown plus the total that Activity Monitor would show.

Usage:
    python3 scripts/mem-report.py [pid]
With no pid, every running `codifa` shell is reported.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys


def all_processes() -> dict[int, tuple[int, float, str, str]]:
    """pid -> (ppid, rss_mb, etime, command)."""
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,rss=,etime=,comm="],
        capture_output=True,
        text=True,
    ).stdout
    procs: dict[int, tuple[int, float, str, str]] = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, etime, comm = parts
        try:
            procs[int(pid)] = (int(ppid), int(rss) / 1024.0, etime, comm)
        except ValueError:
            continue
    return procs


def footprint_mb(pid: int) -> float | None:
    """Physical footprint in MB, or None when vmmap cannot read the task."""
    try:
        out = subprocess.run(
            ["vmmap", "--summary", str(pid)],
            capture_output=True,
            text=True,
            timeout=120,
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if line.startswith("Physical footprint:"):
            m = re.search(r"([\d.]+)([KMG])", line)
            if not m:
                return None
            value = float(m.group(1))
            unit = m.group(2)
            if unit == "G":
                return value * 1024
            if unit == "K":
                return value / 1024
            return value
    return None


def renderer_pid(shell_pid: int, procs: dict[int, tuple]) -> int | None:
    """The WebKit content process for this app instance.

    macOS reparents it to launchd, so it cannot be found by walking the tree.
    It is identified by launch order instead: the renderer is created within a
    few seconds of its shell.
    """
    shell_start = _start_epoch(shell_pid)
    if shell_start is None:
        return None
    best = None
    for pid, (ppid, _rss, _etime, comm) in procs.items():
        if "WebKit.WebContent" not in comm:
            continue
        start = _start_epoch(pid)
        if start is None:
            continue
        delta = start - shell_start
        if -2 <= delta <= 10:
            if best is None or abs(delta) < abs(best[0]):
                best = (delta, pid)
    return best[1] if best else None


def _start_epoch(pid: int) -> float | None:
    try:
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
        ).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    import datetime

    try:
        return datetime.datetime.strptime(out, "%a %b %d %H:%M:%S %Y").timestamp()
    except ValueError:
        return None


def descendants(root: int, procs: dict[int, tuple]) -> list[int]:
    out: list[int] = []
    stack = [root]
    while stack:
        cur = stack.pop()
        for pid, (ppid, *_rest) in procs.items():
            if ppid == cur and pid != cur:
                out.append(pid)
                stack.append(pid)
    return out


def category(comm: str) -> str:
    low = comm.lower()
    if "rust-analyzer" in low and "proc-macro" in low:
        return "rust-analyzer proc-macro"
    if "rust-analyzer" in low:
        return "rust-analyzer"
    if "ms-playwright" in low or "chrome-headless-shell" in low:
        return "chromium (browser tool)"
    if "tsserver" in low or "typescript-language-server" in low:
        return "typescript LSP"
    if "pylsp" in low:
        return "python LSP"
    if comm.endswith("node"):
        return "node (other)"
    if "WebContent" in comm:
        return "renderer"
    if comm.endswith("codifa"):
        return "app shell"
    return "other child"


def report(shell_pid: int, procs: dict[int, tuple]) -> float:
    renderer = renderer_pid(shell_pid, procs)
    print(f"\n=== Codifa instance (shell pid {shell_pid}) ===")
    buckets: dict[str, list[tuple[int, float]]] = {}
    for pid in [shell_pid] + descendants(shell_pid, procs):
        if pid == shell_pid:
            cat = "app shell"
        else:
            cat = category(procs[pid][3])
        fp = footprint_mb(pid)
        if fp is None:
            continue
        buckets.setdefault(cat, []).append((pid, fp))
    if renderer is not None:
        fp = footprint_mb(renderer)
        if fp is not None:
            buckets.setdefault("renderer", []).append((renderer, fp))
    total = 0.0
    for cat in sorted(buckets, key=lambda c: -sum(v for _, v in buckets[c])):
        entries = buckets[cat]
        sub = sum(v for _, v in entries)
        total += sub
        pids = ",".join(str(p) for p, _ in entries)
        print(f"  {cat:<26} {sub:8.1f} MB   ({len(entries)} proc: {pids})")
    print(f"  {'TOTAL (Activity Monitor)':<26} {total:8.1f} MB")
    return total


def main() -> None:
    procs = all_processes()
    if len(sys.argv) > 1:
        targets = [int(a) for a in sys.argv[1:]]
    else:
        targets = [
            pid
            for pid, (ppid, _rss, _etime, comm) in procs.items()
            if comm.endswith("codifa") or "/codifa" in comm
        ]
        targets = [p for p in targets if "_" not in procs[p][3].split("/")[-1]]
    if not targets:
        print("no codifa instance is running")
        return
    grand = 0.0
    for pid in sorted(targets):
        grand += report(pid, procs)
    print(f"\nGRAND TOTAL: {grand:.1f} MB")


if __name__ == "__main__":
    main()
