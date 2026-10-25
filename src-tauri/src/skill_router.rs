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

/// How many skills the keyword matcher may attach on its own.
///
/// Small on purpose: every auto-attached body is inlined into the prompt, so
/// this is the one place where a Persian request could suddenly get expensive.
const AUTO_ATTACH_MAX: usize = 2;

/// Shortest keyword the matcher accepts. A one- or two-character phrase matches
/// almost any sentence, which would attach a skill to every single turn.
const AUTO_ATTACH_MIN_KEYWORD_CHARS: usize = 3;

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
///
/// Test-only: production goes through `catalog_at` with the user's configured
/// budget, so this fixed-cap wrapper exists to keep the assertions readable.
#[cfg(test)]
fn catalog(all: &[Value]) -> String {
    catalog_at(all, CATALOG_MAX_CHARS)
}

/// `catalog` with an explicit byte budget (the value Settings → Skills edits).
fn catalog_at(all: &[Value], max: usize) -> String {
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
            Some(cmd) => format!("- {name} (command: /{cmd})"),            None => format!("- {name}"),
        })
        .collect();
    let bare: usize = heads.iter().map(|h| h.len() + 1).sum();
    let room = max.saturating_sub(bare + CATALOG_TRUNCATE_NOTE_RESERVE);
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

/// Skills whose own `fa_keywords` appear in the prompt, best match first.
///
/// Leaving the Persian case entirely to the model did not work: weak models
/// read the catalog as reference material and never called `load_skill` (real
/// traces: 2 calls across ~250 steps with the whole catalog in the prompt). The
/// keywords are the user's OWN phrases, so matching them in code is the same
/// judgement the model was being asked to make — done where it cannot be
/// skipped. This never overrides an `@mention`; it only adds.
///
/// Deliberately conservative, because every hit is inlined into the prompt:
/// Every phrase that can trigger one skill.
///
/// A skill's OWN list wins outright. Only a skill that carries none falls back
/// to the keywords of the BUNDLE it ships in (`bundle_keywords`), which is how
/// a library answers a broad Persian ask — without every skill of that bundle
/// pretending the same phrases are its own.
fn keyword_pool(skill: &Value) -> Vec<&str> {
    let listed = |field: &str| -> Vec<&str> {
        skill[field]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::trim).collect())
            .unwrap_or_default()
    };
    let own = listed("fa_keywords");
    if own.is_empty() {
        listed("bundle_keywords")
    } else {
        own
    }
}

/// - a keyword shorter than `AUTO_ATTACH_MIN_KEYWORD_CHARS` never matches,
/// - both sides go through `skills::fold_fa`, so the Arabic yeh/kaf and the
///   zero-width non-joiner cannot make a real phrase miss,
/// - at most `AUTO_ATTACH_MAX` skills are attached,
/// - a skill already attached manually is never counted twice.
fn match_by_keywords(all: &[Value], prompt: &str, already: &[&Value]) -> Vec<Value> {
    let folded = skills::fold_fa(prompt);
    if folded.trim().is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, usize, Value)> = Vec::new();
    for skill in all {
        let name = skill["name"].as_str().unwrap_or_default().trim();
        if name.is_empty() || already.iter().any(|p| p["name"].as_str() == Some(name)) {
            continue;
        }
        let keywords = keyword_pool(skill);
        if keywords.is_empty() {
            continue;
        }
        let mut hits = 0usize;
        let mut longest = 0usize;
        for kw in keywords {
            let kw = kw.trim();
            // Counted in CHARS: a three-word Persian phrase is few bytes and
            // would otherwise pass while a two-character one would too.
            if kw.chars().count() < AUTO_ATTACH_MIN_KEYWORD_CHARS {
                continue;
            }
            let needle = skills::fold_fa(kw);
            if !needle.trim().is_empty() && folded.contains(&needle) {
                hits += 1;
                longest = longest.max(needle.chars().count());
            }
        }
        if hits > 0 {
            scored.push((hits, longest, skill.clone()));
        }
    }
    // More matched keywords wins; a longer phrase breaks the tie, because a
    // longer match is the more specific request.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored.into_iter().take(AUTO_ATTACH_MAX).map(|(_, _, s)| s).collect()
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
/// the bodies of the ones the user attached.
///
/// The catalog is what makes on-demand loading possible — without it the model
/// has no way to know a skill exists. WHICH skill applies is normally the
/// model's call (`load_skill`), the way Codex and Claude do it — except for the
/// Persian keywords, which are matched here as well (see `match_by_keywords`).
pub fn build_section(prompt: &str, root: &str, manual_names: &[String]) -> SkillSection {
    build_section_with_cap(prompt, root, manual_names, configured_catalog_max(root))
}

/// `build_section` with an explicit catalog budget and the resolved setting.
pub fn build_section_with_cap(
    prompt: &str,
    root: &str,
    manual_names: &[String],
    catalog_max: usize,
) -> SkillSection {
    let all = load_skills(root);
    let mut text = String::new();

    let listed = catalog_at(&all, catalog_max);
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
    // Persian keywords are matched here as well as in the model's head: an
    // explicit `@mention` always wins, and this only ever ADDS a skill the
    // prompt's own words already point at.
    let auto = match_by_keywords(&all, prompt, &picked);
    let auto_names: Vec<&str> = auto
        .iter()
        .filter_map(|s| s["name"].as_str())
        .collect();
    let picked: Vec<&Value> = picked.into_iter().chain(auto.iter()).collect();
    if !picked.is_empty() {
        text.push_str(
            "\n\n=== ATTACHED SKILLS ===\n\
             The user attached these skills to this turn — follow their \
             instructions and do NOT call load_skill for them.\n",
        );
        if !auto_names.is_empty() {
            text.push_str(&format!(
                "(Matched from the request's Persian keywords, not attached by hand: {}. \
                 If one of them is NOT what the request needs, ignore it.)\n",
                auto_names.join(", ")
            ));
        }
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
        // A list typed with the Persian comma (`فیلم، سریال`) used to survive as
        // ONE garbled keyword, so the keywords the user actually types were
        // missing from the catalog line.
        let dir = std::env::temp_dir().join(format!("codifa-skill-fa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم، سریال, سینما", "BODY");
        let root = dir.to_str().unwrap();

        let listed = catalog(&load_skills(root));
        assert!(listed.contains("فیلم, سریال, سینما"), "{listed}");
        // Each keyword stands alone, so any one of them is a trigger the model
        // can find the skill by.
        assert!(listed.contains("[fa: فیلم, سریال, سینما]"), "{listed}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_matches_the_prompt_by_persian_keywords() {
        // Auto-match by SCORING is gone (it picked the wrong skill often enough
        // to be worse than nothing), but the user's own Persian keywords are now
        // matched in code: leaving it to the model meant weak models never called
        // `load_skill` at all. A prompt that carries a skill's own keyword
        // attaches it; anything else must stay out.
        let dir =
            std::env::temp_dir().join(format!("codifa-skill-nomatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم, سینما", "BODY");
        let root = dir.to_str().unwrap();

        // The user's own phrase in the request attaches the skill's body.
        let section = build_section("یه فیلم خوب معرفی کن", root, &[]);
        assert!(section.text.contains("- Movie Finder"), "{}", section.text);
        assert!(section.text.contains("BODY"), "{}", section.text);

        // A request that shares nothing with the keywords stays untouched — the
        // catalog is still there, the body is not.
        let unrelated = build_section("این کد را ریفکتور کن", root, &[]);
        assert!(unrelated.text.contains("- Movie Finder"), "{}", unrelated.text);
        assert!(!unrelated.text.contains("BODY"), "{}", unrelated.text);

        // An explicit @mention keeps working on its own.
        let attached = build_section("بدون کلمه کلیدی", root, &["Movie Finder".into()]);
        assert!(attached.text.contains("BODY"), "{}", attached.text);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keyword_match_folds_arabic_letters_and_ignores_short_phrases() {
        // The Arabic yeh/kaf and the ZWNJ are invisible to the user: a keyword
        // typed with `ي` must still find the request typed with `ی`.
        let all = vec![
            json!({"name": "Translate", "fa_keywords": ["ترجمة كن"]}),
            json!({"name": "Noisy", "fa_keywords": ["کن"]}),
            json!({"name": "Silent", "fa_keywords": ["هیچ"]}),
        ];
        let hits = match_by_keywords(&all, "این متن را ترجمه کن", &[]);
        let names: Vec<&str> = hits.iter().filter_map(|s| s["name"].as_str()).collect();
        assert_eq!(names, vec!["Translate"], "{names:?}");
    }

    #[test]
    fn keyword_match_attaches_at_most_the_cap_and_skips_manual_skills() {
        // Every auto-attached body is inlined, so the number of hits is bounded:
        // a shared keyword among many skills must not blow the turn up.
        let all: Vec<Value> = (0..10)
            .map(|i| json!({"name": format!("Skill {i}"), "fa_keywords": ["فیلم"]}))
            .collect();
        assert!(match_by_keywords(&all, "یه فیلم بده", &[]).len() <= AUTO_ATTACH_MAX);

        // A skill already attached by hand is never counted twice.
        let manual = vec![all[0].clone()];
        let refs: Vec<&Value> = manual.iter().collect();
        for hit in match_by_keywords(&all, "یه فیلم بده", &refs) {
            assert_ne!(hit["name"], all[0]["name"]);
        }

        // No keywords in the prompt = nothing attached at all.
        assert!(match_by_keywords(&all, "", &[]).is_empty());
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
    fn bundle_keywords_trigger_a_skill_that_carries_none_of_its_own() {
        // A library whose skills have no Persian words of their own still has to
        // answer a Persian ask — through the BUNDLE's list, which the row now
        // carries separately instead of having it copied onto every skill.
        let rows = vec![json!({
            "name": "Bare Skill",
            "slug": "bare-skill",
            "bundle_keywords": ["ترجمه", "برگردان"],
        })];
        let hit = match_by_keywords(&rows, "این متن را ترجمه کن", &[]);
        assert_eq!(hit.len(), 1, "the bundle trigger must still reach the skill");

        // A skill's OWN list wins: the bundle's words must not attach it too.
        let own = vec![json!({
            "name": "Own Words",
            "slug": "own-words",
            "fa_keywords": ["فیلم"],
            "bundle_keywords": ["ترجمه"],
        })];
        assert!(match_by_keywords(&own, "این متن را ترجمه کن", &[]).is_empty());
        assert_eq!(match_by_keywords(&own, "یک فیلم معرفی کن", &[]).len(), 1);
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

        let text = build_section("", root, &[]).text;
        let line = "- Movie Finder";
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
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY HERE");
        let root = dir.to_str().unwrap();

        // The catalog is what lets the model load a skill on demand.
        let plain = build_section("", root, &[]);
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
