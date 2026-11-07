//! One-shot migration of the two standalone stores into plugin bundles.
//!
//! The app used to keep three parallel places: `skills/` (the user's own store),
//! `mcp/` (connectors) and `plugins/` (bundles). A plugin is already a container
//! for all of it, so the first two are folded in here: every stored skill and
//! every connector becomes its OWN single-part bundle. One bundle per item — not
//! one big bundle — because the bundle's `enabled` flag is the only switch left,
//! and a merged bundle would make it impossible to turn one skill off alone.
//!
//! Runs once, before any reader touches the stores (main.rs setup), and leaves a
//! marker so a bundle the user later deletes is never resurrected.

use std::path::Path;

use serde_json::{json, Value};

/// Marker that names the migration: its PRESENCE is the guard, so the work is
/// never repeated. Lives beside the stores it consumed.
const MIGRATED: &str = ".stores-in-bundles";

/// Atomic text write: temp file + fsync + rename, so a crash or power loss
/// mid-write can never tear the file.
///
/// The rename migration rewrites `settings.json` — the WHOLE store document.
/// The store layer itself publishes it temp+rename (`store::write_document`),
/// and a migration must meet the same bar: a torn settings.json reads back as
/// an empty store, and the next `store_set` would happily persist that
/// emptiness over the user's providers (encrypted API keys included) and chat
/// index.
fn atomic_write_text(path: &Path, text: &str) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return false;
    };
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!("{name}.tmp{}.{unique}", std::process::id()));
    {
        use std::io::Write;
        let Ok(mut f) = std::fs::File::create(&tmp) else {
            return false;
        };
        if f.write_all(text.as_bytes()).is_err() || f.sync_all().is_err() {
            let _ = std::fs::remove_file(&tmp);
            return false;
        }
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

/// Fold `<root>/skills/*` and `<root>/mcp/*.json` into plugin bundles.
///
/// Returns the number of bundles written. Idempotent: a second call does nothing,
/// and a single item that fails to convert is skipped rather than aborting the
/// rest (one unreadable file must not leave the user with a half-migrated app).
pub fn standalone_stores_to_bundles(root: &Path) -> usize {
    if root.join(MIGRATED).exists() {
        return 0;
    }
    let mut written = 0;
    written += skills_to_bundles(root);
    written += connectors_to_bundles(root);
    // The marker is written even when there was nothing to do: the stores could
    // appear later only if a user restored an old backup, and re-running the
    // migration then would fight the bundles they already have.
    let _ = std::fs::write(root.join(MIGRATED), format!("{written}\n"));
    written
}

/// Delete the two store folders a migration left behind, now that their content
/// is in bundles.
///
/// The migration COPIES rather than moves — a failure halfway through must not
/// lose the only copy — and its marker stops it from ever running again, so
/// without this the stale `skills/` and `mcp/` folders outlive the change for
/// good. That is exactly what happened on an install migrated before this step:
/// the bundles were written and the originals were left sitting next to them.
///
/// Only a copy CONFIRMED to exist in a bundle is removed, matched by NAME: an
/// item written into the old store after the marker was dropped has no bundle
/// behind it, so it is still the user's only copy and is left alone.
///
/// Returns how many leftovers were removed.
pub fn prune_migrated_stores(root: &Path) -> usize {
    if !root.join(MIGRATED).exists() {
        // Nothing was migrated here, so nothing in these folders is a copy.
        return 0;
    }
    prune_skill_store(root) + prune_connector_store(root)
}

/// Drop every `skills/<slug>/` whose skill already lives in a bundle.
/// Drop every `skills/<slug>/` whose skill already lives in a bundle.
fn prune_skill_store(root: &Path) -> usize {
    let base = crate::skills::skills_dir_pub(root);
    let Ok(entries) = std::fs::read_dir(&base) else {
        return 0;
    };
    let in_bundles: Vec<String> = crate::plugins::all_plugin_skills(root)
        .iter()
        .filter_map(|row| row["name"].as_str().map(|n| n.trim().to_lowercase()))
        .collect();
    let mut removed = 0;
    for entry in entries.flatten() {
        let dir = entry.path();
        let md = dir.join("skill.md");
        if !dir.is_dir() || !md.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&md) else {
            continue;
        };
        let (name, _, _) = crate::skills::parse_frontmatter_pub(&raw);
        let key = name.trim().to_lowercase();
        if key.is_empty() || !in_bundles.contains(&key) {
            continue;
        }
        // Extra files travel with the folder, exactly as the migration carried
        // them into the bundle, so nothing is lost by taking the whole thing.
        if std::fs::remove_dir_all(&dir).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 && dir_is_empty(&base) {
        let _ = std::fs::remove_dir(&base);
    }
    removed
}

/// Drop every `mcp/<name>.json` whose connector already lives in a bundle.
fn prune_connector_store(root: &Path) -> usize {
    let base = root.join("mcp");
    let Ok(entries) = std::fs::read_dir(&base) else {
        return 0;
    };
    let in_bundles = crate::plugins::all_connector_names(root);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(name) = record["name"].as_str().map(str::trim).filter(|n| !n.is_empty()) else {
            continue;
        };
        if !in_bundles.iter().any(|n| n == name) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 && dir_is_empty(&base) {
        let _ = std::fs::remove_dir(&base);
    }
    removed
}

/// `true` when a folder holds nothing worth keeping.
///
/// `find`-style emptiness is not enough on macOS: Finder drops a `.DS_Store` in
/// the folder it was last opened in, so `skills/` kept a file and stayed behind
/// after every skill in it had been moved into a bundle. A sidecar is not
/// content, so it is REMOVED when it is the only thing left — otherwise the
/// folder can never be taken away. Anything else still counts as content.
fn dir_is_empty(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut only_sidecars = true;
    for entry in entries.flatten() {
        let leaf = entry.file_name().to_string_lossy().to_string();
        if leaf == ".DS_Store" || leaf == ".localized" {
            let _ = std::fs::remove_file(entry.path());
        } else {
            only_sidecars = false;
        }
    }
    only_sidecars
}

/// One bundle per stored skill, carrying that skill and nothing else.
fn skills_to_bundles(root: &Path) -> usize {
    let base = root.join("skills");
    let Ok(entries) = std::fs::read_dir(&base) else {
        return 0;
    };
    let mut written = 0;
    for entry in entries.flatten() {
        let dir = entry.path();
        let md = dir.join("skill.md");
        if !dir.is_dir() || !md.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&md) else {
            continue;
        };
        let (name, _slug, description) = crate::skills::parse_frontmatter_pub(&raw);
        if name.trim().is_empty() {
            continue;
        }
        let content = crate::skills::strip_frontmatter_pub(&raw);
        // Extra files travel with the skill: a bundle is the only home it has
        // now, and dropping them would lose data the user may rely on.
        let mut extra = serde_json::Map::new();
        if let Ok(files) = std::fs::read_dir(&dir) {
            for file in files.flatten() {
                let Some(fname) = file.file_name().into_string().ok() else {
                    continue;
                };
                if fname.eq_ignore_ascii_case("skill.md") || fname == crate::skills::SHIPPED_MARKER
                {
                    continue;
                }
                if !file.path().is_file() {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(file.path()) {
                    extra.insert(fname, json!(text));
                }
            }
        }
        let mut skill = json!({
            "name": name,
            "description": description,
            "content": content,
        });
        if !extra.is_empty() {
            skill["extra_files"] = Value::Object(extra);
        }
        if crate::plugins::install_bundle(root, &name, json!({ "skills": [skill] })).is_ok() {
            written += 1;
        }
    }
    written
}

/// One bundle per connector file, keeping the on/off state the user had.
///
/// Enablement used to live in `settings.json` as an allowlist (`mcpEnabled`),
/// where a name that is ABSENT is off — so absence must become `enabled: false`.
/// Turning a connector on by itself would put tools in front of the model that
/// the user had deliberately switched off.
fn connectors_to_bundles(root: &Path) -> usize {
    let base = root.join("mcp");
    let enabled = settings_mcp_enabled(root);
    let Ok(entries) = std::fs::read_dir(&base) else {
        return 0;
    };
    let mut written = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(name) = record["name"].as_str().map(str::trim).filter(|n| !n.is_empty()) else {
            continue;
        };
        let Some(cfg) = record.get("config").filter(|c| c.is_object()) else {
            continue;
        };
        let on = enabled.iter().any(|n| n == name);
        let mut servers = serde_json::Map::new();
        servers.insert(name.to_string(), cfg.clone());
        let parts = json!({
            "mcp": Value::Object(servers),
            "enabled": on,
        });
        if crate::plugins::install_bundle(root, name, parts).is_ok() {
            written += 1;
        }
    }
    written
}

/// The `mcpEnabled` allowlist out of `settings.json` (empty when unreadable).
fn settings_mcp_enabled(root: &Path) -> Vec<String> {
    std::fs::read_to_string(root.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| {
            v["mcpEnabled"].as_array().map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Marker that the built-in bundle rename already ran. Without it a plugin the
/// user later names `docker` (or `builtin-skills`) would be renamed on the next
/// boot, because the folder name alone cannot tell it from the old seed.
const BUILTIN_RENAMED: &str = ".builtin-bundles-renamed";

/// Rename the two seeded bundles whose names changed after they first shipped.
///
/// The constants alone would leave an existing install with BOTH folders: the
/// old `builtin-skills`/`docker` bundle keeps its data, and the seeder writes a
/// fresh `builtin-plugin`/`docker-mcp` beside it. This moves the folder, patches
/// its manifest and connector keys, and carries user additions along. It also
/// rewrites saved schedules and the settings snapshot, which refer to the old
/// names. Idempotent: the marker stops a second boot from touching a bundle the
/// user made later with one of the old names.
pub fn rename_builtin_bundles(root: &Path) -> usize {
    if root.join(BUILTIN_RENAMED).exists() {
        return 0;
    }
    let mut changed = 0;
    if rename_bundle(root, "builtin-skills", crate::plugins::BUILTIN_BUNDLE_SLUG) {
        changed += 1;
    }
    if rename_bundle(root, "docker", crate::plugins::DOCKER_BUNDLE) {
        changed += 1;
    }
    // Patch identity even when the folder was already renamed on an earlier
    // boot: an interrupted migration may have moved the folder but not written
    // the manifest.
    if patch_manifest_identity(
        &root.join("plugins").join(crate::plugins::BUILTIN_BUNDLE_SLUG),
        crate::plugins::BUILTIN_BUNDLE_NAME,
        crate::plugins::BUILTIN_BUNDLE_SLUG,
    ) {
        changed += 1;
    }
    if patch_manifest_identity(
        &root.join("plugins").join(crate::plugins::DOCKER_BUNDLE),
        crate::plugins::DOCKER_BUNDLE,
        crate::plugins::DOCKER_BUNDLE,
    ) {
        changed += 1;
    }
    if patch_docker_connector_key(root) {
        changed += 1;
    }
    changed += rewrite_schedule_refs(root);
    changed += rewrite_settings_refs(root);
    // A failed move leaves an old folder behind: keep the marker off so the
    // next boot retries instead of stranding the user's data under the old name.
    let leftover = root.join("plugins").join("builtin-skills").is_dir()
        || root.join("plugins").join("docker").is_dir();
    if !leftover {
        let _ = std::fs::write(root.join(BUILTIN_RENAMED), format!("{changed}\n"));
    }
    changed
}

/// Move one plugin folder, merging into the destination when it already exists.
fn rename_bundle(root: &Path, from: &str, to: &str) -> bool {
    let base = root.join("plugins");
    let src = base.join(from);
    let dst = base.join(to);
    if !src.is_dir() {
        return false;
    }
    if dst.exists() {
        // A partially migrated install can hold both. Keep the destination's
        // files and copy only what is missing, so no user addition is lost.
        merge_missing(&src, &dst);
        std::fs::remove_dir_all(&src).is_ok()
    } else {
        std::fs::rename(&src, &dst).is_ok()
    }
}

/// Recursively copy files the destination does not already have. JSON files
/// (`plugin.json`, `mcp.json`) are merged by key so a connector or keyword from
/// the old folder is not dropped just because the destination has the file.
fn merge_missing(src: &Path, dst: &Path) {
    if std::fs::create_dir_all(dst).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(src) else {
        return;
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let Some(name) = from.file_name() else {
            continue;
        };
        let to = dst.join(name);
        if from.is_dir() {
            merge_missing(&from, &to);
            continue;
        }
        if !to.exists() {
            let _ = std::fs::copy(&from, &to);
            continue;
        }
        if matches!(name.to_str(), Some("plugin.json") | Some("mcp.json")) {
            merge_json_objects(&from, &to);
        }
    }
}

fn merge_json_objects(src: &Path, dst: &Path) {
    let Ok(from_text) = std::fs::read_to_string(src) else {
        return;
    };
    let Ok(to_text) = std::fs::read_to_string(dst) else {
        return;
    };
    let Ok(Value::Object(mut to)) = serde_json::from_str::<Value>(&to_text) else {
        return;
    };
    let Ok(Value::Object(from)) = serde_json::from_str::<Value>(&from_text) else {
        return;
    };
    for (key, value) in from {
        to.entry(key).or_insert(value);
    }
    let _ = std::fs::write(dst, Value::Object(to).to_string());
}

/// Set a bundle manifest's display name and slug without touching anything the
/// user changed (enabled, description, keywords, connector metadata).
fn patch_manifest_identity(dir: &Path, name: &str, slug: &str) -> bool {
    let path = dir.join("plugin.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(Value::Object(mut manifest)) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let mut changed = false;
    if manifest.get("name").and_then(Value::as_str) != Some(name) {
        manifest.insert("name".into(), json!(name));
        changed = true;
    }
    if manifest.get("slug").and_then(Value::as_str) != Some(slug) {
        manifest.insert("slug".into(), json!(slug));
        changed = true;
    }
    if changed {
        let raw = serde_json::to_string_pretty(&Value::Object(manifest)).unwrap_or_default();
        atomic_write_text(&path, &raw);
    }
    changed
}

/// Rename the connector key inside the Docker bundle and its manifest metadata.
fn patch_docker_connector_key(root: &Path) -> bool {
    let dir = root.join("plugins").join(crate::plugins::DOCKER_BUNDLE);
    let mut changed = false;
    let mcp_path = dir.join("mcp.json");
    if let Ok(text) = std::fs::read_to_string(&mcp_path) {
        if let Ok(Value::Object(mut servers)) = serde_json::from_str::<Value>(&text) {
            if let Some(cfg) = servers.remove("docker") {
                servers.entry(crate::plugins::DOCKER_BUNDLE.to_string()).or_insert(cfg);
                atomic_write_text(&mcp_path, &Value::Object(servers).to_string());
                changed = true;
            }
        }
    }
    let manifest_path = dir.join("plugin.json");
    if let Ok(text) = std::fs::read_to_string(&manifest_path) {
        if let Ok(Value::Object(mut manifest)) = serde_json::from_str::<Value>(&text) {
            if let Some(Value::Object(mut meta)) = manifest.get_mut("connector_meta").cloned() {
                if let Some(entry) = meta.remove("docker") {
                    meta.entry(crate::plugins::DOCKER_BUNDLE.to_string()).or_insert(entry);
                    manifest.insert("connector_meta".into(), Value::Object(meta));
                    let raw = serde_json::to_string_pretty(&Value::Object(manifest)).unwrap_or_default();
                    atomic_write_text(&manifest_path, &raw);
                    changed = true;
                }
            }
        }
    }
    changed
}

/// Point saved schedules at the renamed bundles. Legacy `skills`/`mcp_servers`
/// fields are rewritten too, because the scheduler still reads them.
fn rewrite_schedule_refs(root: &Path) -> usize {
    let dir = root.join("schedules");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut changed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(Value::Object(mut task)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let mut touched = false;
        for key in ["plugins", "skills", "mcp_servers"] {
            let Some(items) = task.get_mut(key).and_then(Value::as_array_mut) else {
                continue;
            };
            for item in items {
                let Some(name) = item.as_str() else {
                    continue;
                };
                let next = match name {
                    "builtin-skills" => Some(crate::plugins::BUILTIN_BUNDLE_SLUG),
                    "docker" => Some(crate::plugins::DOCKER_BUNDLE),
                    _ => None,
                };
                if let Some(next) = next {
                    *item = json!(next);
                    touched = true;
                }
            }
        }
        if touched {
            if let Ok(raw) = serde_json::to_string_pretty(&Value::Object(task)) {
                if atomic_write_text(&path, &raw) {
                    changed += 1;
                }
            }
        }
    }
    changed
}

/// Rename the connector in the settings snapshot too. The live MCP list comes
/// from the bundles, but `settings.json` keeps a copy that the renderer merges
/// at startup; leaving `docker` there would show a ghost connector.
fn rewrite_settings_refs(root: &Path) -> usize {
    let path = root.join("settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(Value::Object(mut settings)) = serde_json::from_str::<Value>(&text) else {
        return 0;
    };
    let mut changed = false;
    if let Some(Value::Object(mut servers)) = settings.get("mcpServers").cloned() {
        if let Some(cfg) = servers.remove("docker") {
            servers.entry(crate::plugins::DOCKER_BUNDLE.to_string()).or_insert(cfg);
            settings.insert("mcpServers".into(), Value::Object(servers));
            changed = true;
        }
    }
    if let Some(Value::Array(enabled)) = settings.get("mcpEnabled").cloned() {
        let mut names: Vec<String> = Vec::new();
        for item in enabled {
            let name = match item.as_str() {
                Some("docker") => {
                    changed = true;
                    crate::plugins::DOCKER_BUNDLE.to_string()
                }
                Some(name) => name.to_string(),
                None => continue,
            };
            if !names.contains(&name) {
                names.push(name);
            }
        }
        if names.len() != settings["mcpEnabled"].as_array().map_or(0, Vec::len) {
            changed = true;
        }
        settings.insert("mcpEnabled".into(), json!(names));
    }
    if changed {
        if let Ok(raw) = serde_json::to_string(&Value::Object(settings)) {
            return usize::from(atomic_write_text(&path, &raw));
        }
    }
    0
}

#[cfg(test)]
mod tests;
