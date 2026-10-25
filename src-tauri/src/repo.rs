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

    /// The three arguments `Repo::open` was called with, so a caller can name
    /// this very repo again. A marketplace row whose `source` is a bare
    /// sub-folder needs that address to point back into the marketplace's OWN
    /// tree rather than at a repo root.
    pub fn install_args(&self) -> (String, String, String) {
        match &self.spec.local {
            Some(dir) => (dir.display().to_string(), String::new(), String::new()),
            None => (
                format!("{}/{}", self.spec.owner, self.spec.name),
                self.spec.sub.clone(),
                self.git_ref.clone(),
            ),
        }
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

/// Whether `spec` could name a repo at all: `owner/repo`, a URL, `git@host:…`,
/// a path with a slash, or a folder that exists.
///
/// A bare word like `eurusd` is a NAME, not an address. `parse` would only say
/// "cannot read a repo from …" much later, which reads as a bug when what the
/// user wanted was to CREATE a plugin by that name — callers ask this first so
/// they can answer with the thing that was actually meant.
pub fn looks_like_repo_address(spec: &str) -> bool {
    let raw = spec.trim();
    if raw.is_empty() {
        return false;
    }
    if expand_home(raw).is_dir() {
        return true;
    }
    // `owner/repo`, `https://…`, `/an/absolute/path`, `./relative`.
    if raw.contains('/') {
        return true;
    }
    // `git@github.com:owner/repo`.
    raw.contains('@') && raw.contains(':')
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
    match http_get(&url) {
        Ok(body) => body["default_branch"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("cannot read the default branch of {}/{}", repo.owner, repo.name)),
        // Rate-limited: the branch an anonymous clone checks out IS the
        // default, so `git ls-remote --symref` answers the same question
        // without the API. An empty ref means HEAD.
        Err(e) if e.contains("rate limit") => git_default_branch_via_ls(repo)
            .map_err(|_| e),
        Err(e) => Err(e),
    }
}

fn git_default_branch_via_ls(repo: &RepoRef) -> Result<String, String> {
    let url = format!("https://github.com/{}/{}.git", repo.owner, repo.name);
    let out = std::process::Command::new("git")
        .args(["ls-remote", "--symref", &url, "HEAD"])
        .output()
        .map_err(|e| format!("git is unavailable: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ls-remote failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // First line: `ref: refs/heads/main\tHEAD`.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|l| l.split_once("refs/heads/"))
        .map(|(_, b)| b.split_whitespace().next().unwrap_or("").to_string())
        .filter(|b| !b.is_empty())
        .ok_or_else(|| format!("cannot read the default branch of {}/{} via git", repo.owner, repo.name))
}

fn github_list(repo: &RepoRef, git_ref: &str) -> Result<Vec<String>, String> {
    let url = format!(
        "{GITHUB_API}/repos/{}/{}/git/trees/{}?recursive=1",
        repo.owner, repo.name, git_ref
    );
    match http_get(&url) {
        Ok(body) => {
            let tree = body["tree"]
                .as_array()
                .ok_or_else(|| format!("unexpected GitHub response from {url}"))?;
            Ok(tree
                .iter()
                .filter(|e| e["type"].as_str() == Some("blob"))
                .filter_map(|e| e["path"].as_str().map(str::to_string))
                .collect())
        }
        // The anonymous API budget (60/h per IP) runs out fast on browse+install
        // days. A clone reads the same tree without the API, so a rate-limited
        // install must fall back to it rather than refuse to work.
        Err(e) if e.contains("rate limit") => {
            git_clone_list(repo, git_ref).map_err(|_| e)
        }
        Err(e) => Err(e),
    }
}

/// File list of a repo via a shallow clone, for when the REST API is
/// rate-limited. The clone lands in a temp dir the OS cleans up eventually;
/// text reads still go through raw.githubusercontent (no limit), so only the
/// LIST needs this.
fn git_clone_list(repo: &RepoRef, git_ref: &str) -> Result<Vec<String>, String> {
    let dir = std::env::temp_dir().join(format!(
        "codifa-clone-{}-{}",
        repo.owner,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let url = format!("https://github.com/{}/{}.git", repo.owner, repo.name);
    let out = std::process::Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            git_ref,
            &url,
            dir.to_str().unwrap_or("."),
        ])
        .output()
        .map_err(|e| format!("git is unavailable: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut files = Vec::new();
    list_local(&dir, &dir, &mut files)?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(files)
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

/// Whether `path` is a plugin script's manifest: `<anything>/scripts/<name>/script.json`.
fn is_script_manifest(path: &str) -> bool {
    if !leaf(path).eq_ignore_ascii_case(crate::plugins::SCRIPT_MANIFEST) {
        return false;
    }
    parent(path)
        .rsplit('/')
        .nth(1)
        .is_some_and(|folder| folder == crate::plugins::SCRIPTS)
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
    // Scripts travel with the bundle too: a plugin whose commands are code would
    // otherwise install as an empty shell. Read from `<root>/scripts/<name>/`
    // with the same manifest the writer produces, so a reinstall updates them.
    let mut scripts: Vec<Value> = Vec::new();
    for path in repo
        .files()
        .iter()
        .filter(|p| p.starts_with(prefix.as_str()) && is_script_manifest(p))
        .take(crate::plugins::MAX_SCRIPTS)
    {
        let dir = parent(path);
        let raw = repo.read(path)?;
        let meta: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("{path} is not valid JSON: {e}"))?;
        let name = meta["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .or_else(|| dir.rsplit('/').next().map(str::to_string))
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        // The source file the language names, read verbatim; a manifest without
        // one is a folder we cannot run, so it is skipped rather than half-read.
        let language = meta["language"].as_str().unwrap_or("rust").trim();
        let source = format!(
            "{dir}/{}",
            crate::plugins::script_source_file(language)
        );
        let Ok(content) = repo.read(&source) else {
            continue;
        };
        scripts.push(json!({
            "name": name,
            "language": language,
            "description": meta["description"].as_str().unwrap_or(""),
            "content": content,
        }));
    }
    // A bundle is a CONTAINER, so it only has to carry SOMETHING: skills,
    // connectors or scripts. Refusing a skills-less repo made a marketplace row
    // that publishes only an `mcp.json` (a connector, no prompt) uninstallable,
    // which is not a property of the row but of this guard.
    let mcp = read_connectors(&repo, &root);
    if skills.is_empty() && scripts.is_empty() && mcp.as_object().is_none_or(|m| m.is_empty()) {
        return Err(format!(
            "nothing to install from {}{} — the folder holds no SKILL.md, no `mcp.json` \
             (or `.mcp.json`) and no `scripts/`. Point `repo_path` at the folder that does",
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
    // The bundle's own Persian trigger travels with the install: it is what
    // makes a plugin whose skills carry no keywords findable from a Persian
    // request. Accepts the array form and a hand-written comma-separated string.
    let keywords = match &manifest["fa_keywords"] {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        Value::String(s) => s.clone(),
        _ => String::new(),
    };
    Ok(json!({
        "name": name,
        "description": manifest["description"].as_str().unwrap_or(""),
        "version": manifest["version"].as_str().unwrap_or(""),
        "fa_keywords": crate::skills::split_fa_keywords(&keywords),
        "source": repo.describe(),
        "manifest": manifest_path,
        "skills": skills,
        "scripts": scripts,
        "mcp": read_connectors(&repo, &root),
    }))
}

/// Skills only, from a row that ships no `plugin.json`.
///
/// `read_plugin` refuses a repo without a single `SKILL.md`, which is right for a
/// bundle — but a marketplace's Skills tab lists plain skill folders, and those
/// belong in the SKILLS STORE rather than as a one-skill plugin. Returns the same
/// row shape `skills::sync_skill` accepts, plus the source for the message.
pub fn read_skills_at(spec: &str, sub: &str, git_ref: &str) -> Result<Value, String> {
    let repo = Repo::open(spec, sub, git_ref)?;
    let (root, _) = locate(&repo).unwrap_or((String::new(), None));
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
            "no SKILL.md found in {} — point `repo_path` at the folder holding the skill",
            repo.describe()
        ));
    }
    Ok(json!({ "source": repo.describe(), "skills": skills }))
}

/// Connectors only: the `.mcp.json` / `mcp.json` of one marketplace row.
///
/// Separate from `read_plugin` because that one HARD-ERRORS without a `SKILL.md`,
/// so an MCP server published on its own was uninstallable: the MCP tab offered a
/// row whose install could only ever answer "no SKILL.md found".
pub fn read_connectors_at(spec: &str, sub: &str, git_ref: &str) -> Result<Value, String> {
    let repo = Repo::open(spec, sub, git_ref)?;
    let (root, _) = locate(&repo).unwrap_or((String::new(), None));
    Ok(json!({
        "source": repo.describe(),
        "mcp": read_connectors(&repo, &root),
    }))
}

/// Read one skill out of a repo. `hint` (a name or folder) picks between
/// several candidates; an ambiguous repo is an explicit error, never a guess.
/// Index file names a marketplace repo may use, Claude's layout first.
const INDEX_FILES: [&str; 2] = [".claude-plugin/marketplace.json", "marketplace.json"];

/// How long a cached index is served without asking GitHub again.
///
/// Long enough to make repeated Settings visits free (the tab opens on its own
/// every time), short enough that a marketplace's new plugins show up the same
/// session. The Refresh button bypasses it entirely.
const INDEX_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/**
 * Read a marketplace index, preferring a disk copy kept under `cache`.
 *
 * Why a cache and not a straight read: a cold read costs TWO anonymous GitHub
 * API calls (default branch + recursive tree) plus the index file itself, and
 * GitHub allows 60 of those an hour per IP. The Marketplaces tab opens on its
 * own every time Settings does, so without this each visit spent budget and —
 * once the limit was hit — the browse failed with nothing to show at all. It is
 * also what makes the tab open instantly instead of after a 4-9 second wait.
 *
 * `refresh` bypasses a still-fresh copy (the explicit Refresh button).
 * A failed read falls back to a stale copy: an out-of-date list is far more
 * useful than an empty tab while offline or rate limited.
 */
pub fn read_index_cached(
    cache: &Path,
    spec: &str,
    sub: &str,
    git_ref: &str,
    refresh: bool,
) -> Result<Value, String> {
    let file = cache.join(format!(
        "marketplace-{}.json",
        index_cache_key(spec, sub, git_ref)
    ));
    let cached = || {
        fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    };
    if !refresh {
        let fresh = fs::metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < INDEX_TTL);
        if fresh {
            if let Some(v) = cached() {
                return Ok(v);
            }
        }
    }
    match read_index(spec, sub, git_ref) {
        Ok(v) => {
            let _ = fs::create_dir_all(cache);
            if let Ok(text) = serde_json::to_string(&v) {
                let _ = fs::write(&file, text);
            }
            Ok(v)
        }
        // Opened on its own (Settings), an offline or rate-limited read still
        // gets the last good list instead of a blank tab — marked `stale` so the
        // UI can say the list may be old. An explicit Refresh asked for the
        // remote, so it reports the failure rather than a stale success.
        Err(e) => match cached() {
            Some(mut v) if !refresh => {
                v["stale"] = json!(true);
                Ok(v)
            }
            _ => Err(e),
        },
    }
}

/// Stable cache-file name for one index address.
fn index_cache_key(spec: &str, sub: &str, git_ref: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    spec.hash(&mut h);
    sub.hash(&mut h);
    git_ref.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Read a marketplace INDEX: the catalogue of plugins a repo advertises.
///
/// This is the DISCOVERY half of install. `read_plugin` fetches one bundle once
/// its address is known; this reads the list holding those addresses. An index
/// is a plain JSON file in a repo, so a GitHub URL, an `owner/repo` and a local
/// folder all work — exactly like an install source.
///
/// Every row is normalised to the SAME three arguments `install_plugin` takes
/// (`repo`, `repo_path`, `repo_ref`), so browsing an index and installing from
/// one go through the install path that already exists.
pub fn read_index(spec: &str, sub: &str, git_ref: &str) -> Result<Value, String> {
    let repo = Repo::open(spec, sub, git_ref)?;
    let path = INDEX_FILES
        .iter()
        .find(|p| repo.files().iter().any(|f| f == *p))
        .ok_or_else(|| {
            format!(
                "no marketplace index in {} — expected {}",
                repo.describe(),
                INDEX_FILES.join(" or ")
            )
        })?;
    let raw = repo.read(path)?;
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("{path} is not valid JSON: {e}"))?;
    let entries = parsed["plugins"]
        .as_array()
        .ok_or_else(|| format!("{path} has no `plugins` array — is it a marketplace index?"))?;
    let plugins: Vec<Value> = entries
        .iter()
        .filter_map(|entry| index_entry(&repo, entry))
        .collect();
    Ok(json!({
        "name": parsed["name"].as_str().unwrap_or(""),
        "description": parsed["description"].as_str().unwrap_or(""),
        "source": repo.describe(),
        "count": plugins.len(),
        "plugins": plugins,
    }))
}

/// One index row as an INSTALL ADDRESS.
///
/// A row that names no readable repo is dropped rather than listed: the browse
/// list must never offer a click that cannot work.
fn index_entry(repo: &Repo, entry: &Value) -> Option<Value> {
    let name = entry["name"].as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let source = &entry["source"];
    let named = source["url"]
        .as_str()
        .or_else(|| source["repo"].as_str())
        .or_else(|| entry["repo"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (repo_spec, path) = match named {
        Some(url) => (
            url.to_string(),
            source["path"].as_str().unwrap_or("").trim().to_string(),
        ),
        // A bare string source points INSIDE the marketplace's own tree (one
        // row per plugin in a monorepo). An explicitly RELATIVE one (`./x`,
        // `../x`) can only ever mean that, so a missing folder drops the row
        // instead of being re-read as `owner/repo` — which would have sent the
        // installer to github.com/bundles/in-tree. Anything else may name
        // another repo.
        None => {
            let rel = source.as_str().map(str::trim).filter(|s| !s.is_empty())?;
            let relative = rel.starts_with("./") || rel.starts_with("../");
            let cleaned = rel.trim_start_matches("./");
            // `"./"` (or `"."`) means the marketplace's ROOT bundle: one row
            // advertising the whole repo (anthropics/skills does this). It is a
            // real install address — the marketplace repo itself, at its root —
            // not a row to drop.
            if cleaned == "." || cleaned.is_empty() && relative {
                let (spec, sub, _) = repo.install_args();
                (spec, sub.to_string())
            } else {
                let rel = cleaned.trim_matches('/').trim_start_matches("./");
                let rel = rel.trim_start_matches("../");
                if rel.is_empty() {
                    return None;
                }
            let inside = repo
                .files()
                .iter()
                .any(|f| f.starts_with(&format!("{rel}/")));
            if inside {
                let (spec, sub, _) = repo.install_args();
                let path = if sub.is_empty() {
                    rel.to_string()
                } else {
                    format!("{sub}/{rel}")
                };
                (spec, path)
            } else if relative {
                return None;
            } else {
                (rel.to_string(), String::new())
            }
            }
        }
    };
    Some(json!({
        "name": name,
        "description": entry["description"].as_str().unwrap_or(""),
        "version": entry["version"].as_str().unwrap_or(""),
        "author": entry["author"]["name"]
            .as_str()
            .or_else(|| entry["author"].as_str())
            .unwrap_or(""),
        // The index's own topic tag (`security`, `documentation`, …). It is what
        // a keyword seed is derived from, so it must survive the browse →
        // install hop; an index without categories leaves it empty.
        "category": entry["category"].as_str().unwrap_or("").trim(),
        "repo": repo_spec,
        "repo_path": path,
        "repo_ref": source["ref"].as_str().unwrap_or("").trim().to_string(),
    }))
}

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
    fn an_index_lists_its_plugins_even_when_the_source_is_a_sub_folder() {
        // The browse list is the DISCOVERY half of install, and every row it
        // offers has to be a real install address: a row that cannot be
        // installed must not be listed as a clickable one.
        let dir = fixture("index");
        // The in-tree row points at a folder that really exists — a row whose
        // folder is missing must NOT be offered (it could never install).
        put(&dir, "bundles/in-tree/plugin.json", r#"{"name":"In Tree"}"#);
        put(
            &dir,
            "marketplace.json",
            r#"
{
  "name": "Demo Market",
  "description": "bundles we ship",
  "plugins": [
    {"name": "In Tree", "description": "lives here", "source": "./bundles/in-tree"},
    {"name": "Elsewhere", "source": {"url": "https://github.com/other/repo", "ref": "v2"}},
    {"name": "Gone", "source": "./bundles/not-there"},
    {"name": "  "},
    {"description": "no name, no address"}
  ]
}
"#,
        );
        let got = read_index(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Demo Market");
        // The two nameless rows and the missing folder are dropped, not listed.
        assert_eq!(got["count"], 2);
        let rows = got["plugins"].as_array().unwrap();
        let in_tree = rows.iter().find(|r| r["name"] == "In Tree").unwrap();
        // A sub-folder source points back into THIS repo, so the install address
        // is the marketplace itself plus that path.
        assert_eq!(in_tree["repo_path"], "bundles/in-tree");
        let elsewhere = rows.iter().find(|r| r["name"] == "Elsewhere").unwrap();
        assert_eq!(elsewhere["repo"], "https://github.com/other/repo");
        assert_eq!(elsewhere["repo_ref"], "v2");
    }

    #[test]
    fn claudes_index_file_name_is_found_too() {
        // Claude hides its index in `.claude-plugin/`, exactly like its
        // manifest — a marketplace written for Claude must open unchanged.
        let dir = fixture("index-claude");
        put(&dir, "plugins/ponytail/plugin.json", r#"{"name":"Ponytail"}"#);
        put(
            &dir,
            ".claude-plugin/marketplace.json",
            r#"{"name":"Official","plugins":[{"name":"Ponytail","source":"./plugins/ponytail"}]}"#,
        );
        let got = read_index(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["name"], "Official");
        assert_eq!(got["plugins"][0]["name"], "Ponytail");
    }

    #[test]
    fn a_root_source_row_points_at_the_marketplace_itself() {
        // anthropics/skills advertises ONE bundle: `"source": "./"`. That is
        // the marketplace's own root — a real install address, not a row to
        // drop. Dropping it left the Skills tab permanently empty.
        let dir = fixture("index-root");
        put(&dir, "skills/xlsx/SKILL.md", "---\nname: xlsx\n---\nbody");
        put(
            &dir,
            ".claude-plugin/marketplace.json",
            r#"{"name":"Skills","plugins":[{"name":"document-skills","source":"./"}]}"#,
        );
        let got = read_index(dir.to_str().unwrap(), "", "").unwrap();
        assert_eq!(got["count"], 1);
        let row = &got["plugins"][0];
        let (spec, sub, _) = Repo::open(dir.to_str().unwrap(), "", "")
            .unwrap()
            .install_args();
        assert_eq!(row["repo"], spec);
        assert_eq!(row["repo_path"], sub);
    }

    #[test]
    fn a_browsed_index_is_served_from_the_disk_copy() {
        // Opening Settings must not spend GitHub's 60-an-hour budget on every
        // visit: the tab opens the catalogue on its own, so a cold read per
        // visit drained it and then showed an EMPTY tab. The copy also has to
        // keep working after the source is gone, otherwise "offline" and
        // "rate limited" still mean a blank catalogue.
        let dir = fixture("index-cache-src");
        put(
            &dir,
            "marketplace.json",
            r#"{"name":"Cached","plugins":[{"name":"A","source":{"url":"https://github.com/o/r"}}]}"#,
        );
        let cache = fixture("index-cache-store");
        let first = read_index_cached(&cache, dir.to_str().unwrap(), "", "", false).unwrap();
        assert_eq!(first["name"], "Cached");

        // The source disappears: a fresh copy must still answer, and it must be
        // the SAVED bytes, which proves the read never went out again.
        fs::remove_dir_all(&dir).unwrap();
        // Age the copy past the TTL so the stale path is the one under test
        // (a still-fresh copy returns before ever touching the source).
        let cached_file = fs::read_dir(&cache)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "json"))
            .unwrap();
        let old = std::time::SystemTime::now() - INDEX_TTL - std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&cached_file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let again = read_index_cached(&cache, dir.to_str().unwrap(), "", "", false).unwrap();
        assert_eq!(again["name"], "Cached");
        // Marked stale so the tab can say the list may be out of date instead of
        // presenting an old catalogue as the current one.
        assert_eq!(again["stale"], true);

        // `refresh` bypasses the copy, so the explicit button reports the real
        // state of the remote instead of a stale success.
        assert!(read_index_cached(&cache, dir.to_str().unwrap(), "", "", true).is_err());
    }

    #[test]
    fn a_folder_without_an_index_says_so() {
        // Browsing names the exact file it wanted instead of returning an empty
        // list that reads like an empty marketplace.
        let dir = fixture("index-missing");
        put(&dir, "README.md", "nothing here");
        let err = read_index(dir.to_str().unwrap(), "", "").unwrap_err();
        assert!(err.contains("marketplace.json"), "{err}");
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
