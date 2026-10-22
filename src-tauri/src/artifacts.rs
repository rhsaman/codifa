//! Chat artifacts: versioned HTML/Markdown documents the agent builds in the
//! right-hand preview instead of dumping a wall of markup into the bubble.
//!
//! Layout: `<data_root>/artifacts/<chat_id>/<slug>/`
//! - `index.json`      — id, title, kind, latest version, version history
//! - `v<N>.html|md`    — one file per save, so `update_artifact` never loses an
//!   earlier rendering
//!
//! The transcript itself only carries `{id, title, kind, content}` (see
//! `MessageSegment`), so a chat reopened after the files are gone still shows
//! its cards; the files exist for versioning and for the preview tab.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Index file inside one artifact folder.
const INDEX: &str = "index.json";
/// Kind used when the caller does not name one.
const DEFAULT_KIND: &str = "html";
/// How many versions one artifact keeps before the oldest is dropped.
const MAX_VERSIONS: usize = 20;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn artifacts_root(root: &Path) -> PathBuf {
    root.join("artifacts")
}

fn chat_dir(root: &Path, chat_id: &str) -> PathBuf {
    let id = if chat_id.trim().is_empty() { "scratch" } else { chat_id };
    artifacts_root(root).join(crate::skills::safe_file(id, "chat"))
}

/// `html` (the sandboxed preview) or `md` (prose). Anything else falls back to
/// html, because the preview iframe is the only renderer.
pub fn kind_of(body: &Value) -> String {
    let kind = body["kind"].as_str().unwrap_or(DEFAULT_KIND).trim().to_lowercase();
    if kind == "md" || kind == "markdown" {
        "md".to_string()
    } else {
        "html".to_string()
    }
}

/// Stable folder slug: the explicit `id` when given, else the title.
pub fn artifact_id(body: &Value) -> String {
    let given = body["id"].as_str().unwrap_or("").trim().to_string();
    let source = if given.is_empty() {
        body["title"].as_str().unwrap_or("").to_string()
    } else {
        given
    };
    crate::skills::safe_file(&source.to_lowercase(), "artifact")
}

fn read_index(dir: &Path) -> Value {
    fs::read_to_string(dir.join(INDEX))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "versions": [] }))
}

/// Save a new version of one artifact.
///
/// `create` refuses to overwrite an existing artifact (the caller asked for a
/// NEW one); `update` requires it to exist, so a typo in the id cannot silently
/// produce a second document.
pub fn save(root: &Path, chat_id: &str, body: &Value, create: bool) -> Result<Value, String> {
    let content = body["content"].as_str().unwrap_or("");
    if content.trim().is_empty() {
        return Err("artifact content is required".into());
    }
    let id = artifact_id(body);
    let dir = chat_dir(root, chat_id).join(&id);
    let existed = dir.join(INDEX).is_file();
    if create && existed {
        return Err(format!(
            "artifact \"{id}\" already exists in this chat — update it instead"
        ));
    }
    if !create && !existed {
        return Err(format!("artifact not found: {id}. Create it first."));
    }

    let index = read_index(&dir);
    // An update that omits `kind` keeps the stored one: `kind_of` defaults to
    // html (the preview is the only renderer), so re-rendering a markdown
    // document without repeating the kind used to silently turn it into an
    // html artifact. The title has always been inherited this way.
    let kind = if body["kind"].as_str().unwrap_or("").trim().is_empty() {
        index["kind"].as_str().unwrap_or(DEFAULT_KIND).to_string()
    } else {
        kind_of(body)
    };
    let version = index["version"].as_u64().unwrap_or(0) + 1;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = format!("v{version}.{kind}");
    fs::write(dir.join(&file), content).map_err(|e| e.to_string())?;

    let title = body["title"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or_else(|| index["title"].as_str().map(str::to_string))
        .unwrap_or_else(|| id.clone());
    let mut versions: Vec<Value> = index["versions"].as_array().cloned().unwrap_or_default();
    versions.push(json!({ "version": version, "file": file }));
    // Trim the history AND the files it named: an unbounded folder grows on
    // every turn that re-renders the same document.
    while versions.len() > MAX_VERSIONS {
        let dropped = versions.remove(0);
        if let Some(old) = dropped["file"].as_str() {
            let _ = fs::remove_file(dir.join(old));
        }
    }

    let record = json!({
        "id": id,
        "title": title,
        "kind": kind,
        "version": version,
        "file": file,
        "updated_at": now_secs(),
        // The OWNER chat id, not the folder name: the folder is the sanitized
        // spelling (`chat_dir`), and the Artifacts page must jump back to the
        // real chat. Older records lack the field — `list` falls back to the
        // folder name for them.
        "chat_id": chat_id,
        "versions": versions,
    });
    fs::write(dir.join(INDEX), record.to_string()).map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "id": id,
        "title": title,
        "kind": kind,
        "version": version,
        "path": dir.join(&file).to_string_lossy(),
        "content": content,
    }))
}

/// Latest saved body of one artifact, for the preview tab after a restart.
pub fn read(root: &Path, chat_id: &str, id: &str) -> Result<Value, String> {
    let dir = chat_dir(root, chat_id).join(crate::skills::safe_file(id, "artifact"));
    let index = read_index(&dir);
    let Some(file) = index["file"].as_str() else {
        return Err(format!("artifact not found: {id}"));
    };
    let content = fs::read_to_string(dir.join(file)).map_err(|e| e.to_string())?;
    Ok(json!({
        "id": index["id"],
        "title": index["title"],
        "kind": index["kind"],
        "version": index["version"],
        "content": content,
    }))
}

/// Delete one artifact: its whole folder, every saved version included.
///
/// A missing artifact is an explicit error rather than a silent success: a
/// delete from the page must not look like it worked when the row named a
/// folder that was already gone.
pub fn delete(root: &Path, chat_id: &str, id: &str) -> Result<Value, String> {
    let slug = crate::skills::safe_file(id, "artifact");
    let dir = chat_dir(root, chat_id).join(&slug);
    if !dir.is_dir() {
        return Err(format!("artifact not found: {id}"));
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "id": slug, "chat_id": chat_id, "note": "deleted" }))
}

/// Every saved artifact, newest first — the Artifacts page's list.
///
/// An empty `chat_id` walks every chat folder (the page groups by chat); a
/// non-empty one lists just that chat. Only `index.json` is read, never the
/// bodies: a page listing generated documents must not load them all.
pub fn list(root: &Path, chat_id: &str) -> Result<Value, String> {
    let base = artifacts_root(root);
    let dirs: Vec<PathBuf> = if chat_id.trim().is_empty() {
        // No chat folder yet is an empty list, not an error: the page is
        // reachable before anything was built.
        let Ok(entries) = fs::read_dir(&base) else {
            return Ok(json!({ "artifacts": [] }));
        };
        entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()
    } else {
        vec![chat_dir(root, chat_id)]
    };

    let mut items: Vec<Value> = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let index = read_index(&path);
            // A folder without a saved version (or without an id) has nothing
            // to open — listing it would render a row that cannot work.
            let (Some(id), Some(_)) = (index["id"].as_str(), index["file"].as_str()) else {
                continue;
            };
            let folder = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let title = index["title"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or(id);
            items.push(json!({
                "id": id,
                "title": title,
                "kind": index["kind"].as_str().unwrap_or(DEFAULT_KIND),
                "version": index["version"].as_u64().unwrap_or(1),
                "updated_at": index["updated_at"].as_u64().unwrap_or(0),
                // Records written before `chat_id` existed fall back to the
                // folder name, which IS the sanitized chat id.
                "chat_id": index["chat_id"]
                    .as_str()
                    .filter(|c| !c.trim().is_empty())
                    .unwrap_or(folder.as_str()),
            }));
        }
    }
    // Newest first: the page answers "what did I build lately".
    items.sort_by(|a, b| {
        let (x, y) = (
            a["updated_at"].as_u64().unwrap_or(0),
            b["updated_at"].as_u64().unwrap_or(0),
        );
        y.cmp(&x)
    });
    Ok(json!({ "artifacts": items }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-artifact-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    #[test]
    fn create_then_update_bumps_the_version() {
        let root = temp_root("version");
        let first = save(
            &root,
            "chat-1",
            &json!({"title": "Sales chart", "kind": "html", "content": "<b>1</b>"}),
            true,
        )
        .unwrap();
        assert_eq!(first["id"], "sales-chart");
        assert_eq!(first["version"], 1);

        // A second create on the same id must fail: use update for a new version.
        assert!(save(
            &root,
            "chat-1",
            &json!({"title": "Sales chart", "content": "<b>2</b>"}),
            true
        )
        .is_err());

        let second = save(
            &root,
            "chat-1",
            &json!({"id": "sales-chart", "content": "<b>2</b>"}),
            false,
        )
        .unwrap();
        assert_eq!(second["version"], 2);
        // The title/kind survive an update that only sends content.
        assert_eq!(second["title"], "Sales chart");
        assert_eq!(second["kind"], "html");

        let latest = read(&root, "chat-1", "sales-chart").unwrap();
        assert_eq!(latest["content"], "<b>2</b>");
        assert_eq!(latest["version"], 2);

        // Updating an unknown artifact is an explicit error, not a silent create.
        assert!(save(&root, "chat-1", &json!({"id": "ghost", "content": "x"}), false).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_reports_every_chat_newest_first() {
        let root = temp_root("list");
        // Nothing built yet: an empty list, never an error.
        assert_eq!(list(&root, "").unwrap()["artifacts"].as_array().unwrap().len(), 0);

        save(
            &root,
            "chat-a",
            &json!({"title": "Alpha", "kind": "md", "content": "# a"}),
            true,
        )
        .unwrap();
        save(
            &root,
            "chat-b",
            &json!({"title": "Beta", "content": "<b>b</b>"}),
            true,
        )
        .unwrap();
        // A second version of Alpha must NOT add a second row.
        save(&root, "chat-a", &json!({"id": "alpha", "content": "# a2"}), false).unwrap();

        let all = list(&root, "").unwrap();
        let items = all["artifacts"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{all}");
        let alpha = items.iter().find(|i| i["id"] == "alpha").unwrap();
        assert_eq!(alpha["title"], "Alpha");
        assert_eq!(alpha["kind"], "md");
        assert_eq!(alpha["version"], 2);
        assert_eq!(alpha["chat_id"], "chat-a");
        let beta = items.iter().find(|i| i["id"] == "beta").unwrap();
        assert_eq!(beta["chat_id"], "chat-b");
        // Newest first: Alpha was updated last.
        assert_eq!(items[0]["id"], "alpha");

        // One chat's own list, and an unknown chat is empty rather than an error.
        assert_eq!(
            list(&root, "chat-b").unwrap()["artifacts"].as_array().unwrap().len(),
            1
        );
        assert_eq!(list(&root, "ghost").unwrap()["artifacts"].as_array().unwrap().len(), 0);

        // A folder that never got a version is skipped (no openable document).
        let stray = chat_dir(&root, "chat-a").join("empty");
        fs::create_dir_all(&stray).unwrap();
        assert_eq!(list(&root, "chat-a").unwrap()["artifacts"].as_array().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_the_whole_folder() {
        let root = temp_root("delete");
        save(&root, "chat-a", &json!({"title": "Doomed", "content": "<b>1</b>"}), true).unwrap();
        save(&root, "chat-a", &json!({"id": "doomed", "content": "<b>2</b>"}), false).unwrap();
        assert_eq!(list(&root, "chat-a").unwrap()["artifacts"].as_array().unwrap().len(), 1);

        let out = delete(&root, "chat-a", "doomed").unwrap();
        assert_eq!(out["ok"], true);
        // Every version goes with it, and the chat folder stays for the rest.
        assert_eq!(list(&root, "chat-a").unwrap()["artifacts"].as_array().unwrap().len(), 0);
        assert!(!chat_dir(&root, "chat-a").join("doomed").exists());
        assert!(!read(&root, "chat-a", "doomed").is_ok());
        // Deleting it twice is an explicit error, not a silent success.
        assert!(delete(&root, "chat-a", "doomed").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn markdown_kind_is_recognised() {
        assert_eq!(kind_of(&json!({"kind": "markdown"})), "md");
        assert_eq!(kind_of(&json!({"kind": "MD"})), "md");
        assert_eq!(kind_of(&json!({})), "html");
        assert_eq!(kind_of(&json!({"kind": "svg"})), "html");
    }
}
