//! Native skills / MCP / system-prompts endpoints (phase 2).
//!
//! Mirrors the file-backed parts of backend/state_db.py + tools.py:
//! - skills live in `<data_root>/skills/<slug>/skill.md` (YAML frontmatter)
//!   plus optional extra files in the same folder
//! - MCP connectors are one JSON file per name under `<data_root>/mcp/`
//! - system prompts are a static in-code map (agents.SYSTEM_PROMPTS)

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

// --- helpers (mirror state_db.py) -------------------------------------------

fn raw_slug(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn skill_slug(name: &str) -> String {
    let slug = raw_slug(name);
    if !slug.is_empty() {
        return slug;
    }
    // Stable hash for non-ASCII names (mirror of state_db._skill_slug).
    let digest = sha1_hex(name.trim().as_bytes());
    format!("skill-{}", &digest[..8])
}

fn sha1_hex(data: &[u8]) -> String {
    // Minimal SHA-1 (state_db only needs the first 8 hex chars for skill dirs).
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let ml = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&ml.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

fn safe_file(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(|c| c == '.' || c == '-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn skills_dir(root: &Path) -> PathBuf {
    root.join("skills")
}

fn skill_dir(root: &Path, slug: &str) -> PathBuf {
    skills_dir(root).join(safe_file(slug, "skill"))
}

/// Drop a leading `---…---` frontmatter block. `sync_skill` re-adds its own, so
/// a caller that passes a whole skill.md (the settings editor does) must not
/// have its copy embedded in the body.
fn strip_frontmatter(raw: &str) -> String {
    if !raw.starts_with("---") {
        return raw.to_string();
    }
    match raw.find("\n---") {
        Some(i) => raw[i + 4..].trim_start_matches('\n').to_string(),
        None => raw.to_string(),
    }
}

/// Parse `name`, `slug`, `description`, `fa_keywords` from skill.md frontmatter.
fn parse_frontmatter(raw: &str) -> (String, String, String, Vec<String>) {    let mut name = String::new();
    let mut slug = String::new();
    let mut description = String::new();
    let mut fa_keywords: Vec<String> = Vec::new();
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                let Some((key, val)) = line.split_once(':') else {
                    continue;
                };
                let val = val.trim().trim_matches('"').trim_matches('\'').to_string();
                match key.trim().to_lowercase().as_str() {
                    "name" => name = val,
                    "slug" => slug = val,
                    "description" => description = val,
                    "fa_keywords" => {
                        // Split on the ASCII comma AND the Persian one (U+060C):
                        // a list typed as `فیلم، سریال` used to collapse into a
                        // single garbled keyword that could never match a real
                        // request. A YAML-style `- item` entry is tolerated too.
                        fa_keywords = val
                            .split([',', '،'])
                            .map(|k| k.trim().trim_start_matches('-').trim().to_string())
                            .filter(|k| !k.is_empty())
                            .collect();
                        // Dedupe case-insensitively, first occurrence wins, so a
                        // repeated phrase cannot bloat the catalog line.
                        let mut seen: std::collections::HashSet<String> =
                            std::collections::HashSet::new();
                        fa_keywords.retain(|k| seen.insert(k.to_lowercase()));
                    }
                    _ => {}
                }
            }
        }
    }
    if name.is_empty() {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            name = if let Some(h) = line.strip_prefix('#') {
                h.trim().to_string()
            } else {
                line.to_string()
            };
            break;
        }
    }
    if slug.is_empty() && !name.is_empty() {
        slug = raw_slug(&name);
    }
    (name, slug, description, fa_keywords)
}

/// Locate a skill folder by name or slug (mirror of _find_skill_dir).
fn find_skill_dir(root: &Path, name_or_slug: &str) -> Option<PathBuf> {
    let q = name_or_slug.trim();
    if q.is_empty() {
        return None;
    }
    let slug = raw_slug(q);
    if !slug.is_empty() {
        let d = skill_dir(root, &slug);
        if d.join("skill.md").is_file() {
            return Some(d);
        }
    }
    // Fall back to matching the stored frontmatter name.
    let base = skills_dir(root);
    let entries = fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        let md = p.join("skill.md");
        if !p.is_dir() || !md.is_file() {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&md) {
            let (name, _, _, _) = parse_frontmatter(&raw);
            if name.trim() == q {
                return Some(p);
            }
        }
    }
    None
}

/// Public wrapper so tool dispatch can mark a just-written skill as user-owned.
pub fn find_skill_dir_pub(root: &Path, name_or_slug: &str) -> Option<PathBuf> {
    find_skill_dir(root, name_or_slug)
}

fn sanitize_extra_filename(filename: &str) -> Option<String> {
    let raw = filename.trim().trim_matches(|c| c == '/' || c == '\\');
    if raw.is_empty() || raw.eq_ignore_ascii_case("skill.md") {
        return None;
    }
    if raw.contains('/') || raw.contains('\\') || raw == "." || raw == ".." {
        return None;
    }
    let mut chars = raw.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    Some(raw.to_string())
}

// --- skills endpoints --------------------------------------------------------

/// GET /skills — list all skills (frontmatter-stripped content).
pub fn list_skills(root: &Path) -> Value {
    let base = skills_dir(root);
    let mut skills: Vec<Value> = Vec::new();
    let Ok(entries) = fs::read_dir(&base) else {
        return json!({ "skills": skills });
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let md = dir.join("skill.md");
        if !dir.is_dir() || !md.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&md) else {
            continue;
        };
        let (name, slug, description, fa_keywords) = parse_frontmatter(&raw);
        if name.is_empty() {
            continue;
        }
        // Strip the frontmatter block from the body (mirror of list_skills).
        let content = if raw.starts_with("---") {
            raw.find("\n---")
                .map(|i| raw[i + 4..].trim_start_matches('\n').to_string())
                .unwrap_or(raw.clone())
        } else {
            raw.clone()
        };
        let files: Vec<String> = fs::read_dir(&dir)
            .map(|rd| {
                rd.flatten()
                    // Only real files count: a sub-folder inside the skill dir
                    // used to be listed as an "extra file", and picking it then
                    // failed with "file not found" because reading a directory
                    // as text is impossible.
                    .filter(|e| e.path().is_file())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|f| !f.eq_ignore_ascii_case("skill.md"))
                    .filter(|f| sanitize_extra_filename(f).is_some())
                    .collect()
            })
            .unwrap_or_default();
        skills.push(json!({
            "name": name,
            "slug": if slug.is_empty() {
                entry.file_name().to_string_lossy().to_string()
            } else {
                slug
            },
            "description": description,
            "path": md.to_string_lossy(),
            "content": content,
            "fa_keywords": fa_keywords,
            "files": files,
        }));
    }
    // Mirror the Python layer's ordering (name asc) and key order (name first)
    // so the frontend sees an identical shape from either backend.
    skills.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!({ "skills": skills })
}

/// GET /skills/file?name=...&file=...
pub fn read_skill_file(root: &Path, name: &str, file: &str) -> Result<Value, String> {
    let Some(safe) = sanitize_extra_filename(file) else {
        return Err("invalid file name".into());
    };
    let Some(dir) = find_skill_dir(root, name) else {
        return Err(format!("skill not found: {name}"));
    };
    match fs::read_to_string(dir.join(&safe)) {
        Ok(content) => Ok(json!({ "name": name, "file": safe, "content": content })),
        Err(_) => Err(format!("file not found: {safe}")),
    }
}

/// POST /skills/sync — create/update/delete a skill (mirror of persist_skill).
pub fn sync_skill(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("skill name is required".into());
    }

    // Delete path.
    if body["delete"].as_bool().unwrap_or(false) {
        let Some(dir) = find_skill_dir(&root, &name) else {
            return Ok(json!({ "ok": true, "name": name, "note": "already gone" }));
        };
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(json!({ "ok": true, "name": name, "note": "deleted" }));
    }

    let raw_content = body["content"].as_str().unwrap_or("").trim().to_string();
    // A caller may hand us the WHOLE skill.md (frontmatter included): the
    // settings editor sends `---\nname: …\n---` + body, and the Python twin's
    // save_skill stripped that before writing. Without stripping it here the
    // stored file embedded a SECOND frontmatter block inside the body — it
    // rendered as literal `---`/`name:` text, and every later save nested
    // another one.
    let content = strip_frontmatter(&raw_content).trim().to_string();
    // NOT validated here: an empty body means "keep the stored one" (see the
    // preservation block below), and whether there IS a stored body is only
    // known once the folder is resolved. Validating here is what made
    // `create_skill` reject a delete or an extra-file-only save.
    let mut description = body["description"].as_str().unwrap_or("").trim().to_string();
    let mut fa_keywords: Vec<String> = match &body["fa_keywords"] {
        // Split on the ASCII comma AND the Persian one (U+060C), exactly like
        // `parse_frontmatter` reads them. Splitting only on the ASCII comma
        // meant a caller that wrote `فیلم، سریال` (the natural way to type a
        // Persian list, and what the `create_skill` schema asks for) produced
        // ONE keyword containing a comma instead of two — the file happened to
        // round-trip because the reader is more permissive, but the in-memory
        // value was wrong for the empty-check and the dedupe below.
        Value::String(s) => s
            .split([',', '،'])
            .map(|k| k.trim().trim_start_matches('-').trim().to_string())
            .filter(|k| !k.is_empty())
            .collect(),
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str())
            .flat_map(|k| k.split([',', '،']))
            .map(|k| k.trim().trim_start_matches('-').trim().to_string())
            .filter(|k| !k.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    let slug = skill_slug(&name);

    // Renaming: move the previous folder so extra files survive.
    let prev = body["previous_name"].as_str().unwrap_or("").trim().to_string();
    let dir = skill_dir(&root, &slug);
    // Errors here used to be swallowed with `let _ =`: when the rename failed
    // (or the old folder did not exist) the write below still created a SECOND
    // skill folder, so the user ended up with two skills and an "old" one they
    // could not delete by the new name.
    let mut renamed_from: Option<String> = None;
    if !prev.is_empty() && prev != name {
        if let Some(old_dir) = find_skill_dir(&root, &prev) {
            if old_dir != dir {
                if let Some(parent) = dir.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::rename(&old_dir, &dir).map_err(|e| {
                    format!("could not rename skill folder {} -> {}: {e}", old_dir.display(), dir.display())
                })?;
                renamed_from = Some(prev.clone());
            }
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // PRESERVE an omitted field instead of erasing it. The editor's draft body
    // carries no frontmatter, so a save used to arrive with an empty
    // `description` and no `fa_keywords` at all — `sync_skill` then rewrote the
    // file with `description:` blank and DROPPED the `fa_keywords:` line, so the
    // skill lost its catalog description and became unfindable from Persian
    // (the reported "fa_keywords/description get wiped on save" bug).
    // An omitted (or empty) value now means "keep what the file already has".
    let existing_raw = fs::read_to_string(dir.join("skill.md")).unwrap_or_default();
    let (existing_name, _, existing_desc, existing_fa) = parse_frontmatter(&existing_raw);
    if description.is_empty() {
        description = existing_desc;
    }
    if fa_keywords.is_empty() {
        fa_keywords = existing_fa;
    }
    // An EMPTY body follows the same rule: keep the stored text. A caller that
    // only adds/removes an extra file, renames, or edits the frontmatter must
    // not have to resend the whole markdown (the model routinely calls
    // `create_skill` exactly that way). Creating a NEW skill still requires a
    // body, so we never write an empty skill.md.
    let mut content = content;
    if content.is_empty() {
        let stored = strip_frontmatter(&existing_raw).trim().to_string();
        // Strip the heading by the OLD name: after a rename the stored body
        // still starts with `# Old Name`, and leaving it in would make the
        // rewritten file carry a second (stale) heading under the new one.
        let old_name = if existing_name.trim().is_empty() {
            name.as_str()
        } else {
            existing_name.as_str()
        };
        content = strip_heading(&stored, old_name).trim().to_string();
        content = strip_heading(&content, &name).trim().to_string();
        if content.is_empty() {
            return Err("skill content is required".into());
        }
    }
    // Dedupe case-insensitively, keeping the author's order: a repeated phrase
    // only bloats the catalog line the model has to read.
    {
        let mut seen_kw: std::collections::HashSet<String> = std::collections::HashSet::new();
        fa_keywords.retain(|k| seen_kw.insert(k.to_lowercase()));
    }

    let mut markdown = format!(
        "---\nname: {name}\ndescription: {description}\n"
    );
    if !fa_keywords.is_empty() {
        markdown.push_str(&format!("fa_keywords: {}\n", fa_keywords.join(", ")));
    }
    markdown.push_str(&format!("---\n\n# {name}\n\n{content}\n"));
    let md_path = dir.join("skill.md");
    fs::write(&md_path, &markdown).map_err(|e| e.to_string())?;

    // Extra files: write new/updated, delete removed.
    //
    // Both spellings are accepted (`extra_files` from the model's tool call,
    // `files`/`deletedFiles` from the renderer's /skills/sync payload). The
    // renderer sends camelCase and the Rust side only read snake_case, so a
    // multi-file skill edited from Settings silently lost its extra files.
    let extra_obj = body["extra_files"]
        .as_object()
        .or_else(|| body["files"].as_object());
    let mut files: Vec<String> = Vec::new();
    if let Some(extra) = extra_obj {
        for (fname, fval) in extra {
            let Some(safe) = sanitize_extra_filename(fname) else {
                continue;
            };
            let fcontent = fval.as_str().unwrap_or("");
            fs::write(dir.join(&safe), fcontent).map_err(|e| e.to_string())?;
            files.push(safe);
        }
    }
    if let Some(deleted) = body["deleted_files"]
        .as_array()
        .or_else(|| body["deletedFiles"].as_array())
    {
        for d in deleted {
            let Some(name) = d.as_str().and_then(sanitize_extra_filename) else {
                continue;
            };
            let _ = fs::remove_file(dir.join(&name));
        }
    }

    Ok(json!({
        "ok": true,
        "name": name,
        "slug": slug,
        "path": md_path.to_string_lossy(),
        "note": "saved",
        "files": files,
        "renamed_from": renamed_from,
        // An empty keyword list makes the skill invisible to auto-match: the
        // callers surface this instead of pretending everything is fine.
        "fa_keyword_count": fa_keywords.len(),
    }))
}

/// Collapse every whitespace run to a single space.
///
/// The shipped markdown and the stored copy are produced by different code
/// paths (file read vs. frontmatter-stripped store row), so they differ in
/// trailing newlines, CRLF and indentation. Comparing them raw made every
/// startup re-seed every built-in; normalizing makes the comparison mean what
/// it says: "did the shipped text actually change?".
fn norm_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Drop a leading `# <name>` heading line.
///
/// `sync_skill` writes `# {name}\n\n{content}` while the shipped `.md` already
/// carries its own `# {name}` heading, so the stored body and the shipped body
/// differ by exactly that one line. Comparing them without stripping it made
/// every startup re-seed every built-in (and the re-seed is what the test
/// caught).
fn strip_heading(s: &str, name: &str) -> String {
    let t = s.trim_start();
    if let Some(rest) = t.strip_prefix('#') {
        let (head, body) = match rest.find('\n') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, ""),
        };
        if head.trim().eq_ignore_ascii_case(name.trim()) {
            return body.to_string();
        }
    }
    s.to_string()
}

/// Stable 16-hex fingerprint of a skill's shipped form.
fn fingerprint(description: &str, body: &str, fa_keywords: &[String]) -> String {
    let mut sorted: Vec<String> = fa_keywords.iter().map(|k| k.trim().to_string()).collect();
    sorted.retain(|k| !k.is_empty());
    sorted.sort();
    let joined = format!("{}\u{1}{}\u{1}{}", norm_ws(description), norm_ws(body), sorted.join("\u{1}"));
    sha1_hex(joined.as_bytes())[..16].to_string()
}

/// Sidecar file inside a skill folder recording the provenance of `skill.md`.
///
/// Format: three lines — `{origin}\n{shipped fingerprint}\n{sha1 of the file}`
/// where origin is `seeded` (this file is exactly what `sync_skill` wrote for
/// that shipped version) or `user` (the user's own text, seeded or edited).
///
/// Why it exists: the seed step used to compare the STORED text with the
/// SHIPPED text, so any user edit to a shipped skill looked like "the store is
/// stale" and was silently reverted on the next launch. A user's edit is not
/// staleness. With this marker the seed can tell the two apart.
const SHIPPED_MARKER: &str = ".shipped";

struct ShippedMarker {
    origin: String,
    shipped_fp: String,
    file_hash: String,
}

fn marker_path(dir: &Path) -> PathBuf {
    dir.join(SHIPPED_MARKER)
}

fn read_marker(dir: &Path) -> Option<ShippedMarker> {
    let raw = fs::read_to_string(marker_path(dir)).ok()?;
    let mut lines = raw.lines();
    let first = lines.next()?.trim().to_string();
    let second = lines.next()?.trim().to_string();
    // Legacy two-line marker (no origin): treat it as "we wrote it".
    let (origin, shipped_fp, file_hash) = if
        first == "seeded" || first == "user"
    {
        let third = lines.next().unwrap_or("").trim().to_string();
        (first, second, third)
    } else {
        ("seeded".to_string(), first, second)
    };
    Some(ShippedMarker { origin, shipped_fp, file_hash })
}

fn write_marker(dir: &Path, origin: &str, shipped_fp: &str, file_hash: &str) {
    let _ = fs::write(
        marker_path(dir),
        format!("{origin}\n{shipped_fp}\n{file_hash}\n"),
    );
}

/// Mark a skill folder as "the user (or the model on their behalf) owns this
/// file": the seeder will never overwrite it again.
///
/// Called by `create_skill` after a successful write, because a skill the model
/// edited is the user's text too — otherwise the NEXT shipped update would
/// silently discard that edit.
pub fn mark_user_edit(dir: &Path) {
    let prev = read_marker(dir).map(|m| m.shipped_fp).unwrap_or_default();
    let md = fs::read_to_string(dir.join("skill.md")).unwrap_or_default();
    write_marker(dir, "user", &prev, &sha1_hex(md.as_bytes()));
}

/// Who owns this skill file, according to the `.shipped` marker:
/// `Some("user")`, `Some("seeded")`, or `None` when there is no marker (a skill
/// seeded by an older build).
///
/// `cfg(test)` on purpose: the ownership claim itself happens through
/// `mark_user_edit`, so the only reader is a test asserting that the seeder will
/// leave a model-written skill alone. Compiled only for tests, it cannot drift
/// into a production path that reads provenance it does not act on.
#[cfg(test)]
pub fn marker_origin(dir: &Path) -> Option<String> {
    read_marker(dir).map(|m| m.origin)
}

/// Locate the shipped built-in skills directory (the `*.md` files that ship
/// with the app). They live in `src-tauri/skills` in the repo and are bundled
/// as the `skills/` resource in a packaged build, so they no longer depend on
/// the Python backend at all.
pub fn shipped_skills_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    // Dev: prefer the repo checkout so editing a shipped skill takes effect on
    // the next launch. Release: the bundled resource dir wins.
    let cwd = std::env::current_dir().ok();
    let dev = [
        cwd.as_ref().map(|d| d.join("skills")),
        cwd.as_ref().map(|d| d.join("src-tauri").join("skills")),
    ];
    let packaged = app.path().resource_dir().ok().map(|res| res.join("skills"));
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();
    if cfg!(debug_assertions) {
        candidates.extend(dev);
        candidates.push(packaged);
    } else {
        candidates.push(packaged);
        candidates.extend(dev);
    }
    candidates.into_iter().flatten().find(|p| p.is_dir())
}

/// Seed/re-sync the shipped built-in skills from `skills/*.md`.
///
/// Mirrors the Python sidecar's `sync_builtin_skills` (which lived in the now
/// dead tools.py): a shipped skill that is missing from the user's store is
/// created, and one whose shipped markdown changed (body OR frontmatter) is
/// re-seeded so official fixes propagate without manual deletion. User-created
/// skills are never touched, and extra files in a skill folder survive.
///
/// Returns the names that were seeded or re-synced.
pub fn seed_builtin_skills(root: &Path, shipped_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(shipped_dir) else {
        return Vec::new();
    };
    let existing = list_skills(root);
    let rows = existing["skills"].as_array().cloned().unwrap_or_default();
    // Map name/slug -> (description, body, fa_keywords) so a shipped change to
    // any of the three triggers a re-sync below.
    let mut meta: std::collections::HashMap<String, (String, String, Vec<String>)> =
        std::collections::HashMap::new();
    for s in &rows {
        let entry = (
            norm_ws(s["description"].as_str().unwrap_or("")),
            norm_ws(&strip_heading(
                s["content"].as_str().unwrap_or(""),
                s["name"].as_str().unwrap_or(""),
            )),
            s["fa_keywords"]
                .as_array()
                .map(|a| {
                    let mut v: Vec<String> = a
                        .iter()
                        .filter_map(|k| k.as_str())
                        .map(|k| k.trim().to_string())
                        .filter(|k| !k.is_empty())
                        .collect();
                    v.sort();
                    v
                })
                .unwrap_or_default(),
        );
        for key in [s["name"].as_str(), s["slug"].as_str()].into_iter().flatten() {
            if !key.is_empty() {
                meta.insert(key.to_string(), entry.clone());
            }
        }
    }

    let mut seeded: Vec<String> = Vec::new();
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect();
    paths.sort();
    for path in paths {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let (name, slug, description, fa_keywords) = parse_frontmatter(&raw);
        if name.is_empty() {
            continue;
        }
        let body = if raw.starts_with("---") {
            raw.find("\n---")
                .map(|i| raw[i + 4..].trim_start_matches('\n').to_string())
                .unwrap_or_else(|| raw.clone())
        } else {
            raw.clone()
        };
        // sync_skill re-adds a `# {name}` heading, so drop the shipped one
        // first — otherwise every re-seed writes a duplicated heading and the
        // stored body never matches the shipped one (which made every startup
        // re-seed every built-in).
        let body = strip_heading(&body, &name);
        let mut sorted_fa = fa_keywords.clone();
        sorted_fa.sort();
        let shipped = (
            norm_ws(&description),
            norm_ws(&body),
            sorted_fa,
        );
        let shipped_fp = fingerprint(&description, &body, &fa_keywords);

        // Three cases, in order:
        // 1. no stored copy            -> seed it
        // 2. the user owns the copy    -> NEVER overwrite (their text wins)
        // 3. we wrote it, shipped moved -> re-seed so official fixes land
        let dir = find_skill_dir(root, &name).or_else(|| find_skill_dir(root, &slug));
        let stored_dir_exists = dir
            .as_ref()
            .map(|d| d.join("skill.md").is_file())
            .unwrap_or(false);
        let legacy_match = || {
            meta.get(&name)
                .or_else(|| meta.get(&slug))
                .map(|cur| *cur == shipped)
                .unwrap_or(false)
        };
        if stored_dir_exists {
            let md_now = dir
                .as_ref()
                .and_then(|d| fs::read_to_string(d.join("skill.md")).ok())
                .unwrap_or_default();
            let hash_now = sha1_hex(md_now.as_bytes());
            let marker = dir.as_ref().and_then(|d| read_marker(d));
            let user_owns = match &marker {
                Some(m) if m.origin == "user" => true,
                // We wrote it: any byte we did not write means the user edited it.
                Some(m) => m.file_hash != hash_now,
                // No marker (seeded by an older build): fall back to comparing
                // the stored text with the shipped one.
                None => !legacy_match(),
            };
            if user_owns {
                // Record which shipped version we are deliberately NOT applying,
                // so later launches stay quiet instead of re-reporting it.
                if let Some(d) = dir.as_ref() {
                    write_marker(d, "user", &shipped_fp, &hash_now);
                }
                continue;
            }
            let already_current = match &marker {
                Some(m) => m.shipped_fp == shipped_fp,
                None => legacy_match(),
            };
            if already_current {
                // Record provenance for a skill seeded before this marker
                // existed. Without it the NEXT shipped change would look like a
                // user edit to an unmarked file and be skipped.
                if marker.is_none() {
                    if let Some(d) = dir.as_ref() {
                        write_marker(d, "seeded", &shipped_fp, &hash_now);
                    }
                }
                continue;
            }
        }
        let payload = json!({
            "name": name,
            "description": description,
            "content": body,
            "fa_keywords": fa_keywords,
        });
        if sync_skill(root, &payload).is_ok() {
            if let Some(d) = find_skill_dir(root, &name).or_else(|| find_skill_dir(root, &slug)) {
                let md = fs::read_to_string(d.join("skill.md")).unwrap_or_default();
                write_marker(&d, "seeded", &shipped_fp, &sha1_hex(md.as_bytes()));
            }
            seeded.push(name);
        }
    }
    seeded
}

// --- mcp endpoints -----------------------------------------------------------

/// GET /mcp — list connectors as `{name: config}` plus builtins.
pub fn list_mcp(root: &Path) -> Value {
    let base = root.join("mcp");
    let mut servers = serde_json::Map::new();
    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if let (Some(name), Some(cfg)) = (v["name"].as_str(), v.get("config")) {
                        servers.insert(name.to_string(), cfg.clone());
                    }
                }
            }
        }
    }
    json!({
        "mcpServers": Value::Object(servers),
        "builtins": ["docker"],
    })
}

/// Built-in MCP connectors installed on first run (mirrors the Python
/// sidecar's `_BUILTIN_MCP_SERVERS`). They are seeded by NAME: an entry the
/// user already edited is never overwritten, and a builtin added later is still
/// seeded on the next start.
///
/// The browser is NOT a connector any more: `browser_driver` ships the same
/// tools natively, so seeding `npx @playwright/mcp` would spawn a Node sidecar
/// whose entire tool list is then discarded by the native-wins filter — a live
/// process and a startup round-trip per turn for zero usable tools.
pub fn builtin_mcp_servers() -> Vec<(&'static str, Value)> {
    vec![(
        "docker",
        json!({"command": "docker", "args": ["mcp", "gateway", "run"]}),
    )]
}

/// The connector config that used to be seeded for the browser, kept here only
/// so an install that already has it can be cleaned up (see
/// [`retire_builtin_mcp`]).
const RETIRED_BROWSER_MCP: (&str, &str, &[&str]) =
    ("playwright", "npx", &["-y", "@playwright/mcp@latest"]);

/// Remove the retired browser connector from an install that was seeded before
/// the native driver replaced it.
///
/// Seeding is name-only and never overwrites, so deleting the entry from
/// [`builtin_mcp_servers`] does NOT remove the file already on disk — every
/// existing install would keep a connector that spawns `npx` and contributes
/// nothing. The file is deleted ONLY while its config still matches the shipped
/// default; a connector the user edited (a pinned version, their own endpoint)
/// is left exactly as it is. Returns the names that were retired.
pub fn retire_builtin_mcp(root: &Path) -> Vec<String> {
    let (name, command, args) = RETIRED_BROWSER_MCP;
    let path = root
        .join("mcp")
        .join(format!("{}.json", safe_file(name, "server")));
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(record) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let untouched = record["config"]["command"].as_str() == Some(command)
        && record["config"]["args"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).eq(args.iter().copied()))
            .unwrap_or(false);
    if !untouched {
        return Vec::new();
    }
    if fs::remove_file(&path).is_ok() {
        return vec![name.to_string()];
    }
    Vec::new()
}

/// Install the built-in MCP connectors that are missing. Returns the names
/// that were seeded (empty when everything was already present).
pub fn seed_builtin_mcp(root: &Path) -> Vec<String> {
    let existing = list_mcp(root);
    let names: Vec<String> = existing["mcpServers"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let mut seeded = Vec::new();
    for (name, cfg) in builtin_mcp_servers() {
        if names.iter().any(|n| n == name) {
            continue;
        }
        if save_mcp(root, &json!({"name": name, "cfg": cfg})).is_ok() {
            seeded.push(name.to_string());
        }
    }
    seeded
}

/// POST /mcp — save one connector (`{name, cfg}`).
pub fn save_mcp(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let cfg = body.get("cfg").cloned().unwrap_or(Value::Null);
    let base = root.join("mcp");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let safe = safe_file(&name, "server");
    let path = base.join(format!("{safe}.json"));
    let record = json!({ "name": name, "config": cfg });
    fs::write(&path, record.to_string()).map_err(|e| e.to_string())?;
    Ok(json!({ "name": name, "ok": true }))
}

/// POST /mcp/delete — remove one connector.
pub fn delete_mcp(root: &Path, body: &Value) -> Result<Value, String> {
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("connector name is required".into());
    }
    let safe = safe_file(&name, "server");
    let path = root.join("mcp").join(format!("{safe}.json"));
    let removed = fs::remove_file(&path).is_ok();
    Ok(json!({ "ok": true, "removed": removed }))
}

// --- system prompts ----------------------------------------------------------

// NOTE: /system-prompts stays proxied to the Python sidecar on purpose — the
// prompts live in backend/agents.py (single source of truth) and duplicating
// them here would drift. It moves to Rust in phase 3 with the agent engine.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_python() {
        assert_eq!(raw_slug("Learn from Docs"), "learn-from-docs");
        assert_eq!(raw_slug("  Mixed_123 name! "), "mixed-123-name");
        assert_eq!(raw_slug("فارسی"), "");
        assert_eq!(skill_slug("فارسی"), skill_slug("فارسی"));
        assert!(skill_slug("فارسی").starts_with("skill-"));
    }

    #[test]
    fn safe_file_matches_python() {
        assert_eq!(safe_file("my skill.md", "skill"), "my-skill.md");
        assert_eq!(safe_file("..", "item"), "item");
        assert_eq!(safe_file("a/b\\c", "item"), "a-b-c");
    }

    #[test]
    fn the_shipped_coding_standards_skill_parses_and_is_matchable() {
        // The generic coding rules are no longer in the prompt text — they live
        // in this shipped skill, so the file itself is now load-bearing. A
        // frontmatter typo would leave the skill nameless (unloadable by the
        // `name=Coding Standards` pointer the system prompt emits) or keyless
        // (never auto-matched), and both failures are silent at runtime.
        let raw = include_str!("../skills/coding-standards.md");
        let (name, slug, description, fa_keywords) = parse_frontmatter(raw);
        assert_eq!(name, "Coding Standards");
        assert_eq!(slug, "coding-standards");
        assert!(!description.trim().is_empty(), "a skill needs a description");
        assert!(
            fa_keywords.len() >= 3,
            "the skill must carry Persian + English keywords so a real request \
             triggers it: {fa_keywords:?}"
        );
        // The body is what the model is told to follow — an empty one would
        // make the prompt's pointer a dead end.
        let body = raw.split("\n---").nth(1).unwrap_or_default();
        assert!(
            body.contains("## 7. Debugging protocol"),
            "the debugging protocol is the reason this skill exists — keep it"
        );
    }

    #[test]
    fn frontmatter_parses_like_python() {
        let raw = "---\nname: Test\nslug: test\ndescription: d\nfa_keywords: a, b\n---\n\n# Test\nbody";
        let (name, slug, desc, fa) = parse_frontmatter(raw);
        assert_eq!(name, "Test");
        assert_eq!(slug, "test");
        assert_eq!(desc, "d");
        assert_eq!(fa, vec!["a", "b"]);
        // Heading fallback when frontmatter is absent.
        let (name2, _, _, _) = parse_frontmatter("# Only heading\nbody");
        assert_eq!(name2, "Only heading");
    }

    #[test]
    fn extra_filename_validation_matches_python() {
        assert_eq!(sanitize_extra_filename("data.json"), Some("data.json".into()));
        assert_eq!(sanitize_extra_filename("skill.md"), None);
        assert_eq!(sanitize_extra_filename("../evil"), None);
        assert_eq!(sanitize_extra_filename(".hidden"), None);
        assert_eq!(sanitize_extra_filename("no space.txt"), None);
    }

    #[test]
    fn seed_builtin_mcp_no_longer_installs_a_browser_connector() {
        let tmp = std::env::temp_dir().join(format!("codifa-mcp-seed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("store");
        fs::create_dir_all(&root).unwrap();

        // The browser ships as native tools (`browser_driver`), so no connector
        // seeding an `npx` sidecar should appear on a fresh install.
        let seeded = seed_builtin_mcp(&root);
        assert!(
            !seeded.iter().any(|n| n == "playwright"),
            "the retired browser connector was seeded again: {seeded:?}"
        );
        let installed = list_mcp(&root);
        assert!(
            installed["mcpServers"].get("playwright").is_none(),
            "{installed}"
        );
        // ...and it is not listed as a builtin any more, so the user can remove
        // it from Settings if some other install left one behind.
        let builtins = installed["builtins"].as_array().cloned().unwrap_or_default();
        assert!(
            !builtins.iter().any(|b| b.as_str() == Some("playwright")),
            "{installed}"
        );
    }

    /// An install seeded before the native driver replaced the browser keeps a
    /// connector that spawns `npx` for zero usable tools. Seeding never
    /// overwrites, so it has to be retired explicitly — but ONLY while it still
    /// matches the shipped default.
    #[test]
    fn retire_builtin_mcp_drops_only_the_untouched_default() {
        let tmp = std::env::temp_dir().join(format!("codifa-mcp-retire-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("store");
        let mcp_dir = root.join("mcp");
        fs::create_dir_all(&mcp_dir).unwrap();

        // 1. Untouched default -> retired, file gone.
        save_mcp(
            &root,
            &json!({"name": "playwright", "cfg": {"command": "npx", "args": ["-y", "@playwright/mcp@latest"]}}),
        )
        .unwrap();
        assert_eq!(retire_builtin_mcp(&root), vec!["playwright".to_string()]);
        assert!(!mcp_dir.join("playwright.json").exists());
        // Idempotent: a second run finds nothing and reports nothing.
        assert!(retire_builtin_mcp(&root).is_empty());

        // 2. A config the user edited (a pinned version) is LEFT ALONE.
        save_mcp(
            &root,
            &json!({"name": "playwright", "cfg": {"command": "npx", "args": ["-y", "@playwright/mcp@1.2.3"]}}),
        )
        .unwrap();
        assert!(retire_builtin_mcp(&root).is_empty());
        assert!(mcp_dir.join("playwright.json").exists());
        assert!(list_mcp(&root)["mcpServers"].get("playwright").is_some());
    }

    #[test]
    fn seed_builtin_skills_creates_then_skips_unchanged() {
        let tmp = std::env::temp_dir().join(format!("codifa-seed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        let shipped = tmp.join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\nbody\n",
        )
        .unwrap();

        // First run seeds the shipped skill.
        let first = seed_builtin_skills(&store, &shipped);
        assert_eq!(first, vec!["Movie Finder".to_string()]);
        let listed = list_skills(&store);
        assert_eq!(listed["skills"][0]["name"], "Movie Finder");
        assert_eq!(listed["skills"][0]["fa_keywords"][0], "film");

        // Second run is a no-op: the stored copy already matches the shipped one.
        assert!(seed_builtin_skills(&store, &shipped).is_empty());

        // A shipped body change re-syncs the built-in.
        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\nUPDATED\n",
        )
        .unwrap();
        assert_eq!(seed_builtin_skills(&store, &shipped), vec!["Movie Finder".to_string()]);
        assert!(list_skills(&store)["skills"][0]["content"]
            .as_str()
            .unwrap()
            .contains("UPDATED"));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// A user edit to a SHIPPED skill must survive a relaunch: the seed step is
    /// only allowed to overwrite a file that still has exactly the bytes it
    /// wrote for that shipped version.
    #[test]
    fn seed_builtin_skills_keeps_a_user_edit_to_a_shipped_skill() {
        let tmp = std::env::temp_dir().join(format!("codifa-seed-edit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        let shipped = tmp.join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\nbody\n",
        )
        .unwrap();

        assert_eq!(seed_builtin_skills(&store, &shipped).len(), 1, "first seed");

        // The user edits the shipped skill from the app.
        sync_skill(
            &store,
            &json!({
                "name": "Movie Finder",
                "description": "my own movies helper",
                "content": "MY OWN BODY",
                "fa_keywords": "فیلم, سینما",
            }),
        )
        .expect("user edit saves");

        // Relaunch: the shipped version did NOT change, so nothing is re-seeded
        // and the user's text is still there.
        assert!(seed_builtin_skills(&store, &shipped).is_empty(), "user edit must not be reverted");
        let after = list_skills(&store);
        assert_eq!(after["skills"][0]["description"], "my own movies helper");
        assert!(after["skills"][0]["content"].as_str().unwrap().contains("MY OWN BODY"));

        // ...and a REAL shipped change must NOT clobber the user's text either:
        // their edit wins over an upstream rewrite.
        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\nUPDATED SHIPPED\n",
        )
        .unwrap();
        assert!(
            seed_builtin_skills(&store, &shipped).is_empty(),
            "an edited shipped skill must stay edited"
        );
        let after2 = list_skills(&store);
        assert!(after2["skills"][0]["content"].as_str().unwrap().contains("MY OWN BODY"));
        // ...and it stays put on every later launch (marker records the decline).
        assert!(seed_builtin_skills(&store, &shipped).is_empty());

        let _ = fs::remove_dir_all(&tmp);
    }

    /// A shipped change DOES land while the user never touched the file.
    #[test]
    fn seed_builtin_skills_reseeds_an_untouched_shipped_skill() {
        let tmp = std::env::temp_dir().join(format!("codifa-seed-reseed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        let shipped = tmp.join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\nbody\n",
        )
        .unwrap();
        assert_eq!(seed_builtin_skills(&store, &shipped).len(), 1);
        assert!(seed_builtin_skills(&store, &shipped).is_empty(), "idempotent");

        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\nv2\n",
        )
        .unwrap();
        assert_eq!(seed_builtin_skills(&store, &shipped), vec!["Movie Finder".to_string()]);
        assert!(list_skills(&store)["skills"][0]["content"].as_str().unwrap().contains("v2"));
        assert!(seed_builtin_skills(&store, &shipped).is_empty(), "idempotent again");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// The `.shipped` marker must not show up as an "extra file" of the skill
    /// (it would be offered to the model as a loadable extra file).
    #[test]
    fn shipped_marker_is_not_listed_as_an_extra_file() {
        let tmp = std::env::temp_dir().join(format!("codifa-marker-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let shipped = tmp.join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        fs::write(
            shipped.join("movie-finder.md"),
            "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film\n---\n\n# Movie Finder\nbody\n",
        )
        .unwrap();
        let store = tmp.join("store");
        seed_builtin_skills(&store, &shipped);

        let files = list_skills(&store)["skills"][0]["files"].clone();
        assert_eq!(files, json!([]), "the marker is a dotfile, not a skill file");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A sub-folder inside a skill folder is not an extra file: it used to be
    /// listed, and reading it failed with "file not found".
    #[test]
    fn a_subfolder_is_not_listed_as_an_extra_file() {
        let tmp = std::env::temp_dir().join(format!("codifa-subdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        sync_skill(
            &store,
            &json!({
                "name": "Has Folder",
                "description": "d",
                "content": "c",
                "fa_keywords": "folder",
            }),
        )
        .expect("write");
        let dir = find_skill_dir(&store, "Has Folder").expect("folder exists");
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes").join("inner.md"), "x").unwrap();
        fs::write(dir.join("data.json"), "{}").unwrap();

        let files = list_skills(&store)["skills"][0]["files"].clone();
        assert_eq!(files, json!(["data.json"]));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Renaming a skill must move the folder (and its extra files), and the
    /// camelCase spellings the renderer sends must be understood.
    #[test]
    fn rename_moves_extra_files_and_camel_case_spellings_work() {
        let tmp = std::env::temp_dir().join(format!("codifa-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        sync_skill(
            &store,
            &json!({
                "name": "Old Name",
                "description": "d",
                "content": "c",
                "fa_keywords": "old",
                "extra_files": { "keep.txt": "kept", "drop.txt": "gone" },
            }),
        )
        .expect("first write");

        let res = sync_skill(
            &store,
            &json!({
                "name": "New Name",
                "previous_name": "Old Name",
                "description": "d",
                "content": "c2",
                "fa_keywords": "new",
                "files": { "added.txt": "added" },
                "deletedFiles": ["drop.txt"],
            }),
        )
        .expect("rename write");
        assert_eq!(res["renamed_from"], "Old Name");

        let listed = list_skills(&store);
        let names: Vec<&str> = listed["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        // The old name is gone: the folder MOVED instead of a second one being
        // created (the old code swallowed the rename error and duplicated it).
        assert_eq!(names, vec!["New Name"]);
        let files: Vec<String> = listed["skills"][0]["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f.as_str().map(|s| s.to_string()))
            .collect();
        assert!(files.contains(&"keep.txt".to_string()), "{files:?}");
        assert!(files.contains(&"added.txt".to_string()), "{files:?}");
        assert!(!files.contains(&"drop.txt".to_string()), "{files:?}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// `sync_skill` reports the keyword count so callers can warn about a skill
    /// that auto-match can never pick up.
    #[test]
    fn sync_skill_reports_the_keyword_count() {
        let tmp = std::env::temp_dir().join(format!("codifa-kwcount-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        let with = sync_skill(
            &store,
            &json!({
                "name": "With Kws",
                "description": "d",
                "content": "c",
                "fa_keywords": "فیلم، سریال",
            }),
        )
        .expect("write");
        // The Persian comma must split into TWO keywords, not one.
        assert_eq!(with["fa_keyword_count"], 2);

        // An empty list on a NEW skill really is zero.
        let without = sync_skill(
            &store,
            &json!({
                "name": "No Kws",
                "description": "d",
                "content": "c",
                "fa_keywords": "",
            }),
        )
        .expect("write");
        assert_eq!(without["fa_keyword_count"], 0);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A skill seeded by an older build (no marker) is adopted: a later shipped
    /// change must still overwrite it, because the user never touched it.
    #[test]
    fn an_unmarked_stored_skill_is_adopted_as_seeded() {
        let tmp = std::env::temp_dir().join(format!("codifa-adopt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        let shipped = tmp.join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        let shipped_md = "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film\n---\n\n# Movie Finder\nbody\n";
        fs::write(shipped.join("movie-finder.md"), shipped_md).unwrap();

        // Seed once, then pretend the marker was lost (old build wrote the file).
        assert_eq!(seed_builtin_skills(&store, &shipped).len(), 1);
        let dir = find_skill_dir(&store, "Movie Finder").expect("seeded");
        let md = fs::read_to_string(dir.join("skill.md")).unwrap();
        let _ = fs::remove_file(marker_path(&dir));
        fs::write(dir.join("skill.md"), &md).unwrap();

        // Same shipped version + no marker: nothing to do, but it is adopted.
        assert!(seed_builtin_skills(&store, &shipped).is_empty());
        assert!(read_marker(&dir).is_some(), "provenance is recorded");

        // A real shipped change now overwrites the untouched copy.
        fs::write(
            shipped.join("movie-finder.md"),
            &shipped_md.replace("body\n", "v2\n"),
        )
        .unwrap();
        assert_eq!(seed_builtin_skills(&store, &shipped), vec!["Movie Finder".to_string()]);
        assert!(list_skills(&store)["skills"][0]["content"].as_str().unwrap().contains("v2"));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// `create_skill` (the model-side writer) marks the folder as user-owned so
    /// a later shipped update cannot revert an edit the model just made.
    #[test]
    fn mark_user_edit_protects_a_model_written_skill() {
        let tmp = std::env::temp_dir().join(format!("codifa-usermark-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let store = tmp.join("store");
        let shipped = tmp.join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        let shipped_md = "---\nname: Movie Finder\ndescription: find movies\nfa_keywords: film\n---\n\n# Movie Finder\nbody\n";
        fs::write(shipped.join("movie-finder.md"), shipped_md).unwrap();
        seed_builtin_skills(&store, &shipped);

        // The model rewrites the shipped skill on the user's behalf, exactly as
        // the `create_skill` dispatch does.
        sync_skill(
            &store,
            &json!({
                "name": "Movie Finder",
                "description": "mine",
                "content": "MODEL BODY",
            }),
        )
        .expect("write");
        let dir = find_skill_dir(&store, "Movie Finder").expect("dir");
        mark_user_edit(&dir);

        // Even an upstream rewrite must not clobber it.
        fs::write(
            shipped.join("movie-finder.md"),
            &shipped_md.replace("body\n", "UPSTREAM v2\n"),
        )
        .unwrap();
        assert!(seed_builtin_skills(&store, &shipped).is_empty());
        assert!(list_skills(&store)["skills"][0]["content"]
            .as_str()
            .unwrap()
            .contains("MODEL BODY"));

        let _ = fs::remove_dir_all(&tmp);
    }
}
