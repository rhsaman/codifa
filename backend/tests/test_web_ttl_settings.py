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


def test_rag_web_ttl_uses_config_not_constant(tmp_path):
    """TTL وب باید از config.ttl_days (تنظیمات کاربر) بیاد، نه ثابت hardcode.

    چون upsert_doc embedding می‌خواد (که توی محیط تست دانلود نشده)،
    ردیف‌های doc رو مستقیماً با SQL درج می‌کنیم تا فقط evict() رو تست کنیم.
    """
    import time

    from vector_store import KIND_WEB, StoreConfig, VectorStore

    cfg = StoreConfig.from_dict({"ttl_days": 30, "max_docs": 500, "max_chunks": 4000})
    store = VectorStore(str(tmp_path / "ws.sqlite"), cfg)
    now = int(time.time())
    old_ts = now - 60 * 86400
    new_ts = now - 86400
    # درج مستقیم دو doc وب (بدون نیاز به embedding)
    store._conn.execute(
        "INSERT INTO docs (key, kind, title, fetched_at, created_at, updated_at, chunk_count) "
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
        ("web:http://x", KIND_WEB, "X", old_ts, old_ts, old_ts),
    )
    store._conn.execute(
        "INSERT INTO docs (key, kind, title, fetched_at, created_at, updated_at, chunk_count) "
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
        ("web:http://y", KIND_WEB, "Y", new_ts, new_ts, new_ts),
    )
    store._conn.commit()

    removed = store.evict()
    # فقط doc قدیمی (۶۰ روزه) باید پاک بشه، نه جدید
    assert removed == 1
    remaining = store.all_doc_meta(KIND_WEB)
    assert "web:http://y" in remaining
    assert "web:http://x" not in remaining
