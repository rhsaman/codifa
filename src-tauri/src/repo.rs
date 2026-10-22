//! Read a plugin or a skill straight out of a git repo.
//!
//! Claude Desktop installs a bundle by fetching its repo; this module is the
//! read half of that. It parses the repo spec, lists the files and returns
//! their text, so `plugins.rs` / `tools.rs` can hand the result to the SAME
//! writers a hand-written bundle goes through (`sync_skill`, `write_manifest`)
//! instead of inventing a second storage format.
//!
//! GitHub is read over its public API (`git/trees?recursive=1` for the file
//! list, `raw.githubusercontent.com` for the text): no new dependency, no token
//! for a public repo. A local folder goes through the exact same code path,
//! which is also what makes the whole flow testable without a network.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// GitHub's REST API root.
const GITHUB_API: &str = "https://api.github.com";
/// Raw file host: same bytes as the contents API, without its rate limit.
const GITHUB_RAW: &str = "https://raw.githubusercontent.com";
/// Timeout for one request.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Folders that are never part of a plugin or a skill.
const SKIP_DIRS: [&str; 7] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "__pycache__",
];
/// Files at a skill's own level that belong to the REPO, not to the skill.
const SKIP_FILES: [&str; 8] = [
    "readme.md",
    "license",
    "license.md",
    "changelog.md",
    "package.json",
    "plugin.json",
    "mcp.json",
    ".mcp.json",
];
/// Cap on the files that travel with one skill: `extra_files` is prompt-sized.
const MAX_EXTRA_FILES: usize = 20;

/// One repo, already resolved: the ref the files were read from and the paths
/// below the sub-folder the caller pointed at.
pub struct Repo {
    spec: RepoRef,
    /// Ref the listing came from (the default branch when the spec had none).
    git_ref: String,
    /// Files under `spec.sub`, paths relative to it, sorted.
    files: Vec<String>,
}

/// The parsed repo spec.
struct RepoRef {
    /// `owner` for a GitHub repo, empty for a local folder.
    owner: String,
    /// Repo name (GitHub) or the folder name (local).
    name: String,
    /// Branch/tag/commit; empty = the repo's default branch.
    git_ref: String,
    /// Sub-folder inside the repo the spec itself pointed at.
    sub: String,
    /// Set when the spec is a local directory.
    local: Option<PathBuf>,
}

impl Repo {
    /// Resolve a spec + optional sub-folder/ref into a readable repo.
    pub fn open(spec: &str, sub: &str, git_ref: &str) -> Result<Repo, String> {
        let mut spec = parse(spec)?;
        let extra = sub.trim().trim_matches('/');
        if !extra.is_empty() {
            spec.sub = if spec.sub.is_empty() {
                extra.to_string()
            } else {
                format!("{}/{}", spec.sub.trim_matches('/'), extra)
            };
        }
        if !git_ref.trim().is_empty() {
            spec.git_ref = git_ref.trim().to_string();
        }
        // Resolve the default branch ONCE: doing it per file would burn the
        // anonymous API budget (60 requests an hour) on a ten-file plugin.
        let git_ref = if spec.local.is_none() && spec.git_ref.is_empty() {
            github_default_branch(&spec)?
        } else {
            spec.git_ref.clone()
        };
        let mut files = match &spec.local {
            Some(dir) => {
                let mut out = Vec::new();
                list_local(dir, dir, &mut out)?;
                out
            }
            None => github_list(&spec, &git_ref)?,
        };
        if !spec.sub.is_empty() {
            let prefix = format!("{}/", spec.sub);
            files = files
                .into_iter()
                .filter_map(|p| p.strip_prefix(prefix.as_str()).map(str::to_string))
                .collect();
        }
        files.sort();
        files.dedup();
        Ok(Repo {
            spec,
            git_ref,
            files,
        })
    }

    /// Files below the caller's sub-folder, relative paths with `/`.
    pub fn files(&self) -> &[String] {
        &self.files
    }

    /// What to show the user as the install source.
    pub fn describe(&self) -> String {
        match &self.spec.local {
            Some(dir) => dir.display().to_string(),
            None => {
                let mut out = format!("{}/{}", self.spec.owner, self.spec.name);
                if !self.spec.sub.is_empty() {
                    out.push_str(&format!("/{}", self.spec.sub));
                }
                if self.git_ref != "HEAD" && !self.git_ref.is_empty() {
                    out.push_str(&format!("@{}", self.git_ref));
                }
                out
            }
        }
    }

    /// Repo (or folder) name, the fallback when a manifest has no `name`.
    pub fn repo_name(&self) -> String {
        self.spec.name.clone()
    }

    /// Read one file (path relative to the caller's sub-folder).
    pub fn read(&self, path: &str) -> Result<String, String> {
        if let Some(dir) = &self.spec.local {
            let full = dir.join(&self.spec.sub).join(path);
            return fs::read_to_string(&full).map_err(|e| format!("cannot read {path}: {e}"));
        }
        let rel = if self.spec.sub.is_empty() {
            path.to_string()
        } else {
            format!("{}/{}", self.spec.sub, path)
        };
        http_get_text(&format!(
            "{GITHUB_RAW}/{}/{}/{}/{}",
            self.spec.owner, self.spec.name, self.git_ref, rel
        ))
    }
}

/// Parse the shapes a user actually types into a repo reference.
fn parse(spec: &str) -> Result<RepoRef, String> {
    let raw = spec.trim();
    if raw.is_empty() {
        return Err(
            "a repo is required: `owner/repo`, a GitHub URL, or a local folder path".into(),
        );
    }
    let as_path = expand_home(raw);
    if as_path.is_dir() {
        let name = as_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        return Ok(RepoRef {
            owner: String::new(),
            name,
            git_ref: String::new(),
            sub: String::new(),
            local: Some(as_path),
        });
    }
    if as_path.exists() {
        return Err(format!("{raw} is a file, not a folder"));
    }

    // `git@github.com:owner/repo` → `github.com/owner/repo`, then drop the scheme.
    let mut text = raw.to_string();
    if let Some(rest) = text.strip_prefix("git@") {
        text = rest.replacen(':', "/", 1);
    }
    for scheme in ["https://", "http://"] {
        if let Some(rest) = text.strip_prefix(scheme) {
            text = rest.to_string();
            break;
        }
    }
    // Drop the host so `owner/repo` and a full URL share one path. A first
    // segment with a dot is a host, never an owner.
    if let Some((host, rest)) = text.split_once('/') {
        if host.contains('.') {
            let host = host.to_ascii_lowercase();
            if host != "github.com" && host != "www.github.com" {
                return Err(format!(
                    "only github.com repos can be read over the network (got {host}); \
                     clone it and pass the folder path instead"
                ));
            }
            text = rest.to_string();
        }
    }
    let parts: Vec<&str> = text.split('/').filter(|p| !p.is_empty()).collect();
    let owner = parts.first().copied().unwrap_or("").to_string();
    let mut name = parts.get(1).copied().unwrap_or("").to_string();
    if let Some(stripped) = name.strip_suffix(".git") {
        name = stripped.to_string();
    }
    if owner.is_empty() || name.is_empty() {
        return Err(format!(
            "cannot read a repo from {raw:?}: expected `owner/repo`, a GitHub URL, or a local folder"
        ));
    }
    // `/tree/<ref>/<sub>` (and `/blob/`) point at a folder inside the repo.
    let mut git_ref = String::new();
    let mut sub = String::new();
    let tail = &parts[2.min(parts.len())..];
    if let Some(pos) = tail.iter().position(|p| *p == "tree" || *p == "blob") {
        let after = &tail[pos + 1..];
        git_ref = after.first().copied().unwrap_or("").to_string();
        sub = after.get(1..).map(|s| s.join("/")).unwrap_or_default();
    }
    Ok(RepoRef {
        owner,
        name,
        git_ref,
        sub,
        local: None,
    })
}

/// `~/x` → the home directory, so a path typed from the shell also works.
fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

fn list_local(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d)) {
                continue;
            }
            list_local(root, &path, out)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

fn github_default_branch(repo: &RepoRef) -> Result<String, String> {
    let url = format!("{GITHUB_API}/repos/{}/{}", repo.owner, repo.name);
    let body = http_get(&url)?;
    body["default_branch"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("cannot read the default branch of {}/{}", repo.owner, repo.name))
}

fn github_list(repo: &RepoRef, git_ref: &str) -> Result<Vec<String>, String> {
    let url = format!(
        "{GITHUB_API}/repos/{}/{}/git/trees/{}?recursive=1",
        repo.owner, repo.name, git_ref
    );
    let body = http_get(&url)?;
    let tree = body["tree"]
        .as_array()
        .ok_or_else(|| format!("unexpected GitHub response from {url}"))?;
    Ok(tree
        .iter()
        .filter(|e| e["type"].as_str() == Some("blob"))
        .filter_map(|e| e["path"].as_str().map(str::to_string))
        .collect())
}

fn http_get(url: &str) -> Result<Value, String> {
    let text = http_get_text(url)?;
    serde_json::from_str(&text).map_err(|e| format!("cannot parse the response from {url}: {e}"))
}

/// `reqwest::blocking` builds its own runtime and panics inside an async
/// context (the agent loop and the axum router both are async), so every
/// request runs on a plain thread — same trick as `mcp::http_request`.
fn http_get_text(url: &str) -> Result<String, String> {
    let url = url.to_string();
    std::thread::spawn(move || http_get_blocking(&url))
        .join()
        .map_err(|_| "the repo download thread panicked".to_string())?
}

fn http_get_blocking(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("codifa")
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let res = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .map_err(|e| format!("cannot read the download: {e}"))?;
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => format!("not found: {url} (is the repo public?)"),
            403 => format!("GitHub refused the request (rate limit?): {url}"),
            code => format!("download failed ({code}): {url}"),
        });
    }
    Ok(text)
}

fn is_manifest(path: &str) -> bool {
    leaf(path).eq_ignore_ascii_case("plugin.json")
}

fn is_skill_file(path: &str) -> bool {
    leaf(path).eq_ignore_ascii_case("skill.md")
}

fn leaf(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

/// The bundle root plus the manifest that declared it.
///
/// Claude's layout hides the manifest in `.claude-plugin/` while the skills and
/// `.mcp.json` sit at the repo root, so the root is one level UP from the
/// manifest in that case; a bundle that keeps `plugin.json` beside its skills
/// (`skills/plugin.json`) roots at the manifest's own folder.
fn locate(repo: &Repo) -> Result<(String, Option<String>), String> {
    let mut manifests: Vec<&String> = repo.files().iter().filter(|p| is_manifest(p)).collect();
    manifests.sort_by_key(|p| p.matches('/').count());
    let Some(path) = manifests.first().map(|p| (*p).clone()) else {
        return Ok((String::new(), None));
    };
    let depth = path.matches('/').count();
    let ties: Vec<&&String> = manifests
        .iter()
        .filter(|p| p.matches('/').count() == depth)
        .collect();
    if ties.len() > 1 {
        let list = ties
            .iter()
            .map(|p| format!("  {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "this repo holds more than one plugin — pass `repo_path` to pick one:\n{list}"
        ));
    }
    let dir = parent(&path).to_string();
    let root = match dir.rsplit_once('/') {
        Some((up, last)) if last.eq_ignore_ascii_case(".claude-plugin") => up.to_string(),
        _ if dir.eq_ignore_ascii_case(".claude-plugin") => String::new(),
        _ => dir,
    };
    Ok((root, Some(path)))
}

/// Read a whole plugin bundle: manifest, skills and connectors, in the exact
/// shape `plugins::create_plugin` already accepts.
pub fn read_plugin(spec: &str, sub: &str, git_ref: &str) -> Result<Value, String> {
    let repo = Repo::open(spec, sub, git_ref)?;
    let (root, manifest_path) = locate(&repo)?;
    let manifest = match &manifest_path {
        Some(path) => {
            let raw = repo.read(path)?;
            serde_json::from_str::<Value>(&raw)
                .map_err(|e| format!("{path} is not valid JSON: {e}"))?
        }
        None => json!({}),
    };
    let prefix = if root.is_empty() {
        String::new()
    } else {
        format!("{root}/")
    };
    let mut skills: Vec<Value> = Vec::new();
    for path in repo
        .files()
        .iter()
        .filter(|p| p.starts_with(prefix.as_str()) && is_skill_file(p))
    {
        skills.push(read_skill_at(&repo, path)?);
    }
    if skills.is_empty() {
        return Err(format!(
            "no SKILL.md found in {}{} — point `repo_path` at the folder holding the plugin's skills",
            repo.describe(),
            match &manifest_path {
                Some(p) => format!(" (plugin.json is {p})"),
                None => String::new(),
            }
        ));
    }
    let name = manifest["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| repo.repo_name());
    Ok(json!({
        "name": name,
        "description": manifest["description"].as_str().unwrap_or(""),
        "version": manifest["version"].as_str().unwrap_or(""),
        "source": repo.describe(),
        "manifest": manifest_path,
        "skills": skills,
        "mcp": read_connectors(&repo, &root),
    }))
}

/// Read one skill out of a repo. `hint` (a name or folder) picks between
/// several candidates; an ambiguous repo is an explicit error, never a guess.
pub fn read_skill(spec: &str, sub: &str, git_ref: &str, hint: &str) -> Result<Value, String> {
    let repo = Repo::open(spec, sub, git_ref)?;
    let candidates: Vec<String> = repo
        .files()
        .iter()
        .filter(|p| is_skill_file(p))
        .cloned()
        .collect();
    if candidates.is_empty() {
        return Err(format!(
            "no SKILL.md in {} — point `repo_path` at the skill's folder",
            repo.describe()
        ));
    }
    let want = crate::skills::safe_file(&hint.trim().to_lowercase(), "");
    let by_hint = candidates.iter().find(|path| {
        let dir = parent(path);
        let folder = dir.rsplit('/').next().unwrap_or(dir);
        !want.is_empty() && crate::skills::safe_file(&folder.to_lowercase(), "") == want
    });
    let pick = by_hint.or_else(|| {
        if candidates.len() == 1 {
            candidates.first()
        } else {
            None
        }
    });
    let Some(path) = pick else {
        let list = candidates
            .iter()
            .map(|p| format!("  {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "{} holds {} skills — pass `repo_path` with one of:\n{list}",
            repo.describe(),
            candidates.len()
        ));
    };
    read_skill_at(&repo, path)
}

fn read_skill_at(repo: &Repo, path: &str) -> Result<Value, String> {
    let raw = repo.read(path)?;
    let (mut name, _slug, description, fa_keywords) =
        crate::skills::parse_frontmatter_pub(&raw);
    let dir = parent(path);
    if name.trim().is_empty() {
        let folder = dir.rsplit('/').next().unwrap_or(dir);
        name = if folder.is_empty() {
            repo.repo_name()
        } else {
            folder.to_string()
        };
    }
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let mut extra = serde_json::Map::new();
    for file in repo.files() {
        if extra.len() >= MAX_EXTRA_FILES {
            break;
        }
        if !file.starts_with(prefix.as_str()) || is_skill_file(file) {
            continue;
        }
        // A skill at the repo root must not swallow the whole repo as extra files.
        if dir.is_empty() && !parent(file).is_empty() {
            continue;
        }
        if SKIP_FILES
            .iter()
            .any(|f| leaf(file).eq_ignore_ascii_case(f))
        {
            continue;
        }
        let Some(flat) = flatten_name(&file[prefix.len()..]) else {
            continue;
        };
        if let Ok(text) = repo.read(file) {
            extra.insert(flat, json!(text));
        }
    }
    Ok(json!({
        "name": name,
        "description": description,
        "fa_keywords": fa_keywords.join(", "),
        "content": crate::skills::strip_frontmatter_pub(&raw).trim().to_string(),
        "extra_files": Value::Object(extra),
        "path": path,
    }))
}

/// `scripts/x.py` → `scripts__x.py`: `extra_files` is ONE flat map and
/// `sanitize_extra_filename` rejects every `/`.
fn flatten_name(rel: &str) -> Option<String> {
    if let Some(ok) = crate::skills::sanitize_extra_filename(rel) {
        return Some(ok);
    }
    crate::skills::sanitize_extra_filename(&rel.replace('/', "__"))
}

/// Connectors of a bundle. Claude's `.mcp.json` wraps the map in `mcpServers`,
/// our own `mcp.json` is the bare map — both install the same way.
fn read_connectors(repo: &Repo, root: &str) -> Value {
    for name in [".mcp.json", "mcp.json"] {
        let path = if root.is_empty() {
            name.to_string()
        } else {
            format!("{root}/{name}")
        };
        if !repo.files().iter().any(|p| *p == path) {
            continue;
        }
        let Ok(raw) = repo.read(&path) else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(map) = parsed.get("mcpServers").and_then(Value::as_object) {
            return Value::Object(map.clone());
        }
        if let Some(map) = parsed.as_object() {
            return Value::Object(map.clone());
        }
    }
    json!({})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-repo-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn parse_accepts_every_shape_a_user_types() {
        let plain = parse("DietrichGebert/ponytail").unwrap();
        assert_eq!(plain.owner, "DietrichGebert");
        assert_eq!(plain.name, "ponytail");
        assert!(plain.sub.is_empty());

        let url = parse("https://github.com/owner/repo.git").unwrap();
        assert_eq!(url.owner, "owner");
        assert_eq!(url.name, "repo");

        let tree = parse("https://github.com/owner/repo/tree/dev/skills/x").unwrap();
        assert_eq!(tree.git_ref, "dev");
        assert_eq!(tree.sub, "skills/x");

        let ssh = parse("git@github.com:owner/repo.git").unwrap();
        assert_eq!(ssh.name, "repo");

        let local = fixture("parse-local");
        assert!(parse(local.to_str().unwrap()).unwrap().local.is_some());

        assert!(parse("").is_err());
        assert!(parse("https://gitlab.com/owner/repo").is_err());
    }

    #[test]
    fn open_filters_to_the_requested_sub_folder() {
        let dir = fixture("sub");
        put(&dir, "one/skills/a/SKILL.md", "---\nname: a\n---\nbody");
        put(&dir, "one/README.md", "readme");
        put(&dir, "two/skills/b/SKILL.md", "---\nname: b\n---\nbody");
        let repo = Repo::open(dir.to_str().unwrap(), "one", "").unwrap();
        assert_eq!(repo.files(), ["README.md", "skills/a/SKILL.md"]);
    }

    #[test]
    fn claude_layout_roots_at_the_repo_not_the_hidden_manifest() {
        let dir = fixture("claude");
        put(
            &dir,
            ".claude-plugin/plugin.json",
            r#"{"name":"Demo Bundle","description":"demo bundle","version":"0.2.0"}"#,
        );
        put(
            &dir,
            "skills/alpha/SKILL.md",
            "---\nname: alpha\ndescription: >\n  Reviews a change\n  for logic errors.\n---\n\n# alpha\n\nDo it.",
        );
        put(&dir, "skills/alpha/ref/notes.txt", "notes");
        put(&dir, "skills/beta/SKILL.md", "---\nname: beta\n---\n\n# beta\n\nBody.");
        put(
            &dir,
            ".mcp.json",
            r#"{"mcpServers":{"demo":{"command":"npx","args":["demo"]}}}"#,
        );
        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Demo Bundle");
        assert_eq!(got["version"], "0.2.0");
        let skills = got["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 2);
        let alpha = skills
            .iter()
            .find(|s| s["name"] == "alpha")
            .expect("alpha skill");
        // The block scalar is folded onto one line instead of the literal ">".
        assert_eq!(alpha["description"], "Reviews a change for logic errors.");
        assert_eq!(alpha["extra_files"]["ref__notes.txt"], "notes");
        assert_eq!(got["mcp"]["demo"]["command"], "npx");
    }

    #[test]
    fn manifest_beside_the_skills_is_also_a_root() {
        let dir = fixture("ponytail");
        put(&dir, "skills/plugin.json", r#"{"name":"Ponytail"}"#);
        put(&dir, "skills/review/SKILL.md", "---\nname: review\n---\nBody.");
        put(&dir, "README.md", "not a skill");
        let got = read_plugin(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Ponytail");
        assert_eq!(got["skills"].as_array().unwrap().len(), 1);
        assert_eq!(got["manifest"], "skills/plugin.json");
    }

    #[test]
    fn skill_pick_uses_the_hint_and_refuses_to_guess() {
        let dir = fixture("pick");
        put(&dir, "skills/one/SKILL.md", "---\nname: One Skill\n---\nBody one.");
        put(&dir, "skills/two/SKILL.md", "---\nname: Two Skill\n---\nBody two.");
        let err = read_skill(dir.to_str().unwrap(), "", "", "").unwrap_err();
        assert!(err.contains("skills/one/SKILL.md"), "{err}");
        let picked = read_skill(dir.to_str().unwrap(), "", "", "two").unwrap();
        assert_eq!(picked["name"], "Two Skill");
        assert_eq!(picked["content"], "Body two.");

        let single = fixture("pick-single");
        put(&single, "only/SKILL.md", "---\nname: Solo\n---\nBody.");
        assert_eq!(
            read_skill(single.to_str().unwrap(), "", "", "").unwrap()["name"],
            "Solo"
        );
    }

    #[test]
    fn a_bundle_without_a_skill_is_an_explicit_error() {
        let dir = fixture("empty");
        put(&dir, "README.md", "nothing here");
        let err = read_plugin(dir.to_str().unwrap(), "", "").unwrap_err();
        assert!(err.contains("no SKILL.md"), "{err}");
    }
}
