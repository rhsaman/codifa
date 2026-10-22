#!/usr/bin/env python3
"""Report which Codifa instances are running and how stale the build is.

Two things decide whether a memory measurement is meaningful:

* which binary is actually running (a dev build from `target/debug` embeds a
  snapshot of `dist/`, so a source edit newer than the binary is NOT in it), and
* whether any heavyweight sidecar (a language server, the headless browser) is
  attached to it.

Usage:
    python3 scripts/state-check.py
"""

from __future__ import annotations

import os
import subprocess
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Source files whose mtime must not be newer than the binary, or the running
# build is missing those edits.
WATCHED = [
    "dist/index.html",
    "src-tauri/src/retention.rs",
    "src-tauri/src/lsp.rs",
    "src-tauri/src/store.rs",
    "src-tauri/src/browser.rs",
    "src/components/Chat.tsx",
    "src/lib/messageWindow.ts",
    "src/styles/global.css",
]

HEAVY_MARKERS = ("rust-analyzer", "pylsp", "ms-playwright", "chrome-headless-shell")


def processes() -> list[tuple[int, int, float, str]]:
    """(pid, ppid, rss_mb, args) for every process."""
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,rss=,args="], capture_output=True, text=True
    ).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]) / 1024.0, parts[3]))
        except ValueError:
            continue
    return rows


def mtime(rel: str) -> float | None:
    try:
        return os.stat(os.path.join(REPO, rel)).st_mtime
    except OSError:
        return None


def main() -> None:
    rows = processes()

    print("=== running Codifa instances ===")
    shells = [r for r in rows if r[3].endswith("codifa") or "/codifa" in r[3][:60]]
    shells = [r for r in shells if "WebKit" not in r[3] and "scripts/" not in r[3]]
    if not shells:
        print("  none")
    for pid, ppid, rss, args in shells:
        print(f"  pid={pid} ppid={ppid} rss={rss:.1f}MB  {args[:90]}")

    print()
    print("=== renderers (reparented to launchd, attributed by start time) ===")
    for pid, ppid, rss, args in rows:
        if "WebKit.WebContent" in args:
            print(f"  pid={pid} ppid={ppid} rss={rss:.1f}MB")

    print()
    print("=== heavyweight sidecars ===")
    heavy = [r for r in rows if any(m in r[3] for m in HEAVY_MARKERS)]
    if not heavy:
        print("  none")
    for pid, ppid, rss, args in heavy:
        print(f"  pid={pid} ppid={ppid} rss={rss:.1f}MB  {args[:80]}")

    print()
    print("=== build freshness ===")
    binary = mtime("src-tauri/target/debug/codifa")
    if binary is None:
        print("  debug binary MISSING")
        return
    print(f"  debug binary   {time.strftime('%m-%d %H:%M:%S', time.localtime(binary))}")
    stale = []
    for rel in WATCHED:
        t = mtime(rel)
        if t is None:
            print(f"  MISSING        {rel}")
            continue
        flag = "STALE" if t > binary else "ok   "
        if t > binary:
            stale.append(rel)
        print(f"  {flag}          {time.strftime('%m-%d %H:%M:%S', time.localtime(t))}  {rel}")
    print()
    if stale:
        print(f"  => {len(stale)} source file(s) newer than the binary: rebuild before measuring")
    else:
        print("  => binary embeds every current source edit")


if __name__ == "__main__":
    main()
