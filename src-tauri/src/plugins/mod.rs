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
pub const MANIFEST: &str = "plugin.json";
/// Name + folder of the ONE bundle every shipped built-in skill lives in.
///
/// The seeder used to give each shipped skill a bundle of its own, so Settings
/// showed 25 cards reading "1 skill" for what is really one library. A shipped
/// skill is not a subscription the user chose — it ships with the app — so the
/// library is a single container behind a single switch.
pub const BUILTIN_BUNDLE_NAME: &str = "builtin plugin";
pub const BUILTIN_BUNDLE_SLUG: &str = "builtin-plugin";
/// The catalog line for the built-in library.
///
/// The library is ONE bundle of ~24 shipped skills, and the catalog shows only
/// the first few skill names plus "+N more" — so this line is the ONLY trigger
/// the agent sees for everything hidden behind that count. Lifting one skill's
/// description (what the old refresh did) advertised the whole library as
/// "UI/UX design intelligence" and made the live-test harness, browser
/// automation, writing and research skills invisible: a live-test request had
/// nothing in the catalog to match. Keep the major capabilities, most
/// actionable first; the catalog clips the tail, not the head.
pub const BUILTIN_BUNDLE_DESCRIPTION: &str = "Built-in library: live-test and debug Codifa's UI in a browser harness, drive the browser, design/review frontends, plus research, writing, planning, git, data and translation.";
/// The seeded Docker connector bundle. The bundle and the connector key share
/// one name, so `mcp__docker-mcp__*` tool names match the Settings row.
pub const DOCKER_BUNDLE: &str = "docker-mcp";
/// Connector file inside one plugin folder.
const CONNECTORS: &str = "mcp.json";
/// Default version written for a plugin created without one.
const DEFAULT_VERSION: &str = "1.0.0";
/// Manifest key recording where an installed bundle came from.
const SOURCE: &str = "source";
/// The install ARGUMENTS, not just a display string.
///
/// `source` is a human string like `owner/repo/path@ref`, which cannot be fed
/// back to `install_plugin`. These three can, so "update from source" re-reads
/// the exact bundle it came from instead of guessing at a repo root.
const SOURCE_REPO: &str = "source_repo";
const SOURCE_PATH: &str = "source_path";
/// The marketplace index's topic tag, stored with the same pattern as the
/// source address (an UPDATE call carries only the address).
const SOURCE_CATEGORY: &str = "source_category";
const SOURCE_REF: &str = "source_ref";
/// The skill folders a marketplace ROW publishes, when it names them. Kept with
/// the address so "update from source" re-reads the same selection instead of
/// pulling in every skill the source folder happens to hold.
const SOURCE_SKILLS: &str = "source_skills";
/// Manifest key holding per-connector metadata: `{name: {description}}`.
///
/// Deliberately NOT stored inside the connector's own config: `mcp.json` values
/// are forwarded to the MCP server verbatim, so anything extra in there would
/// ride into the protocol payload.
const MCP_META: &str = "connector_meta";
/// Folder inside a plugin holding its runnable scripts.
pub(crate) const SCRIPTS: &str = "scripts";
/// Folder inside a plugin holding its slash commands (`commands/<name>.md`).
///
/// Deliberately NOT the skill store: a command is typed as `/name`, never
/// attached with `@`, and keeping it in its own folder means the skills catalog
/// and the `@` picker cannot accidentally list it.
pub(crate) const COMMANDS: &str = "commands";
/// Cap on the commands one bundle may ship.
pub(crate) const MAX_COMMANDS: usize = 64;
/// Manifest inside one script folder: name, slug, language, description.
pub(crate) const SCRIPT_MANIFEST: &str = "script.json";
/// Language a script is written in when the call does not name one.
///
/// Scripts are Rust by default — that is the house language here — and a call
/// that wants something else says so with `language`.
pub const DEFAULT_SCRIPT_LANGUAGE: &str = "rust";
/// The languages a plugin script may be written in.
pub const SCRIPT_LANGUAGES: [&str; 4] = ["rust", "python", "node", "bash"];
/// Cap on the scripts one bundle may hold.
pub(crate) const MAX_SCRIPTS: usize = 20;
/// A plugin script has NO time budget: not a default, not a cap. The wait is
/// whatever the script needs, and only the caller's own `timeout` (when it
/// names one) can bound it.
///
/// Why: a paid script (article + image) was killed at 60 s, then at 600 s, then
/// at an hour — every kill landed AFTER the money was spent, and the retry paid
/// again. A ceiling smaller than the work it bounds is not a guard, it is a
/// billing bug.
///
/// A `rustc` BUILD is the compiler, not the script, so it keeps its own bound.
const SCRIPT_BUILD_TIMEOUT_SECS: u64 = 180;

/// Enabled plugin folders, sorted by slug.
pub fn enabled_plugins(root: &Path) -> Vec<(String, Value)> {
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

/// Whether one bundle's own switch is on.
///
/// The script runner asks this: a switched-off bundle must contribute nothing,
/// and that includes its scripts — they are code the bundle owns, so letting
/// them run while the switch is off would make the switch a lie. An unknown
/// slug (or a folder with no manifest) is OFF, matching `enabled_plugins`,
/// which skips both.
fn plugin_enabled(root: &Path, slug: &str) -> bool {
    read_manifest(root, slug)
        .map(|m| m["enabled"].as_bool().unwrap_or(true))
        .unwrap_or(false)
}

/// One plugin's manifest (`plugin.json`), or an empty object when the slug
/// names no plugin — for callers that only want its display name and must not
/// fail on a half-installed bundle.
pub fn manifest_of(root: &Path, slug: &str) -> Value {
    read_manifest(root, slug).unwrap_or(Value::Object(serde_json::Map::new()))
}

/// Skill rows of every ENABLED plugin, in the `skills::list_skills` shape plus a
/// `plugin` tag. A disabled plugin contributes nothing, which is how switching
/// one off removes its skills from the prompt catalog.
pub fn enabled_plugin_skills(root: &Path) -> Vec<Value> {
    plugin_skills(root, false)
}

/// The same rows for EVERY plugin, enabled or not.
///
/// Settings has to show a bundle's skills while it is switched off — that is
/// exactly when a user goes looking for what it contains. Each row carries
/// `plugin_enabled` and `plugin_slug` so the panel never has to guess which
/// plugin a skill came from by matching display names.
pub fn all_plugin_skills(root: &Path) -> Vec<Value> {
    plugin_skills(root, true)
}

/// Every script of every plugin, enabled or not, tagged with its owning bundle.
///
/// The same shape `all_plugin_skills` uses, so Settings lists all three parts of
/// a bundle the same way instead of special-casing scripts.
pub fn all_plugin_scripts(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        for mut row in list_scripts(root, &slug) {
            row["plugin"] = json!(label);
            row["plugin_slug"] = json!(slug);
            row["plugin_enabled"] = json!(enabled);
            out.push(row);
        }
    }
    out
}

/// Every connector of every plugin, enabled or not, tagged with its owning
/// bundle — plus the description kept for it in the bundle manifest (never
/// inside `cfg`, which the MCP client forwards as-is).
pub fn all_plugin_connectors(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        let meta = connector_meta_map(root, &slug);
        for (name, cfg) in read_connectors(root, &slug) {
            let own = meta.get(&name).cloned().unwrap_or_else(|| json!({}));
            out.push(json!({
                "name": name,
                "cfg": cfg,
                // Owning bundle's absolute folder — what a `/plugin update`
                // session pins the composer badge to.
                "dir": plugin_dir(root, &slug).to_string_lossy(),
                "description": own["description"].as_str().unwrap_or(""),
                "plugin": label,
                "plugin_slug": slug,
                "plugin_enabled": enabled,
            }));
        }
    }
    out
}

/// Skill NAMES carried by the NAMED plugins, skipping disabled ones — the
/// scheduled-run counterpart of `mcp_of`. Naming a plugin in a task means
/// "everything inside it", so its skills are attached outright, the way the
/// input path (`resolvePluginTurn`) already does, instead of waiting for the
/// model to discover them in the catalog. Slugs that are switched off or no
/// longer exist contribute nothing, exactly like connectors.
pub fn bundle_skill_names(root: &Path, slugs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (slug, _) in enabled_plugins(root) {
        if !slugs.iter().any(|s| s == &slug) {
            continue;
        }
        let listed = crate::skills::list_skills(&plugin_dir(root, &slug));
        for row in listed["skills"].as_array().cloned().unwrap_or_default() {
            if let Some(name) = row["name"].as_str() {
                if !name.trim().is_empty() && !out.iter().any(|s| s == name) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out
}

fn plugin_skills(root: &Path, include_disabled: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        if !include_disabled && !enabled {
            continue;
        }
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let description = manifest["description"].as_str().unwrap_or_default().to_string();
        let listed = crate::skills::list_skills(&plugin_dir(root, &slug));
        for mut row in listed["skills"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
        {
            row["plugin"] = json!(label);
            // The bundle's own description rides along (read-only data, like
            // the label): the catalog's bundle rungs describe a group with the
            // bundle's own line instead of inventing one from its skills.
            row["plugin_description"] = json!(description);
            row["plugin_slug"] = json!(slug);
            row["plugin_enabled"] = json!(enabled);
            out.push(row);
        }
    }
    out
}

/// Per-connector metadata a bundle carries: `{name: {description}}`.
pub(crate) fn connector_meta_map(root: &Path, slug: &str) -> serde_json::Map<String, Value> {
    read_manifest(root, slug)
        .and_then(|m| m[MCP_META].as_object().cloned())
        .unwrap_or_default()
}

/// Store (or clear) one connector's metadata inside the bundle manifest.
///
/// An entry carrying no description is REMOVED rather than written empty, so
/// clearing the field leaves no trace behind.
fn write_connector_meta(root: &Path, slug: &str, name: &str, entry: &Value) -> Result<(), String> {
    let Some(mut manifest) = read_manifest(root, slug) else {
        return Err(format!("plugin not found: {slug}"));
    };
    let mut all = connector_meta_map(root, slug);
    let blank = entry["description"]
        .as_str()
        .map_or(true, |d| d.trim().is_empty());
    if blank {
        all.remove(name);
    } else {
        all.insert(name.to_string(), entry.clone());
    }
    if all.is_empty() {
        if let Some(map) = manifest.as_object_mut() {
            map.remove(MCP_META);
        }
    } else {
        manifest[MCP_META] = Value::Object(all);
    }
    manifest["updated_at"] = json!(now_secs());
    write_manifest(root, slug, &manifest)
}

/// Upsert one connector in a plugin's `mcp.json` (rename removes the old key).
pub fn save_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    if read_manifest(root, &slug).is_none() {
        return Err(format!("plugin not found: {slug}"));
    }
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let previous = body["previous_name"].as_str().unwrap_or("").trim();
    let cfg = body.get("cfg").cloned().unwrap_or_else(|| json!({}));
    if !cfg.is_object() {
        return Err("connector config must be an object".into());
    }
    let mut servers = read_connectors(root, &slug);
    if !previous.is_empty() && previous != name {
        servers.remove(previous);
    }
    servers.insert(name.to_string(), cfg);
    write_connectors(&plugin_dir(root, &slug), &servers)?;
    Ok(json!({ "ok": true, "slug": slug, "name": name, "mcp": connector_names(root, &slug) }))
}

/// Remove one connector from a plugin's `mcp.json`.
pub fn delete_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    if read_manifest(root, &slug).is_none() {
        return Err(format!("plugin not found: {slug}"));
    }
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let mut servers = read_connectors(root, &slug);
    servers.remove(name);
    write_connectors(&plugin_dir(root, &slug), &servers)?;
    // Its metadata goes with it: a later connector reusing the name must not
    // inherit a description the user wrote for a different server.
    write_connector_meta(root, &slug, name, &json!({}))?;
    Ok(json!({ "ok": true, "slug": slug, "name": name, "mcp": connector_names(root, &slug) }))
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
/// the standalone `<root>/skills` store: without this, `load_plugin` (and the
/// `/skills/file` route) answered "skill not found" for every skill the prompt
/// catalog had just advertised. Disabled plugins are skipped, so switching a
/// plugin off stays a real off switch.
pub fn plugin_of_skill(root: &Path, name_or_slug: &str) -> Option<String> {
    plugin_of_skill_in(root, name_or_slug, false)
}

/// The same lookup over EVERY bundle, enabled or not.
///
/// The two WRITERS need this: editing or deleting a skill that lives in a bundle
/// the user switched off must land in THAT bundle, not build a second one —
/// editing while off is exactly what someone opens Settings for.
pub fn plugin_of_skill_any(root: &Path, name_or_slug: &str) -> Option<String> {
    plugin_of_skill_in(root, name_or_slug, true)
}

fn plugin_of_skill_in(root: &Path, name_or_slug: &str, include_disabled: bool) -> Option<String> {
    let query = name_or_slug.trim();
    if query.is_empty() {
        return None;
    }
    let bundles = if include_disabled {
        all_plugins(root)
    } else {
        enabled_plugins(root)
    };
    for (slug, _) in bundles {
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

    #[test]
    fn script_timeout_uses_the_calls_own_value_and_has_no_default_cap() {
        // No timeout named: NO deadline — the script runs to completion.
        assert_eq!(script_timeout(&json!({})), 0);
        assert_eq!(script_timeout(&json!({"timeout": 0})), 0);
        // A named value is used as given, however large.
        assert_eq!(script_timeout(&json!({"timeout": 540})), 540);
        assert_eq!(script_timeout(&json!({"timeout": 5400})), 5400);
    }

    fn temp_root(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-plugin-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    /// A bundle made ONLY of commands and a sub-agent — the shape the reporter's
    /// `claude-model-advisor` has, and the one that used to fail with "nothing to
    /// install": no SKILL.md, no mcp.json, no scripts/.
    /// The schema advertises a profile as `agent__<slug>` (whitespace folded to
    /// `_`). Dispatch strips the prefix and looks the profile up by that same
    /// slug — a pack with a human-readable frontmatter name must resolve, or it
    /// silently runs the builtin explore prompt instead of its own.
    #[test]
    fn a_spaced_agent_name_resolves_from_its_delegation_slug() {
        let root = temp_root("spaced-agent");
        create_plugin(
            &root,
            &json!({
                "name": "Reviewer Pack",
                "description": "test plugin: Reviewer Pack",
                "slug": "reviewer-pack",
                "agents": [{
                    "name": "Code Reviewer",
                    "description": "Reviews a diff",
                    "tools": ["Read", "WebSearch"],
                    "prompt": "You review diffs."
                }]
            }),
        )
        .expect("a pack with a spaced agent name must install");

        let row = find_plugin_agent(&root, "code_reviewer")
            .expect("the advertised slug must resolve the profile");
        assert_eq!(row["name"], "Code Reviewer");
        // A slug the model could not have called still resolves nothing.
        assert!(find_plugin_agent(&root, "code_reviewer_two").is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bundle_of_commands_and_agents_is_a_real_install() {
        let root = temp_root("commands-only");
        let created = create_plugin(
            &root,
            &json!({
                "name": "Advisor",
                "description": "test plugin: Advisor",
                "slug": "advisor",
                "commands": [{
                    "name": "model-check",
                    "description": "Check the model routing",
                    "content": "Check $1 with $ARGUMENTS"
                }],
                "agents": [{
                    "name": "judge",
                    "description": "Reviews a diff",
                    "tools": ["read"],
                    "prompt": "You review diffs."
                }]
            }),
        )
        .expect("a command/agent-only bundle must install");

        // The parts are ON DISK, not just in the manifest.
        let dir = plugin_dir(&root, "advisor");
        assert!(dir.join(COMMANDS).join("model-check.md").is_file());
        assert!(dir.join(crate::subagents::AGENTS).join("judge.md").is_file());
        assert_eq!(created["commands"], json!(["model-check"]));
        assert_eq!(created[crate::subagents::AGENTS], json!(["judge"]));

        // ...and the agent-facing readers find them.
        let cmds = enabled_plugin_commands(&root);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0]["name"], "model-check");
        assert!(cmds[0]["content"]
            .as_str()
            .unwrap()
            .contains("$ARGUMENTS"));
        let agents = enabled_plugin_agents(&root);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["tools"], json!(["read"]));
        assert!(find_plugin_agent(&root, "judge").is_some());

        // Switching the bundle OFF takes both away: the switch is the control.
        toggle_plugin(&root, &json!({"slug": "advisor", "enabled": false})).unwrap();
        assert!(enabled_plugin_commands(&root).is_empty());
        assert!(enabled_plugin_agents(&root).is_empty());
        assert!(find_plugin_agent(&root, "judge").is_none());
        // Settings still lists them (it must show what a switched-off bundle has).
        assert_eq!(all_plugin_commands(&root).len(), 1);
        assert_eq!(all_plugin_agents(&root).len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    /// An install carries hooks as the FLAT row list the repo reader produces
    /// (`[{event, matcher, command}]`), not the nested document a hand-written
    /// `hooks.json` has. Reading only the object dropped every installed hook —
    /// and the handler SCRIPT a declaration points at has to travel too, since a
    /// real bundle keeps it in `hooks-handlers/` and spells it
    /// `${CLAUDE_PLUGIN_ROOT}/…`.
    #[test]
    fn an_install_carries_hook_rows_and_their_handler_files() {
        // A bundle on disk with the layout `Jaace/claude-model-advisor` ships.
        let source = temp_root("hook-source");
        let bundle = source.join("bundle");
        fs::create_dir_all(bundle.join("hooks")).unwrap();
        fs::create_dir_all(bundle.join("hooks-handlers")).unwrap();
        fs::create_dir_all(bundle.join("commands")).unwrap();
        fs::create_dir_all(bundle.join("agents")).unwrap();
        fs::write(
            bundle.join(MANIFEST),
            json!({"name": "Advisor", "version": "1.0.1"}).to_string(),
        )
        .unwrap();
        fs::write(
            bundle.join(COMMANDS).join("model-check.md"),
            "Reassess the session.\n",
        )
        .unwrap();
        // A sub-agent ships alongside the command: all three parts travel in
        // ONE install, so the reply must report each of them.
        fs::write(
            bundle.join("agents").join("judge.md"),
            "---\nname: judge\ndescription: Reviews a diff\ntools: read\n---\nYou review diffs.\n",
        )
        .unwrap();
        fs::write(
            bundle.join("hooks/hooks.json"),
            json!({"hooks": {"SessionStart": [{"hooks": [{
                "type": "command",
                "command": "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/start.sh",
            }]}]}})
            .to_string(),
        )
        .unwrap();
        fs::write(
            bundle.join("hooks-handlers/start.sh"),
            "#!/bin/sh\necho ready\n",
        )
        .unwrap();

        let root = temp_root("hook-store");
        let out = install_plugin(
            &root,
            &json!({"repo": bundle.to_string_lossy()}),
        )
        .expect("a commands+hooks bundle must install");

        // The declaration landed as a declared hook, runnable while enabled.
        assert_eq!(out["hooks"].as_array().map(Vec::len), Some(1));
        assert_eq!(out["hooks"][0]["event"], "SessionStart");
        assert!(out["summary"].as_str().unwrap().contains("1 hook"));
        // The command and the sub-agent landed too — not just the hook.
        assert_eq!(out[COMMANDS], json!(["model-check"]));
        assert_eq!(out[crate::subagents::AGENTS], json!(["judge"]), "the agent must travel with the install");
        assert!(plugin_dir(&root, "advisor")
            .join(crate::subagents::AGENTS)
            .join("judge.md")
            .is_file());
        // ...and so did the script it points at, EXECUTABLE: a handler that
        // cannot start is the one failure a hook must not have.
        let handler = plugin_dir(&root, "advisor").join("hooks-handlers/start.sh");
        assert!(handler.is_file(), "the handler script must be written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&handler).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "the handler must be executable");
        }

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&source);
    }

    #[test]
    fn hooks_run_while_the_bundle_is_enabled() {
        let root = temp_root("hooks-off");
        let view = create_plugin(
            &root,
            &json!({
                "name": "Guarded",
                "description": "test plugin: Guarded",
                "slug": "guarded",
                "hooks": {"PreToolUse": [{
                    "matcher": "write",
                    "hooks": [{"command": "./guard.sh"}]
                }]}
            }),
        )
        .expect("create");
        // Declared, listed, and runnable: the bundle's switch IS the approval.
        assert_eq!(view["hooks"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            active_hook_bundles(&root)
                .iter()
                .filter(|(dir, approved)| *approved && dir.ends_with("guarded"))
                .count(),
            1
        );

        // Turning the bundle off is what stops the handlers.
        toggle_plugin(&root, &json!({"slug": "guarded", "enabled": false})).unwrap();
        assert!(active_hook_bundles(&root)
            .iter()
            .all(|(dir, _)| !dir.ends_with("guarded")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bundle_script_that_hard_codes_a_home_path_is_reported() {
        // The reported bug: a script kept its dedup memory in
        // `$HOME/.healer_generated_topics.json`. That is outside every root a
        // scheduled run may touch, so the run hit a permission gate nobody could
        // answer and stalled forever. The bundle must resolve its own files
        // relative to itself, and the write path must SAY when it does not.
        let root = temp_root("script-detached");
        fs::create_dir_all(root.join("plugins/mylib/scripts/keep")).unwrap();
        fs::write(
            root.join("plugins/mylib/plugin.json"),
            json!({"name": "mylib"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("plugins/mylib/scripts/keep/script.json"),
            json!({"name": "keep", "language": "rust"}).to_string(),
        )
        .unwrap();
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        let stray = format!("{home}/.mylib_state.json");
        fs::write(
            root.join("plugins/mylib/scripts/keep/main.rs"),
            format!("fn main() {{ let p = \"{stray}\"; let _ = p; }}"),
        )
        .unwrap();

        assert_eq!(script_outside_paths(&root, "mylib"), vec![stray]);

        // A path INSIDE the bundle is exactly what the rule asks for.
        fs::write(
            root.join("plugins/mylib/scripts/keep/main.rs"),
            "fn main() { let p = \"state.json\"; let _ = p; }",
        )
        .unwrap();
        assert!(script_outside_paths(&root, "mylib").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_script_runs_with_env_and_args_instead_of_exit_127() {
        // The reported bug: env pairs, PATH and the program path were glued
        // into ONE shell word, so any bundle with a .env made `sh` see a
        // single never-found command and the args became its arguments —
        // every run died with exit 127 "command not found".
        let root = temp_root("script-env");
        fs::create_dir_all(root.join("plugins/mylib/scripts/echo")).unwrap();
        fs::write(
            root.join("plugins/mylib/plugin.json"),
            json!({"name": "mylib"}).to_string(),
        )
        .unwrap();
        fs::write(root.join("plugins/mylib/.env"), "GREETING=hello plugin").unwrap();
        fs::write(
            root.join("plugins/mylib/scripts/echo/script.json"),
            json!({"name": "echo", "language": "bash"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("plugins/mylib/scripts/echo/main.sh"),
            "printf '%s|%s' \"$GREETING\" \"$1\"",
        )
        .unwrap();

        let out = run_plugin_script(
            &root,
            &json!({"slug": "mylib", "name": "echo", "args": ["world"]}),
        )
        .expect("the script must run once env/PATH/program are separate words");
        assert_eq!(out["output"], json!("hello plugin|world"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn enabled_connectors_come_from_every_enabled_plugin() {
        let root = temp_root("connectors");
        create_plugin(
            &root,
            &json!({
                "name": "Notes",
                "description": "test plugin: Notes",
                "skills": [{"name": "Notes", "content": "x"}],
                "mcp": {"notes": {"command": "npx"}}
            }),
        )
        .unwrap();
        create_plugin(
            &root,
            &json!({
                "name": "Search",
                "description": "test plugin: Search",
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
    fn bundle_skill_names_of_named_plugins() {
        // Naming a plugin in a scheduled task means "everything inside it": its
        // skills are attached outright, the one-unit deal its connectors have.
        let root = temp_root("bundle-skill-names");
        create_plugin(
            &root,
            &json!({
                "name": "Notes",
                "description": "test plugin: Notes",
                "skills": [{"name": "Notes", "content": "x"}]
            }),
        )
        .unwrap();
        create_plugin(
            &root,
            &json!({
                "name": "Search",
                "description": "test plugin: Search",
                "skills": [{"name": "Search", "content": "y"}]
            }),
        )
        .unwrap();

        let wanted = vec!["notes".to_string()];
        assert_eq!(bundle_skill_names(&root, &wanted), vec!["Notes".to_string()]);
        // An unknown slug contributes nothing instead of failing the run.
        let ghost = vec!["ghost".to_string()];
        assert!(bundle_skill_names(&root, &ghost).is_empty());
        // A switched-off bundle is the off switch, same as its connectors.
        toggle_plugin(&root, &json!({"slug": "notes", "enabled": false})).unwrap();
        assert!(bundle_skill_names(&root, &wanted).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_update_toggle_delete_round_trip() {
        let root = temp_root("round-trip");

        let created = create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "description": "test plugin: Release Notes",
                "description": "turns git log into notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "# steps\n\nread the log",
                    "description": "when the user asks for release notes"
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
        // standalone store. `load_skill` used to read only the store (the loader is
        // `load_plugin` now), so every
        // skill the catalog advertised from a plugin answered "skill not found".
        let root = temp_root("locate");
        create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "description": "test plugin: Release Notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "# steps\n\nread the log",
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

    #[test]
    fn a_marketplace_skill_row_keeps_its_description() {
        // Reported: an installed skill showed a blank card line. The row's own
        // frontmatter has to survive the trip into a bundle at BOTH levels,
        // because the card reads the manifest and the catalog reads the skill.
        let root = temp_root("row-meta");
        let src = temp_root("row-meta-src");
        fs::create_dir_all(src.join("writer")).unwrap();
        fs::write(
            src.join("writer/SKILL.md"),
            "---\nname: Lex Writer\ndescription: Writes copy that sells\n---\n# writer\nBody.",
        )
        .unwrap();
        let out = install_from_marketplace(
            &root,
            &json!({"kind": "skills", "repo": src.to_str().unwrap()}),
        )
        .unwrap();
        let slug = out["slug"].as_str().unwrap();
        let manifest = read_manifest(&root, slug).unwrap();
        assert_eq!(
            manifest["description"],
            json!("Writes copy that sells"),
            "the bundle card must not be blank"
        );
        let dir = skill_dir_for(&root, "Lex Writer").unwrap();
        let md = fs::read_to_string(dir.join("skill.md")).unwrap();
        let (_, _, desc) = crate::skills::parse_frontmatter_pub(&md);
        assert_eq!(desc, "Writes copy that sells", "the skill keeps its own line");

        // A REINSTALL must not wipe what is stored: the row is read again and
        // the same fields have to come back unchanged.
        install_from_marketplace(
            &root,
            &json!({"kind": "skills", "repo": src.to_str().unwrap()}),
        )
        .unwrap();
        let again = read_manifest(&root, slug).unwrap();
        assert_eq!(again["description"], json!("Writes copy that sells"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn a_marketplace_row_lands_in_a_bundle_whatever_its_tab() {
        // A bundle is the ONLY container, so the tab no longer picks a store: it
        // decides what the row CONTRIBUTES. A skills row installs, and its skill
        // is then findable by name through the bundle tree — which is what the
        // Settings list and the `@` picker both read.
        let root = temp_root("kind-routing");

        // A skills row: one single-part bundle holding that skill.
        let skill_src = temp_root("kind-skill-src");
        fs::create_dir_all(skill_src.join("writer")).unwrap();
        fs::write(
            skill_src.join("writer/SKILL.md"),
            "---\nname: Lex Writer\ndescription: Writes copy\n---\n# writer\nBody.",
        )
        .unwrap();
        let out = install_from_marketplace(
            &root,
            &json!({"kind": "skills", "repo": skill_src.to_str().unwrap()}),
        )
        .unwrap();
        assert_eq!(out["skills"], json!(["Lex Writer"]));
        assert!(
            skill_dir_for(&root, "Lex Writer").is_some(),
            "a skills row must be findable through its bundle"
        );
        assert!(
            plugin_dir(&root, out["slug"].as_str().unwrap())
                .join(MANIFEST)
                .is_file(),
            "the skill must live in a bundle, not a standalone store"
        );

        // An MCP row: a single-part bundle holding the connector.
        let mcp_src = temp_root("kind-mcp-src");
        fs::create_dir_all(&mcp_src).unwrap();
        fs::write(
            mcp_src.join(".mcp.json"),
            r#"{"mcpServers":{"lex-tools":{"command":"npx","args":["-y","lex-tools"]}}}"#,
        )
        .unwrap();
        let out = install_from_marketplace(
            &root,
            &json!({"kind": "mcp", "repo": mcp_src.to_str().unwrap()}),
        )
        .unwrap();
        assert_eq!(out["mcp"], json!(["lex-tools"]));
        let stored = read_connectors(&root, out["slug"].as_str().unwrap());
        assert_eq!(stored["lex-tools"]["command"], "npx");

        // No kind (the Plugins tab, or a `/plugin install`): a BUNDLE, as before.
        let plugin_src = temp_root("kind-plugin-src");
        fs::create_dir_all(plugin_src.join("skills/one")).unwrap();
        fs::write(
            plugin_src.join("plugin.json"),
            r#"{"name":"Lex Plugin","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            plugin_src.join("skills/one/SKILL.md"),
            "---\nname: one\n---\n# one\nBody.",
        )
        .unwrap();
        install_from_marketplace(
            &root,
            &json!({"repo": plugin_src.to_str().unwrap()}),
        )
        .unwrap();
        assert!(plugin_dir(&root, "lex-plugin").join(MANIFEST).is_file());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&skill_src);
        let _ = fs::remove_dir_all(&mcp_src);
        let _ = fs::remove_dir_all(&plugin_src);
    }

    #[test]
    fn install_records_the_address() {
        // "Update from source" needs the ARGUMENTS, not a display string.
        // The install source is a plain folder, which `repo.rs` reads through
        // the SAME path a GitHub repo takes — so this needs no network.
        let src = temp_root("install-src");
        fs::create_dir_all(src.join("skills/alpha")).unwrap();
        fs::write(src.join("plugin.json"), r#"{"name":"Demo","version":"1.0.0"}"#).unwrap();
        fs::write(
            src.join("skills/alpha/SKILL.md"),
            "---\nname: alpha\n---\n# alpha\nBody.",
        )
        .unwrap();
        let root = temp_root("install-addr");
        let spec = src.to_str().unwrap();
        let out = install_plugin(&root, &json!({"repo": spec})).unwrap();
        let slug = out["slug"].as_str().unwrap().to_string();
        assert_eq!(out["installed"], "created");
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(plugin_dir(&root, &slug).join(MANIFEST)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["source_repo"], spec);

        // A reinstall is an UPDATE of the same bundle.
        let again = install_plugin(&root, &json!({"repo": spec})).unwrap();
        assert_eq!(again["installed"], "updated");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn a_marketplace_row_keeps_its_own_name_across_reinstalls() {
        // Five rows can share one source folder (anthropics/skills). The row's
        // name is the bundle's identity: without it every row landed as the
        // repo-named bundle, and "update from source" created a second copy.
        let src = temp_root("row-name-src");
        fs::create_dir_all(src.join("skills/alpha")).unwrap();
        fs::write(src.join("plugin.json"), r#"{"name":"Repo Name"}"#).unwrap();
        fs::write(
            src.join("skills/alpha/SKILL.md"),
            "---\nname: alpha\n---\nbody",
        )
        .unwrap();
        let root = temp_root("row-name-out");
        let out = install_plugin(
            &root,
            &json!({
                "repo": src.to_str().unwrap(),
                "name": "Row Name",
                "slug": "row-name",
            }),
        )
        .unwrap();
        assert_eq!(out["slug"], "row-name");
        assert_eq!(out["plugin"]["name"], "Row Name");

        let again = install_plugin(
            &root,
            &json!({
                "repo": src.to_str().unwrap(),
                "name": "Row Name",
                "slug": "row-name",
            }),
        )
        .unwrap();
        assert_eq!(again["installed"], "updated");
        assert_eq!(again["slug"], "row-name");
        let folders: Vec<String> = fs::read_dir(plugins_dir(&root))
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .collect();
        assert_eq!(folders, ["row-name"], "a reinstall must not create a second bundle");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn install_honours_the_skill_folders_a_marketplace_row_publishes() {
        // A row can point at a repo root and name only some of its skills
        // (anthropics/skills publishes five rows from `./`). Installing the
        // row must land that subset, not every skill in the repo.
        let src = temp_root("row-skills-src");
        fs::create_dir_all(src.join("skills/alpha")).unwrap();
        fs::create_dir_all(src.join("skills/beta")).unwrap();
        fs::create_dir_all(src.join("skills/gamma")).unwrap();
        fs::write(src.join("plugin.json"), r#"{"name":"Demo"}"#).unwrap();
        for name in ["alpha", "beta", "gamma"] {
            fs::write(
                src.join(format!("skills/{name}/SKILL.md")),
                format!("---\nname: {name}\ndescription: {name} skill\n---\nbody"),
            )
            .unwrap();
        }
        let root = temp_root("row-skills-out");
        let out = install_plugin(
            &root,
            &json!({
                "repo": src.to_str().unwrap(),
                "skills": ["./skills/alpha", "skills/gamma"],
            }),
        )
        .unwrap();
        let mut names: Vec<&str> = out["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s.as_str())
            .collect();
        names.sort();
        assert_eq!(names, ["alpha", "gamma"], "{out}");
        // The selection is remembered, so "update from source" re-reads the
        // same subset instead of adding `beta` on the next install.
        assert_eq!(
            out["plugin"]["source_skills"],
            json!(["skills/alpha", "skills/gamma"])
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn a_script_defaults_to_rust_and_an_unknown_language_is_refused() {
        // Rust is the DEFAULT, not one of four equal choices: the caller has to
        // ask for anything else. A typo must be refused here rather than write a
        // script nothing knows how to run.
        let root = temp_root("script-lang");
        let created = create_plugin(
            &root,
            &json!({
                "name": "Toolkit",
                "description": "test plugin: Toolkit",
                "scripts": [{"name": "Ping"}, {"name": "Probe", "language": "py"}]
            }),
        )
        .unwrap();
        assert_eq!(created["scripts"], json!(["Ping", "Probe"]));
        // No `language` given: Rust, both on disk and in the manifest.
        assert!(scripts_dir(&root, "toolkit").join("ping/main.rs").is_file());
        let meta = read_script(&root, "toolkit", "ping").unwrap();
        assert_eq!(meta["language"], "rust");
        // Aliases resolve to one canonical name, so `py` lands on `main.py`.
        let probe = read_script(&root, "toolkit", "probe").unwrap();
        assert_eq!(probe["language"], "python");
        assert!(scripts_dir(&root, "toolkit").join("probe/main.py").is_file());

        assert!(create_plugin(
            &root,
            &json!({"name": "Broken",
                "description": "test plugin: Broken", "scripts": [{"name": "x", "language": "cobol"}]}),
        )
        .is_err());
        // The cap is a real ceiling rather than a silent truncation.
        let too_many: Vec<Value> = (0..=MAX_SCRIPTS)
            .map(|i| json!({"name": format!("s{i}")}))
            .collect();
        assert!(update_plugin(
            &root,
            &json!({"slug": "toolkit", "scripts": too_many}),
        )
        .is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_script_runs_and_reports_its_own_words() {
        // The whole point of a script is its OUTPUT. Bash is used here so the
        // test does not depend on a compiler — the Rust path is the same call
        // with `rustc` in front, covered by the language test above.
        let root = temp_root("script-run");
        create_plugin(
            &root,
            &json!({
                "name": "Toolkit",
                "description": "test plugin: Toolkit",
                "scripts": [{
                    "name": "Greet",
                    "language": "bash",
                    "content": "echo \"hello $1\""
                }]
            }),
        )
        .unwrap();
        let out = run_plugin_script(
            &root,
            &json!({"slug": "toolkit", "name": "GREET", "args": ["world"]}),
        )
        .unwrap();
        assert_eq!(out["language"], "bash");
        // The name is echoed back as it was asked for; the lookup itself is
        // case-insensitive, which is exactly why `GREET` resolved at all.
        assert_eq!(out["script"].as_str().unwrap_or("").to_lowercase(), "greet");
        assert!(
            out["output"].as_str().unwrap_or("").contains("hello world"),
            "unexpected output: {out}"
        );

        // A name that is not there must list what IS, not fail blankly.
        let err = run_plugin_script(&root, &json!({"slug": "toolkit", "name": "ghost"}))
            .unwrap_err();
        // The stored name is listed as written; the lookup itself is
        // case-insensitive, which is why `greet` above resolved `Greet`.
        assert!(
            err.to_lowercase().contains("greet"),
            "unhelpful error: {err}"
        );
        // Switching the bundle OFF must take its scripts with it: the switch is
        // one unit, and a script of a bundle the user turned off running anyway
        // would make that switch a lie.
        update_plugin(&root, &json!({"slug": "toolkit", "enabled": false})).unwrap();
        let off = run_plugin_script(&root, &json!({"slug": "toolkit", "name": "greet"})).unwrap_err();
        assert!(
            off.contains("switched off"),
            "a switched-off bundle must refuse its scripts: {off}"
        );
        // And back on makes it runnable again (no state was lost).
        update_plugin(&root, &json!({"slug": "toolkit", "enabled": true})).unwrap();
        assert!(run_plugin_script(&root, &json!({"slug": "toolkit", "name": "greet"})).is_ok());

        // Deleting is a real removal, so the script list follows.
        update_plugin(
            &root,
            &json!({"slug": "toolkit", "deleted_scripts": ["greet"]}),
        )
        .unwrap();
        assert!(script_names(&root, "toolkit").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_connector_saved_with_a_slug_lands_in_that_bundle_not_a_new_one() {
        // The reported bug: Settings → a bundle's page sent `{slug, name, cfg}`
        // and the save ignored the slug, so a NEW single-part bundle was created
        // named after the connector and the bundle on screen stayed empty.
        let root = temp_root("conn-slug");
        install_bundle(
            &root,
            "Toolkit",
            json!({ "skills": [{ "name": "one", "content": "# One\n" }] }),
        )
        .unwrap();

        let out = save_bundle_connector(
            &root,
            &json!({
                "slug": "toolkit",
                "name": "fs",
                "cfg": { "command": "npx", "args": ["-y", "server-fs"] },
                "description": "Filesystem access",
            }),
        )
        .unwrap();
        assert_eq!(out["slug"], "toolkit");

        // The connector is IN the bundle, and no bundle was invented for it.
        assert_eq!(connector_names(&root, "toolkit"), vec!["fs".to_string()]);
        let all: Vec<String> = all_plugins(&root).into_iter().map(|(s, _)| s).collect();
        assert_eq!(all, vec!["toolkit".to_string()], "a stray bundle was created");

        // Its metadata sits in the manifest, never in `cfg` (forwarded verbatim).
        let row = all_plugin_connectors(&root)
            .into_iter()
            .find(|r| r["name"] == "fs")
            .expect("the connector row");
        assert_eq!(row["description"], "Filesystem access");
        assert!(row["cfg"].get("description").is_none(), "{row}");

        // Deleting from the page targets the same bundle.
        let gone = delete_bundle_connector(&root, &json!({ "slug": "toolkit", "name": "fs" }))
            .unwrap();
        assert_eq!(gone["ok"], true);
        assert!(connector_names(&root, "toolkit").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_with_a_name_says_to_create_instead_of_blaming_the_repo() {
        // The reported dead end: `/plugin install eurusd` reached `repo::parse`
        // and failed with "cannot read a repo from …", which reads as a bug when
        // the user simply wanted a bundle by that name.
        let root = temp_root("install-name");
        let err = install_plugin(&root, &json!({"repo": "eurusd"})).unwrap_err();
        assert!(err.contains("is a name, not a repo address"), "{err}");
        assert!(err.contains("action=create"), "{err}");
        // A real address still gets through the guard untouched (and fails only
        // because this one does not exist).
        let real = install_plugin(&root, &json!({"repo": "owner/repo"})).unwrap_err();
        assert!(!real.contains("is a name, not a repo address"), "{real}");
        let _ = fs::remove_dir_all(&root);
    }
}

mod bundle;
mod install;
mod parts;
mod toolbox;
mod scripts;
mod skills_connectors;
mod store;

#[allow(unused_imports)] // used by agent tests under cfg(test)
use parts::*;

// Private globs: sibling parts see each other's pub(super) items exactly as in
// the single-file module. The pub use globs below re-export the public surface.
use bundle::*;
use install::*;
use scripts::*;
use skills_connectors::*;
use store::*;

// Public re-exports reproduce the original plugins surface.
#[allow(unused_imports)] // some items are only referenced under cfg(test)
pub use bundle::*;
#[allow(unused_imports)] // some items are only referenced under cfg(test)
pub use install::*;
pub use scripts::run_plugin_script;
#[allow(unused_imports)] // some items are only referenced under cfg(test)
pub use skills_connectors::*;
#[allow(unused_imports)] // some items are only referenced under cfg(test)
pub use store::*;
pub use toolbox::*;
#[allow(unused_imports)] // used by agent tests under cfg(test)
pub(crate) use bundle::refresh_builtin_bundle_view;
#[allow(unused_imports)] // used by agent tests under cfg(test)
pub(crate) use scripts::load_plugin_env;
#[allow(unused_imports)] // used by agent tests under cfg(test)
pub(crate) use store::script_source_file;
