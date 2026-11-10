//! Native skill selection: the available-skills catalog + the SKILLS prompt section.
//!
//! Mirrors how Codex and Claude expose skills: the system prompt carries a
//! compact catalog (name + description) of every installed skill, and the model
//! loads the toolbox it needs through the `load_plugin` tool. Nothing is
//! embedded, indexed or classified up front, so a turn costs no local inference
//! and no extra model call — only the skills the user attached (`@mention`) are
//! inlined whole.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::skills;

/// Bodies longer than this are not inlined: the description plus a `load_plugin`
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
/// `load_plugin` pointer is emitted instead, so one huge skill cannot flood the
/// prompt.
fn format_skill_body(s: &Value) -> String {
    let name = s["name"].as_str().unwrap_or_default();
    let description = s["description"].as_str().unwrap_or_default();
    let files: Vec<&str> = s["files"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(str::trim).filter(|f| !f.is_empty()).collect())
        .unwrap_or_default();
    let plugin = s["plugin_slug"].as_str().unwrap_or_default().trim();
    let extra = if files.is_empty() {
        String::new()
    } else {
        format!(
            "\nExtra files: {} — call load_plugin with slug={} skill=<name> file=<file> only when needed.",
            files.join(", "),
            if plugin.is_empty() { "<plugin>" } else { plugin }
        )
    };
    let content = s["content"].as_str().unwrap_or_default();
    if content.chars().count() > AUTO_MAX_BODY_CHARS {
        return format!(
            "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n\
             This skill's body is long and was NOT inlined. Call load_plugin with \
             slug={} skill={name} before following it.\n===== END SKILL: {name} =====",
            if plugin.is_empty() { "<plugin>" } else { plugin }
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

/// Bytes of skill NAMES one plugin line may carry.
///
/// The old line showed the first six names and hid the rest behind `+N more`:
/// a 24-skill library then advertised `test-ui` nowhere, so the one skill a
/// live-test request needed was undiscoverable. Names are the trigger — a
/// medium bundle (the built-in library, a design pack, a testing pack) now
/// shows ALL of them, while a 82-skill pack still fits the catalog by clipping
/// its tail. This is a per-BUNDLE budget, not a built-in special case: any
/// bundle of any size gets the same treatment.
const CATALOG_SKILL_NAMES_MAX_CHARS: usize = 520;

/// A hard cap on rows any bundle's skill list can add, so one pathological
/// bundle cannot push every other plugin out of the catalog.
const CATALOG_SKILL_NAMES_MAX: usize = 70;

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

/// `- slug (Name): description [skills: …]` — ONE line per ENABLED plugin.
///
/// The plugin is the unit: the top-level description is the trigger, and the
/// skill names ride along so the agent can find WHICH plugin carries the skill a
/// request names (it may then load the plugin, or the plugin narrowed to that
/// one skill with `slug` + `skill`). This is what makes 24 plugins fit where
/// 184 skill rows could not: the old catalog dropped 102 skills, including the
/// one the request needed.
fn plugin_catalog_at(root: &str, max: usize) -> String {
    render_plugin_catalog(
        &crate::plugins::enabled_plugin_catalog(std::path::Path::new(root)),
        max,
    )
}

/// `plugin_catalog_at` with the rows already resolved (testable without disk).
fn render_plugin_catalog(rows: &[Value], max: usize) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let heads: Vec<String> = rows
        .iter()
        .map(|p| {
            let slug = p["slug"].as_str().unwrap_or_default().trim();
            let name = p["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() || name.eq_ignore_ascii_case(slug) {
                format!("- {slug}")
            } else {
                format!("- {slug} ({name})")
            }
        })
        .collect();
    let tails: Vec<String> = rows
        .iter()
        .map(|p| {
            let names: Vec<&str> = p["skills"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if names.is_empty() {
                return String::new();
            }
            // Show every name of a medium bundle; clip the tail of a huge one.
            // Losing a NAME hides the only hint that a skill exists, so names
            // are kept whole and the DESCRIPTION absorbs the clipping above.
            let mut shown: Vec<&str> = Vec::new();
            let mut used = 0usize;
            for name in &names {
                let cost = name.len() + 2; // ", " separator
                if !shown.is_empty()
                    && (used + cost > CATALOG_SKILL_NAMES_MAX_CHARS
                        || shown.len() >= CATALOG_SKILL_NAMES_MAX)
                {
                    break;
                }
                used += cost;
                shown.push(name);
            }
            let more = names.len().saturating_sub(shown.len());
            format!(
                " [skills: {}{}]",
                shown.join(", "),
                if more > 0 {
                    format!(" +{more} more")
                } else {
                    String::new()
                }
            )
        })
        .collect();
    let bare: usize = heads
        .iter()
        .zip(&tails)
        .map(|(h, t)| h.len() + t.len() + 1)
        .sum();
    let room = max.saturating_sub(bare + CATALOG_TRUNCATE_NOTE_RESERVE);
    let per_row = (room / rows.len()).min(CATALOG_DETAIL_PER_ROW);

    let mut lines: Vec<String> = Vec::with_capacity(rows.len());
    let mut detail_clipped = false;
    for (i, p) in rows.iter().enumerate() {
        let desc = p["description"].as_str().unwrap_or_default().trim();
        let natural = catalog_detail(desc, CATALOG_DETAIL_PER_ROW);
        let detail = if natural.len() <= per_row {
            natural
        } else {
            detail_clipped = true;
            catalog_detail(desc, per_row)
        };
        lines.push(format!("{}{}{}", heads[i], detail, tails[i]));
    }

    let mut out = String::new();
    let mut dropped = 0usize;
    for line in &lines {
        if out.len() + line.len() + 1 + CATALOG_TRUNCATE_NOTE_RESERVE > max {
            dropped = lines.len() - out.lines().count();
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    if dropped > 0 {
        out.push_str(&format!(
            "- …({dropped} more plugin(s) are installed than fit here — call load_plugin with \
             query=<words> to search every installed plugin)\n"
        ));
    } else if detail_clipped {
        out.push_str(
            "- …(descriptions are trimmed to fit; call load_plugin with a plugin's slug to load \
             its whole toolbox)\n",
        );
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

/// Change-detector for the one on-disk store the catalog reads: every path
/// under `<root>/plugins` folded in as (path, mtime, size).
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
/// model's call (`load_plugin`), the way Codex and Claude do it.
pub fn build_section(root: &str, manual_names: &[String]) -> SkillSection {
    build_section_with_cap(root, manual_names, configured_catalog_max(root))
}

/// Total body budget for the skills a SUB-AGENT carries from its attached
/// bundles.
///
/// A bundle can be a LIBRARY: the trading pack ships 82 skills / ~820 KB, and
/// inlining all of them would spend the child's whole context before it reads a
/// single file (its prompt is re-sent on EVERY round of a 12-step budget).
/// Skills that NAME the agent's role are inlined inside this budget; the rest
/// are indexed with the path to their `SKILL.md`, which the agent can `read` in
/// one call when a task actually needs one.
pub const SUBAGENT_ATTACHED_MAX_CHARS: usize = 28_000;

/// Cap on the index of skills left out by the budget. Names + a short
/// description + a path per row; a normal bundle never loses a name.
const SUBAGENT_INDEX_MAX_CHARS: usize = 12_000;

/// Longest description one index row keeps.
const INDEX_DESC_MAX_CHARS: usize = 160;

/// Words too common to prove that a skill belongs to an agent. Without this a
/// prompt saying "trading" matched every skill in a trading pack, and the
/// budget then inlined arbitrary ones instead of the relevant few.
const FOCUS_STOPWORDS: &[&str] = &[
    "able", "about", "after", "again", "against", "agent", "agents", "also", "always",
    "among", "another", "because", "been", "before", "being", "between", "both", "could",
    "does", "doing", "done", "during", "each", "either", "ensure", "every", "from",
    "further", "have", "having", "here", "into", "itself", "just", "like", "made", "make",
    "many", "might", "more", "most", "much", "must", "need", "needs", "never", "only",
    "other", "over", "same", "should", "skill", "skills", "some", "such", "task", "tasks",
    "than", "that", "their", "them", "then", "there", "these", "they", "this", "those",
    "through", "under", "until", "upon", "using", "very", "want", "were", "what", "when",
    "where", "which", "while", "will", "with", "within", "without", "work", "working",
    "would", "your", "yourself",
    // Persian function words and light verbs. Without these, a keyword such as
    // "جلوگیری از تکرار" matched every request containing "از", and the real
    // store's Persian Test UI request returned three unrelated plugins.
    "از", "است", "اگر", "آن", "این", "با", "برای", "بر", "به", "بگیر", "بود",
    "بودن", "بله", "تا", "در", "دار", "دارد", "دارم", "ده", "را", "رو", "شده",
    "شدن", "کن", "کرد", "کردن", "کنم", "کنی", "کنید", "که", "کی", "کجا", "می",
    "نمی", "نه", "هم", "چه", "چی", "چطور", "یا", "یه", "یک",
];

/// Fold a handful of common Persian technical words onto the English token the
/// shipped skill names use, so a request written in Persian can still find
/// `Test UI`, `Browser Automation`, or `landing-page-design`.
///
/// This is only a bridge for automatic matching — the catalog and the skill
/// bodies are untouched, and the model still sees the user's original words.
/// The list stays deliberately small: a miss only means the model must find the
/// skill the normal way, while an over-eager alias would pull in the wrong one.
fn canonical_token(token: &str) -> &str {
    match token {
        "تست" => "test",
        "لایو" => "live",
        "پنل" => "panel",
        "مرورگر" => "browser",
        "فرانت" | "فرانت‌اند" => "frontend",
        "بک‌اند" => "backend",
        "طراحی" => "design",
        "لندینگ" => "landing",
        "صفحه" => "page",
        "سایت" | "وبسایت" => "website",
        "تنظیمات" => "settings",
        "کاربر" => "user",
        "خطا" => "error",
        "باگ" => "bug",
        "فیلم" => "movie",
        "ایمیل" => "email",
        "ترجمه" => "translation",
        "نوشتن" => "writing",
        "مقاله" => "article",
        "داده" | "دیتا" => "data",
        "تحلیل" => "analysis",
        "جستجو" | "سرچ" => "search",
        "فروشگاه" => "store",
        "پرداخت" => "payment",
        "عکس" => "image",
        "ویدیو" => "video",
        "موسیقی" => "music",
        "بازی" => "game",
        "امنیت" => "security",
        "دیتابیس" => "database",
        "محتوا" => "content",
        "سرور" => "server",
        "کلاینت" => "client",
        other => other,
    }
}

/// Header shared by both sub-agent shapes: everything inlined, and the
/// matching part of a large bundle.
const SUBAGENT_SKILLS_HEADER: &str =
    "\n\n=== ATTACHED BUNDLE SKILLS ===\n\
     These skills come from the plugin bundles attached to this sub-agent. A skill the parent \
     turn attached is MANDATORY here too: follow its steps and its verification before \
     reporting done. The bundle's other skills are candidates — follow the ones this task \
     needs; extra files are at the paths named inside each skill.\n";

/// The ATTACHED-SKILLS half of [`build_section`], without the plugin catalog.
///
/// This is what a sub-agent inlines from its own bundles: the bodies of the
/// skills they carry. [`build_subagent_section`] adds the plugin catalog on top
/// (a sub-agent has `load_plugin` and must be able to discover any toolbox).
///
/// `focus` is the agent's own name/description/prompt head. A small bundle is
/// inlined whole; a large one only inlines the skills that name the agent's
/// role, and indexes the rest by path so nothing becomes unreachable. See
/// [`SUBAGENT_ATTACHED_MAX_CHARS`].
pub fn build_attached_section(root: &str, manual_names: &[String], focus: &str) -> SkillSection {
    attached_section_for_agent(
        &load_skills(root),
        manual_names,
        focus,
        SUBAGENT_ATTACHED_MAX_CHARS,
    )
}

/// Build the skill/plugin section for a SUB-AGENT.
///
/// A sub-agent now has `load_plugin` (see `research_schemas`), so it gets the
/// same plugin CATALOG as the main agent: that is the only way it can discover
/// and load a toolbox the user installed without the user naming plugins in
/// Settings → Sub-agents. [`build_attached_section`] supplies the bodies of the
/// skills the sub-agent already carries (its bundle / @mentions), budgeted so a
/// library-sized pack cannot eat the child's context.
pub fn build_subagent_section(
    root: &str,
    manual_names: &[String],
    focus: &str,
) -> SkillSection {
    let mut section = build_section_with_cap(root, &[], configured_catalog_max(root));
    let attached = build_attached_section(root, manual_names, focus);
    section.text.push_str(&attached.text);
    section.missing.extend(attached.missing);
    section
}

/// Leading line of the automatic skill-match context message. Kept byte-stable
/// so `is_wire_only_context` can recognise it after a fold.
pub const AUTO_MATCH_HEAD: &str = "=== INSTALLED SKILLS THAT MATCH THIS REQUEST ===";

/// Automatic skill→plugin matches for one request, rendered as a trailing
/// context message.
///
/// The catalog already names every installed skill, but a weak model can skim
/// past a 6 KB list. This is the deterministic second door: tokenise the
/// request, match it against every ENABLED skill's name/slug (and the optional
/// `match_keywords:` it declares), and name the PLUGIN that carries each strong
/// match plus the exact `slug`+`skill` call. It never inlines a body and never
/// picks a skill the model cannot see in the catalog — it only turns "the user
/// did not @mention it" into an explicit, plugin-first hint.
///
/// A single matching token is enough only when that token is RARE across the
/// store (a name like `instagram`, or a distinctive multilingual keyword);
/// common words (`design`, `trading`) need a second hit or a full-name substring,
/// so an ordinary request does not drag in half the library. Legacy keyword
/// values that are really model prose are ignored entirely — see
/// [`keyword_terms`].
pub fn auto_match_hint(root: &str, request: &str) -> Option<String> {
    let all = load_skills(root);
    if all.is_empty() {
        return None;
    }
    let mut terms: Vec<String> = Vec::new();
    for raw in request
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2)
        .filter(|t| !FOCUS_STOPWORDS.contains(t))
    {
        let t = canonical_token(raw);
        if !terms.iter().any(|x| x.as_str() == t) {
            terms.push(t.to_string());
        }
    }
    if terms.is_empty() {
        return None;
    }

    // How many skills carry each token in their NAME or a usable keyword. A
    // rare token is a strong signal; a token shared by half the store is not.
    let mut df: HashMap<String, usize> = HashMap::new();
    for s in &all {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for t in skill_name_tokens(s) {
            seen.insert(t);
        }
        seen.extend(keyword_terms(s));
        for t in seen {
            *df.entry(t).or_insert(0) += 1;
        }
    }

    let mut hits: Vec<(u32, &Value)> = Vec::new();
    for s in &all {
        let name = s["name"].as_str().unwrap_or_default().to_lowercase();
        let slug = s["slug"].as_str().unwrap_or_default().to_lowercase();
        if name.is_empty() && slug.is_empty() {
            continue;
        }
        let name_tokens: std::collections::HashSet<String> =
            skill_name_tokens(s).into_iter().collect();
        let keyword_tokens = keyword_terms(s);
        let slug_tokens: std::collections::HashSet<String> = slug
            .split(['-', '_'])
            .filter(|t| t.chars().count() >= 2)
            .map(|t| canonical_token(t).to_string())
            .collect();
        let mut score = 0u32;
        let mut strong_exact = false;
        let mut exact = 0usize;
        for t in &terms {
            if name_tokens.contains(t) {
                score += 4;
                exact += 1;
                if df.get(t).copied().unwrap_or(0) <= 3 {
                    strong_exact = true;
                }
            } else if keyword_tokens.contains(t) {
                // A skill's own multilingual keyword is a trigger too, but only
                // counts as strong when that word is rare: a short legacy
                // keyword like "تست فرانت" still matches "تست", while a word
                // shared by many skills does not.
                score += 4;
                exact += 1;
                if df.get(t).copied().unwrap_or(0) <= 3 {
                    strong_exact = true;
                }
            } else if slug_tokens.contains(t) {
                score += 3;
                exact += 1;
                if df.get(t).copied().unwrap_or(0) <= 3 {
                    strong_exact = true;
                }
            } else if t.chars().count() >= 4 && (name.contains(t) || slug.contains(t)) {
                score += 2;
            }
        }
        // One exact token is enough only when it is distinctive; two are
        // always a signal.
        if exact >= 2 || strong_exact {
            hits.push((score, s));
        }
    }
    if hits.is_empty() {
        return None;
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| skill_name(a.1).cmp(&skill_name(b.1))));
    let mut out = String::from(AUTO_MATCH_HEAD);
    out.push_str(
        "\nThe request names installed skills. Load the PLUGIN that carries each one — never a \
         bare skill:\n",
    );
    for (_, s) in hits.iter().take(3) {
        let name = skill_name(s);
        let plugin = s["plugin_slug"]
            .as_str()
            .or_else(|| s["plugin"].as_str())
            .unwrap_or_default();
        if plugin.is_empty() {
            continue;
        }
        out.push_str(&format!(
            "- {name} — plugin {plugin}. Load with load_plugin slug={plugin} skill={name} (or \
             slug={plugin} for the whole toolbox).\n"
        ));
    }
    if out.ends_with(":\n") {
        return None;
    }
    out.push_str("--- end of matches ---");
    Some(out)
}

/// The tokens of a skill's declared keywords, filtered so a legacy keyword
/// value that is really model prose cannot poison automatic matching.
///
/// Real stores written by older builds often carry a sentence there ("I can see
/// the skill list you've pasted …") rather than trigger words. Tokenising that
/// sentence made `the` match nearly every skill. A phrase is used only when it
/// still looks like a keyword: bounded length, no sentence punctuation, and no
/// English connector words. Multi-word phrases are still split into tokens —
/// the rarity check in [`auto_match_hint`] decides whether a token is strong
/// enough on its own.
fn keyword_terms(s: &Value) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Some(list) = s["match_keywords"].as_array() else {
        return out;
    };
    for raw in list.iter().filter_map(Value::as_str) {
        let phrase = raw.trim();
        if phrase.is_empty() || phrase.chars().count() > 64 {
            continue;
        }
        if phrase
            .chars()
            .any(|c| matches!(c, '.' | '!' | '?' | ':' | ';' | '`' | '—'))
        {
            continue;
        }
        let toks: Vec<String> = phrase
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.chars().count() >= 2)
            .filter(|t| !FOCUS_STOPWORDS.contains(t))
            .map(|t| canonical_token(t).to_string())
            .collect();
        if toks.is_empty() || toks.len() > 6 {
            continue;
        }
        out.extend(toks);
    }
    out
}

fn skill_name_tokens(s: &Value) -> Vec<String> {
    let mut text = skill_name(s).to_lowercase();
    text.push(' ');
    text.push_str(s["slug"].as_str().unwrap_or_default().to_lowercase().as_str());
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2)
        .map(|t| canonical_token(t).to_string())
        .collect()
}

/// Resolve attached NAMES against the loaded store. A name matches a skill's
/// display name case-insensitively; blanks and duplicates are dropped.
fn pick_attached<'a>(all: &'a [Value], manual_names: &[String]) -> (Vec<&'a Value>, Vec<String>) {
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
        match all
            .iter()
            .find(|s| s["name"].as_str().unwrap_or_default().trim().to_lowercase() == *n)
        {
            Some(s) => {
                if !picked.iter().any(|p| p["name"] == s["name"]) {
                    picked.push(s);
                }
            }
            None => missing.push(n.clone()),
        }
    }
    (picked, missing)
}

/// Shared implementation: pick the named skills out of the loaded store and
/// render their bodies. `missing` names what was asked for and not found.
fn attached_section(all: &[Value], manual_names: &[String]) -> SkillSection {
    let (picked, missing) = pick_attached(all, manual_names);
    let mut text = String::new();
    // A plugin's skills ride in WHOLE when the user attaches the plugin (or an
    // `@mention` names one of its skills): the toolbox is already open, so the
    // bodies are inlined without a tool call.
    if !picked.is_empty() {
        text.push_str(
            "\n\n=== ATTACHED PLUGIN SKILLS ===\n\
             The user attached these skills to THIS turn. They are MANDATORY: follow each \
             one's steps, run the verification it requires, and do not substitute your own \
             approach for its harness. Everything they need is already loaded; do NOT call \
             load_plugin for this plugin again unless you need to re-read one body.\n",
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

fn skill_name(s: &Value) -> String {
    s["name"].as_str().unwrap_or_default().trim().to_string()
}

/// First `max` chars of a string, on a char boundary, with an ellipsis when cut.
fn clip_chars(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// One inlined skill for a SUB-AGENT. A body over [`AUTO_MAX_BODY_CHARS`] is
/// not inlined; its file path is named instead, because a sub-agent has no
/// `load_plugin` and `read` is its only door to the body.
fn format_subagent_skill(s: &Value) -> String {
    let name = skill_name(s);
    let description = s["description"].as_str().unwrap_or_default();
    let path = s["path"].as_str().unwrap_or_default();
    let content = s["content"].as_str().unwrap_or_default();
    let files: Vec<&str> = s["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let dir = std::path::Path::new(path)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let extra = if files.is_empty() {
        String::new()
    } else {
        format!(
            "\nExtra files (in {dir}): {} — `read` one only when needed.",
            files.join(", ")
        )
    };
    if content.chars().count() > AUTO_MAX_BODY_CHARS {
        return format!(
            "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n\
             This skill's body is long and was NOT inlined. `read` it from {path} before \
             following it.\n===== END SKILL: {name} ====="
        );
    }
    format!(
        "===== SKILL: {name} =====\nDescription: {description}{extra}\n\n{content}\n\
         ===== END SKILL: {name} ====="
    )
}

/// One index row for a bundle skill that was NOT inlined: name, a short
/// description to match a task against, and the file to `read` before use.
fn format_skill_index_line(s: &Value) -> String {
    let name = skill_name(s);
    let path = s["path"].as_str().unwrap_or_default();
    let description = clip_chars(
        s["description"].as_str().unwrap_or_default().trim(),
        INDEX_DESC_MAX_CHARS,
    );
    if description.is_empty() {
        format!("- {name} — read {path}")
    } else {
        format!("- {name}: {description} — read {path}")
    }
}

/// A crude stem: enough for `strategy` / `strategies` / `strategist` and
/// `algorithm` / `algorithms` / `algorithmic` to meet on one token.
fn focus_stem(word: &str) -> String {
    word.chars().take(7).collect()
}

/// Distinct content words of a text, stemmed. Shared by the agent-identity
/// side and the skill side so both always compare the same tokens.
fn content_words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .map(|w| w.to_lowercase())
        .filter(|w| w.chars().count() >= 4)
        .filter(|w| !FOCUS_STOPWORDS.contains(&w.as_str()))
        .map(|w| focus_stem(&w))
}

/// Distinct content words of the agent's identity, stemmed.
fn focus_words(text: &str) -> std::collections::HashSet<String> {
    content_words(text).collect()
}

/// How many skill NAMES in this bundle carry each token. A token shared by ten
/// skills ("strategies" in a trading pack) is a weak sign of relevance; one
/// shared by a single skill ("execution") is a strong one. The divisor here is
/// the whole point: without it, name matching ties and the budget inlines
/// whichever skills happen to sort first.
fn name_token_df(rows: &[&Value]) -> HashMap<String, usize> {
    let mut df: HashMap<String, usize> = HashMap::new();
    for s in rows {
        let mut seen: std::collections::HashSet<String> =
            content_words(s["name"].as_str().unwrap_or_default()).collect();
        for token in seen.drain() {
            *df.entry(token).or_insert(0) += 1;
        }
    }
    df
}

/// How strongly a bundle skill names this agent's role. A NAME hit is weighted
/// by how RARE that name token is across the bundle (see [`name_token_df`]) and
/// three description hits weigh far less: every skill of a trading pack
/// mentions trading in its description.
fn skill_relevance(
    s: &Value,
    focus: &std::collections::HashSet<String>,
    df: &HashMap<String, usize>,
) -> usize {
    let mut score = 0usize;
    for token in content_words(s["name"].as_str().unwrap_or_default()) {
        if focus.contains(&token) {
            score += 100 / df.get(&token).copied().unwrap_or(1).max(1);
        }
    }
    let desc_hits = content_words(s["description"].as_str().unwrap_or_default())
        .filter(|w| focus.contains(w))
        .count();
    score + desc_hits
}

/// The sub-agent shape of [`attached_section`]: inline what fits (a small
/// bundle) or only the role-matching skills (a large one), then index the rest.
fn attached_section_for_agent(
    all: &[Value],
    manual_names: &[String],
    focus: &str,
    budget: usize,
) -> SkillSection {
    let (picked, missing) = pick_attached(all, manual_names);
    if picked.is_empty() {
        return SkillSection {
            text: String::new(),
            missing,
        };
    }
    let rendered: Vec<(&Value, String)> = picked
        .iter()
        .map(|s| (*s, format_subagent_skill(s)))
        .collect();
    let total: usize = rendered
        .iter()
        .map(|(_, body)| body.chars().count() + 2)
        .sum();
    let mut text = String::new();
    // A small bundle is its own index: everything fits, so inline it all, like
    // the main agent's @mention path. This is the common case.
    if total <= budget {
        text.push_str(SUBAGENT_SKILLS_HEADER);
        text.push_str(
            &rendered
                .iter()
                .map(|(_, body)| body.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
        return SkillSection { text, missing };
    }

    // A big bundle: inline only the skills that NAME this agent's role, best
    // first, and index the rest. A description-only hit is too weak here —
    // every skill of a trading pack mentions trading.
    let focus_words = focus_words(focus);
    let df = name_token_df(&picked);
    let mut ranked: Vec<(&Value, &str, usize)> = rendered
        .iter()
        .map(|(s, body)| (*s, body.as_str(), skill_relevance(s, &focus_words, &df)))
        .collect();
    ranked.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| skill_name(a.0).cmp(&skill_name(b.0)))
    });
    let mut inline_text = String::new();
    let mut inlined: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (s, body, score) in &ranked {
        if *score < 3 {
            continue;
        }
        let cost = body.chars().count() + 2;
        if used + cost > budget {
            continue;
        }
        inline_text.push_str(body);
        inline_text.push_str("\n\n");
        used += cost;
        inlined.push(skill_name(s));
    }
    if !inlined.is_empty() {
        text.push_str(SUBAGENT_SKILLS_HEADER);
        text.push_str(
            "This bundle carries many skills. The ones matching this agent's role are below; \
             every other skill is indexed at the end — `read` the file of the one a task needs \
             before following it.\n\n",
        );
        text.push_str(inline_text.trim_end());
        text.push('\n');
    }
    let rest: Vec<&Value> = ranked
        .iter()
        .filter(|(s, _, _)| !inlined.iter().any(|n| *n == skill_name(s)))
        .map(|(s, _, _)| *s)
        .collect();
    if !rest.is_empty() {
        text.push_str(&format!(
            "\n\n=== OTHER SKILLS IN THIS BUNDLE ({}) ===\n\
             These were NOT inlined (the bundle is large). Before using one, `read` its file — \
             one call, not a guess.\n",
            rest.len()
        ));
        // Two shapes, richest first: name + description + path, else name +
        // path when the descriptions would push names out. Losing a NAME is
        // losing the only hint that the skill exists, so that is the last
        // thing sacrificed here; the count note covers the rest.
        let full: Vec<String> = rest.iter().map(|s| format_skill_index_line(s)).collect();
        let compact: Vec<String> = rest.iter().map(|s| format_skill_index_compact(s)).collect();
        let index_len = |lines: &[String]| -> usize {
            lines.iter().map(|l| l.chars().count() + 1).sum()
        };
        let chosen: Vec<String> = if index_len(&full) <= SUBAGENT_INDEX_MAX_CHARS {
            full
        } else if index_len(&compact) <= SUBAGENT_INDEX_MAX_CHARS {
            compact
        } else {
            let mut kept: Vec<String> = Vec::new();
            let mut used = 0usize;
            for line in compact {
                let cost = line.chars().count() + 1;
                if used + cost > SUBAGENT_INDEX_MAX_CHARS {
                    break;
                }
                used += cost;
                kept.push(line);
            }
            kept
        };
        let omitted = rest.len().saturating_sub(chosen.len());
        text.push_str(&chosen.join("\n"));
        text.push('\n');
        if omitted > 0 {
            text.push_str(&format!(
                "...and {omitted} more, not listed to keep this prompt small. List the bundle's \
                 skills folder with `glob` if you need the rest.\n"
            ));
        }
    }
    SkillSection { text, missing }
}

/// The compact index row used when descriptions would push NAMES out of the
/// budget: the skill still has to be discoverable, and its path is the way in.
fn format_skill_index_compact(s: &Value) -> String {
    format!(
        "- {} — read {}",
        skill_name(s),
        s["path"].as_str().unwrap_or_default()
    )
}

/// `build_section` with an explicit catalog budget and the resolved setting.
pub fn build_section_with_cap(root: &str, manual_names: &[String], catalog_max: usize) -> SkillSection {
    let all = load_skills(root);
    let mut text = String::new();

    let listed = plugin_catalog_at(root, catalog_max);
    if !listed.is_empty() {
        text.push_str(
            "\n\n=== AVAILABLE PLUGINS ===\n\
             Each line is ONE plugin — a toolbox. It carries its skills, MCP connectors, \
             scripts and commands. The user does NOT have to @mention a skill: match the \
             request against the plugin's description AND against its skill names, then find \
             and load the PLUGIN that carries the match yourself. A request in another \
             language still matches an English line when it names the same task. Call \
             load_plugin with that plugin's `slug` BEFORE doing the work; add \
             `skill=<name>` only when you need ONE skill body instead of the whole toolbox. \
             Never load a bare skill name — a skill is used from inside its plugin.\n\
             This list is CAPPED: an absent entry does NOT mean the plugin or skill is \
             missing — call load_plugin with a `query` of the task's words to search every \
             installed plugin and every skill by name and description.\n",
        );
        text.push_str(&listed);
        // Restate the duty UNDER the list: a long catalog pushes the opening
        // instruction out of a weak model's attention, and the list then reads
        // as reference material. The plugin is the unit here too, and a single
        // skill inside it is reachable with `slug` + `skill`.
        text.push_str(
            "If one of the plugins above covers this request — or one of its skill names \
             clearly does — call load_plugin NOW, before any other tool call, with that \
             plugin's `slug` (add `skill=<name>` when only that one body is needed). Do not \
             answer from memory or invent the workflow when a plugin's skill names it.\n",
        );
    }

    let attached = attached_section(&all, manual_names);
    text.push_str(&attached.text);
    SkillSection {
        text,
        missing: attached.missing,
    }
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
    /// installed has to write the bundle that carries it. `keywords` writes a
    /// `keywords:` line when non-empty; the catalog must carry it and the
    /// matcher must ignore prose values.
    fn write_bundle(root: &std::path::Path, name: &str, description: &str, keywords: &str, body: &str) {
        let slug = name.to_lowercase().replace(' ', "-");
        let bundle = root.join("plugins").join(&slug);
        std::fs::create_dir_all(bundle.join("skills").join(&slug)).unwrap();
        std::fs::write(
            bundle.join("plugin.json"),
            json!({ "name": name, "slug": slug, "enabled": true, "description": description })
                .to_string(),
        )
        .unwrap();
        let mut md = format!("---\nname: {name}\ndescription: {description}\n");
        if !keywords.is_empty() {
            md.push_str(&format!("keywords: {keywords}\n"));
        }
        md.push_str(&format!("---\n{body}\n"));
        std::fs::write(bundle.join("skills").join(&slug).join("skill.md"), md).unwrap();
    }

    fn plugin_row(slug: &str, description: &str) -> Value {
        json!({
            "slug": slug,
            "name": slug,
            "description": description,
            "skills": [format!("{slug} skill")],
        })
    }

    #[test]
    fn catalog_ignores_a_legacy_fa_line() {
        // Skills are matched on the plugin's DESCRIPTION, so a skill whose
        // frontmatter still carries an older build's keyword list must not leak
        // it into the catalog line.
        let dir = std::env::temp_dir().join(format!("codifa-skill-fa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم، سریال, سینما", "BODY");
        let root = dir.to_str().unwrap();

        let listed = plugin_catalog_at(root, CATALOG_MAX_CHARS);
        assert!(listed.contains("find movies"), "{listed}");
        assert!(!listed.contains("[fa:"), "{listed}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_persian_prompt_no_longer_attaches_a_skill_on_its_own() {
        // Selection is the model's call, made from the catalog: a prompt that
        // carries a skill's keyword must NOT inline the body — the model reaches
        // it through load_plugin. An explicit @mention still attaches.
        let dir =
            std::env::temp_dir().join(format!("codifa-skill-nomatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم, سینما", "BODY");
        let root = dir.to_str().unwrap();

        let section = build_section(root, &[]);
        assert!(section.text.contains("- movie-finder"), "{}", section.text);
        assert!(!section.text.contains("BODY"), "{}", section.text);

        // An explicit @mention keeps working on its own.
        let attached = build_section(root, &["Movie Finder".into()]);
        assert!(attached.text.contains("BODY"), "{}", attached.text);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_custom_catalog_cap_is_honoured() {
        // Settings → Skills can raise the cap, so the budget must actually be
        // the argument — and a raised cap must fit MORE rows, not the same.
        let rows: Vec<Value> = (0..80)
            .map(|i| plugin_row(&format!("plugin-{i}"), "a description long enough to fill the cap"))
            .collect();
        let small = render_plugin_catalog(&rows, CATALOG_MAX_MIN);
        let big = render_plugin_catalog(&rows, CATALOG_MAX_LIMIT);
        assert!(small.len() <= CATALOG_MAX_MIN, "{} bytes", small.len());
        assert!(big.len() <= CATALOG_MAX_LIMIT, "{} bytes", big.len());
        assert!(big.len() > small.len(), "raising the cap must list more");
        assert!(big.contains("- plugin-79"), "the tail must survive a bigger cap");
    }

    #[test]
    fn catalog_lists_one_line_per_plugin_with_its_skill_names() {
        // The plugin is the unit: one line per plugin, its top-level description
        // as the trigger, and its skill names only as inventory — never one
        // catalog row (or one command) per skill.
        let rows = vec![json!({
            "slug": "ponytail",
            "name": "Ponytail",
            "description": "lazy senior dev",
            "skills": ["Ponytail", "Ponytail Audit"],
        })];
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.contains("- ponytail: lazy senior dev"), "{listed}");
        assert!(
            listed.contains("[skills: Ponytail, Ponytail Audit]"),
            "{listed}"
        );
        assert!(!listed.contains("/ponytail-audit"), "{listed}");
    }

    #[test]
    fn catalog_lists_every_skill_name_of_a_medium_bundle() {
        // The built-in library is ONE bundle of 24 skills. The old six-name
        // tail hid `test-ui` behind `+18 more`, so a live-test request had no
        // name to match. A medium bundle now lists ALL its names; the budget is
        // per bundle, so this works for any plugin, not just the built-in one.
        let names: Vec<String> = (0..23)
            .map(|i| format!("filler-skill-{i}"))
            .chain(std::iter::once("test-ui".to_string()))
            .collect();
        let rows = vec![json!({
            "slug": "builtin-plugin",
            "name": "builtin plugin",
            "description": "the built-in library",
            "skills": names,
        })];
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.contains("test-ui"), "{listed}");
        assert!(!listed.contains(" more]"), "no name may be hidden: {listed}");
    }

    #[test]
    fn catalog_clips_only_the_tail_of_a_huge_bundle() {
        // A pack with dozens of long names still cannot all fit; it keeps a
        // clipped tail (with the count + query escape hatch), never a crash or
        // a dropped plugin row.
        let names: Vec<String> = (0..120)
            .map(|i| format!("a-very-long-skill-name-number-{i:03}"))
            .collect();
        let rows = vec![json!({
            "slug": "trading",
            "name": "trading",
            "description": "trading pack",
            "skills": names,
        })];
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.contains("- trading"), "{listed}");
        assert!(listed.contains("more]"), "{listed}");
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
    }

    #[test]
    fn auto_match_hint_names_the_plugin_for_a_request_without_an_at_mention() {
        // The generic automatic path: the user's own words name a skill, so the
        // harness finds the owning PLUGIN and hands the model the exact call.
        // No @mention, no body inlined, no bare-skill shortcut.
        let dir = std::env::temp_dir().join(format!("codifa-auto-match-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Live Test", "drive the renderer UI", "تست لایو", "HARNESS BODY");
        let root = dir.to_str().unwrap();

        let hint = auto_match_hint(root, "یه تست لایو از پنل بگیر").expect("no hint for a live test");
        assert!(hint.starts_with(AUTO_MATCH_HEAD), "{hint}");
        assert!(hint.contains("slug=live-test"), "{hint}");
        assert!(hint.contains("skill=Live Test"), "{hint}");
        assert!(!hint.contains("HARNESS BODY"), "a hint must not inline: {hint}");

        assert!(auto_match_hint(root, "write me a poem about rain").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_match_hint_ignores_a_common_name_word_shared_by_many_skills() {
        // "design" appears in eight skill names in a real store; a request that
        // only says "design" must not drag a random one in. A distinctive word
        // ("zebra") still matches on its own.
        let dir = std::env::temp_dir().join(format!("codifa-auto-df-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for i in 0..8 {
            write_bundle(
                &dir,
                &format!("Design Skill {i}"),
                "a design helper",
                "",
                "BODY",
            );
        }
        write_bundle(&dir, "Zebra Finder", "find zebras", "", "BODY");
        let root = dir.to_str().unwrap();
        assert!(auto_match_hint(root, "design a landing page").is_none());
        let zebra = auto_match_hint(root, "find zebra for me").expect("distinctive name must match");
        assert!(zebra.contains("slug=zebra-finder"), "{zebra}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_match_hint_ignores_prose_in_a_legacy_keyword() {
        // The real store has legacy keyword values that are whole sentences
        // written by an older generator. Tokenising one made "the" match
        // nearly every plugin, so an ordinary request returned three random
        // toolboxes. Prose must be ignored, while a SHORT legacy keyword still
        // triggers on its rare word (the stored `Test UI` copy is exactly
        // `تست فرانت, تست UI, live test UI`).
        let dir = std::env::temp_dir().join(format!("codifa-auto-prose-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(
            &dir,
            "Frame Capture",
            "record a page",
            "I can see the skill list you've pasted — it is a set of capabilities for building animated web experiences.",
            "BODY",
        );
        write_bundle(
            &dir,
            "Test UI",
            "live test",
            "تست فرانت, تست UI, live test UI",
            "HARNESS",
        );
        let root = dir.to_str().unwrap();

        assert!(
            auto_match_hint(root, "run the tests").is_none(),
            "a prose keyword must not match on a common word"
        );
        assert!(
            auto_match_hint(root, "the page is broken").is_none(),
            "prose must not turn 'the'/'page' into triggers"
        );
        let hint = auto_match_hint(root, "یه تست لایو بگیر").expect("short keyword must match");
        assert!(hint.contains("skill=Test UI"), "{hint}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_match_hint_bridges_persian_words_to_the_english_skill_name() {
        // The shipped `Test UI` row is named in English but the user writes in
        // Persian. A stored copy from an older build only carries the Persian
        // keywords "تست فرانت / تست UI", so "تست لایو" must still find it.
        let dir = std::env::temp_dir().join(format!("codifa-auto-bridge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(
            &dir,
            "Test UI",
            "live test",
            "تست فرانت, تست UI, live test UI",
            "HARNESS",
        );
        // Make "تست" alone common, exactly like the real store's Playwright
        // pack: a bare "test" request must not pick a random testing skill.
        for i in 0..4 {
            write_bundle(
                &dir,
                &format!("Test Helper {i}"),
                "run unit tests",
                "تست",
                "BODY",
            );
        }
        let root = dir.to_str().unwrap();
        assert!(
            auto_match_hint(root, "یه تست بگیر").is_none(),
            "a common word must not pick one tester"
        );
        let hint =
            auto_match_hint(root, "یه تست لایو از پنل بگیر").expect("live test must match Test UI");
        assert!(hint.contains("skill=Test UI"), "{hint}");

        write_bundle(
            &dir,
            "Landing Page Design",
            "design a landing page",
            "طراحی لندینگ",
            "BODY",
        );
        let design =
            auto_match_hint(root, "طراحی لندینگ").expect("Persian design request must match");
        assert!(design.contains("slug=landing-page-design"), "{design}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_lists_names_and_descriptions() {
        let rows = vec![plugin_row("movie-finder", "find movies")];
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.contains("movie-finder"), "{listed}");
        assert!(listed.contains("find movies"), "{listed}");
        // A plugin without a description still gets a line.
        let bare = vec![json!({ "slug": "bare", "name": "bare", "skills": [] })];
        assert!(render_plugin_catalog(&bare, CATALOG_MAX_CHARS).contains("- bare"));
    }

    #[test]
    fn catalog_keeps_every_plugin_even_when_the_details_overflow() {
        // Detail may be clipped; an ENTRY may not disappear — a dropped plugin
        // is one the model never learns exists and can never load.
        let rows: Vec<Value> = (0..60)
            .map(|i| {
                plugin_row(
                    &format!("plugin-{i}"),
                    "a long english description that would overflow the catalog cap on its own \
                     when sixty of them are listed one after another in the system prompt",
                )
            })
            .collect();
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        for i in 0..60 {
            assert!(
                listed.contains(&format!("- plugin-{i}")),
                "plugin-{i} missing:\n{listed}"
            );
        }
    }

    #[test]
    fn catalog_caps_the_listing() {
        let rows: Vec<Value> = (0..500)
            .map(|i| plugin_row(&format!("plugin-{i}"), "a description long enough to fill the cap"))
            .collect();
        assert!(render_plugin_catalog(&rows, CATALOG_MAX_CHARS).len() <= CATALOG_MAX_CHARS);
    }

    #[test]
    fn catalog_lists_short_named_plugins_way_past_the_detail_cap() {
        // A realistic overflowing store: short slugs, long descriptions. Every
        // plugin must still be NAMED, only the details are trimmed.
        let rows: Vec<Value> = (0..100)
            .map(|i| {
                plugin_row(
                    &format!("p{i}"),
                    "a fairly long english description that would overflow the catalog cap on its \
                     own when a hundred of them are listed one after another in the system \
                     prompt of a real turn",
                )
            })
            .collect();
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        let names: Vec<&str> = listed
            .lines()
            .filter_map(|l| l.strip_prefix("- "))
            .map(|l| l.split([':', ' ']).next().unwrap_or(""))
            .collect();
        for i in 0..100 {
            assert!(names.contains(&format!("p{i}").as_str()), "p{i} missing:\n{listed}");
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
        // load_plugin instead, so one huge skill cannot flood the prompt.
        let long = json!({
            "name": "Huge Skill",
            "description": "big",
            "content": "x".repeat(AUTO_MAX_BODY_CHARS + 1),
            "files": [],
        });
        let out = format_skill_body(&long);
        assert!(!out.contains(&"x".repeat(100)), "long body was inlined");
        assert!(out.contains("load_plugin"), "{out}");
        // A body under the cap is inlined whole.
        let short = skill("Small", "small");
        assert!(format_skill_body(&short).contains("body of Small"));
    }

    #[test]
    fn catalog_restates_the_duty_after_the_list() {
        // The opening instruction sits ABOVE a list that can run to thousands of
        // characters, and weak models then read the list as reference material.
        // The duty is restated directly UNDER the list.
        let dir = std::env::temp_dir().join(format!("codifa-skill-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY");
        let root = dir.to_str().unwrap();

        let text = build_section(root, &[]).text;
        let line = "- movie-finder";
        let listed_at = text.find(line).expect("catalog line");
        let restated_at = text
            .find("If one of the plugins above covers this request")
            .expect("restated duty");
        assert!(
            restated_at > listed_at,
            "the reminder must come AFTER the list it refers to: {text}"
        );
        // Automatic discovery is the point: the user should not have to
        // @mention the skill, and a match must lead to the PLUGIN (`slug`),
        // never to a bare skill body.
        assert!(text.contains("does NOT have to @mention"), "{text}");
        assert!(text.contains("Never load a bare skill name"), "{text}");
        assert!(text.contains("skill=<name>"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_section_lists_catalog_and_inlines_attached() {
        let dir = std::env::temp_dir().join(format!("codifa-skill-router-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY HERE");
        let root = dir.to_str().unwrap();

        // The catalog is what lets the model load a plugin on demand.
        let plain = build_section(root, &[]);
        assert!(plain.text.contains("=== AVAILABLE PLUGINS ==="), "{}", plain.text);
        assert!(plain.text.contains("- movie-finder"), "{}", plain.text);
        assert!(plain.text.contains("find movies"), "{}", plain.text);
        // The cap is stated, and the escape hatch with it: a large store
        // overflows this list, and "absent from the list" must not be readable
        // as "not installed".
        assert!(plain.text.contains("CAPPED"), "{}", plain.text);
        assert!(plain.text.contains("query"), "{}", plain.text);
        assert!(!plain.text.contains("BODY HERE"), "catalog must not inline bodies");
        assert!(plain.missing.is_empty());

        // An attached skill is inlined whole.
        let attached = build_section(root, &["Movie Finder".into()]);
        assert!(
            attached.text.contains("=== ATTACHED PLUGIN SKILLS ==="),
            "{}",
            attached.text
        );
        assert!(attached.text.contains("BODY HERE"), "{}", attached.text);
        assert!(attached.missing.is_empty());

        // A deleted/renamed attachment is reported instead of silently ignored.
        let gone = build_section(root, &["Ghost Skill".into()]);
        assert_eq!(gone.missing, vec!["ghost skill".to_string()]);
        assert!(!gone.text.contains("ATTACHED PLUGIN SKILLS"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sub-agent receives the attached skill BODIES from its own bundles.
    #[test]
    fn build_attached_section_has_bodies_but_no_catalog() {
        let dir =
            std::env::temp_dir().join(format!("codifa-skill-attached-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY HERE");
        let root = dir.to_str().unwrap();

        let attached = build_attached_section(root, &["Movie Finder".into()], "movie finder");
        assert!(attached.text.contains("BODY HERE"), "{}", attached.text);
        assert!(
            attached.text.contains("=== ATTACHED BUNDLE SKILLS ==="),
            "{}",
            attached.text
        );
        assert!(
            !attached.text.contains("=== AVAILABLE PLUGINS ==="),
            "a sub-agent must not get the catalog: {}",
            attached.text
        );
        assert!(
            !attached.text.contains("- movie-finder"),
            "the catalog line leaked into a sub-agent prompt: {}",
            attached.text
        );
        assert!(attached.missing.is_empty());
        // No attachments = no section at all.
        assert!(build_attached_section(root, &[], "").text.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sub-agent can load ANY installed plugin (`load_plugin` is in its tool
    /// set), so its section must carry the same catalog the main agent uses —
    /// that is what makes Settings → Sub-agents plugin-free — plus its own
    /// bundle bodies on top.
    #[test]
    fn a_subagent_section_carries_the_plugin_catalog_and_its_own_bodies() {
        let dir =
            std::env::temp_dir().join(format!("codifa-skill-subagent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(&dir, "Movie Finder", "find movies", "فیلم", "BODY HERE");
        let root = dir.to_str().unwrap();

        let section = build_subagent_section(root, &["Movie Finder".into()], "movie finder");
        // The catalog is the door to every OTHER installed plugin.
        assert!(
            section.text.contains("=== AVAILABLE PLUGINS ==="),
            "{}",
            section.text
        );
        assert!(section.text.contains("- movie-finder"), "{}", section.text);
        // The owns-bundle bodies are still inlined.
        assert!(section.text.contains("BODY HERE"), "{}", section.text);
        assert!(
            section.text.contains("=== ATTACHED BUNDLE SKILLS ==="),
            "{}",
            section.text
        );

        // With nothing attached it is still the catalog (unlike the attached-only
        // builder), because the sub-agent must be able to discover a toolbox.
        let bare = build_subagent_section(root, &[], "");
        assert!(!bare.text.is_empty(), "a sub-agent must see the catalog");
        assert!(bare.text.contains("=== AVAILABLE PLUGINS ==="), "{}", bare.text);
        assert!(!bare.text.contains("=== ATTACHED BUNDLE SKILLS ==="));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A bundle can be a LIBRARY (the trading pack ships 82 skills / ~820 KB).
    /// A sub-agent must not receive every body: only the skills that name its
    /// role are inlined, and every other one is indexed by its file path so it
    /// stays reachable through `read`.
    #[test]
    fn a_large_bundle_inlines_matching_skills_and_indexes_the_rest() {
        let mut rows: Vec<Value> = (0..40)
            .map(|i| {
                json!({
                    "name": format!("Generic Topic {i}"),
                    "description": "trading strategies and market notes",
                    "path": format!("/data/plugins/pack/skills/topic-{i}/skill.md"),
                    "content": "x".repeat(2_000),
                    "files": [],
                })
            })
            .collect();
        rows.push(json!({
            "name": "Execution Algorithms",
            "description": "TWAP, VWAP and implementation shortfall",
            "path": "/data/plugins/pack/skills/execution-algorithms/skill.md",
            "content": "EXECUTION BODY",
            "files": [],
        }));
        let names: Vec<String> = rows
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_string())
            .collect();

        let section = attached_section_for_agent(
            &rows,
            &names,
            "Algorithmic Trading Strategist — execution algorithm design",
            SUBAGENT_ATTACHED_MAX_CHARS,
        );
        // The role-matching skill is inlined whole.
        assert!(section.text.contains("EXECUTION BODY"), "{}", section.text);
        // The generic bodies (40 × 2 KB, far over budget) are not.
        assert!(
            !section.text.contains(&"x".repeat(2_000)),
            "a generic skill was inlined: {} chars",
            section.text.chars().count()
        );
        // But nothing is lost: each is listed with the file to read.
        assert!(
            section.text.contains("=== OTHER SKILLS IN THIS BUNDLE (40) ==="),
            "{}",
            section.text
        );
        assert!(
            section.text
                .contains("- Generic Topic 0: trading strategies and market notes — read /data/plugins/pack/skills/topic-0/skill.md"),
            "{}",
            section.text
        );
        assert!(section.text.chars().count() < SUBAGENT_ATTACHED_MAX_CHARS + SUBAGENT_INDEX_MAX_CHARS + 2_000);
        assert!(section.missing.is_empty());
    }

    /// A big bundle with NO role-matching skill inlines nothing: inlining an
    /// arbitrary body would be worse than the index, because the agent would
    /// follow an unrelated workflow while the right one sits on disk.
    #[test]
    fn a_large_bundle_with_no_match_inlines_no_body() {
        let rows: Vec<Value> = (0..20)
            .map(|i| {
                json!({
                    "name": format!("Topic {i}"),
                    "description": "finance notes",
                    "path": format!("/data/plugins/pack/skills/t{i}/skill.md"),
                    "content": "y".repeat(3_000),
                    "files": [],
                })
            })
            .collect();
        let names: Vec<String> = rows
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_string())
            .collect();
        let section = attached_section_for_agent(
            &rows,
            &names,
            "Kubernetes cluster operator",
            SUBAGENT_ATTACHED_MAX_CHARS,
        );
        assert!(!section.text.contains(&"y".repeat(3_000)), "{}", section.text);
        assert!(
            section.text.contains("=== OTHER SKILLS IN THIS BUNDLE (20) ==="),
            "{}",
            section.text
        );
        assert!(
            section.text.contains("read /data/plugins/pack/skills/t0/skill.md"),
            "{}",
            section.text
        );
    }

    /// A long description per row must not push NAMES out of the index: the
    /// compact shape (name + path) takes over, and every skill stays findable.
    #[test]
    fn a_long_index_keeps_every_skill_name() {
        let rows: Vec<Value> = (0..60)
            .map(|i| {
                json!({
                    "name": format!("Skill Number {i}"),
                    "description": "a".repeat(160),
                    "path": format!("/data/plugins/pack/skills/skill-number-{i}/skill.md"),
                    "content": "b".repeat(2_000),
                    "files": [],
                })
            })
            .collect();
        let names: Vec<String> = rows
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_string())
            .collect();
        let section = attached_section_for_agent(
            &rows,
            &names,
            "Kubernetes cluster operator",
            SUBAGENT_ATTACHED_MAX_CHARS,
        );
        // 60 × 2 KB > the inline budget, so all 60 are indexed.
        for i in [0, 59] {
            assert!(
                section.text.contains(&format!("Skill Number {i}")),
                "skill {i} lost from the index: {}",
                section.text
            );
            assert!(
                section
                    .text
                    .contains(&format!("/data/plugins/pack/skills/skill-number-{i}/skill.md")),
                "skill {i}'s path lost: {}",
                section.text
            );
        }
        assert!(
            !section.text.contains(&"a".repeat(160)),
            "the long descriptions should have been dropped before any name: {}",
            section.text
        );
        assert!(section.text.chars().count() < 20_000, "{}", section.text);
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
                "description": "Model advice commands",
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
    fn catalog_points_at_the_query_search_when_rows_had_to_be_dropped() {
        // Hundreds of plugins cannot all be named inside the cap. The note must
        // name the way in (`load_plugin query=`) — a bare count left the model
        // unable to reach any of the plugins it was told existed.
        let rows: Vec<Value> = (0..500)
            .map(|i| {
                plugin_row(
                    &format!("plugin-number-{i:03}"),
                    "a fairly long english description that would overflow the catalog cap on its \
                     own when five hundred of them are listed one after another in the system \
                     prompt of a real turn",
                )
            })
            .collect();
        let listed = render_plugin_catalog(&rows, CATALOG_MAX_CHARS);
        assert!(listed.len() <= CATALOG_MAX_CHARS, "{} bytes", listed.len());
        assert!(listed.contains("load_plugin with query=<words>"), "{listed}");
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
