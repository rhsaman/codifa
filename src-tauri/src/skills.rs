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

/// Parse `name`, `slug`, `description`, `fa_keywords` from skill.md frontmatter.
fn parse_frontmatter(raw: &str) -> (String, String, String, Vec<String>) {
    let mut name = String::new();
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
                        fa_keywords = val
                            .split(',')
                            .map(|k| k.trim().to_string())
                            .filter(|k| !k.is_empty())
                            .collect();
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

    let content = body["content"].as_str().unwrap_or("").trim().to_string();
    if content.is_empty() {
        return Err("skill content is required".into());
    }
    let description = body["description"].as_str().unwrap_or("").trim().to_string();
    let fa_keywords: Vec<String> = match &body["fa_keywords"] {
        Value::String(s) => s.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect(),
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str())
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    let slug = skill_slug(&name);

    // Renaming: move the previous folder so extra files survive.
    let prev = body["previous_name"].as_str().unwrap_or("").trim().to_string();
    let dir = skill_dir(&root, &slug);
    if !prev.is_empty() && prev != name {
        if let Some(old_dir) = find_skill_dir(&root, &prev) {
            if old_dir != dir {
                let _ = fs::create_dir_all(dir.parent().unwrap());
                let _ = fs::rename(&old_dir, &dir);
            }
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

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
    let mut files: Vec<String> = Vec::new();
    if let Some(extra) = body["extra_files"].as_object() {
        for (fname, fval) in extra {
            let Some(safe) = sanitize_extra_filename(fname) else {
                continue;
            };
            let fcontent = fval.as_str().unwrap_or("");
            fs::write(dir.join(&safe), fcontent).map_err(|e| e.to_string())?;
            files.push(safe);
        }
    }
    if let Some(deleted) = body["deleted_files"].as_array() {
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
    }))
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
        "builtins": ["docker", "playwright"],
    })
}

/// Built-in MCP connectors installed on first run (mirrors the Python
/// sidecar's `_BUILTIN_MCP_SERVERS`). They are seeded by NAME: an entry the
/// user already edited is never overwritten, and a builtin added later (e.g.
/// playwright after docker) is still seeded on the next start.
pub fn builtin_mcp_servers() -> Vec<(&'static str, Value)> {
    vec![
        (
            "docker",
            json!({"command": "docker", "args": ["mcp", "gateway", "run"]}),
        ),
        (
            "playwright",
            json!({"command": "npx", "args": ["-y", "@playwright/mcp@latest"]}),
        ),
    ]
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
}
