#!/usr/bin/env python3
"""Measure peak rustc memory during a cargo build.

Samples the summed RSS of every rustc process while a build runs, so the effect
of a Cargo profile change (debug info / opt-level) is a number, not a guess.
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time


def rustc_rss_mb() -> tuple[int, float]:
    """(process count, summed RSS in MB) for every live rustc process."""
    out = subprocess.run(
        ["ps", "-Ao", "rss,comm"], capture_output=True, text=True
    ).stdout
    count = 0
    total_kb = 0
    for line in out.splitlines()[1:]:
        parts = line.split(None, 1)
        if len(parts) < 2 or "rustc" not in parts[1]:
            continue
        try:
            total_kb += int(parts[0])
        except ValueError:
            continue
        count += 1
    return count, total_kb / 1024


def main() -> int:
    cmd = sys.argv[1:] or ["cargo", "build", "--bin", "codifa"]
    peak_mb = 0.0
    peak_n = 0
    samples = 0
    stop = threading.Event()

    def sample() -> None:
        nonlocal peak_mb, peak_n, samples
        while not stop.is_set():
            n, mb = rustc_rss_mb()
            if mb > peak_mb:
                peak_mb, peak_n = mb, n
            samples += 1
            time.sleep(0.4)

    thread = threading.Thread(target=sample, daemon=True)
    thread.start()
    started = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.monotonic() - started
    stop.set()
    thread.join(timeout=2)

    print(f"command      : {' '.join(cmd)}")
    print(f"exit code    : {proc.returncode}")
    print(f"wall time    : {elapsed:.1f}s")
    print(f"samples      : {samples}")
    print(f"PEAK rustc   : {peak_mb:.0f} MB across {peak_n} processes")
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-6:]
        print("stderr tail  :")
        for line in tail:
            print("   ", line)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
