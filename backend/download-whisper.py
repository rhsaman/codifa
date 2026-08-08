"""Download the local Whisper (faster-whisper / CTranslate2) model into
backend/whisper/ so voice input works fully offline.

Usage:
    uv run --project backend python scripts/download-whisper.py
"""

from __future__ import annotations

import argparse
import os

PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(PARENT, "backend", "whisper")
REPO = "Systran/faster-whisper-medium"


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the on-device Whisper model")
    parser.add_argument("--repo", default=REPO, help="HuggingFace repo id")
    parser.add_argument("--dest", default=DEST, help="Destination directory")
    args = parser.parse_args()

    if os.path.isdir(args.dest) and any(
        os.path.getsize(os.path.join(args.dest, f)) > 0
        for f in os.listdir(args.dest)
        if os.path.isfile(os.path.join(args.dest, f))
    ):
        print(f"Model already present at {args.dest} — skipping download.")
        return 0

    try:
        from huggingface_hub import snapshot_download
    except ImportError:  # pragma: no cover
        print("huggingface_hub is not installed. Run `npm run setup` first.")
        return 1

    os.makedirs(args.dest, exist_ok=True)
    print(f"Downloading {args.repo} -> {args.dest} ...")
    snapshot_download(
        repo_id=args.repo,
        local_dir=args.dest,
        local_dir_use_symlinks=False,
    )
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())