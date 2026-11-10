use super::*;

/// Folder of one bundle, for callers outside this module (tests, migration).
#[cfg(test)]
pub fn plugin_dir_of(root: &Path, slug: &str) -> PathBuf {
    plugin_dir(root, slug)
}

/// Every bundle folder with its manifest, sorted by slug.
pub fn all_plugins(root: &Path) -> Vec<(String, Value)> {
    let Ok(entries) = fs::read_dir(plugins_dir(root)) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Value)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(manifest) = read_manifest(root, &slug) {
            out.push((slug, manifest));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Folder of a SKILL inside any bundle, matched by name or folder slug.
///
/// Skills have no store of their own, so "where does this skill live" is
/// answered by looking inside every bundle — the lookup the boot seeder and the
/// editor both need now that `skills::find_skill_dir` covers no store.
pub fn skill_dir_for(root: &Path, name_or_slug: &str) -> Option<PathBuf> {
    if name_or_slug.trim().is_empty() {
        return None;
    }
    for (slug, _) in all_plugins(root) {
        if let Some(dir) =
            crate::skills::find_skill_dir_pub(&plugin_dir(root, &slug), name_or_slug)
        {
            return Some(dir);
        }
    }
    None
}

/// Write one skill into the bundle that owns it, or into a NEW one named after it.
///
/// A skill has no store of its own any more, so "where does this skill go" is
/// decided by who already owns it (`plugin_of_skill`, matched on the new name AND
/// the previous one so a rename stays in the same bundle). Otherwise it gets a
/// single-part bundle of its own — the granularity the switch needs.
pub fn save_bundle_skill(root: &Path, skill: Value) -> Result<Value, String> {
    let name = skill["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("skill name is required".into());
    }
    // A DELETE goes through the bundle-aware deleter: the folder is removed, and
    // a bundle that held only that skill goes with it.
    if skill["delete"].as_bool().unwrap_or(false) {
        return delete_bundle_skill(root, &name);
    }
    let previous = skill["previous_name"].as_str().unwrap_or("").trim().to_string();
    let owner = plugin_of_skill_any(root, &name)
        .or_else(|| if previous.is_empty() { None } else { plugin_of_skill_any(root, &previous) });
    let slug = match owner {
        // An existing bundle: address it by SLUG and leave its name alone (only
        // present fields are patched, so omitting `name` cannot rename it).
        Some(slug) => {
            let manifest = read_manifest(root, &slug).unwrap_or_else(|| json!({}));
            let mut payload = json!({ "slug": slug, "skills": [skill] });
            if let Some(n) = manifest["name"].as_str() {
                payload["name"] = json!(n);
            }
            write_bundle_payload(root, &payload)?;
            slug
        }
        None => {
            install_bundle(root, &name, json!({ "skills": [skill] }))?;
            plugin_slug(&name, "")
        }
    };
    // The SHAPE the skill callers expect (`sync_skill`'s reply): the tool result
    // and the Settings toast both read these keys, so a bundle write has to
    // report the same way a store write used to.
    let dir = skill_dir_for(root, &name).unwrap_or_else(|| plugin_dir(root, &slug));
    // The same listing `sync_skill` reports: the editor refreshes its file list
    // from this reply, so a hard-coded empty array hid the extra files the call
    // had just written or kept.
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|f| {
                    !f.eq_ignore_ascii_case("skill.md") && f != crate::skills::SHIPPED_MARKER
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    Ok(json!({
        "ok": true,
        "name": name,
        "slug": slug,
        "path": dir.join("skill.md").to_string_lossy(),
        "note": "saved",
        "files": files,
        "renamed_from": if previous.is_empty() { Value::Null } else { json!(previous) },
    }))
}

/// Delete one skill wherever it lives, and drop its bundle when it was alone.
///
/// A bundle that held ONLY that skill disappears: keeping an empty folder would
/// leave a switch in Settings with nothing behind it. A bundle with more in it
/// (another skill, a connector, a script) just loses the one skill.
pub fn delete_bundle_skill(root: &Path, name: &str) -> Result<Value, String> {
    let Some(slug) = plugin_of_skill_any(root, name) else {
        return Ok(json!({ "ok": true, "note": "already gone" }));
    };
    let only_part = skill_names(root, &slug).len() <= 1
        && connector_names(root, &slug).is_empty()
        && script_names(root, &slug).is_empty();
    if only_part {
        fs::remove_dir_all(plugin_dir(root, &slug)).map_err(|e| e.to_string())?;
        return Ok(json!({ "ok": true, "note": "deleted" }));
    }
    let manifest = read_manifest(root, &slug).unwrap_or_else(|| json!({}));
    let mut payload = json!({ "slug": slug, "deleted_skills": [name] });
    if let Some(n) = manifest["name"].as_str() {
        payload["name"] = json!(n);
    }
    write_bundle_payload(root, &payload)?;
    Ok(json!({ "ok": true, "note": "deleted" }))
}

/// Save one connector into the bundle that owns it, or into a new single-part
/// bundle named after it. `previous_name` renames in place (see [`save_connector`]).
pub fn save_bundle_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let previous = body["previous_name"].as_str().unwrap_or("").trim();
    let cfg = body.get("cfg").cloned().unwrap_or_else(|| json!({}));
    if !cfg.is_object() {
        return Err("connector config must be an object".into());
    }
    // The row's own description travels in the SAME call but is stored in the
    // bundle manifest — never inside the connector's config, which is forwarded
    // to the MCP server verbatim.
    let entry = json!({
        "description": body["description"].as_str().unwrap_or(""),
    });
    let has_meta = body.get("description").is_some();
    match connector_target(root, body, name, previous) {
        Some(slug) => {
            if has_meta {
                write_connector_meta(root, &slug, name, &entry)?;
            }
            save_connector(root, &json!({ "slug": slug, "name": name, "previous_name": previous, "cfg": cfg }))
        }
        None => {
            let mut servers = serde_json::Map::new();
            servers.insert(name.to_string(), cfg);
            let made = install_bundle(root, name, json!({ "mcp": Value::Object(servers) }))?;
            if has_meta {
                if let Some(slug) = made["slug"].as_str() {
                    write_connector_meta(root, slug, name, &entry)?;
                }
            }
            Ok(made)
        }
    }
}

/// Which bundle a connector call targets.
///
/// An explicit `slug` wins: Settings opens a bundle's page and saves the row
/// from there, so the bundle on screen IS the target — without this, saving a
/// connector into an existing bundle silently created a SECOND bundle named
/// after the connector. Only when no slug is given (a caller that names just
/// the connector) does the owner lookup decide, and a rename looks up `previous_name`
/// first so it finds the row it is moving. `None` means a brand-new connector
/// that needs a single-part bundle of its own.
pub(super) fn connector_target(root: &Path, body: &Value, name: &str, previous: &str) -> Option<String> {
    let slug = body["slug"].as_str().unwrap_or("").trim();
    if !slug.is_empty() && read_manifest(root, slug).is_some() {
        return Some(slug.to_string());
    }
    connector_owner(root, name)
        .or_else(|| if previous.is_empty() { None } else { connector_owner(root, previous) })
}

/// Which bundle holds a connector by that name (first match, slug order).
pub(super) fn connector_owner(root: &Path, name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return None;
    }
    all_plugins(root)
        .into_iter()
        .find(|(slug, _)| read_connectors(root, slug).contains_key(name))
        .map(|(slug, _)| slug)
}

/// Delete a connector from the bundle that owns it, removing the bundle when it
/// was alone.
pub fn delete_bundle_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let Some(slug) = connector_target(root, body, name, "") else {
        return Ok(json!({ "ok": true, "removed": false }));
    };
    let only_part = connector_names(root, &slug).len() <= 1
        && skill_names(root, &slug).is_empty()
        && command_names(root, &slug).is_empty()
        && agent_names(root, &slug).is_empty()
        && !crate::hooks::hooks_file(&plugin_dir(root, &slug)).is_file()
        && script_names(root, &slug).is_empty();
    if only_part {
        let removed = fs::remove_dir_all(plugin_dir(root, &slug)).is_ok();
        return Ok(json!({ "ok": true, "removed": removed }));
    }
    delete_connector(root, &json!({ "slug": slug, "name": name }))
}

/// The connector config seeded for the browser before the native driver replaced
/// it, kept here only so an install that already has the bundle can drop it.
pub(super) const RETIRED_BROWSER_CONNECTOR: (&str, &str, &[&str]) =
    ("playwright", "npx", &["-y", "@playwright/mcp@latest"]);

/// Built-in connectors installed on first run.
///
/// The browser is NOT among them: `browser_driver` ships the same tools
/// natively, so a `npx @playwright/mcp` connector would spawn a Node sidecar
/// whose whole tool list is then discarded by the native-wins filter — a live
/// process and a startup round-trip per turn for zero usable tools.
pub fn builtin_connectors() -> Vec<(&'static str, Value)> {
    vec![(
        DOCKER_BUNDLE,
        json!({"command": "docker", "args": ["mcp", "gateway", "run"]}),
    )]
}

/// Install the built-in connector bundles that are missing.
///
/// Guarded by the bundle FOLDER, not by the connector name: a user who deleted
/// the seeded bundle does not want it back on the next launch. Returns the names
/// that were seeded.
pub fn seed_builtin_connectors(root: &Path) -> Vec<String> {
    let mut seeded = Vec::new();
    for (name, cfg) in builtin_connectors() {
        if plugin_dir(root, &plugin_slug(name, "")).join(MANIFEST).is_file() {
            continue;
        }
        let mut servers = serde_json::Map::new();
        servers.insert(name.to_string(), cfg);
        if install_bundle(root, name, json!({ "mcp": Value::Object(servers) })).is_ok() {
            seeded.push(name.to_string());
        }
    }
    seeded
}

/// Remove the retired browser connector's bundle from an install that has it.
///
/// Deleted ONLY while the bundle still holds exactly the shipped default and no
/// skills: a connector the user repointed (a pinned version, their own endpoint)
/// is theirs, and a bundle carrying anything else is not a seed to clean up.
/// Returns the names that were retired.
pub fn retire_builtin_connector(root: &Path) -> Vec<String> {
    let (name, command, args) = RETIRED_BROWSER_CONNECTOR;
    let slug = plugin_slug(name, "");
    let mut servers = read_connectors(root, &slug);
    if servers.len() != 1 {
        return Vec::new();
    }
    let Some(cfg) = servers.remove(name) else {
        return Vec::new();
    };
    let untouched = cfg["command"].as_str() == Some(command)
        && cfg["args"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).eq(args.iter().copied()))
            .unwrap_or(false);
    if !untouched || !skill_names(root, &slug).is_empty() {
        return Vec::new();
    }
    if fs::remove_dir_all(plugin_dir(root, &slug)).is_ok() {
        return vec![name.to_string()];
    }
    Vec::new()
}

