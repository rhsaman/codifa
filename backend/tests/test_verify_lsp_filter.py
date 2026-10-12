"""Verify-edit LSP filter + per-chat read-seen stub (redo-loop fixes).

- hint/info-only diagnostics must NOT fail auto-verify (they sent the model
  into a fix-and-re-verify loop over pre-existing notes after a good edit).
- error/warning diagnostics still fail, with hint/info counted not listed.
- re-reading an unchanged window in the same chat returns a stub, and an
  edit of the file clears the seen mark so the next read is full again.
"""

import asyncio
import sys

import tools


class _FakeMgr:
    def __init__(self, diags):
        self._diags = diags

    def is_server_running(self, target):
        return True

    def diagnostics(self, target):
        return list(self._diags)


def _patch_lsp(monkeypatch, diags):
    fake = _FakeMgr(diags)

    class _FakeMod:
        @staticmethod
        def get_manager(root):
            return fake

    monkeypatch.setitem(sys.modules, "lsp_manager", _FakeMod())
    return fake


def test_hints_only_do_not_fail_verify(monkeypatch, tmp_path):
    target = tmp_path / "a.py"
    target.write_text("x = 1\n", encoding="utf-8")
    hints = [
        {"path": "a.py", "line": 1, "severity": "hint", "message": "'x' is never read", "source": "py"},
        {"path": "a.py", "line": 2, "severity": "info", "message": "something minor", "source": "py"},
    ]
    _patch_lsp(monkeypatch, hints)
    assert tools._verify_lsp_diagnostics(str(tmp_path), str(target)) is None


def test_errors_still_reported_with_hints_suppressed(monkeypatch, tmp_path):
    target = tmp_path / "a.py"
    target.write_text("x = 1\n", encoding="utf-8")
    diags = [
        {"path": "a.py", "line": 3, "severity": "error", "message": "boom", "source": "py"},
        {"path": "a.py", "line": 1, "severity": "hint", "message": "'x' is never read", "source": "py"},
        {"path": "a.py", "line": 2, "severity": "hint", "message": "other note", "source": "py"},
    ]
    _patch_lsp(monkeypatch, diags)
    note = tools._verify_lsp_diagnostics(str(tmp_path), str(target))
    assert note is not None
    assert "boom" in note
    assert "1 LSP diagnostic(s)" in note
    assert "suppressed" in note
    assert "'x' is never read" not in note


def test_read_seen_cleared_on_edit_and_chat_delete(tmp_path):
    root = str(tmp_path)
    f = tmp_path / "f.py"
    f.write_text("x = 1\n", encoding="utf-8")
    norm = tools.resolve_safe(root, "f.py", allow_coder=True)
    key = ("read", norm, "1", "50")
    tools._READ_SEEN_BY_CHAT.setdefault("c1", set()).add(key)
    assert key in tools._READ_SEEN_BY_CHAT["c1"]
    tools._invalidate_read_cache_for("f.py", root)
    assert key not in tools._READ_SEEN_BY_CHAT.get("c1", set())
    tools._READ_SEEN_BY_CHAT.setdefault("c1", set()).add(key)
    tools.clear_chat_state("c1")
    assert "c1" not in tools._READ_SEEN_BY_CHAT


def _make_read_cb(root, chat_id):
    captured = []

    def emit(event):
        captured.append(event)

    cbs = tools.make_tool_callbacks(str(root), emit, chat_id=chat_id)
    return cbs["read"], captured


def test_covering_window_read_stubs_same_turn(tmp_path):
    """A window inside an already-served range of the same turn returns a
    stub instead of resending bytes (the live-trace overlap waste)."""
    root = str(tmp_path)
    f = tmp_path / "f.py"
    f.write_text("".join(f"line {i}\n" for i in range(1, 21)), encoding="utf-8")
    tools._READ_RANGES_BY_CHAT.pop("cc", None)
    read, _ = _make_read_cb(root, "cc")
    try:
        first = asyncio.run(read(filePath="f.py", offset=1, limit=20))
        assert "line 5" in first
        second = asyncio.run(read(filePath="f.py", offset=5, limit=5))
        assert "unchanged" in second
        assert "line 5" not in second
        third = asyncio.run(read(filePath="f.py", offset=15, limit=10))
        assert "line 15" in third
    finally:
        tools._READ_RANGES_BY_CHAT.pop("cc", None)
        tools.clear_chat_state("cc")


def test_covering_window_cleared_on_edit_and_new_turn(tmp_path):
    """An edit purges the served ranges; a new turn (callbacks rebuilt)
    starts with empty ranges so cross-turn reads stay full."""
    root = str(tmp_path)
    f = tmp_path / "f.py"
    f.write_text("".join(f"line {i}\n" for i in range(1, 21)), encoding="utf-8")
    tools._READ_RANGES_BY_CHAT.pop("cc", None)
    read, _ = _make_read_cb(root, "cc")
    try:
        asyncio.run(read(filePath="f.py", offset=1, limit=20))
        tools._invalidate_read_cache_for("f.py", root)
        after_edit = asyncio.run(read(filePath="f.py", offset=5, limit=5))
        assert "line 5" in after_edit
        read2, _ = _make_read_cb(root, "cc")
        fresh = asyncio.run(read2(filePath="f.py", offset=6, limit=3))
        assert "line 6" in fresh
    finally:
        tools._READ_RANGES_BY_CHAT.pop("cc", None)
        tools.clear_chat_state("cc")


def test_read_turn_line_cap_stubs_paging(tmp_path):
    """Past the per-turn per-file served-line cap, further windows return a
    stub pointing at grep/lsp_symbols — the live trace paged a whole
    8300-line file in 29 windows (~70K tokens in one step)."""
    root = str(tmp_path)
    f = tmp_path / "big.tsx"
    f.write_text("".join(f"line {i}\n" for i in range(1, 4001)), encoding="utf-8")
    tools._READ_RANGES_BY_CHAT.pop("cap1", None)
    read, _ = _make_read_cb(root, "cap1")
    try:
        # offset=2 dodges the head-map path (offset 1 + limit>=400 on a
        # 4000-line file serves a file map, not bulk lines).
        first = asyncio.run(read(filePath="big.tsx", offset=2, limit=1500))
        assert "2 | line 2" in first
        second = asyncio.run(read(filePath="big.tsx", offset=1542, limit=1500))
        assert "1542 | line 1542" in second
        third = asyncio.run(read(filePath="big.tsx", offset=3082, limit=500))
        assert "read cap" in third
        assert "3082 | line 3082" not in third
    finally:
        tools._READ_RANGES_BY_CHAT.pop("cap1", None)
        tools.clear_chat_state("cap1")


def test_read_cap_cleared_on_edit_and_new_turn(tmp_path):
    """The served-line cap follows the served ranges: an edit purges them
    and a new turn starts fresh, so a capped file becomes readable again."""
    root = str(tmp_path)
    f = tmp_path / "big.tsx"
    f.write_text("".join(f"line {i}\n" for i in range(1, 4001)), encoding="utf-8")
    tools._READ_RANGES_BY_CHAT.pop("cap2", None)
    read, _ = _make_read_cb(root, "cap2")
    try:
        asyncio.run(read(filePath="big.tsx", offset=2, limit=1600))
        asyncio.run(read(filePath="big.tsx", offset=1602, limit=1600))
        capped = asyncio.run(read(filePath="big.tsx", offset=3300, limit=200))
        assert "read cap" in capped
        tools._invalidate_read_cache_for("big.tsx", root)
        after_edit = asyncio.run(read(filePath="big.tsx", offset=3300, limit=200))
        assert "3300 | line 3300" in after_edit
        read2, _ = _make_read_cb(root, "cap2")
        # A different window: the exact (3300,200) window is intentionally
        # deduped cross-turn (seen-stub); the cap reset is what we test here.
        fresh = asyncio.run(read2(filePath="big.tsx", offset=3600, limit=100))
        assert "3600 | line 3600" in fresh
    finally:
        tools._READ_RANGES_BY_CHAT.pop("cap2", None)
        tools.clear_chat_state("cap2")
