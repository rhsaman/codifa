"""قرارداد Review: خروجی write_file باید مثل edit_file شامل old_content/new_content
باشد تا فرانت‌اند یک DiffView واحد بسازد، و git_diff باید رشته‌ی unified بدون رنگ
برگرداند."""

from __future__ import annotations

import os

import git_tools
import tools


def test_write_file_returns_old_and_new_content(tmp_path):
    root = str(tmp_path)
    path = "openai.config.toml"

    # فایل جدید: old_content خالی است.
    res = tools.write_file(root, path, 'model = "gpt-6-sol"\n')
    assert res.get("ok") is True
    assert res["old_content"] == ""
    assert res["new_content"] == 'model = "gpt-6-sol"\n'
    assert res["occurrences"] == 1

    # بازنویسی فایل موجود: old_content محتوای قبلی است.
    res2 = tools.write_file(root, path, 'model = "gpt-5"\n')
    assert res2.get("ok") is True
    assert res2["old_content"] == 'model = "gpt-6-sol"\n'
    assert res2["new_content"] == 'model = "gpt-5"\n'


def test_write_file_error_has_no_old_new(tmp_path):
    root = str(tmp_path)
    # مسیر یک پوشه است — باید خطا بدهد، نه old/new.
    os.mkdir(os.path.join(root, "adir"))
    res = tools.write_file(root, "adir", "x")
    assert "error" in res
    assert "old_content" not in res


def test_git_diff_returns_plain_unified(tmp_path):
    root = str(tmp_path)
    # یک ریپوی موقت با یک کامیت و یک تغییر.
    assert git_tools._run_git(root, ["init"]).get("ok") is True
    git_tools._run_git(root, ["config", "user.email", "t@t"])
    git_tools._run_git(root, ["config", "user.name", "t"])
    tools.write_file(root, "a.txt", "one\n")
    git_tools._run_git(root, ["add", "-A"])
    git_tools._run_git(root, ["commit", "-m", "init"])
    tools.write_file(root, "a.txt", "one\ntwo\n")

    res = git_tools.git_diff(root)
    assert "error" not in res
    diff = res["diff"]
    assert isinstance(diff, str)
    # unified diff بدون کد رنگ ANSI.
    assert "@@" in diff
    assert "\x1b[" not in diff
    assert "+two" in diff
