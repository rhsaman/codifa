//! Native skill selection: the available-skills catalog + the SKILLS prompt section.
//!
//! Mirrors how Codex and Claude expose skills: the system prompt carries a
//! compact catalog (name + description) of every installed skill, and the model
//! loads the body of the ones it needs through the `load_skill` tool. Nothing is
//! embedded, indexed or classified up front, so a turn costs no local inference
//! and no extra model call — only the skills the user attached (`@mention`) are
//! inlined whole.

use serde_json::Value;

use crate::skills;

/// Bodies longer than this are not inlined: the description plus a `load_skill`
/// pointer is emitted instead, so one huge skill cannot flood the prompt.
pub const AUTO_MAX_BODY_CHARS: usize = 16_000;

/// Catalog lines are capped so a huge store cannot flood the system prompt.
const CATALOG_MAX_CHARS: usize = 6_000;

/// Result of building the SKILLS section for one turn.
pub struct SkillSection {
    /// Prompt text to append to the system prompt ("" when nothing applies).
    pub text: String,
    /// Attached names that no longer exist in the store.
    pub missing: Vec<String>,
    /// Names AUTO-MATCHED from the user's prompt this turn. The renderer shows
    /// them as ⚡ chips, so the user can see which skill actually ran.
    pub matched: Vec<String>,
}

/// Auto-match budget: how many skills one turn may pick up from the prompt.
const MAX_AUTO_MATCHED: usize = 3;
/// Minimum score (see `skill_score`) before a skill is auto-inlined. 2 means a
/// single name word is not enough on its own — the request must agree on two
/// signals, or carry one complete `fa_keywords` phrase.
const MATCH_MIN_SCORE: usize = 2;

/// Lowercase + whitespace-collapse, used for prompt/keyword matching.
fn normalize_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Distinctive words of a phrase (4+ chars), for partial keyword hits.
fn words_of(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.chars().count() >= 4)
        .map(|w| w.to_lowercase())
        .collect()
}

/// How well one skill matches an already-normalized prompt.
///
/// Weighted on purpose: the user's own `fa_keywords` phrase is the strongest
/// signal (it is literally what they type), then the skill's name/slug, then
/// the individual words of a multi-word keyword. The description is
/// deliberately NOT used — it is prose, and matching it fired on almost every
/// request.
fn skill_score(s: &Value, hay: &str) -> usize {
    let mut score = 0usize;
    let name_words = words_of(s["name"].as_str().unwrap_or_default());
    let slug_words = words_of(s["slug"].as_str().unwrap_or_default());
    let name_hits = name_words
        .iter()
        .chain(slug_words.iter())
        .filter(|w| hay.contains(w.as_str()))
        .count();
    // Capped so a generic name cannot outrank a real keyword match.
    score += name_hits.min(2);

    if let Some(kws) = s["fa_keywords"].as_array() {
        for kw in kws.iter().filter_map(Value::as_str) {
            let kw = normalize_text(kw);
            if kw.chars().count() < 3 {
                continue;
            }
            if hay.contains(&kw) {
                // The complete phrase is in the request: strongest signal.
                score += 3;
            } else {
                // Multi-word keyword ("landing page design") still matches a
                // shorter paraphrase ("landing page") word by word.
                score += words_of(&kw)
                    .iter()
                    .filter(|w| hay.contains(w.as_str()))
                    .count();
            }
        }
    }
    score
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
/// request. Emitting the user's own keywords keeps matching language-agnostic
/// without any embedding or classifier.
fn catalog(all: &[Value]) -> String {
    let mut out = String::new();
    for s in all {
        let name = s["name"].as_str().unwrap_or_default().trim();
        if name.is_empty() {
            continue;
        }
        let desc = s["description"].as_str().unwrap_or_default().trim();
        let fa: Vec<&str> = s["fa_keywords"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::trim).filter(|k| !k.is_empty()).collect())
            .unwrap_or_default();
        let mut line = format!("- {name}");
        if !desc.is_empty() {
            line.push_str(&format!(": {desc}"));
        }
        if !fa.is_empty() {
            line.push_str(&format!(" [fa: {}]", fa.join(", ")));
        }
        line.push('\n');
        if out.len() + line.len() > CATALOG_MAX_CHARS {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// Load the skill store for a workspace root.
fn load_skills(root: &str) -> Vec<Value> {
    skills::list_skills(std::path::Path::new(root))["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// Build the SKILLS section for one turn: the catalog of installed skills, the
/// bodies of the ones the user attached, and the bodies of the ones that
/// AUTO-MATCH the request.
///
/// The catalog is what makes on-demand loading possible — without it the model
/// has no way to know a skill exists. Attached skills are inlined whole because
/// the user asked for them explicitly; auto-matched ones are inlined too, since
/// leaving the pick to the model meant it mostly skipped the `load_skill` call
/// and the user never saw which skill applied (no badge, no effect).
pub fn build_section(prompt: &str, root: &str, manual_names: &[String]) -> SkillSection {
    let all = load_skills(root);
    let mut text = String::new();

    let listed = catalog(&all);
    if !listed.is_empty() {
        text.push_str(
            "\n\n=== AVAILABLE SKILLS ===\n\
             These skills are installed. When a task falls under one of them, call \
             load_skill with name=<name> to load its full instructions BEFORE doing \
             the work. Do not load a skill you do not need.\n\
             The `[fa: …]` keywords are the user's own Persian terms for that skill — \
             match against them too, so a Persian request finds the right skill.\n",
        );
        text.push_str(&listed);
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

    // ---- AUTO-MATCH from the prompt -------------------------------------
    // This is the "decision router": instead of only listing the catalog and
    // hoping the model calls `load_skill`, the turn's own prompt is scored
    // against every installed skill and the best fits are inlined. The user
    // sees them as ⚡ chips, and the model no longer has to guess.
    let hay = normalize_text(prompt);
    let mut matched: Vec<String> = Vec::new();
    if !hay.is_empty() {
        let mut scored: Vec<(usize, &Value)> = all
            .iter()
            .filter(|s| {
                // An attached skill is already inlined — never duplicate it.
                !picked.iter().any(|p| p["name"] == s["name"])
            })
            .map(|s| (skill_score(s, &hay), s))
            .filter(|(score, _)| *score >= MATCH_MIN_SCORE)
            .collect();
        // Highest score first; ties keep the store's name order (stable sort).
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        scored.truncate(MAX_AUTO_MATCHED);
        for (_, s) in scored {
            let name = s["name"].as_str().unwrap_or_default().trim().to_string();
            if name.is_empty() {
                continue;
            }
            matched.push(name);
        }
        if !matched.is_empty() {
            text.push_str(
                "\n\n=== AUTO-MATCHED SKILLS ===\n\
                 These skills were picked for THIS request from its keywords. Adopt \
                 their role and follow their instructions (the decision is already \
                 made — do NOT call load_skill for them).\n",
            );
            let bodies: Vec<String> = matched_bodies(&all, &matched);
            text.push_str(&bodies.join("\n\n"));
        }
    }

    SkillSection { text, missing, matched }
}

/// Formatted bodies for the auto-matched names, in the given order.
fn matched_bodies(all: &[Value], matched: &[String]) -> Vec<String> {
    matched
        .iter()
        .filter_map(|n| {
            all.iter().find(|s| {
                s["name"].as_str().unwrap_or_default().trim().to_lowercase()
                    == n.to_lowercase()
            })
        })
        .map(format_skill_body)
        .collect()
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
    fn auto_match_picks_from_the_prompt_keywords() {
        // The user's own Persian phrase must match without any embedding —
        // that is what `fa_keywords` exists for.
        let movie = json!({
            "name": "Movie Finder",
            "slug": "movie-finder",
            "description": "find movies",
            "fa_keywords": ["فیلم", "سریال"],
            "content": "BODY",
            "files": [],
        });
        let trans = json!({
            "name": "translation",
            "slug": "translation",
            "description": "translate",
            "fa_keywords": ["ترجمه", "ترجمه کن"],
            "content": "BODY",
            "files": [],
        });
        let hay = normalize_text("یه فیلم خوب معرفی کن");
        assert!(skill_score(&movie, &hay) >= MATCH_MIN_SCORE);
        // An unrelated request must NOT drag a skill in.
        let other = normalize_text("refactor this module");
        assert!(skill_score(&trans, &other) < MATCH_MIN_SCORE);
    }

    #[test]
    fn auto_match_needs_two_signals_or_a_whole_keyword() {
        let mut s = skill("Summarization", "summarize text");
        s["fa_keywords"] = json!(["خلاصه کن"]);
        // A bare shared word is not enough on its own...
        assert!(skill_score(&s, &normalize_text("a short note")) < MATCH_MIN_SCORE);
        // ...but one complete keyword phrase is decisive.
        assert!(skill_score(&s, &normalize_text("این متن رو خلاصه کن")) >= MATCH_MIN_SCORE);
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
    fn catalog_caps_the_listing() {
        let all: Vec<Value> = (0..500)
            .map(|i| skill(&format!("Skill {i}"), "a description long enough to fill the cap"))
            .collect();
        assert!(catalog(&all).len() <= CATALOG_MAX_CHARS);
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
}
