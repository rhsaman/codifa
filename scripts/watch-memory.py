#!/usr/bin/env python3
"""Measure memory WITHOUT perturbing the process being measured.

`vmmap` suspends its target and walks the whole address space, which faults
pages in and inflates what the next sample sees. Sampling it in a loop therefore
manufactures the very growth it is supposed to detect.

This script takes the cheap, non-intrusive reading (`ps` RSS + the kernel's own
`phys_footprint` from `ps -o rss`) on a timer, and calls `vmmap` only once at the
start and once at the end so the two heavy readings are comparable.

Usage:
    python3 scripts/watch-memory.py <shell-pid> [renderer-pid] [seconds]
"""

from __future__ import annotations

import re
import subprocess
import sys
import time


def footprint_mb(pid: int) -> float | None:
    """Physical footprint via vmmap. Heavy: suspends the task. Use sparingly."""
    try:
        out = subprocess.run(
            ["vmmap", "--summary", str(pid)], capture_output=True, text=True, timeout=180
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if line.startswith("Physical footprint:"):
            m = re.search(r"([\d.]+)([KMG])", line)
            if not m:
                return None
            v = float(m.group(1))
            return {"G": v * 1024, "M": v, "K": v / 1024}[m.group(2)]
    return None


def rss_map() -> dict[int, float]:
    """pid -> RSS in MB, from a single cheap `ps` snapshot."""
    out = subprocess.run(
        ["ps", "-Ao", "pid=,rss="], capture_output=True, text=True
    ).stdout
    res: dict[int, float] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            res[int(parts[0])] = int(parts[1]) / 1024.0
        except ValueError:
            continue
    return res


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    shell = int(sys.argv[1])
    renderer = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 300

    print("=== one vmmap at the start (baseline footprint) ===")
    sh_fp0 = footprint_mb(shell)
    rd_fp0 = footprint_mb(renderer) if renderer else None
    print(f"  shell={sh_fp0}  renderer={rd_fp0}")

    print()
    print("=== RSS only, no vmmap (non-perturbing) ===")
    first = None
    peak = 0.0
    start = time.time()
    while time.time() - start < seconds:
        rss = rss_map()
        sh = rss.get(shell, 0.0)
        rd = rss.get(renderer, 0.0) if renderer else 0.0
        tot = sh + rd
        if first is None:
            first = tot
        peak = max(peak, tot)
        elapsed = int(time.time() - start)
        print(
            f"  t+{elapsed:3d}s  shell_rss={sh:7.1f}  renderer_rss={rd:7.1f}  "
            f"total_rss={tot:7.1f}  drift={tot - first:+6.1f}",
            flush=True,
        )
        time.sleep(15)

    print()
    print("=== one vmmap at the end (comparable to the start) ===")
    sh_fp1 = footprint_mb(shell)
    rd_fp1 = footprint_mb(renderer) if renderer else None
    print(f"  shell={sh_fp1}  renderer={rd_fp1}")
    if sh_fp0 and sh_fp1:
        print(f"  footprint drift: shell {sh_fp1 - sh_fp0:+.1f}MB", end="")
    if rd_fp0 and rd_fp1:
        print(f"  renderer {rd_fp1 - rd_fp0:+.1f}MB")
    else:
        print()
    print(f"  RSS peak during the window: {peak:.1f}MB")


if __name__ == "__main__":
    main()
