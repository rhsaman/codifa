#!/usr/bin/env python3
"""Measure the REAL memory of a running Codifa instance, the way Activity
Monitor reports it.

Activity Monitor's "Memory" column is the *physical footprint* (dirty +
compressed page count) of a process, and it attributes every CHILD process of
the app to the app. RSS alone is therefore misleading in both directions: it
misses compressed pages (a 1.4 GB rust-analyzer showed 6.7 MB RSS once it was
paged out) and it misses the whole child tree (language servers, tsserver).

Two counting rules matter, and both were wrong in an earlier version of this
script:

  * Every pid is counted EXACTLY ONCE. The WebKit content process is often
    re-parented to launchd but can appear under the shell in some macOS
    versions, so a `renderer` pid found both ways used to be added twice.
  * A descendant is bucketed by WHAT IT IS, never folded into `app shell`.
    Folding every `codifa`-named descendant into the shell bucket reported
    ~7x the shell's real footprint.

Usage:
    python3 scripts/mem-report.py [pid ...]
With no pid, every running `codifa` shell is reported.
"""

from __future__ import annotations

import datetime
import re
import subprocess
import sys

VMMAP_TIMEOUT = 300


def all_processes() -> dict[int, tuple[int, float, str, str]]:
    """pid -> (ppid, rss_mb, etime, comm)."""
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
    """Physical footprint in MB, or None when vmmap cannot read the task.

    A busy process can report a bare `0` (no unit), which must be read as zero
    rather than skipped — skipping it would silently drop the process from the
    total.
    """
    try:
        out = subprocess.run(
            ["vmmap", "--summary", str(pid)],
            capture_output=True,
            text=True,
            timeout=VMMAP_TIMEOUT,
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if line.startswith("Physical footprint:"):
            m = re.search(r"([\d.]+)\s*([KMG])", line)
            if not m:
                # No size at all (all zeros) — a valid zero, not a failure.
                if re.search(r"Physical footprint:\s*0", line):
                    return 0.0
                return None
            value = float(m.group(1))
            unit = m.group(2)
            if unit == "G":
                return value * 1024
            if unit == "K":
                return value / 1024
            return value
    return None


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
    try:
        return datetime.datetime.strptime(out, "%a %b %d %H:%M:%S %Y").timestamp()
    except ValueError:
        return None


def renderer_pid(shell_pid: int, procs: dict[int, tuple]) -> int | None:
    """The WebKit content process for this app instance.

    macOS may re-parent it to launchd, so it cannot always be found by walking
    the tree. It is identified by launch order instead: the renderer is created
    within a few seconds of its shell. Ties are broken by the closest start
    time, which is what pairs one renderer with its own shell when two Codifa
    instances are running.
    """
    shell_start = _start_epoch(shell_pid)
    if shell_start is None:
        return None
    best: tuple[float, int] | None = None
    for pid, (_ppid, _rss, _etime, comm) in procs.items():
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


def descendants(root: int, procs: dict[int, tuple]) -> list[int]:
    out: list[int] = []
    stack = [root]
    seen = {root}
    while stack:
        cur = stack.pop()
        for pid, (ppid, *_rest) in procs.items():
            if ppid == cur and pid not in seen:
                seen.add(pid)
                out.append(pid)
                stack.append(pid)
    return out


def category(comm: str) -> str:
    low = comm.lower()
    if "rust-analyzer" in low and "proc-macro" in low:
        return "rust-analyzer proc-macro"
    if "rust-analyzer" in low:
        return "rust-analyzer"
    if "ms-playwright" in low or "chrome-headless-shell" in low or "chromium" in low:
        return "chromium (browser tool)"
    if "tsserver" in low or "typescript-language-server" in low or "typingsinstaller" in low:
        return "typescript LSP"
    if "pylsp" in low:
        return "python LSP"
    if "WebContent" in comm:
        return "renderer"
    if "codifa" in low:
        # NOT "app shell": a descendant is a helper, and folding it into the
        # shell bucket is what once reported ~7x the shell's real footprint.
        return "codifa helper"
    if comm.endswith("node"):
        return "node (other)"
    return "other child"


def report(shell_pid: int, procs: dict[int, tuple]) -> float:
    renderer = renderer_pid(shell_pid, procs)
    print(f"\n=== Codifa instance (shell pid {shell_pid}) ===")
    buckets: dict[str, list[tuple[int, float]]] = {}
    counted: set[int] = set()

    def add(pid: int, cat: str) -> None:
        # Every pid exactly once, whatever path reached it.
        if pid in counted:
            return
        counted.add(pid)
        fp = footprint_mb(pid)
        if fp is None:
            return
        buckets.setdefault(cat, []).append((pid, fp))

    add(shell_pid, "app shell")
    for pid in descendants(shell_pid, procs):
        add(pid, category(procs[pid][3]))
    if renderer is not None:
        add(renderer, "renderer")

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
        # Only real app shells: a `codifa` helper or a `sh -c ... codifa` wrapper
        # is not a shell, and reporting one would double the whole subtree.
        targets = [
            pid
            for pid, (_ppid, _rss, _etime, comm) in procs.items()
            if comm.endswith("/codifa") or comm == "codifa"
        ]
    if not targets:
        print("no codifa instance is running")
        return
    grand = 0.0
    for pid in sorted(targets):
        grand += report(pid, procs)
    print(f"\nGRAND TOTAL: {grand:.1f} MB")


if __name__ == "__main__":
    main()
