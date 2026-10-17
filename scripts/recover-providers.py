#!/usr/bin/env python3
"""One-off recovery for custom providers wiped from ~/.codifa/settings.json.

Why: `store_set("settings", ...)` overwrote the `providers` array wholesale, so
a stale or partially hydrated payload could delete provider rows that own
`enc:v1:` API keys. The pre-wipe snapshot survives in `app-state-cache.json`
(written by the main process until Oct 2026).

What it does (idempotent):
  * unions providers from the cache into the live file, keyed by id
  * keeps the live row when it still carries credentials
  * never touches any other key (chats, workspaces, encryption stay as-is)
  * writes a timestamped backup before mutating anything

Usage: python3 scripts/recover-providers.py [--dry-run]
"""
from __future__ import annotations

import json
import pathlib
import shutil
import sys
import time

HOME = pathlib.Path.home()
ROOT = HOME / ".codifa"
LIVE = ROOT / "settings.json"
CACHE = ROOT / "app-state-cache.json"


def load(path: pathlib.Path):
    return json.loads(path.read_text("utf-8"))


def providers_of(doc: dict) -> list:
    """Providers live at the top level; older snapshots nest them under `settings`."""
    top = doc.get("providers")
    if isinstance(top, list):
        return top
    nested = doc.get("settings")
    if isinstance(nested, dict) and isinstance(nested.get("providers"), list):
        return nested["providers"]
    return []


def key_count(row: dict) -> int:
    keys = row.get("apiKeys")
    return len(keys) if isinstance(keys, list) else 0


def encrypt_count(rows) -> int:
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in row.get("apiKeys") or []:
            if isinstance(key, str) and key.startswith("enc:v1:"):
                n += 1
    return n


def merge(live_rows: list, cache_rows: list):
    """Union by id: the live row wins, unless it lost its credentials."""
    order: list[str] = []
    final: dict[str, dict] = {}
    for row in live_rows:
        if isinstance(row, dict) and row.get("id"):
            order.append(row["id"])
            final[row["id"]] = row
    recovered: list[str] = []
    for row in cache_rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        pid = row["id"]
        if pid not in final:
            final[pid] = row
            order.append(pid)
            recovered.append(pid)
        elif key_count(final[pid]) == 0 and key_count(row) > 0:
            final[pid] = row
            recovered.append(f"{pid} (credentials restored)")
    return [final[pid] for pid in order], recovered


def main() -> int:
    dry = "--dry-run" in sys.argv
    if not LIVE.is_file():
        print(f"! missing {LIVE}")
        return 1
    if not CACHE.is_file():
        print(f"! missing {CACHE} — nothing to recover from")
        return 1

    live = load(LIVE)
    cache = load(CACHE)
    live_rows = providers_of(live)
    cache_rows = providers_of(cache)

    print(f"live   providers={len(live_rows)} enc_keys={encrypt_count(live_rows)}")
    print(f"cache  providers={len(cache_rows)} enc_keys={encrypt_count(cache_rows)}")

    merged, recovered = merge(live_rows, cache_rows)
    print(f"merged providers={len(merged)} enc_keys={encrypt_count(merged)}")
    for pid in recovered:
        print(f"  + {pid}")

    missing = sorted(k for k in cache if k not in live and k != "chats")
    if missing:
        print("cache-only top-level keys (left untouched): " + ", ".join(missing))

    if not recovered:
        print("nothing to do")
        return 0
    if dry:
        print("dry run — no file written")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = LIVE.with_name(f"settings.json.pre-recovery-{stamp}")
    shutil.copy2(LIVE, backup)
    print(f"backup {backup}")

    if isinstance(live.get("providers"), list):
        live["providers"] = merged
    else:
        live["settings"]["providers"] = merged

    tmp = LIVE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(live, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(LIVE)
    print(f"wrote {LIVE} providers={len(merged)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
