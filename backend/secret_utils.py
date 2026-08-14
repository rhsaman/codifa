"""Decrypt secrets the Electron renderer stores encrypted in settings.json.

API keys / OAuth client id + secret / refresh tokens are encrypted at rest with
AES-256-GCM (``enc:v1:<b64 iv>.<b64 ciphertext+tag>``). The key comes from the
Electron main process via the ``CODER_SECRET_KEY`` env var (in-memory only);
the renderer and the sidecar share the same key at runtime. Legacy plaintext
values pass through untouched.
"""

from __future__ import annotations

import os

_ENC_PREFIX = "enc:v1:"


def decrypt_secret(value: str) -> str:
    """Decrypt a stored secret; plaintext (legacy) values are returned as-is."""
    value = (value or "").strip()
    if not value or not value.startswith(_ENC_PREFIX):
        return value
    key_b64 = os.environ.get("CODER_SECRET_KEY", "").strip()
    if not key_b64:
        return ""
    try:
        from base64 import b64decode

        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        body = value[len(_ENC_PREFIX):]
        iv_b64, ct_b64 = body.split(".", 1)
        iv = b64decode(iv_b64)
        ct = b64decode(ct_b64)
        plaintext = AESGCM(b64decode(key_b64)).decrypt(iv, ct, None)
        return plaintext.decode("utf-8")
    except Exception:  # noqa: BLE001 - never surface ciphertext/decrypt internals
        return ""
