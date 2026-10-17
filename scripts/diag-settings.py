#!/usr/bin/env python3
"""One-off diagnostic: inspect the on-disk settings store and secrets keys."""
import json
import os
import pathlib
import time

HOME = pathlib.Path.home()
CANDIDATES = [
    HOME / ".codifa" / "settings.json",
    HOME / ".coder" / "settings.json",
    HOME / "Library" / "Application Support" / "codifa" / "settings.json",
    HOME / "Library" / "Application Support" / "com.codifa.app" / "settings.json",
]

for path in CANDIDATES:
    if not path.exists():
        print(f"MISSING  {path}")
        continue
    stat = path.stat()
    print(f"EXISTS   {path}  size={stat.st_size}  mtime={time.ctime(stat.st_mtime)}")
    try:
        doc = json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001
        print(f"  !! unparsable: {exc}")
        continue
    print(f"  top-level keys: {sorted(doc.keys())}")
    providers = doc.get("providers")
    if isinstance(providers, dict):
        providers = providers.get("providers")
    settings = doc.get("settings")
    if not isinstance(providers, list) and isinstance(settings, dict):
        providers = settings.get("providers")
    if isinstance(providers, list):
        print(f"  providers: {len(providers)}")
        for p in providers:
            keys = p.get("apiKeys") or []
            enc = sum(1 for k in keys if isinstance(k, str) and k.startswith("enc:"))
            print(f"    - id={p.get('id')!r} kind={p.get('kind')!r} name={p.get('name')!r} "
                  f"keys={len(keys)} enc={enc} baseUrl={p.get('baseUrl')!r} model={p.get('model')!r}")
    else:
        print("  providers: <none>")
    chats = doc.get("chats")
    if isinstance(chats, list):
        print(f"  chats: {len(chats)}")
    active = doc.get("activeProviderId")
    if active is None and isinstance(settings, dict):
        active = settings.get("activeProviderId")
    print(f"  activeProviderId: {active!r}")

print()
for pointer in [
    HOME / "Library" / "Application Support" / "com.codifa.app" / "data-root.json",
    HOME / "Library" / "Application Support" / "codifa" / "data-root.json",
]:
    print(f"pointer {pointer}: {pointer.read_text().strip() if pointer.exists() else 'MISSING'}")

print()
for key in [
    HOME / "Library" / "Application Support" / "com.codifa.app" / "secrets.key",
    HOME / "Library" / "Application Support" / "codifa" / "secrets.key",
]:
    if key.exists():
        raw = key.read_text().strip()
        head = raw[:14]
        print(f"key {key}: {head}... len={len(raw)}")
    else:
        print(f"key {key}: MISSING")

print()
chats_dir = HOME / ".codifa" / "chats"
if chats_dir.exists():
    files = list(chats_dir.rglob("*.json"))
    print(f"chat files under {chats_dir}: {len(files)}")
print(f"cwd: {os.getcwd()}")
