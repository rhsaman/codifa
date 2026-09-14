"""گارد امنیتی ترمینال: تشخیص مسیرهای خارج از workspace.

رگرسیون: عملگر تقسیم صحیح پایتون (``//``) نباید به‌عنوان مسیر فایل بلاک شود
(باگ واقعی: ``b.width // 2`` → realpath('//') → بلاک بی‌دلیل دستور پایتون).
"""

from __future__ import annotations

import os

from tools import _escapes_root

_ROOT = os.path.realpath(os.path.abspath(os.sep))  # یک ریشهٔ همیشه-موجود


def test_python_floor_division_not_flagged(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path)
    cmd = 'uv run python -c "print(10 // 2, b.width // 2)"'
    assert _escapes_root(cmd, root) is None


def test_real_outside_path_still_flagged(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path)
    outside = os.path.join(os.path.dirname(root), "elsewhere.txt")
    assert _escapes_root(f"cat {outside}", root) is not None


def test_home_expansion_still_flagged(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert _escapes_root("cat ~/.zshrc", str(tmp_path)) is not None


def test_plain_slash_not_flagged(tmp_path, monkeypatch) -> None:
    """توکن تک‌اسلش (مثل جداکنندهٔ regex در sed) هم مسیر نیست."""
    monkeypatch.chdir(tmp_path)
    assert _escapes_root("echo a/b | sed s/a/c/", str(tmp_path)) is None


def test_brew_install_blocked_even_without_outside_path(tmp_path) -> None:
    """رگرسیون: ``brew install tree-sitter`` هیچ مسیر خارجی‌ای در متن ندارد،
    ولی brew در /opt/homebrew (خارج از workspace) نصب می‌کند — و کاربر اجازه‌اش
    را DENY کرده بود. باید بدون permit بلاک شود و با permit اجرا شود."""
    from tools import run_terminal

    root = str(tmp_path)
    blocked = run_terminal(root, "brew install tree-sitter 2>&1 | tail -5")
    assert "error" in blocked
    assert "request_permission" in blocked["error"]

    allowed = run_terminal(root, "echo ok", permit={"outside": True})
    assert allowed.get("exit_code") == 0


def test_local_package_commands_not_blocked(tmp_path) -> None:
    """دستورات محلیِ عادی (npm install بدون -g، pip در venv پروژه) نباید بلاک شوند."""
    from tools import run_terminal

    root = str(tmp_path)
    for cmd in ("npm install", "npm i --no-audit", "uv run pytest -q"):
        res = run_terminal(root, cmd, timeout=5)
        assert "error" not in res, f"{cmd} نباید بلاک شود: {res.get('error')}"


def test_permit_folder_allows_terminal_outside(tmp_path) -> None:
    """مجوز per-folder: با پوشه‌ی مجاز، دستور بیرونیِ همان زیردرخت رد می‌شود؛
    پوشه‌ی خواهری همچنان بلاک است."""
    from tools import run_terminal

    root = str(tmp_path)
    allowed_dir = tmp_path.parent / "permitted-area"
    allowed_dir.mkdir(exist_ok=True)
    (allowed_dir / "note.txt").write_text("x")
    sibling_dir = tmp_path.parent / "other-area"
    sibling_dir.mkdir(exist_ok=True)
    (sibling_dir / "note.txt").write_text("x")

    permit = {"folders": [str(allowed_dir)]}
    ok = run_terminal(root, f"cat {allowed_dir / 'note.txt'}", permit=permit)
    assert "error" not in ok, f"مسیر زیر پوشه‌ی مجاز باید رد شود: {ok.get('error')}"

    blocked = run_terminal(root, f"cat {sibling_dir / 'note.txt'}", permit=permit)
    assert "error" in blocked
    assert "request_permission" in blocked["error"]


def test_permit_folder_allows_file_tools(tmp_path) -> None:
    """مجوز per-folder در ابزارهای فایل: read/write/edit زیر پوشه‌ی مجاز
    کار می‌کند؛ مسیر بیرونیِ دیگر همچنان PathEscapeError می‌دهد."""
    from tools import PathEscapeError, read_file, write_file

    root = str(tmp_path)
    allowed_dir = tmp_path.parent / "permitted-files"
    allowed_dir.mkdir(exist_ok=True)

    permit = {"folders": [str(allowed_dir)]}
    target = allowed_dir / "cfg.toml"
    res = write_file(root, str(target), "k = 1\n", permit=permit)
    assert res.get("ok") is True, f"write زیر پوشه‌ی مجاز باید رد شود: {res}"
    out = read_file(root, str(target), permit=permit)
    assert "k = 1" in out.get("content", "")

    other = tmp_path.parent / "not-permitted" / "x.txt"
    try:
        write_file(root, str(other), "no\n", permit=permit)
        raise AssertionError("مسیر خارج از پوشه‌های مجاز باید PathEscapeError بدهد")
    except PathEscapeError:
        pass
