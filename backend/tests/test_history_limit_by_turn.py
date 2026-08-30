"""تست‌های واحد برای helper برش history بر اساس «N رفت‌وبرگشت» (UI وعده می‌دهد).

این فایل رفتار ``_slice_history_by_turns`` را قفل می‌کند تا اطمینان حاصل شود
که تنظیم General → historyLimit در عمل نیمی از مقدار تنظیم‌شده نگه نمی‌دارد
و برش هیچ‌وقت وسط یک جفت user/assistant نمی‌افتد.
"""

import graph


def _h(*items):
    """ساخت history آزمایشی: آرگومان‌ها به شکل ``("user", "hi")`` یا
    ``("assistant", "reply")`` یا ``("system", "note")``.
    """
    return [{"role": r, "content": c} for r, c in items]


def test_basic_three_turns_keeps_six_entries_not_three():
    """۵ turn کامل (هرکدام ۲ entry)؛ n=3 باید ۶ entry نگه دارد نه ۳ entry."""
    h = []
    for i in range(5):
        h.append({"role": "user", "content": f"u{i}"})
        h.append({"role": "assistant", "content": f"a{i}"})
    out = graph._slice_history_by_turns(h, 3)
    # ۳ turn اخیر = ۶ entry آخر
    assert out == h[-6:]
    assert out[0]["role"] == "user"
    assert out[-1]["role"] == "assistant"
    assert len(out) == 6


def test_slice_always_starts_with_user():
    """خروجی helper باید همیشه با یک entry ``user`` شروع شود تا برش وسط
    یک جفت user/assistant نیفتد (این تضمین اصلی فیکس است)."""
    h = _h(
        ("user", "u1"),
        ("assistant", "a1"),
        ("user", "u2"),
        ("assistant", "a2"),
        ("user", "u3"),
        ("assistant", "a3"),
    )
    out = graph._slice_history_by_turns(h, 2)
    assert out[0]["role"] == "user"
    assert out[0]["content"] == "u2"
    assert len(out) == 4  # u2, a2, u3, a3


def test_n_larger_than_user_count_returns_whole_history():
    """اگر n از تعداد userهای واقعی بیشتر باشد، همهٔ history برمی‌گردد تا
    caller بفهمد چیزی برای trim کردن وجود ندارد."""
    h = _h(("user", "u1"), ("assistant", "a1"))
    out = graph._slice_history_by_turns(h, 10)
    assert out == h
    assert len(out) == len(h)


def test_system_entry_attached_to_last_turn_is_kept():
    """system entry بعد از آخرین reply (مثل mode-switch notice) باید به‌عنوان
    بخشی از همان turn آخر نگه داشته شود، نه اینکه از سهم n کم شود."""
    h = _h(
        ("user", "u1"),
        ("assistant", "a1"),
        ("user", "u2"),
        ("assistant", "a2"),
        ("system", "[Mode switched to plan]"),
    )
    out = graph._slice_history_by_turns(h, 1)
    # فقط turn آخر (u2/a2) + system notice چسبیده به آن
    assert out == h[2:]
    assert out[-1]["role"] == "system"
    assert len(out) == 3


def test_system_entry_between_turns_drops_with_older_turn():
    """system entry بین دو turn (مثلاً compaction summary بین turn قدیمی و
    turn بعدی) وقتی turn قدیمی‌تر trim شود، system entry هم همراهش می‌رود."""
    h = _h(
        ("user", "u1"),
        ("assistant", "a1"),
        ("system", "[Compacted earlier context]"),
        ("user", "u2"),
        ("assistant", "a2"),
    )
    out = graph._slice_history_by_turns(h, 1)
    # فقط turn آخر (u2/a2)
    assert out == h[3:]
    assert all(e["role"] != "system" for e in out)


def test_n_zero_returns_whole_history():
    """n=0 یعنی «بدون محدودیت» → کل history برگردد."""
    h = _h(("user", "u1"), ("assistant", "a1"))
    assert graph._slice_history_by_turns(h, 0) == h


def test_empty_history_returns_empty():
    """history خالی با هر n باید خالی برگردد (و خطا ندهد)."""
    assert graph._slice_history_by_turns([], 5) == []
    assert graph._slice_history_by_turns([], 0) == []


def test_history_without_any_user_returns_whole():
    """اگر هیچ entry با role=='user' نباشد (فقط system/assistant)، همه چیز
    نگه داشته شود؛ helper قرار نیست history را خالی کند."""
    h = _h(("system", "note"), ("assistant", "orphan"))
    out = graph._slice_history_by_turns(h, 3)
    assert out == h


def test_odd_n_does_not_split_mid_pair():
    """تضمین حیاتی: حتی وقتی n فرد باشد و history هم تعداد فرد entry داشته
    باشد، slice نباید وسط جفت user/assistant بیفتد (یعنی نباید با assistant
    شروع شود)."""
    h = _h(("user", "u1"), ("assistant", "a1"), ("user", "u2"))
    out = graph._slice_history_by_turns(h, 1)
    # آخرین user = u2 در index 2 → slice از u2 تا انتها (فقط u2، نه a1)
    assert out == h[2:]
    assert out[0]["role"] == "user"
    assert len(out) == 1


def test_n_exact_user_count_returns_all():
    """وقتی n دقیقاً برابر تعداد user باشد، helper کل history را برمی‌گرداند
    (همان رفتار n بزرگ‌تر، ولی در نقطهٔ مرزی)."""
    h = _h(("user", "u1"), ("assistant", "a1"), ("user", "u2"), ("assistant", "a2"))
    out = graph._slice_history_by_turns(h, 2)
    assert out == h


def test_large_history_keeps_exact_n_turns():
    """history بلند (۲۰ turn = ۴۰ entry)؛ n=10 باید دقیقاً ۱۰ turn (۲۰ entry)
    از انتها نگه دارد، نه ۱۰ entry."""
    h = []
    for i in range(20):
        h.append({"role": "user", "content": f"u{i}"})
        h.append({"role": "assistant", "content": f"a{i}"})
    out = graph._slice_history_by_turns(h, 10)
    assert len(out) == 20
    # اولین entry باید user شماره ۱۰ باشد
    assert out[0] == {"role": "user", "content": "u10"}
    assert out[-1] == {"role": "assistant", "content": "a19"}
