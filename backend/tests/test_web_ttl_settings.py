"""تست TTL جداگانه‌ی کش وب/fetch از تنظیمات."""

from __future__ import annotations

import importlib

import tools as tools_mod
from state_db import _DEFAULT_SETTINGS_KEYS


def test_default_settings_keys_include_ttl():
    assert "webSearchTtlDays" in _DEFAULT_SETTINGS_KEYS
    assert "fetchUrlTtlDays" in _DEFAULT_SETTINGS_KEYS
    assert "ragWebTtlDays" in _DEFAULT_SETTINGS_KEYS


def test_web_cache_ttl_default_7_days(monkeypatch):
    monkeypatch.setattr(tools_mod._state_db, "get_settings", dict)
    importlib.reload(tools_mod)
    try:
        assert tools_mod._web_cache_ttl() == 7 * 86400
        assert tools_mod._fetch_cache_ttl() == 7 * 86400
    finally:
        importlib.reload(tools_mod)


def test_web_cache_ttl_from_settings(monkeypatch):
    monkeypatch.setattr(
        tools_mod._state_db,
        "get_settings",
        lambda: {"webSearchTtlDays": 14, "fetchUrlTtlDays": 30},
    )
    importlib.reload(tools_mod)
    try:
        assert tools_mod._web_cache_ttl() == 14 * 86400
        assert tools_mod._fetch_cache_ttl() == 30 * 86400
    finally:
        importlib.reload(tools_mod)


def test_rag_web_ttl_constant():
    from vector_store import RAG_WEB_TTL_DAYS

    assert RAG_WEB_TTL_DAYS == 90
