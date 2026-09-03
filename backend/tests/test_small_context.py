"""تست‌های حالت small-context (بهینه‌سازی برای مدل‌های لوکال با کانتکست کم).

هدف: مطمئن شویم که:
  * تشخیص small_ctx درست است (و مقدار 0 = نامشخص، رفتار فعلی را عوض نمی‌کند)
  * _skills_section در حالت desc_limit=0 فقط نام برمی‌گرداند (نه description)
  * _skills_section در حالت desc_limit=100 (پیش‌فرض) رفتار قبلی را حفظ می‌کند
  * _read_project_memory با max_bytes کوچک، متن بلند را trim و marker اضافه می‌کند
  * ثابت‌های آستانه و سقف‌ها مقدار معقول دارند
"""

from __future__ import annotations

import os
import tempfile
import time

import pytest

from agents import (
    _PROJECT_MEMORY_MAX_BYTES,
    _SMALL_CTX_CODE_MAP_TOKENS,
    _SMALL_CTX_PROJECT_MEMORY_MAX,
    _SMALL_CTX_RAG_MAX_CHARS,
    _SMALL_CTX_SKILL_DESC_LIMIT,
    _SMALL_CTX_THRESHOLD,
    _SMALL_CTX_TOOL_OUTPUT_MAX,
    _read_project_memory,
    _skills_section,
    is_small_context,
)

# ---- is_small_context ---------------------------------------------------


def test_is_small_context_unknown_returns_false():
    """ctx=0 (نامشخص) → False تا رفتار فعلی (full prompt) حفظ شود."""
    assert is_small_context(0) is False
    assert is_small_context(None) is False


def test_is_small_context_below_threshold():
    """ctx زیر آستانه (مثلاً 8k) → True."""
    assert is_small_context(8_000) is True
    assert is_small_context(16_000) is True
    assert is_small_context(31_999) is True


def test_is_small_context_at_threshold_returns_false():
    """مرز: دقیقاً روی آستانه (32k) → False (مدل‌های بزرگ‌تر آسیب نبینند)."""
    assert is_small_context(_SMALL_CTX_THRESHOLD) is False
    assert is_small_context(32_000) is False


def test_is_small_context_above_threshold():
    """ctx بالای آستانه (200k مثل Claude) → False."""
    assert is_small_context(200_000) is False
    assert is_small_context(128_000) is False


def test_is_small_context_handles_garbage():
    """مقادیر غیرعددی نباید کرش کنند — False برمی‌گردانند."""
    assert is_small_context("not a number") is False
    assert is_small_context(object()) is False


# ---- _skills_section ----------------------------------------------------


def test_skills_section_default_includes_description():
    """پیش‌فرض (desc_limit=100): name + description کوتاه‌شده."""
    out = _skills_section(
        [{"name": "alpha", "description": "x" * 200, "content": ""}]
    )
    assert "alpha" in out
    assert "—" in out
    assert "…" in out  # description کوتاه شد


def test_skills_section_desc_limit_zero_lists_names_only():
    """small_ctx: desc_limit=0 → فقط نام skillها، بدون description و بدون جداکنندهٔ «—»."""
    out = _skills_section(
        [
            {"name": "alpha", "description": "should not appear", "content": ""},
            {"name": "beta", "description": "nor this", "content": ""},
        ],
        desc_limit=0,
    )
    assert "- alpha" in out
    assert "- beta" in out
    assert "should not appear" not in out
    assert "nor this" not in out
    # متن هیچ description اضافه‌ای ندارد (نه «— description» نه description تنها).
    for line in out.splitlines():
        if line.startswith("- "):
            # فرمت «- name — desc» نباید وجود داشته باشد
            assert "—" not in line, f"name-only line should not contain em-dash: {line!r}"


def test_skills_section_empty_returns_empty_string():
    assert _skills_section([]) == ""
    assert _skills_section([], desc_limit=0) == ""


# ---- _read_project_memory ----------------------------------------------


def _write_agents_md(root: str, body: str) -> None:
    with open(os.path.join(root, "AGENTS.md"), "w", encoding="utf-8") as fh:
        fh.write(body)


def test_read_project_memory_short_body_not_truncated():
    """body کوتاه‌تر از max_bytes → بدون تغییر (marker اضافه نمی‌شود)."""
    with tempfile.TemporaryDirectory() as d:
        _write_agents_md(d, "short body")
        out = _read_project_memory(d, max_bytes=10_000)
        assert "short body" in out
        assert "truncated" not in out


def test_read_project_memory_long_body_truncated():
    """body بلندتر از max_bytes → trim + marker."""
    with tempfile.TemporaryDirectory() as d:
        body = "x" * 5_000
        _write_agents_md(d, body)
        out = _read_project_memory(d, max_bytes=1_000)
        # marker اضافه شده
        assert "truncated" in out
        # طول خروجی تقریباً max_bytes (با کمی margin برای marker/header)
        # ما فقط چک می‌کنیم که body اصلی تماماً داخل نیست
        # (نباید همه‌ی 5000 کاراکتر x پشت سر هم باشد)
        # marker بعد از max_bytes کاراکتر است، پس x ها ≤ max_bytes + مقداری marker
        # ساده: بخش x ها از خروجی استخراج و چک می‌کنیم
        run_of_x = "x" * 2000  # بیشتر از max_bytes
        assert run_of_x not in out


def test_read_project_memory_missing_file_returns_empty():
    """وقتی AGENTS.md نیست → خروجی خالی، بدون کرش."""
    with tempfile.TemporaryDirectory() as d:
        out = _read_project_memory(d, max_bytes=1_000)
        assert out == ""


# ---- ثابت‌ها: هم‌خوانی با طراحی ---------------------------------------


def test_small_ctx_constants_are_reasonable():
    """ثابت‌ها باید مقدار معقول داشته باشند (نه صفر، نه بیشتر از نسخهٔ عادی)."""
    assert 0 < _SMALL_CTX_THRESHOLD <= 200_000
    assert 0 < _SMALL_CTX_CODE_MAP_TOKENS <= 1024
    assert _SMALL_CTX_RAG_MAX_CHARS < 3_600
    assert _SMALL_CTX_TOOL_OUTPUT_MAX < 2_000
    assert _SMALL_CTX_PROJECT_MEMORY_MAX < _PROJECT_MEMORY_MAX_BYTES
    assert _SMALL_CTX_SKILL_DESC_LIMIT == 0


# ---- end-to-end: مسیر کامل ollama/llama.cpp → small_ctx -----------------


@pytest.mark.asyncio
async def test_ollama_8k_triggers_small_context(monkeypatch):
    """وقتی client مقدار context_window نداد، model_context از models.dev catalog
    مقدار واقعی (8192) را می‌گیرد و is_small_context فعال می‌شود."""
    import providers as P

    # فرمت صحیح catalog: provider_key → "models" → model_id → "limit" → "context"
    # timestamp باید time.time() باشد تا cache منقضی نشود و از شبکه خوانده نشود
    fake_catalog = {
        "ollama": {"models": {"qwen2.5-coder:7b": {"limit": {"context": 8192}}}}
    }
    monkeypatch.setattr(P, "_models_dev_cache", (time.time(), fake_catalog))
    monkeypatch.setattr(P, "_model_cache", {})

    ctx = await P.model_context(
        provider="ollama",
        model="qwen2.5-coder:7b",
        base_url="http://localhost:11434",
    )
    assert ctx == 8192
    assert is_small_context(ctx) is True


@pytest.mark.asyncio
async def test_llamacpp_8k_triggers_small_context(monkeypatch):
    """وقتی client مقدار context_window نداد، model_context از models.dev catalog
    مقدار llama.cpp (8192) را می‌گیرد و is_small_context فعال می‌شود."""
    import providers as P

    fake_catalog = {
        "custom": {"models": {"qwen2.5-coder-7b-q4": {"limit": {"context": 8192}}}}
    }
    monkeypatch.setattr(P, "_models_dev_cache", (time.time(), fake_catalog))
    monkeypatch.setattr(P, "_model_cache", {})

    ctx = await P.model_context(
        provider="custom",
        model="qwen2.5-coder-7b-q4",
        base_url="http://localhost:8080/v1",
    )
    assert ctx == 8192
    assert is_small_context(ctx) is True


@pytest.mark.asyncio
async def test_large_model_200k_keeps_full_prompt(monkeypatch):
    """مدل‌های بزرگ (200k) نباید small_context شوند حتی اگر model_context مقدار دهد."""
    import providers as P

    fake_catalog = {
        "ollama": {"models": {"qwen2.5-coder:32b": {"limit": {"context": 200_000}}}}
    }
    monkeypatch.setattr(P, "_models_dev_cache", (time.time(), fake_catalog))
    monkeypatch.setattr(P, "_model_cache", {})

    ctx = await P.model_context(
        provider="ollama",
        model="qwen2.5-coder:32b",
        base_url="http://localhost:11434",
    )
    assert ctx == 200_000
    assert is_small_context(ctx) is False  # بالای آستانه


@pytest.mark.asyncio
async def test_lmstudio_4k_small_context(monkeypatch):
    """LM Studio با 4k context → is_small_context فعال."""
    import providers as P

    fake_catalog = {
        "custom": {"models": {"local-model": {"limit": {"context": 4096}}}}
    }
    monkeypatch.setattr(P, "_models_dev_cache", (time.time(), fake_catalog))
    monkeypatch.setattr(P, "_model_cache", {})

    ctx = await P.model_context(
        provider="custom",
        model="local-model",
        base_url="http://localhost:1234/v1",
    )
    assert ctx == 4096
    assert is_small_context(ctx) is True


def test_is_small_context_threshold_boundary():
    """مرز آستانه (32k) باید دقیقاً false برگرداند (≤ 32k = safe)."""
    assert is_small_context(32_000) is False  # خود آستانه
    assert is_small_context(32_001) is False  # یکی بالاتر
    assert is_small_context(31_999) is True   # یکی پایین‌تر
