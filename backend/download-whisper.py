"""Download the local Whisper (faster-whisper / CTranslate2) model into
backend/whisper/ so voice input works fully offline.

Usage:
    uv run --project backend python backend/download-whisper.py
    uv run --project backend python backend/download-whisper.py \
        --model Systran/faster-whisper-medium --endpoint https://hf-mirror.com

The same download is available from the app via Settings → Models.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model_download


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the on-device Whisper model")
    parser.add_argument(
        "--model",
        default=model_download.WHISPER_DEFAULT_REPO,
        help="HuggingFace repo id (default: %(default)s)",
    )
    parser.add_argument(
        "--endpoint",
        default="",
        help="HF mirror endpoint, e.g. https://hf-mirror.com",
    )
    args = parser.parse_args()

    if model_download.whisper_ready():
        suffix = f" ({model_download.whisper_dir()})" if args.model == model_download.WHISPER_DEFAULT_REPO else ""
        print(f"Whisper model already present at {model_download.whisper_dir()} — skipping download{suffix}.")
        return 0

    if not model_download.start_download(model_download.KIND_WHISPER, args.model, args.endpoint):
        print("Could not start download (empty repo id).")
        return 1

    import time

    print(f"Downloading {args.model} -> {model_download.whisper_dir()} ...")
    while True:
        state = model_download.download_state(model_download.KIND_WHISPER) or {}
        if not state:
            break
        if state.get("state") == "error":
            print(f"Download failed: {state.get('error')}")
            return 1
        time.sleep(1)
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())