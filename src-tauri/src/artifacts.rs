//! Chat artifacts: versioned HTML/Markdown documents the agent builds in the
//! right-hand preview instead of dumping a wall of markup into the bubble.
//!
//! Layout: `<data_root>/artifacts/<chat_id>/<slug>/`
//! - `index.json`      — id, title, kind, latest version, version history
//! - `v<N>.html|md`    — one file per save, so `update_artifact` never loses an
//!   earlier rendering
//! - `assets/`         — the supporting files of the SAME version: backend
//!   sources, data files, config. An artifact is a small project, not only a
//!   document, so the panel can hand these to the sandboxed frame.
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
/// Folder holding the supporting files of the latest version.
const ASSETS: &str = "assets";
/// Cap on the number of attached files: the panel is a preview, not a repo.
const MAX_ASSET_FILES: usize = 40;
/// Cap on one attached file, so a pasted blob cannot freeze the preview.
const MAX_ASSET_BYTES: usize = 512 * 1024;

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

/// Public wrapper: one artifact's folder (chat + artifact slug), so the agent
/// loop can pin where an update to this document keeps working.
pub fn chat_dir_pub(root: &Path, chat_id: &str, id: &str) -> PathBuf {
    chat_dir(root, chat_id).join(crate::skills::safe_file(id, "artifact"))
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

/// One attached file name: relative, inside the artifact folder, no traversal.
///
/// A backend in another language is NORMAL for an artifact, so the name is kept
/// as written but forced to stay inside `assets/`: the agent names the file, the
/// store decides where it may land.
fn asset_relative(path: &str) -> Option<String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return None;
    }
    let cleaned: Vec<&str> = trimmed
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned.join("/"))
}

/// Write the attached files of one version into `assets/`, replacing the whole
/// folder so the latest version is what the panel serves.
///
/// Returns the written file names, sorted. Limits are enforced here rather than
/// trusted from the caller: this folder is served back to a sandboxed frame.
fn write_assets(dir: &Path, files: &Value) -> Result<Vec<String>, String> {
    let assets_dir = dir.join(ASSETS);
    if assets_dir.is_dir() {
        fs::remove_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    }
    let Some(list) = files.as_array() else {
        return Ok(vec![]);
    };
    if list.is_empty() {
        return Ok(vec![]);
    }
    if list.len() > MAX_ASSET_FILES {
        return Err(format!(
            "artifact accepts at most {MAX_ASSET_FILES} files (got {})",
            list.len()
        ));
    }
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    let mut written: Vec<String> = Vec::new();
    for entry in list {
        let content = entry["content"].as_str().unwrap_or("");
        if content.len() > MAX_ASSET_BYTES {
            return Err(format!(
                "artifact file exceeds {MAX_ASSET_BYTES} bytes: {}",
                entry["path"].as_str().unwrap_or("?")
            ));
        }
        let Some(relative) = asset_relative(entry["path"].as_str().unwrap_or("")) else {
            continue;
        };
        let target = assets_dir.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, content).map_err(|e| e.to_string())?;
        written.push(relative);
    }
    written.sort();
    Ok(written)
}

/// The supporting files of an artifact, for the preview panel.
///
/// Text only, capped: the panel renders a document, so a binary asset would be
/// noise — and an unbounded read would let one artifact freeze the page.
pub fn read_assets(root: &Path, chat_id: &str, id: &str) -> Result<Value, String> {
    let dir = chat_dir(root, chat_id).join(crate::skills::safe_file(id, "artifact"));
    let assets_dir = dir.join(ASSETS);
    let mut files: Vec<Value> = Vec::new();
    if assets_dir.is_dir() {
        collect_assets(&assets_dir, &assets_dir, &mut files)?;
    }
    files.sort_by(|a, b| {
        a["path"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["path"].as_str().unwrap_or_default())
    });
    Ok(json!({ "id": id, "files": files }))
}

/// Names of the files already stored in `assets/`, without reading them: an
/// update that attaches nothing must not silently drop the backend it added
/// earlier.
fn existing_assets(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let assets_dir = dir.join(ASSETS);
    if assets_dir.is_dir() {
        let _ = collect_asset_names(&assets_dir, &assets_dir, &mut names);
    }
    names.sort();
    names
}

fn collect_asset_names(base: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_asset_names(base, &path, out)?;
        } else if let Ok(relative) = path.strip_prefix(base) {
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn collect_assets(base: &Path, dir: &Path, out: &mut Vec<Value>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_assets(base, &path, out)?;
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.len() > MAX_ASSET_BYTES {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let relative = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        out.push(json!({ "path": relative, "content": text }));
    }
    Ok(())
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
    // The supporting files travel with the version that references them.
    // Omitting `files` on an update keeps the ones already stored.
    let assets = match body.get("files") {
        Some(files) if !files.is_null() => write_assets(&dir, files)?,
        _ => existing_assets(&dir),
    };

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
        "assets": assets,
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
        "assets": assets,
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
                // Absolute folder — what an /artifact update session pins the
                // composer badge to.
                "dir": path.to_string_lossy(),
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
    fn attached_files_travel_with_the_version() {
        let root = temp_root("assets");
        let saved = save(
            &root,
            "chat-1",
            &json!({
                "title": "Live panel",
                "kind": "html",
                "content": "<b>ui</b>",
                "files": [
                    {"path": "backend.rs", "content": "fn main() {}"},
                    {"path": "data/rows.json", "content": "[]"},
                ],
            }),
            true,
        )
        .unwrap();
        assert_eq!(saved["assets"].as_array().unwrap().len(), 2);

        let read_back = read_assets(&root, "chat-1", "live-panel").unwrap();
        let files = read_back["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        // Sorted by path, so the panel lists them in a stable order.
        assert_eq!(files[0]["path"], "backend.rs");
        assert_eq!(files[1]["path"], "data/rows.json");
        assert_eq!(files[1]["content"], "[]");

        // An update that attaches nothing keeps the files already stored: a
        // content-only edit must not silently drop the backend.
        save(
            &root,
            "chat-1",
            &json!({"id": "live-panel", "content": "<b>ui 2</b>"}),
            false,
        )
        .unwrap();
        let kept = read_assets(&root, "chat-1", "live-panel").unwrap();
        assert_eq!(kept["files"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn attached_file_names_cannot_escape_the_artifact_folder() {
        let root = temp_root("assets-traversal");
        save(
            &root,
            "chat-1",
            &json!({
                "title": "Sneaky",
                "content": "x",
                "files": [{"path": "../../escaped.rs", "content": "evil"}],
            }),
            true,
        )
        .unwrap();
        // The name is flattened into the assets folder instead of walking out.
        assert!(!root.join("escaped.rs").exists());
        assert!(root
            .join("artifacts/chat-1/sneaky/assets/escaped.rs")
            .is_file());
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
