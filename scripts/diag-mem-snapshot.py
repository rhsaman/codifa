#!/usr/bin/env python3
"""One-shot memory + disk snapshot for the Codifa memory work.

Prints, without touching anything:
  * RSS of every process that belongs to Codifa (shells, WebKit renderers,
    LSP/MCP children, sidecar python) grouped by owner;
  * on-disk sizes of the data root (settings.json, chats bodies, traces,
    checkpoints, uploads) plus the largest chat body files.

Read-only. Handy while iterating on the memory fix.
"""

import os
import re
import subprocess
import time

DATA_ROOT = os.path.expanduser("~/.codifa")

MB = 1024.0


def ps_rows():
    out = subprocess.run(
        ["ps", "-axo", "pid,rss,etime,command"],
        capture_output=True, text=True, check=False,
    ).stdout.splitlines()[1:]
    rows = []
    for line in out:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, rss, etime, cmd = parts
        try:
            rows.append((int(pid), int(rss), etime, cmd))
        except ValueError:
            continue
    return rows


def human_kb(kb):
    return f"{kb / MB:8.1f} MB"


def du_kb(path):
    """Total bytes under `path` (file count), like `du -sk`."""
    total = 0
    files = 0
    if os.path.isfile(path):
        try:
            return os.path.getsize(path), 1
        except OSError:
            return 0, 0
    for dirpath, _dirs, names in os.walk(path):
        for n in names:
            try:
                total += os.path.getsize(os.path.join(dirpath, n))
                files += 1
            except OSError:
                pass
    return total, files


def main():
    rows = ps_rows()

    groups = {
        "Rust shell (release)": "release/bundle/macos/Codifa.app",
        "Rust shell (debug/dev)": "target/debug/codifa",
        "WebKit renderer": "com.apple.WebKit.WebContent",
        "WebKit GPU": "com.apple.WebKit.GPU",
        "rust-analyzer": "rust-analyzer",
        "TypeScript LSP": "typescript-language-server",
        "python sidecar": "python",
        "vite": "vite",
    }

    print("=" * 78)
    print("Codifa memory snapshot  " + time.strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 78)

    app_total = 0
    for label, mark in groups.items():
        hits = [r for r in rows if mark in r[3]]
        if not hits:
            continue
        print(f"\n-- {label} --")
        sub = 0
        for pid, rss, etime, cmd in sorted(hits, key=lambda r: -r[1])[:12]:
            sub += rss
            short = cmd if len(cmd) <= 70 else "…" + cmd[-69:]
            print(f"  pid {pid:<7} {human_kb(rss)}  up {etime:>9}  {short}")
        print(f"  {'subtotal':<11} {human_kb(sub)}  ({len(hits)} procs)")
        if label.startswith(("Rust shell", "WebKit")):
            app_total += sub

    print(f"\n>>> APP TOTAL (shells + WebKit): {human_kb(app_total)}")

    print("\n-- data root --")
    for name in ("settings.json", "chats", "traces", "checkpoints", "uploads"):
        p = os.path.join(DATA_ROOT, name)
        if not os.path.exists(p):
            print(f"  {name:<16} (missing)")
            continue
        size, files = du_kb(p)
        print(f"  {name:<16} {size / MB / 1024:8.2f} MB   {files} files")

    chats = os.path.join(DATA_ROOT, "chats")
    biggest = []
    for dirpath, _dirs, names in os.walk(chats):
        for n in names:
            if n.endswith(".json"):
                p = os.path.join(dirpath, n)
                try:
                    biggest.append((os.path.getsize(p), p))
                except OSError:
                    pass
    biggest.sort(reverse=True)
    if biggest:
        print(f"\n-- largest chat bodies (of {len(biggest)}) --")
        for size, p in biggest[:10]:
            print(f"  {size / MB / 1024:8.2f} MB   {os.path.relpath(p, DATA_ROOT)}")


if __name__ == "__main__":
    main()
