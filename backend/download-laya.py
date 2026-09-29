"""Download the local Laya decision checkpoint so fast routing works offline.

Usage:
    uv run --project backend python backend/download-laya.py
    uv run --project backend python backend/download-laya.py \
        --model convaiinnovations/laya-multilingual --endpoint https://hf-mirror.com

The same download is available from the app via Settings → Models.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model_download


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the on-device Laya model")
    parser.add_argument(
        "--model",
        default=model_download.LAYA_DEFAULT_REPO,
        help="HuggingFace repo id (default: %(default)s)",
    )
    parser.add_argument(
        "--endpoint",
        default="",
        help="HF mirror endpoint, e.g. https://hf-mirror.com",
    )
    args = parser.parse_args()

    if model_download.laya_ready(args.model):
        print(f"Laya model already present ({args.model}) — skipping download.")
        return 0

    if not model_download.start_download(model_download.KIND_LAYA, args.model, args.endpoint):
        print("Could not start download (empty repo id).")
        return 1

    import time

    POLL_INTERVAL_S = 5
    print(f"Downloading {args.model} ...")
    deadline = time.time() + 3600
    while True:
        if time.time() > deadline:
            print("Download timed out after 3600s")
            return 1
        state = model_download.download_state(model_download.KIND_LAYA) or {}
        if not state:
            break
        if state.get("state") == "error":
            print(f"Download failed: {state.get('error')}")
            return 1
        time.sleep(POLL_INTERVAL_S)
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
