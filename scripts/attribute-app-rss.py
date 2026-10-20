#!/usr/bin/env python3
"""Attribute RSS to one app instance by walking the process tree.

Mixing every WebContent on the machine is meaningless when an old release build
is still open, so this starts from the target pid and sums only its descendants.
"""
import subprocess
import sys

rows = []
for line in subprocess.run(
    ["ps", "-Ao", "pid=,ppid=,rss=,comm="],
    capture_output=True,
    text=True,
).stdout.splitlines():
    parts = line.split(None, 3)
    if len(parts) < 4:
        continue
    try:
        rows.append((int(parts[0]), int(parts[1]), int(parts[2]), parts[3]))
    except ValueError:
        continue

by_pid = {r[0]: r for r in rows}
children = {}
for pid, ppid, _rss, _cmd in rows:
    children.setdefault(ppid, []).append(pid)


def tree(root):
    out, stack = [], [root]
    while stack:
        p = stack.pop()
        if p in by_pid:
            out.append(by_pid[p])
        stack.extend(children.get(p, []))
    return out


# Candidate roots: any process whose comm ends with the debug binary or the
# bundled release binary.
roots = {}
for pid, _ppid, _rss, cmd in rows:
    if cmd.rstrip("/").endswith("/target/debug/codifa") or cmd == "./src-tauri/target/debug/codifa":
        roots.setdefault("DEV (debug binary)", pid)
    elif "release/bundle/macos/Codifa.app/Contents/MacOS/codifa" in cmd:
        roots.setdefault("RELEASE (old build)", pid)

if not roots:
    print("no codifa root process found")
    sys.exit(1)

for label, pid in roots.items():
    procs = tree(pid)
    total = sum(p[2] for p in procs) / 1024.0
    print(f"== {label} — root pid {pid} ==")
    for p in sorted(procs, key=lambda x: -x[2]):
        name = p[3].rsplit("/", 1)[-1]
        print(f"   {p[2] / 1024.0:8.1f} MB  pid {p[0]:<7} {name}")
    print(f"   {'-' * 40}")
    print(f"   {total:8.1f} MB  TOTAL (shell + its web content)")
    print()
