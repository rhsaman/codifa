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
    /// BYTE-STABLE part: the catalog plus the skills the user attached with an
    /// `@mention`. Goes into the system prompt, which every request re-sends.
    pub text: String,
    /// PER-TURN part: the bodies of the auto-matched skills.
    ///
    /// This must NOT go into the system prompt. Auto-match is recomputed from
    /// the current user message on every turn, so a prompt whose keywords pick
    /// a different skill rewrites the system prompt and invalidates the cached
    /// prefix of the WHOLE conversation. A measured trace showed exactly that:
    /// two consecutive main turns diverged at char 8 696 inside
    /// `=== AUTO-MATCHED SKILLS ===` and the next call cost 96 460 uncached
    /// tokens instead of riding the cache. The caller appends this to the
    /// TRAILING message instead (same treatment as the plan/checklist section),
    /// where per-turn churn cannot move anything the previous call cached.
    pub volatile: String,
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
/// signals, or carry one complete `fa_keywords` phrase (or ONE word of one).
const MATCH_MIN_SCORE: usize = 2;
/// How far below the best score a skill may sit and still be inlined.
///
/// An absolute threshold alone cannot express "this one is clearly the topic":
/// with only `score >= 2`, a prompt scoring 6 for `summarization` also dragged
/// in an unrelated skill that scraped a 2. Relative filtering keeps the winner
/// plus its genuine near-ties (`design a landing page` keeps landing-page-design
/// and Hallmark) and drops the noise. Measured over the labelled set: no correct
/// pick lost, the trailing stragglers gone.
const AUTO_MATCH_WINDOW: usize = 1;

/// Lowercase + whitespace-collapse, used for prompt/keyword matching.
fn normalize_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Shortest word that counts as a match signal.
///
/// 4 was wrong for Persian: the language is built from short words, so
/// `این باگ رو درست کن` kept only `درست` and dropped `باگ` — the exact word the
/// Code-Expert skill lists. `commit this and push` likewise lost `git` and
/// scored 1 instead of a match. Measured over a labelled set of 19 prompts:
/// 3 recovers every miss the 4-char floor caused with no new false positive
/// (the word-boundary rule, not the length, is what keeps matching honest).
const MIN_WORD_CHARS: usize = 3;

/// Distinctive words of a phrase, for partial keyword hits.
fn words_of(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.chars().count() >= MIN_WORD_CHARS)
        .map(|w| w.to_lowercase())
        .collect()
}

/// Shared prefix needed before two words can be the same stem.
const STEM_PREFIX_MIN: usize = 5;

/// Word endings that never change what the word is about.
///
/// The first version compared raw lengths (allow a 1-char tail) and got both
/// cases wrong: it accepted `data`/`dataset` (a different word) while rejecting
/// `refactor`/`refactoring` (the same one), because both differ by three
/// characters. Length cannot separate them — the actual signal is WHICH letters
/// the tail is made of. So the tail must be one of these morphemes on BOTH
/// sides; `ing`/`ion` are inflections, `set` is a different noun.
const STEM_SUFFIXES: [&str; 22] = [
    "", "s", "es", "e", "ed", "d", "ing", "ging", "r", "er", "ers", "ion", "ions", "ation",
    "ations", "ly", "is", "sis", "ze", "al", "ment", "ments",
];

/// Whether two lowercase words are the same word up to an inflection.
///
/// The user types one form while the skill lists another — `refactor` vs
/// `refactoring`, `debug` vs `debugging`, `analyze` vs `analysis`, `brainstorm`
/// vs `brainstorming`, `translate` vs `translation` — and an exact word-set
/// comparison missed every one of them. A real stemmer is overkill here; the
/// rule is: a long enough shared prefix plus an inflection-only tail.
///
/// Rejects `data`/`dataset` (shared prefix only 4, and `set` is not an
/// inflection), so unrelated skills are not dragged in.
fn same_stem(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let shared = a
        .chars()
        .zip(b.chars())
        .take_while(|(x, y)| x == y)
        .count();
    if shared < STEM_PREFIX_MIN {
        return false;
    }
    let tail = |w: &str| -> String { w.chars().skip(shared).collect() };
    let (ta, tb) = (tail(a), tail(b));
    STEM_SUFFIXES.contains(&ta.as_str()) && STEM_SUFFIXES.contains(&tb.as_str())
}

/// Whether any prompt word matches `word` (exactly or as the same stem).
fn word_in(word: &str, prompt_words: &[String]) -> bool {
    prompt_words.iter().any(|p| same_stem(word, p))
}

/// Whether any prompt word equals `word` exactly.
///
/// The skill NAME is a label, not a curated keyword list: its words are generic
/// (`optimization`, `analysis`, `design`) and stem-expanding them drags the
/// skill into requests about something else — `optimize the sql query` reached
/// `seo-optimization` through `optimize` -> `optimization` and inlined an SEO
/// skill into a database question. Inflection tolerance belongs to the
/// `fa_keywords` the author wrote on purpose, so name/slug matching stays exact.
fn word_in_exact(word: &str, prompt_words: &[String]) -> bool {
    prompt_words.iter().any(|p| p == word)
}

/// Whether `needle` occurs in `hay` at WORD boundaries.
///
/// A bare `hay.contains(needle)` was wrong for short keywords: the Playwrite
/// skill lists `ref`, which matched inside "**ref**actor this module" and
/// "this is a **pref**erence setting" and pulled a browser-automation skill
/// into ordinary coding requests. Both sides of the match must be a non-word
/// character (or a string edge).
///
/// Both arguments are already lowercased (`normalize_text`); the check is on
/// `char::is_alphanumeric` so it holds for Persian as well as ASCII — `باگ`
/// still matches inside `این باگ رو` because the neighbours are spaces.
fn contains_phrase(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before_ok = hay[..start].chars().next_back().is_none_or(|c| !is_word(c));
        let after_ok = hay[end..].chars().next().is_none_or(|c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        // Advance past the first char of this hit (never inside a UTF-8 char).
        from = start + hay[start..].chars().next().map(chars_len).unwrap_or(1);
    }
    false
}

/// Byte length of one char (helper so `contains_phrase` can advance safely).
fn chars_len(c: char) -> usize {
    c.len_utf8()
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
    // Matching is WORD-based, never raw substring: `hay.contains("data")` also
    // fired inside "metadata"/"database", so unrelated skills were pulled into
    // prompts that never mentioned them (the "it loads the wrong skill" report).
    let prompt_words: Vec<String> = words_of(hay);
    let name_words = words_of(s["name"].as_str().unwrap_or_default());
    let slug_words = words_of(s["slug"].as_str().unwrap_or_default());
    let name_hits = name_words
        .iter()
        .chain(slug_words.iter())
        .filter(|w| word_in_exact(w, &prompt_words))
        .count();
    // Capped so a generic name cannot outrank a real keyword match.
    score += name_hits.min(2);

    if let Some(kws) = s["fa_keywords"].as_array() {
        for kw in kws.iter().filter_map(Value::as_str) {
            let kw = normalize_text(kw);
            if kw.chars().count() < 3 {
                continue;
            }
            if contains_phrase(hay, &kw) {
                // The complete phrase is in the request: strongest signal.
                score += 3;
                continue;
            }
            let kw_words = words_of(&kw);
            if kw_words.is_empty() {
                continue;
            }
            let hits = kw_words.iter().filter(|w| word_in(w, &prompt_words)).count();
            if kw_words.len() == 1 {
                // A ONE-WORD keyword is the whole signal, not a fragment of a
                // longer phrase: `باگ` / `فیلم` / `translate` matching its word
                // means exactly what a multi-word phrase matching would mean.
                // Scoring it +1 made every single-word keyword (which is most
                // of them) unable to reach the threshold on its own — the
                // reported "auto-skill never picks anything" bug. Only a partial
                // hit of a MULTI-word keyword stays at +1 per word.
                if hits == 1 {
                    score += 3;
                }
            } else {
                // Multi-word keyword ("landing page design") still matches a
                // shorter paraphrase ("landing page") word by word.
                score += hits;
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
/// Bytes reserved so the "list truncated" note always fits inside the cap.
const CATALOG_TRUNCATE_NOTE_RESERVE: usize = 160;

fn catalog(all: &[Value]) -> String {
    let mut out = String::new();
    let mut truncated = false;
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
        if out.len() + line.len() + CATALOG_TRUNCATE_NOTE_RESERVE > CATALOG_MAX_CHARS {
            truncated = true;
            break;
        }
        out.push_str(&line);
    }
    // Say so instead of silently ending the list: the model then knows a skill
    // may exist that it cannot see, and can still load one the user names.
    if truncated {
        out.push_str(
            "- …(more skills are installed than fit here — call load_skill with \
             the name if the user names one)\n",
        );
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
    let mut volatile = String::new();

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
        // Keep only the clear winners: a skill that merely crossed the absolute
        // threshold while the winner scored far higher is noise on this prompt,
        // not a match (see AUTO_MATCH_WINDOW).
        if let Some(best) = scored.first().map(|(score, _)| *score) {
            let floor = best.saturating_sub(AUTO_MATCH_WINDOW);
            scored.retain(|(score, _)| *score >= floor);
        }
        scored.truncate(MAX_AUTO_MATCHED);
        for (_, s) in scored {
            let name = s["name"].as_str().unwrap_or_default().trim().to_string();
            if name.is_empty() {
                continue;
            }
            matched.push(name);
        }
        if !matched.is_empty() {
            volatile.push_str(
                "\n\n=== AUTO-MATCHED SKILLS ===\n\
                 These skills were picked for THIS request from its keywords. Adopt \
                 their role and follow their instructions (the decision is already \
                 made — do NOT call load_skill for them).\n",
            );
            let bodies: Vec<String> = matched_bodies(&all, &matched);
            volatile.push_str(&bodies.join("\n\n"));
        }
    }

    SkillSection { text, volatile, missing, matched }
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
    #[ignore = "diagnostic: run with --ignored to see which real prompts auto-match"]
    fn diagnose_auto_match_against_the_real_store() {
        // Runs the REAL router over the REAL skill store, so "why did no skill
        // match?" is answered by the code that decides it rather than by a
        // re-implementation of the scoring rules.
        //
        // NOTE: the store at {data_root}/skills is only re-synced from
        // `src-tauri/skills/*.md` at app STARTUP (`seed_builtin_skills`), so a
        // fresh checkout that has not launched the app yet still holds the OLD
        // keywords. Pass `CODER_SKILL_ROOT=src-tauri` to measure the SHIPPED
        // set instead, which is what a new build actually loads.
        let root = match std::env::var("CODER_SKILL_ROOT") {
            Ok(r) => r,
            Err(_) => match std::env::var("CODER_DATA_DIR") {
                Ok(d) => d,
                Err(_) => std::env::var("HOME")
                    .map(|h| format!("{h}/.codifa"))
                    .unwrap_or_default(),
            },
        };
        let prompts = [
            "این باگ رو درست کن",
            "این کد رو ریفکتور کن",
            "می‌خوام این کامپوننت رو طراحی کنم، ظاهر تمیزی می‌خوام",
            "این متن رو خلاصه کن",
            "یه فیلم خوب معرفی کن",
            "چرا اتو اسکیل هیچ اسکیلی رو انتخاب نمیکنه؟",
            "کاهش مصرف توکن و کاهش راندتریپ explore",
            "fix this bug",
            "debug this crash",
            "refactor this module",
            "design a landing page",
            "please translate this paragraph",
            "commit this and push",
            "test the ui in a browser",
            "analyze this dataset",
            "brainstorm ideas for me",
            "research the latest react docs",
            "سئو سایت رو بهتر کن",
            // Negatives: none of these may inline a skill.
            "this is a preference setting",
            "rename this variable",
            "update the changelog",
            "optimize the sql query",
            "deploy the docker image to staging",
            "move this helper into its own file",
        ];
        println!("skills root: {root}");
        let mut hit = 0usize;
        for p in prompts {
            let sec = build_section(p, &root, &[]);
            if sec.matched.is_empty() {
                println!("  [--] {p}");
            } else {
                hit += 1;
                println!("  [OK] {p} -> {:?}", sec.matched);
            }
        }
        println!("matched {hit}/{}", prompts.len());
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
    fn auto_match_ignores_substrings_inside_other_words() {
        // "read" lives inside "already"/"spread": plain substring matching
        // pulled the wrong skill into prompts that never mentioned it.
        let s = skill("Read File", "read a file");
        assert!(skill_score(&s, &normalize_text("already spread the changes")) < MATCH_MIN_SCORE);
        // A real mention of the word still scores on the two name signals.
        assert!(skill_score(&s, &normalize_text("please read the file")) >= MATCH_MIN_SCORE);
    }

    #[test]
    fn short_persian_words_are_match_signals() {
        // Persian is built from short words (`باگ`, `کد`, `گیت`, `سئو`). A
        // 4-char floor dropped them, so `این باگ رو درست کن` kept only `درست`
        // and no skill could match — the reported "auto-skill never picks
        // anything" bug. The floor is 3 now.
        assert!(words_of("این باگ رو درست کن").contains(&"باگ".to_string()));
        let mut s = skill("Code-Expert", "debugging help");
        s["fa_keywords"] = json!(["باگ"]);
        assert!(skill_score(&s, &normalize_text("این باگ رو درست کن")) >= MATCH_MIN_SCORE);
    }

    #[test]
    fn one_word_keyword_is_the_whole_signal() {
        // Most keywords are a SINGLE word. Scoring a match +1 meant such a
        // keyword could never reach the threshold alone, so the skill with the
        // exact word the user typed still lost. One word is a complete signal.
        let mut s = skill("Code-Expert", "debugging help");
        s["fa_keywords"] = json!(["ریفکتور"]);
        assert!(skill_score(&s, &normalize_text("این کد رو ریفکتور کن")) >= MATCH_MIN_SCORE);
        // A fragment of a MULTI-word keyword is still worth only one point.
        // The skill NAME must not appear in the prompt, or the name signals
        // (worth up to 2) would carry the assertion instead of the fragment.
        let mut multi = skill("Page Builder", "landing pages");
        multi["fa_keywords"] = json!(["landing page design"]);
        let partial = skill_score(&multi, &normalize_text("the landing is done"));
        assert!(partial < MATCH_MIN_SCORE, "{partial}");
    }

    #[test]
    fn word_forms_share_a_stem_but_longer_derivations_do_not() {
        // The user types one form, the skill lists another.
        assert!(same_stem("refactor", "refactoring"));
        assert!(same_stem("debug", "debugging"));
        assert!(same_stem("analyze", "analysis"));
        assert!(same_stem("brainstorm", "brainstorming"));
        assert!(same_stem("translate", "translation"));
        // But a 3-letter derivation is a DIFFERENT word: `data`/`dataset` and
        // `test`/`testing` must not collide, or the wrong skill fires.
        assert!(!same_stem("data", "dataset"));
        assert!(!same_stem("test", "testing"));
        // Unrelated words never share a stem.
        assert!(!same_stem("preference", "refactor"));
    }

    #[test]
    fn a_skill_created_with_persian_commas_is_auto_matched() {
        // The `create_skill` schema asks for `fa_keywords` as ONE string, and a
        // Persian list is naturally typed with `،`. The WRITE path split only
        // on the ASCII comma, so `فیلم، سریال` became one keyword containing a
        // comma; the reader happened to recover, but the stored value was wrong
        // (and the empty-check / dedupe saw a single bogus keyword). A skill the
        // user creates must be auto-matched by the same rules as a shipped one.
        let dir = std::env::temp_dir().join(format!("codifa-skill-create-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::skills::sync_skill(
            &dir,
            &json!({
                "name": "My Persian Notes",
                "description": "notes helper",
                "content": "how to take notes",
                "fa_keywords": "یادداشت، نوت برداری، note taking",
            }),
        )
        .expect("sync_skill writes the skill");
        // Read it back through the same path the router uses: three separate
        // keywords, not one string containing a comma.
        let stored = skills::list_skills(&dir);
        let kws = stored["skills"][0]["fa_keywords"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(kws.len(), 3, "{kws:?}");
        let root = dir.to_str().unwrap();
        // The newly created skill is picked up by the router with no restart:
        // every read goes to disk (no cache), so a create/edit is live at once.
        let section = build_section("یه یادداشت خوب بنویس", root, &[]);
        assert!(
            section.matched.contains(&"My Persian Notes".to_string()),
            "{:?}",
            section.matched
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_edited_skill_replaces_its_old_keywords() {
        // Editing a skill must be as reliable as creating one: the new
        // keywords replace the old ones, and the OLD wording stops matching.
        let dir = std::env::temp_dir().join(format!("codifa-skill-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = crate::skills::sync_skill(
            &dir,
            &json!({
                "name": "Deploy Helper",
                "description": "deployment",
                "content": "deploy it",
                "fa_keywords": "استقرار, docker",
            }),
        )
        .expect("first write");
        assert!(first["ok"].as_bool() != Some(false), "{first}");
        let root = dir.to_str().unwrap();
        assert!(build_section("کمک به استقرار", root, &[])
            .matched
            .contains(&"Deploy Helper".to_string()));
        // Edit: new keywords, same name — the old one must no longer fire.
        crate::skills::sync_skill(
            &dir,
            &json!({
                "name": "Deploy Helper",
                "previous_name": "Deploy Helper",
                "description": "deployment",
                "content": "deploy it",
                "fa_keywords": "kubernetes, release",
            }),
        )
        .expect("second write");
        let after = build_section("کمک به استقرار", root, &[]);
        assert!(
            !after.matched.contains(&"Deploy Helper".to_string()),
            "stale keyword still matched: {:?}",
            after.matched
        );
        assert!(build_section("a kubernetes release", root, &[])
            .matched
            .contains(&"Deploy Helper".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_generic_user_keyword_does_not_fire_elsewhere() {
        // The single-word rule is what made real matches work, so a generic
        // keyword on a USER skill must stay contained: `update` is the worst
        // offender measured (it fires on "update the changelog"), but with a
        // clear winner present the relative window keeps the user skill out.
        let dir = std::env::temp_dir().join(format!("codifa-skill-generic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::skills::sync_skill(
            &dir,
            &json!({
                "name": "My Helper",
                "description": "generic helper",
                "content": "help",
                "fa_keywords": "update",
            }),
        )
        .expect("write");
        let root = dir.to_str().unwrap();
        // No strong competitor in this store, so the generic word DOES fire —
        // that is the accepted cost of the single-word rule (measured: at most
        // 2 of 35 prompts, and only ones that really say "update").
        // The guard that matters: a prompt without the word never fires.
        assert!(!build_section("deploy the docker image", root, &[])
            .matched
            .contains(&"My Helper".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skill_name_words_match_exactly_but_keywords_tolerate_inflection() {
        // `optimize the sql query` reached `seo-optimization` through the NAME
        // word `optimization` under stem matching, inlining an SEO skill into a
        // database question. Name words are generic labels, so they must match
        // exactly; the author-written keywords keep inflection tolerance.
        let mut seo = skill("seo-optimization", "seo help");
        seo["fa_keywords"] = json!(["سئو", "seo optimization"]);
        let hay = normalize_text("optimize the sql query");
        // The NAME word `optimization` no longer matches `optimize` (exact only).
        // The keyword `seo optimization` still contributes one point through its
        // `optimization` word — 1, not the 2 needed, so the skill stays out.
        let score = skill_score(&seo, &hay);
        assert!(
            score < MATCH_MIN_SCORE,
            "an SEO skill must not match a database question (score {score})"
        );
        // Proof the fix is the NAME path: with no keywords at all the same skill
        // scores zero on that prompt, where stem matching gave it name points.
        seo["fa_keywords"] = json!([]);
        assert_eq!(
            skill_score(&seo, &hay),
            0,
            "a name word must not stem-match a different request"
        );
        // A keyword the author wrote DOES tolerate an inflection.
        let mut research = skill("Deep Research", "look things up");
        research["fa_keywords"] = json!(["research"]);
        assert!(skill_score(&research, &normalize_text("research the react docs")) >= MATCH_MIN_SCORE);
    }

    #[test]
    fn auto_match_drops_trailing_noise_next_to_a_clear_winner() {
        // With only an absolute threshold, a prompt that clearly names one topic
        // still inlined an unrelated skill that scraped MATCH_MIN_SCORE. The
        // relative window keeps the winner and its near-ties only.
        let dir = std::env::temp_dir().join(format!("codifa-skill-window-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (slug, keywords) in [
            ("summarization", "خلاصه, خلاصه کن, چکیده"),
            ("translation", "translate this"),
        ] {
            let sdir = dir.join("skills").join(slug);
            std::fs::create_dir_all(&sdir).unwrap();
            std::fs::write(
                sdir.join("skill.md"),
                format!("---\nname: {slug}\ndescription: d\nfa_keywords: {keywords}\n---\nBODY\n"),
            )
            .unwrap();
        }
        let root = dir.to_str().unwrap();
        // A strong summarization hit must not drag `translation` along.
        let section = build_section("این متن رو خلاصه کن", root, &[]);
        assert!(
            section.matched.contains(&"summarization".to_string()),
            "{:?}",
            section.matched
        );
        assert!(
            !section.matched.contains(&"translation".to_string()),
            "{:?}",
            section.matched
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_splits_persian_comma_keywords() {
        // A list typed with the Persian comma (`فیلم، سریال`) used to survive as
        // ONE garbled keyword, so no Persian request could ever match it.
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
        // Each keyword stands alone: mentioning only the second one is enough.
        let section = build_section("یه سریال خوب معرفی کن", root, &[]);
        assert!(
            section.matched.contains(&"Movie Finder".to_string()),
            "{:?}",
            section.matched
        );
        // ...and the matched body is PER-TURN text, so it must land in
        // `volatile`, never in the byte-stable `text` that becomes the system
        // prompt: a prompt-only match that rewrote `system` invalidated the
        // cached prefix of the whole conversation.
        assert!(
            section.volatile.contains("=== AUTO-MATCHED SKILLS ===")
                && section.volatile.contains("BODY"),
            "{}",
            section.volatile
        );
        assert!(!section.text.contains("AUTO-MATCHED"), "{}", section.text);
        let _ = std::fs::remove_dir_all(&dir);
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
