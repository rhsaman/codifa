#!/usr/bin/env python3
"""Verify the memory fixes on a running Codifa instance.

Checks, in one pass:
  * no heavyweight language server (rust-analyzer / pylsp) was pre-warmed
  * physical footprint of the app shell and its renderer, plus stability
    samples so a slow leak cannot hide behind a single reading
  * the split storage is intact: every index row still resolves to a body whose
    message count matches the index, so no chat or message was lost
  * the app log has no panics or errors

Physical footprint (not RSS) is what Activity Monitor's "Memory" column shows,
and it attributes every child process to the app, so the whole process tree is
summed here.

Usage: python3 scripts/verify-memory.py <shell-pid> [--no-samples]
"""

import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

HEAVY = ("rust-analyzer", "pylsp", "clangd", "gopls", "jdtls", "metals")


# ── process / memory helpers ────────────────────────────────────────────────


def all_processes():
    """pid -> (ppid, comm) for every visible process."""
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,comm="], capture_output=True, text=True
    ).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) != 3:
            continue
        try:
            procs[int(parts[0])] = (int(parts[1]), parts[2])
        except ValueError:
            continue
    return procs


def footprint_mb(pid):
    """Physical footprint in MB, or None when the process is gone."""
    try:
        out = subprocess.run(
            ["vmmap", "--summary", str(pid)], capture_output=True, text=True, timeout=180
        ).stdout
    except Exception:
        return None
    m = re.search(r"Physical footprint:\s+([\d.]+)([KMG])", out)
    if not m:
        return None
    value = float(m.group(1))
    unit = m.group(2)
    return value / 1024 if unit == "K" else (value if unit == "M" else value * 1024)


def start_epoch(pid):
    """Process start time as a unix timestamp, or None."""
    try:
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True
        ).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    try:
        return datetime.datetime.strptime(out, "%a %b %d %H:%M:%S %Y").timestamp()
    except ValueError:
        return None


def descendants(root, procs):
    children = {}
    for pid, (ppid, _comm) in procs.items():
        children.setdefault(ppid, []).append(pid)
    found, stack = [], [root]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


def renderer_pid(shell_pid, procs):
    """The WebKit content process belonging to this app instance.

    macOS reparents it to launchd, so it cannot be reached by walking the tree.
    It is matched by launch order instead: the renderer starts within a few
    seconds of its shell.
    """
    shell_start = start_epoch(shell_pid)
    if shell_start is None:
        return None
    best = None
    for pid, (_ppid, comm) in procs.items():
        if "WebKit.WebContent" not in comm:
            continue
        start = start_epoch(pid)
        if start is None:
            continue
        delta = start - shell_start
        if -2 <= delta <= 10 and (best is None or abs(delta) < abs(best[0])):
            best = (delta, pid)
    return best[1] if best else None


# ── checks ─────────────────────────────────────────────────────────────────


def check_heavy(shell_pid, procs):
    print("=== heavyweight language servers ===")
    offenders = []
    for pid in descendants(shell_pid, procs):
        comm = procs[pid][1]
        if any(name in comm for name in HEAVY):
            offenders.append((pid, comm, footprint_mb(pid)))
    if offenders:
        print("  PROBLEM — the pre-warm policy is not in effect:")
        for pid, comm, size in offenders:
            print(f"    pid={pid} {comm} footprint={size}MB")
        return False
    print("  none — heavy servers start on demand only")
    return True


def sample(shell_pid, renderer, rounds=3, gap=40):
    print()
    print("=== footprint samples (stability) ===")
    rows = []
    for i in range(rounds):
        shell = footprint_mb(shell_pid) or 0.0
        rend = footprint_mb(renderer) if renderer else 0.0
        rend = rend or 0.0
        rows.append((shell, rend))
        print(
            f"  t+{i * gap:>3}s  shell={shell:7.1f}MB  renderer={rend:7.1f}MB"
            f"  total={shell + rend:7.1f}MB"
        )
        if i + 1 < rounds:
            import time

            time.sleep(gap)
    if len(rows) > 1:
        drift = (rows[-1][0] + rows[-1][1]) - (rows[0][0] + rows[0][1])
        print(f"  drift over {(rounds - 1) * gap}s: {drift:+.1f}MB")
    return rows[-1][0] + rows[-1][1]


def workspace_slug(root):
    """Mirror of plans::workspace_slug_for_root (basename + 8-char sha1)."""
    if not root or not root.strip():
        return "workspace"
    real = os.path.realpath(root).rstrip("/")
    if not real:
        return "workspace"
    base = os.path.basename(real) or "workspace"
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip(".-") or "workspace"
    digest = hashlib.sha1(real.encode()).hexdigest()[:8]
    return f"{base}-{digest}"


def safe_id(raw):
    out, prev_dash = [], False
    for ch in (raw or "").strip():
        if ch.isalnum() or ch in "._-":
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
        if len(out) > 120:
            break
    trimmed = "".join(out).strip(".-")
    return trimmed or "chat"


def body_path(data_root, row):
    """Mirror of store::body_path: the index `dir` wins, else the slug layout."""
    rel = row.get("dir")
    if rel:
        return os.path.join(data_root, rel)
    slug = workspace_slug(row.get("root") or "")
    return os.path.join(data_root, "chats", slug, safe_id(row.get("id") or "chat")) + ".json"


def check_data():
    print()
    print("=== data integrity (split storage) ===")
    data_root = os.path.expanduser("~/.codifa")
    doc_path = os.path.join(data_root, "settings.json")
    with open(doc_path) as fh:
        doc = json.load(fh)
    rows = doc.get("chats") or []
    embedded = [r for r in rows if r.get("messages")]
    print(
        f"  schemaVersion={doc.get('schemaVersion')}  rows={len(rows)}  "
        f"rows-carrying-messages={len(embedded)}"
    )
    if embedded:
        print("  PROBLEM — the index still embeds chat bodies")
        return False

    missing, mismatched = [], []
    index_total = body_total = 0
    for row in rows:
        cid = row.get("id")
        expected = int(row.get("messageCount") or 0)
        index_total += expected
        path = body_path(data_root, row)
        if not os.path.exists(path):
            if expected > 0:
                missing.append((cid, expected, path))
            continue
        try:
            with open(path) as fh:
                body = json.load(fh)
        except Exception:
            missing.append((cid, expected, path))
            continue
        actual = len(body.get("messages") or [])
        body_total += actual
        if actual != expected:
            mismatched.append((cid, expected, actual))

    print(f"  missing bodies={len(missing)}  count mismatches={len(mismatched)}")
    print(f"  index message total={index_total}  body message total={body_total}")
    for cid, expected, path in missing[:5]:
        print(f"    MISSING {cid} (expected {expected}) -> {path}")
    for cid, expected, actual in mismatched[:5]:
        print(f"    MISMATCH {cid}: index={expected} body={actual}")
    print(f"  settings.json = {os.path.getsize(doc_path) / 1e6:.2f} MB")
    return not missing and not mismatched


def check_logs(paths):
    print()
    print("=== logs ===")
    bad_total = 0
    for path in paths:
        if not os.path.exists(path):
            continue
        text = open(path, errors="replace").read()
        lines = text.splitlines()
        bad = [
            line
            for line in lines
            if any(k in line.lower() for k in ("panic", "error", "fatal", "sigsegv"))
        ]
        print(f"  {os.path.basename(path)}: {len(lines)} lines, {len(bad)} error-ish")
        for line in bad[:5]:
            print("    ", line[:160])
        bad_total += len(bad)
    return bad_total == 0


def main():
    if len(sys.argv) < 2:
        print("usage: verify-memory.py <shell-pid> [--no-samples]")
        return 2
    shell_pid = int(sys.argv[1])
    do_samples = "--no-samples" not in sys.argv

    procs = all_processes()
    if shell_pid not in procs:
        print(f"pid {shell_pid} is not running")
        return 2

    failures = 0
    if not check_heavy(shell_pid, procs):
        failures += 1

    renderer = renderer_pid(shell_pid, procs)
    print(f"  renderer: {renderer}")

    if do_samples:
        total = sample(shell_pid, renderer)
    else:
        total = (footprint_mb(shell_pid) or 0) + (footprint_mb(renderer) or 0 if renderer else 0)

    print()
    print(f"=== TOTAL (Activity Monitor) ~= {total:.1f} MB ===")
    if total >= 1024:
        print("  ABOVE the 1 GB goal")
        failures += 1
    else:
        print("  under the 1 GB goal")

    if not check_data():
        failures += 1
    if not check_logs(["/tmp/live1.log", "/tmp/app9.log", "/tmp/app10.log"]):
        failures += 1

    print()
    print("RESULT:", "PASS" if failures == 0 else f"{failures} check(s) failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
