"""تست اعلام مد برای reader (مد داخلی چهارم).

reader مد واقعیِ چهارم سیستمه که فقط ایجنت از طریق دستور /reader یا اشاره به
فایل فعالش می‌کنه. چون قبلاً در _MODE_LABELS/_MODE_CAPS/_MODE_OUTPUT جا مانده
بود، اعلام مدش از مقدار پیش‌فرضِ ضعیف استفاده می‌کرد. این تست‌ها چک می‌کنن که
حالا توانایی و قرارداد خروجیِ اختصاصی reader صریحاً اعلام می‌شه.
"""

from agents import _mode_declare


def test_reader_declares_its_own_label_not_fallback():
    note = _mode_declare("reader")
    assert "=== CURRENT MODE: Reader ===" in note
    # نباید از برچسب پیش‌فرض (capitalize) استفاده کنه
    assert "=== CURRENT MODE: Reader ===" in note
    assert "CURRENT MODE: Ask" not in note


def test_reader_declares_focused_reader_caps():
    note = _mode_declare("reader")
    assert "FOCUSED CODE READER" in note
    assert "pointed you at specific file" in note
    # نباید تواناییِ مد دیگه‌ای (مثل mentor/planner) رو ادعا کنه
    assert "read-only MENTOR" not in note
    assert "read-only PLANNER" not in note


def test_reader_declares_scoped_output_contract():
    note = _mode_declare("reader")
    assert "OUTPUT CONTRACT FOR THIS MODE" in note
    assert "file:line references" in note
    assert "scoped to the referenced files" in note


def test_reader_note_includes_history_mode_tags_guidance():
    note = _mode_declare("reader")
    assert "HISTORY MODE TAGS" in note
    assert "[Mode: X]" in note


def test_all_four_modes_declare_distinct_caps():
    notes = {m: _mode_declare(m) for m in ("ask", "plan", "coder", "reader")}
    # هر چهار مد باید برچسب متفاوت و تواناییِ متمایز داشته باشن
    assert notes["ask"] != notes["plan"] != notes["coder"] != notes["reader"]
    for m, note in notes.items():
        assert f"=== CURRENT MODE: {m.capitalize()} ===" in note
