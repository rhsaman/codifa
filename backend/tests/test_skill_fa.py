"""Persian task-signal and skill fallback tests: general verbs/nouns (not UI-only).

Covers the root cause where short Persian requests (e.g. "ui ...") carried
no English token, looked like chit-chat, and got zero skill tokens.
UI is only one parametrized row here on purpose.
"""
import graph


def _skill(name, desc="", fa=()):
    return {"name": name, "description": desc, "content": "BODY-" + name, "fa_keywords": list(fa)}


_POOL = [
    _skill("UI/UX Pro Max", "UI/UX design intelligence for web interfaces",
           ["یوآی", "رابط", "ظاهر", "دیزاین", "استایل", "چیدمان", "ریسپانسیو",
            "انیمیشن", "فونت", "رنگ", "کامپوننت", "لندینگ", "داشبورد", "فرم",
            "لاگین", "فرانت"]),
    _skill("translation", "Translate accurately between languages", ["ترجمه"]),
    _skill("summarization", "Condense long content into summaries", ["خلاصه"]),
    _skill("Test UI", "Live-test UI in a browser via playwright", ["تست", "آزمون"]),
    _skill("seo-optimization", "SEO optimization for pages", ["سئو"]),
    _skill("git-workflow", "Clean safe git workflow",
           ["کامیت", "پوش", "مرج", "شاخه", "گیت"]),
    _skill("Code-Expert", "Senior software engineering mentor for coding and debugging",
           ["دیباگ", "اشکال", "رفع", "رفکتور", "بازنویسی", "بنویس", "کد",
            "برنامه", "اپلیکیشن", "سرور", "دیتابیس", "بک‌اند"]),
    _skill("Learn from Docs", "Learn from documentation with research",
           ["داکیومنت", "مستند", "راهنما", "آموزش", "یادگیری"]),
    _skill("project-planning", "Plan projects step by step",
           ["پروژه", "برنامه‌ریزی", "پلن"]),
    _skill("professional-writing", "Professional writing for reports",
           ["نوشتن", "متن", "گزارش"]),
]


def test_fa_task_signal_true_for_general_verbs():
    for prompt in (
        "یوآی رو بهتر کن",
        "ui رو بهتر کن",
        "یه فرم لاگین کامل با اعتبارسنجی بساز",
        "این متن رو ترجمه کن",
        "این مقاله رو خلاصه کن",
        "برای این تابع تست بنویس",
        "سئوی صفحه رو بررسی کن",
        "کامیت رو پوش کن",
        "باگ سرور رو رفع کن",
        "مستندات پروژه رو راهنمایی کن",
    ):
        assert graph._turn_task_signal(prompt, []) is True, prompt
        assert graph._obvious_non_code_turn(prompt, []) is False, prompt


def test_fa_greetings_stay_chitchat():
    for prompt in ("سلام", "چطوری؟", "ممنون", "مرسی"):
        assert graph._turn_task_signal(prompt, []) is False, prompt
        assert graph._obvious_non_code_turn(prompt, []) is True, prompt


def test_fa_skill_fallback_picks_matching_skill():
    cases = [
        ("یوآی رو بهتر کن", "UI/UX Pro Max"),
        ("ui رو بهتر کن", "UI/UX Pro Max"),
        ("این متن رو ترجمه کن", "translation"),
        ("این مقاله رو خلاصه کن", "summarization"),
        ("برای این تابع تست بنویس", "Test UI"),
        ("سئوی صفحه رو بررسی کن", "seo-optimization"),
        ("کامیت رو پوش کن", "git-workflow"),
        ("باگ سرور رو رفع کن", "Code-Expert"),
        ("از روی داکیومنت یاد بگیر", "Learn from Docs"),
        ("پروژه رو پلن کن", "project-planning"),
        ("گزارش عملکرد رو آماده کن", "professional-writing"),
    ]
    for prompt, expected in cases:
        assert graph._fa_skill_fallback(prompt, _POOL) == expected, prompt


def test_fa_skill_fallback_empty_on_greeting_or_no_pool():
    assert graph._fa_skill_fallback("سلام", _POOL) == ""
    assert graph._fa_skill_fallback("یوآی رو بهتر کن", []) == ""
    assert graph._fa_skill_fallback("", _POOL) == ""


def test_fa_skill_fallback_matches_brand_new_skill_without_code_change():
    """Generic matcher: a skill added later with its own fa_keywords matches."""
    pool = [_skill("astro-deploy", "Deploy sites to the edge", ["استقرار", "دیپلوی"])]
    assert graph._fa_skill_fallback("سایت رو استقرار بده", pool) == "astro-deploy"


def test_fa_skill_fallback_matches_english_tokens_without_keywords():
    """Code-switched prompts match skill name tokens with no fa_keywords set."""
    pool = [_skill("seo-optimization", "SEO optimization for pages")]
    assert graph._fa_skill_fallback("seo سایت رو درست کن", pool) == "seo-optimization"


def test_skill_auto_pick_relaxed_threshold_still_blocks_flat_noise():
    ranked = [
        {"name": "a", "confidence": 0.74},
        {"name": "b", "confidence": 0.72},
    ]
    assert graph._skill_auto_pick(ranked, True) == ""
    ranked = [
        {"name": "UI/UX Pro Max", "confidence": 0.65},
        {"name": "other", "confidence": 0.60},
    ]
    assert graph._skill_auto_pick(ranked, True) == "UI/UX Pro Max"
