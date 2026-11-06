use super::*;

/// One plugin as the renderer/tool sees it: the manifest plus the live lists of
/// what is inside the folder.
pub(super) fn plugin_view(root: &Path, slug: &str) -> Value {
    let mut manifest = read_manifest(root, slug).unwrap_or_else(|| json!({}));
    if !manifest.is_object() {
        manifest = json!({});
    }
    manifest["slug"] = json!(slug);
    // Absolute folder — lets a client (e.g. the /plugin update badge) pin an
    // update session to this bundle's directory without a second call.
    manifest["dir"] = json!(plugin_dir(root, slug).to_string_lossy().to_string());
    manifest["skills"] = json!(skill_names(root, slug));
    manifest["mcp"] = json!(connector_names(root, slug));
    manifest["scripts"] = json!(script_names(root, slug));
    // The three parts a Claude Code bundle may be made of ENTIRELY. They are
    // listed from disk like the rest, so a bundle with no skill still shows
    // what it actually carries.
    manifest[COMMANDS] = json!(command_names(root, slug));
    manifest[crate::subagents::AGENTS] = json!(agent_names(root, slug));
    manifest["hooks"] = crate::hooks::describe(&plugin_dir(root, slug))["hooks"].clone();
    // Always an array, even when the file holds a hand-written string: the
    // renderer edits it as a list and would otherwise show nothing.
    manifest[KEYWORDS] = json!(keywords_of(&manifest[KEYWORDS].clone()));
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

/// `plugin action=list` for the AGENT: one line per bundle — slug, display
/// name, enabled state, skill count, connector and script names.
///
/// The full `plugin_view` JSON (manifest, keywords, commands, agents, hooks,
/// absolute dir…) is what the Settings page needs; a model that only asked
/// what is installed paid every bundle's whole manifest for it, and a store of
/// ten bundles flooded the turn with JSON nothing read. The detail stays one
/// call away: `plugin action=list slug=<slug>` (see [`plugin_detail`]).
pub fn list_plugins_summary(root: &Path) -> String {
    let plugins = list_plugins(root)["plugins"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if plugins.is_empty() {
        return "(no plugin bundles installed)".to_string();
    }
    let mut out = String::new();
    for p in plugins {
        let slug = p["slug"].as_str().unwrap_or_default();
        let name = p["name"].as_str().unwrap_or(slug);
        let enabled = if p["enabled"].as_bool().unwrap_or(false) { "on" } else { "off" };
        let skills = p["skills"].as_array().map(|a| a.len()).unwrap_or(0);
        out.push_str(&format!(
            "- {slug} — {name} [{enabled}] — {skills} skill(s); connectors: {}; scripts: {}\n",
            name_list(&p["mcp"]),
            name_list(&p["scripts"]),
        ));
    }
    out
}

/// A JSON array of strings as a comma list, `none` when empty.
pub(super) fn name_list(v: &Value) -> String {
    let names: Vec<&str> = v
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if names.is_empty() {
        "none".to_string()
    } else {
        names.join(", ")
    }
}

/// One bundle's FULL manifest — what `plugin action=list slug=<slug>` returns.
///
/// The compact list names the slugs; this is the drill-in, so the model pays a
/// bundle's whole manifest only when it is about to work with that bundle.
pub fn plugin_detail(root: &Path, slug: &str) -> Result<Value, String> {
    if read_manifest(root, slug).is_none() {
        return Err(format!(
            "plugin not found: {slug} — action=list names the installed slugs"
        ));
    }
    Ok(plugin_view(root, slug))
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
    // The bundle's own Persian trigger, written on CREATE too. Writing it only
    // in `update_plugin` meant a hand-made plugin (chat or the create button)
    // silently dropped every keyword it was given, so the bundle could never be
    // found from a Persian request — the one thing this field is for.
    let keywords = keywords_of(&body[KEYWORDS]);
    if !keywords.is_empty() {
        manifest[KEYWORDS] = json!(keywords);
    }
    copy_source_args(&mut manifest, body);
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
    // An explicit empty list CLEARS the keywords; an absent field leaves them
    // alone, exactly like `description` above.
    if has_keywords(body) {
        let keywords = keywords_of(&body[KEYWORDS]);
        if keywords.is_empty() {
            if let Some(map) = manifest.as_object_mut() {
                map.remove(KEYWORDS);
            }
        } else {
            manifest[KEYWORDS] = json!(keywords);
        }
    }
    if let Some(src) = body[SOURCE].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        manifest[SOURCE] = json!(src);
    }
    copy_source_args(&mut manifest, body);
    manifest["updated_at"] = json!(now_secs());
    write_manifest(root, &slug, &manifest)?;
    apply_parts(root, &slug, body)?;
    Ok(plugin_view(root, &slug))
}

/// Install a plugin straight out of a git repo, the way Claude Desktop does:
/// read the bundle from the repo and write it through the SAME path a
/// hand-authored one takes — `create_plugin`, or `update_plugin` when the slug
/// already exists, so reinstalling updates instead of failing.
/// Install one marketplace row.
///
/// A marketplace index lists three things and the tab the user clicked says which
/// — but that only decides what the row CONTRIBUTES (`skills`, `mcp`, or a whole
/// bundle). Everything lands in a PLUGIN BUNDLE, the single container: one store
/// means one create/update/switch/delete path, and a skill installed from the
/// Skills tab is exactly as visible and editable as one the user wrote by hand.
/// This used to route skills and connectors into standalone stores, which gave
/// the app two of everything.
pub fn install_from_marketplace(root: &Path, body: &Value) -> Result<Value, String> {
    match body["kind"].as_str().unwrap_or("").trim() {
        "skills" => install_skills_as_bundle(root, body),
        "mcp" => install_connectors_as_bundle(root, body),
        _ => install_plugin(root, body),
    }
}

/// The shared guard: `install` gets a NAME instead of an address when what the
/// user wants is something CREATED, and "cannot read a repo from …" reads as a
/// bug there, so say which action does what was asked.
pub(super) fn require_repo_address(spec: &str) -> Result<(), String> {
    if !spec.is_empty() && !crate::repo::looks_like_repo_address(spec) {
        return Err(format!(
            "{spec:?} is a name, not a repo address. `install` only READS an existing bundle \
             from `owner/repo`, a GitHub URL, or a local folder. To create a bundle with that \
             name, call action=create (the `/plugin create` command) and give it skills and \
             scripts."
        ));
    }
    Ok(())
}

/// Bundle name + payload for a marketplace row: the row's own name wins, and the
/// install ADDRESS travels with it so "update from source" can re-read the row.
pub(super) fn row_bundle_payload(
    body: &Value,
    name: &str,
    parts: Value,
    keywords: &[String],
    stale: Vec<Value>,
) -> Value {
    let mut payload = json!({
        "name": name,
        "source": body["source"].clone(),
        "repo": body["repo"].clone(),
        "repo_path": body["repo_path"].clone(),
        "repo_ref": body["repo_ref"].clone(),
    });
    if let Some(obj) = parts.as_object() {
        for (k, v) in obj {
            payload[k] = v.clone();
        }
    }
    // `keywords_of` is the one splitter/deduplicator (Persian comma included), so
    // the same phrase cannot land twice under two spellings. An explicit empty
    // list from the caller still clears the field.
    if !keywords.is_empty() {
        payload[KEYWORDS] = json!(keywords_of(&json!(keywords)));
    }
    if !stale.is_empty() {
        payload["deleted_skills"] = json!(stale);
    }
    payload
}

/// A Skills-tab row: the repo's skills, written into ONE plugin bundle.
///
/// Each skill keeps its own `fa_keywords`: an own list wins, otherwise the skill
/// NAME seeds them (the same conservative rule the bundle mapper uses), and an
/// empty seed leaves the key out so a reinstall cannot wipe a hand-edited list.
pub(super) fn install_skills_as_bundle(root: &Path, body: &Value) -> Result<Value, String> {
    let spec = body["repo"].as_str().unwrap_or("").trim();
    require_repo_address(spec)?;
    let read = crate::repo::read_skills_at(
        spec,
        body["repo_path"].as_str().unwrap_or(""),
        body["repo_ref"].as_str().unwrap_or(""),
    )?;
    let mut skills: Vec<Value> = Vec::new();
    let mut keywords: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for row in read["skills"].as_array().into_iter().flatten() {
        let name = row["name"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let own = crate::skills::split_fa_keywords(row[KEYWORDS].as_str().unwrap_or(""));
        let seed = if own.is_empty() {
            category_keywords(name)
        } else {
            own
        };
        keywords.extend(seed.iter().cloned());
        names.push(name.to_string());
        skills.push(json!({
            "name": name,
            "description": row["description"].clone(),
            "content": row["content"].clone(),
            "extra_files": row["extra_files"].clone(),
            "fa_keywords": seed,
        }));
    }
    if names.is_empty() {
        return Err(format!(
            "no SKILL.md found in {} — point the marketplace row at a folder holding a skill",
            read["source"].as_str().unwrap_or(spec)
        ));
    }
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| names[0].as_str())
        .to_string();
    let slug = plugin_slug(&name, body["slug"].as_str().unwrap_or(""));
    // A skill the row no longer ships is removed, so "update from source" cannot
    // leave a withdrawn one behind (the bundle writer honours `deleted_skills`).
    let stale: Vec<Value> = if plugin_dir(root, &slug).join(MANIFEST).is_file() {
        skill_names(root, &slug)
            .into_iter()
            .filter(|n| !names.contains(n))
            .map(Value::String)
            .collect()
    } else {
        Vec::new()
    };
    let payload = row_bundle_payload(
        body,
        &name,
        json!({ "skills": skills, "source": read["source"].clone() }),
        &keywords,
        stale,
    );
    write_bundle_payload(root, &payload)
}

/// An MCP-tab row: the repo's connectors, written into ONE plugin bundle.
///
/// The row's connectors ride on the bundle payload's `mcp` key, which
/// `apply_parts` already merges into the bundle's own `mcp.json` — no second
/// writer for the same file.
pub(super) fn install_connectors_as_bundle(root: &Path, body: &Value) -> Result<Value, String> {
    let spec = body["repo"].as_str().unwrap_or("").trim();
    require_repo_address(spec)?;
    let read = crate::repo::read_connectors_at(
        spec,
        body["repo_path"].as_str().unwrap_or(""),
        body["repo_ref"].as_str().unwrap_or(""),
    )?;
    let servers = read["mcp"].as_object().cloned().unwrap_or_default();
    if servers.is_empty() {
        return Err(format!(
            "no .mcp.json or mcp.json found in {} — that row does not publish a connector",
            read["source"].as_str().unwrap_or(spec)
        ));
    }
    let names: Vec<String> = servers.keys().cloned().collect();
    let keywords: Vec<String> = names.iter().flat_map(|n| category_keywords(n)).collect();
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| names[0].as_str())
        .to_string();
    let payload = row_bundle_payload(
        body,
        &name,
        json!({ "mcp": Value::Object(servers), "source": read["source"].clone() }),
        &keywords,
        Vec::new(),
    );
    write_bundle_payload(root, &payload)
}

/// Create or update a bundle from a NAME and the parts it carries.
///
/// The single entry point every producer goes through — a boot migration, a
/// built-in seed, the agent's `create_skill`/`create_mcp` — so exactly one place
/// decides a slug, seeds keywords and writes a manifest. `parts` is the
/// `plugin.json`-shaped content minus the address arguments (`skills`, `mcp`,
/// `scripts`, `description`, `enabled`, `fa_keywords`).
///
/// `enabled` is honoured when the caller states it (a migration has to reproduce
/// the switch the user had) and defaults to on.
pub fn install_bundle(root: &Path, name: &str, parts: Value) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("bundle name is required".into());
    }
    // The bundle's own trigger, so a bundle whose parts carry no keywords is
    // still reachable from a Persian ask; a caller that already knows better
    // passes its own list and wins.
    let mut base = json!({ "name": name });
    let seed = category_keywords(name);
    if !seed.is_empty() {
        base[KEYWORDS] = json!(seed);
    }
    let mut payload = base;
    if let Some(obj) = parts.as_object() {
        for (k, v) in obj {
            payload[k] = v.clone();
        }
    }
    // A single-part bundle whose only skill carries keywords has to be findable
    // AT BUNDLE LEVEL too: the name may identify no technology at all (a
    // migrated skill called «Movie Finder»), and the plugin card then showed an
    // empty trigger while the skill inside it had one.
    if payload.get(KEYWORDS).is_none_or(|v| v.as_array().map_or(true, Vec::is_empty)) {
        let mut lifted: Vec<String> = Vec::new();
        for item in payload["skills"].as_array().into_iter().flatten() {
            for kw in keywords_of(&item[KEYWORDS]) {
                if !lifted.contains(&kw) {
                    lifted.push(kw);
                }
            }
        }
        lifted.truncate(INHERIT_KEYWORDS_MAX);
        if !lifted.is_empty() {
            payload[KEYWORDS] = json!(lifted);
        }
    }
    // The description lift lives in `write_bundle_payload`, the single writer,
    // so a marketplace row that skips this function gets it too.
    write_bundle_payload(root, &payload)
}

/// Folder slug of the one bundle the shipped skills live in.
pub fn builtin_bundle_slug() -> String {
    plugin_slug(BUILTIN_BUNDLE_NAME, BUILTIN_BUNDLE_SLUG)
}

/// Write one skill into ONE named bundle, creating that bundle when needed.
///
/// The shipped-skill seeder goes through this: the built-in library is a single
/// container, so Settings shows one card instead of one card per shipped file.
pub fn save_skill_into_bundle(
    root: &Path,
    bundle_name: &str,
    bundle_slug: &str,
    skill: Value,
) -> Result<Value, String> {
    install_bundle(
        root,
        bundle_name,
        json!({ "slug": plugin_slug(bundle_name, bundle_slug), "skills": [skill] }),
    )
}

/// Cap on the keywords lifted from a library's skills to its own manifest.
pub(super) const BUNDLE_LIBRARY_KEYWORDS_MAX: usize = 8;

/// Fold the per-skill bundles an older seeder made into the single builtin one.
///
/// A bundle is folded only when EVERY skill inside it is a SHIPPED one (it
/// carries `skills::SHIPPED_MARKER`) and it holds no connector or script: a
/// bundle the user built, and a connector bundle, keep the switch they have —
/// one switch per thing the user chose is the granularity that matters.
///
/// Returns how many skill folders moved.
pub fn fold_builtin_skills_into_one(root: &Path) -> usize {
    let base = plugins_dir(root);
    let Ok(entries) = fs::read_dir(&base) else {
        return 0;
    };
    let builtin = plugin_dir(root, &builtin_bundle_slug());
    let mut moves: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut emptied: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if slug == builtin_bundle_slug() || read_manifest(root, &slug).is_none() {
            continue;
        }
        // A connector or a script in the folder means it is not a skill library.
        if !read_connectors(root, &slug).is_empty() || !script_names(root, &slug).is_empty() {
            continue;
        }
        let src = plugin_dir(root, &slug).join("skills");
        let Ok(kids) = fs::read_dir(&src) else {
            continue;
        };
        let mut shipped: Vec<PathBuf> = Vec::new();
        let mut all_shipped = true;
        for kid in kids.flatten() {
            let path = kid.path();
            if !path.is_dir() || !path.join("skill.md").is_file() {
                continue;
            }
            if !path.join(crate::skills::SHIPPED_MARKER).is_file() {
                all_shipped = false;
                break;
            }
            shipped.push(path);
        }
        if !all_shipped || shipped.is_empty() {
            continue;
        }
        for path in shipped {
            let Some(folder) = path.file_name() else {
                continue;
            };
            moves.push((path.clone(), builtin.join("skills").join(folder)));
        }
        emptied.push(plugin_dir(root, &slug));
    }
    if moves.is_empty() {
        return 0;
    }
    if fs::create_dir_all(builtin.join("skills")).is_err() {
        return 0;
    }
    // The container itself, so the moved folders have a manifest beside them.
    let _ = install_bundle(root, BUILTIN_BUNDLE_NAME, json!({ "slug": builtin_bundle_slug() }));
    let mut count = 0;
    for (from, to) in &moves {
        // The library copy can be stale (a re-seed wrote it before the fold ran).
        if to.exists() {
            let _ = fs::remove_dir_all(to);
        }
        if fs::rename(from, to).is_ok() {
            count += 1;
        }
    }
    for dir in emptied {
        let _ = fs::remove_dir_all(&dir);
    }
    refresh_builtin_bundle_view(root);
    count
}

/// Lift a library's description and keywords up to its own manifest.
///
/// The folders were MOVED, not re-written through the skill writer, so nothing
/// filled the bundle-level fields the card renders.
///
/// Keywords are taken ROUND-ROBIN across the skills, not in folder order: the
/// first skill of a large library (Browser Automation carries eleven) used to
/// fill the whole cap, so the bundle advertised one topic and every other skill
/// was unreachable from a Persian ask. One phrase per skill in turn keeps the
/// bundle's trigger representative of what it actually holds.
///
/// A list the user typed by hand is left alone: when it names a phrase no skill
/// carries, it did not come from this lift, so it is not this function's to
/// rewrite.
pub(crate) fn refresh_builtin_bundle_view(root: &Path) {
    let Ok(kids) = fs::read_dir(plugin_dir(root, &builtin_bundle_slug()).join("skills")) else {
        return;
    };
    let mut description = String::new();
    let mut per_skill: Vec<Vec<String>> = Vec::new();
    for kid in kids.flatten() {
        let Ok(raw) = fs::read_to_string(kid.path().join("skill.md")) else {
            continue;
        };
        let (_, _, desc, fa) = crate::skills::parse_frontmatter_pub(&raw);
        if description.is_empty() && !desc.trim().is_empty() {
            description = desc.trim().to_string();
        }
        if !fa.is_empty() {
            per_skill.push(fa);
        }
    }
    let lifted = interleave(&per_skill, BUNDLE_LIBRARY_KEYWORDS_MAX);
    if let Some(stored) = read_manifest(root, &builtin_bundle_slug()) {
        let known: Vec<String> = per_skill.iter().flatten().cloned().collect();
        let hand_typed = keywords_of(&stored[KEYWORDS])
            .into_iter()
            .any(|k| !known.contains(&k));
        if hand_typed {
            return;
        }
    }
    let mut patch = json!({ "slug": builtin_bundle_slug(), "name": BUILTIN_BUNDLE_NAME });
    if !description.is_empty() {
        patch["description"] = json!(description);
    }
    if !lifted.is_empty() {
        patch[KEYWORDS] = json!(lifted);
    }
    let _ = update_plugin(root, &patch);
}

/// One phrase per list in turn, so a long list cannot starve the others.
///
/// Each list is deduped against the whole result, so the same phrase appearing
/// in several skills is not paid for twice.
pub(super) fn interleave(lists: &[Vec<String>], cap: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut round = 0;
    while out.len() < cap {
        let mut took = false;
        for list in lists {
            let Some(kw) = list.get(round).map(|k| k.trim()).filter(|k| !k.is_empty()) else {
                continue;
            };
            took = true;
            if !out.iter().any(|k| k == kw) {
                out.push(kw.to_string());
                if out.len() >= cap {
                    break;
                }
            }
        }
        // Every list is exhausted, so another pass would add nothing.
        if !took {
            break;
        }
        round += 1;
    }
    out
}

/// Shipped skills that have been REPLACED or withdrawn, by their old name.
///
/// `seed_builtin_skills` only ever adds or updates, so a renamed shipped file
/// would leave the old one in every install forever — the user would see both
/// "Playwrite" and "Browser Automation" in the catalog. A name listed here is
/// removed on boot, but ONLY while the file is still the machine's: a skill the
/// user edited carries a `user` marker and their text wins.
pub const RETIRED_BUILTIN_SKILLS: &[&str] = &[
    // Renamed to "Browser Automation": the old name misspelled Playwright, and
    // the guide is about the NATIVE browser tools, not the retired MCP.
    "Playwrite",
];

/// Delete the shipped skills that a rename left behind. Returns the names.
///
/// `delete_bundle_skill` already knows to drop a bundle that held only this
/// skill, so nothing here repeats that rule.
pub fn retire_builtin_skills(root: &Path) -> Vec<String> {
    let mut retired: Vec<String> = Vec::new();
    for name in RETIRED_BUILTIN_SKILLS {
        let Some(dir) = skill_dir_for(root, name) else {
            continue;
        };
        // Provenance decides, and it must PROVE the machine wrote this copy:
        // a `seeded` marker is a stale copy of a shipped file and goes, a
        // `user` marker is the user's text and stays, and NO marker (migrated
        // or pre-marker skill) is unknown provenance — deleting it could take
        // the only copy of the user's work, so it stays.
        if !crate::skills::skill_is_app_seeded(&dir) {
            continue;
        }
        if delete_bundle_skill(root, name).is_ok() {
            retired.push((*name).to_string());
        }
    }
    retired
}

/// Create or update the bundle `payload` describes.
///
/// The reply is the marketplace-install shape (`installed`/`source`/`skills`/…) so
/// every producer reports back the same way and the UI can show what landed
/// without a second read.
pub(super) fn write_bundle_payload(root: &Path, payload: &Value) -> Result<Value, String> {
    let slug = plugin_ref(payload);
    let existed = plugin_dir(root, &slug).join(MANIFEST).is_file();
    let mut payload = payload.clone();
    lift_description(root, &slug, existed, &mut payload);
    let view = if existed {
        update_plugin(root, &payload)?
    } else {
        create_plugin(root, &payload)?
    };
    Ok(json!({
        "installed": if existed { "updated" } else { "created" },
        "slug": slug,
        "source": view["source"].clone(),
        "skills": view["skills"].clone(),
        "mcp": view["mcp"].clone(),
        "scripts": view["scripts"].clone(),
        "plugin": view,
    }))
}

/// Give a bundle the first skill's description when it has none of its own.
///
/// Applied in the SINGLE writer so every producer gets it. The marketplace paths
/// (`install_skills_as_bundle`, `install_connectors_as_bundle`, `install_plugin`)
/// call this directly instead of `install_bundle`, so they used to land with a
/// blank card line while the skill inside carried a full description — the
/// reported "description is empty" on an installed skill.
///
/// A bundle that already has one — on disk, or in this very payload — keeps it,
/// so an update that does not mention the field never overwrites it.
pub(super) fn lift_description(root: &Path, slug: &str, existed: bool, payload: &mut Value) {
    if !payload["description"].as_str().unwrap_or("").trim().is_empty() {
        return;
    }
    if existed
        && read_manifest(root, slug)
            .and_then(|m| m["description"].as_str().map(str::to_string))
            .is_some_and(|d| !d.trim().is_empty())
    {
        return;
    }
    let lifted = payload["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|item| item["description"].as_str())
        .map(str::trim)
        .filter(|d| !d.is_empty());
    if let Some(desc) = lifted {
        payload["description"] = json!(desc);
    }
}

