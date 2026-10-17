#!/usr/bin/env python3
"""Scan the data root and the Electron userData dirs for any JSON file that
looks like a settings document, so a wiped custom-provider list can be
recovered. Read-only."""
import json
import os
import pathlib
import time

HOME = pathlib.Path.home()
ROOTS = [
    HOME / ".codifa",
    HOME / ".coder",
    HOME / "Library" / "Application Support" / "codifa",
    HOME / "Library" / "Application Support" / "com.codifa.app",
]

# Directories that hold megabytes of unrelated data.
SKIP_DIRS = {
    "models", "vector-db", "browser-profile", ".venv", ".git", "node_modules",
    "uploads", "checkpoints", "traces", "memory", "crashpad", "GPUCache",
    "Cache", "Code Cache", "Service Worker", "DawnGraphiteCache", "DawnWebGPUCache",
    "Local Storage", "Session Storage", "IndexedDB", "shared_proto_db",
}

BUILTIN_IDS = {
    "openrouter", "local", "ollama", "google", "nvidia", "cloudflare",
    "tokenrouter", "openai", "anthropic",
}


def providers_of(doc):
    """Return the provider array whether the doc is flat or nested."""
    if not isinstance(doc, dict):
        return None
    if isinstance(doc.get("providers"), list):
        return doc["providers"]
    inner = doc.get("settings")
    if isinstance(inner, dict) and isinstance(inner.get("providers"), list):
        return inner["providers"]
    return None


def describe(path):
    try:
        stat = path.stat()
    except OSError:
        return
    if stat.st_size > 40 * 1024 * 1024:
        return
    try:
        doc = json.loads(path.read_text(errors="replace"))
    except Exception:  # noqa: BLE001
        return
    providers = providers_of(doc)
    if providers is None:
        return
    ids = []
    enc = 0
    for p in providers:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id"))
        ids.append(pid)
        for k in p.get("apiKeys") or []:
            if isinstance(k, str) and k.startswith("enc:"):
                enc += 1
        if isinstance(p.get("apiKey"), str) and p["apiKey"].startswith("enc:"):
            enc += 1
    custom = [i for i in ids if i not in BUILTIN_IDS]
    print(f"{time.ctime(stat.st_mtime)}  size={stat.st_size:>9}  providers={len(providers):>3} "
          f"(custom={len(custom)}, enc_keys={enc})  {path}")
    print(f"    ids: {', '.join(ids)}")
    chats = None
    if isinstance(doc, dict):
        if isinstance(doc.get("chats"), list):
            chats = len(doc["chats"])
        elif isinstance(doc.get("settings", {}), dict) is False:
            pass
    if chats is not None:
        print(f"    chats in file: {chats}")


print("=== candidate JSON documents ===")
for root in ROOTS:
    if not root.exists():
        print(f"(missing root) {root}")
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if dirpath.count(os.sep) - str(root).count(os.sep) > 2:
            dirnames[:] = []
            continue
        for name in filenames:
            if not (name.endswith(".json") or name.endswith(".bak")):
                continue
            describe(pathlib.Path(dirpath) / name)

print()
print("=== secrets key files ===")
for key in [
    HOME / "Library" / "Application Support" / "com.codifa.app" / "secrets.key",
    HOME / "Library" / "Application Support" / "codifa" / "secrets.key",
]:
    print(f"{key}: {'present' if key.exists() else 'MISSING'}")

print()
print("=== userData listings ===")
for root in [HOME / "Library" / "Application Support" / "codifa",
             HOME / "Library" / "Application Support" / "com.codifa.app"]:
    print(f"-- {root}")
    if root.exists():
        for entry in sorted(root.iterdir()):
            try:
                size = entry.stat().st_size
            except OSError:
                size = -1
            print(f"   {entry.name}  ({size})")
