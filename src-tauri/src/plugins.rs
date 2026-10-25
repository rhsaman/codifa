//! Plugins: folder-backed bundles of skills + MCP connectors.
//!
//! Layout: `<data_root>/plugins/<slug>/`
//! - `plugin.json`   — name, slug, description, version, enabled, timestamps
//! - `skills/<name>/skill.md` — the exact skill layout `skills.rs` reads, so a
//!   plugin folder doubles as a skill-store root and needs no second parser
//! - `mcp.json`      — `{name: config}`, the same record shape as `<data_root>/mcp`
//!
//! Turning a plugin off never deletes anything: it only hides the plugin's
//! skills from the prompt catalog and its connectors from the MCP list, which
//! is what makes a plugin one switchable unit instead of loose files.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Manifest file inside one plugin folder.
pub const MANIFEST: &str = "plugin.json";
/// Name + folder of the ONE bundle every shipped built-in skill lives in.
///
/// The seeder used to give each shipped skill a bundle of its own, so Settings
/// showed 25 cards reading "1 skill" for what is really one library. A shipped
/// skill is not a subscription the user chose — it ships with the app — so the
/// library is a single container behind a single switch.
pub const BUILTIN_BUNDLE_NAME: &str = "Built-in Skills";
pub const BUILTIN_BUNDLE_SLUG: &str = "builtin-skills";
/// Connector file inside one plugin folder.
const CONNECTORS: &str = "mcp.json";
/// Default version written for a plugin created without one.
const DEFAULT_VERSION: &str = "1.0.0";
/// Manifest key recording where an installed bundle came from.
const SOURCE: &str = "source";
/// The install ARGUMENTS, not just a display string.
///
/// `source` is a human string like `owner/repo/path@ref`, which cannot be fed
/// back to `install_plugin`. These three can, so "update from source" re-reads
/// the exact bundle it came from instead of guessing at a repo root.
const SOURCE_REPO: &str = "source_repo";
const SOURCE_PATH: &str = "source_path";
/// The marketplace index's topic tag, stored with the same pattern as the
/// source address: an UPDATE call carries only the address, so the stored
/// category is what lets its seed still find Persian keywords.
const SOURCE_CATEGORY: &str = "source_category";
const SOURCE_REF: &str = "source_ref";
/// Manifest key holding the Persian phrases the whole bundle answers to.
const KEYWORDS: &str = "fa_keywords";
/// Manifest key holding per-connector metadata: `{name: {description, fa_keywords}}`.
///
/// Deliberately NOT stored inside the connector's own config: `mcp.json` values
/// are forwarded to the MCP server verbatim, so anything extra in there would
/// ride into the protocol payload.
const MCP_META: &str = "connector_meta";
/// Most keywords a plugin hands down to a skill that carries none of its own.
///
/// A plugin may bundle skills on unrelated topics, so its keywords are a
/// LAST-RESORT trigger: enough to find a bare skill from a Persian ask, few
/// enough that a hundred skills do not refill the catalog budget.
const INHERIT_KEYWORDS_MAX: usize = 4;
/// Folder inside a plugin holding its runnable scripts.
pub(crate) const SCRIPTS: &str = "scripts";
/// Manifest inside one script folder: name, slug, language, description.
pub(crate) const SCRIPT_MANIFEST: &str = "script.json";
/// Language a script is written in when the call does not name one.
///
/// Scripts are Rust by default — that is the house language here — and a call
/// that wants something else says so with `language`.
pub const DEFAULT_SCRIPT_LANGUAGE: &str = "rust";
/// The languages a plugin script may be written in.
pub const SCRIPT_LANGUAGES: [&str; 4] = ["rust", "python", "node", "bash"];
/// Cap on the scripts one bundle may hold.
pub(crate) const MAX_SCRIPTS: usize = 20;
/// How long one script run may take when the call does not say.
const SCRIPT_TIMEOUT_SECS: u64 = 60;
/// Hard ceiling for a script run, so one call cannot pin a worker forever.
const SCRIPT_TIMEOUT_MAX: u64 = 600;
/// A `rustc` build is slower than a run but still bounded.
const SCRIPT_BUILD_TIMEOUT_SECS: u64 = 180;

/// The Persian trigger phrases each KNOWN capability maps to.
///
/// Only a CAPABILITY is listed. Broad buckets ("development", "productivity",
/// "data", "ai") used to sit here as well, and because a category was read as
/// fact they filed nonsense onto unrelated bundles — the reported bug, where
/// telegram answered to «بهره‌وری، کارایی». One word of metadata can honestly
/// claim no more than the capability it names.
const CATEGORY_KEYWORDS: &[(&str, &str)] = &[
    ("security", "امنیت، اسکن امنیتی، آسیب‌پذیری"),
    ("documentation", "مستندسازی، مستندات"),
    ("testing", "تست، تست‌نویسی"),
    ("database", "دیتابیس، پایگاه داده"),
    ("monitoring", "مانیتورینگ، رصد"),
    ("deployment", "داپلوی، استقرار"),
    ("design", "طراحی، دیزاین، رابط کاربری"),
    ("communication", "پیام‌رسان، پیام، ارتباطات"),
    ("automation", "اتوماسیون، خودکارسازی"),
    ("migration", "مهاجرت داده"),
    ("learning", "یادگیری، آموزش"),
    ("math", "ریاضی، محاسبات"),
    ("location", "موقعیت مکانی، نقشه"),
];

/// Concrete technologies an index row may NAME, and the capability each means.
///
/// Matched as whole words against the row's NAME — and nothing else. A product
/// noun (`telegram`, `postgres`, `terraform`) identifies a domain on its own;
/// the prose and the declared category do not, and both used to file nonsense
/// onto unrelated bundles (measured: 97 of 173 seeded rows came from prose). No
/// match → the bundle stays keyword-free for the user to edit.
const DOMAIN_ANCHORS: &[(&str, &str)] = &[
    ("telegram", "communication"),
    ("slack", "communication"),
    ("discord", "communication"),
    ("imessage", "communication"),
    ("whatsapp", "communication"),
    ("twilio", "communication"),
    ("messaging", "communication"),
    ("mailgun", "communication"),
    ("sendgrid", "communication"),
    ("resend", "communication"),
    ("postmark", "communication"),
    ("mailchimp", "communication"),
    ("smtp", "communication"),
    ("email", "communication"),
    ("inbox", "communication"),
    ("sms", "communication"),
    ("zulip", "communication"),
    ("postgres", "database"),
    ("postgresql", "database"),
    ("mysql", "database"),
    ("sqlite", "database"),
    ("sqlserver", "database"),
    ("mongodb", "database"),
    ("redis", "database"),
    ("clickhouse", "database"),
    ("snowflake", "database"),
    ("bigquery", "database"),
    ("databricks", "database"),
    ("cockroachdb", "database"),
    ("supabase", "database"),
    ("airtable", "database"),
    ("prisma", "database"),
    ("dynamodb", "database"),
    ("cassandra", "database"),
    ("sql", "database"),
    ("database", "database"),
    ("kubernetes", "deployment"),
    ("docker", "deployment"),
    ("terraform", "deployment"),
    ("helm", "deployment"),
    ("vercel", "deployment"),
    ("netlify", "deployment"),
    ("cloudflare", "deployment"),
    ("hostinger", "deployment"),
    ("deployment", "deployment"),
    ("deploy", "deployment"),
    ("hosting", "deployment"),
    ("datadog", "monitoring"),
    ("sentry", "monitoring"),
    ("grafana", "monitoring"),
    ("prometheus", "monitoring"),
    ("honeycomb", "monitoring"),
    ("dynatrace", "monitoring"),
    ("newrelic", "monitoring"),
    ("langfuse", "monitoring"),
    ("observability", "monitoring"),
    ("telemetry", "monitoring"),
    ("monitoring", "monitoring"),
    ("figma", "design"),
    ("sketch", "design"),
    ("photoshop", "design"),
    ("canva", "design"),
    ("design", "design"),
    ("pytest", "testing"),
    ("vitest", "testing"),
    ("playwright", "testing"),
    ("cypress", "testing"),
    ("jest", "testing"),
    ("testing", "testing"),
    ("semgrep", "security"),
    ("sonarqube", "security"),
    ("snyk", "security"),
    ("aikido", "security"),
    ("crowdsec", "security"),
    ("sonatype", "security"),
    ("hawkscan", "security"),
    ("vulnerability", "security"),
    ("vulnerabilities", "security"),
    ("pentest", "security"),
    ("firewall", "security"),
    ("malware", "security"),
    ("security", "security"),
    ("cron", "automation"),
    ("zapier", "automation"),
    ("n8n", "automation"),
    ("webhook", "automation"),
    ("automation", "automation"),
    ("migration", "migration"),
    ("migrate", "migration"),
    ("learning", "learning"),
    ("tutorial", "learning"),
    ("academy", "learning"),
    ("course", "learning"),
    ("math", "math"),
    ("algebra", "math"),
    ("geometry", "math"),
    ("documentation", "documentation"),
    ("docs", "documentation"),
    ("readme", "documentation"),
    ("location", "location"),
    ("maps", "location"),
    ("map", "location"),
    ("geo", "location"),
];

/// The phrase lists an EARLIER mapper wrote into the bundles it seeded.
///
/// Kept as history and still load-bearing: a stored `fa_keywords` that matches
/// one of these lists VERBATIM was written by that mapper (which read the
/// index's declared category as fact) and never typed by hand, so it is safe to
/// re-map. See `is_legacy_seed`.
const LEGACY_CATEGORY_KEYWORDS: [(&str, &str); 12] = [
    ("security", "امنیت، امنیتی، اسکن امنیتی، آسیب‌پذیری"),
    ("documentation", "مستندسازی، مستندات، تولید مستندات"),
    ("development", "توسعه، کدنویسی، برنامه‌نویسی"),
    ("productivity", "بهره‌وری، کارایی، مدیریت کار"),
    ("testing", "تست، تست نویسی، تست خودکار"),
    ("database", "دیتابیس، پایگاه داده، بانک اطلاعاتی"),
    ("devops", "داپلوی، استقرار، دیوآپس، ci/cd"),
    ("deployment", "داپلوی، استقرار، انتشار"),
    ("data", "داده، تحلیل داده، پردازش داده"),
    ("ai", "هوش مصنوعی، مدل زبانی، llm"),
    ("communication", "ارتباطات، پیام، مدیریت پیام"),
    ("design", "طراحی، دیزاین، رابط کاربری"),
];

/// The Persian keywords one marketplace row seeds.
///
/// The row's NAME is read first and its description second: a product noun is a
/// fact about the bundle, while loose prose is what used to give a database tool
/// the words for «تحلیل داده». Nothing matches → the declared category, but only
/// when it names a known capability. Still nothing → an EMPTY list: a wrong
/// keyword fires the wrong skill, so an unrecognized bundle stays keyword-free
/// until the user edits it.
fn category_keywords(name: &str) -> Vec<String> {
    // Whole-word match on ASCII words: substring matching would fire on
    // noise ("ai" inside "email"), so a word must stand alone in the text.
    let words = |text: &str| -> Vec<String> {
        text.trim()
            .to_ascii_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    };
    let phrases_of = |domain: &str| -> Vec<String> {
        CATEGORY_KEYWORDS
            .iter()
            .find(|(key, _)| *key == domain)
            .map(|(_, phrases)| crate::skills::split_fa_keywords(phrases))
            .unwrap_or_default()
    };
    let anchor = |ws: &[String]| -> Option<&'static str> {
        DOMAIN_ANCHORS
            .iter()
            .find(|(word, _)| ws.iter().any(|w| w == word))
            .map(|(_, domain)| *domain)
    };
    // ONLY the name. Measured against the live catalogue, reading the
    // description here filed a keyword on 97 of 173 rows and almost every one
    // was wrong, because prose names whichever technology it mentions:
    // `apollo-skills` (a GraphQL toolkit) matched "design", `atomic-agents`
    // matched "testing", `aws-serverless` matched "deploy" — the plugin then
    // fires on a Persian ask it has nothing to do with.
    //
    // The declared category is not evidence either: the index files telegram
    // under "productivity", `azure` under "database", `adobe-for-creativity`
    // under "design". A product NOUN is the one honest signal a row carries,
    // so an unrecognized name stays keyword-free for the user to edit.
    anchor(&words(name)).map(phrases_of).unwrap_or_default()
}

/// Whether a stored keyword list is EXACTLY one an earlier mapper wrote.
///
/// Compared as an unordered set of folded forms: a list the user reordered or
/// retyped is theirs and is never overwritten — only a verbatim machine seed is
/// stale, which is what lets the wrong keywords already sitting in a plugin
/// folder be re-mapped instead of haunting it forever.
fn is_legacy_seed(stored: &[String]) -> bool {
    if stored.is_empty() {
        return false;
    }
    let folded = |phrases: &str| -> Vec<String> {
        let mut out: Vec<String> = crate::skills::split_fa_keywords(phrases)
            .iter()
            .map(|k| crate::skills::fold_fa(k))
            .collect();
        out.sort();
        out.dedup();
        out
    };
    let mut have: Vec<String> = stored.iter().map(|k| crate::skills::fold_fa(k)).collect();
    have.sort();
    have.dedup();
    let matches = |want: Vec<String>| want == have;
    // An older mapper seeded straight from the declared category…
    LEGACY_CATEGORY_KEYWORDS
        .iter()
        .any(|(_, phrases)| matches(folded(phrases)))
        // …and the mapper that read the row's DESCRIPTION mapped every phrase
        // list too. Those seeds are just as wrong (that is what put «تست» on a
        // GraphQL toolkit), so they are recognised and re-mapped as well —
        // otherwise a keyword already on disk would outlive the fix.
        || CATEGORY_KEYWORDS
            .iter()
            .any(|(_, phrases)| matches(folded(phrases)))
}

/// Rewrite every bundle whose stored keywords are an older mapper's seed.
///
/// The mapper used to read an index row's declared category as FACT, so a
/// bundle filed under the wrong category (telegram under "productivity") landed
/// with that category's Persian words — a wrong trigger that survived in the
/// already-installed folder. `install_plugin` re-maps such a list, but only when
/// that bundle is updated; this sweep does it on boot so a keyword already on
/// disk is corrected without the user re-installing anything.
///
/// The SAME wrong list was written into each shipped skill's frontmatter (the
/// per-skill seed read the category and the row's prose too), and a skill's own
/// list outranks the bundle's when the skill is matched — so a folder is not
/// corrected until its skills are, which is why both levels are swept here.
///
/// Returns how many files were rewritten. Only a VERBATIM machine seed is
/// touched (`is_legacy_seed`): a list the user typed or reordered is theirs.
pub fn remap_legacy_keywords(root: &Path) -> usize {
    let base = plugins_dir(root);
    let Ok(entries) = fs::read_dir(&base) else {
        return 0;
    };
    let mut fixed = 0;
    for entry in entries.flatten() {
        let slug = entry.file_name().to_string_lossy().to_string();
        let Some(mut manifest) = read_manifest(root, &slug) else {
            continue;
        };
        let stored = keywords_of(&manifest[KEYWORDS]);
        if is_legacy_seed(&stored) {
            let seed = category_keywords(manifest["name"].as_str().unwrap_or(&slug));
            // A seed the new mapper cannot replace is still a wrong trigger: drop
            // it rather than keep words that fire the bundle for the wrong ask.
            manifest[KEYWORDS] = json!(seed);
            manifest["updated_at"] = json!(now_secs());
            if write_manifest(root, &slug, &manifest).is_ok() {
                fixed += 1;
            }
        }
        fixed += remap_skill_keywords(&plugin_dir(root, &slug));
    }
    fixed
}

/// The same re-map for every shipped skill's frontmatter, one level deeper.
///
/// `sync_skill` is the only writer of a skill file, so its frontmatter rules
/// (splitting, preserving an omitted field) stay authoritative here rather than
/// being duplicated: the body and description are passed through untouched.
fn remap_skill_keywords(dir: &Path) -> usize {
    // A bundle's skills live one level DOWN, in the shape `sync_skill` writes
    // (`<plugin>/skills/<slug>/skill.md`). Reading the plugin's own children
    // looked at `<plugin>/<slug>/skill.md` — a path the writer never produces —
    // so a wrong keyword inside a shipped skill outlived the sweep.
    let Ok(entries) = fs::read_dir(crate::skills::skills_dir_pub(dir)) else {
        return 0;
    };
    let mut fixed = 0;
    for entry in entries.flatten() {
        let md = entry.path().join("skill.md");
        let Ok(raw) = fs::read_to_string(&md) else {
            continue;
        };
        let (name, _slug, description, keywords) = crate::skills::parse_frontmatter_pub(&raw);
        if name.is_empty() || !is_legacy_seed(&keywords) {
            continue;
        }
        let seed = category_keywords(&name);
        let body = crate::skills::strip_frontmatter_pub(&raw);
        let out = json!({
            "name": name,
            "description": description,
            // An empty list when the new mapper finds nothing: `sync_skill` reads
            // an ABSENT field as "keep what is stored", so an explicit [] is the
            // only way to actually drop a phrase the fix proved wrong.
            "fa_keywords": seed,
            "content": body,
        });
        if crate::skills::sync_skill(dir, &out).is_ok() {
            fixed += 1;
        }
    }
    fixed
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Carry an install address from a request body into a manifest.
///
/// Only present, non-empty arguments are copied, so a plain create/update keeps
/// whatever address the bundle already records.
fn copy_source_args(manifest: &mut Value, body: &Value) {
    for (key, field) in [
        (SOURCE_REPO, "repo"),
        (SOURCE_PATH, "repo_path"),
        (SOURCE_REF, "repo_ref"),
        (SOURCE_CATEGORY, "category"),
    ] {
        if let Some(v) = body[field].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            manifest[key] = json!(v);
        }
    }
}

fn plugins_dir(root: &Path) -> PathBuf {
    root.join("plugins")
}

fn plugin_dir(root: &Path, slug: &str) -> PathBuf {
    plugins_dir(root).join(crate::skills::safe_file(slug, "plugin"))
}

/// Folder slug for a plugin: the explicit `slug` when given, else the name.
fn plugin_slug(name: &str, given: &str) -> String {
    let raw = if given.trim().is_empty() { name } else { given };
    crate::skills::safe_file(&raw.trim().to_lowercase(), "plugin")
}

fn plugin_ref(body: &Value) -> String {
    plugin_slug(
        body["name"].as_str().unwrap_or(""),
        body["slug"].as_str().unwrap_or(""),
    )
}

/// Persian phrases read out of a manifest field that may be an array or a
/// single comma-separated string.
///
/// Splits on the ASCII comma AND the Persian one (U+060C), trims, drops empties
/// and dedupes on the folded form so `فیلم` and `فيلم` count once.
fn keywords_of(value: &Value) -> Vec<String> {
    let chunks: Vec<String> = match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in chunks {
        for k in crate::skills::split_fa_keywords(&chunk) {
            if seen.insert(crate::skills::fold_fa(&k)) {
                out.push(k);
            }
        }
    }
    out
}

/// Whether a request body carries the keyword field at all (an explicit empty
/// list clears it; an absent field leaves it alone).
fn has_keywords(body: &Value) -> bool {
    body.get(KEYWORDS).is_some_and(|v| !v.is_null())
}

/// The name a marketplace row's keywords should be mapped from.
///
/// The index row's own name wins (it is the short identifier), the bundle's
/// manifest name is the fallback, so an install with neither still maps.
fn seed_name(body: &Value, payload: &Value, stored: Option<&Value>) -> String {
    body["name"]
        .as_str()
        .or_else(|| payload["name"].as_str())
        .or_else(|| stored.and_then(|m| m["name"].as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn read_manifest(root: &Path, slug: &str) -> Option<Value> {
    let raw = fs::read_to_string(plugin_dir(root, slug).join(MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_manifest(root: &Path, slug: &str, manifest: &Value) -> Result<(), String> {
    let dir = plugin_dir(root, slug);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join(MANIFEST), raw).map_err(|e| e.to_string())
}

fn read_connectors(root: &Path, slug: &str) -> serde_json::Map<String, Value> {
    fs::read_to_string(plugin_dir(root, slug).join(CONNECTORS))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_connectors(dir: &Path, servers: &serde_json::Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(CONNECTORS), Value::Object(servers.clone()).to_string())
        .map_err(|e| e.to_string())
}

/// Skill names a plugin currently holds (recomputed from disk, never stored).
fn skill_names(root: &Path, slug: &str) -> Vec<String> {
    crate::skills::list_skills(&plugin_dir(root, slug))["skills"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn connector_names(root: &Path, slug: &str) -> Vec<String> {
    read_connectors(root, slug).keys().cloned().collect()
}

/// Every connector name that lives in SOME bundle, enabled or not.
///
/// The boot cleanup asks this before deleting a leftover `mcp/*.json`: a name
/// that already crossed over is a dead copy, anything else is still the only
/// copy the user has.
pub fn all_connector_names(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (slug, _) in all_plugins(root) {
        for name in connector_names(root, &slug) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

/// Folder holding one plugin's runnable scripts.
fn scripts_dir(root: &Path, slug: &str) -> PathBuf {
    plugin_dir(root, slug).join(SCRIPTS)
}

/// Folder of ONE script: the manifest plus its source file.
fn script_dir(root: &Path, slug: &str, name: &str) -> PathBuf {
    scripts_dir(root, slug).join(crate::skills::safe_file(&name.to_lowercase(), "script"))
}

/// The source file name a language is written to.
fn script_file(language: &str) -> &'static str {
    script_source_file(language)
}

/// The source file a language is written to.
///
/// Public so `repo.rs` can find the file a bundle's script manifest names
/// without guessing at the extension.
pub(crate) fn script_source_file(language: &str) -> &'static str {
    match language {
        "python" => "main.py",
        "node" => "main.js",
        "bash" => "main.sh",
        _ => "main.rs",
    }
}

/// Canonical language name for a script.
///
/// Rust is the default because it is this project's own language; anything else
/// has to be asked for explicitly and must be one of [`SCRIPT_LANGUAGES`], so a
/// typo cannot produce a script nothing knows how to run.
fn script_language(raw: &str) -> Result<String, String> {
    let lang = raw.trim().to_ascii_lowercase();
    if lang.is_empty() {
        return Ok(DEFAULT_SCRIPT_LANGUAGE.to_string());
    }
    let lang = match lang.as_str() {
        "py" | "python3" => "python".to_string(),
        "js" | "javascript" | "nodejs" => "node".to_string(),
        "sh" | "shell" | "zsh" => "bash".to_string(),
        "rs" => "rust".to_string(),
        other => other.to_string(),
    };
    if !SCRIPT_LANGUAGES.contains(&lang.as_str()) {
        return Err(format!(
            "unsupported script language {lang:?} — use one of {} (Rust is the default)",
            SCRIPT_LANGUAGES.join(", ")
        ));
    }
    Ok(lang)
}

/// Names of the scripts a plugin currently holds (recomputed from disk).
fn script_names(root: &Path, slug: &str) -> Vec<String> {
    list_scripts(root, slug)
        .iter()
        .filter_map(|row| row["name"].as_str().map(str::to_string))
        .collect()
}

/// Every script of a plugin WITH its own metadata, sorted by name.
///
/// Read out of each script's manifest — the folder stays the only source of
/// truth — so Settings can show (and edit) a script's description and Persian
/// keywords without opening its source.
pub fn list_scripts(root: &Path, slug: &str) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(scripts_dir(root, slug)) else {
        return Vec::new();
    };
    let mut rows: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(entry.path().join(SCRIPT_MANIFEST)) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(name) = meta["name"].as_str().map(str::to_string) else {
            continue;
        };
        let language = meta["language"]
            .as_str()
            .unwrap_or(DEFAULT_SCRIPT_LANGUAGE)
            .to_string();
        let source = script_source_file(&language);
        rows.push(json!({
            "name": name,
            "language": language,
            "description": meta["description"].as_str().unwrap_or(""),
            KEYWORDS: keywords_of(&meta[KEYWORDS]),
            // The file the script's code lives in, so the page can name it.
            "file": source,
        }));
    }
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    rows
}

/// One script's manifest, resolved by the name the user gave.
fn read_script(root: &Path, slug: &str, name: &str) -> Option<Value> {
    let raw = fs::read_to_string(script_dir(root, slug, name).join(SCRIPT_MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The source text a script already has on disk, so an edit that only changes
/// its description or keywords leaves the body alone.
fn read_script_source(root: &Path, slug: &str, name: &str, meta: &Value) -> Option<String> {
    let language = meta["language"].as_str().unwrap_or(DEFAULT_SCRIPT_LANGUAGE);
    fs::read_to_string(script_dir(root, slug, name).join(script_source_file(language))).ok()
}

/// A runnable starting point, so a script can be created without the caller
/// having to invent boilerplate — and so the DEFAULT language is visible as
/// working Rust code rather than an empty file.
fn script_template(language: &str, name: &str) -> String {
    match language {
        "python" => format!(
            "#!/usr/bin/env python3\n\
             \"\"\"{name} — a plugin script.\n\n\
             Arguments arrive in sys.argv[1:]; print to stdout — the caller reads\n\
             that as the tool result.\n\
             \"\"\"\n\
             import sys\n\n\n\
             def main() -> None:\n\
             \x20   args = sys.argv[1:]\n\
             \x20   print(f\"{name} got {{len(args)}} argument(s): {{args!r}}\")\n\n\n\
             if __name__ == \"__main__\":\n\
             \x20   main()\n"
        ),
        "node" => format!(
            "#!/usr/bin/env node\n\
             // {name} — a plugin script.\n\
             // Arguments arrive in process.argv.slice(2); print to stdout.\n\
             const args = process.argv.slice(2);\n\
             console.log(`{name} got ${{args.length}} argument(s):`, args);\n"
        ),
        "bash" => format!(
            "#!/usr/bin/env bash\n\
             # {name} — a plugin script.\n\
             # Arguments arrive in \"$@\"; print to stdout.\n\
             set -euo pipefail\n\
             echo \"{name} got $# argument(s): $*\"\n"
        ),
        _ => format!(
            "//! {name} — a plugin script.\n\
             //!\n\
             //! Arguments arrive in `std::env::args()`; print to stdout — the\n\
             //! caller reads that as the tool result.\n\n\
             fn main() {{\n\
             \x20   let args: Vec<String> = std::env::args().skip(1).collect();\n\
             \x20   println!(\"{name} got {{}} argument(s): {{:?}}\", args.len(), args);\n\
             }}\n"
        ),
    }
}

/// Create/update/delete the scripts named by a create/update call.
///
/// Same shape as the skills branch above: only what the call names changes, so
/// adding one script never rewrites the others.
fn apply_scripts(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    if let Some(list) = body["scripts"].as_array() {
        if list.len() > MAX_SCRIPTS {
            return Err(format!("a plugin can hold at most {MAX_SCRIPTS} scripts"));
        }
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() {
                return Err("every entry in `scripts` needs a name".into());
            }
            let dir = script_dir(root, slug, &name);
            let previous = item["previous_name"].as_str().unwrap_or("").trim();
            if !previous.is_empty() && previous != name {
                let old = script_dir(root, slug, previous);
                if old.is_dir() {
                    fs::rename(&old, &dir).map_err(|e| e.to_string())?;
                }
            }
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            // PATCH, not replace: a call that only rewrites the description or
            // the Persian keywords keeps the language and the body the script
            // already has. Naming neither used to fall back to Rust plus the
            // boilerplate template, so editing a Python script's description
            // silently replaced its source with Rust code nothing could run.
            let stored = read_script(root, slug, &name);
            let language = match item["language"].as_str().map(str::trim).filter(|l| !l.is_empty()) {
                Some(raw) => script_language(raw)?,
                None => stored
                    .as_ref()
                    .and_then(|m| m["language"].as_str())
                    .filter(|l| SCRIPT_LANGUAGES.contains(l))
                    .unwrap_or(DEFAULT_SCRIPT_LANGUAGE)
                    .to_string(),
            };
            // The stored body is only inherited when the language did not
            // change: keeping Rust source in a file that is now `main.py` would
            // be worse than starting from that language's template.
            let kept_source = stored
                .as_ref()
                .filter(|m| m["language"].as_str().unwrap_or(DEFAULT_SCRIPT_LANGUAGE) == language)
                .and_then(|m| read_script_source(root, slug, &name, m));
            let content = item["content"]
                .as_str()
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| kept_source.unwrap_or_else(|| script_template(&language, &name)));
            let description = match item.get("description").and_then(Value::as_str) {
                Some(text) => text.to_string(),
                None => stored
                    .as_ref()
                    .and_then(|m| m["description"].as_str())
                    .unwrap_or("")
                    .to_string(),
            };
            // An absent field keeps the stored keywords; an explicit empty one
            // clears them, exactly like `update_plugin` treats the bundle's own.
            let keywords = if has_keywords(item) {
                keywords_of(&item[KEYWORDS])
            } else {
                stored
                    .as_ref()
                    .map(|m| keywords_of(&m[KEYWORDS]))
                    .unwrap_or_default()
            };
            let now = now_secs();
            let created = stored
                .as_ref()
                .and_then(|m| m["created_at"].as_u64())
                .unwrap_or(now);
            let mut meta = json!({
                "name": name,
                "language": language,
                "description": description,
                "created_at": created,
                "updated_at": now,
            });
            if !keywords.is_empty() {
                meta[KEYWORDS] = json!(keywords);
            }
            fs::write(
                dir.join(script_file(&language)),
                content.trim_end().to_string() + "\n",
            )
            .map_err(|e| e.to_string())?;
            fs::write(
                dir.join(SCRIPT_MANIFEST),
                serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(list) = body["deleted_scripts"].as_array() {
        for item in list {
            let Some(name) = item.as_str() else { continue };
            let dir = script_dir(root, slug, name);
            if dir.is_dir() {
                fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Shell-quote one argument.
///
/// Every part of a script command is built from disk state (a slug, a path in
/// the data root), but quoting is what makes that safe by construction instead
/// of by argument about what `safe_file` happens to allow today.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Where a Rust script's compiled binary lives (inside the script's own folder,
/// so deleting the script deletes its build).
fn rust_binary(dir: &Path, name: &str) -> PathBuf {
    dir.join(".build").join(crate::skills::safe_file(&name.to_lowercase(), "script"))
}

/// Run one of a plugin's scripts, bounded exactly like `run_terminal`.
///
/// Rust is compiled with `rustc` on first use and re-used until the source or
/// the binary changes, so a repeat run costs nothing; the other languages go
/// straight to their interpreter.
pub fn run_plugin_script(root: &Path, body: &Value) -> Result<Value, String> {
    let plugin = plugin_ref(body);
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("a script name is required".into());
    }
    // The bundle's own switch governs its scripts too — see `plugin_enabled`.
    if !plugin_enabled(root, &plugin) {
        return Err(format!(
            "plugin {plugin} is switched off — enable it under Settings → Plugins to run its \
scripts"
        ));
    }
    let meta = read_script(root, &plugin, &name).ok_or_else(|| {
        format!(
            "plugin {plugin} has no script {name:?}. Scripts: {}",
            match script_names(root, &plugin) {
                names if names.is_empty() => "(none)".to_string(),
                names => names.join(", "),
            }
        )
    })?;
    let language = meta["language"].as_str().unwrap_or(DEFAULT_SCRIPT_LANGUAGE);
    // Rust is the project's own backend language, so it stays the default; the
    // other runtimes are accepted only when the bundle names one explicitly.
    // An artifact that needs a non-Rust backend asks the user first (see the
    // `artifact` schema), so an unknown runtime is refused rather than guessed:
    // no silent fallback to an interpreter the user never approved.
    if !matches!(language, "rust" | "python" | "node" | "bash") {
        return Err(format!(
            "plugin {plugin} script {name:?} asks for language {language:?}; supported: \
rust, python, node, bash"
        ));
    }
    let dir = script_dir(root, &plugin, &name);
    let source = dir.join(script_file(language));
    if !source.is_file() {
        return Err(format!(
            "script {name:?} of plugin {plugin} has no {} on disk",
            script_file(language)
        ));
    }

    let args: Vec<String> = body["args"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|a| a.as_str().map(str::to_string).unwrap_or_else(|| a.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let timeout = body["timeout"]
        .as_u64()
        .filter(|t| *t > 0)
        .unwrap_or(SCRIPT_TIMEOUT_SECS)
        .min(SCRIPT_TIMEOUT_MAX);
    // Default to the plugin folder: a script that ships data beside itself
    // resolves relative paths without the caller having to explain where it is.
    let cwd = body["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| plugin_dir(root, &plugin));
    if !cwd.is_dir() {
        return Err(format!("working folder {} does not exist", cwd.display()));
    }
    let cwd = cwd.to_string_lossy().to_string();

    let program = match language {
        "python" => "python3".to_string(),
        "node" => "node".to_string(),
        "bash" => "bash".to_string(),
        _ => {
            let bin = rust_binary(&dir, &name);
            if rust_needs_build(&source, &bin) {
                fs::create_dir_all(bin.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
                let build = format!(
                    "PATH={} {} -O -o {} {}",
                    sh_quote(&crate::shell_env::shell_path()),
                    sh_quote("rustc"),
                    sh_quote(&bin.to_string_lossy()),
                    sh_quote(&source.to_string_lossy()),
                );
                let out = crate::tools::run_terminal(&cwd, &build, SCRIPT_BUILD_TIMEOUT_SECS)?;
                if !bin.is_file() {
                    // `rustc` missing or the source does not compile: hand the
                    // compiler's own words back instead of a bare failure.
                    return Err(format!("could not build Rust script {name:?}:\n{out}"));
                }
            }
            bin.to_string_lossy().to_string()
        }
    };

    let mut command = format!(
        "PATH={} {}",
        sh_quote(&crate::shell_env::shell_path()),
        sh_quote(&program)
    );
    // An interpreter needs the FILE as its own first argument. The Rust branch's
    // `program` is the compiled binary, which is self-contained — passing the
    // source to it would only be read as an argument.
    if language != DEFAULT_SCRIPT_LANGUAGE {
        command.push(' ');
        command.push_str(&sh_quote(&source.to_string_lossy()));
    }
    for a in &args {
        command.push(' ');
        command.push_str(&sh_quote(a));
    }
    let output = crate::tools::run_terminal(&cwd, &command, timeout)?;
    Ok(json!({
        "plugin": plugin,
        "script": name,
        "language": language,
        "args": args,
        "cwd": cwd,
        "output": output,
    }))
}

/// Whether a Rust script has to be compiled again: no binary yet, or either
/// side of the pair moved since the last build.
fn rust_needs_build(source: &Path, bin: &Path) -> bool {
    let Ok(built) = fs::metadata(bin).and_then(|m| m.modified()) else {
        return true;
    };
    match fs::metadata(source).and_then(|m| m.modified()) {
        Ok(src) => src > built,
        // An unreadable source is not a reason to skip the build: `rustc` gives
        // a far better message than "up to date" would.
        Err(_) => true,
    }
}

/// One plugin as the renderer/tool sees it: the manifest plus the live lists of
/// what is inside the folder.
fn plugin_view(root: &Path, slug: &str) -> Value {
    let mut manifest = read_manifest(root, slug).unwrap_or_else(|| json!({}));
    if !manifest.is_object() {
        manifest = json!({});
    }
    manifest["slug"] = json!(slug);
    manifest["skills"] = json!(skill_names(root, slug));
    manifest["mcp"] = json!(connector_names(root, slug));
    manifest["scripts"] = json!(script_names(root, slug));
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
fn require_repo_address(spec: &str) -> Result<(), String> {
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
fn row_bundle_payload(
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
fn install_skills_as_bundle(root: &Path, body: &Value) -> Result<Value, String> {
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
fn install_connectors_as_bundle(root: &Path, body: &Value) -> Result<Value, String> {
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
const BUNDLE_LIBRARY_KEYWORDS_MAX: usize = 8;

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
fn interleave(lists: &[Vec<String>], cap: usize) -> Vec<String> {
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
        // Provenance decides: an untouched seed is a stale copy of a shipped
        // file and goes; anything the user wrote in is theirs and stays.
        if crate::skills::skill_is_user_owned(&dir) {
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
fn write_bundle_payload(root: &Path, payload: &Value) -> Result<Value, String> {
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
fn lift_description(root: &Path, slug: &str, existed: bool, payload: &mut Value) {
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

/// Folder of one bundle, for callers outside this module (tests, migration).
#[cfg(test)]
pub fn plugin_dir_of(root: &Path, slug: &str) -> PathBuf {
    plugin_dir(root, slug)
}

/// Every bundle folder with its manifest, sorted by slug.
pub fn all_plugins(root: &Path) -> Vec<(String, Value)> {
    let Ok(entries) = fs::read_dir(plugins_dir(root)) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Value)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(manifest) = read_manifest(root, &slug) {
            out.push((slug, manifest));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Folder of a SKILL inside any bundle, matched by name or folder slug.
///
/// Skills have no store of their own, so "where does this skill live" is
/// answered by looking inside every bundle — the lookup the boot seeder and the
/// editor both need now that `skills::find_skill_dir` covers no store.
pub fn skill_dir_for(root: &Path, name_or_slug: &str) -> Option<PathBuf> {
    if name_or_slug.trim().is_empty() {
        return None;
    }
    for (slug, _) in all_plugins(root) {
        if let Some(dir) =
            crate::skills::find_skill_dir_pub(&plugin_dir(root, &slug), name_or_slug)
        {
            return Some(dir);
        }
    }
    None
}

/// Write one skill into the bundle that owns it, or into a NEW one named after it.
///
/// A skill has no store of its own any more, so "where does this skill go" is
/// decided by who already owns it (`plugin_of_skill`, matched on the new name AND
/// the previous one so a rename stays in the same bundle). Otherwise it gets a
/// single-part bundle of its own — the granularity the switch needs.
pub fn save_bundle_skill(root: &Path, skill: Value) -> Result<Value, String> {
    let name = skill["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("skill name is required".into());
    }
    // A DELETE goes through the bundle-aware deleter: the folder is removed, and
    // a bundle that held only that skill goes with it.
    if skill["delete"].as_bool().unwrap_or(false) {
        return delete_bundle_skill(root, &name);
    }
    let previous = skill["previous_name"].as_str().unwrap_or("").trim().to_string();
    let owner = plugin_of_skill_any(root, &name)
        .or_else(|| if previous.is_empty() { None } else { plugin_of_skill_any(root, &previous) });
    let slug = match owner {
        // An existing bundle: address it by SLUG and leave its name alone (only
        // present fields are patched, so omitting `name` cannot rename it).
        Some(slug) => {
            let manifest = read_manifest(root, &slug).unwrap_or_else(|| json!({}));
            let mut payload = json!({ "slug": slug, "skills": [skill] });
            if let Some(n) = manifest["name"].as_str() {
                payload["name"] = json!(n);
            }
            write_bundle_payload(root, &payload)?;
            slug
        }
        None => {
            install_bundle(root, &name, json!({ "skills": [skill] }))?;
            plugin_slug(&name, "")
        }
    };
    // The SHAPE the skill callers expect (`sync_skill`'s reply): the tool result
    // and the Settings toast both read these keys, so a bundle write has to
    // report the same way a store write used to.
    let dir = skill_dir_for(root, &name).unwrap_or_else(|| plugin_dir(root, &slug));
    let md = std::fs::read_to_string(dir.join("skill.md")).unwrap_or_default();
    let (_, _, _, written_fa) = crate::skills::parse_frontmatter_pub(&md);
    // The same listing `sync_skill` reports: the editor refreshes its file list
    // from this reply, so a hard-coded empty array hid the extra files the call
    // had just written or kept.
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|f| {
                    !f.eq_ignore_ascii_case("skill.md") && f != crate::skills::SHIPPED_MARKER
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    Ok(json!({
        "ok": true,
        "name": name,
        "slug": slug,
        "path": dir.join("skill.md").to_string_lossy(),
        "note": "saved",
        "files": files,
        "renamed_from": if previous.is_empty() { Value::Null } else { json!(previous) },
        "fa_keyword_count": written_fa.len(),
    }))
}

/// Delete one skill wherever it lives, and drop its bundle when it was alone.
///
/// A bundle that held ONLY that skill disappears: keeping an empty folder would
/// leave a switch in Settings with nothing behind it. A bundle with more in it
/// (another skill, a connector, a script) just loses the one skill.
pub fn delete_bundle_skill(root: &Path, name: &str) -> Result<Value, String> {
    let Some(slug) = plugin_of_skill_any(root, name) else {
        return Ok(json!({ "ok": true, "note": "already gone" }));
    };
    let only_part = skill_names(root, &slug).len() <= 1
        && connector_names(root, &slug).is_empty()
        && script_names(root, &slug).is_empty();
    if only_part {
        fs::remove_dir_all(plugin_dir(root, &slug)).map_err(|e| e.to_string())?;
        return Ok(json!({ "ok": true, "note": "deleted" }));
    }
    let manifest = read_manifest(root, &slug).unwrap_or_else(|| json!({}));
    let mut payload = json!({ "slug": slug, "deleted_skills": [name] });
    if let Some(n) = manifest["name"].as_str() {
        payload["name"] = json!(n);
    }
    write_bundle_payload(root, &payload)?;
    Ok(json!({ "ok": true, "note": "deleted" }))
}

/// Save one connector into the bundle that owns it, or into a new single-part
/// bundle named after it. `previous_name` renames in place (see [`save_connector`]).
pub fn save_bundle_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let previous = body["previous_name"].as_str().unwrap_or("").trim();
    let cfg = body.get("cfg").cloned().unwrap_or_else(|| json!({}));
    if !cfg.is_object() {
        return Err("connector config must be an object".into());
    }
    // The row's own description and keywords travel in the SAME call but are
    // stored in the bundle manifest — never inside the connector's config, which
    // is forwarded to the MCP server verbatim.
    let entry = json!({
        "description": body["description"].as_str().unwrap_or(""),
        KEYWORDS: keywords_of(&body[KEYWORDS]),
    });
    let has_meta = body.get("description").is_some() || has_keywords(body);
    match connector_target(root, body, name, previous) {
        Some(slug) => {
            if has_meta {
                write_connector_meta(root, &slug, name, &entry)?;
            }
            save_connector(root, &json!({ "slug": slug, "name": name, "previous_name": previous, "cfg": cfg }))
        }
        None => {
            let mut servers = serde_json::Map::new();
            servers.insert(name.to_string(), cfg);
            let made = install_bundle(root, name, json!({ "mcp": Value::Object(servers) }))?;
            if has_meta {
                if let Some(slug) = made["slug"].as_str() {
                    write_connector_meta(root, slug, name, &entry)?;
                }
            }
            Ok(made)
        }
    }
}

/// Which bundle a connector call targets.
///
/// An explicit `slug` wins: Settings opens a bundle's page and saves the row
/// from there, so the bundle on screen IS the target — without this, saving a
/// connector into an existing bundle silently created a SECOND bundle named
/// after the connector. Only when no slug is given (the agent's `create_mcp`
/// tool) does the owner lookup decide, and a rename looks up `previous_name`
/// first so it finds the row it is moving. `None` means a brand-new connector
/// that needs a single-part bundle of its own.
fn connector_target(root: &Path, body: &Value, name: &str, previous: &str) -> Option<String> {
    let slug = body["slug"].as_str().unwrap_or("").trim();
    if !slug.is_empty() && read_manifest(root, slug).is_some() {
        return Some(slug.to_string());
    }
    connector_owner(root, name)
        .or_else(|| if previous.is_empty() { None } else { connector_owner(root, previous) })
}

/// Which bundle holds a connector by that name (first match, slug order).
fn connector_owner(root: &Path, name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return None;
    }
    all_plugins(root)
        .into_iter()
        .find(|(slug, _)| read_connectors(root, slug).contains_key(name))
        .map(|(slug, _)| slug)
}

/// Delete a connector from the bundle that owns it, removing the bundle when it
/// was alone.
pub fn delete_bundle_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let Some(slug) = connector_target(root, body, name, "") else {
        return Ok(json!({ "ok": true, "removed": false }));
    };
    let only_part = connector_names(root, &slug).len() <= 1
        && skill_names(root, &slug).is_empty()
        && script_names(root, &slug).is_empty();
    if only_part {
        let removed = fs::remove_dir_all(plugin_dir(root, &slug)).is_ok();
        return Ok(json!({ "ok": true, "removed": removed }));
    }
    delete_connector(root, &json!({ "slug": slug, "name": name }))
}

/// The connector config seeded for the browser before the native driver replaced
/// it, kept here only so an install that already has the bundle can drop it.
const RETIRED_BROWSER_CONNECTOR: (&str, &str, &[&str]) =
    ("playwright", "npx", &["-y", "@playwright/mcp@latest"]);

/// Built-in connectors installed on first run.
///
/// The browser is NOT among them: `browser_driver` ships the same tools
/// natively, so a `npx @playwright/mcp` connector would spawn a Node sidecar
/// whose whole tool list is then discarded by the native-wins filter — a live
/// process and a startup round-trip per turn for zero usable tools.
pub fn builtin_connectors() -> Vec<(&'static str, Value)> {
    vec![(
        "docker",
        json!({"command": "docker", "args": ["mcp", "gateway", "run"]}),
    )]
}

/// Install the built-in connector bundles that are missing.
///
/// Guarded by the bundle FOLDER, not by the connector name: a user who deleted
/// the seeded bundle does not want it back on the next launch. Returns the names
/// that were seeded.
pub fn seed_builtin_connectors(root: &Path) -> Vec<String> {
    let mut seeded = Vec::new();
    for (name, cfg) in builtin_connectors() {
        if plugin_dir(root, &plugin_slug(name, "")).join(MANIFEST).is_file() {
            continue;
        }
        let mut servers = serde_json::Map::new();
        servers.insert(name.to_string(), cfg);
        if install_bundle(root, name, json!({ "mcp": Value::Object(servers) })).is_ok() {
            seeded.push(name.to_string());
        }
    }
    seeded
}

/// Remove the retired browser connector's bundle from an install that has it.
///
/// Deleted ONLY while the bundle still holds exactly the shipped default and no
/// skills: a connector the user repointed (a pinned version, their own endpoint)
/// is theirs, and a bundle carrying anything else is not a seed to clean up.
/// Returns the names that were retired.
pub fn retire_builtin_connector(root: &Path) -> Vec<String> {
    let (name, command, args) = RETIRED_BROWSER_CONNECTOR;
    let slug = plugin_slug(name, "");
    let mut servers = read_connectors(root, &slug);
    if servers.len() != 1 {
        return Vec::new();
    }
    let Some(cfg) = servers.remove(name) else {
        return Vec::new();
    };
    let untouched = cfg["command"].as_str() == Some(command)
        && cfg["args"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).eq(args.iter().copied()))
            .unwrap_or(false);
    if !untouched || !skill_names(root, &slug).is_empty() {
        return Vec::new();
    }
    if fs::remove_dir_all(plugin_dir(root, &slug)).is_ok() {
        return vec![name.to_string()];
    }
    Vec::new()
}

pub fn install_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    // `install` routinely gets a NAME instead of an address (`/plugin install
    // eurusd`) when what the user wants is a bundle CREATED. "cannot read a repo
    // from …" reads as a bug there, so say which action does what was asked.
    let spec = body["repo"].as_str().unwrap_or("").trim();
    require_repo_address(spec)?;
    let read = crate::repo::read_plugin(
        body["repo"].as_str().unwrap_or(""),
        body["repo_path"].as_str().unwrap_or(""),
        body["repo_ref"].as_str().unwrap_or(""),
    )?;
    // The bundle's own manifest names it; an explicit `name` still wins so the
    // user can install the same repo twice under two names.
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| read["name"].as_str().unwrap_or("").to_string());
    let mut payload = json!({
        "name": name,
        "slug": body["slug"].clone(),
        "description": read["description"].clone(),
        "source": read["source"].clone(),
        // The ARGUMENTS, not only the display string: they are what lets
        // "update from source" re-read this same bundle later.
        "repo": body["repo"].clone(),
        "repo_path": body["repo_path"].clone(),
        "repo_ref": body["repo_ref"].clone(),
        "skills": read["skills"].clone(),
        "scripts": read["scripts"].clone(),
    });
    // A repo that ships no keywords leaves the key OUT, so reinstalling never
    // discards keywords the user edited by hand — `update_plugin` only touches
    // fields that are present.
    if read[KEYWORDS].as_array().is_some_and(|a| !a.is_empty()) {
        payload[KEYWORDS] = read[KEYWORDS].clone();
    }
    // An empty version must not overwrite the default with "".
    if read["version"].as_str().is_some_and(|v| !v.trim().is_empty()) {
        payload["version"] = read["version"].clone();
    }
    if read["mcp"].as_object().is_some_and(|m| !m.is_empty()) {
        payload["mcp"] = read["mcp"].clone();
    }
    let slug = plugin_ref(&payload);
    let existed = plugin_dir(root, &slug).join(MANIFEST).is_file();
    // SEED the bundle's keywords from the index row when it would otherwise
    // land with none: an English-only marketplace plugin is unreachable from a
    // Persian ask — the reported bug. A hand-typed list always wins; the one
    // exception is a list an EARLIER mapper wrote (`is_legacy_seed`), which is
    // re-mapped because those words were never the user's own.
    if payload.get(KEYWORDS).and_then(|v| v.as_array()).map_or(true, Vec::is_empty) {
        let manifest = read_manifest(root, &slug);
        let stored = if existed {
            manifest
                .as_ref()
                .map(|m| keywords_of(&m[KEYWORDS]))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let stale = is_legacy_seed(&stored);
        // A stored list is replaced only when it is EMPTY or was written by an
        // earlier mapper: an install always carries the bundle's own name, so it
        // has the one piece of evidence the mapper trusts, while a list the user
        // typed is theirs and is never rewritten.
        if stored.is_empty() || stale {
            let seed = category_keywords(&seed_name(body, &payload, manifest.as_ref()));
            if !seed.is_empty() {
                payload[KEYWORDS] = json!(seed);
            } else if stale {
                // A stale seed the new mapper cannot replace is still a wrong
                // trigger: drop it rather than keep the old nonsense.
                payload[KEYWORDS] = json!([]);
            }
        }
    }
    let view = if existed {
        update_plugin(root, &payload)?
    } else {
        create_plugin(root, &payload)?
    };
    Ok(json!({
        "installed": if existed { "updated" } else { "created" },
        "slug": slug,
        "source": read["source"].clone(),
        "skills": view["skills"].clone(),
        "mcp": view["mcp"].clone(),
        "scripts": view["scripts"].clone(),
        "plugin": view,
    }))
}

/// Switch a plugin on/off. Without an explicit `enabled` the current value is
/// flipped, so the UI can call it as a plain toggle.
pub fn toggle_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    let Some(mut manifest) = read_manifest(root, &slug) else {
        return Err(format!("plugin not found: {slug}"));
    };
    let enabled = body["enabled"]
        .as_bool()
        .unwrap_or_else(|| !manifest["enabled"].as_bool().unwrap_or(true));
    manifest["enabled"] = json!(enabled);
    manifest["updated_at"] = json!(now_secs());
    write_manifest(root, &slug, &manifest)?;
    Ok(plugin_view(root, &slug))
}

/// Remove a plugin and everything inside it.
pub fn delete_plugin(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    let dir = plugin_dir(root, &slug);
    if !dir.exists() {
        return Ok(json!({ "ok": true, "slug": slug, "note": "already gone" }));
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "slug": slug, "note": "deleted" }))
}

/// Skills + connectors carried by a create/update call.
fn apply_parts(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    let dir = plugin_dir(root, slug);
    if let Some(list) = body["skills"].as_array() {
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim();
            if name.is_empty() {
                return Err("every entry in `skills` needs a name".into());
            }
            // An entry that names no keywords at all inherits the bundle's;
            // an explicit (even empty) list is respected as written, so a
            // skill can opt out of keywords.
            let empty = item.get("fa_keywords").is_none_or(|v| match v {
                Value::Null => true,
                Value::String(s) => s.trim().is_empty(),
                Value::Array(a) => a.is_empty(),
                _ => false,
            });
            // A skill that names no keywords is seeded from its own NAME — the
            // only fact about it that is known to be relevant. The bundle's list
            // is deliberately NOT used here: it belongs to the bundle, and
            // copying it onto every skill of a mixed library gave all of them
            // one identical, half-irrelevant trigger.
            let keywords = if empty {
                let seed = category_keywords(name);
                // Empty seed → Null ("keep what is stored"), never "": a bare
                // reinstall would otherwise wipe a list the user typed in.
                if seed.is_empty() {
                    Value::Null
                } else {
                    json!(seed)
                }
            } else {
                item["fa_keywords"].clone()
            };
            // A rename and an extra-file deletion were dropped here, so a rename
            // built a second folder and a "deleted" extra file stayed on disk.
            // `sync_skill` accepts both spellings, so pass whichever came in.
            let deleted = if item.get("deleted_files").is_some() {
                item["deleted_files"].clone()
            } else {
                item["deletedFiles"].clone()
            };
            // The plugin folder IS a skill-store root, so the existing writer
            // owns the frontmatter/slug/extra-file rules for both stores.
            // Both spellings reach here (the renderer sends camelCase) and
            // `sync_skill` accepts either, so pass whichever arrived — passing
            // only `extra_files` silently dropped an editor's added files.
            crate::skills::sync_skill(
                &dir,
                &json!({
                    "name": name,
                    "previous_name": item["previous_name"].clone(),
                    "content": item["content"].clone(),
                    "description": item["description"].clone(),
                    "fa_keywords": keywords,
                    "extra_files": if item.get("extra_files").is_some() {
                        item["extra_files"].clone()
                    } else {
                        item["files"].clone()
                    },
                    "deleted_files": deleted,
                }),
            )?;
        }
    }
    if let Some(list) = body["deleted_skills"].as_array() {
        for item in list {
            let Some(name) = item.as_str() else { continue };
            if let Some(skill) = crate::skills::find_skill_dir_pub(&dir, name) {
                fs::remove_dir_all(skill).map_err(|e| e.to_string())?;
            }
        }
    }
    if body["mcp"].is_object() || body["deleted_mcp"].is_array() {
        // Merge, never replace: an update that only touches a skill must not
        // drop the connectors the call did not mention.
        let mut servers = read_connectors(root, slug);
        if let Some(map) = body["mcp"].as_object() {
            for (name, cfg) in map {
                servers.insert(name.clone(), cfg.clone());
            }
        }
        if let Some(list) = body["deleted_mcp"].as_array() {
            for item in list {
                if let Some(name) = item.as_str() {
                    servers.remove(name);
                }
            }
        }
        write_connectors(&dir, &servers)?;
    }
    // Last, so a bundle that ships code lands with it: `scripts/` is written
    // through the same branch a hand-authored one takes.
    apply_scripts(root, slug, body)?;
    Ok(())
}

/// Enabled plugin folders, sorted by slug.
fn enabled_plugins(root: &Path) -> Vec<(String, Value)> {
    let base = plugins_dir(root);
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Value)> = Vec::new();
    for entry in entries.flatten() {
        let Some(slug) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !entry.path().is_dir() {
            continue;
        }
        let Some(manifest) = read_manifest(root, &slug) else {
            continue;
        };
        if manifest["enabled"].as_bool().unwrap_or(true) {
            out.push((slug, manifest));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Whether one bundle's own switch is on.
///
/// The script runner asks this: a switched-off bundle must contribute nothing,
/// and that includes its scripts — they are code the bundle owns, so letting
/// them run while the switch is off would make the switch a lie. An unknown
/// slug (or a folder with no manifest) is OFF, matching `enabled_plugins`,
/// which skips both.
fn plugin_enabled(root: &Path, slug: &str) -> bool {
    read_manifest(root, slug)
        .map(|m| m["enabled"].as_bool().unwrap_or(true))
        .unwrap_or(false)
}

/// Skill rows of every ENABLED plugin, in the `skills::list_skills` shape plus a
/// `plugin` tag. A disabled plugin contributes nothing, which is how switching
/// one off removes its skills from the prompt catalog.
pub fn enabled_plugin_skills(root: &Path) -> Vec<Value> {
    plugin_skills(root, false)
}

/// The same rows for EVERY plugin, enabled or not.
///
/// Settings has to show a bundle's skills while it is switched off — that is
/// exactly when a user goes looking for what it contains. Each row carries
/// `plugin_enabled` and `plugin_slug` so the panel never has to guess which
/// plugin a skill came from by matching display names.
pub fn all_plugin_skills(root: &Path) -> Vec<Value> {
    plugin_skills(root, true)
}

/// Every script of every plugin, enabled or not, tagged with its owning bundle.
///
/// The same shape `all_plugin_skills` uses, so Settings lists all three parts of
/// a bundle the same way instead of special-casing scripts.
pub fn all_plugin_scripts(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        for mut row in list_scripts(root, &slug) {
            row["plugin"] = json!(label);
            row["plugin_slug"] = json!(slug);
            row["plugin_enabled"] = json!(enabled);
            out.push(row);
        }
    }
    out
}

/// Every connector of every plugin, enabled or not, tagged with its owning
/// bundle — plus the description and Persian keywords kept for it in the
/// bundle manifest (never inside `cfg`, which the MCP client forwards as-is).
pub fn all_plugin_connectors(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        let meta = connector_meta_map(root, &slug);
        for (name, cfg) in read_connectors(root, &slug) {
            let own = meta.get(&name).cloned().unwrap_or_else(|| json!({}));
            out.push(json!({
                "name": name,
                "cfg": cfg,
                "description": own["description"].as_str().unwrap_or(""),
                KEYWORDS: own[KEYWORDS].clone(),
                "plugin": label,
                "plugin_slug": slug,
                "plugin_enabled": enabled,
            }));
        }
    }
    out
}

fn plugin_skills(root: &Path, include_disabled: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (slug, manifest) in all_plugins(root) {
        let enabled = manifest["enabled"].as_bool().unwrap_or(true);
        if !include_disabled && !enabled {
            continue;
        }
        let label = manifest["name"].as_str().unwrap_or(&slug).to_string();
        // The bundle's OWN keywords travel as a SEPARATE field, never written
        // into a skill's `fa_keywords`. They are the last-resort trigger for a
        // skill that carries none — a whole library answering to one Persian
        // ask — but copying them onto every skill made all of them show the
        // same phrases in the editor, and a mixed bundle's list can only ever
        // describe SOME of its parts.
        let bundle_kw: Vec<String> = keywords_of(&manifest[KEYWORDS])
            .into_iter()
            .take(INHERIT_KEYWORDS_MAX)
            .collect();
        let listed = crate::skills::list_skills(&plugin_dir(root, &slug));
        for mut row in listed["skills"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
        {
            // A skill's keywords are its OWN, never the bundle's. Inheriting
            // them made every skill of a bundle list the same phrases, so the
            // editor showed one identical — and usually irrelevant, because a
            // mixed bundle's list can only describe SOME of its parts — trigger
            // for all of them. The bundle's own keywords still route a Persian
            // ask to the bundle (see `skill_router`), which is where a whole
            // library belongs.
            row["plugin"] = json!(label);
            if !bundle_kw.is_empty() {
                row["bundle_keywords"] = json!(bundle_kw.clone());
            }
            row["plugin_slug"] = json!(slug);
            row["plugin_enabled"] = json!(enabled);
            out.push(row);
        }
    }
    out
}

/// Per-connector metadata a bundle carries: `{name: {description, fa_keywords}}`.
pub(crate) fn connector_meta_map(root: &Path, slug: &str) -> serde_json::Map<String, Value> {
    read_manifest(root, slug)
        .and_then(|m| m[MCP_META].as_object().cloned())
        .unwrap_or_default()
}

/// Store (or clear) one connector's metadata inside the bundle manifest.
///
/// An entry carrying neither a description nor keywords is REMOVED rather than
/// written empty, so clearing both fields leaves no trace behind.
fn write_connector_meta(root: &Path, slug: &str, name: &str, entry: &Value) -> Result<(), String> {
    let Some(mut manifest) = read_manifest(root, slug) else {
        return Err(format!("plugin not found: {slug}"));
    };
    let mut all = connector_meta_map(root, slug);
    let blank = entry["description"]
        .as_str()
        .map_or(true, |d| d.trim().is_empty())
        && keywords_of(&entry[KEYWORDS]).is_empty();
    if blank {
        all.remove(name);
    } else {
        all.insert(name.to_string(), entry.clone());
    }
    if all.is_empty() {
        if let Some(map) = manifest.as_object_mut() {
            map.remove(MCP_META);
        }
    } else {
        manifest[MCP_META] = Value::Object(all);
    }
    manifest["updated_at"] = json!(now_secs());
    write_manifest(root, slug, &manifest)
}

/// Upsert one connector in a plugin's `mcp.json` (rename removes the old key).
pub fn save_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    if read_manifest(root, &slug).is_none() {
        return Err(format!("plugin not found: {slug}"));
    }
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let previous = body["previous_name"].as_str().unwrap_or("").trim();
    let cfg = body.get("cfg").cloned().unwrap_or_else(|| json!({}));
    if !cfg.is_object() {
        return Err("connector config must be an object".into());
    }
    let mut servers = read_connectors(root, &slug);
    if !previous.is_empty() && previous != name {
        servers.remove(previous);
    }
    servers.insert(name.to_string(), cfg);
    write_connectors(&plugin_dir(root, &slug), &servers)?;
    Ok(json!({ "ok": true, "slug": slug, "name": name, "mcp": connector_names(root, &slug) }))
}

/// Remove one connector from a plugin's `mcp.json`.
pub fn delete_connector(root: &Path, body: &Value) -> Result<Value, String> {
    let slug = plugin_ref(body);
    if read_manifest(root, &slug).is_none() {
        return Err(format!("plugin not found: {slug}"));
    }
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let mut servers = read_connectors(root, &slug);
    servers.remove(name);
    write_connectors(&plugin_dir(root, &slug), &servers)?;
    // Its metadata goes with it: a later connector reusing the name must not
    // inherit a description the user wrote for a different server.
    write_connector_meta(root, &slug, name, &json!({}))?;
    Ok(json!({ "ok": true, "slug": slug, "name": name, "mcp": connector_names(root, &slug) }))
}

/// Number of Persian keywords one skill inside a plugin actually carries.
///
/// Used right after an install to tell the model which skills a Persian request
/// could never reach, so it writes them in the same turn instead of reporting a
/// successful install that its user cannot trigger.
pub fn skill_keyword_count(root: &Path, slug: &str, name: &str) -> usize {
    crate::skills::list_skills(&plugin_dir(root, slug))["skills"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|r| {
                    r["name"].as_str() == Some(name) || r["slug"].as_str() == Some(name)
                })
                .and_then(|r| r["fa_keywords"].as_array().map(Vec::len))
        })
        .unwrap_or(0)
}

/// Locate a skill folder inside ONE plugin: `<root>/plugins/<slug>/skills/<name>`.
///
/// `skills::find_skill_dir` already walks a skill-store root, and a plugin
/// folder is exactly one, so the rules for name-vs-slug and the frontmatter
/// fallback stay in a single place.
pub fn find_skill_dir(root: &Path, slug: &str, name_or_slug: &str) -> Option<PathBuf> {
    crate::skills::find_skill_dir_pub(&plugin_dir(root, slug), name_or_slug)
}

/// Slug of the ENABLED plugin that carries a skill called `name_or_slug`.
///
/// Needed because a plugin's skills are served from the plugin folder, not from
/// the standalone `<root>/skills` store: without this, `load_skill` (and the
/// `/skills/file` route) answered "skill not found" for every skill the prompt
/// catalog had just advertised. Disabled plugins are skipped, so switching a
/// plugin off stays a real off switch.
pub fn plugin_of_skill(root: &Path, name_or_slug: &str) -> Option<String> {
    plugin_of_skill_in(root, name_or_slug, false)
}

/// The same lookup over EVERY bundle, enabled or not.
///
/// The two WRITERS need this: editing or deleting a skill that lives in a bundle
/// the user switched off must land in THAT bundle, not build a second one —
/// editing while off is exactly what someone opens Settings for.
pub fn plugin_of_skill_any(root: &Path, name_or_slug: &str) -> Option<String> {
    plugin_of_skill_in(root, name_or_slug, true)
}

fn plugin_of_skill_in(root: &Path, name_or_slug: &str, include_disabled: bool) -> Option<String> {
    let query = name_or_slug.trim();
    if query.is_empty() {
        return None;
    }
    let bundles = if include_disabled {
        all_plugins(root)
    } else {
        enabled_plugins(root)
    };
    for (slug, _) in bundles {
        let listed = crate::skills::list_skills(&plugin_dir(root, &slug));
        let hit = listed["skills"].as_array().is_some_and(|rows| {
            rows.iter().any(|s| {
                let n = s["name"].as_str().unwrap_or_default().trim();
                let sl = s["slug"].as_str().unwrap_or_default().trim();
                n.eq_ignore_ascii_case(query) || sl.eq_ignore_ascii_case(query)
            })
        });
        if hit {
            return Some(slug);
        }
    }
    None
}

/// Connectors of EVERY enabled plugin, as one map.
///
/// A normal chat turn carries them along without the user adding each connector
/// in Settings → MCP: an enabled plugin is ONE unit, so its connectors come with
/// its skills (a scheduled run already behaved this way). A name the user
/// configured themselves wins, exactly like `mcp_of`.
pub fn enabled_connectors(root: &Path) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (slug, _) in enabled_plugins(root) {
        for (name, cfg) in read_connectors(root, &slug) {
            out.entry(name).or_insert(cfg);
        }
    }
    out
}

/// Connectors of the NAMED plugins, skipping disabled ones and ignoring slugs
/// that no longer exist — a task that names a deleted plugin still runs.
pub fn mcp_of(root: &Path, slugs: &[String]) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (slug, _) in enabled_plugins(root) {
        if !slugs.iter().any(|s| s == &slug) {
            continue;
        }
        for (name, cfg) in read_connectors(root, &slug) {
            out.entry(name).or_insert(cfg);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-plugin-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    #[test]
    fn a_librarys_own_keywords_come_from_every_skill_not_the_first_one() {
        // The reported bug: the built-in bundle advertised ONE topic (whichever
        // skill the folder listing happened to return first), so a Persian ask
        // about anything else in the same library never reached it.
        let lists = vec![
            vec!["a1".into(), "a2".into(), "a3".into(), "a4".into()],
            vec!["b1".into()],
            vec!["c1".into(), "c2".into()],
        ];
        assert_eq!(
            interleave(&lists, 4),
            vec!["a1", "b1", "c1", "a2"],
            "each skill must contribute before any skill contributes twice"
        );
        // The cap holds, and a phrase two skills share is paid for once.
        let shared = vec![vec!["same".into(), "x".into()], vec!["same".into(), "y".into()]];
        assert_eq!(interleave(&shared, 8), vec!["same", "x", "y"]);
        assert_eq!(interleave(&shared, 1), vec!["same"]);
        assert!(interleave(&[], 8).is_empty());
    }

    #[test]
    fn enabled_connectors_come_from_every_enabled_plugin() {
        let root = temp_root("connectors");
        create_plugin(
            &root,
            &json!({
                "name": "Notes",
                "skills": [{"name": "Notes", "content": "x"}],
                "mcp": {"notes": {"command": "npx"}}
            }),
        )
        .unwrap();
        create_plugin(
            &root,
            &json!({
                "name": "Search",
                "skills": [{"name": "Search", "content": "x"}],
                "mcp": {"search": {"command": "npx"}}
            }),
        )
        .unwrap();

        // A chat turn carries an enabled plugin's connectors along — the whole
        // point of a bundle is that it switches on as ONE unit.
        let all = enabled_connectors(&root);
        assert!(all.contains_key("notes"), "{all:?}");
        assert!(all.contains_key("search"), "{all:?}");

        // Switching one off removes only ITS connector.
        toggle_plugin(&root, &json!({"slug": "notes", "enabled": false})).unwrap();
        let after = enabled_connectors(&root);
        assert!(!after.contains_key("notes"), "{after:?}");
        assert!(after.contains_key("search"), "{after:?}");
    }

    #[test]
    fn create_update_toggle_delete_round_trip() {
        let root = temp_root("round-trip");

        let created = create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "description": "turns git log into notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "# steps\n\nread the log",
                    "description": "when the user asks for release notes",
                    "fa_keywords": "یادداشت انتشار"
                }],
                "mcp": {"notes": {"command": "npx"}}
            }),
        )
        .unwrap();
        assert_eq!(created["slug"], "release-notes");
        assert_eq!(created["enabled"], true);
        assert_eq!(created["skills"], json!(["Release Notes"]));
        assert_eq!(created["mcp"], json!(["notes"]));
        assert!(plugin_dir(&root, "release-notes").join(MANIFEST).is_file());

        // A second create on the same slug must fail instead of overwriting.
        let dup = create_plugin(&root, &json!({"name": "Release Notes"}));
        assert!(dup.is_err(), "duplicate create must be rejected");

        // Patch update: description changes, the skill stays.
        let updated = update_plugin(
            &root,
            &json!({"slug": "release-notes", "version": "2.0.0"}),
        )
        .unwrap();
        assert_eq!(updated["version"], "2.0.0");
        assert_eq!(updated["skills"], json!(["Release Notes"]));
        assert_eq!(updated["description"], "turns git log into notes");

        // Disabled plugins contribute nothing to the catalog or the connectors.
        toggle_plugin(&root, &json!({"slug": "release-notes", "enabled": false})).unwrap();
        assert!(enabled_plugin_skills(&root).is_empty());
        assert!(mcp_of(&root, &["release-notes".to_string()]).is_empty());
        assert_eq!(list_plugins(&root)["plugins"].as_array().unwrap().len(), 1);

        let on = toggle_plugin(&root, &json!({"slug": "release-notes"})).unwrap();
        assert_eq!(on["enabled"], true);
        let rows = enabled_plugin_skills(&root);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["plugin"], "Release Notes");
        assert!(mcp_of(&root, &["release-notes".to_string()]).contains_key("notes"));
        // An unnamed plugin contributes nothing to a task's connectors.
        assert!(mcp_of(&root, &[]).is_empty());

        delete_plugin(&root, &json!({"slug": "release-notes"})).unwrap();
        assert!(list_plugins(&root)["plugins"].as_array().unwrap().is_empty());
        assert!(enabled_plugin_skills(&root).is_empty());
        // Deleting twice is a no-op, not an error.
        assert!(delete_plugin(&root, &json!({"slug": "release-notes"})).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn update_requires_an_existing_plugin() {
        let root = temp_root("missing");
        assert!(update_plugin(&root, &json!({"slug": "ghost"})).is_err());
        assert!(toggle_plugin(&root, &json!({"slug": "ghost"})).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plugin_skill_can_be_located_and_read() {
        // A plugin's skills live in `<root>/plugins/<slug>/skills/`, not in the
        // standalone store. `load_skill` used to read only the store, so every
        // skill the catalog advertised from a plugin answered "skill not found".
        let root = temp_root("locate");
        create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "# steps\n\nread the log",
                    "fa_keywords": "یادداشت انتشار",
                    "extra_files": {"checklist.md": "- tag the release"}
                }]
            }),
        )
        .unwrap();

        assert_eq!(plugin_of_skill(&root, "Release Notes").as_deref(), Some("release-notes"));
        // The folder slug resolves the skill too, case-insensitively.
        assert_eq!(plugin_of_skill(&root, "release-notes").as_deref(), Some("release-notes"));
        let dir = find_skill_dir(&root, "release-notes", "Release Notes").expect("skill folder");
        assert!(dir.join("skill.md").is_file());
        let extra = crate::skills::read_extra_file(&dir, "Release Notes", "checklist.md").unwrap();
        assert_eq!(extra["content"], "- tag the release");

        // A disabled plugin is a real off switch: nothing resolves.
        toggle_plugin(&root, &json!({"slug": "release-notes", "enabled": false})).unwrap();
        assert!(plugin_of_skill(&root, "Release Notes").is_none());
        // Unknown names and blank queries resolve to nothing, never to a panic.
        assert!(plugin_of_skill(&root, "Ghost").is_none());
        assert!(plugin_of_skill(&root, "  ").is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_seeds_persian_keywords_from_the_marketplace_name() {
        // The reported bug: a plugin installed from a marketplace index landed
        // with NO `fa_keywords` (neither plugin nor skills), so a Persian ask
        // never found it. The row's NAME seeds them: a product noun names a real
        // capability, while prose and the declared category are what used to file
        // «تحلیل داده» onto a database tool and «بهره‌وری» onto a messaging bridge.
        let src = temp_root("seed-src");
        fs::create_dir_all(src.join("skills/sec"))
            .unwrap();
        fs::write(src.join("plugin.json"), r#"{"name":"Sentry Security","version":"1.0.0"}"#).unwrap();
        fs::write(
            src.join("skills/sec/SKILL.md"),
            "---\nname: sec\n---\n# sec\nBody.",
        )
        .unwrap();
        let root = temp_root("seed-install");
        let out = install_plugin(
            &root,
            &json!({
                "repo": src.to_str().unwrap(),
                "category": "xyzzynotknown",
                "description": "Assorted utilities for folders",
            }),
        )
        .unwrap();
        let seeded = out["plugin"][KEYWORDS].as_array().unwrap();
        assert!(!seeded.is_empty(), "the product name must seed Persian keywords");
        assert!(
            seeded.iter().any(|k| k.as_str() == Some("مانیتورینگ")),
            "got {seeded:?}"
        );
        // The manifest carries them too, so the seed survives a reload.
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(plugin_dir(&root, "sentry-security").join(MANIFEST)).unwrap(),
        )
        .unwrap();
        assert!(!manifest[KEYWORDS].as_array().unwrap().is_empty());
        // A NAME that identifies no technology guesses NOTHING: a wrong keyword
        // fires the wrong skill, so such a bundle stays keyword-free to edit —
        // neither the category NOR the prose is read at all.
        let bare_root = temp_root("seed-unknown");
        let bare = install_plugin(
            &bare_root,
            &json!({
                "repo": src.to_str().unwrap(),
                "name": "Mystery Bundle",
                "category": "security",
                "description": "Automate API security audits",
            }),
        )
        .unwrap();
        assert_eq!(bare["plugin"][KEYWORDS], json!([]));
        let up_root = temp_root("seed-on-update");
        install_plugin(
            &up_root,
            &json!({"repo": src.to_str().unwrap(), "category": "xyzzynotknown"}),
        )
        .unwrap();
        let updated = install_plugin(
            &up_root,
            // Address only, like the card's "Update from source" button.
            &json!({"repo": src.to_str().unwrap()}),
        )
        .unwrap();
        // An address-only update still seeds, because the seed comes from the
        // row's NAME (which an update carries) and not from the category (which
        // it does not).
        assert!(
            updated["plugin"][KEYWORDS].as_array().is_some_and(|a| !a.is_empty()),
            "an address-only update must still seed from the name, got {:?}",
            updated["plugin"][KEYWORDS]
        );
        // The reported wrong-keyword bug: the official index files telegram as
        // "productivity" while the bundle is a MESSAGING bridge. The NAME decides
        // — a Persian ask for پیام must find it, «بهره‌وری» must never land — and
        // the prose is not read at all any more.
        let tg = temp_root("seed-telegram-src");
        fs::create_dir_all(tg.join("skills/bridge")).unwrap();
        fs::write(
            tg.join("plugin.json"),
            r#"{"name":"Telegram Bridge","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            tg.join("skills/bridge/SKILL.md"),
            "---\nname: bridge\n---\n# bridge\nBody.",
        )
        .unwrap();
        let wrong_root = temp_root("seed-wrong-category");
        let wrong = install_plugin(
            &wrong_root,
            &json!({
                "repo": tg.to_str().unwrap(),
                "category": "productivity",
                "description": "Assorted note-taking helpers for the whole team",
            }),
        )
        .unwrap();
        let wrong_kw = wrong["plugin"][KEYWORDS].as_array().unwrap();
        assert!(
            wrong_kw.iter().any(|k| k.as_str() == Some("پیام")),
            "the name must decide the domain, got {wrong_kw:?}"
        );
        assert!(
            !wrong_kw.iter().any(|k| k.as_str() == Some("بهره‌وری")),
            "the declared category must not leak its keywords, got {wrong_kw:?}"
        );
        let _ = fs::remove_dir_all(&wrong_root);
        let _ = fs::remove_dir_all(&tg);
        let _ = fs::remove_dir_all(&up_root);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn a_marketplace_skill_row_keeps_its_description_and_keywords() {
        // Reported: an installed skill showed a blank card line, and the Persian
        // trigger it shipped with was nowhere to be found. The row's own
        // frontmatter has to survive the trip into a bundle at BOTH levels,
        // because the card reads the manifest and the catalog reads the skill.
        let root = temp_root("row-meta");
        let src = temp_root("row-meta-src");
        fs::create_dir_all(src.join("writer")).unwrap();
        fs::write(
            src.join("writer/SKILL.md"),
            "---\nname: Lex Writer\ndescription: Writes copy that sells\n\
             fa_keywords: نویسندگی, متن تبلیغاتی\n---\n# writer\nBody.",
        )
        .unwrap();
        let out = install_from_marketplace(
            &root,
            &json!({"kind": "skills", "repo": src.to_str().unwrap()}),
        )
        .unwrap();
        let slug = out["slug"].as_str().unwrap();
        let manifest = read_manifest(&root, slug).unwrap();
        assert_eq!(
            manifest["description"],
            json!("Writes copy that sells"),
            "the bundle card must not be blank"
        );
        assert_eq!(
            keywords_of(&manifest[KEYWORDS]),
            vec!["نویسندگی".to_string(), "متن تبلیغاتی".to_string()],
            "the bundle must answer the row's own Persian phrases"
        );
        let dir = skill_dir_for(&root, "Lex Writer").unwrap();
        let md = fs::read_to_string(dir.join("skill.md")).unwrap();
        let (_, _, desc, fa) = crate::skills::parse_frontmatter_pub(&md);
        assert_eq!(desc, "Writes copy that sells", "the skill keeps its own line");
        assert_eq!(fa.len(), 2, "the skill keeps its own phrases, got {fa:?}");

        // A REINSTALL must not wipe what is stored: the row is read again and
        // the same fields have to come back unchanged.
        install_from_marketplace(
            &root,
            &json!({"kind": "skills", "repo": src.to_str().unwrap()}),
        )
        .unwrap();
        let again = read_manifest(&root, slug).unwrap();
        assert_eq!(again["description"], json!("Writes copy that sells"));
        assert_eq!(keywords_of(&again[KEYWORDS]).len(), 2);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn a_marketplace_row_lands_in_a_bundle_whatever_its_tab() {
        // A bundle is the ONLY container, so the tab no longer picks a store: it
        // decides what the row CONTRIBUTES. A skills row installs, and its skill
        // is then findable by name through the bundle tree — which is what the
        // Settings list and the `@` picker both read.
        let root = temp_root("kind-routing");

        // A skills row: one single-part bundle holding that skill.
        let skill_src = temp_root("kind-skill-src");
        fs::create_dir_all(skill_src.join("writer")).unwrap();
        fs::write(
            skill_src.join("writer/SKILL.md"),
            "---\nname: Lex Writer\ndescription: Writes copy\n---\n# writer\nBody.",
        )
        .unwrap();
        let out = install_from_marketplace(
            &root,
            &json!({"kind": "skills", "repo": skill_src.to_str().unwrap()}),
        )
        .unwrap();
        assert_eq!(out["skills"], json!(["Lex Writer"]));
        assert!(
            skill_dir_for(&root, "Lex Writer").is_some(),
            "a skills row must be findable through its bundle"
        );
        assert!(
            plugin_dir(&root, out["slug"].as_str().unwrap())
                .join(MANIFEST)
                .is_file(),
            "the skill must live in a bundle, not a standalone store"
        );

        // An MCP row: a single-part bundle holding the connector.
        let mcp_src = temp_root("kind-mcp-src");
        fs::create_dir_all(&mcp_src).unwrap();
        fs::write(
            mcp_src.join(".mcp.json"),
            r#"{"mcpServers":{"lex-tools":{"command":"npx","args":["-y","lex-tools"]}}}"#,
        )
        .unwrap();
        let out = install_from_marketplace(
            &root,
            &json!({"kind": "mcp", "repo": mcp_src.to_str().unwrap()}),
        )
        .unwrap();
        assert_eq!(out["mcp"], json!(["lex-tools"]));
        let stored = read_connectors(&root, out["slug"].as_str().unwrap());
        assert_eq!(stored["lex-tools"]["command"], "npx");

        // No kind (the Plugins tab, or a `/plugin install`): a BUNDLE, as before.
        let plugin_src = temp_root("kind-plugin-src");
        fs::create_dir_all(plugin_src.join("skills/one")).unwrap();
        fs::write(
            plugin_src.join("plugin.json"),
            r#"{"name":"Lex Plugin","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            plugin_src.join("skills/one/SKILL.md"),
            "---\nname: one\n---\n# one\nBody.",
        )
        .unwrap();
        install_from_marketplace(
            &root,
            &json!({"repo": plugin_src.to_str().unwrap()}),
        )
        .unwrap();
        assert!(plugin_dir(&root, "lex-plugin").join(MANIFEST).is_file());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&skill_src);
        let _ = fs::remove_dir_all(&mcp_src);
        let _ = fs::remove_dir_all(&plugin_src);
    }

    #[test]
    fn a_wrong_category_is_not_read_as_fact() {
        // Reported: a bundle filed under a WRONG category answered to that
        // category's Persian words. The row NAME identifies the domain, so a
        // messaging bridge must answer to «پیام» and never to «بهره‌وری».
        let prod = category_keywords("telegram");
        assert!(prod.iter().any(|k| k == "پیام"), "got {prod:?}");
        assert!(!prod.iter().any(|k| k == "بهره‌وری"), "got {prod:?}");

        // A name with no technology noun stays KEYWORD-FREE: prose and category
        // are no longer read at all, so nothing can be misfiled from them.
        assert!(category_keywords("altimate-code").is_empty());
        assert!(category_keywords("mystery-bundle").is_empty());

        // A name that IS a product noun maps on its own.
        let db = category_keywords("clickhouse");
        assert!(db.iter().any(|k| k == "دیتابیس"), "got {db:?}");
        let loc = category_keywords("amazon-location-service");
        assert!(loc.iter().any(|k| k == "نقشه"), "got {loc:?}");
    }

    #[test]
    fn boot_sweep_also_fixes_the_seed_inside_each_skill() {
        // The per-skill seed read the category and the row's prose too, so the
        // same wrong list sits in each shipped skill's frontmatter — and a
        // skill's OWN list outranks the bundle's when the skill is matched. A
        // sweep that only rewrote the manifest left the wrong trigger in force.
        let root = temp_root("boot-remap-skill");
        let dir = plugins_dir(&root).join("skills");
        // The REAL layout `sync_skill` writes: the skills live one level below
        // the bundle (`<plugin>/skills/<slug>/skill.md`). The fixture used to
        // write `<plugin>/<slug>/skill.md`, which the sweep read and no writer
        // produces — so it passed while the sweep was blind to real skills.
        fs::create_dir_all(dir.join("skills").join("docx")).unwrap();
        fs::write(
            dir.join(MANIFEST),
            serde_json::to_string(&json!({ "name": "skills" })).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join("skills").join("docx").join("skill.md"),
            "---\nname: docx\ndescription: Word documents\nfa_keywords: داده، تحلیل داده، پردازش داده\n---\n\n# docx\n\nBody text.\n",
        )
        .unwrap();

        remap_legacy_keywords(&root);

        let raw = fs::read_to_string(dir.join("skills").join("docx").join("skill.md")).unwrap();
        assert!(!raw.contains("تحلیل داده"), "wrong seed survived: {raw}");
        assert!(raw.contains("Body text."), "body must survive: {raw}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn boot_sweep_remaps_a_wrong_seed_already_on_disk() {
        // Reported: the wrong keywords were ALREADY written into the installed
        // folder by the earlier mapper, so fixing the mapper alone left telegram
        // answering to «بهره‌وری، کارایی». The boot sweep corrects such a bundle
        // without the user re-installing it — and still leaves a hand-typed list
        // alone, because only a verbatim machine seed counts as stale.
        let root = temp_root("boot-remap");
        let dir = plugins_dir(&root).join("telegram");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST),
            serde_json::to_string(&json!({
                "name": "telegram",
                "description": "Telegram channel — messaging bridge with access control",
                SOURCE_CATEGORY: "productivity",
                KEYWORDS: ["بهره‌وری", "کارایی", "مدیریت کار"],
            }))
            .unwrap(),
        )
        .unwrap();
        // A hand-typed list that is NOT a full machine seed stays untouched:
        // that is the only way a stored list can be told apart from a seed.
        let partial = plugins_dir(&root).join("partial");
        fs::create_dir_all(&partial).unwrap();
        fs::write(
            partial.join(MANIFEST),
            serde_json::to_string(&json!({
                "name": "partial",
                KEYWORDS: ["بهره‌وری", "کارایی"],
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(remap_legacy_keywords(&root), 1, "only the machine seed");
        let fixed = read_manifest(&root, "telegram").unwrap();
        let kw = keywords_of(&fixed[KEYWORDS]);
        assert!(kw.iter().any(|k| k == "پیام"), "got {kw:?}");
        assert!(!kw.iter().any(|k| k == "بهره‌وری"), "got {kw:?}");
        // The short hand-typed list is the user's and survives verbatim.
        let kept = read_manifest(&root, "partial").unwrap();
        assert_eq!(
            keywords_of(&kept[KEYWORDS]),
            vec!["بهره‌وری".to_string(), "کارایی".to_string()]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn paragraph_keyword_seed_is_recognised_by_verbatim_comparison() {
        // The re-map gate: only a list an EARLIER mapper wrote is replaceable, so
        // a list the user retyped (or reordered) is never touched.
        assert!(is_legacy_seed(&["بهره‌وری".into(), "کارایی".into(), "مدیریت کار".into()]));
        assert!(is_legacy_seed(&["داده".into(), "تحلیل داده".into(), "پردازش داده".into()]));
        // A reorder is still the same machine list.
        assert!(is_legacy_seed(&["کارایی".into(), "بهره‌وری".into(), "مدیریت کار".into()]));
        // A hand-typed phrase is the user's own and must survive.
        assert!(!is_legacy_seed(&["بهره‌وری".into(), "کارایی".into()]));
        assert!(!is_legacy_seed(&["دموی من".into()]));
        assert!(!is_legacy_seed(&[]));
    }

    #[test]
    fn a_stale_seed_is_remapped_and_a_hand_typed_list_is_kept() {
        // Reported: the wrong keywords were already written into the installed
        // folder, so fixing the mapper alone left the bad list in place forever.
        // An install always carries the bundle's own name/description, so it can
        // re-map a machine seed — while a list the USER typed is never touched.
        let src = temp_root("stale-src");
        fs::create_dir_all(src.join("skills/msg")).unwrap();
        fs::write(src.join("plugin.json"), r#"{"name":"telegram"}"#).unwrap();
        fs::write(
            src.join("skills/msg/SKILL.md"),
            "---\nname: msg\n---\n# msg\nBody.",
        )
        .unwrap();
        let root = temp_root("stale-root");
        let spec = src.to_str().unwrap();
        install_plugin(&root, &json!({"repo": spec})).unwrap();
        // Simulate the install an older mapper produced.
        update_plugin(
            &root,
            &json!({
                "slug": "telegram",
                "fa_keywords": ["بهره‌وری", "کارایی", "مدیریت کار"],
            }),
        )
        .unwrap();
        // Reinstalling re-maps that stale seed: the row's own name is enough.
        let fixed = install_plugin(&root, &json!({"repo": spec})).unwrap();
        let kw = fixed["plugin"][KEYWORDS].as_array().unwrap();
        assert!(
            kw.iter().any(|k| k.as_str() == Some("پیام")),
            "the stale seed must be re-mapped, got {kw:?}"
        );
        assert!(!kw.iter().any(|k| k.as_str() == Some("بهره‌وری")), "got {kw:?}");
        // A hand-typed list is the user's own, so a reinstall leaves it alone.
        update_plugin(
            &root,
            &json!({"slug": "telegram", "fa_keywords": ["تلگرام", "پیام‌رسان من"]}),
        )
        .unwrap();
        let kept = install_plugin(&root, &json!({"repo": spec})).unwrap();
        let kept_kw = kept["plugin"][KEYWORDS].as_array().unwrap();
        assert!(
            kept_kw.iter().any(|k| k.as_str() == Some("پیام‌رسان من")),
            "a hand-typed list must survive a reinstall, got {kept_kw:?}"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn install_records_the_address_and_keeps_edited_keywords() {
        // "Update from source" needs the ARGUMENTS, not a display string, and a
        // reinstall must not discard keywords the user typed by hand.
        // The install source is a plain folder, which `repo.rs` reads through
        // the SAME path a GitHub repo takes — so this needs no network.
        let src = temp_root("install-src");
        fs::create_dir_all(src.join("skills/alpha")).unwrap();
        fs::write(src.join("plugin.json"), r#"{"name":"Demo","version":"1.0.0"}"#).unwrap();
        fs::write(
            src.join("skills/alpha/SKILL.md"),
            "---\nname: alpha\n---\n# alpha\nBody.",
        )
        .unwrap();
        let root = temp_root("install-addr");
        let spec = src.to_str().unwrap();
        let out = install_plugin(&root, &json!({"repo": spec})).unwrap();
        let slug = out["slug"].as_str().unwrap().to_string();
        assert_eq!(out["installed"], "created");
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(plugin_dir(&root, &slug).join(MANIFEST)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["source_repo"], spec);

        // The user adds keywords by hand; the repo carries none.
        update_plugin(
            &root,
            &json!({"slug": slug, "fa_keywords": ["دموی من"]}),
        )
        .unwrap();
        let again = install_plugin(&root, &json!({"repo": spec})).unwrap();
        assert_eq!(again["installed"], "updated");
        assert_eq!(again["plugin"][KEYWORDS], json!(["دموی من"]));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn creating_a_plugin_by_hand_keeps_its_keywords() {
        // The reported bug: `create_plugin` wrote no plugin-level
        // `fa_keywords`, so a bundle created by hand (from the chat or the
        // agent's tool) was saved WITHOUT them and could never be found from a
        // Persian request — while `update_plugin` saved them fine.
        let root = temp_root("create-keywords");
        let created = create_plugin(
            &root,
            &json!({
                "name": "Demo",
                "fa_keywords": "دموی من, نمونه",
                "skills": [{"name": "Demo", "content": "x"}]
            }),
        )
        .unwrap();
        assert_eq!(created[KEYWORDS], json!(["دموی من", "نمونه"]));
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(plugin_dir(&root, "demo").join(MANIFEST)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest[KEYWORDS], json!(["دموی من", "نمونه"]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_seeds_keywords_on_skills_that_carry_none() {
        // The reported bug, second half: a bundle installed from a marketplace
        // whose rows carry no per-skill keywords landed with a keyworded PLUGIN
        // but BARE skills — and a Persian request found the plugin, not its
        // skills. The skill's row now carries the bundle's list as
        // `bundle_keywords`, so the router reaches it WITHOUT the bundle's
        // phrases being written on every skill as if they were its own.
        let src = temp_root("skill-seed-src");
        fs::create_dir_all(src.join("skills/guard")).unwrap();
        fs::write(
            src.join("plugin.json"),
            r#"{"name":"Sentry Guard","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            src.join("skills/guard/SKILL.md"),
            "---\nname: guard\ndescription: Automated API security auditing and vulnerability scanning\n---\n# guard\nBody.",
        )
        .unwrap();
        let root = temp_root("skill-seed");
        let out = install_plugin(
            &root,
            &json!({
                "repo": src.to_str().unwrap(),
                "category": "security",
                "description": "API security testing",
            }),
        )
        .unwrap();
        // The PLUGIN was seeded by the earlier fix; the SKILL must be reachable
        // through that same list without owning it.
        assert!(!out["plugin"][KEYWORDS].as_array().unwrap().is_empty());
        let rows = enabled_plugin_skills(&root);
        let skill = rows
            .iter()
            .find(|r| r["name"] == "guard")
            .expect("the installed skill must be listed")
            .clone();
        assert!(
            !skill["bundle_keywords"].as_array().unwrap_or(&vec![]).is_empty(),
            "a skill with no keywords of its own must carry the bundle's as a fallback"
        );
        assert!(
            keywords_of(&skill[KEYWORDS]).is_empty(),
            "the bundle's phrases must not be written as if they were the skill's OWN"
        );
        // A skill that DOES ship its own keywords is never overwritten.
        let src2 = temp_root("skill-own-src");
        fs::create_dir_all(src2.join("skills/own")).unwrap();
        fs::write(src2.join("plugin.json"), r#"{"name":"Own","version":"1.0.0"}"#).unwrap();
        fs::write(
            src2.join("skills/own/SKILL.md"),
            "---\nname: own\ndescription: x\nfa_keywords: کلیدواژهٔ خودم\n---\n# own\nBody.",
        )
        .unwrap();
        let root2 = temp_root("skill-own");
        install_plugin(
            &root2,
            &json!({
                "repo": src2.to_str().unwrap(),
                "category": "security",
                "description": "security security",
            }),
        )
        .unwrap();
        let rows2 = enabled_plugin_skills(&root2);
        let own = rows2
            .iter()
            .find(|r| r["name"] == "own")
            .expect("the skill must be listed")
            .clone();
        assert_eq!(keywords_of(&own[KEYWORDS]), vec!["کلیدواژهٔ خودم".to_string()]);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&src2);
    }

    #[test]
    fn a_skill_with_no_keywords_keeps_the_ones_the_user_added() {
        // `sync_skill` now treats an explicit empty value as "remove them", so
        // a bundle edit that names no keywords must send NULL (keep) rather
        // than "" (clear) or every save would silently drop the user's own
        // Persian trigger.
        let root = temp_root("keep-skill-keywords");
        create_plugin(
            &root,
            &json!({
                "name": "Demo",
                "skills": [{"name": "Demo", "content": "x", "fa_keywords": "دموی من"}]
            }),
        )
        .unwrap();
        update_plugin(
            &root,
            &json!({
                "slug": "demo",
                "skills": [{"name": "Demo", "content": "x"}]
            }),
        )
        .unwrap();
        let rows = enabled_plugin_skills(&root);
        assert_eq!(rows[0][KEYWORDS], json!(["دموی من"]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_script_defaults_to_rust_and_an_unknown_language_is_refused() {
        // Rust is the DEFAULT, not one of four equal choices: the caller has to
        // ask for anything else. A typo must be refused here rather than write a
        // script nothing knows how to run.
        let root = temp_root("script-lang");
        let created = create_plugin(
            &root,
            &json!({
                "name": "Toolkit",
                "scripts": [{"name": "Ping"}, {"name": "Probe", "language": "py"}]
            }),
        )
        .unwrap();
        assert_eq!(created["scripts"], json!(["Ping", "Probe"]));
        // No `language` given: Rust, both on disk and in the manifest.
        assert!(scripts_dir(&root, "toolkit").join("ping/main.rs").is_file());
        let meta = read_script(&root, "toolkit", "ping").unwrap();
        assert_eq!(meta["language"], "rust");
        // Aliases resolve to one canonical name, so `py` lands on `main.py`.
        let probe = read_script(&root, "toolkit", "probe").unwrap();
        assert_eq!(probe["language"], "python");
        assert!(scripts_dir(&root, "toolkit").join("probe/main.py").is_file());

        assert!(create_plugin(
            &root,
            &json!({"name": "Broken", "scripts": [{"name": "x", "language": "cobol"}]}),
        )
        .is_err());
        // The cap is a real ceiling rather than a silent truncation.
        let too_many: Vec<Value> = (0..=MAX_SCRIPTS)
            .map(|i| json!({"name": format!("s{i}")}))
            .collect();
        assert!(update_plugin(
            &root,
            &json!({"slug": "toolkit", "scripts": too_many}),
        )
        .is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_script_runs_and_reports_its_own_words() {
        // The whole point of a script is its OUTPUT. Bash is used here so the
        // test does not depend on a compiler — the Rust path is the same call
        // with `rustc` in front, covered by the language test above.
        let root = temp_root("script-run");
        create_plugin(
            &root,
            &json!({
                "name": "Toolkit",
                "scripts": [{
                    "name": "Greet",
                    "language": "bash",
                    "content": "echo \"hello $1\""
                }]
            }),
        )
        .unwrap();
        let out = run_plugin_script(
            &root,
            &json!({"slug": "toolkit", "name": "GREET", "args": ["world"]}),
        )
        .unwrap();
        assert_eq!(out["language"], "bash");
        // The name is echoed back as it was asked for; the lookup itself is
        // case-insensitive, which is exactly why `GREET` resolved at all.
        assert_eq!(out["script"].as_str().unwrap_or("").to_lowercase(), "greet");
        assert!(
            out["output"].as_str().unwrap_or("").contains("hello world"),
            "unexpected output: {out}"
        );

        // A name that is not there must list what IS, not fail blankly.
        let err = run_plugin_script(&root, &json!({"slug": "toolkit", "name": "ghost"}))
            .unwrap_err();
        // The stored name is listed as written; the lookup itself is
        // case-insensitive, which is why `greet` above resolved `Greet`.
        assert!(
            err.to_lowercase().contains("greet"),
            "unhelpful error: {err}"
        );
        // Switching the bundle OFF must take its scripts with it: the switch is
        // one unit, and a script of a bundle the user turned off running anyway
        // would make that switch a lie.
        update_plugin(&root, &json!({"slug": "toolkit", "enabled": false})).unwrap();
        let off = run_plugin_script(&root, &json!({"slug": "toolkit", "name": "greet"})).unwrap_err();
        assert!(
            off.contains("switched off"),
            "a switched-off bundle must refuse its scripts: {off}"
        );
        // And back on makes it runnable again (no state was lost).
        update_plugin(&root, &json!({"slug": "toolkit", "enabled": true})).unwrap();
        assert!(run_plugin_script(&root, &json!({"slug": "toolkit", "name": "greet"})).is_ok());

        // Deleting is a real removal, so the script list follows.
        update_plugin(
            &root,
            &json!({"slug": "toolkit", "deleted_scripts": ["greet"]}),
        )
        .unwrap();
        assert!(script_names(&root, "toolkit").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_connector_saved_with_a_slug_lands_in_that_bundle_not_a_new_one() {
        // The reported bug: Settings → a bundle's page sent `{slug, name, cfg}`
        // and the save ignored the slug, so a NEW single-part bundle was created
        // named after the connector and the bundle on screen stayed empty.
        let root = temp_root("conn-slug");
        install_bundle(
            &root,
            "Toolkit",
            json!({ "skills": [{ "name": "one", "content": "# One\n" }] }),
        )
        .unwrap();

        let out = save_bundle_connector(
            &root,
            &json!({
                "slug": "toolkit",
                "name": "fs",
                "cfg": { "command": "npx", "args": ["-y", "server-fs"] },
                "description": "Filesystem access",
                "fa_keywords": ["فایل"],
            }),
        )
        .unwrap();
        assert_eq!(out["slug"], "toolkit");

        // The connector is IN the bundle, and no bundle was invented for it.
        assert_eq!(connector_names(&root, "toolkit"), vec!["fs".to_string()]);
        let all: Vec<String> = all_plugins(&root).into_iter().map(|(s, _)| s).collect();
        assert_eq!(all, vec!["toolkit".to_string()], "a stray bundle was created");

        // Its metadata sits in the manifest, never in `cfg` (forwarded verbatim).
        let row = all_plugin_connectors(&root)
            .into_iter()
            .find(|r| r["name"] == "fs")
            .expect("the connector row");
        assert_eq!(row["description"], "Filesystem access");
        assert_eq!(row["fa_keywords"][0], "فایل");
        assert!(row["cfg"].get("description").is_none(), "{row}");

        // Deleting from the page targets the same bundle.
        let gone = delete_bundle_connector(&root, &json!({ "slug": "toolkit", "name": "fs" }))
            .unwrap();
        assert_eq!(gone["ok"], true);
        assert!(connector_names(&root, "toolkit").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_with_a_name_says_to_create_instead_of_blaming_the_repo() {
        // The reported dead end: `/plugin install eurusd` reached `repo::parse`
        // and failed with "cannot read a repo from …", which reads as a bug when
        // the user simply wanted a bundle by that name.
        let root = temp_root("install-name");
        let err = install_plugin(&root, &json!({"repo": "eurusd"})).unwrap_err();
        assert!(err.contains("is a name, not a repo address"), "{err}");
        assert!(err.contains("action=create"), "{err}");
        // A real address still gets through the guard untouched (and fails only
        // because this one does not exist).
        let real = install_plugin(&root, &json!({"repo": "owner/repo"})).unwrap_err();
        assert!(!real.contains("is a name, not a repo address"), "{real}");
        let _ = fs::remove_dir_all(&root);
    }
}
