use super::*;

pub fn install_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    // `install` routinely gets a NAME instead of an address (`/plugin install
    // eurusd`) when what the user wants is a bundle CREATED. "cannot read a repo
    // from …" reads as a bug there, so say which action does what was asked.
    let spec = body["repo"].as_str().unwrap_or("").trim();
    require_repo_address(spec)?;
    // A marketplace row may name the skill folders it publishes. The source
    // folder can hold a whole catalogue (`source: "./"`), so without this
    // selection a row installs skills it never advertised — and PAYS to read
    // them first. The reader filters before downloading.
    let wanted_skills: Vec<String> = body["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|s| s.trim().trim_start_matches("./").trim_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let repo_spec = body["repo"].as_str().unwrap_or("");
    let repo_path = body["repo_path"].as_str().unwrap_or("");
    let repo_ref = body["repo_ref"].as_str().unwrap_or("");
    let read = if wanted_skills.is_empty() {
        crate::repo::read_plugin(repo_spec, repo_path, repo_ref)?
    } else {
        crate::repo::read_plugin_filtered(repo_spec, repo_path, repo_ref, &wanted_skills)?
    };
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
        // The ARGUMENTS, not only the display string: they are what lets
        // "update from source" re-read this same bundle later.
        "repo": body["repo"].clone(),
        "repo_path": body["repo_path"].clone(),
        "repo_ref": body["repo_ref"].clone(),
        "skills": read["skills"].clone(),
        "scripts": read["scripts"].clone(),
        // The three parts a Claude Code bundle may be made of ENTIRELY. Without
        // them a commands-only bundle (`commands/*.md`, no SKILL.md, no mcp.json)
        // installed as an empty folder — the reported "nothing to install".
        COMMANDS: read[COMMANDS].clone(),
        "agents": read[crate::subagents::AGENTS].clone(),
    });
    // A bundle that declares hooks lands with them DISABLED: writing the file is
    // not approval to run it. The key is deliberately NOT set here — `plugin_view`
    // reports `false` for an absent key — so a REINSTALL cannot flip a switch the
    // user already turned on (the update path keeps the stored approval).
    if read["hooks"].as_array().is_some_and(|a| !a.is_empty()) {
        payload["hooks"] = read["hooks"].clone();
        // The handler SCRIPTS the declarations point at. Without them a bundle
        // installs with hooks.json naming a file that was never written, so the
        // approved hook could only ever fail to start.
        if read["hook_files"].as_array().is_some_and(|a| !a.is_empty()) {
            payload["hook_files"] = read["hook_files"].clone();
        }
    }
    // An empty version must not overwrite the default with "".
    if read["version"].as_str().is_some_and(|v| !v.trim().is_empty()) {
        payload["version"] = read["version"].clone();
    }
    if read["mcp"].as_object().is_some_and(|m| !m.is_empty()) {
        payload["mcp"] = read["mcp"].clone();
    }
    if !wanted_skills.is_empty() {
        payload[SOURCE_SKILLS] = json!(wanted_skills);
    }
    let slug = plugin_ref(&payload);
    let existed = plugin_dir(root, &slug).join(MANIFEST).is_file();
    // Every installed plugin must be findable: the description is the trigger
    // the agent matches a request against. A repo that only ships a SKILL.md
    // gets that skill's description lifted to the plugin; a connector- or
    // command-only bundle gets a line derived from its parts.
    lift_description(root, &slug, existed, &mut payload);
    if payload["description"].as_str().unwrap_or("").trim().is_empty() {
        payload["description"] = json!(derived_description(&payload));
    }
    if payload["description"].as_str().unwrap_or("").trim().is_empty() {
        return Err(format!(
            "the bundle at {} carries no parts Codifa can run (no skill, connector, command, \
             agent, script or hook), so it cannot be installed as a findable plugin. Point \
             `repo_path` at the folder that holds the bundle.",
            read["source"].as_str().unwrap_or(spec)
        ));
    }
    // Writing is the install's LAST leg; the progress bubble shows it so a slow
    // disk write does not read as a hang either. Cleared on success, so a done
    // install does not leave a stale bar behind (an error path leaves the last
    // reading tick — the poller stops the moment its request settles anyway).
    crate::repo::install_progress_set("writing", 0, 0);
    let view = if existed {
        update_plugin(root, &payload)?
    } else {
        create_plugin_relaxed(root, &payload)?
    };
    crate::repo::install_progress_clear();
    Ok(json!({
        "installed": if existed { "updated" } else { "created" },
        "slug": slug,
        "source": read["source"].clone(),
        // The index file the source repo carries, when it is also a catalogue:
        // the UI registers it as a marketplace from this flag instead of
        // probing every install for an index that is almost never there.
        "marketplace": read["marketplace"].clone(),
        // What actually landed, in words: a bundle carrying only commands used to
        // answer with three empty arrays, which reads exactly like a failed
        // install.
        "summary": install_summary(&view),
        "skills": view["skills"].clone(),
        "mcp": view["mcp"].clone(),
        "scripts": view["scripts"].clone(),
        COMMANDS: view[COMMANDS].clone(),
        "agents": view[crate::subagents::AGENTS].clone(),
        "hooks": view["hooks"].clone(),
        "plugin": view,
    }))
}

/// One line naming what an install landed, for the result message.
pub(super) fn install_summary(view: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (key, label) in [
        ("skills", "skill"),
        ("mcp", "connector"),
        (COMMANDS, "command"),
        (crate::subagents::AGENTS, "sub-agent"),
        ("scripts", "script"),
    ] {
        let n = view[key].as_array().map_or(0, Vec::len);
        if n > 0 {
            parts.push(format!("{n} {label}{}", if n == 1 { "" } else { "s" }));
        }
    }
    if parts.is_empty() {
        return "the bundle carries no parts Codifa can run".to_string();
    }
    let mut out = parts.join(", ");
    let hooks = view["hooks"].as_array().map_or(0, Vec::len);
    if hooks > 0 {
        out.push_str(&format!(
            ", {hooks} hook{} (off until enabled)",
            if hooks == 1 { "" } else { "s" }
        ));
    }
    out
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

