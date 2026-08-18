"""One-off cleanup of stale/backup files in the user data root.

Removes only clearly disposable files that the app itself regenerates:
  - coder.db.bak-*            (pre-migration SQLite backup)
  - coder.db.migrated         (migration marker)
  - settings.json.bak         (settings backup)
  - app-state-cache.json      (derived cache, rebuilt on next launch)

The active data root is resolved the same way the app resolves it:
  1. Electron's data-root.json pointer (userData dir)
  2. CODER_DATA_DIR env var
  3. default ~/.codifa

Run:  python backend/cleanup-data.py
"""

from __future__ import annotations

import glob
import json
import os
import sys

# -- resolve the active data root ------------------------------------------- #


def _electron_user_data() -> str:
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "coder-ai-assistant")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA", home), "coder-ai-assistant")
    return os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config")), "coder-ai-assistant")


def resolve_data_root() -> str:
    # 1. Electron pointer file
    try:
        ptr = os.path.join(_electron_user_data(), "data-root.json")
        if os.path.isfile(ptr):
            with open(ptr, encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict) and isinstance(raw.get("path"), str) and raw["path"].strip():
                return os.path.abspath(raw["path"])
    except Exception:  # noqa: BLE001, S110 — fall back to env/default
        pass
    # 2. env var
    env = os.environ.get("CODER_DATA_DIR", "").strip()
    if env:
        return os.path.abspath(env)
    # 3. default
    return os.path.join(os.path.expanduser("~"), ".codifa")


# -- cleanup ---------------------------------------------------------------- #


def main() -> int:
    root = resolve_data_root()
    print(f"data root: {root}")
    if not os.path.isdir(root):
        print("data root missing — nothing to do")
        return 0

    patterns = [
        os.path.join(root, "coder.db.bak-*"),
        os.path.join(root, "coder.db.migrated"),
        os.path.join(root, "settings.json.bak"),
        os.path.join(root, "app-state-cache.json"),
    ]
    removed: list[str] = []
    for pat in patterns:
        for p in glob.glob(pat):
            try:
                if os.path.isfile(p):
                    os.remove(p)
                    removed.append(p)
            except OSError as exc:
                print(f"  ! cannot remove {p}: {exc}")
    if removed:
        print("removed:")
        for p in removed:
            print(f"  - {p}")
    else:
        print("nothing to remove")
    return 0


if __name__ == "__main__":
    sys.exit(main())