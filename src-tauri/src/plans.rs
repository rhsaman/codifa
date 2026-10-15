//! Native plan persistence (mirrors backend/state_db.py's plan layer).
//!
//! Layout (identical to the Python sidecar's, so existing on-disk plans keep
//! working): `<data_root>/plan/<workspace-slug>/<chat-id>/plan.md` plus a
//! `plan.meta.json` sidecar (title/updated_at) and an optional
//! `checklist.json`. The Python sidecar wrote these files from graph.py; the
//! native agent now owns the same files so the Plan panel can reload them
//! after a restart.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

use crate::state::now_ms;

/// Sanitize a path component (mirrors state_db._safe_file).
fn safe_file(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() > 120 {
            break;
        }
    }
    let trimmed = out.trim_matches(['.', '-']).to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// Unique workspace slug for a project root: basename + 8-char sha1 of the
/// resolved absolute path (mirrors state_db.workspace_slug_for_root).
pub fn workspace_slug_for_root(root: &str) -> String {
    let real = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root.trim()));
    let real_str = real.to_string_lossy().trim_end_matches('/').to_string();
    if real_str.is_empty() {
        return "workspace".into();
    }
    let base = real
        .file_name()
        .map(|n| safe_file(&n.to_string_lossy(), "workspace"))
        .unwrap_or_else(|| "workspace".into());
    let digest = sha1_hex(real_str.as_bytes());
    format!("{base}-{}", &digest[..8])
}

/// Minimal SHA-1 (only used for the workspace slug — not security-sensitive).
fn sha1_hex(data: &[u8]) -> String {
    // FNV-1a 64-bit is enough for a slug disambiguator and avoids a crypto
    // dependency; collisions across two same-named workspaces are vanishingly
    // unlikely for a single user's machine.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn plans_dir(data_root: &str) -> PathBuf {
    PathBuf::from(data_root).join("plan")
}

fn plan_dir(data_root: &str, workspace: &str, chat_id: &str) -> PathBuf {
    plans_dir(data_root)
        .join(safe_file(workspace, "workspace"))
        .join(safe_file(chat_id, "default"))
}

fn atomic_write(path: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "tmp{}",
        std::process::id()
    ));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Upsert the plan for a workspace+chat (mirrors state_db.save_plan).
pub fn save_plan(
    data_root: &str,
    workspace: &str,
    title: &str,
    content: &str,
    chat_id: &str,
) -> Result<(), String> {
    let d = plan_dir(data_root, workspace, chat_id);
    atomic_write(&d.join("plan.md"), content)?;
    atomic_write(
        &d.join("plan.meta.json"),
        &json!({
            "workspace": workspace,
            "chat_id": chat_id,
            "title": title,
            "updated_at": now_ms() as f64 / 1000.0,
        })
        .to_string(),
    )
}

/// Return `{"workspace", "chat_id", "title", "content"}` or None (mirrors
/// state_db.get_plan: with an empty chat_id returns None — never falls back
/// to another chat's plan).
pub fn get_plan(data_root: &str, workspace: &str, chat_id: &str) -> Option<Value> {
    if chat_id.trim().is_empty() {
        return None;
    }
    let d = plan_dir(data_root, workspace, chat_id);
    let content = fs::read_to_string(d.join("plan.md")).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    let meta: Value = fs::read_to_string(d.join("plan.meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    Some(json!({
        "workspace": workspace,
        "chat_id": chat_id,
        "title": meta.get("title").and_then(|t| t.as_str()).unwrap_or(""),
        "content": content,
    }))
}

/// All saved plans (mirrors state_db.list_plans).
#[allow(dead_code)]
pub fn list_plans(data_root: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(ws_iter) = fs::read_dir(plans_dir(data_root)) else {
        return out;
    };
    for ws in ws_iter.flatten() {
        let Ok(chat_iter) = fs::read_dir(ws.path()) else {
            continue;
        };
        for chat in chat_iter.flatten() {
            if let Some(plan) = get_plan(
                data_root,
                &ws.file_name().to_string_lossy(),
                &chat.file_name().to_string_lossy(),
            ) {
                out.push(plan);
            }
        }
    }
    out
}

/// Remove a plan folder (mirrors state_db.delete_plan). With a chat_id removes
/// that chat's folder; with an empty chat_id removes the whole workspace's.
pub fn delete_plan(data_root: &str, workspace: &str, chat_id: &str) -> bool {
    let target = if chat_id.trim().is_empty() {
        plans_dir(data_root).join(safe_file(workspace, "workspace"))
    } else {
        plan_dir(data_root, workspace, chat_id)
    };
    let result = if target.is_dir() {
        fs::remove_dir_all(&target).is_ok()
    } else {
        false
    };
    result
}

/// Persist the live checklist next to plan.md (mirrors state_db.save_checklist).
pub fn save_checklist(data_root: &str, workspace: &str, chat_id: &str, items: &Value) {
    let Some(items) = items.as_array() else { return };
    let clean: Vec<Value> = items
        .iter()
        .filter_map(|it| {
            let content = it
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .trim()
                .chars()
                .take(200)
                .collect::<String>();
            if content.is_empty() {
                return None;
            }
            let status = it
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("pending")
                .to_lowercase();
            let status = if matches!(status.as_str(), "pending" | "in_progress" | "completed") {
                status
            } else {
                "pending".into()
            };
            Some(json!({"content": content, "status": status}))
        })
        .collect();
    let d = plan_dir(data_root, workspace, chat_id);
    let _ = atomic_write(&d.join("checklist.json"), &serde_json::to_string(&clean).unwrap_or_default());
}

/// Load the persisted checklist for a workspace+chat (or []).
pub fn get_checklist(data_root: &str, workspace: &str, chat_id: &str) -> Value {
    let d = plan_dir(data_root, workspace, chat_id);
    fs::read_to_string(d.join("checklist.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_root(tag: &str) -> String {
        let d = env::temp_dir().join(format!("codifa-plans-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn save_get_delete_roundtrip() {
        let root = tmp_root("rt");
        save_plan(&root, "codifa-abc12345", "plan", "## Plan\nstep one", "chat-1").unwrap();
        let plan = get_plan(&root, "codifa-abc12345", "chat-1").expect("plan exists");
        assert_eq!(
            plan["content"].as_str().unwrap(),
            "## Plan\nstep one"
        );
        assert!(get_plan(&root, "codifa-abc12345", "").is_none());
        assert!(delete_plan(&root, "codifa-abc12345", "chat-1"));
        assert!(get_plan(&root, "codifa-abc12345", "chat-1").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_slug_matches_python_layout() {
        // Same basename+digest shape as state_db.workspace_slug_for_root so
        // plans written by the Python sidecar are found by the native reader.
        let slug = workspace_slug_for_root("/tmp");
        assert!(slug.starts_with("tmp-"));
        assert_eq!(slug.len(), "tmp-".len() + 8);
    }

    #[test]
    fn checklist_roundtrip_and_cleanup() {
        let root = tmp_root("cl");
        save_checklist(
            &root,
            "ws-x",
            "chat-2",
            &json!([
                {"content": "step", "status": "completed"},
                {"content": "", "status": "pending"},
                {"content": "bad", "status": "weird"}
            ]),
        );
        let items = get_checklist(&root, "ws-x", "chat-2");
        let arr = items.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["status"], "completed");
        assert_eq!(arr[1]["status"], "pending");
        let _ = fs::remove_dir_all(&root);
    }
}
