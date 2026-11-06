//! Plugin sub-agents: the `agents/*.md` half of a Claude Code bundle.
//!
//! A plugin ships `agents/<name>.md` with YAML frontmatter (`name`,
//! `description`, `tools`) plus the prompt body. Codifa renders each one as a
//! delegable sub-agent: the prompt body becomes the sub-agent's system prompt
//! and `tools` narrows what it may call.
//!
//! The MODEL is deliberately NOT taken from the file. Every plugin sub-agent
//! runs on the same slot the built-in `explore` agent uses — the "Explore" row of
//! Settings → Tools and its fallback chain — so a bundle cannot smuggle in a
//! model, a provider or a price of its own.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

/// Folder inside a plugin holding its sub-agent profiles.
pub(crate) const AGENTS: &str = "agents";
/// Cap on the sub-agents one bundle may ship, so a runaway repo cannot flood the
/// tool list the main agent sees on every round.
pub(crate) const MAX_AGENTS: usize = 16;
/// Cap on a profile's prompt body. A sub-agent prompt is a role description the
/// model carries on every round, not a document library.
pub(crate) const MAX_PROMPT_CHARS: usize = 8000;

/// Split `---…---` frontmatter from the body. Returns `(yaml, body)`.
fn split_frontmatter(raw: &str) -> (String, String) {
    let Some(rest) = raw.strip_prefix("---") else {
        return (String::new(), raw.trim().to_string());
    };
    match rest.find("\n---") {
        Some(end) => {
            let yaml = rest[..end].to_string();
            let body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
            (yaml, body.trim().to_string())
        }
        None => (String::new(), raw.trim().to_string()),
    }
}

/// One frontmatter value, unquoted and trimmed.
fn scalar(yaml: &str, key: &str) -> String {
    for line in yaml.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        return v
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
    }
    String::new()
}

/// Allowed tools from `tools:` — a comma list (`tools: read, grep`) or a
/// YAML block list (`tools:\n  - read`). Empty means "no narrowing".
fn tool_list(yaml: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_tools = false;
    for line in yaml.lines() {
        let trimmed = line.trim();
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("tools") {
                in_tools = true;
                for item in v.split([',', '،', ' ']) {
                    let item = item.trim().trim_matches(['[', ']', '"', '\'']);
                    if !item.is_empty() {
                        out.push(item.to_ascii_lowercase());
                    }
                }
                continue;
            }
            // Any other top-level key ends the block.
            if !trimmed.starts_with('-') {
                in_tools = false;
            }
        }
        if in_tools {
            let item = trimmed.trim_start_matches('-').trim();
            let item = item.trim_matches(['"', '\'']);
            if !item.is_empty() {
                out.push(item.to_ascii_lowercase());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Parse one `agents/<file>.md` into the profile shape the agent loop uses.
///
/// `fallback_name` is the file stem, used when the frontmatter names nothing —
/// a profile must still be addressable to be delegable.
pub fn parse_profile(raw: &str, fallback_name: &str) -> Value {
    let (yaml, body) = split_frontmatter(raw);
    let mut name = scalar(&yaml, "name");
    if name.trim().is_empty() {
        name = fallback_name.trim().to_string();
    }
    let prompt: String = body.chars().take(MAX_PROMPT_CHARS).collect();
    json!({
        "name": name,
        "description": scalar(&yaml, "description"),
        "tools": tool_list(&yaml),
        "prompt": prompt,
    })
}

/// Every sub-agent profile a plugin folder holds, sorted by name.
///
/// Read from disk on each call — the folder stays the only source of truth, the
/// same rule the skills and scripts of a bundle follow.
pub fn read_agents(plugin_dir: &Path) -> Vec<Value> {
    let base = plugin_dir.join(AGENTS);
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= MAX_AGENTS {
            break;
        }
        let path = entry.path();
        if !path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let mut profile = parse_profile(&raw, &stem);
        if !profile["prompt"].as_str().is_some_and(|p| !p.trim().is_empty()) {
            // A profile with no prompt has nothing to say: skip rather than
            // register an agent that would answer as the parent.
            continue;
        }
        profile["file"] = json!(path.file_name().map(|s| s.to_string_lossy().to_string()));
        out.push(profile);
    }
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

/// One profile by name (case-insensitive), from a plugin folder.
pub fn find_agent(plugin_dir: &Path, name: &str) -> Option<Value> {
    let want = name.trim().to_lowercase();
    read_agents(plugin_dir)
        .into_iter()
        .find(|row| row["name"].as_str().unwrap_or("").to_lowercase() == want)
}

#[cfg(test)]
mod tests;
