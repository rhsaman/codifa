#!/usr/bin/env python3
"""Correlate the renderer's graphics-region count with mounted message counts.

Hypothesis under test: the renderer's `owned unmapped (graphics)` regions are
proportional to the number of MESSAGES mounted in the DOM, not to the viewport.
If the region count tracks the largest chat's message count, then anything that
bounds the mounted window (or the per-message paint containment) is the lever.

Usage:
    python3 scripts/graphics-vs-messages.py [shell_pid]
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def renderer_pid(shell_pid: int) -> int | None:
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,lstart=,comm="], capture_output=True, text=True
    ).stdout
    shell_start = subprocess.run(
        ["ps", "-o", "lstart=", "-p", str(shell_pid)], capture_output=True, text=True
    ).stdout.strip()
    best = None
    for line in out.splitlines():
        if "WebKit.WebContent" not in line:
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        pid, _ppid = int(parts[0]), int(parts[1])
        lstart = " ".join(parts[2:6])
        if lstart == shell_start:
            return pid
        if best is None:
            best = pid
    return best


def graphics_regions(pid: int) -> tuple[int, float, int]:
    """(count, resident_mb, total_region_rows) for owned unmapped (graphics)."""
    out = subprocess.run(
        ["vmmap", "--summary", str(pid)], capture_output=True, text=True, timeout=300
    ).stdout
    total = 0
    for line in out.splitlines():
        if line.startswith("REGION TYPE"):
            break
    for line in out.splitlines():
        m = re.match(
            r"^owned unmapped \(graphics\)\s+(\S+)\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s*$",
            line.strip(),
        )
        if m:
            def mb(tok: str) -> float:
                v = float(tok[:-1])
                u = tok[-1]
                return v * 1024 if u == "G" else (v / 1024 if u == "K" else v)
            return int(m.group(4)), mb(m.group(2)), 0
    return 0, 0.0, 0


def chat_stats() -> tuple[int, int, list[tuple[str, int]]]:
    """(chat_count, total_messages, [(title, messageCount)] desc)."""
    root = os.path.expanduser("~/.codifa")
    doc = json.load(open(os.path.join(root, "settings.json")))
    rows = doc.get("chats") or []
    counts = []
    for r in rows:
        n = r.get("messageCount")
        if isinstance(n, int):
            counts.append((str(r.get("title") or r.get("id")), n))
    counts.sort(key=lambda t: -t[1])
    return len(rows), sum(c for _t, c in counts), counts[:8]


def main() -> int:
    shell = int(sys.argv[1]) if len(sys.argv) > 1 else None
    if shell is None:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,comm="], capture_output=True, text=True
        ).stdout
        for line in out.splitlines():
            if "Codifa.app/Contents/MacOS/codifa" in line:
                shell = int(line.split()[0])
                break
    if shell is None:
        print("no Codifa shell found")
        return 1
    rpid = renderer_pid(shell)
    print(f"shell={shell} renderer={rpid}")
    if rpid:
        count, res, _ = graphics_regions(rpid)
        print(f"  owned unmapped (graphics): {count} regions, {res:.1f} MB resident")
    n_chats, total, top = chat_stats()
    print(f"  chats in index: {n_chats}, messages total: {total}")
    print("  largest chats by messageCount:")
    for title, cnt in top:
        print(f"    {cnt:>5}  {title[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
