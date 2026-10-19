#!/usr/bin/env python3
"""Attribute RSS to the RUNNING dev build of Codifa.

The dev app (`target/debug/codifa`) is the only build that carries the memory
fixes, so this is the honest honeypot: it reports the Rust shell and the WebKit
renderer window it owns.

Why `etime` and not the process tree: macOS REPARENTS WebKit helpers to launchd
(pid 1), so a helper's parent says nothing about which app it belongs to. The
elapsed time does — a window's renderer starts seconds after its shell. Helpers
are therefore paired with the dev shell whose start time they follow.

Read-only. Run while `npm run tauri dev` is up.
"""

import os
import subprocess
import time

DEV_MARK = "target/debug/codifa"
REL_MARK = "Codifa.app"


def rows():
    """(pid, ppid, rss_kb, etime_seconds, command) for every process."""
    out = subprocess.run(
        ["ps", "-axo", "pid,ppid,rss,etime,command"],
        capture_output=True, text=True, check=False,
    ).stdout.splitlines()[1:]
    parsed = []
    for line in out:
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, etime, cmd = parts
        try:
            parsed.append((int(pid), int(ppid), int(rss), parse_etime(etime), cmd))
        except ValueError:
            continue
    return parsed


def parse_etime(text):
    """`[[dd-]hh:]mm:ss` -> seconds."""
    days = 0
    if "-" in text:
        d, text = text.split("-", 1)
        days = int(d)
    bits = [int(b) for b in text.split(":")]
    while len(bits) < 3:
        bits.insert(0, 0)
    h, m, s = bits[-3], bits[-2], bits[-1]
    return days * 86400 + h * 3600 + m * 60 + s


def mb(kb):
    return kb / 1024.0


def main():
    all_rows = rows()
    dev_shells = [r for r in all_rows if DEV_MARK in r[4]]
    rel_shells = [r for r in all_rows if REL_MARK in r[4]]
    webkit = [r for r in all_rows if "WebContent" in r[4]]

    print("=" * 74)
    print("Codifa live memory attribution")
    print("=" * 74)

    for label, shells in (("DEV build (carries the fixes)", dev_shells),
                          ("RELEASE build (old binary)", rel_shells)):
        print(f"\n-- {label} --")
        total = 0
        if not shells:
            print("  (not running)")
            continue
        earliest = min(r[3] for r in shells)
        for pid, _ppid, rss, etime, _cmd in shells:
            total += rss
            print(f"  Rust shell     {mb(rss):8.1f} MB   pid {pid:<7} up {etime/60:.1f} min")
        # Renderer attribution: a WebKit helper's cmdline never names the app,
        # so the only signal is start order. `etime` counts UP from start, so a
        # helper spawned by this shell has an etime slightly SMALLER than the
        # shell's (it started later). Anything started within an hour after the
        # shell and not older than it belongs to this app.
        owned = [
            h for h in webkit
            if h[3] < earliest + 5 and h[3] > earliest - 3600
        ]
        for pid, _ppid, rss, etime, _cmd in owned:
            total += rss
            print(f"  WebContent     {mb(rss):8.1f} MB   pid {pid:<7} up {etime/60:.1f} min")
        if not owned:
            print("  WebContent     (none — window may not have opened yet)")
        print(f"  {'TOTAL':<14} {mb(total):8.1f} MB")

    print("\n-- every WebKit helper on the machine --")
    for pid, _ppid, rss, etime, _cmd in sorted(webkit, key=lambda r: -r[2]):
        print(f"  pid {pid:<7} {mb(rss):8.1f} MB   up {etime/60:6.1f} min")

    root = os.path.expanduser("~/.codifa")
    print("\n-- data root --")
    if os.path.isdir(root):
        now = time.time()
        for sub in ("traces", "checkpoints", "uploads"):
            d = os.path.join(root, sub)
            if not os.path.isdir(d):
                continue
            total = files = stale = 0
            ttl_days = 30 if sub == "uploads" else 14
            for dirpath, _dirs, names in os.walk(d):
                for n in names:
                    p = os.path.join(dirpath, n)
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    total += st.st_size
                    files += 1
                    if (now - st.st_mtime) / 86400 > ttl_days:
                        stale += 1
            print(
                f"  {sub:<12} {total/1024/1024:8.1f} MB  {files:5d} files"
                f"  {stale:4d} past TTL({ttl_days}d)"
            )
        sj = os.path.join(root, "settings.json")
        if os.path.isfile(sj):
            print(f"  {'settings.json':<12} {os.path.getsize(sj)/1024/1024:8.2f} MB  (index only)")


if __name__ == "__main__":
    main()
