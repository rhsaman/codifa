"""تست واحد برای پارسر JSON داخل ``_rg_search`` در tools.py.

این تست ``subprocess.run`` را mock می‌کند تا یک stream مصنوعی از ``rg --json``
تزریق کنیم (شامل رویدادهای ``match`` و ``context`` به ترتیبی که rg واقعی
تولید می‌کند)، و سپس رفتار context_lines را بررسی می‌کنیم.

رگرسیون هدف (قبل از فیکس):
    1. خط match واقعی هرگز در ``context_lines`` نبود ⇒ marker ``>`` در
       ``grep_tool`` dead code بود و مدل مجبور به ``read`` اضافه می‌شد.
    2. context قبل از اولین match drop می‌شد (شرط ``and matches`` fail).
    3. context بین دو match به match قبلی می‌چسبید (mis-assigned).
"""
import json
import os
import subprocess
import tempfile

import tools


# یک نمونه‌ی CompletedProcess برای تزریق به mock
class _FakeProc:
    def __init__(self, stdout: str, returncode: int = 0):
        self.stdout = stdout
        self.stderr = ""
        self.returncode = returncode


def _mk_match(path: str, line_no: int, text: str) -> str:
    """ساخت یک خط JSON معتبر که rg برای هر match تولید می‌کند."""
    return json.dumps(
        {
            "type": "match",
            "data": {
                "path": {"text": path},
                "lines": {"text": text + "\n"},
                "line_number": line_no,
                "absolute_offset": line_no,
                "submatches": [{"match": {"text": text}, "start": 0, "end": len(text)}],
            },
        }
    )


def _mk_context(path: str, line_no: int, text: str) -> str:
    """ساخت یک خط JSON معتبر که rg برای هر context line تولید می‌کند."""
    return json.dumps(
        {
            "type": "context",
            "data": {
                "path": {"text": path},
                "lines": {"text": text + "\n"},
                "line_number": line_no,
                "submatches": [],
            },
        }
    )


def _run_with_fake_rg(monkeypatch, fake_stdout: str, tmp_root: str, ctx: int = 3):
    """``subprocess.run`` را طوری mock می‌کند که stream JSON مصنوعی
    برگرداند؛ سپس ``_rg_search`` را صدا می‌زند."""
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return _FakeProc(stdout=fake_stdout, returncode=0)

    # ماژول tools در سطح ماژول ``subprocess`` را می‌بیند (نه ``tools.subprocess``)،
    # پس monkeypatch روی خود ``subprocess`` اعمال می‌کنیم.
    monkeypatch.setattr(subprocess, "run", fake_run)
    # مسیر rg را طوری جعل می‌کنیم که ``shutil.which`` غیر-None برگرداند.
    monkeypatch.setattr(tools.shutil, "which", lambda name: "/usr/bin/rg" if name == "rg" else None)
    return tools._rg_search(tmp_root, "TARGET", "", ctx=ctx, include=""), calls


def _make_tmp_root():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    return root


# ---------------------------------------------------------------------------
# ۱. خط match واقعی باید در context_lines باشد
# ---------------------------------------------------------------------------


def test_match_line_is_in_context_lines(monkeypatch):
    """رگرسیون: خط match باید در context_lines باشد تا marker ``>``
    در grep_tool trigger شود."""
    root = _make_tmp_root()
    stream = "\n".join(
        [
            _mk_context("a.py", 10, "a10"),
            _mk_context("a.py", 11, "a11"),
            _mk_context("a.py", 12, "a12"),
            _mk_match("a.py", 13, "def first():"),
            _mk_context("a.py", 14, "    pass"),
            _mk_context("a.py", 15, "c1"),
            _mk_context("a.py", 16, "c2"),
        ]
    )
    result, _ = _run_with_fake_rg(monkeypatch, stream, root)
    matches = result["matches"]
    assert len(matches) == 1
    m = matches[0]
    assert m["line"] == 13
    assert m["text"] == "def first():"
    # همهٔ context_lines باید خط 13 (match) را شامل شوند
    line_numbers = [c["line"] for c in m["context_lines"]]
    assert 13 in line_numbers, (
        f"match line 13 باید در context_lines باشد (تا marker > کار کند)، ولی شد: {line_numbers}"
    )
    # marker شرط: cl['line'] == m['line']
    assert any(
        c["line"] == m["line"] and c["text"] == m["text"] for c in m["context_lines"]
    ), "خط match با متن دقیق باید در context_lines باشد"


# ---------------------------------------------------------------------------
# ۲. context قبل از اولین match نباید drop شود
# ---------------------------------------------------------------------------


def test_context_before_first_match_is_kept(monkeypatch):
    """رگرسیون: context قبل از اولین match قبلاً drop می‌شد چون شرط
    ``and matches`` fail می‌کرد. حالا باید در context_lines اولین match باشد."""
    root = _make_tmp_root()
    stream = "\n".join(
        [
            _mk_context("a.py", 8, "a8"),
            _mk_context("a.py", 9, "a9"),
            _mk_context("a.py", 10, "a10"),
            _mk_match("a.py", 11, "def first():"),
            _mk_context("a.py", 12, "    pass"),
        ]
    )
    result, _ = _run_with_fake_rg(monkeypatch, stream, root)
    matches = result["matches"]
    assert len(matches) == 1
    line_numbers = [c["line"] for c in matches[0]["context_lines"]]
    # قبلاً خطوط 8، 9، 10 drop می‌شدند
    assert 8 in line_numbers, f"context قبل از match اول drop شد: {line_numbers}"
    assert 9 in line_numbers, f"context قبل از match اول drop شد: {line_numbers}"
    assert 10 in line_numbers, f"context قبل از match اول drop شد: {line_numbers}"
    # و match خودش هم هست
    assert 11 in line_numbers


# ---------------------------------------------------------------------------
# ۳. context بین دو match به match دوم (before-context آن) می‌چسبد
# ---------------------------------------------------------------------------


def test_context_between_two_matches_attaches_to_next(monkeypatch):
    """رگرسیون: context بین دو match (مثلاً خطوط 30-32 قبل از match در خط 33)
    قبلاً به match اول misassign می‌شد. حالا باید before-context match دوم باشد."""
    root = _make_tmp_root()
    stream = "\n".join(
        [
            _mk_context("a.py", 8, "a8"),
            _mk_context("a.py", 9, "a9"),
            _mk_context("a.py", 10, "a10"),
            _mk_match("a.py", 11, "def first():"),
            _mk_context("a.py", 12, "    pass"),
            _mk_context("a.py", 13, "c1"),
            _mk_context("a.py", 14, "c2"),
            # فاصلهٔ بزرگ، سپس before-context برای match دوم
            _mk_context("a.py", 30, "c18"),
            _mk_context("a.py", 31, "c19"),
            _mk_context("a.py", 32, "c20"),
            _mk_match("a.py", 33, "def second():"),
            _mk_context("a.py", 34, "    pass"),
        ]
    )
    result, _ = _run_with_fake_rg(monkeypatch, stream, root)
    matches = result["matches"]
    assert len(matches) == 2

    first = matches[0]
    second = matches[1]
    assert first["line"] == 11
    assert second["line"] == 33

    first_lines = [c["line"] for c in first["context_lines"]]
    second_lines = [c["line"] for c in second["context_lines"]]

    # match اول فقط before-context خودش (8-10) و خودش (11) و after-context (12-14) دارد
    assert 8 in first_lines and 9 in first_lines and 10 in first_lines
    assert 11 in first_lines
    assert 12 in first_lines and 13 in first_lines and 14 in first_lines
    # match اول نباید خطوط 30-32 را داشته باشد (آن‌ها before-context match دوم است)
    assert 30 not in first_lines, (
        f"context بین دو match به match اول misassign شد: {first_lines}"
    )
    assert 31 not in first_lines
    assert 32 not in first_lines

    # match دوم باید before-context خودش (30-32) و خودش (33) و after-context (34) داشته باشد
    assert 30 in second_lines, (
        f"before-context match دوم attach نشد: {second_lines}"
    )
    assert 31 in second_lines
    assert 32 in second_lines
    assert 33 in second_lines  # خود match
    assert 34 in second_lines  # after-context


# ---------------------------------------------------------------------------
# ۴. context بعد از match همان after-context است و به همان match می‌چسبد
# ---------------------------------------------------------------------------


def test_after_context_attaches_to_same_match(monkeypatch):
    """context lines که بعد از match می‌آیند باید after-context همان match باشند."""
    root = _make_tmp_root()
    stream = "\n".join(
        [
            _mk_context("a.py", 10, "before1"),
            _mk_context("a.py", 11, "before2"),
            _mk_match("a.py", 12, "MATCH_HERE"),
            _mk_context("a.py", 13, "after1"),
            _mk_context("a.py", 14, "after2"),
            _mk_context("a.py", 15, "after3"),
        ]
    )
    result, _ = _run_with_fake_rg(monkeypatch, stream, root)
    matches = result["matches"]
    assert len(matches) == 1
    lines = [c["line"] for c in matches[0]["context_lines"]]
    assert lines == [10, 11, 12, 13, 14, 15], f"unexpected order: {lines}"


# ---------------------------------------------------------------------------
# ۵. وقتی ctx=0 باشد context_lines ساخته نمی‌شود
# ---------------------------------------------------------------------------


def test_no_context_lines_when_ctx_zero(monkeypatch):
    """اگر ctx=0 باشد، نباید context_lines به entry اضافه شود (رفتار قبلی حفظ شود)."""
    root = _make_tmp_root()
    stream = "\n".join(
        [
            _mk_context("a.py", 10, "a10"),
            _mk_match("a.py", 11, "def first():"),
        ]
    )
    result, _ = _run_with_fake_rg(monkeypatch, stream, root, ctx=0)
    matches = result["matches"]
    assert len(matches) == 1
    assert "context_lines" not in matches[0], (
        f"context_lines نباید ساخته شود وقتی ctx=0: {matches[0]}"
    )


# ---------------------------------------------------------------------------
# ۶. only-match (بدون context) هم کار می‌کند
# ---------------------------------------------------------------------------


def test_only_matches_no_context(monkeypatch):
    """اگر فقط match باشد (بدون context) و ctx>0، match باید در
    context_lines باشد ولی context اضافه‌ای نباشد."""
    root = _make_tmp_root()
    stream = "\n".join(
        [
            _mk_match("a.py", 5, "def only():"),
        ]
    )
    result, _ = _run_with_fake_rg(monkeypatch, stream, root)
    matches = result["matches"]
    assert len(matches) == 1
    assert matches[0]["context_lines"] == [{"line": 5, "text": "def only():"}]


# ---------------------------------------------------------------------------
# ۷. تست یکپارچگی با rg واقعی (اگر نصب باشد)
# ---------------------------------------------------------------------------


def test_real_rg_end_to_end(tmp_path):
    """اگر ripgrep نصب باشد، یک فایل واقعی بساز و search_in_files را تست کن
    تا مطمئن شویم context_lines در خروجی واقعی rg درست ساخته می‌شوند.

    این تست end-to-end تضمین می‌کند که پارسر JSON ما واقعاً stream واقعی
    rg را درست هندل می‌کند (نه فقط stream مصنوعی ما)."""
    import shutil

    if shutil.which("rg") is None:
        import pytest

        pytest.skip("rg not installed")

    # دو match در یک فایل، با gap بزرگ بینشان تا سناریوی قبلاً شکسته را
    # پوشش دهیم: context بین دو match نباید misassign شود.
    # الگوی `def_` به جای `def first():` چون pattern به‌عنوان regex تفسیر
    # می‌شود و پرانتز در pattern مشکل ایجاد می‌کند.
    src = (
        "a8\n"
        "a9\n"
        "a10\n"
        "def_ first():\n"  # MATCH @ line 4
        "    pass\n"
        "c1\n"
        "c2\n"
        + ("\n" * 20)
        + "c18\n"
        "c19\n"
        "c20\n"
        "def_ second():\n"  # MATCH @ line 31
        "    pass\n"
    )
    (tmp_path / "a.py").write_text(src, encoding="utf-8")
    # ساده‌تر: ابتدا بررسی کنیم rg اصلاً match پیدا می‌کند
    simple = "def_ line1\nsome other\ndef_ line3\n"
    (tmp_path / "b.py").write_text(simple, encoding="utf-8")
    result = tools.search_in_files(str(tmp_path), "def_", path="b.py", context=3)
    assert len(result["matches"]) >= 1, (
        f"rg نتوانست حتی یک match ساده پیدا کند: {result!r} — "
        f"shutil.which('rg')={__import__('shutil').which('rg')!r}"
    )
    # حالا سناریوی اصلی با دو match و gap
    (tmp_path / "a.py").write_text(src, encoding="utf-8")
    result = tools.search_in_files(str(tmp_path), "def_", path="a.py", context=3)
    matches = result["matches"]
    if len(matches) != 2:
        raise AssertionError(
            f"expected 2 matches in a.py, got {len(matches)}: result={result!r}"
        )
    assert len(matches) == 2
    first, second = matches
    # خط match باید در context_lines باشد (رگرسیون اصلی — قبلاً نبود)
    assert any(c["line"] == first["line"] for c in first["context_lines"])
    assert any(c["line"] == second["line"] for c in second["context_lines"])
    # before-context match اول (a8/a9/a10) نباید drop شده باشد
    first_lines = [c["line"] for c in first["context_lines"]]
    assert 1 in first_lines and 2 in first_lines and 3 in first_lines, (
        f"context قبل از match اول drop شد: {first_lines}"
    )
    # context بین دو match (c18/c19/c20 در خطوط 28-30) نباید به match اول چسبیده باشد
    assert 28 not in first_lines, (
        f"context بین دو match به match اول misassign شد: {first_lines}"
    )
    assert 29 not in first_lines
    assert 30 not in first_lines
    # و باید به match دوم چسبیده باشد
    second_lines = [c["line"] for c in second["context_lines"]]
    assert 28 in second_lines and 29 in second_lines and 30 in second_lines, (
        f"before-context match دوم attach نشد: {second_lines}"
    )
