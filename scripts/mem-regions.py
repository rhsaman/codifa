#!/usr/bin/env python3
"""Break down a process's memory by REGION TYPE, sorted by resident size.

`vmmap --summary` prints a REGION TYPE table whose numeric columns can be a
bare `0` (no unit suffix) or a suffixed size. This parses that table properly
instead of guessing column positions with awk.

Usage:
    python3 scripts/mem-regions.py <pid> [top]
"""

from __future__ import annotations

import re
import subprocess
import sys


def to_mb(token: str) -> float | None:
    """`146.8M` -> 146.8, `1.4G` -> 1433.6, `0` -> 0.0, else None."""
    m = re.fullmatch(r"([\d.]+)([KMG]?)", token)
    if not m:
        return None
    value = float(m.group(1))
    unit = m.group(2)
    if unit == "G":
        return value * 1024
    if unit == "K":
        return value / 1024
    return value


def parse(pid: int) -> tuple[list[str], float | None, float | None]:
    out = subprocess.run(
        ["vmmap", "--summary", str(pid)], capture_output=True, text=True, timeout=300
    ).stdout
    footprint = peak = None
    for line in out.splitlines():
        if line.startswith("Physical footprint:"):
            m = re.search(r"([\d.]+)([KMG])", line)
            if m:
                footprint = to_mb(m.group(1) + m.group(2))
        elif line.startswith("Physical footprint (peak):"):
            m = re.search(r"([\d.]+)([KMG])", line)
            if m:
                peak = to_mb(m.group(1) + m.group(2))

    # The REGION TYPE table: every data row ends with 8 numeric-ish columns
    # (SIZE x7 + COUNT) preceded by the region name.
    rows: list[tuple[float, float, float, str, str]] = []
    in_table = False
    for line in out.splitlines():
        if line.startswith("REGION TYPE"):
            in_table = True
            continue
        if not in_table:
            continue
        if line.startswith("TOTAL"):
            break
        if not line.strip() or line.startswith("="):
            continue
        parts = line.split()
        if len(parts) < 8:
            continue
        count = parts[-1]
        sizes = parts[-7:-1]
        if not count.isdigit():
            continue
        virt = to_mb(sizes[0])
        res = to_mb(sizes[1])
        dirty = to_mb(sizes[2])
        if virt is None or res is None or dirty is None:
            continue
        name = " ".join(parts[:-7]) or "?"
        rows.append((res, dirty, virt, name, count))
    rows.sort(reverse=True)
    return rows, footprint, peak


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pid = int(sys.argv[1])
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    rows, footprint, peak = parse(pid)
    print(f"pid {pid}: physical footprint {footprint} MB (peak {peak} MB)")
    print(f"  {'resident':>10} {'dirty':>10} {'virtual':>11} {'count':>6}  region")
    for res, dirty, virt, name, count in rows[:top]:
        print(f"  {res:9.1f}M {dirty:9.1f}M {virt:10.1f}M {count:>6}  {name}")
    total_res = sum(r[0] for r in rows)
    print(f"  {'-' * 10}")
    print(f"  {total_res:9.1f}M  sum of listed regions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
