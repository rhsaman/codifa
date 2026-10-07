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


def git_discard(root: str) -> dict:
    """Discard all uncommitted changes, restoring the tree to HEAD."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    reset = _run_git(root, ["reset", "--hard", "HEAD"])
    if not reset.get("ok"):
        return {"error": reset.get("error") or reset.get("err") or "git reset failed"}
    clean = _run_git(root, ["clean", "-fd"])
    if not clean.get("ok"):
        return {"error": clean.get("error") or clean.get("err") or "git clean failed"}
    return {"discarded": True}


def git_branches(root: str) -> dict:
    """List local branches plus the current one."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    cur = _run_git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    current = cur["out"].strip() if cur.get("ok") else ""
    res = _run_git(root, ["branch", "--format=%(refname:short)"])
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git branch failed"}
    branches = [ln.strip() for ln in res["out"].splitlines() if ln.strip()]
    return {"current": current, "branches": branches}


def _valid_branch(name: str) -> bool:
    """Conservative branch-name check (single argv, never a flag)."""
    import re

    if not name or name.startswith(("-", ".")):
        return False
    if ".." in name or "~" in name or "^" in name or ":" in name:
        return False
    if any(c in name for c in (" ", "?", "*", "[", "\\", "'", '"', ";", "&", "|")):
        return False
    return re.match(r"^[A-Za-z0-9._/\-]+$", name) is not None


def git_checkout(root: str, branch: str, create: bool = False) -> dict:
    """Checkout an existing branch, or create+checkout when ``create``."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    name = (branch or "").strip()
    if not _valid_branch(name):
        return {"error": f"invalid branch name: {branch!r}"}
    args = ["checkout", "-b", name] if create else ["checkout", name]
    res = _run_git(root, args)
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git checkout failed"}
    return {"current": name}


def _valid_remote(name: str) -> bool:
    """Conservative remote-name check (single argv, never a flag or URL)."""
    import re

    if not name or name.startswith(("-", ".")):
        return False
    if ".." in name or "~" in name or "^" in name or ":" in name:
        return False
    if any(c in name for c in (" ", "?", "*", "[", "\\", "'", '"', ";", "&", "|")):
        return False
    if any(c in name for c in ("/", "$", "`", "(", ")", "<", ">")):
        return False
    return re.match(r"^[A-Za-z0-9._\-]+$", name) is not None


def git_push(
    root: str, remote: str = "origin", branch: str = "", set_upstream: bool = False
) -> dict:
    """Push the current branch (or ``branch``) to ``remote``.

    List-argv subprocess only (via ``_run_git``) — no shell. ``remote``
    must be a plain remote name (default ``"origin"``); URLs are rejected.
    An empty ``branch`` pushes the current branch (``HEAD`` when detached).
    """
    if not _is_repo(root):
        return {"error": "not a git repository"}
    remote = (remote or "origin").strip() or "origin"
    if not _valid_remote(remote):
        return {"error": f"invalid remote name: {remote!r}"}
    name = (branch or "").strip()
    if not name:
        cur = _run_git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
        cur_name = cur.get("out", "").strip() if cur.get("ok") else ""
        if not cur_name or cur_name == "HEAD":
            name = "HEAD"
        else:
            name = cur_name
    if name != "HEAD" and not _valid_branch(name):
        return {"error": f"invalid branch name: {branch!r}"}
    args = ["push", remote, name]
    if set_upstream and name != "HEAD":
        args = ["push", "-u", remote, name]
    res = _run_git(root, args)
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git push failed"}
    out = (res.get("out") or "").strip()
    err = (res.get("err") or "").strip()
    summary = err or out
    return {
        "pushed": True,
        "remote": remote,
        "branch": name,
        "summary": summary,
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


def git_show(root: str, rev: str = "HEAD", path: str = "") -> dict:
    """Unified diff of a single commit (default HEAD), optionally scoped to a path."""
    if not _is_repo(root):
        return {"error": "not a git repository"}
    rev = (rev or "HEAD").strip() or "HEAD"
    if rev.startswith("-"):
        return {"error": f"invalid revision: {rev!r}"}
    args = ["show", rev, "--no-color", "--pretty=format:", "--no-ext-diff"]
    if path:
        # "--" ends option parsing; the path can never be read as a flag.
        args += ["--", path]
    res = _run_git(root, args)
    if not res.get("ok"):
        return {"error": res.get("error") or res.get("err") or "git show failed"}
    diff = res["out"]
    truncated = False
    if len(diff) > _MAX_DIFF:
        diff = diff[:_MAX_DIFF]
        truncated = True
    return {"diff": diff, "truncated": truncated}
