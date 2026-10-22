#!/usr/bin/env python3
"""Report malloc-zone occupancy so freed-but-retained memory is visible.

A process's physical footprint can sit far above its live data when the malloc
allocator keeps freed slabs mapped. `vmmap --summary` exposes this as
`Malloc Small (empty)` / `Malloc Large (empty)`: regions whose allocation was
released but which were never returned to the kernel. That is the signature of
a hot allocate/free-churn path (repeatedly cloning and dropping a large
document), not of a live leak — and the fix is to stop the churn, not to hunt
for a reference that is still held.

Usage:
    python3 scripts/malloc-zones.py <pid>
"""

from __future__ import annotations

import re
import subprocess
import sys


def mb(token: str) -> float:
    m = re.fullmatch(r"([\d.]+)([KMG]?)", token)
    if not m:
        return 0.0
    value = float(m.group(1))
    unit = m.group(2)
    return value * 1024 if unit == "G" else (value / 1024 if unit == "K" else value)


INTERESTING = [
    "Malloc Small",
    "Malloc Small (empty)",
    "Malloc Large",
    "Malloc Large (empty)",
    "Malloc Tiny",
    "Malloc Nano",
    "Malloc Metadata",
    "WebKit Malloc",
    "WebKit Malloc (empty)",
    "IOSurface",
    "CG Image",
    "Image IO",
    "IOAccelerator",
    "Deferred Reclaim",
    "__LINKEDIT",
    "__DATA_CONST",
    "__OBJC_RO",
    "__TEXT",
]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pid = sys.argv[1]
    out = subprocess.run(
        ["vmmap", "--summary", pid], capture_output=True, text=True, timeout=300
    ).stdout

    footprint = peak = None
    for line in out.splitlines():
        if line.startswith("Physical footprint:"):
            m = re.search(r"([\d.]+)([KMG])", line)
            footprint = mb(m.group(1) + m.group(2)) if m else None
        elif line.startswith("Physical footprint (peak):"):
            m = re.search(r"([\d.]+)([KMG])", line)
            peak = mb(m.group(1) + m.group(2)) if m else None

    print(f"pid {pid}: physical footprint {footprint} MB (peak {peak} MB)\n")
    print(f"  {'resident':>10} {'dirty':>10} {'swap':>10}  region")
    totals: dict[str, list[float]] = {}
    for line in out.splitlines():
        stripped = line.strip()
        name = None
        for candidate in INTERESTING:
            if stripped.startswith(candidate):
                if name is None or len(candidate) > len(name):
                    name = candidate
        if name is None:
            continue
        parts = stripped.split()
        if len(parts) < 8:
            continue
        # region name words, then 7 sizes + count
        sizes = parts[-(len(parts) - len(name.split())) :]
        if len(sizes) < 7:
            continue
        try:
            res, dirt, swap = mb(sizes[1]), mb(sizes[2]), mb(sizes[5])
        except Exception:
            continue
        agg = totals.setdefault(name, [0.0, 0.0, 0.0])
        agg[0] += res
        agg[1] += dirt
        agg[2] += swap

    for name, (res, dirt, swap) in sorted(totals.items(), key=lambda kv: -kv[1][0]):
        if res == 0 and dirt == 0:
            continue
        print(f"  {res:9.1f}M {dirt:9.1f}M {swap:9.1f}M  {name}")

    empty = totals.get("Malloc Small (empty)", [0, 0, 0])[0] + totals.get(
        "Malloc Large (empty)", [0, 0, 0]
    )[0]
    if footprint:
        print(
            f"\n  freed-but-retained slabs: {empty:.1f} MB "
            f"({empty / footprint * 100:.0f}% of footprint)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
