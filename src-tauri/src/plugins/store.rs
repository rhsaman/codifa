use super::*;

pub(super) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Carry an install address from a request body into a manifest.
///
/// Only present, non-empty arguments are copied, so a plain create/update keeps
/// whatever address the bundle already records.
pub(super) fn copy_source_args(manifest: &mut Value, body: &Value) {
    for (key, field) in [
        (SOURCE_REPO, "repo"),
        (SOURCE_PATH, "repo_path"),
        (SOURCE_REF, "repo_ref"),
        (SOURCE_CATEGORY, "category"),
    ] {
        if let Some(v) = body[field].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            manifest[key] = json!(v);
        }
    }
    // The row's skill selection is a LIST, not an address string: copy it
    // verbatim so an update from source keeps the same subset.
    if let Some(list) = body[SOURCE_SKILLS].as_array().filter(|a| !a.is_empty()) {
        manifest[SOURCE_SKILLS] = json!(list);
    }
}

pub(super) fn plugins_dir(root: &Path) -> PathBuf {
    root.join("plugins")
}

/// Public wrapper: one bundle's folder, so the agent loop can pin the folder an
/// update should keep working in.
pub fn plugin_dir_pub(root: &Path, plugin: &str) -> PathBuf {
    plugin_dir(root, plugin)
}

pub(super) fn plugin_dir(root: &Path, slug: &str) -> PathBuf {
    plugins_dir(root).join(crate::skills::safe_file(slug, "plugin"))
}

/// Folder slug for a plugin: the explicit `slug` when given, else the name.
pub(super) fn plugin_slug(name: &str, given: &str) -> String {
    let raw = if given.trim().is_empty() { name } else { given };
    crate::skills::safe_file(&raw.trim().to_lowercase(), "plugin")
}

pub fn plugin_ref(body: &Value) -> String {
    plugin_slug(
        body["name"].as_str().unwrap_or(""),
        body["slug"].as_str().unwrap_or(""),
    )
}

pub(super) fn read_manifest(root: &Path, slug: &str) -> Option<Value> {
    let raw = fs::read_to_string(plugin_dir(root, slug).join(MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(super) fn write_manifest(root: &Path, slug: &str, manifest: &Value) -> Result<(), String> {
    let dir = plugin_dir(root, slug);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join(MANIFEST), raw).map_err(|e| e.to_string())
}

pub(super) fn read_connectors(root: &Path, slug: &str) -> serde_json::Map<String, Value> {
    fs::read_to_string(plugin_dir(root, slug).join(CONNECTORS))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub(super) fn write_connectors(dir: &Path, servers: &serde_json::Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(CONNECTORS), Value::Object(servers.clone()).to_string())
        .map_err(|e| e.to_string())
}

/// Skill names a plugin currently holds (recomputed from disk, never stored).
pub(super) fn skill_names(root: &Path, slug: &str) -> Vec<String> {
    crate::skills::list_skills(&plugin_dir(root, slug))["skills"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn connector_names(root: &Path, slug: &str) -> Vec<String> {
    read_connectors(root, slug).keys().cloned().collect()
}

/// Every connector name that lives in SOME bundle, enabled or not.
///
/// The boot cleanup asks this before deleting a leftover `mcp/*.json`: a name
/// that already crossed over is a dead copy, anything else is still the only
/// copy the user has.
pub fn all_connector_names(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (slug, _) in all_plugins(root) {
        for name in connector_names(root, &slug) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

/// Folder holding one plugin's runnable scripts.
pub(super) fn scripts_dir(root: &Path, slug: &str) -> PathBuf {
    plugin_dir(root, slug).join(SCRIPTS)
}

/// Folder of ONE script: the manifest plus its source file.
pub(super) fn script_dir(root: &Path, slug: &str, name: &str) -> PathBuf {
    scripts_dir(root, slug).join(crate::skills::safe_file(&name.to_lowercase(), "script"))
}

/// The source file name a language is written to.
pub(super) fn script_file(language: &str) -> &'static str {
    script_source_file(language)
}

/// The source file a language is written to.
///
/// Public so `repo.rs` can find the file a bundle's script manifest names
/// without guessing at the extension.
pub(crate) fn script_source_file(language: &str) -> &'static str {
    match language {
        "python" => "main.py",
        "node" => "main.js",
        "bash" => "main.sh",
        _ => "main.rs",
    }
}

/// Canonical language name for a script.
///
/// Rust is the default because it is this project's own language; anything else
/// has to be asked for explicitly and must be one of [`SCRIPT_LANGUAGES`], so a
/// typo cannot produce a script nothing knows how to run.
pub(super) fn script_language(raw: &str) -> Result<String, String> {
    let lang = raw.trim().to_ascii_lowercase();
    if lang.is_empty() {
        return Ok(DEFAULT_SCRIPT_LANGUAGE.to_string());
    }
    let lang = match lang.as_str() {
        "py" | "python3" => "python".to_string(),
        "js" | "javascript" | "nodejs" => "node".to_string(),
        "sh" | "shell" | "zsh" => "bash".to_string(),
        "rs" => "rust".to_string(),
        other => other.to_string(),
    };
    if !SCRIPT_LANGUAGES.contains(&lang.as_str()) {
        return Err(format!(
            "unsupported script language {lang:?} — use one of {} (Rust is the default)",
            SCRIPT_LANGUAGES.join(", ")
        ));
    }
    Ok(lang)
}

/// Names of the scripts a plugin currently holds (recomputed from disk).
pub(super) fn script_names(root: &Path, slug: &str) -> Vec<String> {
    list_scripts(root, slug)
        .iter()
        .filter_map(|row| row["name"].as_str().map(str::to_string))
        .collect()
}

// ---------------------------------------------------------------------------
// commands and sub-agents
// ---------------------------------------------------------------------------

/// Folder holding one plugin's slash commands.
pub(super) fn commands_dir(root: &Path, slug: &str) -> PathBuf {
    plugin_dir(root, slug).join(COMMANDS)
}

/// Folder holding one plugin's sub-agent profiles.
pub(super) fn agents_dir(root: &Path, slug: &str) -> PathBuf {
    plugin_dir(root, slug).join(crate::subagents::AGENTS)
}

/// Every slash command a plugin ships, sorted by name.
///
/// The file STEM is the command name — it is what the user types after `/`, so
/// the frontmatter `name` is a display label only and a command listed under it
/// would be one nobody can invoke. Read from disk on each call, like every other
/// part of a bundle: the folder stays the only source of truth.
pub fn list_commands(root: &Path, slug: &str) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(commands_dir(root, slug)) else {
        return Vec::new();
    };
    let mut rows: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let (_, _, description) = crate::skills::parse_frontmatter_pub(&raw);
        rows.push(json!({
            "name": stem,
            "description": if description.trim().is_empty() {
                format!("Run the /{stem} command")
            } else {
                description
            },
            // The body WITHOUT its frontmatter: this text becomes the prompt, so
            // a `---` block left in would be read as instructions.
            "content": crate::skills::strip_frontmatter_pub(&raw),
        }));
    }
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    rows
}

/// Command names only — what the manifest/view lists.
pub(super) fn command_names(root: &Path, slug: &str) -> Vec<String> {
    list_commands(root, slug)
        .iter()
        .filter_map(|row| row["name"].as_str().map(str::to_string))
        .collect()
}

/// The sub-agent profiles a plugin ships (the parsing lives in `subagents`).
pub fn list_agents(root: &Path, slug: &str) -> Vec<Value> {
    crate::subagents::read_agents(&plugin_dir(root, slug))
}

/// Sub-agent names only — what the manifest/view lists.
pub(super) fn agent_names(root: &Path, slug: &str) -> Vec<String> {
    list_agents(root, slug)
        .iter()
        .filter_map(|row| row["name"].as_str().map(str::to_string))
        .collect()
}

/// Slash commands of every ENABLED bundle, with their bodies, for the turn.
///
/// A disabled bundle contributes nothing: its switch is the on/off control, so a
/// `/name` it ships must stop resolving the moment it is switched off.
pub fn enabled_plugin_commands(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        if !manifest["enabled"].as_bool().unwrap_or(true) {
            continue;
        }
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        for mut row in list_commands(root, &slug) {
            row["plugin"] = json!(label);
            row["plugin_slug"] = json!(slug);
            out.push(row);
        }
    }
    out
}

/// Sub-agent profiles of every ENABLED bundle, tagged with their owner.
pub fn enabled_plugin_agents(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        if !manifest["enabled"].as_bool().unwrap_or(true) {
            continue;
        }
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        for mut row in list_agents(root, &slug) {
            row["plugin"] = json!(label);
            row["plugin_slug"] = json!(slug);
            out.push(row);
        }
    }
    out
}

/// Every handler the agent may run this turn: the ENABLED bundles' hooks.
///
/// The bundle's own switch IS the approval — turning a bundle on runs its
/// hooks, turning it off stops them. The pair list is what `hooks::active_in`
/// consumes.
pub fn active_hook_bundles(root: &Path) -> Vec<(PathBuf, bool)> {
    all_plugins(root)
        .into_iter()
        .filter(|(_, m)| m["enabled"].as_bool().unwrap_or(true))
        .map(|(slug, _)| (plugin_dir(root, &slug), true))
        .collect()
}

/// One ENABLED bundle's sub-agent profile by name.
///
/// The name is the delegation TOOL name the model was shown, so the lookup is
/// case-insensitive and reads disk: a profile edited between two turns resolves
/// to what is actually there now.
pub fn find_plugin_agent(root: &Path, name: &str) -> Option<Value> {
    let want = name.trim();
    if want.is_empty() {
        return None;
    }
    for (slug, manifest) in all_plugins(root) {
        if !manifest["enabled"].as_bool().unwrap_or(true) {
            continue;
        }
        if let Some(mut row) = crate::subagents::find_agent(&plugin_dir(root, &slug), want) {
            row["plugin"] = json!(manifest["name"].as_str().unwrap_or(&slug));
            row["plugin_slug"] = json!(slug);
            return Some(row);
        }
    }
    None
}

/// Every command of every plugin, enabled or not, tagged with its owning bundle.
pub fn all_plugin_commands(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        for mut row in list_commands(root, &slug) {
            row["plugin"] = json!(label);
            row["plugin_slug"] = json!(slug);
            row["plugin_enabled"] = json!(enabled);
            out.push(row);
        }
    }
    out
}

/// Every sub-agent of every plugin, enabled or not, tagged with its bundle.
pub fn all_plugin_agents(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        for mut row in list_agents(root, &slug) {
            row["plugin"] = json!(label);
            row["plugin_slug"] = json!(slug);
            row["plugin_enabled"] = json!(enabled);
            out.push(row);
        }
    }
    out
}

/// Every script of a plugin WITH its own metadata, sorted by name.
///
/// Read out of each script's manifest — the folder stays the only source of
/// truth — so Settings can show (and edit) a script's description without
/// opening its source.
pub fn list_scripts(root: &Path, slug: &str) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(scripts_dir(root, slug)) else {
        return Vec::new();
    };
    let mut rows: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(entry.path().join(SCRIPT_MANIFEST)) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(name) = meta["name"].as_str().map(str::to_string) else {
            continue;
        };
        let language = meta["language"]
            .as_str()
            .unwrap_or(DEFAULT_SCRIPT_LANGUAGE)
            .to_string();
        let source = script_source_file(&language);
        rows.push(json!({
            "name": name,
            "language": language,
            "description": meta["description"].as_str().unwrap_or(""),
            // The file the script's code lives in, so the page can name it.
            "file": source,
        }));
    }
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    rows
}

/// One script's manifest, resolved by the name the user gave.
pub(super) fn read_script(root: &Path, slug: &str, name: &str) -> Option<Value> {
    let raw = fs::read_to_string(script_dir(root, slug, name).join(SCRIPT_MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The source text a script already has on disk, so an edit that only changes
/// its description leaves the body alone.
pub(super) fn read_script_source(root: &Path, slug: &str, name: &str, meta: &Value) -> Option<String> {
    let language = meta["language"].as_str().unwrap_or(DEFAULT_SCRIPT_LANGUAGE);
    fs::read_to_string(script_dir(root, slug, name).join(script_source_file(language))).ok()
}

/// Absolute `$HOME` paths a bundle's scripts hard-code OUTSIDE their own folder.
///
/// A bundle is a self-contained folder: it must reach its config, history and
/// state through paths relative to itself (the runner starts a script with the
/// bundle as its working directory). A literal like
/// `/Users/<someone>/.codifa/plugins/<slug>/...` stops being true as soon as the
/// bundle is installed anywhere else, and anything else under `$HOME` is outside
/// every root a scheduled run may touch without asking — which is exactly how a
/// scheduled run reached a permission gate with nobody to answer it and stalled
/// forever. Reported at WRITE time so the bug never ships.
pub fn script_outside_paths(root: &Path, slug: &str) -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let home = home.to_string_lossy().to_string();
    let own = plugin_dir(root, slug).to_string_lossy().to_string();
    let mut hits: Vec<String> = Vec::new();
    for row in list_scripts(root, slug) {
        let Some(name) = row["name"].as_str() else {
            continue;
        };
        let Some(meta) = read_script(root, slug, name) else {
            continue;
        };
        let Some(source) = read_script_source(root, slug, name, &meta) else {
            continue;
        };
        for literal in quoted_absolutes(&source) {
            // Only the home tree is interesting: `/tmp`, `/usr`, `/opt` and the
            // like are legitimate tool paths, not a misplaced bundle file.
            if !literal.starts_with(&home) || literal.starts_with(&own) {
                continue;
            }
            if !hits.iter().any(|h| h == &literal) {
                hits.push(literal);
            }
        }
    }
    hits
}

/// Absolute-path string literals in a source file (`"..."` and `'...'`).
///
/// Deliberately lexical: there is no parser per language here, and every one of
/// them spells a string the same way. A `~` form is expanded first, because
/// `"~/.x"` is the same mistake as `"/Users/me/.x"`.
pub(super) fn quoted_absolutes(source: &str) -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default().to_string_lossy().to_string();
    let mut out: Vec<String> = Vec::new();
    for (i, quote) in source.char_indices().filter(|(_, c)| *c == '"' || *c == '\'') {
        let rest = &source[i + 1..];
        let Some(len) = rest.find(quote) else { continue };
        let mut lit = rest[..len].trim().to_string();
        if lit.starts_with("~/") {
            lit = format!("{}{}", home, &lit[1..]);
        }
        if lit.starts_with('/') && !out.iter().any(|o| o == &lit) {
            out.push(lit);
        }
    }
    out
}

