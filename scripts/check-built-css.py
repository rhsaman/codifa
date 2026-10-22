#!/usr/bin/env python3
"""Report which memory-relevant CSS features are present in the BUILT bundle.

The dev binary and the release bundle both serve a snapshot of `dist/`, so a
source edit only reaches the running app after `npm run build`. This checks the
built CSS instead of the source, so a "fix not in the build" mistake is caught
before it is measured.

Usage:
    python3 scripts/check-built-css.py [dist_dir]
"""

from __future__ import annotations

import glob
import os
import re
import sys

KEYWORDS = [
    "will-change",
    "content-visibility",
    "contain-intrinsic",
    "backdrop-filter",
]


def main() -> int:
    dist = sys.argv[1] if len(sys.argv) > 1 else "dist"
    files = sorted(glob.glob(os.path.join(dist, "assets", "*.css")))
    if not files:
        print(f"no built CSS under {dist}/assets — run `npm run build` first")
        return 1
    for path in files:
        text = open(path, errors="replace").read()
        print(f"{os.path.basename(path):34} {len(text):>8} chars")
        for kw in KEYWORDS:
            hits = [m.start() for m in re.finditer(re.escape(kw), text)]
            print(f"  {kw:20} {len(hits):>4} hit(s)")
            for h in hits[:3]:
                snippet = text[max(0, h - 60) : h + 80].replace("\n", " ")
                print(f"      …{snippet}…")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
