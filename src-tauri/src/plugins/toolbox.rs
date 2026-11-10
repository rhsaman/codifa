use super::*;

/// One enabled plugin resolved as the agent's toolbox.
///
/// The plugin is ALWAYS the unit that gets loaded: `slug` returns the whole
/// toolbox (skills + connectors + scripts). `slug` + `skill` narrows that to
/// ONE skill body **from inside the plugin** — the plugin still has to be the
/// thing the agent found and named, so a bare skill name is never a shortcut
/// around plugin discovery.
pub struct PluginToolbox {
    /// Connector names the caller must activate for the next round.
    pub connectors: Vec<String>,
    /// The model-facing text: skills, scripts, commands, connector inventory.
    pub text: String,
}

/// One catalog row per ENABLED plugin — the unit discovery works on.
///
/// The top-level description is the trigger. A bundle that has none falls back
/// to the first skill's description (legacy bundles such as `docker` were
/// installed before the description was required), so the catalog never hides
/// a whole toolbox behind a blank manifest field.
pub fn enabled_plugin_catalog(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in enabled_plugins(root) {
        let name = manifest["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&slug)
            .to_string();
        let skills: Vec<Value> = crate::skills::list_skills(&plugin_dir(root, &slug))["skills"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let description = effective_plugin_description(&slug, &manifest, &skills);
        let skill_names: Vec<String> = skills
            .iter()
            .filter_map(|s| s["name"].as_str().map(str::to_string))
            .collect();
        out.push(json!({
            "slug": slug,
            "name": name,
            "description": description,
            "skills": skill_names,
            "connectors": connector_names(root, &slug),
            "scripts": script_names(root, &slug),
            "commands": command_names(root, &slug),
        }));
    }
    out
}

/// The description discovery matches against: the manifest's own line, or the
/// first skill's description when the manifest is blank.
pub fn effective_plugin_description(slug: &str, manifest: &Value, skills: &[Value]) -> String {
    let own = manifest["description"].as_str().unwrap_or("").trim();
    if !own.is_empty() {
        return own.to_string();
    }
    skills
        .iter()
        .find_map(|s| s["description"].as_str())
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "(no description — this plugin cannot be matched by the agent; add one with \
                 plugin action=update slug={slug})"
            )
        })
}

/// Resolve a slug/name to an ENABLED plugin. A skill name is NOT a plugin: it
/// gets a redirect to its owning plugin, never a body.
fn resolve_enabled(root: &Path, wanted: &str) -> Result<(String, Value), String> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        let slugs: Vec<String> = enabled_plugins(root).into_iter().map(|(s, _)| s).collect();
        return Err(format!(
            "load_plugin needs a plugin slug. Enabled plugins: {}",
            if slugs.is_empty() {
                "(none)".to_string()
            } else {
                slugs.join(", ")
            }
        ));
    }
    for (slug, manifest) in enabled_plugins(root) {
        let name = manifest["name"].as_str().unwrap_or("").trim();
        if slug.eq_ignore_ascii_case(wanted) || name.eq_ignore_ascii_case(wanted) {
            return Ok((slug, manifest));
        }
    }
    if let Some(owner) = crate::plugins::plugin_of_skill(root, wanted) {
        return Err(format!(
            "{wanted:?} is a skill inside plugin {owner:?}, not a plugin. Call load_plugin with \
             slug={owner:?}: one call loads the whole toolbox (that skill included). A skill is \
             never loaded on its own."
        ));
    }
    let slugs: Vec<String> = enabled_plugins(root).into_iter().map(|(s, _)| s).collect();
    Err(format!(
        "plugin not found: {wanted:?}. Enabled plugins: {}",
        if slugs.is_empty() {
            "(none)".to_string()
        } else {
            slugs.join(", ")
        }
    ))
}

/// One skill body as the plugin loader prints it. A body past the shared cap is
/// replaced with a pointer to the per-skill re-read (`load_plugin slug=… skill=…`),
/// so one huge skill cannot flood the turn that loaded the toolbox.
fn skill_block(sk: &Value) -> String {
    let name = sk["name"].as_str().unwrap_or_default();
    let description = sk["description"].as_str().unwrap_or_default();
    let files: Vec<&str> = sk["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let extra = if files.is_empty() {
        String::new()
    } else {
        format!(
            "\nExtra files: {} — read one with load_plugin slug=<this plugin> skill=<name> file=<file>.",
            files.join(", ")
        )
    };
    let content = sk["content"].as_str().unwrap_or_default();
    if content.chars().count() > crate::skill_router::AUTO_MAX_BODY_CHARS {
        return format!(
            "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n\
             This skill's body is long and was NOT inlined. Call load_plugin with \
             slug=<plugin> skill={name} to re-read it.\n===== END SKILL: {name} ====="
        );
    }
    format!(
        "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n{content}\n===== END SKILL: {name} ====="
    )
}

/// Load ONE plugin as a toolbox: every skill body, its connector names (the
/// caller activates them), and the script/command inventory.
pub fn plugin_toolbox(root: &Path, wanted: &str) -> Result<PluginToolbox, String> {
    let (slug, manifest) = resolve_enabled(root, wanted)?;
    let label = manifest["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&slug)
        .to_string();
    let skills: Vec<Value> = crate::skills::list_skills(&plugin_dir(root, &slug))["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let description = effective_plugin_description(&slug, &manifest, &skills);
    let connectors = connector_names(root, &slug);

    let mut text = format!(
        "===== PLUGIN: {label} ({slug}) =====\nDescription: {description}\n\
         This plugin is ONE toolbox: every skill body is below, its connector tools are loaded, \
         and its scripts/commands are listed. Do not load a skill of this plugin separately. \
         If the task it covers needs more than one step, call update_plan BEFORE your next \
         action with the complete checklist in the user's language, then keep it current as \
         you go.\n"
    );
    if skills.is_empty() {
        text.push_str("\n(skills: none)\n");
    } else {
        text.push('\n');
        for sk in &skills {
            text.push_str(&skill_block(sk));
            text.push_str("\n\n");
        }
    }
    if connectors.is_empty() {
        text.push_str("Connectors: none\n");
    } else {
        text.push_str(&format!(
            "Connectors: {} — their tools are callable from your next step.\n",
            connectors.join(", ")
        ));
    }
    let scripts = list_scripts(root, &slug);
    if !scripts.is_empty() {
        text.push_str(&format!(
            "Scripts (run with plugin action=run, slug={slug}, name=<name>):\n"
        ));
        for s in &scripts {
            let name = s["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() {
                continue;
            }
            let lang = s["language"].as_str().unwrap_or("rust");
            let description = s["description"].as_str().unwrap_or_default().trim();
            text.push_str(&format!(
                "  · {name} [{lang}]{}",
                if description.is_empty() {
                    String::new()
                } else {
                    format!(" — {description}")
                }
            ));
            text.push('\n');
        }
    }
    let commands = list_commands(root, &slug);
    if !commands.is_empty() {
        text.push_str("Commands (the user can type these after `/`):\n");
        for c in &commands {
            let name = c["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() {
                continue;
            }
            let description = c["description"].as_str().unwrap_or_default().trim();
            text.push_str(&format!(
                "  · /{name}{}",
                if description.is_empty() {
                    String::new()
                } else {
                    format!(" — {description}")
                }
            ));
            text.push('\n');
        }
    }
    text.push_str("===== END PLUGIN =====");
    Ok(PluginToolbox { connectors, text })
}

/// Re-read ONE skill body of an already loaded plugin.
pub fn plugin_skill_body(root: &Path, plugin: &str, skill: &str) -> Result<String, String> {
    let (slug, _) = resolve_enabled(root, plugin)?;
    let rows = crate::skills::list_skills(&plugin_dir(root, &slug))["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let wanted = skill.trim().to_lowercase();
    rows.iter()
        .find(|s| {
            let name = s["name"].as_str().unwrap_or_default().trim().to_lowercase();
            let skill_slug = s["slug"].as_str().unwrap_or_default().trim().to_lowercase();
            name == wanted || skill_slug == wanted
        })
        .map(skill_block)
        .ok_or_else(|| {
            let names: Vec<&str> = rows
                .iter()
                .filter_map(|s| s["name"].as_str())
                .collect();
            format!(
                "skill {skill:?} is not inside plugin {slug:?}. Its skills: {}",
                if names.is_empty() {
                    "(none)".to_string()
                } else {
                    names.join(", ")
                }
            )
        })
}

/// Read one extra file of a skill inside a plugin.
pub fn plugin_skill_file(
    root: &Path,
    plugin: &str,
    skill: &str,
    file: &str,
) -> Result<String, String> {
    let (slug, _) = resolve_enabled(root, plugin)?;
    let dir = find_skill_dir(root, &slug, skill)
        .ok_or_else(|| format!("skill {skill:?} is not inside plugin {slug:?}"))?;
    let read = crate::skills::read_extra_file(&dir, skill, file)?;
    Ok(read["content"].as_str().unwrap_or_default().to_string())
}

/// Search PLUGINS and their SKILLS by name and description.
///
/// The catalog is byte-capped, so a store of many plugins cannot all fit in the
/// prompt. This is the escape hatch, and it searches BOTH levels: a plugin whose
/// own line matches, and a skill whose name or description matches even when its
/// plugin's description never mentions it. A skill hit is reported WITH its
/// owning plugin, because the plugin is what gets loaded: the result names the
/// exact `slug`, or `slug` + `skill` when only that one body is needed. It never
/// returns a bare skill body — a hidden name (e.g. the 20th of a 24-skill
/// library) still has to be reached through the plugin that carries it.
pub fn search_plugins(root: &Path, query: &str) -> Result<String, String> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() > 1)
        .filter(|t| !PLUGIN_STOPWORDS.contains(t))
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Err(format!(
            "load_plugin query {query:?} has no word to search for"
        ));
    }
    let rows = enabled_plugin_catalog(root);
    if rows.is_empty() {
        return Err(format!(
            "no plugins are enabled — nothing matches {query:?}"
        ));
    }
    struct Hit<'a> {
        score: f64,
        row: &'a Value,
        /// Skills of this plugin that matched, best first. OWNED: the rows are
        /// read per plugin inside the loop, so a borrow of `skill_rows` cannot
        /// outlive the iteration that produced it.
        skills: Vec<(f64, Value)>,
    }
    let mut hits: Vec<Hit> = Vec::new();
    for p in &rows {
        let slug = p["slug"].as_str().unwrap_or_default();
        let name = p["name"].as_str().unwrap_or_default().to_lowercase();
        let description = p["description"].as_str().unwrap_or_default().to_lowercase();
        let slug_l = slug.to_lowercase();
        let mut score = 0.0;
        for t in &terms {
            if slug_l.contains(t) || name.contains(t) {
                score += 3.0;
            }
            if description.contains(t) {
                score += 2.0;
            }
        }
        // Skill rows are read from disk: the catalog carries names only, and a
        // DESCRIPTION is what makes a skill findable when its name is generic.
        let skill_rows: Vec<Value> = crate::skills::list_skills(&plugin_dir(root, slug))["skills"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut matched: Vec<(f64, Value)> = Vec::new();
        for s in &skill_rows {
            let sname = s["name"].as_str().unwrap_or_default().to_lowercase();
            let sslug = s["slug"].as_str().unwrap_or_default().to_lowercase();
            let sdesc = s["description"].as_str().unwrap_or_default().to_lowercase();
            let mut ss = 0.0;
            for t in &terms {
                if sname.contains(t) || sslug.contains(t) {
                    ss += 3.0;
                }
                if sdesc.contains(t) {
                    ss += 1.5;
                }
            }
            if ss > 0.0 {
                matched.push((ss, s.clone()));
            }
        }
        matched.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let best_skill = matched.first().map(|(s, _)| *s).unwrap_or(0.0);
        // A skill hit also lifts its PLUGIN into the results, because the
        // plugin line is where the slug lives — but it never outranks a plugin
        // whose own description matched.
        let total = score + best_skill;
        if total > 0.0 {
            hits.push(Hit {
                score: total,
                row: p,
                skills: matched,
            });
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    if hits.is_empty() {
        let slugs: Vec<&str> = rows
            .iter()
            .filter_map(|p| p["slug"].as_str())
            .collect();
        return Err(format!(
            "no plugin matches {query:?} — no skill does either. Enabled plugins: {}",
            slugs.join(", ")
        ));
    }
    let mut out = format!(
        "Plugins matching {query:?} — load the owning plugin with `slug=<slug>`; add \
         `skill=<name>` to read only that one skill from inside it:\n"
    );
    for hit in hits.iter().take(PLUGIN_SEARCH_MAX) {
        let slug = hit.row["slug"].as_str().unwrap_or_default();
        out.push_str(&plugin_line(hit.row));
        out.push('\n');
        for (_, s) in hit.skills.iter().take(SEARCH_SKILL_ROWS) {
            let name = s["name"].as_str().unwrap_or_default().trim();
            let desc = s["description"].as_str().unwrap_or_default().trim();
            let desc = if desc.is_empty() {
                String::new()
            } else {
                format!(" — {}", clip_search_desc(desc, SEARCH_SKILL_DESC_CHARS))
            };
            out.push_str(&format!(
                "  matched skill {name}: {name}{desc} (load_plugin slug={slug} skill={name})\n"
            ));
        }
    }
    Ok(out)
}

/// One plugin row for a search hit. Skill names are capped: a hit on a 82-skill
/// pack must not re-dump the whole index, and the matched-skill rows below name
/// the exact bodies the query found.
fn plugin_line(p: &Value) -> String {
    let slug = p["slug"].as_str().unwrap_or_default();
    let name = p["name"].as_str().unwrap_or_default();
    let description = p["description"].as_str().unwrap_or_default().trim();
    let skills: Vec<&str> = p["skills"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut out = format!("- {slug} ({name})");
    if !description.is_empty() {
        out.push_str(": ");
        out.push_str(description);
    }
    if !skills.is_empty() {
        let shown: Vec<&str> = skills.iter().take(12).copied().collect();
        let more = skills.len().saturating_sub(shown.len());
        out.push_str(&format!(
            " [skills: {}{}]",
            shown.join(", "),
            if more > 0 {
                format!(" +{more} more")
            } else {
                String::new()
            }
        ));
    }
    out
}

fn clip_search_desc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    match cut.rfind(' ') {
        Some(i) if i > 0 => format!("{}…", cut[..i].trim_end()),
        _ => format!("{cut}…"),
    }
}

const PLUGIN_SEARCH_MAX: usize = 8;

/// How many matching skills one search hit lists, and how much of each
/// description is shown. The plugin row names the slug; these rows name the
/// exact `skill=` to load, so a hidden skill (one whose name is beyond a big
/// bundle's catalog tail) is still reachable.
const SEARCH_SKILL_ROWS: usize = 4;
const SEARCH_SKILL_DESC_CHARS: usize = 180;

/// Function words that say nothing about WHICH plugin applies.
const PLUGIN_STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "from", "with",
    "without", "by", "as", "is", "are", "be", "been", "was", "were", "am", "do", "does",
    "did", "how", "what", "when", "where", "which", "who", "why", "i", "you", "my", "your",
    "me", "it", "its", "this", "that", "these", "those", "there", "here", "can", "could",
    "should", "would", "will", "shall", "may", "might", "must", "have", "has", "had", "not",
    "no", "yes", "if", "then", "than", "so", "such", "own", "same", "also", "just", "about",
    "into", "over", "under", "up", "down", "out", "off", "again", "once", "all", "any",
    "both", "each", "few", "more", "most", "other", "some", "only", "very", "get", "let",
    "us", "we", "he", "she", "they", "them", "their", "his", "her", "him",
    "در", "به", "از", "که", "را", "با", "این", "برای", "است", "هست", "می",
    "تا", "هم", "یا", "یک", "های", "شود", "کند", "باید", "روی",
];

/// The trailing reminder for the plugin the user attached (`/slug`): the whole
/// toolbox is already in the prompt, so the model must not reload its skills.
pub fn active_plugin_note(root: &Path, slugs: &[String]) -> String {
    let enabled: std::collections::HashSet<String> = enabled_plugins(root)
        .into_iter()
        .map(|(slug, _)| slug)
        .collect();
    let mut lines: Vec<String> = Vec::new();
    for slug in slugs {
        if !enabled.contains(slug.as_str()) {
            continue;
        }
        let manifest = manifest_of(root, slug);
        let label = manifest["name"].as_str().unwrap_or(slug);
        let skills = bundle_skill_names(root, std::slice::from_ref(slug));
        // A bundle can be a LIBRARY (82 skills in the trading pack). The note
        // is re-sent on every round, so it names the first handful plus a count
        // instead of the whole inventory — the full list already rides in the
        // skill section (and a large bundle indexes it by path there).
        let shown_skills = if skills.is_empty() {
            "(none)".to_string()
        } else {
            let mut shown = skills.iter().take(12).cloned().collect::<Vec<_>>().join(", ");
            if skills.len() > 12 {
                shown.push_str(&format!(" (+{} more)", skills.len() - 12));
            }
            shown
        };
        let connectors = read_connectors(root, slug);
        lines.push(format!(
            "- {slug} ({label}): ONE toolbox already loaded. Skills: {shown_skills}. \
             Connectors: {}. \
             Do NOT call load_plugin for it again; use what is already attached.",
            if connectors.is_empty() {
                "none".to_string()
            } else {
                connectors.keys().cloned().collect::<Vec<_>>().join(", ")
            }
        ));
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n=== ACTIVE PLUGIN (one unit, already loaded) ===\n\
             The user attached this plugin to the turn. Everything inside it — every skill \
             body and every connector tool — is already available. Treat it as one toolbox. \
             If its workflow needs more than one step, call update_plan BEFORE the first action \
             with the complete checklist in the user's language, then keep it current:\n{}",
            lines.join("\n")
        )
    }
}
