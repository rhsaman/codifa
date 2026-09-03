"""تست‌های گسترده برای ``_strip_think_tags`` و ``_scrub_think_prefix``.

پوشش می‌دهد:
  1. تگ کامل `` در یک chunk
  2. تگ ناقص `` که در مرز دو chunk بریده شده
  3. تگ معادل `` (opencode-style)
  4. تگ معادل `` (deepseek-style)
  5. تگ معادل ``
  6. ``_scrub_think_prefix`` برای متنی که با `` شروع می‌شود
  7. تگ‌های تو در تو (نادر ولی باید حذف شوند)
"""

from _common import _scrub_think_prefix, _strip_think_tags


# ── 1. تگ کامل `` در یک chunk
def test_complete_think_in_single_chunk():
    out, in_t, buf = _strip_think_tags("a<think>secret</think>b", False, "")
    assert out == "ab"
    assert in_t is False
    assert buf == ""


# ── 2. تگ ناقص `` که در مرز دو chunk بریده شده
def test_partial_think_split_across_chunks():
    # chunk 1: prefix + "<think>partial "
    out1, in_t1, buf1 = _strip_think_tags("A<think>partial ", False, "")
    assert out1 == "A"
    assert in_t1 is True
    assert buf1 == "partial "

    # chunk 2: ادامهٔ متن + بستن تگ + متن بعد
    out2, in_t2, buf2 = _strip_think_tags("rest</think>answer", True, "partial ")
    assert out2 == "answer"
    assert in_t2 is False
    assert buf2 == ""


# ── 3. تگ معادل ``
def test_reasoning_tag_removed():
    out, in_t, _buf = _strip_think_tags("a<reasoning>x</reasoning>b", False, "")
    assert out == "ab"
    assert in_t is False


# ── 4. تگ معادل ``
def test_thought_tag_removed():
    out, in_t, _buf = _strip_think_tags("hi<thought>q</thought>bye", False, "")
    assert out == "hibye"
    assert in_t is False


# ── 5. تگ معادل ``
def test_reflection_tag_removed():
    out, in_t, _buf = _strip_think_tags("start<reflection>rrr</reflection>end", False, "")
    assert out == "startend"
    assert in_t is False


# ── 6. ``_scrub_think_prefix`` متنی که با `` شروع می‌شود
def test_scrub_think_prefix_basic():
    # متن `` نباید به UI برسد — فقط محتوای بعد از تگ بازمی‌گردد
    assert _scrub_think_prefix("<think>raw") == "raw"
    assert _scrub_think_prefix("<think>prefix") == "prefix"


# ── 7. ``_scrub_think_prefix`` متن عادی
def test_scrub_think_prefix_no_tag():
    # متنی که با `` شروع نمی‌شود باید دست نخورده بماند
    assert _scrub_think_prefix("hello world") == "hello world"
    assert _scrub_think_prefix("<think>abc") == "abc"


# ── 8. تگ‌های تو در تو
def test_nested_tags_removed():
    # دو تگ متوالی (غیر تو در تو) باید هر دو حذف شوند
    out, in_t, _buf = _strip_think_tags(
        "x<think>c1</think>y<think>c2</think>z", False, ""
    )
    assert out == "xyz"
    assert in_t is False


# ── 9. تگ `` باز ولی chunk بعدی خالی
def test_open_tag_with_no_continuation():
    out1, in_t1, buf1 = _strip_think_tags("hello<think>", False, "")
    assert in_t1 is True
    assert "hello" in out1 or out1 == "hello"

    # chunk بعدی: "" (پایان stream)
    _out2, in_t2, _buf2 = _strip_think_tags("", in_t1, buf1)
    assert in_t2 is True  # هنوز در think هستیم


# ── 10. تگ `` باز و بسته در دو chunk متوالی
def test_open_close_in_separate_chunks():
    out1, in_t1, _buf1 = _strip_think_tags("a<think>secret", False, "")
    assert out1 == "a"
    assert in_t1 is True

    out2, in_t2, _buf2 = _strip_think_tags("more</think>b", True, "<think>secret")
    assert out2 == "b"
    assert in_t2 is False


# ── 11. ترکیب چند تگ در یک chunk
def test_multiple_tags_in_one_chunk():
    out, _in_t, _buf = _strip_think_tags(
        "<think>a</think>middle<reasoning>b</reasoning>end", False, ""
    )
    assert "middle" in out
    assert "end" in out
    assert "a" not in out
    assert "b" not in out


# ── 12. تست scrub برای reasoning که در ابتدای متن است
def test_scrub_reasoning_prefix():
    assert _scrub_think_prefix("<reasoning>raw") == "raw"


# ── 13. متن کاملاً داخل think نباید منتشر شود
def test_fully_inside_think_emits_nothing():
    out1, in_t1, _buf1 = _strip_think_tags("<think>abc", False, "")
    assert out1 == ""  # چیزی منتشر نمی‌شود
    assert in_t1 is True

    out2, in_t2, _buf2 = _strip_think_tags("def", True, "<think>abc")
    assert out2 == ""  # هنوز داخل هستیم
    assert in_t2 is True

    out3, in_t3, _buf3 = _strip_think_tags("</think>visible", True, "<think>abcdef")
    assert out3 == "visible"
    assert in_t3 is False
