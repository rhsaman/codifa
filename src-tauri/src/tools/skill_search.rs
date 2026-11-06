use super::*;

/// Same as [`dispatch`], but the skill and connector tools resolve their store
/// against `data_root` instead of the workspace root.
///
/// Both stores live in the DATA root (`~/.codifa/skills`, `~/.codifa/mcp`),
/// never in the workspace. The system-prompt catalog is built from the data
/// root, so resolving `load_skill` against the workspace listed an EMPTY store:
/// every on-demand load answered `skill not found: X. Available: (none)` even
/// though the catalog just above it advertised that very skill (found in a real
/// trace). The same root mismatch made `create_mcp` write connectors into
/// `<workspace>/mcp` where nothing reads them. `None` keeps the previous
/// behaviour, which the tool tests rely on (they build the store inside their
/// own temp root).
/// The body block for one skill, shared by the by-name and by-query paths.
pub(super) fn skill_body(sk: &Value) -> String {
    let files: Vec<&str> = sk["files"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut out = format!(
        "===== SKILL: {} =====\nDescription: {}\n",
        sk["name"].as_str().unwrap_or_default(),
        sk["description"].as_str().unwrap_or_default()
    );
    if !files.is_empty() {
        out.push_str(&format!(
            "Extra files: {} — load a specific file with load_skill(file=<name>) only when needed.\n",
            files.join(", ")
        ));
    }
    out.push_str(&format!("\n{}\n", sk["content"].as_str().unwrap_or_default()));
    out
}

/// Skill names to suggest after a miss, bounded (`SKILL_LIST_MAX`) so a big
/// store cannot flood the turn that failed to find one skill.
pub(super) fn available_hint(all: &[Value]) -> String {
    let names: Vec<&str> = all.iter().filter_map(|sk| sk["name"].as_str()).collect();
    if names.is_empty() {
        return "(none)".to_string();
    }
    if names.len() <= SKILL_LIST_MAX {
        return names.join(", ");
    }
    format!(
        "{} … (and {} more — load_skill with query=<words> searches all of them)",
        names[..SKILL_LIST_MAX].join(", "),
        names.len() - SKILL_LIST_MAX
    )
}

/// Everything about one skill a search query is matched against: name, slug,
/// description and the user's own `fa_keywords` — a Persian word has to find
/// its skill exactly as it does in the prompt catalog.
pub(super) fn skill_haystack(sk: &Value) -> String {
    let mut hay = String::new();
    for key in ["name", "slug", "description", "plugin"] {
        if let Some(v) = sk[key].as_str() {
            hay.push_str(v);
            hay.push(' ');
        }
    }
    if let Some(kw) = sk["fa_keywords"].as_array() {
        for k in kw.iter().filter_map(Value::as_str) {
            hay.push_str(k);
            hay.push(' ');
        }
    }
    hay.to_lowercase()
}

/// Warn when a bundle's scripts hard-code a `$HOME` path outside their own
/// folder.
///
/// The model writes the source, and a
/// literal home path looks perfectly fine until the bundle runs somewhere else —
/// or, worse, until a scheduled run (who nobody can answer a permission gate)
/// touches it. The warning rides AFTER the JSON so the reply stays
/// machine-readable up to the first newline.
pub(super) fn plugin_detached_path_warning(store: &Path, view: &Value) -> String {
    let Some(slug) = view["slug"].as_str() else {
        return String::new();
    };
    let paths = crate::plugins::script_outside_paths(store, slug);
    if paths.is_empty() {
        return String::new();
    }
    format!(
        "\nWARNING: these absolute $HOME paths are hard-coded in the bundle's scripts but sit \
         OUTSIDE the bundle folder: {}. A bundle must resolve its own files relative to itself \
         (the runner starts a script with the bundle as its working directory) — a literal stops \
         being true when the bundle is installed elsewhere, and any other $HOME path is outside \
         every root a scheduled run may touch, which stalls the run on a permission gate nobody \
         can answer. Rewrite them with action=update.",
        paths.join(", ")
    )
}

/// Function words that say nothing about WHICH skill applies: a query like
/// "open website in browser instagram" must not score a skill for "open" or
/// "in". Domain words stay out of this list on purpose — "browser", "create",
/// "plugin", "script" are exactly the words that discriminate.
pub(super) const SKILL_STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "from", "with",
    "without", "by", "as", "is", "are", "be", "been", "was", "were", "am", "do", "does",
    "did", "how", "what", "when", "where", "which", "who", "why", "i", "you", "my", "your",
    "me", "it", "its", "this", "that", "these", "those", "there", "here", "can", "could",
    "should", "would", "will", "shall", "may", "might", "must", "have", "has", "had", "not",
    "no", "yes", "if", "then", "than", "so", "such", "own", "same", "also", "just", "about",
    "into", "over", "under", "up", "down", "out", "off", "again", "once", "all", "any",
    "both", "each", "few", "more", "most", "other", "some", "only", "very", "get", "let",
    "us", "we", "he", "she", "they", "them", "their", "his", "her", "him",
    // Persian function words — a Persian query must not score a skill for
    // "را" or "برای" any more than an English one for "the" or "for".
    "در", "به", "از", "که", "را", "با", "این", "برای", "است", "هست", "می",
    "تا", "هم", "یا", "یک", "های", "شود", "کند", "باید", "روی",
];

/// How strongly one field of one skill matches one query term.
///
/// A whole-word hit scores 1.0 — including the cheap-stem case ("skill" vs
/// "skills", "connector" vs "connectors": a shared prefix of 4+ chars), which
/// is plain plural morphology and must count as the word itself. A term
/// contained inside a LONGER token ("charting" inside "chartingview") scores
/// 0.5; the REVERSE direction never matches — "site" inside the query word
/// "website" once outranked the skill actually named "browser" by borrowing
/// the whole term's weight for a three-letter fragment. Short terms (2-3
/// chars: "ai", "ui") never substring-match either: "ai" sits inside
/// "trading" and "ui" inside "guild", and a 2-letter term must not buy
/// relevance from either. Unicode-aware, so Persian terms work both ways.
pub(super) fn term_in_field(field: &str, term: &str) -> f64 {
    let lower = field.to_lowercase();
    let tlen = term.chars().count();
    let mut best: f64 = 0.0;
    for tok in lower.split(|c: char| !c.is_alphanumeric()) {
        if tok == term {
            return 1.0;
        }
        let klen = tok.chars().count();
        let stem = tlen.min(klen) >= 4 && (tok.starts_with(term) || term.starts_with(tok));
        if stem {
            best = best.max(1.0);
        } else if tlen >= 4 && tok.contains(term) {
            best = best.max(0.5);
        }
    }
    best
}

/// The string of one skill field as the matcher sees it.
pub(super) fn skill_field<'a>(sk: &'a Value, key: &str) -> String {
    match key {
        "fa_keywords" => sk[key]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
            .unwrap_or_default(),
        _ => sk[key].as_str().unwrap_or_default().to_string(),
    }
}

/// Field weights, strongest first: the name is the sharpest signal of WHAT a
/// skill is, the slug says the same thing in URL form, `fa_keywords` is the
/// user's own Persian trigger list, the description is prose that may mention
/// many things, and the owning bundle is the weakest (a bundle name says
/// little about one skill inside it).
pub(super) const SKILL_FIELD_WEIGHTS: [(&str, f64); 5] = [
    ("name", 4.0),
    ("slug", 3.0),
    ("fa_keywords", 2.5),
    ("description", 2.0),
    ("plugin", 1.0),
];

/// A dominant best hit must clear this score: one weak substring hit of a
/// common word is ~1.0, one real word match scores 4+, so 1.5 admits any real
/// match while refusing "best" that matched one filler word loosely.
pub(super) const SKILL_CONFIDENT_MIN_SCORE: f64 = 1.5;

/// How far the best hit must sit above the runner-up to answer on the first
/// call (the confident-match rule): `best >= 1.6 × next`. Below that the query
/// was genuinely ambiguous and listing candidates IS the right answer.
pub(super) const SKILL_DOMINANT_RATIO: f64 = 1.6;

/// Find a skill by words when the prompt's catalog does not cover the task.
///
/// The catalog is byte-capped, so a store with hundreds of skills cannot list
/// them all — this is the way in for everything it had to leave out. Scoring:
/// stopwords out, IDF over the installed store (a word every skill carries
/// cannot discriminate), field weights (name > slug > fa_keywords >
/// description > bundle), whole-word above substring. A confident top hit
/// returns its body on the FIRST call — the second call naming it was a wasted
/// round (traced `mvyy1qf7`: one query listed Test UI beside three skills that
/// matched one filler word, and the model spent another round naming it).
/// Otherwise the compact candidate list goes back, never a full catalog.
pub(super) fn search_skills(store_base: &str, query: &str) -> Result<String, String> {
    // Word-boundary split (`is_alphanumeric` is Unicode-aware, so Persian words
    // survive whole). One-character words and function words are dropped.
    let terms: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() > 1)
        .filter(|t| !SKILL_STOPWORDS.contains(t))
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Err(format!("load_skill query {query:?} has no word to search for"));
    }
    let all = crate::skill_router::load_skills(store_base);
    if all.is_empty() {
        return Err(format!("no skills are installed — nothing matches {query:?}"));
    }

    // IDF over THIS store: a term in every skill cannot help pick one, so its
    // weight collapses toward ~1.0; a term only one skill carries weighs ln(N).
    // The document frequency reads the skill's OWN fields (name, slug,
    // description, fa_keywords) — the owning bundle's label is context for the
    // score but not the skill's identity, and counting it once made every
    // skill of a bundle named "Skills" dilute the very word "skills".
    // Smoothed so a term in every row still counts a little.
    let n = all.len() as f64;
    let own_fields = |sk: &Value| -> Vec<String> {
        ["name", "slug", "description", "fa_keywords"]
            .iter()
            .map(|k| skill_field(sk, k))
            .collect()
    };
    let idfs: Vec<f64> = terms
        .iter()
        .map(|t| {
            let df = all
                .iter()
                .filter(|sk| own_fields(sk).iter().any(|f| term_in_field(f, t) > 0.0))
                .count() as f64;
            ((n + 1.0) / (df + 1.0)).ln() + 1.0
        })
        .collect();

    let score_of = |sk: &Value| -> f64 {
        let fields: Vec<(f64, String)> = SKILL_FIELD_WEIGHTS
            .iter()
            .map(|(key, w)| (*w, skill_field(sk, key)))
            .collect();
        let mut score = 0.0;
        for (t, idf) in terms.iter().zip(&idfs) {
            for (w, field) in &fields {
                score += idf * w * term_in_field(field, t);
            }
        }
        score
    };

    let mut scored: Vec<(f64, &Value)> = all
        .iter()
        .map(|sk| (score_of(sk), sk))
        .filter(|(s, _)| *s > 0.0)
        .collect();
    // Best hit first; `sort_by` is stable, so ties keep the store's own order
    // and the same query always answers the same thing.
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let best = scored.first().map(|(s, _)| *s).unwrap_or(0.0);
    let dominant = best >= SKILL_CONFIDENT_MIN_SCORE
        && scored
            .get(1)
            .map(|(next, _)| best >= next * SKILL_DOMINANT_RATIO)
            .unwrap_or(true);
    match scored.len() {
        0 => Err(format!(
            "no skill matches {query:?}. Available: {}",
            available_hint(&all)
        )),
        // Exactly one skill fits the words: returning its body saves the model
        // the second call it would have spent naming it.
        1 => Ok(skill_body(&scored[0].1)),
        _ if dominant => Ok(skill_body(&scored[0].1)),
        _ => {
            let mut out = String::from(
                "Several skills match — call load_skill again with the `name` of the right one:\n",
            );
            for (_, sk) in scored.iter().take(SKILL_SEARCH_MAX) {
                out.push_str(&format!(
                    "- {}: {}\n",
                    sk["name"].as_str().unwrap_or_default(),
                    sk["description"].as_str().unwrap_or_default().trim()
                ));
            }
            Ok(out)
        }
    }
}

/// `load_skill bundle=<slug>`: the skills of ONE plugin bundle, one
/// `- name: description` line each. The prompt catalog is byte-capped and can
/// leave a whole bundle unnamed — this is the drill-in that keeps every skill
/// of an installed bundle reachable without a second catalog in the prompt.
pub(super) fn list_bundle_skills(store_base: &str, slug: &str) -> Result<String, String> {
    let rows: Vec<Value> = crate::skill_router::load_skills(store_base)
        .into_iter()
        .filter(|sk| {
            sk["plugin_slug"]
                .as_str()
                .is_some_and(|p| p.eq_ignore_ascii_case(slug))
        })
        .collect();
    if rows.is_empty() {
        return Err(format!(
            "bundle {slug:?} has no skills (or is not enabled) — plugin action=list names the \
bundles and their skill counts"
        ));
    }
    let mut out = format!(
        "Skills of bundle {slug} — load one with load_skill name=<name>:\n"
    );
    for sk in &rows {
        out.push_str(&format!(
            "- {}: {}\n",
            sk["name"].as_str().unwrap_or_default(),
            sk["description"].as_str().unwrap_or_default().trim()
        ));
    }
    Ok(out)
}

