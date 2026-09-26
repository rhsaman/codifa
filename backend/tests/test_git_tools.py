"""تست‌های backend/git_tools.py — با repo موقت در tmp_path.

هر تست یک git repo واقعی می‌سازد (git init + config کاربر محلی) و
رفتار status/diff/commit/log را در آن بررسی می‌کند.
"""

import os
import subprocess

import pytest

import git_tools


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    """یک git repo آماده‌ی کار با یک فایل committed."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    r = tmp_path / "repo"
    r.mkdir()
    subprocess.run(["git", "init"], cwd=r, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@example.com"], cwd=r, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"], cwd=r, check=True, capture_output=True
    )
    (r / "a.txt").write_text("hello\n")
    subprocess.run(["git", "add", "-A"], cwd=r, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=r, check=True, capture_output=True
    )
    return str(r)


def test_status_clean_then_dirty(repo):
    st = git_tools.git_status(repo)
    assert "error" not in st
    assert st["branch"].startswith("master") or st["branch"].startswith("main")
    assert st["entries"] == []
    # فایل جدید → untracked
    with open(os.path.join(repo, "b.txt"), "w") as f:
        f.write("x\n")
    st = git_tools.git_status(repo)
    assert [e["path"] for e in st["entries"]] == ["b.txt"]
    assert st["entries"][0]["xy"].strip() == "??"


def test_status_not_a_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    out = git_tools.git_status(str(tmp_path))
    assert "error" in out


def test_diff_working_tree(repo):
    with open(os.path.join(repo, "a.txt"), "a") as f:
        f.write("world\n")
    out = git_tools.git_diff(repo)
    assert "error" not in out
    assert "+world" in out["diff"]
    assert "-hello" not in out["diff"]  # hello هنوز هست — فقط خط اضافه شده
    # scoped به یک path
    out = git_tools.git_diff(repo, path="a.txt")
    assert "+world" in out["diff"]


def test_diff_staged(repo):
    with open(os.path.join(repo, "a.txt"), "a") as f:
        f.write("staged line\n")
    subprocess.run(["git", "add", "a.txt"], cwd=repo, check=True, capture_output=True)
    out = git_tools.git_diff(repo, staged=True)
    assert "+staged line" in out["diff"]


def test_commit_requires_message(repo):
    out = git_tools.git_commit(repo, "  ")
    assert "error" in out


def test_commit_nothing_staged(repo):
    out = git_tools.git_commit(repo, "empty")
    assert "error" in out
    assert "nothing staged" in out["error"]


def test_commit_add_all(repo):
    with open(os.path.join(repo, "c.txt"), "w") as f:
        f.write("new file\n")
    out = git_tools.git_commit(repo, "add c", add_all=True)
    assert "error" not in out, out
    assert out["commit"]
    st = git_tools.git_status(repo)
    assert st["entries"] == []
    log = git_tools.git_log(repo)
    assert log["commits"][0]["subject"] == "add c"


def test_log_limit(repo):
    for i in range(3):
        with open(os.path.join(repo, f"f{i}.txt"), "w") as f:
            f.write("x\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", f"c{i}"], cwd=repo, check=True, capture_output=True
        )
    log = git_tools.git_log(repo, limit=2)
    assert len(log["commits"]) == 2
    assert log["commits"][0]["subject"] == "c2"
    # cap سخت: limit بزرگ از _MAX_LOG بیشتر نشود
    log = git_tools.git_log(repo, limit=999)
    assert len(log["commits"]) == 4
