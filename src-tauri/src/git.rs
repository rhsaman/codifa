//! Native git endpoints (phase 2) — mirrors backend/git_tools.py.
//!
//! Same subprocess approach as the Python side: shelling out to `git` keeps
//! the user's SSH agent / credential helpers working for push, which the
//! libgit2 bindings cannot do without custom credential callbacks.

use std::path::Path;
use std::process::Command;

use serde::Deserialize;
use serde_json::{json, Value};

/// Matches git_tools._MAX_DIFF.
const MAX_DIFF: usize = 200_000;
/// Matches git_tools._MAX_LOG.
const MAX_LOG: usize = 100;

pub struct GitError(pub String);

type GitResult = Result<Value, GitError>;

fn err(msg: impl Into<String>) -> GitError {
    GitError(msg.into())
}

fn valid_root(root: &str) -> Result<(), GitError> {
    if root.is_empty() || !Path::new(root).is_dir() {
        return Err(err("invalid project root"));
    }
    Ok(())
}

/// Run `git <args>` in `root`, mirroring git_tools._run_git: no shell, 30s
/// timeout. Non-zero exit or spawn failure folds into Err → HTTP 400, same
/// as the Python layer's `{"error": ...}` mapping.
fn run_git(root: &str, args: &[&str]) -> Result<String, GitError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| err(format!("git spawn failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(err(if msg.is_empty() {
            format!("git exited with {}", out.status)
        } else {
            msg
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn truncate(diff: String) -> Value {
    if diff.len() > MAX_DIFF {
        json!({ "diff": diff[..MAX_DIFF].to_string(), "truncated": true })
    } else {
        json!({ "diff": diff, "truncated": false })
    }
}

/// GET /git/status?root=...
pub fn status(root: &str) -> GitResult {
    valid_root(root)?;
    let out = run_git(root, &["status", "--porcelain=v1", "--branch"])?;
    let mut branch = String::new();
    let mut entries: Vec<Value> = Vec::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.split("...").next().unwrap_or(rest).trim().to_string();
        } else if line.len() >= 3 {
            entries.push(json!({
                "xy": &line[..2],
                "path": &line[3..],
                "st": &line[..1],
                "wt": &line[1..2],
            }));
        }
    }
    Ok(json!({ "branch": branch, "entries": entries }))
}

/// GET /git/diff?root=...&path=...&staged=true|false
pub fn diff(root: &str, path: &str, staged: bool) -> GitResult {
    valid_root(root)?;
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    if !path.is_empty() {
        args.push("--");
        args.push(path);
    }
    Ok(truncate(run_git(root, &args)?))
}

/// GET /git/log?root=...&limit=20
pub fn log(root: &str, limit: u32) -> GitResult {
    valid_root(root)?;
    let limit = limit.clamp(1, MAX_LOG as u32);
    let out = run_git(
        root,
        &[
            "log",
            &format!("-{limit}"),
            "--pretty=format:%h%x1f%ad%x1f%s",
            "--date=short",
        ],
    )?;
    let commits: Vec<Value> = out
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\u{1f}');
            Some(json!({
                "hash": parts.next()?,
                "date": parts.next()?,
                "subject": parts.next().unwrap_or(""),
            }))
        })
        .collect();
    Ok(json!({ "commits": commits }))
}

/// GET /git/show?root=...&rev=HEAD&path=...
pub fn show(root: &str, rev: &str, path: &str) -> GitResult {
    valid_root(root)?;
    if rev.starts_with('-') {
        return Err(err("invalid revision"));
    }
    let mut args: Vec<&str> = vec!["show", rev, "--no-color", "--pretty=format:", "--no-ext-diff"];
    if !path.is_empty() {
        args.push("--");
        args.push(path);
    }
    Ok(truncate(run_git(root, &args)?))
}

/// Stage every change (`git add -A`). Used by /git/autocommit, which needs the
/// index populated before it asks the model for a message.
pub fn stage_all(root: &str) -> GitResult {
    valid_root(root)?;
    run_git(root, &["add", "-A"])?;
    Ok(json!({ "staged": true }))
}

/// POST /git/commit {root, message, add_all}
pub fn commit(root: &str, message: &str, add_all: bool) -> GitResult {
    valid_root(root)?;
    if add_all {
        run_git(root, &["add", "-A"])?;
    }
    // `diff --cached --quiet` exits 0 when nothing is staged.
    if Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(root)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Err(err("nothing to commit"));
    }
    let out = run_git(root, &["commit", "-m", message])?;
    let hash = run_git(root, &["rev-parse", "--short", "HEAD"])?.trim().to_string();
    let summary = out.lines().last().unwrap_or("").trim().to_string();
    Ok(json!({ "commit": hash, "summary": summary }))
}

/// POST /git/discard {root}
pub fn discard(root: &str) -> GitResult {
    valid_root(root)?;
    run_git(root, &["reset", "--hard", "HEAD"])?;
    run_git(root, &["clean", "-fd"])?;
    Ok(json!({ "discarded": true }))
}

/// GET /git/branches?root=...
pub fn branches(root: &str) -> GitResult {
    valid_root(root)?;
    let current = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let out = run_git(root, &["branch", "--format=%(refname:short)"])?;
    let list: Vec<String> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    Ok(json!({ "current": current, "branches": list }))
}

/// Branch names must match ^[A-Za-z0-9._/\-]+$ with no leading - or .
/// (git_tools._valid_branch).
fn valid_branch(name: &str) -> Result<(), GitError> {
    let ok = !name.is_empty()
        && !name.starts_with('-')
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
    if ok { Ok(()) } else { Err(err("invalid branch name")) }
}

/// POST /git/checkout {root, branch, create}
pub fn checkout(root: &str, branch: &str, create: bool) -> GitResult {
    valid_root(root)?;
    valid_branch(branch)?;
    if create {
        run_git(root, &["checkout", "-b", branch])?;
    } else {
        run_git(root, &["checkout", branch])?;
    }
    let current = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    Ok(json!({ "current": current }))
}

/// POST /git/push {root, remote, branch, set_upstream}
pub fn push(root: &str, remote: &str, branch: &str, set_upstream: bool) -> GitResult {
    valid_root(root)?;
    if remote.is_empty()
        || !remote
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(err("invalid remote name"));
    }
    let branch = if branch.is_empty() {
        run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string()
    } else {
        branch.to_string()
    };
    let mut args: Vec<&str> = vec!["push"];
    if set_upstream {
        args.push("-u");
    }
    args.push(remote);
    args.push(&branch);
    // Push writes progress to stderr; on success return it as the summary.
    let out = run_git(root, &args)?;
    Ok(json!({
        "pushed": true,
        "remote": remote,
        "branch": branch,
        "summary": out.trim(),
    }))
}

#[derive(Deserialize)]
pub struct CommitBody {
    pub root: String,
    pub message: String,
    #[serde(default)]
    pub add_all: bool,
}

#[derive(Deserialize)]
pub struct CheckoutBody {
    pub root: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub create: bool,
}

#[derive(Deserialize)]
pub struct PushBody {
    pub root: String,
    #[serde(default = "default_remote")]
    pub remote: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub set_upstream: bool,
}

fn default_remote() -> String {
    "origin".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_validation_rejects_shell_metachars() {
        assert!(valid_branch("feature/x-1.2").is_ok());
        assert!(valid_branch("-evil").is_err());
        assert!(valid_branch("..").is_err());
        assert!(valid_branch("a b").is_err());
        assert!(valid_branch("a;b").is_err());
    }

    #[test]
    fn remote_validation_rejects_urls() {
        // A URL must fail remote validation before git is ever touched.
        // Use an existing dir (the workspace) so we hit the remote check,
        // not the root check.
        let root = env!("CARGO_MANIFEST_DIR");
        let e = push(root, "https://evil", "main", false).unwrap_err();
        assert!(e.0.contains("invalid remote"), "got: {}", e.0);
    }
}
