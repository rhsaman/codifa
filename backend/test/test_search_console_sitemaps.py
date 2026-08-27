"""Unit test: اکشن‌های sitemaps / sitemap ابزار search_console.

این تست‌ها جریان کامل انتخاب سایت و فراخوانی endpoint نقشهٔ سایت را با
mock کردن لایه‌های خارجی (تنظیمات، توکن گوگل، httpx) چک می‌کنند — بدون نیاز
به حساب گوگل واقعی.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import tools


class _FakeClient:
    """جایگزین سادهٔ httpx.AsyncClient برای تست (با پشتیبانی async with)."""

    def __init__(self, get_handler, post_handler=None):
        self._get = get_handler
        self._post = post_handler or (lambda u, j: {})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = self._get(url)
        return resp

    async def post(self, url, headers=None, json=None):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = self._post(url, json)
        return resp


def _make_client(get_handler, post_handler=None):
    """ساخت یک AsyncClientِ fake که GET/POST را به هندلرهای داده‌شده واگذار کند."""
    return _FakeClient(get_handler, post_handler)


def _settings_with_site(site_url=""):
    return {
        "searchConsole": {
            "clientId": "cid",
            "clientSecret": "csec",
            "refreshToken": "rtok",
            "siteUrl": site_url,
        }
    }


async def _run_sitemaps(action, site="", feedpath="", site_url=""):
    settings = _settings_with_site(site_url)

    def _fake_get(url):
        if url.endswith("/sites"):
            return {
                "siteEntry": [
                    {"siteUrl": "sc-domain:hamemigan.com"},
                    {"siteUrl": "https://healerglobal.com/"},
                ]
            }
        if url.endswith("/sitemaps"):
            return {
                "sitemap": [
                    {
                        "path": "https://hamemigan.com/sitemap.xml",
                        "status": "SUCCESS",
                        "submitted": 120,
                        "indexed": 118,
                        "lastDownloaded": "2026-08-26T10:00:00Z",
                        "lastSubmitted": "2026-08-25T10:00:00Z",
                        "warnings": "0",
                        "errors": "0",
                        "contents": [
                            {"type": "web", "submitted": 100, "indexed": 98},
                            {"type": "image", "submitted": 20, "indexed": 20},
                        ],
                    }
                ]
            }
        return {}

    client = _make_client(_fake_get)

    with patch.object(tools, "_state_db") as st, patch.object(
        tools, "decrypt_secret", side_effect=lambda v: v
    ), patch.object(
        tools._providers,
        "google_access_token",
        AsyncMock(return_value="TOK"),
    ), patch("httpx.AsyncClient", side_effect=lambda *a, **k: client):
        st.get_settings.return_value = settings
        impl = tools.make_tool_callbacks(
            root="/tmp", emit=lambda _e: None, main_model=None
        )
        fn = impl["search_console"]
        return await fn(
            action=action, site=site, feedpath=feedpath
        )


def test_sitemaps_lists_feed_for_named_site():
    out = asyncio.run(_run_sitemaps("sitemaps", site="hamemigan.com"))
    assert "Sitemaps for sc-domain:hamemigan.com" in out
    assert "https://hamemigan.com/sitemap.xml" in out
    assert "120 submitted" in out
    assert "118 indexed" in out


def test_sitemap_detail_reports_per_type_counts():
    out = asyncio.run(
        _run_sitemaps(
            "sitemap",
            site="hamemigan.com",
            feedpath="https://hamemigan.com/sitemap.xml",
        )
    )
    assert "Sitemap: https://hamemigan.com/sitemap.xml" in out
    assert "status: SUCCESS" in out
    assert "per-type URL counts:" in out
    assert "web: 100 submitted, 98 indexed" in out
    assert "image: 20 submitted, 20 indexed" in out


def test_sitemap_without_feedpath_errors():
    out = asyncio.run(_run_sitemaps("sitemap", site="hamemigan.com"))
    assert "Invalid feedpath" in out


def test_sitemap_unknown_feedpath_lists_available():
    out = asyncio.run(
        _run_sitemaps(
            "sitemap",
            site="hamemigan.com",
            feedpath="https://hamemigan.com/missing.xml",
        )
    )
    assert "not found" in out
    assert "https://hamemigan.com/sitemap.xml" in out
