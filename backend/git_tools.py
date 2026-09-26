"""Git integration — safe status/diff/commit/log helpers.

Dedicated git tools (used by the agent's ``git_*`` tools and the sidecar's
``/git`` endpoints). These bypass the terminal's git-write blacklist on
purpose: they are narrow, argument-validated wrappers — no shell, list-argv
subprocess only — so the model can commit without shelling out.

All functions are best-effort: a missing git binary or a non-repo root
returns ``{"error": ...}`` instead of raising.
"""

from __future__ import annotations

import subprocess

_GIT_TIMEOUT = 30  # seconds — plenty for status/diff/log on normal repos
_MAX_DIFF = 200_000  # cap unified diff output so a huge diff can't flood context
_MAX_LOG = 100  # hard cap on commit count


def _run_git(root: str, args: list[str]) -> dict:
    """Run ``git <args>`` in ``root``. Returns ``{"ok", "out", "err", "code"}``."""
    try:
        proc = subprocess.run(  # noqa: PLW1510 — returncode checked below
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
        )
    except FileNotFoundError:
        return {"ok": False, "error": "git binary not found on PATH"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"git {' '.join(args)} timed out"}
    except OSError as exc:
        return {"ok": False, "error": f"git failed: {exc}"}
    return {
        "ok": proc.returncode == 0,
        "out": proc.stdout,
        "err": proc.stderr.strip(),
        "code": proc.returncode,
    }


def _is_repo(root: str) -> bool:
    return _run_git(root, ["rev-parse", "--is-inside-work-tree"]).get("ok") is True


def git_status(root: str) -> dict:
    """Porcelain status + a short human summary of the working tree."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    res = _run_git(root, ["status", "--porcelain=v1", "--branch"])
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git status failed"}
    lines = [ln for ln in res["out"].splitlines() if ln.strip()]
    branch_line = lines[0] if lines and lines[0].startswith("##") else ""
    entries = [
        {"xy": ln[:2], "path": ln[3:], "st": ln[:1].strip(), "wt": ln[1:2].strip()}
        for ln in lines
        if not ln.startswith("##")
    ]
    return {"branch": branch_line[3:] if branch_line else "", "entries": entries}


def git_diff(root: str, path: str = "", staged: bool = False) -> dict:
    """Unified diff of the working tree (or the index when ``staged``)."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    args = ["diff"]
    if staged:
        args.append("--cached")
    if path:
        # "--" ends option parsing; the path can never be read as a flag.
        args += ["--", path]
    res = _run_git(root, [*args, "--no-color"])
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git diff failed"}
    diff = res["out"]
    truncated = False
    if len(diff) > _MAX_DIFF:
        diff = diff[:_MAX_DIFF]
        truncated = True
    return {"diff": diff, "truncated": truncated}


def git_commit(root: str, message: str, add_all: bool = False) -> dict:
    """Stage (optionally) and commit. Returns the new commit hash."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    msg = (message or "").strip()
    if not msg:
        return {"error": "commit message is required"}
    if add_all:
        stage = _run_git(root, ["add", "-A"])
        if not stage.get("ok"):
            return {"error": stage.get("error") or stage.get("err") or "git add failed"}
    # Refuse an empty commit (nothing staged) instead of letting git fail
    # with a confusing exit code 1.
    staged_check = _run_git(root, ["diff", "--cached", "--quiet"])
    if staged_check.get("ok"):
        return {"error": "nothing staged to commit"}
    res = _run_git(root, ["commit", "-m", msg])
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git commit failed"}
    head = _run_git(root, ["rev-parse", "--short", "HEAD"])
    return {
        "commit": head.get("out", "").strip() if head.get("ok") else "",
        "summary": res["out"].strip().splitlines()[-1] if res["out"].strip() else "",
    }


def git_log(root: str, limit: int = 20) -> dict:
    """Recent commits: hash, author date, subject — newest first."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    n = max(1, min(int(limit or 20), _MAX_LOG))
    res = _run_git(
        root,
        ["log", f"-{n}", "--pretty=format:%h%x1f%ad%x1f%s", "--date=short"],
    )
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git log failed"}
    commits = []
    for ln in res["out"].splitlines():
        parts = ln.split("\x1f", 2)
        if len(parts) == 3:
            commits.append(
                {"hash": parts[0], "date": parts[1], "subject": parts[2]}
            )
    return {"commits": commits}
