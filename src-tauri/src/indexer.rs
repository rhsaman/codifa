//! Native workspace indexer: walk, chunk, embed, store.
//!
//! Mirrors `backend/indexer.py`. One stat-walk plus one metadata query decides
//! what changed; only changed/new files are embedded, and at most `budget`
//! documents per run so a huge tree cannot spike memory. Deleted files are
//! pruned from the store.
//!
//! Code indexing is OFF by default (`AUTO_INDEX_CODE`): the native agent reads
//! files on demand, so pre-embedding a whole repo is wasted work. When off,
//! the run only prunes stale `file:` docs.

use std::path::{Path, PathBuf};

use crate::embeddings;
use crate::vector_store::{self, VectorStore, KIND_FILE};

/// Per-file cap: never embed a giant file.
const MAX_FILE_BYTES: u64 = 2_000_000;
/// Target characters per embedded chunk.
const CHUNK_CHARS: usize = 1_200;
/// Overlap so a symbol boundary does not split meaning.
const CHUNK_OVERLAP: usize = 120;
/// Max chunks per file: one huge doc must not queue thousands of vectors.
const MAX_CHUNKS_PER_FILE: usize = 60;
/// Upper bound on files walked in one pass.
const MAX_FILES: usize = 10_000;

/// Extensions worth embedding (mirrors the Python `_TEXT_EXTENSIONS`).
const TEXT_EXTENSIONS: &[&str] = &[
    "py", "js", "jsx", "ts", "tsx", "json", "jsonc", "yaml", "yml", "toml", "md", "mdx", "txt",
    "html", "css", "scss", "less", "vue", "svelte", "c", "cc", "cpp", "h", "hpp", "rs", "go",
    "java", "kt", "swift", "rb", "php", "sh", "bash", "zsh", "fish", "sql", "xml", "ini", "cfg",
    "conf", "env", "csv", "tsv",
];

/// Directories never walked (mirrors the Python `_SKIP_DIRS`).
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    "dist",
    "dist-electron",
    "release",
    "build",
    "coverage",
    ".cache",
    ".idea",
    ".vscode",
    "target",
    "vendor",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".playwright",
    ".playwright-mcp",
    "out",
    "bin",
    "obj",
];

/// Hidden files that are still worth indexing.
const HIDDEN_ALLOWED: &[&str] = &[".env", ".gitignore", ".dockerignore"];

/// Is code pre-indexing enabled? Off by default — the agent reads on demand.
fn auto_index_code() -> bool {
    matches!(
        std::env::var("AUTO_INDEX_CODE").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// One indexable file found by the walk.
#[derive(Debug, Clone)]
pub struct FileInfo {
    /// Posix-style path relative to the workspace root.
    pub rel: String,
    pub abs: PathBuf,
    pub mtime: f64,
    pub size: u64,
}

/// Is `rel` (posix, relative to root) worth indexing?
pub fn should_index(rel: &str, size: Option<u64>) -> bool {
    if rel.is_empty() || rel.starts_with("../") || rel.contains("/../") {
        return false;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if name.starts_with('.') && !HIDDEN_ALLOWED.contains(&name) {
        return false;
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    let Some(ext) = ext else {
        return false;
    };
    if !TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return false;
    }
    if let Some(size) = size {
        if size > MAX_FILE_BYTES {
            return false;
        }
    }
    // A skipped directory anywhere in the path disqualifies the file.
    !rel.split('/').any(|seg| SKIP_DIRS.contains(&seg))
}

/// Walk `root` and return stat info for every indexable text file, sorted by
/// path so the budget is deterministic across runs.
pub fn scan_workspace(root: &str, max_files: usize) -> Vec<FileInfo> {
    let root_real = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    let mut out: Vec<FileInfo> = Vec::new();
    let walker = walkdir::WalkDir::new(&root_real)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                return !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        });

    for entry in walker.flatten() {
        if out.len() >= max_files {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let Ok(rel_path) = abs.strip_prefix(&root_real) else {
            continue;
        };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        if !should_index(&rel, None) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let size = meta.len();
        if size == 0 || !should_index(&rel, Some(size)) {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        out.push(FileInfo {
            rel,
            abs,
            mtime,
            size,
        });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// Split text into overlapping chunks on line boundaries.
pub fn chunk_text(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        // A single line longer than the target is hard-split.
        if line.len() > CHUNK_CHARS {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            let mut rest = line;
            while rest.len() > CHUNK_CHARS {
                let (head, tail) = rest.split_at(CHUNK_CHARS);
                chunks.push(head.to_string());
                rest = tail;
            }
            current.push_str(rest);
            continue;
        }
        if current.len() + line.len() > CHUNK_CHARS && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            // Carry the tail of the previous chunk as overlap.
            if let Some(prev) = chunks.last() {
                let start = prev.len().saturating_sub(CHUNK_OVERLAP);
                let carry: String = prev[start..].to_string();
                current.push_str(&carry);
            }
        }
        current.push_str(line);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
        .into_iter()
        .filter(|c| !c.trim().is_empty())
        .collect()
}

/// Result of one indexing run, mirroring the Python stats dict.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct IndexStats {
    pub total: usize,
    pub indexed: usize,
    pub pruned: usize,
    pub skipped: usize,
    pub unchanged: usize,
}

/// Incrementally index changed/new files and prune deleted ones.
///
/// Never fails the caller: a walk or embed error is reported through the
/// returned stats rather than raised, so a broken model cannot break startup.
pub fn index_workspace(store: &VectorStore, root: &str, budget: usize, max_files: usize) -> IndexStats {
    let mut stats = IndexStats::default();

    let existing = store.doc_meta(KIND_FILE).unwrap_or_default();

    if !auto_index_code() {
        // Code indexing is off: only drop stale file docs.
        for (key, _) in existing.iter() {
            if key.starts_with("file:") && store.remove_doc(key).is_ok() {
                stats.pruned += 1;
            }
        }
        return stats;
    }

    let scan = scan_workspace(root, max_files);
    stats.total = scan.len();
    let live: std::collections::HashSet<String> =
        scan.iter().map(|f| format!("file:{}", f.rel)).collect();

    for (key, _) in existing.iter() {
        if key.starts_with("file:") && !live.contains(key) && store.remove_doc(key).is_ok() {
            stats.pruned += 1;
        }
    }

    for info in &scan {
        if stats.indexed >= budget {
            break;
        }
        let key = format!("file:{}", info.rel);
        if let Some((prev_mtime, prev_size)) = existing.get(&key) {
            let same = (*prev_mtime - info.mtime).abs() < 1.0 && *prev_size == info.size;
            if same {
                stats.unchanged += 1;
                continue;
            }
        }
        let Ok(text) = std::fs::read_to_string(&info.abs) else {
            stats.skipped += 1;
            continue;
        };
        let mut chunks = chunk_text(&text);
        chunks.truncate(MAX_CHUNKS_PER_FILE);
        if chunks.is_empty() {
            stats.skipped += 1;
            continue;
        }
        let Ok(vectors) = embeddings::embed_passages(&chunks) else {
            stats.skipped += 1;
            continue;
        };
        match store.upsert_doc(&key, KIND_FILE, &info.rel, &info.rel, &chunks, &vectors) {
            Ok(_) => stats.indexed += 1,
            Err(_) => stats.skipped += 1,
        }
    }
    stats
}

/// Cheap first-run check: does the workspace have zero `file` docs?
pub fn needs_index(store: &VectorStore, _root: &str) -> bool {
    store.count_docs(KIND_FILE).unwrap_or(0) == 0
}

/// Open the workspace store, or `None` when it cannot be opened.
///
/// Mirrors `workspace_fs.open_vector_store`: never raises, so callers degrade
/// gracefully instead of failing the request.
pub fn open_store(root: &str, base_dir: &str, config: Option<&serde_json::Value>) -> Option<VectorStore> {
    let base = if base_dir.trim().is_empty() {
        default_vector_db_dir()
    } else {
        PathBuf::from(base_dir)
    };
    let slug = vector_store::workspace_slug_for_root(root);
    let path = vector_store::db_path_for(&base, &slug);
    VectorStore::open(&path, vector_store::StoreConfig::from_json(config)).ok()
}

/// `{data_root}/vector-db`, the default store location.
pub fn default_vector_db_dir() -> PathBuf {
    let root = std::env::var("CODER_DATA_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codifa")))
        .unwrap_or_else(|| PathBuf::from("."));
    root.join("vector-db")
}

/// Path of the store for a workspace, for diagnostics.
pub fn store_path(root: &str, base_dir: &str) -> PathBuf {
    let base = if base_dir.trim().is_empty() {
        default_vector_db_dir()
    } else {
        PathBuf::from(base_dir)
    };
    vector_store::db_path_for(&base, &vector_store::workspace_slug_for_root(root))
}

/// Is `path` inside `root`? Guards the indexer against escaping the workspace.
///
/// A path that does not exist yet (a file about to be written) is resolved
/// through its nearest existing ancestor, so the guard works before creation
/// and stays correct across symlinked temp dirs (macOS `/var` -> `/private/var`).
pub fn is_inside(root: &Path, path: &Path) -> bool {
    let root = resolve_existing(root);
    let path = resolve_existing(path);
    path.starts_with(&root)
}

/// Canonicalize `p`, falling back to canonicalizing its nearest existing
/// ancestor and re-appending the missing tail.
fn resolve_existing(p: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(p) {
        return real;
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    while let Some(parent) = cur.parent().map(Path::to_path_buf) {
        if let Some(name) = cur.file_name() {
            missing.push(name.to_os_string());
        }
        if let Ok(real) = std::fs::canonicalize(&parent) {
            let mut out = real;
            for name in missing.iter().rev() {
                out.push(name);
            }
            return out;
        }
        cur = parent;
    }
    p.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_index_accepts_code_and_rejects_binaries() {
        assert!(should_index("src/main.rs", None));
        assert!(should_index("README.md", None));
        assert!(!should_index("logo.png", None));
        assert!(!should_index("archive.zip", None));
    }

    #[test]
    fn should_index_rejects_escapes_and_hidden_files() {
        assert!(!should_index("../outside.rs", None));
        assert!(!should_index("a/../../b.rs", None));
        assert!(!should_index(".secret.rs", None));
        assert!(should_index(".env", None), "dotenv is explicitly allowed");
    }

    #[test]
    fn should_index_rejects_skipped_directories_and_oversized_files() {
        assert!(!should_index("node_modules/pkg/index.js", None));
        assert!(!should_index("target/debug/x.rs", None));
        assert!(!should_index("big.rs", Some(MAX_FILE_BYTES + 1)));
        assert!(should_index("big.rs", Some(MAX_FILE_BYTES)));
    }

    #[test]
    fn chunk_text_splits_long_text_with_overlap() {
        let text = "line\n".repeat(600);
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 1, "long text must split");
        assert!(chunks.iter().all(|c| c.len() <= CHUNK_CHARS + CHUNK_OVERLAP + 8));
    }

    #[test]
    fn chunk_text_keeps_short_text_in_one_chunk() {
        let chunks = chunk_text("fn main() {}\n");
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains("fn main"));
    }

    #[test]
    fn chunk_text_hard_splits_a_single_giant_line() {
        let chunks = chunk_text(&"x".repeat(CHUNK_CHARS * 3));
        assert!(chunks.len() >= 3);
    }

    #[test]
    fn scan_workspace_finds_files_and_skips_ignored_dirs() {
        let dir = std::env::temp_dir().join(format!("codifa-idx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).expect("mkdir src");
        std::fs::create_dir_all(dir.join("node_modules")).expect("mkdir nm");
        std::fs::write(dir.join("src/main.rs"), "fn main() {}").expect("write");
        std::fs::write(dir.join("node_modules/skip.js"), "x").expect("write");
        std::fs::write(dir.join("logo.png"), "x").expect("write");

        let found = scan_workspace(dir.to_str().unwrap(), MAX_FILES);
        let rels: Vec<&str> = found.iter().map(|f| f.rel.as_str()).collect();
        assert!(rels.contains(&"src/main.rs"), "got {rels:?}");
        assert!(!rels.iter().any(|r| r.contains("node_modules")));
        assert!(!rels.iter().any(|r| r.ends_with(".png")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_workspace_prunes_stale_docs_when_code_indexing_is_off() {
        let dir = std::env::temp_dir().join(format!("codifa-idx2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let store_path = dir.join("s.sqlite");
        let store = VectorStore::open(&store_path, vector_store::StoreConfig::default())
            .expect("open store");
        store
            .upsert_doc(
                "file:gone.rs",
                KIND_FILE,
                "gone.rs",
                "gone.rs",
                &["old".to_string()],
                &[vec![1.0, 0.0]],
            )
            .expect("seed");

        // AUTO_INDEX_CODE is unset in tests, so the run only prunes.
        let stats = index_workspace(&store, dir.to_str().unwrap(), 10, MAX_FILES);
        assert_eq!(stats.pruned, 1, "stale file doc must be pruned");
        assert_eq!(store.count_docs(KIND_FILE).unwrap_or(-1), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn needs_index_is_true_for_an_empty_store() {
        let dir = std::env::temp_dir().join(format!("codifa-idx3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let store = VectorStore::open(&dir.join("s.sqlite"), vector_store::StoreConfig::default())
            .expect("open");
        assert!(needs_index(&store, dir.to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_inside_rejects_paths_outside_the_root() {
        let dir = std::env::temp_dir();
        assert!(is_inside(&dir, &dir.join("x")));
        assert!(!is_inside(&dir, Path::new("/etc/hosts")));
    }
}
