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
/// How many times one download is attempted before it is called failed.
///
/// An install reads ~120 bundle files one request each, and a SINGLE dropped
/// request ("error sending request") used to fail the whole install — the
/// reported trading-bundle install died on one SKILL.md among 82. Transient
/// failures are retried; a 404 (a real miss) and a 403 (rate limit, whose
/// message drives the clone fallback) are not.
const ATTEMPTS: usize = 3;
/// Wait between download attempts, one entry per retry.
const RETRY_BACKOFF: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(600),
    std::time::Duration::from_millis(1800),
];

/// Live progress of the bundle install running in THIS process, polled by the
/// renderer (`GET /plugins/install-progress`) to feed the chat's progress
/// bubble: the install is one blocking request, and a silent one read exactly
/// as "nothing happened" — the user could not tell working from hung. One
/// slot, last install wins: installs are user-paced and the frontend refuses
/// a second concurrent install of the same address, so a race is not a real
/// flow.
fn install_slot() -> &'static std::sync::Mutex<Option<(&'static str, usize, usize)>> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<(&'static str, usize, usize)>>> =
        std::sync::OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Report the install phase: `listing` (the repo tree), `reading` (the bundle
/// files, done/total), `writing` (the bundle hitting disk).
pub fn install_progress_set(phase: &'static str, done: usize, total: usize) {
    if let Ok(mut slot) = install_slot().lock() {
        *slot = Some((phase, done, total));
    }
}

/// Where the install stands right now, for the progress route.
pub fn install_progress_now() -> Option<(&'static str, usize, usize)> {
    install_slot().lock().ok().and_then(|slot| *slot)
}

/// The install settled (either way); the poll reads `idle` and stops.
pub fn install_progress_clear() {
    if let Ok(mut slot) = install_slot().lock() {
        *slot = None;
    }
}
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
const SKIP_FILES: [&str; 9] = [
    "readme.md",
    "license",
    "license.md",
    "license.txt",
    "changelog.md",
    "package.json",
    "plugin.json",
    "mcp.json",
    ".mcp.json",
];
/// Cap on the files that travel with one skill: the prompt carries only their
/// NAMES (a body is read on demand through `load_plugin`), so the cap bounds
/// bundle bloat, not prompt size. An office skill library — the ZCode document
/// packs ship 40+ files of scripts and references — needs the room.
const MAX_EXTRA_FILES: usize = 100;

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

/// One client for every download: reqwest's pool reuses TLS connections, and
/// a fresh client per request paid a full handshake each time — on a network
/// that resets connections intermittently (the reported install died on one
/// dropped request among ~120), every extra handshake is one more chance to
/// lose a request.
fn http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(TIMEOUT)
            .user_agent("codifa")
            .build()
            .unwrap_or_default()
    })
}

fn http_get_blocking(url: &str) -> Result<String, String> {
    let client = http_client();
    for attempt in 0..ATTEMPTS {
        let res = match client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .send()
        {
            Ok(res) => res,
            // A dropped connection or a timed-out read — the request never got
            // a complete answer, so the wait-and-retry is the whole fix.
            Err(_) if attempt + 1 < ATTEMPTS => {
                std::thread::sleep(RETRY_BACKOFF[attempt]);
                continue;
            }
            Err(e) => return Err(format!("download failed: {e}")),
        };
        let status = res.status();
        let code = status.as_u16();
        if code == 429 || code >= 500 {
            // Server-side pressure and gateway blips clear within seconds;
            // the retry is what turns a flaky hour into a working install.
            if attempt + 1 < ATTEMPTS {
                std::thread::sleep(RETRY_BACKOFF[attempt]);
                continue;
            }
        }
        if !status.is_success() {
            return Err(match code {
                404 => format!("not found: {url} (is the repo public?)"),
                403 => format!("GitHub refused the request (rate limit?): {url}"),
                code => format!("download failed ({code}): {url}"),
            });
        }
        return res
            .text()
            .map_err(|e| format!("cannot read the download: {e}"));
    }
    unreachable!("the retry loop returns on its last attempt")
}

fn is_manifest(path: &str) -> bool {
    leaf(path).eq_ignore_ascii_case("plugin.json")
}

fn is_skill_file(path: &str) -> bool {
    leaf(path).eq_ignore_ascii_case("skill.md")
}

/// Whether one skill file belongs to the folders a marketplace row names.
///
/// The row's paths are relative to the bundle's source folder, while the skill
/// carries its repo path, so an exact match or a suffix match both count. The
/// leaf is compared case-insensitively because `SKILL.md` is read that way.
fn skill_in_row(path: &str, wanted: &[String]) -> bool {
    let path = path.trim_start_matches('/').to_ascii_lowercase();
    wanted.iter().any(|w| {
        let w = w.trim_matches('/').to_ascii_lowercase();
        path == format!("{w}/skill.md") || path.ends_with(&format!("/{w}/skill.md"))
    })
}

/// Whether `path` is a Claude Code command: `<anything>/commands/<name>.md`.
fn is_command_file(path: &str) -> bool {
    markdown_under(path, "commands")
}

/// Whether `path` is a Codex prompt: `<anything>/prompts/<name>.md`.
///
/// Codex keeps the exact same prompt-template file under `prompts/`; the two
/// readers are one code path with a different folder name.
fn is_prompt_file(path: &str) -> bool {
    markdown_under(path, "prompts")
}

/// Whether `path` is a plugin sub-agent: `<anything>/agents/<name>.md`.
fn is_agent_file(path: &str) -> bool {
    markdown_under(path, crate::subagents::AGENTS)
}

/// Whether `path` is a hook declaration: `<anything>/hooks/hooks.json`.
fn is_hooks_file(path: &str) -> bool {
    leaf(path).eq_ignore_ascii_case(crate::hooks::HOOKS_FILE)
        && parent(path)
            .rsplit('/')
            .next()
            .is_some_and(|folder| folder.eq_ignore_ascii_case(crate::hooks::HOOKS))
}

fn markdown_under(path: &str, folder: &str) -> bool {
    leaf(path).to_ascii_lowercase().ends_with(".md")
        && parent(path)
            .rsplit('/')
            .next()
            .is_some_and(|f| f.eq_ignore_ascii_case(folder))
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

/// Dot-folders that hold a HOST's copy of the manifest rather than the bundle.
///
/// `.claude-plugin/` is the shape this reader was written for, and `.zcode-plugin/`
/// copies it. Codex, Cursor and Grok publish the SAME bundle under their own
/// dot-folder, so a repo that distributes to several hosts carries one manifest
/// per host at the SAME depth — that is one plugin, not several. Ordered by
/// preference: when a bundle ships several, the Claude manifest wins, because it
/// is the shape that carries every part (commands, hooks, agents, `.mcp.json`).
const HOST_DIRS: [&str; 5] = [
    ".claude-plugin",
    ".zcode-plugin",
    ".codex-plugin",
    ".cursor-plugin",
    ".grok-plugin",
];

/// Last path segment — the folder name a manifest sits in.
fn last_segment(dir: &str) -> &str {
    dir.rsplit('/').next().unwrap_or(dir)
}

fn is_host_dir(segment: &str) -> bool {
    HOST_DIRS.iter().any(|d| segment.eq_ignore_ascii_case(d))
}

/// The bundle folder a manifest belongs to: its own folder, or one level UP when
/// that folder is a host's dot-folder — the skills, connectors and `.mcp.json`
/// sit beside the dot-folder, not inside it.
fn root_of(manifest_path: &str) -> String {
    let dir = parent(manifest_path);
    if is_host_dir(last_segment(dir)) {
        parent(dir).to_string()
    } else {
        dir.to_string()
    }
}

/// Preference among manifests that root to the same folder. A manifest outside
/// every host folder sorts last, so a single bundle still roots at its own
/// `skills/plugin.json` when that is all it has.
fn host_rank(manifest_path: &str) -> usize {
    let dir = parent(manifest_path);
    HOST_DIRS
        .iter()
        .position(|d| last_segment(dir).eq_ignore_ascii_case(d))
        .unwrap_or(HOST_DIRS.len())
}

/// The bundle root plus the manifest that declared it.
///
/// Claude's layout hides the manifest in `.claude-plugin/` while the skills and
/// `.mcp.json` sit at the repo root, so the root is one level UP from the
/// manifest in that case; a bundle that keeps `plugin.json` beside its skills
/// (`skills/plugin.json`) roots at the manifest's own folder. ZCode plugins
/// hide theirs the same way, in `.zcode-plugin/`, and root one level up
/// identically — same shape, different dot-folder name.
///
/// Several manifests at the top depth are only several PLUGINS when they root at
/// DIFFERENT folders. A repo that ships one bundle to Claude, Codex, Cursor and
/// Grok puts a manifest in each host's dot-folder at one depth, and all of them
/// root to the repo — that is one install, so it must not be refused as
/// ambiguous.
fn locate(repo: &Repo) -> Result<(String, Option<String>), String> {
    let mut manifests: Vec<&String> = repo.files().iter().filter(|p| is_manifest(p)).collect();
    manifests.sort_by_key(|p| p.matches('/').count());
    let Some(first) = manifests.first().map(|p| (*p).clone()) else {
        return Ok((String::new(), None));
    };
    let depth = first.matches('/').count();
    let ties: Vec<String> = manifests
        .iter()
        .filter(|p| p.matches('/').count() == depth)
        .map(|p| (*p).clone())
        .collect();
    let mut roots: Vec<String> = Vec::new();
    for path in &ties {
        let root = root_of(path);
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    if roots.len() > 1 {
        // Listed as FOLDERS, because that is what `repo_path` takes: naming the
        // manifests would hand the caller a file where it must pass a directory.
        let list = roots
            .iter()
            .map(|r| format!("  {}", if r.is_empty() { "." } else { r }))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "this repo holds more than one plugin — pass `repo_path` to pick one:\n{list}"
        ));
    }
    let path = ties
        .iter()
        .min_by_key(|p| host_rank(p))
        .cloned()
        .unwrap_or(first);
    Ok((root_of(&path), Some(path)))
}

/// Read a batch of bundle files at once.
///
/// The per-file reads used to run SEQUENTIALLY, so an install's wall time was
/// the SUM of its ~120 requests (the trading bundle measured ~2.5 minutes) and
/// the install sat exposed to the network for every one of them. Workers split
/// the paths and read concurrently; results keep the caller's path order, and
/// the first failure is the error — exactly what the loop this replaced
/// reported, just reached far sooner.
fn read_many<T, F>(paths: &[String], f: F) -> Result<Vec<T>, String>
where
    F: Fn(&str) -> Result<T, String> + Sync,
    T: Send,
{
    const WORKERS: usize = 12;
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    // Contiguous chunks keep each worker's results in path order, so joining
    // the chunks in order flattens to the sequential order.
    let chunk_len = (paths.len() + WORKERS - 1) / WORKERS;
    let mut out = Vec::with_capacity(paths.len());
    std::thread::scope(|s| -> Result<(), String> {
        let handles: Vec<_> = paths
            .chunks(chunk_len)
            .map(|group| {
                // The reader travels as a SHARED reference: one `&F` per worker
                // (Send because `F: Sync`), so the same closure body serves every
                // chunk without cloning the reader itself.
                let f = &f;
                s.spawn(move || group.iter().map(|p| f(p)).collect::<Vec<_>>())
            })
            .collect();
        for handle in handles {
            for item in handle
                .join()
                .map_err(|_| "the repo download thread panicked".to_string())?
            {
                out.push(item?);
            }
        }
        Ok(())
    })?;
    Ok(out)
}

/// Read a whole plugin bundle: manifest, skills and connectors, in the exact
/// shape `plugins::create_plugin` already accepts.
pub fn read_plugin(spec: &str, sub: &str, git_ref: &str) -> Result<Value, String> {
    read_plugin_filtered(spec, sub, git_ref, &[])
}

/// Read one bundle, keeping only the skill folders a marketplace row names.
///
/// The filter is applied BEFORE the files are read: a row that publishes four
/// skills out of a repo holding twenty (`anthropics/skills`) must not download
/// the other sixteen. An empty list reads every skill. A list that matches
/// nothing falls back to every skill, so a malformed index cannot install an
/// empty bundle.
pub fn read_plugin_filtered(
    spec: &str,
    sub: &str,
    git_ref: &str,
    wanted_skills: &[String],
) -> Result<Value, String> {
    install_progress_set("listing", 0, 0);
    let repo = Repo::open(spec, sub, git_ref)?;
    // A repo can be BOTH a plugin and a marketplace. The index file is already
    // in the tree walk this install paid for, so reporting it costs nothing —
    // the caller uses it to register the repo as a catalogue without a second
    // GitHub read (and WITHOUT trying to read an index on every plain install).
    let marketplace = INDEX_FILES
        .iter()
        .find(|p| repo.files().iter().any(|f| f == *p))
        .map(|p| p.to_string());
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
    let all_skill_paths: Vec<String> = repo
        .files()
        .iter()
        .filter(|p| p.starts_with(prefix.as_str()) && is_skill_file(p))
        .cloned()
        .collect();
    let skill_paths: Vec<String> = if wanted_skills.is_empty() {
        all_skill_paths
    } else {
        let kept: Vec<String> = all_skill_paths
            .iter()
            .filter(|p| skill_in_row(p, wanted_skills))
            .cloned()
            .collect();
        if kept.is_empty() { all_skill_paths } else { kept }
    };
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
    // connectors, scripts, commands, hooks or sub-agents. Refusing a
    // skills-less repo made a marketplace row that publishes only an `mcp.json`
    // (a connector, no prompt) uninstallable, which is not a property of the row
    // but of this guard — and the same refusal turned every Claude Code bundle
    // made of `commands/`, `hooks/` and `agents/` into "nothing to install".
    let mcp = read_connectors(&repo, &root);
    // Commands (Claude) and prompts (Codex) are prompt templates, so they land
    // in the bundle's SKILL store flagged as `kind: command`: one container for
    // everything the renderer and the router already read.
    let command_paths: Vec<String> = repo
        .files()
        .iter()
        .filter(|p| {
            p.starts_with(prefix.as_str()) && (is_command_file(p) || is_prompt_file(p))
        })
        .take(crate::plugins::MAX_COMMANDS)
        .cloned()
        .collect();
    // Sub-agent profiles travel verbatim: their frontmatter is the contract, so
    // the file is stored as read and parsed by `subagents` on every listing.
    let agent_paths: Vec<String> = repo
        .files()
        .iter()
        .filter(|p| p.starts_with(prefix.as_str()) && is_agent_file(p))
        .cloned()
        .collect();
    // Every file read reports one tick: the progress bubble in the chat is fed
    // by this counter, so the install visibly moves instead of hanging silent.
    let total = skill_paths.len() + command_paths.len() + agent_paths.len();
    install_progress_set("reading", 0, total);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let tick = || {
        let finished = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        install_progress_set("reading", finished, total);
    };
    let skills = read_many(&skill_paths, |p| {
        let r = read_skill_at(&repo, p);
        tick();
        r
    })?;
    let commands = read_many(&command_paths, |p| {
        let r = read_command_at(&repo, p);
        tick();
        r
    })?;
    // An agent file that cannot be read, or whose frontmatter carries no
    // prompt, is SKIPPED rather than fatal — the sequential loop this replaces
    // `continue`d past one; the cap lands on the COLLECTED agents.
    let agents: Vec<Value> = read_many(&agent_paths, |p| {
        let r = (|| {
            let Ok(raw) = repo.read(p) else {
                return Ok(None);
            };
            let stem = leaf(p).trim_end_matches(".md").trim_end_matches(".MD");
            let mut profile = crate::subagents::parse_profile(&raw, stem);
            if !profile["prompt"].as_str().is_some_and(|p| !p.trim().is_empty()) {
                return Ok(None);
            }
            profile["content"] = json!(raw);
            profile["file"] = json!(leaf(p));
            Ok(Some(profile))
        })();
        tick();
        r
    })?
    .into_iter()
    .flatten()
    .take(crate::subagents::MAX_AGENTS)
    .collect();
    // Hook declarations are VALIDATED here, not executed: a command that leaves
    // the bundle folder, or an event Codifa does not dispatch, is dropped before
    // it can reach disk. Execution is a separate, explicitly-approved decision.
    let mut hooks: Vec<Value> = Vec::new();
    // The HANDLER SCRIPTS a declaration points at. A real Claude Code bundle
    // keeps them beside the manifest (`hooks-handlers/session-start.sh`) and
    // spells the command `${CLAUDE_PLUGIN_ROOT}/…`; carrying only the JSON left
    // every such hook pointing at a file the install never wrote.
    let mut hook_files: Vec<Value> = Vec::new();
    if let Some(path) = repo
        .files()
        .iter()
        .find(|p| p.starts_with(prefix.as_str()) && is_hooks_file(p))
    {
        if let Ok(raw) = repo.read(path) {
            if let Ok(doc) = serde_json::from_str::<Value>(&raw) {
                for hook in crate::hooks::hooks_of(&doc) {
                    if let Some(rel) = crate::hooks::handler_path(&hook.command) {
                        let full = format!("{prefix}{rel}");
                        if !hook_files.iter().any(|f| f["path"] == json!(rel)) {
                            if let Ok(body) = repo.read(&full) {
                                hook_files.push(json!({ "path": rel, "content": body }));
                            }
                        }
                    }
                    hooks.push(json!({
                        "event": hook.event,
                        "matcher": hook.matcher,
                        "command": hook.command,
                    }));
                }
            }
        }
    }
    if skills.is_empty()
        && scripts.is_empty()
        && commands.is_empty()
        && agents.is_empty()
        && hooks.is_empty()
        && mcp.as_object().is_none_or(|m| m.is_empty())
    {
        return Err(format!(
            "nothing to install from {}{} — the folder holds no `skills/*/SKILL.md`, no `commands/*.md` (or Codex `prompts/*.md`), no `agents/*.md`, no `hooks/hooks.json`, no `scripts/` and no `mcp.json` (or `.mcp.json`). Point `repo_path` at the folder that does",
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
        "scripts": scripts,
        "commands": commands,
        "agents": agents,
        "hooks": hooks,
        "hook_files": hook_files,
        "mcp": read_connectors(&repo, &root),
        "marketplace": marketplace,
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
    let Some(path) = INDEX_FILES
        .iter()
        .find(|p| repo.files().iter().any(|f| f == *p))
    else {
        return plain_bundle_index(&repo);
    };
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

/// The catalogue of a repo that carries NO index: the repo itself, as one row.
///
/// `/plugin install <repo>` registers every successful source as a marketplace,
/// and the user expects that source to be browsable. A plain bundle repo has no
/// index to read, so it is a catalogue of ONE — this row. A repo holding
/// SEVERAL bundles has no unambiguous row to synthesize, so it keeps the
/// "no marketplace index" error and asks for `repo_path` instead.
fn plain_bundle_index(repo: &Repo) -> Result<Value, String> {
    let no_index = || {
        format!(
            "no marketplace index in {} — expected {}",
            repo.describe(),
            INDEX_FILES.join(" or ")
        )
    };
    let (root, manifest_path) = match locate(repo) {
        Ok(found) => found,
        // Several plugin folders: only an index can say which row is which.
        Err(_) => return Err(no_index()),
    };
    // A manifest alone is not a bundle: `read_plugin` reads parts from files,
    // so advertising a manifest-only repo would list a row that cannot install.
    let carries_parts = repo.files().iter().any(|p| {
        is_skill_file(p)
            || is_command_file(p)
            || is_prompt_file(p)
            || is_agent_file(p)
            || is_hooks_file(p)
            || is_script_manifest(p)
            || leaf(p).eq_ignore_ascii_case("mcp.json")
            || leaf(p).eq_ignore_ascii_case(".mcp.json")
    });
    if !carries_parts {
        return Err(no_index());
    }
    let manifest = manifest_path
        .as_ref()
        .and_then(|p| repo.read(p).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    let name = manifest["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| repo.repo_name());
    let description = manifest["description"].as_str().unwrap_or("").trim().to_string();
    // Point the row at the folder that actually holds the bundle, so an install
    // from the row is the same read `/plugin install <repo>` just did.
    let (spec, base, _) = repo.install_args();
    let repo_path = match (base.is_empty(), root.is_empty()) {
        (_, true) => base,
        (true, false) => root,
        (false, false) => format!("{base}/{root}"),
    };
    let row = json!({
        "name": name,
        "description": description,
        "version": manifest["version"].as_str().unwrap_or(""),
        "author": manifest["author"]["name"]
            .as_str()
            .or_else(|| manifest["author"].as_str())
            .unwrap_or(""),
        "category": "",
        "skills": [],
        "repo": spec,
        "repo_path": repo_path,
        "repo_ref": "",
    });
    Ok(json!({
        "name": name,
        "description": description,
        "source": repo.describe(),
        "count": 1,
        "plugins": [row],
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
        // The row may publish only SOME of the skills its source folder holds:
        // anthropics/skills points five rows at `./` and names each row's
        // folders here. Without this list a row called "document-skills"
        // installed every skill in the repo.
        "skills": entry["skills"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        "repo": repo_spec,
        "repo_path": path,
        "repo_ref": source["ref"].as_str().unwrap_or("").trim().to_string(),
    }))
}


fn read_command_at(repo: &Repo, path: &str) -> Result<Value, String> {
    let raw = repo.read(path)?;
    let stem = leaf(path)
        .trim_end_matches(".md")
        .trim_end_matches(".MD");
    // The FILE STEM names the command, never the body: `commands/model-check.md`
    // is `/model-check` — the word the palette shows and the user types. Only an
    // explicit `name:` in a frontmatter header may override it. (`parse_frontmatter`
    // falls back to the first body line, which on a real bundle's plain-prose
    // command turned its opening sentence into the command's name.)
    let declared = crate::skills::frontmatter_name_pub(&raw);
    let name = if declared.trim().is_empty() {
        stem.to_string()
    } else {
        declared
    };
    let (_, _, description) = crate::skills::parse_frontmatter_pub(&raw);
    Ok(json!({
        // `kind` is what turns a stored skill row into a SLASH COMMAND: the
        // command palette and the router read the same store, and this field is
        // the one fact that keeps a command from showing up as an attachable
        // skill.
        "name": name,
        "description": if description.trim().is_empty() {
            format!("Run the /{stem} command")
        } else {
            description
        },
        "kind": "command",
        "content": raw,
    }))
}

fn read_skill_at(repo: &Repo, path: &str) -> Result<Value, String> {
    let raw = repo.read(path)?;
    let (mut name, _slug, description) =
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
mod tests;
