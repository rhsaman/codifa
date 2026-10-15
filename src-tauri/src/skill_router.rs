//! Native skill routing: deterministic auto-match + the SKILLS prompt section.
//!
//! Port of the Python sidecar's skill selection (agents.py auto-match
//! constants + graph.py `_build_skills_section`). Only what the user attached
//! (`@mention`) or what the in-code matcher picked is inlined — full bodies,
//! exactly like an @mention. There is no "AVAILABLE SKILLS" catalog in the
//! model prompt: anything else is loaded on demand via the `load_skill` tool,
//! so a turn with no picks adds zero tokens.

use reqwest::Client;
use serde_json::Value;

use crate::llm::LlmConfig;
use crate::skills;

/// Skills auto-matched per turn (0 disables auto-match).
pub const AUTO_MAX: usize = 2;
/// Minimum score to auto-match: a name word hit = 2, a one-word name = 4,
/// an fa_keyword hit = 4.
pub const AUTO_MIN_SCORE: i32 = 4;
/// Longer bodies are not inlined — the model loads them via `load_skill`.
pub const AUTO_MAX_BODY_CHARS: usize = 16_000;
/// Pasted logs/code past this length are not scanned for skill matches.
pub const AUTO_SCAN_CHARS: usize = 1200;

/// Words too common to signal a skill match.
const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "from", "that", "this", "these", "those",
    "your", "you", "are", "was", "not", "how", "what", "when", "into", "than",
    "then", "can", "has", "have", "will", "should", "could", "would", "please",
    "just", "also", "about", "use", "using", "make", "need", "want", "like",
    "some", "any", "all", "new", "get", "set", "add", "fix", "skill", "skills",
    "code", "file", "files", "task", "help", "give", "show", "tell",
];

/// Verbs that, near the word "skill", mean the request is ABOUT skills.
const META_VERBS: &[&str] = &[
    "create", "edit", "update", "modify", "delete", "remove", "rename",
];
/// Persian equivalents of META_VERBS.
const META_VERBS_FA: &[&str] = &["بساز", "ساخت", "ایجاد", "ویرایش", "اصلاح", "حذف", "تغییر"];
/// Persian words for "skill".
const SKILL_WORDS_FA: &[&str] = &["اسکیل", "مهارت"];

/// Lowercase word tokens (Unicode alphanumeric runs).
fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// True when the request is ABOUT creating/editing skills: such a turn must
/// not inline unrelated skill bodies just because its wording mentions
/// "summarize" or "git".
pub fn is_meta_request(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    // English: a meta verb within 60 chars before the word "skill(s)".
    for verb in META_VERBS {
        let mut from = 0;
        while let Some(at) = lower[from..].find(verb) {
            let start = from + at;
            let after = &lower[start + verb.len()..];
            let window: String = after.chars().take(60).collect();
            if window.contains("skill") {
                return true;
            }
            from = start + verb.len();
        }
    }
    // Persian: "skill" and a meta verb within 40 chars of each other, in
    // either order.
    for skill_word in SKILL_WORDS_FA {
        let mut from = 0;
        while let Some(at) = prompt[from..].find(skill_word) {
            let start = from + at;
            let after: String = prompt[start + skill_word.len()..].chars().take(40).collect();
            let before: String = prompt[..start].chars().rev().take(40).collect();
            if META_VERBS_FA.iter().any(|v| after.contains(v) || before.contains(v)) {
                return true;
            }
            from = start + skill_word.len();
        }
    }
    false
}

/// Relevance score of one skill against the request tokens.
fn score_skill(skill: &Value, prompt_lower: &str, tokens: &[String]) -> i32 {
    let name = skill["name"].as_str().unwrap_or_default();
    let name_words = tokenize(name);
    let mut score = 0;
    if name_words.len() == 1 {
        // A single-word name is a strong signal on its own.
        if prompt_lower.contains(&name_words[0]) {
            score += 4;
        }
    } else {
        for w in &name_words {
            if w.len() >= 3 && !STOP_WORDS.contains(&w.as_str()) && tokens.contains(w) {
                score += 2;
            }
        }
    }
    if let Some(keywords) = skill["fa_keywords"].as_array() {
        for k in keywords.iter().filter_map(Value::as_str) {
            let k = k.trim().to_lowercase();
            if !k.is_empty() && prompt_lower.contains(&k) {
                score += 4;
            }
        }
    }
    score
}

/// Names of the skills that match the request, best first (at most AUTO_MAX).
/// Empty for a meta request, an empty prompt, or a prompt past the scan cap.
pub fn auto_match(prompt: &str, all: &[Value]) -> Vec<String> {
    let text = prompt.trim();
    if AUTO_MAX == 0 || text.is_empty() || text.chars().count() > AUTO_SCAN_CHARS {
        return Vec::new();
    }
    if is_meta_request(text) {
        return Vec::new();
    }
    let lower = text.to_lowercase();
    let tokens = tokenize(text);
    let mut scored: Vec<(i32, usize, String)> = Vec::new();
    for (i, s) in all.iter().enumerate() {
        let name = s["name"].as_str().unwrap_or_default().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let score = score_skill(s, &lower, &tokens);
        if score >= AUTO_MIN_SCORE {
            scored.push((score, i, name));
        }
    }
    // Stable: ties keep store order.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(AUTO_MAX).map(|t| t.2).collect()
}

/// One inlined skill (shared by @mentioned and auto-matched skills).
///
/// A body past `AUTO_MAX_BODY_CHARS` is NOT inlined: the description plus a
/// `load_skill` pointer is emitted instead, so one huge skill cannot flood the
/// prompt (and the auto-match path stays cheap). Without this cap the constant
/// was dead and every matched body was inlined whole.
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

/// Result of building the SKILLS section for one turn.
pub struct SkillSection {
    /// Prompt text to append to the system prompt ("" when nothing applies).
    pub text: String,
    /// Auto-matched skill names (reported to the UI as `autoSkills`).
    pub auto: Vec<String>,
    /// Attached names that no longer exist in the store.
    pub missing: Vec<String>,
}

/// Catalog handed to the decision model: one `name: description` line per
/// skill, capped so a huge store cannot flood the router prompt.
const DECISION_CATALOG_MAX_CHARS: usize = 6_000;
/// Skills the decision model may pick per turn.
const DECISION_MAX: usize = 2;

fn decision_catalog(all: &[Value]) -> String {
    let mut out = String::new();
    for s in all {
        let name = s["name"].as_str().unwrap_or_default().trim();
        if name.is_empty() {
            continue;
        }
        let desc = s["description"].as_str().unwrap_or_default().trim();
        let line = if desc.is_empty() {
            format!("- {name}\n")
        } else {
            format!("- {name}: {desc}\n")
        };
        if out.len() + line.len() > DECISION_CATALOG_MAX_CHARS {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// Map the decision model's answer back to real skill names. Accepts a
/// comma/newline separated list (optionally quoted or JSON-array shaped);
/// unknown entries and explicit "none" answers are dropped.
pub fn parse_decision(answer: &str, all: &[Value]) -> Vec<String> {
    let cleaned = answer
        .trim()
        .trim_matches(|c| c == '[' || c == ']' || c == '"' || c == '`');
    let mut out: Vec<String> = Vec::new();
    for raw in cleaned.split([',', '\n', ';']) {
        let want = raw
            .trim()
            .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '-')
            .trim()
            .to_lowercase();
        if want.is_empty() || want == "none" || want == "no" || want == "هیچ" {
            continue;
        }
        let hit = all.iter().find(|s| {
            let name = s["name"].as_str().unwrap_or_default().trim().to_lowercase();
            let slug = s["slug"].as_str().unwrap_or_default().trim().to_lowercase();
            name == want || slug == want
        });
        if let Some(s) = hit {
            let name = s["name"].as_str().unwrap_or_default().to_string();
            if !out.contains(&name) {
                out.push(name);
            }
        }
        if out.len() >= DECISION_MAX {
            break;
        }
    }
    out
}

/// Ask the decision model which skills apply to this request. Err on any
/// transport/provider failure so the caller can fall back to the in-code
/// matcher instead of losing the turn's skills.
pub async fn decide_with_model(
    client: &Client,
    cfg: &LlmConfig,
    prompt: &str,
    all: &[Value],
) -> Result<Vec<String>, String> {
    let catalog = decision_catalog(all);
    if catalog.is_empty() {
        return Ok(Vec::new());
    }
    let system = "You pick which skills apply to a coding request. Reply with the \
                  exact skill names, comma-separated, best first, at most 2. \
                  Reply NONE when no skill applies. No other text.";
    let user = format!(
        "Request:\n{}\n\nSkills:\n{catalog}",
        prompt.chars().take(AUTO_SCAN_CHARS).collect::<String>()
    );
    let res = crate::llm::complete(client, cfg, system, &user).await?;
    Ok(parse_decision(&res.text, all))
}

/// Load the skill store for a workspace root.
fn load_skills(root: &str) -> Vec<Value> {
    skills::list_skills(std::path::Path::new(root))["skills"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// Deterministic in-code routing (no model call). Test-only: the turn always
/// goes through `build_section_async`, which falls back to this matcher when
/// no decision slot is configured or the model call fails.
#[cfg(test)]
pub fn build_section(root: &str, prompt: &str, manual_names: &[String]) -> SkillSection {
    let all = load_skills(root);
    let auto_names = if prompt.trim().is_empty() {
        Vec::new()
    } else {
        auto_match(prompt, &all)
    };
    assemble(&all, auto_names, manual_names)
}

/// Model-backed routing: the "decision" Tool Models slot picks the skills.
/// Falls back to the in-code matcher when the model call fails, so a broken
/// router never costs the turn its skills.
pub async fn build_section_async(
    root: &str,
    prompt: &str,
    manual_names: &[String],
    decision: Option<(&Client, &LlmConfig)>,
) -> SkillSection {
    let all = load_skills(root);
    let auto_names = if prompt.trim().is_empty() {
        Vec::new()
    } else {
        match decision {
            Some((client, cfg)) => match decide_with_model(client, cfg, prompt, &all).await {
                Ok(picked) => picked,
                Err(_) => auto_match(prompt, &all),
            },
            None => auto_match(prompt, &all),
        }
    };
    assemble(&all, auto_names, manual_names)
}

/// Assemble the SKILLS section from a resolved auto-match list: auto-matched
/// bodies first, then the skills the user explicitly attached.
fn assemble(all: &[Value], auto_names: Vec<String>, manual_names: &[String]) -> SkillSection {
    let mut manual: Vec<String> = Vec::new();
    for n in manual_names {
        let n = n.trim().to_lowercase();
        if !n.is_empty() && !manual.contains(&n) {
            manual.push(n);
        }
    }
    // A skill the user attached is never also reported as auto-matched.
    let auto: Vec<Value> = auto_names
        .iter()
        .filter(|n| !manual.contains(&n.trim().to_lowercase()))
        .filter_map(|n| {
            all.iter().find(|s| {
                let name = s["name"].as_str().unwrap_or_default().trim().to_lowercase();
                let slug = s["slug"].as_str().unwrap_or_default().trim().to_lowercase();
                name == n.trim().to_lowercase() || slug == n.trim().to_lowercase()
            })
        })
        .cloned()
        .collect();
    let mut text = String::new();
    if !auto.is_empty() {
        text.push_str(
            "\n\n=== AUTO-MATCHED SKILLS ===\n\
             These skills match the user's request and are ALREADY LOADED below — \
             follow their instructions for this task and do NOT call load_skill for \
             them. When a skill lists Extra files, the main body is enough unless the \
             task needs a listed file — then call load_skill with file=<name> for that \
             specific file only (saves tokens).\n",
        );
        text.push_str(
            &auto
                .iter()
                .map(format_skill_body)
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
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
        text.push_str("\n\n=== ATTACHED SKILLS ===\n");
        text.push_str(
            &picked
                .iter()
                .map(|s| format_skill_body(s))
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
    }
    SkillSection {
        text,
        auto: auto
            .iter()
            .map(|s| s["name"].as_str().unwrap_or_default().to_string())
            .collect(),
        missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn skill(name: &str, description: &str, keywords: &[&str]) -> Value {
        json!({
            "name": name,
            "slug": name.to_lowercase().replace(' ', "-"),
            "description": description,
            "content": format!("body of {name}"),
            "fa_keywords": keywords,
            "files": [],
        })
    }

    #[test]
    fn auto_match_scores_name_words_and_keywords() {
        let all = vec![
            skill("Movie Finder", "find good movies", &["فیلم"]),
            skill("Git Commit", "write commit messages", &[]),
        ];
        // "movies" is a name word of Movie Finder (2) + fa_keyword فیلم (4).
        let picks = auto_match("فیلم خوب برای آخر هفته پیدا کن", &all);
        assert_eq!(picks, vec!["Movie Finder".to_string()]);
        // A one-word name scores 4 on its own.
        let all2 = vec![skill("Summarize", "summarize text", &[])];
        assert_eq!(auto_match("please summarize this", &all2), vec!["Summarize".to_string()]);
    }

    #[test]
    fn auto_match_ignores_meta_requests_and_long_prompts() {
        let all = vec![skill("Summarize", "summarize text", &[])];
        // A request ABOUT skills must not inline unrelated bodies.
        assert!(auto_match("create a new skill that can summarize", &all).is_empty());
        assert!(auto_match("یک اسکیل بساز که خلاصه کند", &all).is_empty());
        // Pasted logs past the scan cap are not scanned.
        let long = format!("summarize {}", "x".repeat(AUTO_SCAN_CHARS + 10));
        assert!(auto_match(&long, &all).is_empty());
    }

    #[test]
    fn auto_match_is_capped_and_stable() {
        let all = vec![
            skill("Alpha", "alpha thing", &[]),
            skill("Beta", "beta thing", &[]),
            skill("Gamma", "gamma thing", &[]),
        ];
        let picks = auto_match("alpha beta gamma", &all);
        assert_eq!(picks.len(), AUTO_MAX);
        // Ties keep store order.
        assert_eq!(picks, vec!["Alpha".to_string(), "Beta".to_string()]);
    }

    #[test]
    fn parse_decision_maps_names_and_drops_noise() {
        let all = vec![
            skill("Movie Finder", "find movies", &[]),
            skill("Git Commit", "commit messages", &[]),
        ];
        // Comma list, quoted, JSON-array shaped and slug forms all resolve.
        assert_eq!(parse_decision("Movie Finder, Git Commit", &all), vec!["Movie Finder", "Git Commit"]);
        assert_eq!(parse_decision("[\"movie-finder\"]", &all), vec!["Movie Finder"]);
        // An explicit "none" and unknown names pick nothing.
        assert!(parse_decision("NONE", &all).is_empty());
        assert!(parse_decision("Ghost Skill", &all).is_empty());
        // The pick count is capped.
        assert_eq!(parse_decision("Movie Finder\nGit Commit", &all).len(), DECISION_MAX);
    }

    #[test]
    fn decision_catalog_lists_names_and_descriptions() {
        let all = vec![skill("Movie Finder", "find movies", &[])];
        let catalog = decision_catalog(&all);
        assert!(catalog.contains("Movie Finder: find movies"), "{catalog}");
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
        let short = skill("Small", "small", &[]);
        assert!(format_skill_body(&short).contains("body of Small"));
    }

    #[test]
    fn build_section_inlines_attached_and_reports_missing() {
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

        let attached = build_section(root, "", &["Movie Finder".into()]);
        assert!(attached.text.contains("=== ATTACHED SKILLS ==="), "{}", attached.text);
        assert!(attached.text.contains("BODY HERE"), "{}", attached.text);
        assert!(attached.auto.is_empty());
        assert!(attached.missing.is_empty());

        // Auto-match picks it from the request and reports it for the UI.
        let auto = build_section(root, "فیلم خوب پیشنهاد بده", &[]);
        assert_eq!(auto.auto, vec!["Movie Finder".to_string()]);
        assert!(auto.text.contains("=== AUTO-MATCHED SKILLS ==="), "{}", auto.text);

        // A deleted/renamed attachment is reported instead of silently ignored.
        let gone = build_section(root, "", &["Ghost Skill".into()]);
        assert_eq!(gone.missing, vec!["ghost skill".to_string()]);
        assert!(!gone.text.contains("ATTACHED SKILLS"));

        // No picks at all adds zero tokens.
        assert!(build_section(root, "", &[]).text.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
