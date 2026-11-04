//! Native skill selection: the available-skills catalog + the SKILLS prompt section.
//!
//! Mirrors how Codex and Claude expose skills: the system prompt carries a
//! compact catalog (name + description) of every installed skill, and the model
//! loads the body of the ones it needs through the `load_skill` tool. Nothing is
//! embedded, indexed or classified up front, so a turn costs no local inference
//! and no extra model call — only the skills the user attached (`@mention`) are
//! inlined whole.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::skills;

/// Bodies longer than this are not inlined: the description plus a `load_skill`
/// pointer is emitted instead, so one huge skill cannot flood the prompt.
pub const AUTO_MAX_BODY_CHARS: usize = 16_000;

/// Catalog lines are capped so a huge store cannot flood the system prompt.
///
/// `build_section` now takes the cap as an argument (Settings → Skills exposes
/// it), so this constant is the default every caller falls back to.
const CATALOG_MAX_CHARS: usize = 6_000;

/// Public default for the catalog cap, in BYTES of system prompt per turn.
pub const CATALOG_MAX_DEFAULT: usize = CATALOG_MAX_CHARS;

/// Floor for a user-chosen cap: below this the catalog cannot even list the
/// names, which is the one thing this budget must always pay for.
pub const CATALOG_MAX_MIN: usize = 1_500;

/// Ceiling for a user-chosen cap: 3k tokens of catalog on EVERY step of every
/// turn is already a lot to re-send, so a typo cannot multiply it further.
pub const CATALOG_MAX_LIMIT: usize = 12_000;

/// Result of building the SKILLS section for one turn.
pub struct SkillSection {
    /// The catalog plus the skills the user attached with an `@mention`. Goes
    /// into the system prompt, which every request re-sends.
    pub text: String,
    /// Attached names that no longer exist in the store.
    pub missing: Vec<String>,
}

/// One inlined skill (the ones the user attached with `@mention`).
///
/// A body past `AUTO_MAX_BODY_CHARS` is NOT inlined: the description plus a
/// `load_skill` pointer is emitted instead, so one huge skill cannot flood the
/// prompt.
fn format_skill_body(s: &Value) -> String {
    let name = s["name"].as_str().unwrap_or_default();
    let description = s["description"].as_str().unwrap_or_default();
    let files: Vec<&str> = s["files"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(str::trim).filter(|f| !f.is_empty()).collect())
        .unwrap_or_default();
    let extra = if files.is_empty() {
        String::new()
    } else {
        format!(
            "\nExtra files: {} — call load_skill with file=<name> only when needed.",
            files.join(", ")
        )
    };
    let content = s["content"].as_str().unwrap_or_default();
    if content.chars().count() > AUTO_MAX_BODY_CHARS {
        return format!(
            "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n\
             This skill's body is long and was NOT inlined. Call load_skill with \
             name={name} before following it.\n===== END SKILL: {name} ====="
        );
    }
    format!(
        "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n{content}\n===== END SKILL: {name} ====="
    )
}

/// `- name: description` line per installed skill, capped so a huge store
/// cannot flood the system prompt.
///
/// The description is the trigger: WHICH skill applies is the model's call made
/// from this line alone, so the line carries nothing the model cannot match a
/// request against.
///
/// Bytes reserved so the "list truncated" note always fits inside the cap.
const CATALOG_TRUNCATE_NOTE_RESERVE: usize = 160;

/// Longest description one catalog line keeps.
const CATALOG_DESC_MAX_CHARS: usize = 120;

/// Ceiling on the description part of a single line, so one verbose skill
/// cannot eat the room every other skill needs.
const CATALOG_DETAIL_PER_ROW: usize = 180;

/// Clip to `max` CHARACTERS on a word boundary (byte slicing would panic on the
/// Persian keywords, which are multi-byte).
fn clip_words(s: &str, max: usize) -> String {
    let s = s.trim();
    if max == 0 {
        return String::new();
    }
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    match cut.rfind(' ') {
        Some(i) if i > 0 => format!("{}…", cut[..i].trim_end()),
        _ => format!("{cut}…"),
    }
}

/// The `: description` tail of one catalog line, fitted into `room` bytes. The
/// DESCRIPTION absorbs the clipping.
fn catalog_detail(desc: &str, room: usize) -> String {
    let mut out = String::new();
    if !desc.is_empty() && room > 4 {
        let clip = (room - 2).min(CATALOG_DESC_MAX_CHARS);
        let clipped = clip_words(desc, clip);
        if !clipped.is_empty() {
            out.push_str(": ");
            out.push_str(&clipped);
        }
    }
    out
}

/// `- name: description` line per installed skill: everything the
/// model gets up front, and nothing more.
///
/// This line IS the trigger for `load_skill`. The model matches the request
/// against the description itself — the same way Claude and Codex expose
/// skills — so the line carries the description, not a keyword list.
///
/// Test-only: production goes through `catalog_at` with the user's configured
/// budget, so this fixed-cap wrapper exists to keep the assertions readable.
#[cfg(test)]
fn catalog(all: &[Value]) -> String {
    catalog_at(all, CATALOG_MAX_CHARS)
}

/// `catalog` with an explicit byte budget (the value Settings → Skills edits).
///
/// The catalog is a LADDER: the richest representation that fits the budget
/// wins, and the model is always told how to reach what the rung had to give
/// up. Every rung represents every non-empty bundle and keeps every skill
/// reachable — by name at the top rungs, through `load_skill bundle=<slug>`
/// plus `query=<words>` at the lower ones.
fn catalog_at(all: &[Value], max: usize) -> String {
    // Group by bundle ONCE. Bundles sort by slug, skills by name — byte-stable
    // output regardless of read_dir order, map iteration or timing.
    let mut bundles: Vec<(String, String, Vec<&Value>)> = Vec::new();
    for s in all {
        if s["name"].as_str().unwrap_or_default().trim().is_empty() {
            continue;
        }
        let slug = s["plugin_slug"].as_str().unwrap_or_default().trim().to_string();
        let label = s["plugin"].as_str().unwrap_or_default().trim().to_string();
        match bundles.iter_mut().find(|(bs, _, _)| *bs == slug) {
            Some((_, _, rows)) => rows.push(s),
            None => bundles.push((slug, label, vec![s])),
        }
    }
    for (_, _, rows) in bundles.iter_mut() {
        rows.sort_by(|a, b| {
            let an = a["name"].as_str().unwrap_or_default();
            let bn = b["name"].as_str().unwrap_or_default();
            an.cmp(bn).then_with(|| {
                a["slug"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(b["slug"].as_str().unwrap_or_default())
            })
        });
    }
    bundles.sort_by(|a, b| a.0.cmp(&b.0));

    // Richest COMPLETE rung that fits. A rung that had to drop a name does
    // not "fit" — hiding entries is what the ladder exists to avoid, so an
    // overflowing rung moves DOWN a level, where every entry is a whole line
    // that fits. Index is the floor: bare bundle lines, and only if even they
    // overflow does its emit-until-full with the dropped-count note apply.
    for rung in [Rung::Full, Rung::Hybrid, Rung::Bundles, Rung::Compact] {
        let (text, complete) = render_rung(rung, &bundles, max);
        if complete && text.len() + CATALOG_TRUNCATE_NOTE_RESERVE <= max {
            return text;
        }
    }
    render_rung(Rung::Index, &bundles, max).0
}

/// One rung of the catalog ladder.
#[derive(Clone, Copy, PartialEq)]
enum Rung {
    /// `- name: full description` per skill.
    Full,
    /// Names for every skill, the leftover budget split evenly over the
    /// descriptions (the pre-ladder shape).
    Hybrid,
    /// One line per bundle: label, command, skill count, the skill NAMES.
    Bundles,
    /// One line per bundle: label, command, count, the BUNDLE's description.
    Compact,
    /// One bare line per bundle: slug and count.
    Index,
}

/// The per-skill `- name: description` line, shared by the Full and Hybrid
/// rungs (`hybrid_per_row = 0` gives the Full form: the whole description).
/// Returns (text, complete) — complete means every skill got its line.
fn skill_rows(
    bundles: &[(String, String, Vec<&Value>)],
    hybrid_per_row: Option<usize>,
    max: usize,
) -> (String, bool) {
    let mut rows: Vec<(&str, &str, Option<String>)> = Vec::new();
    for (_, _, skills) in bundles {
        for s in skills.iter() {
            let name = s["name"].as_str().unwrap_or_default().trim();
            let desc = s["description"].as_str().unwrap_or_default().trim();
            // A skill that ships inside a plugin is invocable as
            // `/<plugin-slug> <skill-slug>` in the composer: the command names
            // the BUNDLE, so a 26-skill library is one palette row instead of
            // 26 that bury every real command.
            let command = s["plugin"].as_str().and_then(|_| {
                let plugin_slug = s["plugin_slug"].as_str().unwrap_or_default().trim();
                let slug = s["slug"].as_str().unwrap_or_default().trim();
                if plugin_slug.is_empty() {
                    None
                } else if slug.is_empty() {
                    Some(plugin_slug.to_string())
                } else {
                    Some(format!("{plugin_slug} {slug}"))
                }
            });
            rows.push((name, desc, command));
        }
    }
    let heads: Vec<String> = rows
        .iter()
        .map(|(name, _, command)| match command {
            // A plugin skill is invocable as `/<slug>` in the composer, so its
            // line names the command: a bundle whose install output says "try
            // /ponytail" left the model unable to explain how to run it, and
            // the user got "Unknown command".
            Some(cmd) => format!("- {name} (command: /{cmd})"),
            None => format!("- {name}"),
        })
        .collect();
    let per_row = match hybrid_per_row {
        // Full: the description is capped only by its own clip.
        None => CATALOG_DETAIL_PER_ROW,
        // Hybrid: the bare name of EVERY skill is paid for first, and the
        // leftover room is then split evenly. A catalog that silently dropped
        // the tail made the last installed skills unreachable: with 25
        // installed skills their full-length descriptions overflowed the cap
        // and three of them disappeared from the list — the model never
        // learned they existed, so `load_skill` was never called for them.
        // Detail is what gets sacrificed, never the entry itself.
        Some(budget) => {
            let bare: usize = heads.iter().map(|h| h.len() + 1).sum();
            let room = budget.saturating_sub(bare + CATALOG_TRUNCATE_NOTE_RESERVE);
            if rows.is_empty() {
                0
            } else {
                (room / rows.len()).min(CATALOG_DETAIL_PER_ROW)
            }
        }
    };

    let mut lines: Vec<String> = Vec::with_capacity(rows.len());
    let mut detail_clipped = false;
    for (i, (_name, desc, _)) in rows.iter().enumerate() {
        let head = &heads[i];
        // The untrimmed detail (description up to its own cap) — comparing it to
        // the row's even share is what separates a store that fits from one
        // whose details had to be sacrificed.
        let natural = catalog_detail(desc, CATALOG_DETAIL_PER_ROW);
        let detail = if natural.len() <= per_row {
            natural
        } else {
            detail_clipped = true;
            catalog_detail(desc, per_row)
        };
        lines.push(format!("{head}{detail}"));
    }

    let mut out = String::new();
    let mut dropped = 0usize;
    for line in &lines {
        // Names are paid for first (see `per_row` above), so by construction a
        // name alone always fits: this is a safety net, not the normal path.
        if out.len() + line.len() + 1 + CATALOG_TRUNCATE_NOTE_RESERVE > max {
            dropped = lines.len() - out.lines().count();
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    // Say so instead of silently ending the list, AND say how to reach what was
    // left out: a store with hundreds of skills always overflows this cap, and a
    // bare count would leave the model no way to find the ones it cannot see.
    // (`load_skill query=` searches every installed skill without adding a byte
    // to the prompt, which is the whole point of the capped catalog.)
    if dropped > 0 || detail_clipped {
        // Both notes must stay under CATALOG_TRUNCATE_NOTE_RESERVE bytes: that
        // reserve is what the emit loop above holds back for them.
        let note = if dropped > 0 {
            format!(
                "- …({dropped} more skill(s) are installed than fit here — call \
                 load_skill with query=<words> to search all of them)\n"
            )
        } else {
            "- …(descriptions are trimmed to fit; call load_skill with the name \
             for a skill's full instructions)\n"
                .to_string()
        };
        out.push_str(&note);
    }
    (out, dropped == 0)
}

/// Render one rung: the skill-line rungs (Full/Hybrid) or the bundle rungs.
fn render_rung(
    rung: Rung,
    bundles: &[(String, String, Vec<&Value>)],
    max: usize,
) -> (String, bool) {
    match rung {
        Rung::Full => skill_rows(bundles, None, max),
        Rung::Hybrid => skill_rows(bundles, Some(max), max),
        Rung::Bundles | Rung::Compact | Rung::Index => bundle_lines(rung, bundles, max),
    }
}

/// The bundle-shaped rungs: one line per NON-EMPTY bundle, every bundle
/// present as a whole line (the fit-check in `catalog_at` moves down a rung
/// rather than truncating a line mid-list — a half-listed bundle line would
/// hide its skills exactly like the old dropped tail did).
/// Returns (text, complete) — complete means every bundle got its whole line
/// (and any bundle-less rows kept every name).
fn bundle_lines(rung: Rung, bundles: &[(String, String, Vec<&Value>)], max: usize) -> (String, bool) {
    let cap = max;
    let mut complete = true;
    let mut out = String::new();
    // Skills with no bundle keep their PER-SKILL lines at the bundle rungs:
    // a bundle-less store (only tests still build one) degenerates to the
    // hybrid shape, which is the richest per-skill form that still fits —
    // collapsing 500 bundle-less skills into one pseudo-bundle line would
    // hide every name behind a clip.
    if let Some((_, _, rows)) = bundles.iter().find(|(slug, _, _)| slug.is_empty()) {
        let group = [(String::new(), String::new(), rows.clone())];
        let (text, all_listed) = skill_rows(&group, Some(max), max);
        out.push_str(&text);
        complete = all_listed;
    }
    let mut note: Option<&str> = None;
    for (slug, label, skills) in bundles.iter().filter(|(slug, _, _)| !slug.is_empty()) {
        let (slug, label, skills) = (slug.as_str(), label.as_str(), skills);
        let count = skills.len();
        let command = if slug.is_empty() {
            String::new()
        } else {
            format!(" (command: /{slug})")
        };
        let line = match rung {
            // The names ride the bundle line, clipped to the line budget the
            // WHOLE list still affords — every bundle keeps its line.
            Rung::Bundles => {
                let names: Vec<&str> = skills
                    .iter()
                    .map(|s| s["name"].as_str().unwrap_or_default().trim())
                    .filter(|n| !n.is_empty())
                    .collect();
                let joined = names.join(", ");
                let head = format!("- {label}{command} — {count} skill(s): ");
                let room = cap
                    .saturating_sub(out.len() + CATALOG_TRUNCATE_NOTE_RESERVE + head.len() + 1);
                let clipped = clip_words(&joined, room);
                let rest = if clipped.len() < joined.len() { " …" } else { "" };
                format!("{head}{clipped}{rest}\n")
            }
            Rung::Compact => {
                // The bundle's OWN description says what the group is for —
                // the one line a lower cap can still afford per bundle.
                let desc = skills
                    .first()
                    .map(|s| s["plugin_description"].as_str().unwrap_or_default().trim())
                    .unwrap_or_default();
                let head = format!("- {label}{command} — {count} skill(s): ");
                let room = cap
                    .saturating_sub(out.len() + CATALOG_TRUNCATE_NOTE_RESERVE + head.len() + 1);
                format!("{head}{}\n", clip_words(desc, room))
            }
            Rung::Index => format!("- {slug} ({count} skills)\n"),
            _ => unreachable!("skill rungs handled above"),
        };
        if out.len() + line.len() + CATALOG_TRUNCATE_NOTE_RESERVE > cap {
            complete = false;
            note = Some(match rung {
                Rung::Bundles => "- …(more bundles are installed than fit here — load_skill \
with bundle=<slug> lists one, query=<words> searches all)\n",
                Rung::Compact => "- …(more bundles are installed than fit here — load_skill \
with bundle=<slug> lists one, query=<words> searches all)\n",
                _ => "- …(more bundles are installed than fit here — load_skill with \
bundle=<slug> lists one)\n",
            });
            break;
        }
        out.push_str(&line);
    }
    // The per-rung how-to-reach note: names are only HALF listed here, so the
    // model needs the drill-in spelled out.
    let has_real = bundles.iter().any(|(slug, _, _)| !slug.is_empty());
    if let Some(note) = note {
        out.push_str(note);
    } else if !has_real {
        // Bundle-less rows only: their own note (emitted above) already says
        // how to reach what was left out.
    } else if rung != Rung::Index {
        out.push_str(
            "- …(skill names are grouped by bundle — load_skill with bundle=<slug> lists one \
bundle's skills; query=<words> searches every installed skill)\n",
        );
    } else {
        out.push_str(
            "- …(load_skill with bundle=<slug> lists a bundle's skills; load_skill with \
query=<words> searches every installed skill)\n",
        );
    }
    (out, complete)
}

/// Load the skill store for a workspace root: the standalone `<root>/skills`
/// folder plus every ENABLED plugin's skills.
///
/// The standalone store is read first on purpose — a plugin must never shadow a
/// skill the user saved directly, and a disabled plugin contributes nothing,
/// which is how switching a plugin off removes its skills from the catalog.
/// How many roots (data roots) `load_skills` keeps cached at once. A process
/// normally has one, so the bound is only a safety net against a root that
/// changes on every call (e.g. a caller passing a new temp dir each time).
const SKILLS_CACHE_MAX: usize = 8;

/// Change-detector for the two on-disk stores the catalog reads: every path
/// under `<root>/skills` and `<root>/plugins` folded in as (path, mtime, size).
///
/// No file CONTENT is read, so a turn stops re-reading and re-parsing every
/// `skill.md` — the cost that made a large store cost ~100 ms per turn. It is a
/// filesystem signature rather than an invalidation hook on purpose: a skill
/// written straight to disk (the app's own writer, a test, or the user's editor)
/// still invalidates, which a mutation-hook cache would miss.
fn store_signature(root: &str) -> u64 {
    tree_stamp(&std::path::Path::new(root).join("plugins"), 0)
}

/// Order-independent stamp of one directory tree: the sum of every entry's
/// (name, mtime, size) hash, so a rename, an edit, an add and a remove all
/// change the result. Summing avoids collecting and sorting the tree, which
/// made the stamp cost as much as the parse it is meant to save.
fn tree_stamp(dir: &std::path::Path, depth: u8) -> u64 {
    use std::hash::{Hash, Hasher};
    // `<root>/plugins/<slug>/skills/<name>/skill.md` is depth 4; anything
    // deeper is not part of the catalog and must not cost a walk.
    if depth > 6 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut acc: u64 = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        entry.file_name().hash(&mut hasher);
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        mtime.hash(&mut hasher);
        meta.len().hash(&mut hasher);
        let mut stamp = hasher.finish();
        if meta.is_dir() {
            stamp ^= tree_stamp(&entry.path(), depth + 1).rotate_left(29);
        }
        acc = acc.wrapping_add(stamp);
    }
    acc
}

/// Per-root cache of `load_skills`, validated by `store_signature`.
fn skills_cache() -> &'static Mutex<HashMap<String, (u64, Vec<Value>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, Vec<Value>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every skill the prompt may offer: the skills of every ENABLED plugin.
///
/// A plugin bundle is the only container a skill can live in, so the "standalone
/// store" half of this read is gone — one source means the Settings list, the
/// prompt catalog and the `@` picker can never disagree about what exists.
fn read_skills_from_disk(root: &str) -> Vec<Value> {
    crate::plugins::enabled_plugin_skills(std::path::Path::new(root))
}

/// Resolve a typed `/name …` against the ENABLED bundles' slash commands.
///
/// Returns the command body with the argument placeholders already substituted
/// (`$ARGUMENTS`, `$1`..`$9`) — ready to be sent as the turn's prompt — plus the
/// command's own name for the trace and the UI banner. `None` when no enabled
/// bundle ships that command, so a built-in `/compact` is never shadowed by an
/// absent one.
///
/// The command name is the FILE STEM (see `plugins::list_commands`): that is what
/// the palette offers and what the user typed, so looking it up by frontmatter
/// `name` would miss every command whose display label differs from its word.
pub fn expand_slash_command(prompt: &str, root: &str) -> Option<(String, String)> {
    let raw = prompt.trim_start();
    let rest = raw.strip_prefix('/')?;
    // One token: the command word. Everything after it is its arguments. The
    // TYPED word is kept for the split — `to_lowercase` can change a string's
    // byte length on some scripts, and slicing a multi-byte word by the folded
    // length would cut into the arguments (or panic).
    let typed = rest.split_whitespace().next()?;
    if typed.is_empty() {
        return None;
    }
    let name = typed.to_lowercase();
    let args = rest[typed.len()..].trim().to_string();
    let row = crate::plugins::enabled_plugin_commands(std::path::Path::new(root))
        .into_iter()
        .find(|c| {
            c["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(&name))
        })?;
    let body = row["content"].as_str().unwrap_or_default();
    // `trim_end` only: a command file is stored with a trailing newline, which
    // would otherwise ride into the prompt as a dangling blank line. Leading
    // whitespace is left alone so an indented body keeps its shape.
    Some((
        skills::expand_command_args(body, &args).trim_end().to_string(),
        row["name"].as_str().unwrap_or(&name).to_string(),
    ))
}

pub fn load_skills(root: &str) -> Vec<Value> {
    let signature = store_signature(root);
    if let Some(rows) = skills_cache()
        .lock()
        .ok()
        .and_then(|c| c.get(root).filter(|(sig, _)| *sig == signature).map(|(_, r)| r.clone()))
    {
        return rows;
    }
    let all = read_skills_from_disk(root);
    if let Ok(mut c) = skills_cache().lock() {
        if c.len() >= SKILLS_CACHE_MAX && !c.contains_key(root) {
            // Any eviction is fine: a miss simply re-reads the store.
            if let Some(k) = c.keys().next().cloned() {
                c.remove(&k);
            }
        }
        c.insert(root.to_string(), (signature, all.clone()));
    }
    all
}

/// The catalog budget the user configured, in bytes.
///
/// The value lives in `settings.json` — the same file a headless scheduled run
/// reads — so both paths agree on one number. Anything missing, unreadable or
/// out of range falls back to the default: a broken settings file must never
/// ship an empty catalog, which is the one failure that hides every skill.
fn configured_catalog_max(root: &str) -> usize {
    std::fs::read_to_string(std::path::Path::new(root).join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v["skillCatalogMaxChars"].as_u64())
        .map(|n| (n as usize).clamp(CATALOG_MAX_MIN, CATALOG_MAX_LIMIT))
        .unwrap_or(CATALOG_MAX_DEFAULT)
}

/// Build the SKILLS section for one turn: the catalog of installed skills plus
/// the bodies of the ones the user attached with an `@mention`.
///
/// The catalog is what makes on-demand loading possible — without it the model
/// has no way to know a skill exists. WHICH skill applies is entirely the
/// model's call (`load_skill`), the way Codex and Claude do it.
pub fn build_section(root: &str, manual_names: &[String]) -> SkillSection {
    build_section_with_cap(root, manual_names, configured_catalog_max(root))
}

/// `build_section` with an explicit catalog budget and the resolved setting.
pub fn build_section_with_cap(root: &str, manual_names: &[String], catalog_max: usize) -> SkillSection {
    let all = load_skills(root);
    let mut text = String::new();

    let listed = catalog_at(&all, catalog_max);
    if !listed.is_empty() {
        text.push_str(
            "\n\n=== AVAILABLE SKILLS ===\n\
             These skills are installed. This list is a TRIGGER, not a summary: if \
             the request falls under one of them, call load_skill with that skill's \
             name BEFORE doing the work and follow its instructions for the rest of \
             the turn. Match on the description — a request written in another \
             language still matches an English description when it names the same \
             task. Do not load a skill you do not need — but a task a skill covers \
             must not be answered from memory.\n\
             This list is CAPPED: a large store does not fit here. An absent entry \
             does NOT mean the skill is missing — call load_skill with a `query` of \
             the task's words to search every installed skill.\n",
        );
        text.push_str(&listed);
        // The duty is restated AFTER the list. A long catalog pushes the opening
        // instruction thousands of characters away from the model's attention, and
        // weak models then read the list as reference material and never call the
        // tool: real traces showed 2 `load_skill` calls across ~250 steps with an
        // 11 KB catalog in the prompt. The list itself is unchanged, so the
        // cached prefix does not move.
        text.push_str(
            "If one of the skills above covers this request, call load_skill for it \
             NOW — before any other tool call.\n",
        );
    }

    let mut manual: Vec<String> = Vec::new();
    for n in manual_names {
        let n = n.trim().to_lowercase();
        if !n.is_empty() && !manual.contains(&n) {
            manual.push(n);
        }
    }
    let mut missing: Vec<String> = Vec::new();
    let mut picked: Vec<&Value> = Vec::new();
    for n in &manual {
        let hit = all.iter().find(|s| {
            s["name"].as_str().unwrap_or_default().trim().to_lowercase() == *n
        });
        match hit {
            Some(s) => {
                if !picked.iter().any(|p| p["name"] == s["name"]) {
                    picked.push(s);
                }
            }
            None => missing.push(n.clone()),
        }
    }
    // WHICH skill applies is entirely the model's call: the catalog above is
    // the trigger and `load_skill` is the pick, the way Claude and Codex do it.
    // A manual `@mention` still inlines a skill's body without a tool call.
    if !picked.is_empty() {
        text.push_str(
            "\n\n=== ATTACHED SKILLS ===\n\
             The user attached these skills to this turn — follow their \
             instructions and do NOT call load_skill for them.\n",
        );
        text.push_str(
            &picked
                .iter()
                .map(|s| format_skill_body(s))
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
    }

    SkillSection { text, missing }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn skill(name: &str, description: &str) -> Value {
        json!({
            "name": name,
            "slug": name.to_lowercase().replace(' ', "-"),
            "description": description,
            "content": format!("body of {name}"),
            "files": [],
        })
    }

    /// One single-skill bundle on disk — the only shape a skill has now.
    ///
    /// A skill can no longer sit in a store of its own, so a test that wants one
    /// installed has to write the bundle that carries it.
    fn write_bundle(root: &std::path::Path, name: &str, description: &str, fa: &str, body: &str) {
        let slug = name.to_lowercase().replace(' ', "-");
        let bundle = root.join("plugins").join(&slug);
        std::fs::create_dir_all(bundle.join("skills").join(&slug)).unwrap();
        std::fs::write(
            bundle.join("plugin.json"),
            json!({ "name": name, "slug": slug, "enabled": true }).to_string(),
        )
        .unwrap();
        let mut md = format!("---\nname: {name}\ndescription: {description}\n");
        if !fa.is_empty() {
            md.push_str(&format!("fa_keywords: {fa}\n"));
        }
        md.push_str(&format!("---\n{body}\n"));
        std::fs::write(bundle.join("skills").join(&slug).join("skill.md"), md).unwrap();
    }

    #[test]
    fn catalog_splits_persian_comma_keywords() {
        // Keywords no longer ride in the catalog at all — the description is
        // the one trigger the model matches on. A skill whose frontmatter
        // still carries a keyword list must not leak it into the line.
        let dir = std::env::temp_dir().join(format!("codifa-skill-fa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم، سریال, سینما", "BODY");
        let root = dir.to_str().unwrap();

        let listed = catalog(&load_skills(root));
        assert!(listed.contains("find movies"), "{listed}");
        assert!(!listed.contains("[fa:"), "{listed}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_persian_prompt_no_longer_attaches_a_skill_on_its_own() {
        // Selection is the model's call, made from the catalog: the keyword
        // auto-attach is gone, so a prompt that carries a skill's keyword must
        // NOT inline the body — the model reaches it through load_skill. An
        // explicit @mention still attaches.
        let dir =
            std::env::temp_dir().join(format!("codifa-skill-nomatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم, سینما", "BODY");
        let root = dir.to_str().unwrap();

        // The user's phrase in the request stays body-free — the catalog is
        // there, the model decides.
        let section = build_section(root, &[]);
        assert!(section.text.contains("- Movie Finder"), "{}", section.text);
        assert!(!section.text.contains("BODY"), "{}", section.text);

        // An explicit @mention keeps working on its own.
        let attached = build_section(root, &["Movie Finder".into()]);
        assert!(attached.text.contains("BODY"), "{}", attached.text);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_custom_catalog_cap_is_honoured() {
        // Settings → Skills can raise the cap, so the budget must actually be
        // the argument — and a raised cap must fit MORE names, not the same.
        let all: Vec<Value> = (0..80)
            .map(|i| skill(&format!("Skill {i}"), "a description long enough to fill the cap"))
            .collect();
        let small = catalog_at(&all, CATALOG_MAX_MIN);
        let big = catalog_at(&all, CATALOG_MAX_LIMIT);
        assert!(small.len() <= CATALOG_MAX_MIN, "{} bytes", small.len());
        assert!(big.len() <= CATALOG_MAX_LIMIT, "{} bytes", big.len());
        assert!(big.len() > small.len(), "raising the cap must list more");
        assert!(big.contains("- Skill 79"), "the tail must survive a bigger cap");
    }

    #[test]
    fn catalog_names_the_bundle_command_not_one_per_skill() {
        // The palette offers ONE command per plugin (`/<plugin> <skill>`), and
        // the catalog has to teach the model the same shape: a library of 26
        // skills must not read as 26 top-level commands.
        let rows = vec![
            json!({
                "name": "Ponytail",
                "slug": "ponytail",
                "description": "lazy senior dev",
                "plugin": "Ponytail",
                "plugin_slug": "ponytail",
            }),
            json!({
                "name": "Ponytail Audit",
                "slug": "ponytail-audit",
                "description": "repo audit",
                "plugin": "Ponytail",
                "plugin_slug": "ponytail",
            }),
            json!({"name": "Movie Finder", "description": "find movies"}),
        ];
        let listed = catalog(&rows);
        assert!(
            listed.contains("- Ponytail (command: /ponytail ponytail)"),
            "{listed}"
        );
        // The skill's own slug is the SECOND word, never a command of its own.
        assert!(!listed.contains("/ponytail-audit"), "{listed}");
        // A standalone skill has no command at all.
        assert!(listed.contains("- Movie Finder: find movies"), "{listed}");
    }

    #[test]
    fn catalog_lists_names_and_descriptions() {
        let all = vec![skill("Movie Finder", "find movies")];
        let listed = catalog(&all);
        assert!(listed.contains("Movie Finder: find movies"), "{listed}");
        // A skill without a description still gets a line.
        let bare = vec![json!({ "name": "Bare" })];
        assert!(catalog(&bare).contains("- Bare"));
    }

    #[test]
    fn catalog_keeps_every_skill_even_when_the_details_overflow() {
        // Regression: 25 installed skills with their real-length descriptions
        // overflowed the cap, and the loop `break`-ed — the three last skills
        // (summarization, threejs-scroll-storytelling, translation) vanished from
        // the catalog entirely, so the model never knew they existed and could
        // never call load_skill for them. Detail may be clipped; an entry may not.
        let all: Vec<Value> = (0..60)
            .map(|i| {
                json!({
                    "name": format!("Skill {i}"),
                    "description": "a long english description that would overflow the catalog cap on its own \
                                    when sixty of them are listed one after another in the system prompt",
                })
            })
            .collect();
        let listed = catalog(&all);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        for i in 0..60 {
            assert!(listed.contains(&format!("- Skill {i}")), "Skill {i} missing:\n{listed}");
        }
    }

    #[test]
    fn catalog_caps_the_listing() {
        let all: Vec<Value> = (0..500)
            .map(|i| skill(&format!("Skill {i}"), "a description long enough to fill the cap"))
            .collect();
        assert!(catalog(&all).len() <= CATALOG_MAX_CHARS);
    }

    #[test]
    fn catalog_lists_short_named_skills_way_past_the_detail_cap() {
        // A realistic overflowing store: short names, long descriptions. Every
        // skill must still be NAMED (the model learns it exists), only the
        // details are trimmed, and the model is told so.
        let all: Vec<Value> = (0..500)
            .map(|i| {
                json!({
                    "name": format!("Sk{i}"),
                    "description": "a fairly long english description that would overflow the \
                                    catalog cap on its own when five hundred of them are listed \
                                    one after another in the system prompt of a real turn",
                    "fa_keywords": ["یک", "دو", "سه"],
                })
            })
            .collect();
        let listed = catalog(&all);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        let names: Vec<&str> = listed
            .lines()
            .filter_map(|l| l.strip_prefix("- "))
            .map(|l| l.split([':', ' ']).next().unwrap_or(""))
            .collect();
        for i in 0..500 {
            assert!(
                names.contains(&format!("Sk{i}").as_str()),
                "Sk{i} missing:\n{listed}"
            );
        }
        assert!(listed.contains("descriptions are trimmed"), "{listed}");
    }

    #[test]
    fn load_skills_sees_a_skill_written_after_the_first_read() {
        // The cache must not hide a skill the store gains between turns: a
        // create/seed/edit writes to disk, which has to invalidate.
        let dir = std::env::temp_dir().join(format!("codifa-skill-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        assert!(load_skills(root).is_empty());
        write_bundle(&dir, "Movie Finder", "find movies", "", "BODY");
        let after = load_skills(root);
        assert_eq!(after.len(), 1, "{after:?}");
        assert_eq!(after[0]["name"], "Movie Finder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_skill_body_caps_long_bodies() {
        // A body past the cap is not inlined — the model is pointed at
        // load_skill instead, so one huge skill cannot flood the prompt.
        let long = json!({
            "name": "Huge Skill",
            "description": "big",
            "content": "x".repeat(AUTO_MAX_BODY_CHARS + 1),
            "files": [],
        });
        let out = format_skill_body(&long);
        assert!(!out.contains(&"x".repeat(100)), "long body was inlined");
        assert!(out.contains("load_skill"), "{out}");
        // A body under the cap is inlined whole.
        let short = skill("Small", "small");
        assert!(format_skill_body(&short).contains("body of Small"));
    }

    #[test]
    fn catalog_restates_the_duty_after_the_list() {
        // The opening instruction sits ABOVE a list that can run to thousands of
        // characters, and weak models then read the list as reference material:
        // real traces showed 2 `load_skill` calls across ~250 steps with an 11 KB
        // catalog in the prompt. The duty is restated directly UNDER the list.
        let dir = std::env::temp_dir().join(format!("codifa-skill-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY");
        let root = dir.to_str().unwrap();

        let text = build_section(root, &[]).text;
        let line = "- Movie Finder";
        let listed_at = text.find(line).expect("catalog line");
        let restated_at = text.find("call load_skill for it").expect("restated duty");
        assert!(
            restated_at > listed_at,
            "the reminder must come AFTER the list it refers to: {text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_lists_catalog_and_inlines_attached() {
        let dir = std::env::temp_dir().join(format!("codifa-skill-router-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY HERE");
        let root = dir.to_str().unwrap();

        // The catalog is what lets the model load a skill on demand.
        let plain = build_section(root, &[]);
        assert!(plain.text.contains("=== AVAILABLE SKILLS ==="), "{}", plain.text);
        assert!(plain.text.contains("- Movie Finder"), "{}", plain.text);
        assert!(plain.text.contains("find movies"), "{}", plain.text);
        // The cap is stated, and the escape hatch with it: a store of hundreds
        // of skills overflows this list, and "absent from the list" must not be
        // readable as "not installed".
        assert!(plain.text.contains("CAPPED"), "{}", plain.text);
        assert!(plain.text.contains("query"), "{}", plain.text);
        assert!(!plain.text.contains("BODY HERE"), "catalog must not inline bodies");
        assert!(plain.missing.is_empty());

        // An attached skill is inlined whole.
        let attached = build_section(root, &["Movie Finder".into()]);
        assert!(attached.text.contains("=== ATTACHED SKILLS ==="), "{}", attached.text);
        assert!(attached.text.contains("BODY HERE"), "{}", attached.text);
        assert!(attached.missing.is_empty());

        // A deleted/renamed attachment is reported instead of silently ignored.
        let gone = build_section(root, &["Ghost Skill".into()]);
        assert_eq!(gone.missing, vec!["ghost skill".to_string()]);
        assert!(!gone.text.contains("ATTACHED SKILLS"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_typed_command_expands_with_its_arguments() {
        // The whole chain a `/model-check something` goes through: a bundle on
        // disk → an enabled command → its body with the placeholders replaced.
        let dir = std::env::temp_dir().join(format!("codifa-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::plugins::create_plugin(
            &dir,
            &json!({
                "name": "Advisor",
                "slug": "advisor",
                "commands": [{
                    "name": "model-check",
                    "description": "Check the model",
                    "content": "Reassess $1 now. Full: $ARGUMENTS"
                }]
            }),
        )
        .expect("plugin");

        let (body, name) = expand_slash_command("/model-check main.rs", dir.to_str().unwrap())
            .expect("the command must resolve");
        assert_eq!(name, "model-check");
        assert_eq!(body, "Reassess main.rs now. Full: main.rs");

        // Case-insensitive on the WORD, and the arguments still arrive whole.
        let (body, _) = expand_slash_command("/Model-Check A B", dir.to_str().unwrap()).unwrap();
        assert_eq!(body, "Reassess A now. Full: A B");

        // A disabled bundle contributes nothing, and an unknown word is the
        // user's own text rather than a dead click.
        crate::plugins::toggle_plugin(&dir, &json!({"slug": "advisor", "enabled": false}))
            .unwrap();
        assert!(expand_slash_command("/model-check x", dir.to_str().unwrap()).is_none());
        assert!(expand_slash_command("/nope x", dir.to_str().unwrap()).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_is_empty_without_skills() {
        let dir = std::env::temp_dir().join(format!("codifa-skill-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let section = build_section(dir.to_str().unwrap(), &[]);
        assert!(section.text.is_empty(), "{}", section.text);
        assert!(section.missing.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_points_at_the_query_search_when_names_had_to_be_dropped() {
        // Hundreds of skills cannot all be named inside the cap. The note must
        // name the way in (`load_skill query=`) — a bare count left the model
        // unable to reach any of the skills it was told existed.
        let all: Vec<Value> = (0..500)
            .map(|i| {
                json!({
                    "name": format!("Skill Number {i:03}"),
                    "description": "a fairly long english description that would overflow the \
                                    catalog cap on its own when five hundred of them are listed \
                                    one after another in the system prompt of a real turn",
                })
            })
            .collect();
        let listed = catalog(&all);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        assert!(listed.contains("load_skill with query=<words>"), "{listed}");
        // The full note fits inside the bytes held back for it, or the emit loop
        // above would have dropped the line after it.
        let note = listed.lines().last().unwrap_or_default();
        assert!(
            note.len() <= CATALOG_TRUNCATE_NOTE_RESERVE,
            "note is {} bytes: {note}",
            note.len()
        );
    }

    // ------------------------------------------------------------------
    // The representation ladder (Full → Hybrid → Bundles → Compact → Index)
    // ------------------------------------------------------------------

    /// A bundled skill row, the shape `enabled_plugin_skills` produces.
    fn bundled(
        bundle_slug: &str,
        bundle_label: &str,
        bundle_desc: &str,
        name: &str,
        desc: &str,
    ) -> Value {
        json!({
            "name": name,
            "slug": name.to_lowercase().replace(' ', "-"),
            "description": desc,
            "plugin": bundle_label,
            "plugin_slug": bundle_slug,
            "plugin_description": bundle_desc,
        })
    }

    /// A store of `bundles × per` skills, the shape a real plugin library has.
    fn bundled_store(bundles: usize, per: usize) -> Vec<Value> {
        (0..bundles)
            .flat_map(|b| {
                let slug = format!("bundle-{b:02}");
                (0..per)
                    .map(move |s| {
                        bundled(
                            &slug,
                            &format!("Bundle {b:02}"),
                            &format!("what bundle {b} is for"),
                            &format!("Bundle{b:02} Skill {s:02}"),
                            &format!("a description long enough that {per} of them cannot fit \
                                      the catalog cap with their descriptions attached"),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn the_ladder_represents_every_bundle_and_reaches_every_skill() {
        // A store whose full descriptions cannot fit: the ladder must move DOWN
        // a rung (not drop the tail), so every bundle keeps a line and every
        // skill stays reachable — by name while names fit, otherwise through
        // its bundle's drill-in (`load_skill bundle=<slug>`).
        for cap in [CATALOG_MAX_MIN, 3_000, CATALOG_MAX_CHARS, CATALOG_MAX_LIMIT] {
            let all = bundled_store(10, 30);
            let listed = catalog_at(&all, cap);
            assert!(
                listed.len() + CATALOG_TRUNCATE_NOTE_RESERVE <= cap,
                "cap {cap}: {} bytes over budget: {listed}",
                listed.len()
            );
            for b in 0..10 {
                let slug = format!("bundle-{b:02}");
                assert!(
                    listed.contains(&slug),
                    "cap {cap}: bundle {slug} is not represented: {listed}"
                );
            }
            for s in 0..30 {
                let name = format!("Bundle00 Skill {s:02}");
                // Reachable: named in the list, or inside its bundle's line
                // (the drill-in lists it), which the bundle assertion above
                // already proved present.
                let named = listed.contains(&name);
                let bundle_named = listed.contains("bundle-00");
                assert!(
                    named || bundle_named,
                    "cap {cap}: skill {name} is unreachable: {listed}"
                );
            }
            // The note always teaches the drill-in the rung relies on.
            assert!(listed.contains("bundle=<slug>") || listed.contains("query=<words>"), "{listed}");
        }
    }

    #[test]
    fn a_500_skill_store_hides_no_bundle_and_is_byte_stable() {
        // The acceptance store: 25 bundles × 20 skills. Every bundle appears at
        // the 6K default, every skill is reachable, and the SAME content always
        // renders to the SAME bytes — insertion order, filesystem order and
        // timing must not leak into the prompt (a prompt that moves between
        // rounds would collapse the prefix cache).
        let all = bundled_store(25, 20);
        let listed = catalog_at(&all, CATALOG_MAX_CHARS);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes: {listed}", listed.len());
        for b in 0..25 {
            assert!(listed.contains(&format!("bundle-{b:02}")), "bundle {b} missing: {listed}");
        }
        for s in 0..20 {
            assert!(
                listed.contains(&format!("Bundle00 Skill {s:02}"))
                    || listed.contains("bundle-00"),
                "skill {s} unreachable: {listed}"
            );
        }
        // Byte-stable across runs and across input order.
        let mut shuffled = all.clone();
        shuffled.reverse();
        assert_eq!(catalog_at(&all, CATALOG_MAX_CHARS), catalog_at(&shuffled, CATALOG_MAX_CHARS));
        assert_eq!(
            catalog_at(&all, CATALOG_MAX_MIN),
            catalog_at(&shuffled, CATALOG_MAX_MIN)
        );
    }

    #[test]
    fn a_rung_that_would_drop_names_never_wins_the_ladder() {
        // The old emitter answered an overflowing cap by dropping the tail of
        // the list; the ladder's contract is that a rung only wins when it
        // named EVERYTHING it can name at that shape, so an overflowing rung
        // hands over to a coarser one instead of going out half-listed.
        // 60 long-description skills: Full would drop ~3 rows, Hybrid (names
        // first, even detail share) fits — the output must be Hybrid's.
        let all: Vec<Value> = (0..60)
            .map(|i| {
                json!({
                    "name": format!("Skill {i}"),
                    "description": "a long english description that would overflow the catalog cap on its own \
                                    when sixty of them are listed one after another in the system prompt",
                })
            })
            .collect();
        let listed = catalog_at(&all, CATALOG_MAX_CHARS);
        for i in 0..60 {
            assert!(listed.contains(&format!("- Skill {i}")), "Skill {i} missing:\n{listed}");
        }
        // Hybrid's even-share note rides along.
        assert!(listed.contains("descriptions are trimmed"), "{listed}");
    }
}
