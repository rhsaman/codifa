#!/usr/bin/env python3
"""Verify the split-storage migration lost no chat and no message.

Compares the three sources of truth:

  * the pre-migration document (`settings.json.pre-index-migration`), which held
    every chat body inline,
  * the post-migration index rows in `settings.json`, and
  * the per-chat body files under `chats/<workspace>/<id>.json`.

The migration contract is: for every chat id, the message count in the body
file matches the count the pre-migration document had, and the index row's
`messageCount` agrees with both. Any id present in one source and missing from
another is reported as data loss.

Read-only. Exits non-zero when a mismatch is found.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def data_root() -> Path:
    return Path(os.environ.get("CODER_DATA_DIR") or (Path.home() / ".codifa"))


def load_json(path: Path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            return json.load(fh)
    except Exception as exc:  # noqa: BLE001 - diagnostics must not crash
        print(f"  ! could not parse {path}: {exc}")
        return None


def message_count(row) -> int:
    msgs = row.get("messages") if isinstance(row, dict) else None
    return len(msgs) if isinstance(msgs, list) else 0


def main() -> int:
    root = data_root()
    print(f"data root: {root}")

    settings_path = root / "settings.json"
    backup_path = root / "settings.json.pre-index-migration"

    settings = load_json(settings_path)
    if not isinstance(settings, dict):
        print(f"FAIL: {settings_path} is not a JSON object")
        return 1

    index_rows = settings.get("chats") or []
    if not isinstance(index_rows, list):
        print("FAIL: settings.json 'chats' is not an array")
        return 1

    print(f"schemaVersion: {settings.get('schemaVersion')}")
    print(f"index rows: {len(index_rows)}")
    inline = [r for r in index_rows if "messages" in r]
    print(f"index rows still carrying a body: {len(inline)}")

    index_count = {str(r.get("id")): int(r.get("messageCount") or 0) for r in index_rows}

    # Body files: one JSON per chat, newest wins on duplicate ids.
    body_count: dict[str, int] = {}
    body_paths: dict[str, Path] = {}
    chats_dir = root / "chats"
    if chats_dir.is_dir():
        for path in sorted(chats_dir.rglob("*.json")):
            row = load_json(path)
            if not isinstance(row, dict):
                continue
            cid = row.get("id")
            if not isinstance(cid, str):
                continue
            count = message_count(row)
            prev = body_count.get(cid)
            if prev is None or count >= prev:
                body_count[cid] = count
                body_paths[cid] = path

    print(f"body files found: {sum(1 for _ in chats_dir.rglob('*.json')) if chats_dir.is_dir() else 0}")
    print(f"distinct chat ids on disk: {len(body_count)}")

    problems: list[str] = []

    # 1) Every index row must have a body file with the same message count.
    for cid, count in index_count.items():
        disk = body_count.get(cid)
        if disk is None:
            problems.append(f"index row '{cid}' has no body file on disk")
        elif disk != count:
            problems.append(
                f"chat '{cid}': index says {count} messages, body file has {disk}"
            )

    # 2) Every body file must be represented in the index.
    for cid in body_count:
        if cid not in index_count:
            problems.append(f"body file for '{cid}' has no index row (orphan)")

    # 3) Against the pre-migration document, when it is still around.
    backup_total = None
    if backup_path.is_file():
        backup = load_json(backup_path)
        if isinstance(backup, dict):
            rows = backup.get("chats") or []
            before: dict[str, int] = {}
            for r in rows:
                if isinstance(r, dict) and isinstance(r.get("id"), str):
                    before[r["id"]] = message_count(r)
            backup_total = sum(before.values())
            print(f"pre-migration doc: {len(before)} chats, {backup_total} messages")
            missing = [cid for cid in before if cid not in index_count]
            if missing:
                problems.append(f"{len(missing)} chat(s) in the pre-migration doc are gone: {missing[:5]}")
            grown = 0
            for cid, count in before.items():
                now = index_count.get(cid)
                if now is None:
                    continue
                if now < count:
                    # Fewer messages than before the migration = real data loss.
                    problems.append(
                        f"chat '{cid}': had {count} messages before migration, only {now} now"
                    )
                elif now > count:
                    # More messages than before = the chat was used after the
                    # migration ran (new turns appended). Not a loss.
                    grown += 1
            if grown:
                print(f"  ({grown} chat(s) grew after the migration - new turns, not loss)")
    else:
        print("pre-migration doc not found (already cleaned up?) - skipping that cross-check")

    print()
    print(f"total messages in index rows: {sum(index_count.values())}")
    print(f"total messages in body files: {sum(body_count.values())}")
    if backup_total is not None:
        print(f"total messages before migration: {backup_total}")

    print()
    if problems:
        print(f"FAIL: {len(problems)} integrity problem(s)")
        for p in problems[:40]:
            print(f"  - {p}")
        return 1
    print("PASS: every chat and every message survived the migration")
    return 0


if __name__ == "__main__":
    sys.exit(main())
