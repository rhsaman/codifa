#!/usr/bin/env python3
"""One-shot health and retention audit of the Codifa data root.

Reports what is still on disk and whether the retention rules are actually
bounding it, so disk growth is visible before it becomes a problem.

Usage:
    python3 scripts/audit-data-root.py [data_dir]
"""

from __future__ import annotations

import os
import sys
import time

DAY_HOURS = 24.0


def dir_size(path: str) -> tuple[int, int, float]:
    """(file_count, total_bytes, oldest_mtime)."""
    count = 0
    total = 0
    oldest = time.time()
    for dirpath, _dirnames, filenames in os.walk(path):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            count += 1
            total += st.st_size
            oldest = min(oldest, st.st_mtime)
    return count, total, oldest


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.codifa")
    if not os.path.isdir(root):
        print(f"no data root at {root}")
        return 1
    print(f"data root: {root}\n")
    grand = 0
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if name == ".DS_Store":
            continue
        if os.path.isfile(full):
            size = os.path.getsize(full)
            age = (time.time() - os.path.getmtime(full)) / 3600
            print(f"  {name:<40} {size / 1048576:9.2f} MB  {age:7.1f}h old")
            grand += size
        else:
            count, total, oldest = dir_size(full)
            age = (time.time() - oldest) / 3600
            print(
                f"  {name + '/':<40} {total / 1048576:9.2f} MB  "
                f"{count:>5} files, oldest {age:.1f}h"
            )
            grand += total
    print(f"  {'-' * 62}")
    print(f"  {'TOTAL':<40} {grand / 1048576:9.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
