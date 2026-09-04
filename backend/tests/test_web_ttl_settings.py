"""تست‌های مرتبط با TTL کش وب/فچ و RAG — بعد از ادغام تنظیمات."""

from state_db import _DEFAULT_SETTINGS_KEYS
from tools import _fetch_cache_ttl, _web_cache_ttl


class TestSettingsKeys:
    def test_default_settings_keys_include_ttl(self):
        """فقط ragWebTtlDays باید در تنظیمات باشه (web/fetch حذف شدن)."""
        assert "ragWebTtlDays" in _DEFAULT_SETTINGS_KEYS
        assert "webSearchTtlDays" not in _DEFAULT_SETTINGS_KEYS
        assert "fetchUrlTtlDays" not in _DEFAULT_SETTINGS_KEYS


class TestWebCacheTtl:
    def test_web_cache_ttl_default_90_days(self):
        """پیش‌فرض TTL وب/فچ ۹۰ روز باشه (نه ۷ روز قدیم)."""
        assert _web_cache_ttl() == 90 * 86400

    def test_fetch_cache_ttl_default_90_days(self):
        """پیش‌فرض TTL فچ ۹۰ روز باشه."""
        assert _fetch_cache_ttl() == 90 * 86400

    def test_web_cache_ttl_from_settings(self, monkeypatch):
        """TTL از ragWebTtlDays خونده بشه."""
        import state_db as _state_db

        monkeypatch.setattr(
            _state_db,
            "get_settings",
            lambda: {"ragWebTtlDays": 42},
        )
        assert _web_cache_ttl() == 42 * 86400

    def test_fetch_cache_ttl_from_settings(self, monkeypatch):
        """TTL فچ هم از ragWebTtlDays خونده بشه."""
        import state_db as _state_db

        monkeypatch.setattr(
            _state_db,
            "get_settings",
            lambda: {"ragWebTtlDays": 42},
        )
        assert _fetch_cache_ttl() == 42 * 86400

    def test_web_cache_ttl_no_legacy_keys(self, monkeypatch):
        """حتی اگه کلیدهای قدیمی webSearchTtlDays/fetchUrlTtlDays در settings باشن،
        TTL باید از ragWebTtlDays بیاد (یا پیش‌فرض ۹۰ اگه نیست)."""
        import state_db as _state_db

        monkeypatch.setattr(
            _state_db,
            "get_settings",
            lambda: {"webSearchTtlDays": 14, "fetchUrlTtlDays": 30},
        )
        # ragWebTtlDays نیست → پیش‌فرض ۹۰
        assert _web_cache_ttl() == 90 * 86400
        assert _fetch_cache_ttl() == 90 * 86400


class TestRagWebStore:
    def test_rag_web_ttl_uses_config_not_constant(self, tmp_path):
        """TTL وب باید از config.ttl_days (تنظیمات کاربر) بیاد، نه ثابت hardcode."""
        from vector_store import (
            _VEC_SUFFIX,
            WEB_RAG_FILENAME_STEM,
            StoreConfig,
            VectorStore,
        )

        db_path = str(tmp_path / f"{WEB_RAG_FILENAME_STEM}{_VEC_SUFFIX}")
        cfg = StoreConfig.from_dict({"ttl_days": 30, "max_docs": 500, "max_chunks": 4000})
        store = VectorStore(db_path, cfg)
        assert store.config.ttl_days == 30
        store.close()
