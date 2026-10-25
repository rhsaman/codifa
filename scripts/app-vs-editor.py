#!/usr/bin/env python3
"""Split a Codifa app's memory from the editor trees the USER opened.

Activity Monitor attributes every descendant of the app process to the app, so a
`nvim` the user launched from the editor panel (plus the LSP servers that nvim
itself spawns) shows up in Codifa's row even though it is the user's editor work,
not the app's footprint. Reporting one number hides that, and it makes an
"is the app leaking" question impossible to answer.

Usage:
    python3 scripts/app-vs-editor.py <app-shell-pid> [samples] [interval-seconds]

The renderer is a WebKit child re-parented to launchd, so it is NOT a descendant
and is reported separately by `scripts/mem-report.py`.
"""

import subprocess
import sys
import time

# Programs a user's editor session pulls in. These are spawned by nvim, not by
# the app, so they must not be counted as the app's own memory.
EDITOR_MARKERS = (
    "nvim",
    "language-server",
    "tscancellation",
    "typesMap",
    "emmet",
    "tailwindcss",
)


def read_procs() -> dict[int, tuple[int, float, str]]:
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,rss=,args=ww"], capture_output=True, text=True
    ).stdout
    rows: dict[int, tuple[int, float, str]] = {}
    for line in out.splitlines()[1:]:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            rows[int(parts[0])] = (int(parts[1]), int(parts[2]) / 1024, parts[3])
        except ValueError:
            continue
    return rows


def is_descendant(pid: int, root: int, rows: dict[int, tuple[int, float, str]]) -> bool:
    cur, hops = pid, 0
    while cur in rows and hops < 14:
        ppid = rows[cur][0]
        if ppid == root:
            return True
        if ppid <= 1:
            return False
        cur, hops = ppid, hops + 1
    return False


def sample(root: int) -> tuple[float, float]:
    rows = read_procs()
    app = editor = 0.0
    for pid, (_ppid, mb, args) in rows.items():
        if pid != root and not is_descendant(pid, root, rows):
            continue
        if any(m in args for m in EDITOR_MARKERS):
            editor += mb
        else:
            app += mb
    return app, editor


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = int(sys.argv[1])
    samples = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    interval = int(sys.argv[3]) if len(sys.argv) > 3 else 25

    for i in range(samples):
        app, editor = sample(root)
        print(
            f"  sample {i + 1}:  app-attributable={app:7.1f}MB   "
            f"editor trees the user opened={editor:7.1f}MB"
        )
        if i < samples - 1:
            time.sleep(interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
