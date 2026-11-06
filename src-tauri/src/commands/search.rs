use super::*;

pub(super) fn text_extensions() -> HashSet<&'static str> {
    HashSet::from([
        ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".yaml", ".yml",
        ".toml", ".md", ".mdx", ".txt", ".html", ".css", ".scss", ".less", ".vue",
        ".svelte", ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".java",
        ".kt", ".swift", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql",
        ".xml", ".ini", ".cfg", ".conf", ".env", ".csv", ".tsv", ".gitignore",
    ])
}

pub(super) const MAX_SEARCH_MATCHES: usize = 200;
pub(super) const MAX_SEARCH_BYTES: u64 = 2_000_000;

#[tauri::command]
pub fn search_content(root: String, query: String) -> Vec<SearchMatch> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return vec![];
    }
    let root = PathBuf::from(&root);
    if !root.exists() {
        return vec![];
    }
    if let Some(matches) = rg_search(&root, &q) {
        return matches;
    }
    fallback_search(&root, &q)
}

pub(super) fn rg_search(root: &Path, query: &str) -> Option<Vec<SearchMatch>> {
    let skip = skip_dirs();
    let mut args: Vec<String> = vec![
        "--json".into(), "-i".into(), "-F".into(), "--no-ignore".into(),
        "--hidden".into(), "--color".into(), "never".into(),
        "--max-filesize".into(), MAX_SEARCH_BYTES.to_string(),
    ];
    for ext in text_extensions() {
        args.push("-g".into());
        args.push(format!("**/*{ext}"));
    }
    for d in &skip {
        args.push("-g".into());
        args.push(format!("!**/{d}/**"));
        args.push("-g".into());
        args.push(format!("!**/{d}"));
    }
    args.push("-e".into());
    args.push(query.into());
    args.push(".".into());
    let out = std::process::Command::new("rg")
        .args(&args)
        .current_dir(root)
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut matches: Vec<SearchMatch> = vec![];
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if obj.get("type").and_then(|t| t.as_str()) == Some("match") {
            let data = obj.get("data")?;
            matches.push(SearchMatch {
                file: data
                    .pointer("/path/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .replace('\\', "/")
                    .trim_start_matches("./")
                    .to_string(),
                line: data.get("line_number").and_then(|v| v.as_u64()).unwrap_or(0),
                text: data
                    .pointer("/lines/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim_end_matches('\n')
                    .chars()
                    .take(300)
                    .collect(),
            });
            if matches.len() >= MAX_SEARCH_MATCHES {
                break;
            }
        }
    }
    Some(matches)
}

pub(super) fn fallback_search(root: &Path, query: &str) -> Vec<SearchMatch> {
    let q = query.to_lowercase();
    let exts = text_extensions();
    let skip = skip_dirs();
    let mut matches: Vec<SearchMatch> = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if matches.len() >= MAX_SEARCH_MATCHES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if matches.len() >= MAX_SEARCH_MATCHES {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            let full = e.path();
            if ft.is_dir() {
                if !skip.contains(name.as_str()) {
                    stack.push(full);
                }
                continue;
            }
            let ext = full
                .extension()
                .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if !exts.contains(ext.as_str()) {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.len() > MAX_SEARCH_BYTES {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&full) else { continue };
            for (i, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&q) {
                    let rel = full
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    matches.push(SearchMatch {
                        file: rel,
                        line: (i + 1) as u64,
                        text: line.chars().take(300).collect(),
                    });
                    if matches.len() >= MAX_SEARCH_MATCHES {
                        break;
                    }
                }
            }
        }
    }
    matches
}

// --- images -----------------------------------------------------------------

