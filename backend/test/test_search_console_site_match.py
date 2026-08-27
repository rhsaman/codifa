"""Unit test: تطبیق خودکار دامنهٔ گفته‌شده در چت با لیست سایت‌های حساب متصل.

این تست‌ها اطمینان می‌دهند که ابزار search_console می‌تواند دامنه‌ای را که
کاربر در چت نام می‌برد (مثلاً «سئوی hamemigan.com رو ببین») بدون نیاز به ست‌کردن
آن در تنظیمات، با ملکیت‌های ثبت‌شده در Google Search Console تطبیق دهد — حتی وقتی
فرم‌های مختلفی (sc-domain:، https://، www.) داشته باشند.
"""

from tools import _match_site, _normalize_site_key

_SITES = [
    {"siteUrl": "sc-domain:hamemigan.com"},
    {"siteUrl": "https://healerglobal.com/"},
    {"siteUrl": "https://www.example.org/"},
]


def test_normalize_strips_prefixes():
    assert _normalize_site_key("sc-domain:hamemigan.com") == "hamemigan.com"
    assert _normalize_site_key("https://www.hamemigan.com/") == "hamemigan.com"
    assert _normalize_site_key("http://Hamemigan.com") == "hamemigan.com"
    assert _normalize_site_key("  HTTPS://WWW.HAMEMIGAN.COM/  ") == "hamemigan.com"


def test_match_raw_domain():
    assert _match_site("hamemigan.com", _SITES) == "sc-domain:hamemigan.com"


def test_match_sc_domain_form():
    assert _match_site("sc-domain:hamemigan.com", _SITES) == "sc-domain:hamemigan.com"


def test_match_full_url_with_www():
    assert _match_site("https://www.hamemigan.com/", _SITES) == "sc-domain:hamemigan.com"


def test_match_case_insensitive():
    assert _match_site("HAMEMIGAN.COM", _SITES) == "sc-domain:hamemigan.com"


def test_match_subdomain_suffix():
    # دامنهٔ خام باید با زیردامنه‌های ثبت‌شده هم تطبیق کند.
    rows = [{"siteUrl": "https://blog.hamemigan.com/"}]
    assert _match_site("hamemigan.com", rows) == "https://blog.hamemigan.com/"


def test_no_match_returns_none():
    assert _match_site("notmyproperty.com", _SITES) is None


def test_empty_site_returns_none():
    assert _match_site("", _SITES) is None
