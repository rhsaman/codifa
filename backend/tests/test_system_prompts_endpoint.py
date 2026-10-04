"""تست endpoint: GET /system-prompts

فرانت با کلیدهای canonical مودها (`ask`, `coder`, `plan`) دنبال پرامپت
سیستم می‌گردد؛ اندپوینت باید هم این کلیدها و هم aliasهای قدیمی
(`chat`, `codewriter`) را برگرداند تا ردیف System prompt در پاپ‌اور
Context windows صفر نماند.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi.testclient import TestClient

import server


def test_system_prompts_returns_canonical_keys():
    client = TestClient(server.app)
    r = client.get("/system-prompts")
    assert r.status_code == 200
    data = r.json()
    # Canonical mode keys the frontend looks up (chat.mode values).
    from agents import SYSTEM_PROMPTS

    for key in SYSTEM_PROMPTS:
        assert key in data, f"canonical key {key!r} missing from /system-prompts"
        assert data[key] == SYSTEM_PROMPTS[key]


def test_system_prompts_includes_legacy_aliases():
    client = TestClient(server.app)
    data = client.get("/system-prompts").json()
    from agents import MODE_ALIASES, SYSTEM_PROMPTS

    for alias, canonical in MODE_ALIASES.items():
        assert alias in data, f"legacy alias {alias!r} missing"
        assert data[alias] == SYSTEM_PROMPTS[canonical]
