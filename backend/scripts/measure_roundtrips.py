"""Measure agent round-trips from saved chats.

Counts per turn: steps (assistant messages carrying tool activity), tool
calls, calls per step, same-file overlapping read windows (duplicate-line
proxy), head-of-file reads (offset=1, limit<=120), and plan-only steps
(steps running nothing but update_plan).

Usage:
    cd backend && uv run python scripts/measure_roundtrips.py CHAT.json [...]
    cd backend && uv run python scripts/measure_roundtrips.py --all [--ws SLUG]
    ... --json  # machine-readable aggregate for before/after comparison

Acceptance for read-efficiency work: fewer steps at equal quality (no cap).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

HEAD_LIMIT = 120  # offset=1 reads at or under this are "head reads"


def _read_windows(tool: str, args: dict) -> list[tuple[str, int, int]]:
    """Normalize one tool call to [(path, start1, end1)] read windows."""
    if not isinstance(args, dict):
        return []
    if tool == "read":
        wins: list[tuple[str, int, int]] = []
        for spec in args.get("ranges") or []:
            parts = str(spec).split(":")
            if len(parts) == 3 and parts[1].strip().isdigit() and parts[2].strip().isdigit():
                o, li = int(parts[1]), int(parts[2])
                wins.append((parts[0].strip(), o, o + li - 1))
        if args.get("symbols"):
            for s in args["symbols"]:
                wins.append((str(args.get("filePath") or ""), -1, -1))  # size unknown offline
                break  # one marker per symbols= call (names resolved live)
            # fall through: concrete filePaths below also count
        for p in [args.get("filePath"), *list(args.get("filePaths") or [])]:
            if p and not any(w[0] == p and w[1] != -1 for w in wins):
                o = int(args.get("offset") or 1)
                li = int(args.get("limit") or 2000)
                wins.append((str(p), o, o + li - 1))
        return [(p, s, e) for p, s, e in wins if p]
    return []


def _overlap(a: tuple[int, int], b: tuple[int, int]) -> int:
    if a[0] < 0 or b[0] < 0:
        return 0
    return max(0, min(a[1], b[1]) - max(a[0], b[0]) + 1)


def measure_chat(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        chat = json.load(fh)
    root = chat.get("root") or ""
    messages = chat.get("messages") or []
    turns: list[dict] = []
    cur: dict | None = None
    for m in messages:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "user":
            if cur is not None:
                turns.append(cur)
            cur = {"steps": 0, "calls": 0, "reads": 0, "plan_only": 0,
                   "windows": [], "symbols_calls": 0}
        elif m.get("role") == "assistant" and cur is not None:
            acts = m.get("toolActivity") or []
            if not acts:
                continue
            cur["steps"] += 1
            cur["calls"] += len(acts)
            tools = {str(a.get("tool") or "") for a in acts}
            if tools <= {"update_plan"}:
                cur["plan_only"] += 1
            for a in acts:
                t = str(a.get("tool") or "")
                args = a.get("args") or {}
                if t == "read":
                    cur["reads"] += 1
                    if args.get("symbols"):
                        cur["symbols_calls"] += 1
                    cur["windows"].extend(_read_windows(t, args))
    if cur is not None:
        turns.append(cur)

    file_lines: dict[str, int] = {}

    def total_of(rel: str) -> int:
        if rel in file_lines:
            return file_lines[rel]
        n = 0
        if root:
            try:
                with open(os.path.join(root, rel), encoding="utf-8", errors="replace") as fh:
                    n = sum(1 for _ in fh)
            except OSError:
                n = 0
        file_lines[rel] = n
        return n

    agg = {"turns": 0, "steps": 0, "calls": 0, "reads": 0, "plan_only": 0,
           "overlap_pairs": 0, "overlap_lines": 0, "head_reads": 0,
           "symbols_calls": 0, "per_turn": []}
    for t in turns:
        if not t["steps"] and not t["calls"]:
            continue
        agg["turns"] += 1
        agg["steps"] += t["steps"]
        agg["calls"] += t["calls"]
        agg["reads"] += t["reads"]
        agg["plan_only"] += t["plan_only"]
        agg["symbols_calls"] += t["symbols_calls"]
        by_file: dict[str, list[tuple[int, int]]] = {}
        for p, s, e in t["windows"]:
            by_file.setdefault(p, []).append((s, e))
        t_pairs = t_lines = t_head = 0
        for p, wins in by_file.items():
            concrete = [w for w in wins if w[0] >= 0]
            for i in range(len(concrete)):
                for j in range(i + 1, len(concrete)):
                    ov = _overlap(concrete[i], concrete[j])
                    if ov:
                        t_pairs += 1
                        t_lines += ov
            for s, e in concrete:
                if s == 1 and (e - s + 1) <= HEAD_LIMIT:
                    tot = total_of(p)
                    if tot > 800 or (tot == 0 and (e - s + 1) <= HEAD_LIMIT):
                        t_head += 1
        agg["overlap_pairs"] += t_pairs
        agg["overlap_lines"] += t_lines
        agg["head_reads"] += t_head
        agg["per_turn"].append({
            "steps": t["steps"], "calls": t["calls"], "reads": t["reads"],
            "overlap_pairs": t_pairs, "overlap_lines": t_lines,
            "head_reads": t_head, "plan_only": t["plan_only"],
        })
    return agg


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Measure agent round-trips in saved chats.")
    ap.add_argument("chats", nargs="*", help="chat JSON files")
    ap.add_argument("--all", action="store_true", help="all chats under ~/.codifa/chats")
    ap.add_argument("--ws", default="", help="workspace slug filter with --all")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ns = ap.parse_args(argv)
    files = list(ns.chats)
    if ns.all:
        base = os.path.join(os.path.expanduser("~"), ".codifa", "chats")
        if ns.ws:
            base = os.path.join(base, ns.ws)
        files.extend(sorted(glob.glob(os.path.join(base, "*", "*.json"))))
        files.extend(sorted(glob.glob(os.path.join(base, "*.json"))))
    if not files:
        ap.error("pass chat JSON files or --all")
    total = {"chats": 0, "turns": 0, "steps": 0, "calls": 0, "reads": 0,
             "plan_only": 0, "overlap_pairs": 0, "overlap_lines": 0,
             "head_reads": 0, "symbols_calls": 0}
    rows = []
    for f in files:
        try:
            agg = measure_chat(f)
        except Exception as exc:  # noqa: BLE001 — one bad file never stops the report
            print(f"skip {f}: {exc}", file=sys.stderr)
            continue
        total["chats"] += 1
        for k in ("turns", "steps", "calls", "reads", "plan_only",
                  "overlap_pairs", "overlap_lines", "head_reads", "symbols_calls"):
            total[k] += agg[k]
        rows.append((f, agg))
    if ns.json:
        print(json.dumps({"total": total}, indent=1))
        return 0
    print(f"{'chat':60} {'turns':>5} {'steps':>5} {'calls':>5} {'reads':>5} "
          f"{'ovl_pairs':>9} {'ovl_lines':>9} {'head':>4} {'planonly':>8}")
    for f, agg in rows:
        name = os.path.basename(f)
        print(f"{name:60} {agg['turns']:>5} {agg['steps']:>5} {agg['calls']:>5} "
              f"{agg['reads']:>5} {agg['overlap_pairs']:>9} {agg['overlap_lines']:>9} "
              f"{agg['head_reads']:>4} {agg['plan_only']:>8}")
    t = total
    cps = (t["calls"] / t["steps"]) if t["steps"] else 0
    print(f"\nTOTAL chats={t['chats']} turns={t['turns']} steps={t['steps']} "
          f"calls={t['calls']} ({cps:.2f}/step) reads={t['reads']} "
          f"overlap_pairs={t['overlap_pairs']} overlap_lines={t['overlap_lines']} "
          f"head_reads={t['head_reads']} plan_only_steps={t['plan_only']} "
          f"symbols_calls={t['symbols_calls']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
