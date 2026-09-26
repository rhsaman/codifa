"""Unit tests: پاک‌سازی options ابزار ask_user (``_clean_ask_options``).

رگرسیونِ گزارش‌شده (اسکرین‌شات): مدل آرایهٔ options را خراب تولید کرده بود —
یک گزینهٔ چسبیده با کوتیشن‌های جداکنندهٔ داخلی، به‌همراه «"git integration"»
با کوتیشن خام که ۴ بار تکرار شده بود. پاک‌ساز باید همهٔ این‌ها را قبل از
emit رویداد ask اصلاح کند.
"""

from tools import _clean_ask_options


def test_strips_outer_quotes_nested():
    assert _clean_ask_options(['"git integration"', "«گزینه»", '""double""']) == [
        "git integration",
        "گزینه",
        "double",
    ]


def test_dedupes_case_insensitive():
    assert _clean_ask_options(["Status", '"status"', "STATUS", "branch"]) == [
        "Status",
        "branch",
    ]


def test_screenshot_regression_glued_blob_and_duplicates():
    """دقیقاً همان ورودی اسکرین‌شات: blob چسبیده + ۴ تکرار با کوتیشن خام."""
    raw = [
        'گدوم کامل"برگریستات"status"commit", diff view, branch, status"checkpoint/undo"',
        '"git integration"',
        '"git integration"',
        '"git integration"',
        '"git integration"',
    ]
    assert _clean_ask_options(raw) == [
        "گدوم کامل",
        "برگریستات",
        "status",
        "commit",
        "diff view, branch, status",
        "checkpoint/undo",
        "git integration",
    ]


def test_keeps_normal_quoted_phrase_intact():
    # فقط ۲ کوتیشن داخلی → عبارت عادی است و نباید بشکند.
    assert _clean_ask_options(['Use "strict" mode']) == ['Use "strict" mode']


def test_coerces_non_string_items_and_drops_empty():
    assert _clean_ask_options([{"x": 1}, None, 5, "   ", "ok"]) == [
        '{"x": 1}',
        "5",
        "ok",
    ]


def test_string_options_input_parsed():
    assert _clean_ask_options('["a", "b"]') == ["a", "b"]
    assert _clean_ask_options("just one") == ["just one"]


def test_caps_option_count():
    assert _clean_ask_options([f"opt{i}" for i in range(12)]) == [
        f"opt{i}" for i in range(8)
    ]


def test_none_and_all_empty():
    assert _clean_ask_options(None) == []
    assert _clean_ask_options([]) == []
    assert _clean_ask_options(['""', "  "]) == []
