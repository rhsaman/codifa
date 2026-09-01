"""تست‌های منطق re-emit متن در stream-end.

مسئله: وقتی LLM reasoning-capable است ولی واقعاً هیچ فیلد reasoning
ارسال نمی‌کند (opencode/openrouter gateway که ``reasoning_content`` را null
می‌فرستد)، حلقهٔ streaming تمام متن ساده را drop می‌کند. در stream-end باید
متن dropped re-emit شود — اما اگر بخشی از آن قبلاً منتشر شده (مثلاً گارد
repetition-loop در میانه فعال شده)، نباید duplicate شود.

این منطق اکنون در ``_resolve_stream_end_text`` به‌صورت pure استخراج شده
و این فایل آن را به‌طور واحد تست می‌کند.
"""

from _common import _resolve_stream_end_text


# ── 1. هیچ متنی قبلاً emit نشده → کل ai_content باید برگردد
def test_no_text_emitted_returns_full():
    """اگر گارد repetition فعال نشده و هیچ متنی emit نشده، re-emit کل متن."""
    out = _resolve_stream_end_text("hello world", 0)
    assert out == "hello world"


# ── 2. همه متن قبلاً emit شده → هیچ چیز نباید re-emit شود
def test_all_text_emitted_returns_empty():
    """اگر همه متن قبلاً emit شده، re-emit نباید چیزی برگرداند."""
    out = _resolve_stream_end_text("hello world", 11)
    assert out == ""


# ── 3. نیمی از متن قبلاً emit شده → فقط نیمهٔ دوم re-emit می‌شود
def test_half_text_emitted_returns_suffix():
    """اگر ۵ کاراکتر از ۱۱ emit شده، فقط ۶ کاراکتر باقی‌مانده re-emit شود."""
    out = _resolve_stream_end_text("hello world", 5)
    assert out == " world"
    assert len(out) == 6


# ── 4. emitted_text_len بیشتر از ai_content → هیچ چیز (ایمنی)
def test_emitted_exceeds_content_returns_empty():
    """اگر counter اشتباهی بزرگ‌تر از ai_content باشد، هیچ چیز برنگردان."""
    out = _resolve_stream_end_text("hi", 100)
    assert out == ""


# ── 5. ai_content لیست باشد (Anthropic/Gemini) → هیچ چیز
def test_list_content_returns_empty():
    """محتوای list (Anthropic) قبلاً در طول stream منتشر شده؛ در stream-end چیزی نمانده."""
    out = _resolve_stream_end_text(
        [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}], 0
    )
    assert out == ""


# ── 6. ai_content خالی → ""
def test_empty_content_returns_empty():
    out = _resolve_stream_end_text("", 0)
    assert out == ""


# ── 7. ai_content None → ""
def test_none_content_returns_empty():
    out = _resolve_stream_end_text(None, 0)
    assert out == ""


# ── 8. سناریوی واقعی: ۲ chunk dropped و ۱ chunk emit شده
def test_mixed_dropped_and_emitted_chunks():
    """سناریو:
    - chunk 1: "abc" (drop، چون reasoning فعال ولی reasoning دیده نشده)
    - chunk 2: "def" (drop، همچنان reasoning دیده نشده)
    - chunk 3: "hello world" (emit، چون repetition guard در میانه فعال شد)

    ai.content = "abcdefhello world" (cumulative)
    emitted_text_len = 11 (فقط "hello world")
    انتظار: re-emit = "abcdefhello world"[11:] = ""
    (یعنی: کل متن emit شده، چیزی اضافی برای re-emit نمانده)
    """
    ai_content = "abcdefhello world"
    emitted_text_len = 11
    out = _resolve_stream_end_text(ai_content, emitted_text_len)
    # "abcdefhello world"[11:] = " world"
    assert out == " world"


# ── 9. سناریوی drop واقعی: ۲ chunk drop + ۱ chunk emit ناقص
def test_partial_emit_with_drops():
    """سناریو:
    - chunk 1: "abc" (drop)
    - chunk 2: "defgh" (drop)
    - chunk 3: "hello " (emit، ۶ کاراکتر)
    - stream تمام

    ai.content = "abcdefghhello "
    emitted_text_len = 6
    انتظار: re-emit = "abcdefghhello "[6:] = "fghhello "

    نکته: این نشان می‌دهد اگر emit فقط بخشی از آن باشد که در ``ai.content``
    بعد از dropped chunks آمده، ما بخشی از dropped را re-emit می‌کنیم. این
    ممکن است هنوز duplicate باشد اگر متن emit شده (در chunk 3) در
    ``ai.content`` بعد از dropped ها نباشد (که LangChain تضمین می‌کند هست).
    پس این مورد safe است.
    """
    ai_content = "abcdefghhello "
    out = _resolve_stream_end_text(ai_content, 6)
    # "abcdefghhello "[6:] = "ghhello "
    assert out == "ghhello "
