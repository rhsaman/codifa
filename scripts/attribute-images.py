#!/usr/bin/env python3
"""Attribute the renderer's graphics memory to image bitmaps vs DOM layers.

A `data:image/...;base64` in a message is decoded by WebKit into an uncompressed
bitmap of 4 bytes per pixel. A 3000x2000 screenshot is 2 MB as JPEG but 24 MB
decoded, and it is held for as long as the <img> is in the document. This script
reports how much decoded-bitmap memory the stored chats can account for, so the
renderer's "owned unmapped (graphics)" can be attributed to images or to DOM
compositing instead of guessed at.

Usage:
    python3 scripts/attribute-images.py [data_dir]
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

BYTES_PER_BITMAP_PIXEL = 4


def iter_bodies(root: str):
    for path in glob.glob(os.path.join(root, "chats", "**", "*.json"), recursive=True):
        try:
            yield path, json.load(open(path))
        except Exception:
            continue


def dataurl_dims(url: str) -> tuple[int, int] | None:
    """Read width/height out of a data URL without a decoder.

    Scans the first bytes of the base64 payload for a PNG IHDR or a JPEG SOFn
    marker; returns None when the format is neither (webp/gif are skipped rather
    than guessed).
    """
    try:
        head = url.split(",", 1)[1]
    except IndexError:
        return None
    import base64

    try:
        raw = base64.b64decode(head[:200000] + "=" * (-len(head[:200000]) % 4), validate=False)
    except Exception:
        return None
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    # JPEG: walk segments looking for SOF0..SOF3 / SOF5..SOF15
    i = 2
    while i + 9 < len(raw):
        if raw[i] != 0xFF:
            i += 1
            continue
        marker = raw[i + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = int.from_bytes(raw[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            h = int.from_bytes(raw[i + 5 : i + 7], "big")
            w = int.from_bytes(raw[i + 7 : i + 9], "big")
            return w, h
        i += 2 + seg_len
    return None


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.codifa")
    print(f"data root: {root}\n")
    per_chat = []
    total_bytes = 0
    total_bitmap = 0
    total_imgs = 0
    unknown = 0

    for path, body in iter_bodies(root):
        msgs = body.get("messages")
        if not isinstance(msgs, list):
            continue
        n_imgs = 0
        b64_bytes = 0
        bitmap = 0
        for m in msgs:
            if not isinstance(m, dict):
                continue
            for img in m.get("images") or []:
                if not isinstance(img, dict):
                    continue
                url = img.get("dataUrl")
                if not isinstance(url, str) or not url.startswith("data:"):
                    continue
                n_imgs += 1
                b64_bytes += len(url)
                dims = dataurl_dims(url)
                if dims:
                    bitmap += dims[0] * dims[1] * BYTES_PER_BITMAP_PIXEL
                else:
                    unknown += 1
        if n_imgs:
            per_chat.append(
                (bitmap, b64_bytes, n_imgs, str(body.get("title") or body.get("id"))[:44])
            )
            total_bytes += b64_bytes
            total_bitmap += bitmap
            total_imgs += n_imgs

    per_chat.sort(reverse=True)
    print(f"{'decoded':>10} {'base64':>10} {'imgs':>5}  chat")
    for bitmap, b64, n, title in per_chat[:12]:
        print(f"{bitmap / 1048576:9.1f}M {b64 / 1048576:9.1f}M {n:>5}  {title}")
    print("  " + "-" * 52)
    print(
        f"{total_bitmap / 1048576:9.1f}M {total_bytes / 1048576:9.1f}M {total_imgs:>5}  ALL CHATS"
    )
    if unknown:
        print(f"  (+{unknown} image(s) of an unsupported format, not counted)")
    print(
        f"\nDecoded bitmaps for ONE chat are held while it is open; the renderer\n"
        f"cannot be below that figure. Largest single chat: "
        f"{per_chat[0][0] / 1048576:.1f} MB decoded" if per_chat else "no images"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
