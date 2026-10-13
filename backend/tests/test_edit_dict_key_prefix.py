"""Regression: a plain-matched edit must write new_string verbatim.

A dict-literal line like ``    1: (429, "x"),`` looks like a ``N:`` line-number
prefix; edit_file used to strip it from new_string even when old_string matched
byte-exact, silently dropping the keys and making every repair a no-op
('edits leave the file unchanged')."""
import os

from tools import edit_file, edit_file_batch

BROKEN = 'x = {\n(429, "a"),\n(429, "b"),\n}\n'
FIXED = 'x = {\n    1: (429, "a"),\n    2: (429, "b"),\n}\n'


def _write(tmp_path, text):
    p = tmp_path / "t.py"
    p.write_text(text, encoding="utf-8")
    return p


def test_edit_file_keeps_numeric_dict_keys(tmp_path):
    p = _write(tmp_path, BROKEN)
    res = edit_file(str(tmp_path), "t.py", BROKEN, FIXED)
    assert "error" not in res, res
    assert p.read_text(encoding="utf-8") == FIXED


def test_edit_file_batch_keeps_numeric_dict_keys(tmp_path):
    p = _write(tmp_path, BROKEN)
    res = edit_file_batch(
        str(tmp_path), "t.py", [{"old_string": BROKEN, "new_string": FIXED}]
    )
    assert "error" not in res, res
    assert p.read_text(encoding="utf-8") == FIXED


def test_decorated_old_string_still_strips_new_string(tmp_path):
    """A model that copies read output (``N | `` rows) into BOTH strings keeps
    the old behavior: prefixes are removed from old and new."""
    p = _write(tmp_path, "a = 1\nb = 2\n")
    res = edit_file(
        str(tmp_path), "t.py", "1 | a = 1\n2 | b = 2", "1 | a = 10\n2 | b = 2"
    )
    assert "error" not in res, res
    assert p.read_text(encoding="utf-8") == "a = 10\nb = 2\n"
    assert os.path.exists(p)
