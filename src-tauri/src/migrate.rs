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
        let (name, _, _, _) = crate::skills::parse_frontmatter_pub(&raw);
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
        let (name, _slug, description, fa_keywords) = crate::skills::parse_frontmatter_pub(&raw);
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
            "fa_keywords": fa_keywords,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_leftover_stores_are_removed_once_their_content_is_in_bundles() {
        // The reported bug: after migrating, `skills/` and `mcp/` stayed on disk
        // beside the bundles that already held the same content — and because the
        // marker stopped the migration from re-running, nothing ever cleaned them.
        let root = temp_root("prune");
        write_skill(&root, "movie-finder", "Movie Finder", "فیلم، سریال");
        write_connector(&root, "docker", "docker");
        standalone_stores_to_bundles(&root);

        assert_eq!(prune_migrated_stores(&root), 2);
        assert!(!root.join("skills").exists(), "the skills store is gone");
        assert!(!root.join("mcp").exists(), "the connector store is gone");
        // The copies that matter are still there, in their bundles.
        assert_eq!(crate::plugins::all_plugin_skills(&root).len(), 1);
        assert_eq!(crate::plugins::all_connector_names(&root).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_skill_written_after_the_migration_keeps_its_only_copy() {
        // The cleanup must not eat data: a folder dropped into the old store
        // AFTER the marker was written has no bundle behind it.
        let root = temp_root("prune-late");
        write_skill(&root, "movie-finder", "Movie Finder", "فیلم، سریال");
        standalone_stores_to_bundles(&root);
        write_skill(&root, "late-arrival", "Late Arrival", "دیر رسیده");

        assert_eq!(prune_migrated_stores(&root), 1);
        assert!(
            root.join("skills").join("late-arrival").join("skill.md").is_file(),
            "the only copy of a skill has to survive the cleanup"
        );
        assert!(!root.join("skills").join("movie-finder").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-migrate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(root: &Path, slug: &str, name: &str, keywords: &str) {
        let dir = root.join("skills").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let mut md = format!("---\nname: {name}\ndescription: does {name}\n");
        if !keywords.is_empty() {
            md.push_str(&format!("fa_keywords: {keywords}\n"));
        }
        md.push_str("---\n\n# body\n\nthe steps\n");
        std::fs::write(dir.join("skill.md"), md).unwrap();
        std::fs::write(dir.join("notes.md"), "extra").unwrap();
    }

    fn write_connector(root: &Path, name: &str, command: &str) {
        let dir = root.join("mcp");
        std::fs::create_dir_all(&dir).unwrap();
        let record = json!({ "name": name, "config": { "command": command } });
        std::fs::write(dir.join(format!("{name}.json")), record.to_string()).unwrap();
    }

    /// Manual check on a COPY of a real data root (`CODIFA_PRUNE_ROOT`).
    ///
    /// The boot step cannot be exercised from a test any other way without
    /// touching the user's own folder, and the whole point is to prove that the
    /// two leftover stores of an ALREADY-migrated install get taken away.
    #[test]
    #[ignore]
    fn manual_prune_on_a_copy() {
        let root = std::path::PathBuf::from(std::env::var("CODIFA_PRUNE_ROOT").unwrap());
        // Exactly what a migrated install has on disk.
        let _ = std::fs::write(root.join(MIGRATED), "26\n");
        let count = |p: &Path| {
            std::fs::read_dir(p)
                .map(|d| {
                    d.flatten()
                        .filter(|e| e.file_name().to_string_lossy() != ".DS_Store")
                        .count()
                })
                .unwrap_or(0)
        };
        let skills = count(&root.join("skills"));
        let mcp = count(&root.join("mcp"));
        let removed = prune_migrated_stores(&root);
        println!("BEFORE skills={skills} mcp={mcp} -> removed={removed}");
        println!(
            "AFTER  skills_dir={} mcp_dir={} docker_kept={}",
            root.join("skills").exists(),
            root.join("mcp").exists(),
            crate::plugins::plugin_dir_of(&root, "docker")
                .join("plugin.json")
                .exists()
        );
        // `.DS_Store` is a macOS sidecar, not content: the prune ignores it, so
        // the assertion is about NAMED entries and about the folders themselves.
        let named = |p: &Path| {
            std::fs::read_dir(p)
                .map(|d| {
                    d.flatten()
                        .filter(|e| e.file_name().to_string_lossy() != ".DS_Store")
                        .count()
                })
                .unwrap_or(0)
        };
        assert_eq!(
            named(&root.join("skills")) + named(&root.join("mcp")),
            0,
            "no named entry may be left behind"
        );
        assert!(
            !root.join("skills").exists() && !root.join("mcp").exists(),
            "both store folders must be gone"
        );
        assert_eq!(removed, skills + mcp, "every named entry was pruned");
    }

    #[test]
    fn a_stored_skill_becomes_its_own_bundle() {
        let root = temp_root("skill");
        write_skill(&root, "movie-finder", "Movie Finder", "فیلم، سریال");
        assert_eq!(standalone_stores_to_bundles(&root), 1);

        let listed = crate::plugins::list_plugins(&root);
        let rows = listed["plugins"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "one bundle per skill: {listed}");
        let view = &rows[0];
        assert_eq!(view["name"], "Movie Finder");
        assert_eq!(view["skills"], json!(["Movie Finder"]));
        assert_eq!(view["fa_keywords"], json!(["فیلم", "سریال"]));
        // The body and the extra file survive, so nothing the user wrote is lost.
        let row = &crate::plugins::all_plugin_skills(&root)[0];
        assert!(row["content"].as_str().unwrap().contains("the steps"));
        assert_eq!(row["files"], json!(["notes.md"]));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_connector_absent_from_the_allowlist_lands_switched_off() {
        let root = temp_root("conn");
        write_connector(&root, "docker", "docker");
        write_connector(&root, "quiet", "quiet-mcp");
        std::fs::write(
            root.join("settings.json"),
            json!({ "mcpEnabled": ["docker"] }).to_string(),
        )
        .unwrap();
        assert_eq!(standalone_stores_to_bundles(&root), 2);

        let rows = crate::plugins::list_plugins(&root);
        let mut state: Vec<(String, bool)> = rows["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["name"].as_str().unwrap().to_string(),
                    p["enabled"].as_bool().unwrap_or(true),
                )
            })
            .collect();
        state.sort();
        // The reported requirement: nothing turns ON by itself. `docker` was in
        // the allowlist, `quiet` was not, so the migration reproduces exactly
        // that — and the enabled one feeds the agent's connector map.
        assert_eq!(
            state,
            vec![("docker".to_string(), true), ("quiet".to_string(), false)]
        );
        let live = crate::plugins::enabled_connectors(&root);
        assert!(live.contains_key("docker"));
        assert!(!live.contains_key("quiet"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_migration_runs_once_and_never_resurrects_a_deleted_bundle() {
        let root = temp_root("once");
        write_skill(&root, "keeper", "Keeper", "");
        assert_eq!(standalone_stores_to_bundles(&root), 1);
        // A second boot must not rewrite anything…
        assert_eq!(standalone_stores_to_bundles(&root), 0);

        // …and a bundle the user deletes stays deleted, even with the store
        // still on disk (an old backup restored, or a file the migration missed).
        let dir = crate::plugins::plugin_dir_of(&root, "keeper");
        assert!(dir.is_dir(), "bundle folder should exist");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(standalone_stores_to_bundles(&root), 0);
        assert_eq!(crate::plugins::list_plugins(&root)["plugins"], json!([]));
        let _ = std::fs::remove_dir_all(&root);
    }
}
