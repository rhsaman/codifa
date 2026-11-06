use super::*;

/// The phrase lists an EARLIER mapper wrote into the bundles it seeded.
///
/// Kept as history and still load-bearing: a stored `fa_keywords` that matches
/// one of these lists VERBATIM was written by that mapper (which read the
/// index's declared category as fact) and never typed by hand, so it is safe to
/// re-map. See `is_legacy_seed`.
pub(super) const LEGACY_CATEGORY_KEYWORDS: [(&str, &str); 12] = [
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
pub(super) fn category_keywords(name: &str) -> Vec<String> {
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
pub(super) fn is_legacy_seed(stored: &[String]) -> bool {
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
pub(super) fn remap_skill_keywords(dir: &Path) -> usize {
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

