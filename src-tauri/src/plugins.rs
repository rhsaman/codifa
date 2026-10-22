//! Plugins: folder-backed bundles of skills + MCP connectors.
//!
//! Layout: `<data_root>/plugins/<slug>/`
//! - `plugin.json`   — name, slug, description, version, enabled, timestamps
//! - `skills/<name>/skill.md` — the exact skill layout `skills.rs` reads, so a
//!   plugin folder doubles as a skill-store root and needs no second parser
//! - `mcp.json`      — `{name: config}`, the same record shape as `<data_root>/mcp`
//!
//! Turning a plugin off never deletes anything: it only hides the plugin's
//! skills from the prompt catalog and its connectors from the MCP list, which
//! is what makes a plugin one switchable unit instead of loose files.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Manifest file inside one plugin folder.
const MANIFEST: &str = "plugin.json";
/// Connector file inside one plugin folder.
const CONNECTORS: &str = "mcp.json";
/// Default version written for a plugin created without one.
const DEFAULT_VERSION: &str = "1.0.0";
/// Manifest key recording where an installed bundle came from.
const SOURCE: &str = "source";

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn plugins_dir(root: &Path) -> PathBuf {
    root.join("plugins")
}

fn plugin_dir(root: &Path, slug: &str) -> PathBuf {
    plugins_dir(root).join(crate::skills::safe_file(slug, "plugin"))
}

/// Folder slug for a plugin: the explicit `slug` when given, else the name.
fn plugin_slug(name: &str, given: &str) -> String {
    let raw = if given.trim().is_empty() { name } else { given };
    crate::skills::safe_file(&raw.trim().to_lowercase(), "plugin")
}

fn plugin_ref(body: &Value) -> String {
    plugin_slug(
        body["name"].as_str().unwrap_or(""),
        body["slug"].as_str().unwrap_or(""),
    )
}

fn read_manifest(root: &Path, slug: &str) -> Option<Value> {
    let raw = fs::read_to_string(plugin_dir(root, slug).join(MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_manifest(root: &Path, slug: &str, manifest: &Value) -> Result<(), String> {
    let dir = plugin_dir(root, slug);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join(MANIFEST), raw).map_err(|e| e.to_string())
}

fn read_connectors(root: &Path, slug: &str) -> serde_json::Map<String, Value> {
    fs::read_to_string(plugin_dir(root, slug).join(CONNECTORS))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_connectors(dir: &Path, servers: &serde_json::Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(CONNECTORS), Value::Object(servers.clone()).to_string())
        .map_err(|e| e.to_string())
}

/// Skill names a plugin currently holds (recomputed from disk, never stored).
fn skill_names(root: &Path, slug: &str) -> Vec<String> {
    crate::skills::list_skills(&plugin_dir(root, slug))["skills"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn connector_names(root: &Path, slug: &str) -> Vec<String> {
    read_connectors(root, slug).keys().cloned().collect()
}

/// One plugin as the renderer/tool sees it: the manifest plus the live lists of
/// what is inside the folder.
fn plugin_view(root: &Path, slug: &str) -> Value {
    let mut manifest = read_manifest(root, slug).unwrap_or_else(|| json!({}));
    if !manifest.is_object() {
        manifest = json!({});
    }
    manifest["slug"] = json!(slug);
    manifest["skills"] = json!(skill_names(root, slug));
    manifest["mcp"] = json!(connector_names(root, slug));
    manifest
}

/// Every plugin folder that has a manifest, sorted by name.
pub fn list_plugins(root: &Path) -> Value {
    let base = plugins_dir(root);
    let mut plugins: Vec<Value> = Vec::new();
    let Ok(entries) = fs::read_dir(&base) else {
        return json!({ "plugins": plugins });
    };
    for entry in entries.flatten() {
        let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !entry.path().is_dir() || read_manifest(root, &slug).is_none() {
            continue;
        }
        plugins.push(plugin_view(root, &slug));
    }
    plugins.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!({ "plugins": plugins })
}

/// Create a plugin. Fails on an existing slug so an accidental create can never
/// overwrite a bundle the user already has (that is `update_plugin`'s job).
pub fn create_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("plugin name is required".into());
    }
    let slug = plugin_ref(body);
    if plugin_dir(root, &slug).join(MANIFEST).is_file() {
        return Err(format!(
            "plugin \"{slug}\" already exists — edit it with action=update"
        ));
    }
    let now = now_secs();
    let mut manifest = json!({
        "name": name,
        "slug": slug,
        "description": body["description"].as_str().unwrap_or("").to_string(),
        "version": body["version"].as_str().unwrap_or(DEFAULT_VERSION),
        "enabled": body["enabled"].as_bool().unwrap_or(true),
        "created_at": now,
        "updated_at": now,
    });
    if let Some(src) = body[SOURCE].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        manifest[SOURCE] = json!(src);
    }
    write_manifest(root, &slug, &manifest)?;
    apply_parts(root, &slug, body)?;
    Ok(plugin_view(root, &slug))
}

/// Patch an existing plugin: only the fields present in `body` change, so a
/// call that adds one skill never wipes the description or the connectors.
pub fn update_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    let Some(mut manifest) = read_manifest(root, &slug) else {
        return Err(format!(
            "plugin not found: {slug}. Create it first with action=create."
        ));
    };
    for key in ["name", "description", "version"] {
        if let Some(v) = body.get(key).and_then(Value::as_str) {
            if !v.trim().is_empty() {
                manifest[key] = json!(v);
            }
        }
    }
    if let Some(v) = body["enabled"].as_bool() {
        manifest["enabled"] = json!(v);
    }
    if let Some(src) = body[SOURCE].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        manifest[SOURCE] = json!(src);
    }
    manifest["updated_at"] = json!(now_secs());
    write_manifest(root, &slug, &manifest)?;
    apply_parts(root, &slug, body)?;
    Ok(plugin_view(root, &slug))
}

/// Install a plugin straight out of a git repo, the way Claude Desktop does:
/// read the bundle from the repo and write it through the SAME path a
/// hand-authored one takes — `create_plugin`, or `update_plugin` when the slug
/// already exists, so reinstalling updates instead of failing.
pub fn install_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let read = crate::repo::read_plugin(
        body["repo"].as_str().unwrap_or(""),
        body["repo_path"].as_str().unwrap_or(""),
        body["repo_ref"].as_str().unwrap_or(""),
    )?;
    // The bundle's own manifest names it; an explicit `name` still wins so the
    // user can install the same repo twice under two names.
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| read["name"].as_str().unwrap_or("").to_string());
    let mut payload = json!({
        "name": name,
        "slug": body["slug"].clone(),
        "description": read["description"].clone(),
        "source": read["source"].clone(),
        "skills": read["skills"].clone(),
    });
    // An empty version must not overwrite the default with "".
    if read["version"].as_str().is_some_and(|v| !v.trim().is_empty()) {
        payload["version"] = read["version"].clone();
    }
    if read["mcp"].as_object().is_some_and(|m| !m.is_empty()) {
        payload["mcp"] = read["mcp"].clone();
    }
    let slug = plugin_ref(&payload);
    let existed = plugin_dir(root, &slug).join(MANIFEST).is_file();
    let view = if existed {
        update_plugin(root, &payload)?
    } else {
        create_plugin(root, &payload)?
    };
    Ok(json!({
        "installed": if existed { "updated" } else { "created" },
        "slug": slug,
        "source": read["source"].clone(),
        "skills": view["skills"].clone(),
        "mcp": view["mcp"].clone(),
        "plugin": view,
    }))
}

/// Switch a plugin on/off. Without an explicit `enabled` the current value is
/// flipped, so the UI can call it as a plain toggle.
pub fn toggle_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    let Some(mut manifest) = read_manifest(root, &slug) else {
        return Err(format!("plugin not found: {slug}"));
    };
    let enabled = body["enabled"]
        .as_bool()
        .unwrap_or_else(|| !manifest["enabled"].as_bool().unwrap_or(true));
    manifest["enabled"] = json!(enabled);
    manifest["updated_at"] = json!(now_secs());
    write_manifest(root, &slug, &manifest)?;
    Ok(plugin_view(root, &slug))
}

/// Remove a plugin and everything inside it.
pub fn delete_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    let dir = plugin_dir(root, &slug);
    if !dir.exists() {
        return Ok(json!({ "ok": true, "slug": slug, "note": "already gone" }));
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "slug": slug, "note": "deleted" }))
}

/// Skills + connectors carried by a create/update call.
fn apply_parts(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    let dir = plugin_dir(root, slug);
    if let Some(list) = body["skills"].as_array() {
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim();
            if name.is_empty() {
                return Err("every entry in `skills` needs a name".into());
            }
            // The plugin folder IS a skill-store root, so the existing writer
            // owns the frontmatter/slug/extra-file rules for both stores.
            crate::skills::sync_skill(
                &dir,
                &json!({
                    "name": name,
                    "content": item["content"].clone(),
                    "description": item["description"].clone(),
                    "fa_keywords": item["fa_keywords"].clone(),
                    "extra_files": item["extra_files"].clone(),
                }),
            )?;
        }
    }
    if let Some(list) = body["deleted_skills"].as_array() {
        for item in list {
            let Some(name) = item.as_str() else { continue };
            if let Some(skill) = crate::skills::find_skill_dir_pub(&dir, name) {
                fs::remove_dir_all(skill).map_err(|e| e.to_string())?;
            }
        }
    }
    if body["mcp"].is_object() || body["deleted_mcp"].is_array() {
        // Merge, never replace: an update that only touches a skill must not
        // drop the connectors the call did not mention.
        let mut servers = read_connectors(root, slug);
        if let Some(map) = body["mcp"].as_object() {
            for (name, cfg) in map {
                servers.insert(name.clone(), cfg.clone());
            }
        }
        if let Some(list) = body["deleted_mcp"].as_array() {
            for item in list {
                if let Some(name) = item.as_str() {
                    servers.remove(name);
                }
            }
        }
        write_connectors(&dir, &servers)?;
    }
    Ok(())
}

/// Enabled plugin folders, sorted by slug.
fn enabled_plugins(root: &Path) -> Vec<(String, Value)> {
    let base = plugins_dir(root);
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Value)> = Vec::new();
    for entry in entries.flatten() {
        let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !entry.path().is_dir() {
            continue;
        }
        let Some(manifest) = read_manifest(root, &slug) else {
            continue;
        };
        if manifest["enabled"].as_bool().unwrap_or(true) {
            out.push((slug, manifest));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Skill rows of every ENABLED plugin, in the `skills::list_skills` shape plus a
/// `plugin` tag. A disabled plugin contributes nothing, which is how switching
/// one off removes its skills from the prompt catalog.
pub fn enabled_plugin_skills(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in enabled_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let listed = crate::skills::list_skills(&plugin_dir(root, &slug));
        for mut row in listed["skills"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
        {
            row["plugin"] = json!(label);
            out.push(row);
        }
    }
    out
}

/// Locate a skill folder inside ONE plugin: `<root>/plugins/<slug>/skills/<name>`.
///
/// `skills::find_skill_dir` already walks a skill-store root, and a plugin
/// folder is exactly one, so the rules for name-vs-slug and the frontmatter
/// fallback stay in a single place.
pub fn find_skill_dir(root: &Path, slug: &str, name_or_slug: &str) -> Option<PathBuf> {
    crate::skills::find_skill_dir_pub(&plugin_dir(root, slug), name_or_slug)
}

/// Slug of the ENABLED plugin that carries a skill called `name_or_slug`.
///
/// Needed because a plugin's skills are served from the plugin folder, not from
/// the standalone `<root>/skills` store: without this, `load_skill` (and the
/// `/skills/file` route) answered "skill not found" for every skill the prompt
/// catalog had just advertised. Disabled plugins are skipped, so switching a
/// plugin off stays a real off switch.
pub fn plugin_of_skill(root: &Path, name_or_slug: &str) -> Option<String> {
    let query = name_or_slug.trim();
    if query.is_empty() {
        return None;
    }
    for (slug, _) in enabled_plugins(root) {
        let listed = crate::skills::list_skills(&plugin_dir(root, &slug));
        let hit = listed["skills"].as_array().is_some_and(|rows| {
            rows.iter().any(|s| {
                let n = s["name"].as_str().unwrap_or_default().trim();
                let sl = s["slug"].as_str().unwrap_or_default().trim();
                n.eq_ignore_ascii_case(query) || sl.eq_ignore_ascii_case(query)
            })
        });
        if hit {
            return Some(slug);
        }
    }
    None
}

/// Connectors of EVERY enabled plugin, as one map.
///
/// A normal chat turn carries them along without the user adding each connector
/// in Settings → MCP: an enabled plugin is ONE unit, so its connectors come with
/// its skills (a scheduled run already behaved this way). A name the user
/// configured themselves wins, exactly like `mcp_of`.
pub fn enabled_connectors(root: &Path) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (slug, _) in enabled_plugins(root) {
        for (name, cfg) in read_connectors(root, &slug) {
            out.entry(name).or_insert(cfg);
        }
    }
    out
}

/// Connectors of the NAMED plugins, skipping disabled ones and ignoring slugs
/// that no longer exist — a task that names a deleted plugin still runs.
pub fn mcp_of(root: &Path, slugs: &[String]) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (slug, _) in enabled_plugins(root) {
        if !slugs.iter().any(|s| s == &slug) {
            continue;
        }
        for (name, cfg) in read_connectors(root, &slug) {
            out.entry(name).or_insert(cfg);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-plugin-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    #[test]
    fn enabled_connectors_come_from_every_enabled_plugin() {
        let root = temp_root("connectors");
        create_plugin(
            &root,
            &json!({
                "name": "Notes",
                "skills": [{"name": "Notes", "content": "x"}],
                "mcp": {"notes": {"command": "npx"}}
            }),
        )
        .unwrap();
        create_plugin(
            &root,
            &json!({
                "name": "Search",
                "skills": [{"name": "Search", "content": "x"}],
                "mcp": {"search": {"command": "npx"}}
            }),
        )
        .unwrap();

        // A chat turn carries an enabled plugin's connectors along — the whole
        // point of a bundle is that it switches on as ONE unit.
        let all = enabled_connectors(&root);
        assert!(all.contains_key("notes"), "{all:?}");
        assert!(all.contains_key("search"), "{all:?}");

        // Switching one off removes only ITS connector.
        toggle_plugin(&root, &json!({"slug": "notes", "enabled": false})).unwrap();
        let after = enabled_connectors(&root);
        assert!(!after.contains_key("notes"), "{after:?}");
        assert!(after.contains_key("search"), "{after:?}");
    }

    #[test]
    fn create_update_toggle_delete_round_trip() {
        let root = temp_root("round-trip");

        let created = create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "description": "turns git log into notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "# steps\n\nread the log",
                    "description": "when the user asks for release notes",
                    "fa_keywords": "یادداشت انتشار"
                }],
                "mcp": {"notes": {"command": "npx"}}
            }),
        )
        .unwrap();
        assert_eq!(created["slug"], "release-notes");
        assert_eq!(created["enabled"], true);
        assert_eq!(created["skills"], json!(["Release Notes"]));
        assert_eq!(created["mcp"], json!(["notes"]));
        assert!(plugin_dir(&root, "release-notes").join(MANIFEST).is_file());

        // A second create on the same slug must fail instead of overwriting.
        let dup = create_plugin(&root, &json!({"name": "Release Notes"}));
        assert!(dup.is_err(), "duplicate create must be rejected");

        // Patch update: description changes, the skill stays.
        let updated = update_plugin(
            &root,
            &json!({"slug": "release-notes", "version": "2.0.0"}),
        )
        .unwrap();
        assert_eq!(updated["version"], "2.0.0");
        assert_eq!(updated["skills"], json!(["Release Notes"]));
        assert_eq!(updated["description"], "turns git log into notes");

        // Disabled plugins contribute nothing to the catalog or the connectors.
        toggle_plugin(&root, &json!({"slug": "release-notes", "enabled": false})).unwrap();
        assert!(enabled_plugin_skills(&root).is_empty());
        assert!(mcp_of(&root, &["release-notes".to_string()]).is_empty());
        assert_eq!(list_plugins(&root)["plugins"].as_array().unwrap().len(), 1);

        let on = toggle_plugin(&root, &json!({"slug": "release-notes"})).unwrap();
        assert_eq!(on["enabled"], true);
        let rows = enabled_plugin_skills(&root);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["plugin"], "Release Notes");
        assert!(mcp_of(&root, &["release-notes".to_string()]).contains_key("notes"));
        // An unnamed plugin contributes nothing to a task's connectors.
        assert!(mcp_of(&root, &[]).is_empty());

        delete_plugin(&root, &json!({"slug": "release-notes"})).unwrap();
        assert!(list_plugins(&root)["plugins"].as_array().unwrap().is_empty());
        assert!(enabled_plugin_skills(&root).is_empty());
        // Deleting twice is a no-op, not an error.
        assert!(delete_plugin(&root, &json!({"slug": "release-notes"})).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn update_requires_an_existing_plugin() {
        let root = temp_root("missing");
        assert!(update_plugin(&root, &json!({"slug": "ghost"})).is_err());
        assert!(toggle_plugin(&root, &json!({"slug": "ghost"})).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plugin_skill_can_be_located_and_read() {
        // A plugin's skills live in `<root>/plugins/<slug>/skills/`, not in the
        // standalone store. `load_skill` used to read only the store, so every
        // skill the catalog advertised from a plugin answered "skill not found".
        let root = temp_root("locate");
        create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "# steps\n\nread the log",
                    "fa_keywords": "یادداشت انتشار",
                    "extra_files": {"checklist.md": "- tag the release"}
                }]
            }),
        )
        .unwrap();

        assert_eq!(plugin_of_skill(&root, "Release Notes").as_deref(), Some("release-notes"));
        // The folder slug resolves the skill too, case-insensitively.
        assert_eq!(plugin_of_skill(&root, "release-notes").as_deref(), Some("release-notes"));
        let dir = find_skill_dir(&root, "release-notes", "Release Notes").expect("skill folder");
        assert!(dir.join("skill.md").is_file());
        let extra = crate::skills::read_extra_file(&dir, "Release Notes", "checklist.md").unwrap();
        assert_eq!(extra["content"], "- tag the release");

        // A disabled plugin is a real off switch: nothing resolves.
        toggle_plugin(&root, &json!({"slug": "release-notes", "enabled": false})).unwrap();
        assert!(plugin_of_skill(&root, "Release Notes").is_none());
        // Unknown names and blank queries resolve to nothing, never to a panic.
        assert!(plugin_of_skill(&root, "Ghost").is_none());
        assert!(plugin_of_skill(&root, "  ").is_none());

        let _ = fs::remove_dir_all(&root);
    }
}
