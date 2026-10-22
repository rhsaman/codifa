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
const CATALOG_MAX_CHARS: usize = 6_000;

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

/// `- name: description [fa: کلمات]` line per installed skill, capped so a huge
/// store cannot flood the system prompt.
///
/// The Persian keywords are part of the line on purpose: the catalog is the
/// only thing the model sees before deciding to call `load_skill`, so a skill
/// whose description is English-only would never be found from a Persian
/// request. Emitting the user's own keywords keeps the catalog findable from
/// the way the user actually writes, without any embedding or classifier.
///
/// Bytes reserved so the "list truncated" note always fits inside the cap.
const CATALOG_TRUNCATE_NOTE_RESERVE: usize = 160;

/// Longest description one catalog line keeps.
const CATALOG_DESC_MAX_CHARS: usize = 120;

/// Most `fa_keywords` one catalog line carries (the user's order is kept: the
/// first ones are the ones they actually say).
const CATALOG_KEYWORDS_MAX: usize = 6;

/// Ceiling on the description+keywords part of a single line, so one verbose
/// skill cannot eat the room every other skill needs.
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

/// The `: description [fa: …]` tail of one catalog line, fitted into `room`
/// bytes. The Persian keywords are the trigger, so they are kept whole (already
/// capped by the caller); the DESCRIPTION absorbs the clipping.
fn catalog_detail(desc: &str, fa: &[&str], room: usize) -> String {
    let mut kw = if fa.is_empty() {
        String::new()
    } else {
        format!(" [fa: {}]", fa.join(", "))
    };
    let mut detail_room = room;
    if !kw.is_empty() {
        if kw.len() < detail_room {
            detail_room -= kw.len();
        } else {
            kw.clear();
        }
    }
    let mut out = String::new();
    if !desc.is_empty() && detail_room > 4 {
        let clip = (detail_room - 2).min(CATALOG_DESC_MAX_CHARS);
        let clipped = clip_words(desc, clip);
        if !clipped.is_empty() {
            out.push_str(": ");
            out.push_str(&clipped);
        }
    }
    out.push_str(&kw);
    out
}

/// `- name: description [fa: کلمات]` line per installed skill: everything the
/// model gets up front, and nothing more.
///
/// This line IS the trigger for `load_skill`. A skill whose description is
/// English-only is unreachable from a Persian request, which is why the user's
/// own keywords are emitted verbatim rather than translated.
fn catalog(all: &[Value]) -> String {
    let rows: Vec<(&str, &str, Vec<&str>, Option<String>)> = all
        .iter()
        .filter_map(|s| {
            let name = s["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() {
                return None;
            }
            let desc = s["description"].as_str().unwrap_or_default().trim();
            let fa: Vec<&str> = s["fa_keywords"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|k| !k.is_empty())
                        .take(CATALOG_KEYWORDS_MAX)
                        .collect()
                })
                .unwrap_or_default();
            // A skill that ships inside a plugin is ALSO a `/`-command in the
            // composer, so the catalog has to name it: an installer script that
            // says "try /ponytail" produced "Unknown command" because the model
            // had no way to learn the command existed.
            let command = s["plugin"].as_str().and_then(|_| {
                let slug = s["slug"].as_str().unwrap_or_default().trim();
                if slug.is_empty() {
                    None
                } else {
                    Some(slug.to_string())
                }
            });
            Some((name, desc, fa, command))
        })
        .collect();

    // The bare name of EVERY skill is paid for first, and the leftover room is
    // then split evenly. A catalog that silently dropped the tail made the last
    // installed skills unreachable: with 25 installed skills their full-length
    // descriptions overflowed the cap and three of them disappeared from the
    // list — the model never learned they existed, so `load_skill` was never
    // called for them. Detail is what gets sacrificed, never the entry itself.
    let heads: Vec<String> = rows
        .iter()
        .map(|(name, _, _, command)| match command {
            // A plugin skill is invocable as `/<slug>` in the composer, so its
            // line names the command: a bundle whose install output says "try
            // /ponytail" left the model unable to explain how to run it, and
            // the user got "Unknown command".
            Some(cmd) => format!("- {name} (command: /{cmd})"),
            None => format!("- {name}"),
        })
        .collect();
    let bare: usize = heads.iter().map(|h| h.len() + 1).sum();
    let room = CATALOG_MAX_CHARS.saturating_sub(bare + CATALOG_TRUNCATE_NOTE_RESERVE);
    let per_row = if rows.is_empty() { 0 } else { (room / rows.len()).min(CATALOG_DETAIL_PER_ROW) };

    let mut lines: Vec<String> = Vec::with_capacity(rows.len());
    let mut detail_clipped = false;
    for (i, (_name, desc, fa, _)) in rows.iter().enumerate() {
        let head = &heads[i];
        // The untrimmed detail (description up to its own cap plus every
        // keyword) — comparing it to the row's even share is what separates a
        // store that fits from one whose details had to be sacrificed.
        let natural = catalog_detail(desc, &fa, CATALOG_DETAIL_PER_ROW);
        let detail = if natural.len() <= per_row {
            natural
        } else {
            detail_clipped = true;
            catalog_detail(desc, &fa, per_row)
        };
        lines.push(format!("{head}{detail}"));
    }

    let mut out = String::new();
    let mut dropped = 0usize;
    for line in &lines {
        // Names are paid for first (see `per_row` above), so by construction a
        // name alone always fits: this is a safety net, not the normal path.
        if out.len() + line.len() + 1 + CATALOG_TRUNCATE_NOTE_RESERVE > CATALOG_MAX_CHARS {
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
    out
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
    let mut acc: u64 = 0;
    for base in ["skills", "plugins"] {
        acc = acc.wrapping_add(tree_stamp(&std::path::Path::new(root).join(base), 0));
    }
    acc
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

/// Every skill the prompt may offer: the standalone store first, then the
/// skills of every enabled plugin.
fn read_skills_from_disk(root: &str) -> Vec<Value> {
    let store = std::path::Path::new(root);
    let mut all = skills::list_skills(store)["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for row in crate::plugins::enabled_plugin_skills(store) {
        if !all.iter().any(|s| s["name"] == row["name"]) {
            all.push(row);
        }
    }
    all
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

/// Build the SKILLS section for one turn: the catalog of installed skills plus
/// the bodies of the ones the user attached.
///
/// The catalog is what makes on-demand loading possible — without it the model
/// has no way to know a skill exists. WHICH skill applies is the model's call
/// (`load_skill`), the way Codex and Claude do it: scoring the prompt against
/// keywords picked the wrong skill often enough to be worse than no pick at all.
pub fn build_section(_prompt: &str, root: &str, manual_names: &[String]) -> SkillSection {
    let all = load_skills(root);
    let mut text = String::new();

    let listed = catalog(&all);
    if !listed.is_empty() {
        text.push_str(
            "\n\n=== AVAILABLE SKILLS ===\n\
             These skills are installed. This list is a TRIGGER, not a summary: if \
             the request falls under one of them, call load_skill with that skill's \
             name BEFORE doing the work and follow its instructions for the rest of \
             the turn. Match on the description AND on the `[fa: …]` keywords (the \
             user's own Persian terms). Do not load a skill you do not need — but a \
             task a skill covers must not be answered from memory.\n\
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

    #[test]
    fn catalog_splits_persian_comma_keywords() {
        // A list typed with the Persian comma (`فیلم، سریال`) used to survive as
        // ONE garbled keyword, so the keywords the user actually types were
        // missing from the catalog line.
        let dir = std::env::temp_dir().join(format!("codifa-skill-fa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: فیلم، سریال, سینما\n---\nBODY\n",
        )
        .unwrap();
        let root = dir.to_str().unwrap();

        let listed = catalog(&load_skills(root));
        assert!(listed.contains("فیلم, سریال, سینما"), "{listed}");
        // Each keyword stands alone, so any one of them is a trigger the model
        // can find the skill by.
        assert!(listed.contains("[fa: فیلم, سریال, سینما]"), "{listed}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_never_picks_a_skill_from_the_prompt() {
        // Auto-match is GONE on purpose: scoring the prompt against keywords
        // picked the wrong skill often enough to be worse than no pick at all.
        // The router only lists the catalog now, and WHICH skill applies is the
        // model's call through `load_skill` (the Codex/Claude model). A
        // regression here would silently inline a skill again and move the
        // cached system-prompt prefix with it.
        let dir =
            std::env::temp_dir().join(format!("codifa-skill-nomatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: فیلم, سینما\n---\nBODY\n",
        )
        .unwrap();
        let root = dir.to_str().unwrap();

        // The prompt carries the skill's own keyword and still nothing is inlined.
        let section = build_section("یه فیلم خوب معرفی کن", root, &[]);
        assert!(section.text.contains("- Movie Finder"), "{}", section.text);
        assert!(!section.text.contains("BODY"), "{}", section.text);

        // An explicit @mention is the only route to a body.
        let attached = build_section("یه فیلم خوب معرفی کن", root, &["Movie Finder".into()]);
        assert!(attached.text.contains("BODY"), "{}", attached.text);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_names_the_slash_command_of_a_plugin_skill() {
        // The plugin's own install output tells the user "try /ponytail", and
        // the composer only knows a command the full catalog contains. Naming
        // the command in the catalog is what lets the model explain it — and a
        // standalone skill has no command, so it must not grow one.
        let rows = vec![
            json!({
                "name": "Ponytail",
                "slug": "ponytail",
                "description": "lazy senior dev",
                "plugin": "Ponytail",
            }),
            json!({"name": "Movie Finder", "description": "find movies"}),
        ];
        let listed = catalog(&rows);
        assert!(listed.contains("- Ponytail (command: /ponytail)"), "{listed}");
        assert!(!listed.contains("/movie-finder"), "{listed}");
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
    fn catalog_carries_the_persian_keywords() {
        // The catalog is all the model sees before calling load_skill, so an
        // English-only description would never match a Persian request.
        let all = vec![json!({
            "name": "Movie Finder",
            "description": "find movies",
            "fa_keywords": ["فیلم", "سینما"],
        })];
        let listed = catalog(&all);
        assert!(listed.contains("[fa: فیلم, سینما]"), "{listed}");
        // No keywords = no empty marker.
        assert!(!catalog(&[skill("Plain", "d")]).contains("[fa:"));
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
                    "fa_keywords": ["کلمه کلیدی", "دوم", "سوم", "چهارم", "پنجم", "ششم", "هفتم", "هشتم"],
                })
            })
            .collect();
        let listed = catalog(&all);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        for i in 0..60 {
            assert!(listed.contains(&format!("- Skill {i}")), "Skill {i} missing:\n{listed}");
        }
        // Clipping is on a character boundary: Persian keywords must survive
        // intact (byte slicing would have panicked here).
        assert!(listed.contains("[fa: کلمه کلیدی"), "{listed}");
        // The tail that overflows must be bounded to the keyword cap.
        assert!(!listed.contains("هشتم"), "keywords past the cap leaked: {listed}");
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
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\n---\nBODY\n",
        )
        .unwrap();
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
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: فیلم\n---\nBODY\n",
        )
        .unwrap();
        let root = dir.to_str().unwrap();

        let text = build_section("", root, &[]).text;
        let line = "- Movie Finder: find movies";
        let listed_at = text.find(line).expect("catalog line");
        let restated_at = text.find("call load_skill for it").expect("restated duty");
        assert!(
            restated_at > listed_at,
            "the reminder must come AFTER the list it refers to: {text}"
        );
        // The keywords still ride along, so a Persian request has a trigger.
        assert!(text.contains("[fa: فیلم]"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_lists_catalog_and_inlines_attached() {
        let dir = std::env::temp_dir().join(format!("codifa-skill-router-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: فیلم\n---\nBODY HERE\n",
        )
        .unwrap();
        let root = dir.to_str().unwrap();

        // The catalog is what lets the model load a skill on demand.
        let plain = build_section("", root, &[]);
        assert!(plain.text.contains("=== AVAILABLE SKILLS ==="), "{}", plain.text);
        assert!(plain.text.contains("Movie Finder: find movies"), "{}", plain.text);
        // The cap is stated, and the escape hatch with it: a store of hundreds
        // of skills overflows this list, and "absent from the list" must not be
        // readable as "not installed".
        assert!(plain.text.contains("CAPPED"), "{}", plain.text);
        assert!(plain.text.contains("query"), "{}", plain.text);
        assert!(!plain.text.contains("BODY HERE"), "catalog must not inline bodies");
        assert!(plain.missing.is_empty());

        // An attached skill is inlined whole.
        let attached = build_section("", root, &["Movie Finder".into()]);
        assert!(attached.text.contains("=== ATTACHED SKILLS ==="), "{}", attached.text);
        assert!(attached.text.contains("BODY HERE"), "{}", attached.text);
        assert!(attached.missing.is_empty());

        // A deleted/renamed attachment is reported instead of silently ignored.
        let gone = build_section("", root, &["Ghost Skill".into()]);
        assert_eq!(gone.missing, vec!["ghost skill".to_string()]);
        assert!(!gone.text.contains("ATTACHED SKILLS"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_is_empty_without_skills() {
        let dir = std::env::temp_dir().join(format!("codifa-skill-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let section = build_section("", dir.to_str().unwrap(), &[]);
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
}
