#!/usr/bin/env python3
"""Live memory + disk attribution for the running Codifa app.

Read-only. Reports:
  * every Codifa-owned process (the Rust shell + the WebKit helpers whose
    ancestry leads back to it), with RSS, so the "4 GB" can be attributed
    instead of guessed;
  * the total RSS of everything Codifa owns;
  * the size and age of checkpoint/trace/upload/browser-profile trees, so the
    retention state is visible.

Run: python3 scripts/diag-live-memory.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


def ps_table() -> list[tuple[int, int, int, str]]:
    out = subprocess.run(
        ["ps", "-axo", "pid,ppid,rss,command"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    rows: list[tuple[int, int, int, str]] = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]), parts[3]))
        except ValueError:
            continue
    return rows


def main() -> int:
    rows = ps_table()
    by_pid = {pid: (ppid, rss, cmd) for pid, ppid, rss, cmd in rows}

    # Roots: any process whose command mentions codifa / Codifa.app.
    roots = [pid for pid, (_, _, cmd) in by_pid.items() if "odifa" in cmd]
    if not roots:
        print("Codifa is not running (no matching process).")
        return 1

    def ancestry(pid: int) -> list[int]:
        chain = [pid]
        seen = set()
        cur = pid
        while cur in by_pid and cur not in seen:
            seen.add(cur)
            cur = by_pid[cur][0]
            if cur > 1:
                chain.append(cur)
        return chain

    owned: set[int] = set(roots)
    # Any process whose ancestor chain reaches a Codifa root is Codifa's
    # (that is how the WebKit helper XPC services are attributed).
    for pid in by_pid:
        if pid in owned:
            continue
        if any(a in owned for a in ancestry(pid)):
            owned.add(pid)

    print("Codifa-owned processes (RSS):")
    total = 0
    for pid in sorted(owned, key=lambda p: -by_pid[p][1]):
        _, rss, cmd = by_pid[pid]
        total += rss
        short = cmd if len(cmd) <= 78 else "…" + cmd[-75:]
        print(f"  {rss/1024:8.1f} MB  pid {pid:<7} {short}")
    print(f"  {'-' * 60}")
    print(f"  {total/1024:8.1f} MB  TOTAL (Codifa + its WebKit helpers)")

    root = Path(os.environ.get("CODER_DATA_DIR") or (Path.home() / ".codifa"))
    now = time.time()
    print()
    print(f"on-disk trees under {root}:")
    if root.is_dir():
        for name in ("settings.json", "chats", "checkpoints", "traces", "uploads", "browser-profile"):
            target = root / name
            if not target.exists():
                continue
            if target.is_file():
                print(f"  {target.stat().st_size/1024/1024:9.1f} MB  {name}")
                continue
            size = 0
            newest = 0.0
            oldest = now
            for dirpath, _dirnames, filenames in os.walk(target):
                for fn in filenames:
                    p = Path(dirpath) / fn
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    size += st.st_size
                    newest = max(newest, st.st_mtime)
                    oldest = min(oldest, st.st_mtime)
            age_new = (now - newest) / 86400 if newest else -1
            age_old = (now - oldest) / 86400 if oldest and oldest < now else -1
            print(
                f"  {size/1024/1024:9.1f} MB  {name:<17} "
                f"newest {age_new:5.1f}d ago, oldest {age_old:5.1f}d ago"
            )

    # How much the next startup's retention sweep would reclaim. The rule is
    # per checkpoint chat dir: a dir is dropped when its NEWEST file is older
    # than the TTL (retention.rs / CHECKPOINT_TTL_DAYS = 14).
    ckpt = root / "checkpoints"
    if ckpt.is_dir():
        ttl_days = 14
        reclaim = 0
        dropped = 0
        kept = 0
        for chat_dir in ckpt.iterdir():
            if not chat_dir.is_dir():
                continue
            newest = 0.0
            size = 0
            for dirpath, _dirnames, filenames in os.walk(chat_dir):
                for fn in filenames:
                    p = Path(dirpath) / fn
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    size += st.st_size
                    newest = max(newest, st.st_mtime)
            if newest and (now - newest) / 86400 > ttl_days:
                reclaim += size
                dropped += 1
            else:
                kept += 1
        print()
        print(
            f"  next startup sweep would reclaim {reclaim/1024/1024:.1f} MB "
            f"({dropped} stale checkpoint chat dirs; {kept} kept)"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
