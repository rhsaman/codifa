//! Native LSP tool support (phase 3-3 parity with backend/lsp_manager.py).
//!
//! A minimal stdio JSON-RPC client with Content-Length framing that spawns
//! language servers lazily per (root, language), runs `initialize`, opens
//! documents on demand and serves the five LSP tools the agent exposes
//! (definition / references / hover / symbols / diagnostics).
//!
//! Parity notes (mirrors lsp_manager.py):
//! - language detection via the same suffix table
//! - same server commands per language
//! - VSCode languageId per suffix for didOpen (servers need exact ids)
//! - caps: refs 40 (inline 25 x 160 chars), symbols 400, def body 60 lines

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tools::resolve_safe;

// --- caps (parity with tools.py constants) ----------------------------------
pub const DEF_BODY_MAX_LINES: usize = 60;
pub const REF_CAP: usize = 40;
pub const REF_INLINE_CAP: usize = 25;
pub const REF_INLINE_MAX_CHARS: usize = 160;
pub const SYMBOLS_CAP: usize = 400;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OPEN_DOCS: usize = 30;

// --- registry tables (parity with lsp_manager.py) ---------------------------

fn server_command(language: &str) -> Option<Vec<String>> {
    let cmd: &[&str] = match language {
        "python" => &["pylsp"],
        "typescript" | "javascript" => &["typescript-language-server", "--stdio"],
        "astro" => &["astro-ls", "--stdio"],
        "bash" => &["bash-language-server", "start"],
        "c" | "cpp" => &["clangd"],
        "csharp" => &["csharp-ls"],
        "css" => &["vscode-css-language-server", "--stdio"],
        "dart" => &["dart", "language-server"],
        "elixir" => &["elixir-ls"],
        "elm" => &["elm-language-server"],
        "erlang" => &["erlang_ls"],
        "go" => &["gopls"],
        "haskell" => &["haskell-language-server-wrapper", "--lsp"],
        "html" => &["vscode-html-language-server", "--stdio"],
        "java" => &["jdtls"],
        "json" => &["vscode-json-language-server", "--stdio"],
        "kotlin" => &["kotlin-language-server"],
        "lua" => &["lua-language-server"],
        "markdown" => &["marksman"],
        "nix" => &["nil"],
        "ocaml" => &["ocamllsp"],
        "php" => &["intelephense", "--stdio"],
        "ruby" => &["solargraph", "stdio"],
        "rust" => &["rust-analyzer"],
        "scala" => &["metals"],
        "svelte" => &["svelteserver", "--stdio"],
        "swift" => &["sourcekit-lsp"],
        "terraform" => &["terraform-ls", "serve"],
        "toml" => &["taplo", "lsp", "stdio"],
        "vue" => &["vue-language-server", "--stdio"],
        "yaml" => &["yaml-language-server", "--stdio"],
        "zig" => &["zls"],
        "tailwind" => &["tailwindcss-language-server", "--stdio"],
        "eslint" => &["vscode-eslint-language-server", "--stdio"],
        _ => return None,
    };
    Some(cmd.iter().map(|s| s.to_string()).collect())
}

fn language_for_suffix(suffix: &str) -> Option<&'static str> {
    Some(match suffix {
        ".py" | ".pyi" => "python",
        ".ts" | ".tsx" | ".mts" | ".cts" => "typescript",
        ".js" | ".jsx" | ".mjs" | ".cjs" => "javascript",
        ".astro" => "astro",
        ".sh" | ".bash" => "bash",
        ".c" | ".h" => "c",
        ".cc" | ".cpp" | ".hpp" => "cpp",
        ".cs" => "csharp",
        ".css" | ".scss" | ".less" => "css",
        ".dart" => "dart",
        ".ex" | ".exs" => "elixir",
        ".elm" => "elm",
        ".erl" | ".hrl" => "erlang",
        ".go" => "go",
        ".hs" => "haskell",
        ".html" | ".htm" => "html",
        ".java" => "java",
        ".json" | ".jsonc" => "json",
        ".kt" | ".kts" => "kotlin",
        ".lua" => "lua",
        ".md" | ".markdown" => "markdown",
        ".nix" => "nix",
        ".ml" | ".mli" => "ocaml",
        ".rb" => "ruby",
        ".php" => "php",
        ".rs" => "rust",
        ".scala" | ".sbt" => "scala",
        ".svelte" => "svelte",
        ".swift" => "swift",
        ".tf" | ".tfvars" => "terraform",
        ".toml" => "toml",
        ".vue" => "vue",
        ".yaml" | ".yml" => "yaml",
        ".zig" => "zig",
        _ => return None,
    })
}

/// VSCode languageId sent in textDocument/didOpen (servers expect exact ids).
fn language_id_for_suffix(suffix: &str) -> &str {
    match suffix {
        ".tsx" => "typescriptreact",
        ".jsx" => "javascriptreact",
        ".sh" | ".bash" => "shellscript",
        ".scss" => "scss",
        ".less" => "less",
        ".jsonc" => "jsonc",
        ".tfvars" => "terraform-vars",
        other => language_for_suffix(other).unwrap_or("plaintext"),
    }
}

// --- JSON-RPC over stdio -----------------------------------------------------

fn next_id() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    // Content-Length framing: headers separated by \r\n, blank line, body.
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("server closed the stream".into());
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(v) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            content_length = v.trim().parse::<usize>().ok();
        }
    }
    let len = content_length
        .ok_or_else(|| "missing Content-Length header".to_string())?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

fn write_message(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    stdin.write_all(&body).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

// --- per-root manager ---------------------------------------------------------

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    initialized: bool,
    /// Open documents (uri -> version) to keep didOpen/didChange bookkeeping.
    open_docs: HashMap<String, u64>,
}

impl Server {
    fn spawn(root: &Path, language: &str) -> Result<Server, String> {
        let cmd = server_command(language)
            .ok_or_else(|| format!("no language server registered for {language}"))?;
        let mut process = Command::new(&cmd[0])
            .args(&cmd[1..])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to start {}: {e}", cmd[0]))?;
        let stdin = process.stdin.take().ok_or("no stdin")?;
        let stdout = process.stdout.take().ok_or("no stdout")?;
        Ok(Server {
            child: process,
            stdin,
            stdout: BufReader::new(stdout),
            initialized: false,
            open_docs: HashMap::new(),
        })
    }

    fn initialize(&mut self, root: &Path) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        let root_uri = path_to_uri(root);
        let params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {},
        });
        write_message(&mut self.stdin, &json!({"jsonrpc": "2.0", "id": next_id(), "method": "initialize", "params": params}))?;
        // Drain responses until the matching initialize result arrives.
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            if Instant::now() > deadline {
                return Err("initialize timed out".into());
            }
            let msg = read_message(&mut self.stdout)?;
            if msg.get("id").is_some() {
                break;
            }
        }
        write_message(&mut self.stdin, &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}))?;
        self.initialized = true;
        Ok(())
    }

    fn ensure_open(&mut self, abs: &Path) -> Result<(), String> {
        let uri = path_to_uri(abs);
        if self.open_docs.contains_key(&uri) {
            return Ok(());
        }
        if self.open_docs.len() >= MAX_OPEN_DOCS {
            // Evict an arbitrary open doc to stay bounded.
            if let Some(old) = self.open_docs.keys().next().cloned() {
                let _ = write_message(&mut self.stdin, &json!({
                    "jsonrpc": "2.0", "method": "textDocument/didClose",
                    "params": {"textDocument": {"uri": old}}
                }));
                self.open_docs.remove(&old);
            }
        }
        let text = std::fs::read_to_string(abs)
            .map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
        let language_id = language_id_for_suffix(
            abs.extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_default()
                .as_str(),
        )
        .to_string();
        write_message(&mut self.stdin, &json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": {"textDocument": {"uri": uri, "languageId": language_id, "version": 1, "text": text}}
        }))?;
        self.open_docs.insert(uri, 1);
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = next_id();
        write_message(&mut self.stdin, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            if Instant::now() > deadline {
                return Err(format!("{method} timed out"));
            }
            let msg = read_message(&mut self.stdout)?;
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = msg.get("error") {
                    return Err(format!("server error: {err}"));
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
            // Notifications (publishDiagnostics etc.) are skipped.
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn path_to_uri(path: &Path) -> String {
    // file:///abs/path with percent-encoding kept minimal (spaces only) —
    // servers accept unencoded UTF-8 paths.
    let s = path.to_string_lossy().replace(' ', "%20");
    format!("file://{s}")
}

/// Per-root singleton: (root realpath) -> language -> server.
#[derive(Default)]
pub struct LspRegistry {
    roots: Mutex<HashMap<PathBuf, HashMap<String, Arc<Mutex<Server>>>>>,
}

impl LspRegistry {
    fn server_for(&self, root: &Path, language: &str) -> Result<Arc<Mutex<Server>>, String> {
        let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut roots = self.roots.lock().unwrap();
        let langs = roots.entry(key).or_default();
        if let Some(srv) = langs.get(language) {
            // Reuse unless the process died.
            let alive = srv.lock().unwrap().child.try_wait().map_or(true, |s| s.is_none());
            if alive {
                return Ok(srv.clone());
            }
        }
        let srv = Arc::new(Mutex::new(Server::spawn(root, language)?));
        srv.lock().unwrap().initialize(root)?;
        langs.insert(language.to_string(), srv.clone());
        Ok(srv)
    }
}

fn registry() -> &'static LspRegistry {
    static REG: std::sync::OnceLock<LspRegistry> = std::sync::OnceLock::new();
    REG.get_or_init(LspRegistry::default)
}

// --- shared helpers -----------------------------------------------------------

fn detect_language(abs: &Path) -> Result<&'static str, String> {
    let suffix = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    language_for_suffix(&suffix)
        .ok_or_else(|| format!("no language server for {suffix} files"))
}

fn position_of(line: i64, character: i64) -> Value {
    json!({"line": line.saturating_sub(1).max(0), "character": character.max(0)})
}

fn uri_to_path(uri: &str) -> PathBuf {
    PathBuf::from(uri.strip_prefix("file://").unwrap_or(uri).replace("%20", " "))
}

fn fmt_location(loc: &Value) -> Option<(String, u32, u32)> {
    let uri = loc.get("uri").or_else(|| loc.get("targetUri"))?.as_str()?;
    let range = loc.get("range").or_else(|| loc.get("targetSelectionRange"))?;
    let line = range.pointer("/start/line").and_then(Value::as_u64)? as u32 + 1;
    let ch = range.pointer("/start/character").and_then(Value::as_u64)? as u32;
    Some((uri_to_path(uri).display().to_string(), line, ch))
}

fn read_excerpt(path: &Path, start_line: u32, max_lines: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    content
        .lines()
        .skip((start_line.saturating_sub(1)) as usize)
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n")
}

// --- the five tools ------------------------------------------------------------

/// lsp_definition: `path:line:character` hits; inline body for <= 3 hits.
pub fn definition(root: &str, file_path: &str, line: i64, character: i64) -> Result<String, String> {
    let abs = resolve_safe(root, file_path, true, None)?;
    let abs = PathBuf::from(abs);
    let language = detect_language(&abs)?;
    let root_path = PathBuf::from(root);
    let srv = registry().server_for(&root_path, language)?;
    let mut srv = srv.lock().unwrap();
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": path_to_uri(&abs)}, "position": position_of(line, character)}),
    )?;
    let locs: Vec<Value> = match result {
        Value::Null => vec![],
        Value::Array(a) => a,
        v @ Value::Object(_) => vec![v],
        _ => vec![],
    };
    if locs.is_empty() {
        return Ok("No definition found.".into());
    }
    let mut out = Vec::new();
    for loc in locs.iter().filter_map(fmt_location) {
        out.push(format!("{}:{}:{}", loc.0, loc.1, loc.2));
    }
    if locs.len() <= 3 {
        for loc in locs.iter().filter_map(fmt_location) {
            let excerpt = read_excerpt(Path::new(&loc.0), loc.1, DEF_BODY_MAX_LINES);
            if !excerpt.is_empty() {
                out.push(String::new());
                out.push(excerpt);
            }
        }
    }
    Ok(out.join("\n"))
}

/// lsp_references: grouped by file, capped at 40 with inline source lines.
pub fn references(root: &str, file_path: &str, line: i64, character: i64) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let srv = registry().server_for(&PathBuf::from(root), language)?;
    let mut srv = srv.lock().unwrap();
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/references",
        json!({
            "textDocument": {"uri": path_to_uri(&abs)},
            "position": position_of(line, character),
            "context": {"includeDeclaration": true},
        }),
    )?;
    let locs = result.as_array().cloned().unwrap_or_default();
    if locs.is_empty() {
        return Ok("No references found.".into());
    }
    let mut out = Vec::new();
    let mut inline = 0usize;
    for (i, loc) in locs.iter().enumerate() {
        if i >= REF_CAP {
            out.push(format!("(+{} more)", locs.len() - REF_CAP));
            break;
        }
        let Some((path, l, _c)) = fmt_location(loc) else { continue };
        let mut row = format!("{path}:{l}");
        if inline < REF_INLINE_CAP {
            let line_text = read_excerpt(Path::new(&path), l, 1);
            let line_text: String = line_text.chars().take(REF_INLINE_MAX_CHARS).collect();
            if !line_text.is_empty() {
                row.push_str(&format!("  {line_text}"));
            }
            inline += 1;
        }
        out.push(row);
    }
    Ok(out.join("\n"))
}

/// lsp_hover: raw hover text.
pub fn hover(root: &str, file_path: &str, line: i64, character: i64) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let srv = registry().server_for(&PathBuf::from(root), language)?;
    let mut srv = srv.lock().unwrap();
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/hover",
        json!({"textDocument": {"uri": path_to_uri(&abs)}, "position": position_of(line, character)}),
    )?;
    let text = result
        .pointer("/contents/value")
        .or_else(|| result.pointer("/contents"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Ok("No hover info (server answered empty).".into());
    }
    Ok(text)
}

/// lsp_symbols: document symbols sorted by line, optional substring filter.
pub fn symbols(root: &str, file_path: &str, query: &str) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let srv = registry().server_for(&PathBuf::from(root), language)?;
    let mut srv = srv.lock().unwrap();
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": path_to_uri(&abs)}}),
    )?;
    let syms = result.as_array().cloned().unwrap_or_default();
    if syms.is_empty() {
        return Ok("No symbols found.".into());
    }
    // Flatten nested children, sort by start line, filter, cap.
    let mut rows: Vec<(u64, u64, String, String)> = Vec::new();
    fn walk(nodes: &[Value], out: &mut Vec<(u64, u64, String, String)>) {
        for n in nodes {
            let name = n.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
            let kind = n
                .get("kind")
                .and_then(Value::as_u64)
                .map(symbol_kind_name)
                .unwrap_or_else(|| "?".into());
            let start = n.pointer("/range/start/line").and_then(Value::as_u64).unwrap_or(0) + 1;
            let end = n.pointer("/range/end/line").and_then(Value::as_u64).unwrap_or(0) + 1;
            out.push((start, end, kind, name));
            if let Some(children) = n.get("children").and_then(Value::as_array) {
                walk(children, out);
            }
        }
    }
    walk(&syms, &mut rows);
    rows.sort_by_key(|r| r.0);
    let q = query.to_lowercase();
    let filtered: Vec<_> = rows
        .into_iter()
        .filter(|(_, _, _, name)| q.is_empty() || name.to_lowercase().contains(&q))
        .collect();
    if filtered.is_empty() {
        return Ok(format!("No symbols matching {query:?}."));
    }
    let total = filtered.len();
    let mut out = Vec::new();
    for (start, end, kind, name) in filtered.into_iter().take(SYMBOLS_CAP) {
        out.push(format!("- {kind} {name} (L{start}-{end})"));
    }
    if total > SYMBOLS_CAP {
        out.push(format!("(+{total} more)"));
    }
    Ok(out.join("\n"))
}

fn symbol_kind_name(kind: u64) -> String {
    let names = [
        "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
        "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
        "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
        "Event", "Operator", "TypeParameter",
    ];
    names
        .get(kind.saturating_sub(1) as usize)
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| format!("kind{kind}"))
}

/// lsp_diagnostics: publishDiagnostics for the target file.
pub fn diagnostics(root: &str, file_path: &str) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let srv = registry().server_for(&PathBuf::from(root), language)?;
    let mut srv = srv.lock().unwrap();
    srv.ensure_open(&abs)?;
    let uri = path_to_uri(&abs);
    // Trigger a pull, then drain notifications for a short window.
    let _ = srv.request("textDocument/diagnostic", json!({"textDocument": {"uri": uri}}));
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut diags: Vec<Value> = Vec::new();
    loop {
        if Instant::now() > deadline {
            break;
        }
        match read_message(&mut srv.stdout) {
            Ok(msg) => {
                if msg.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics") {
                    let d_uri = msg.pointer("/params/uri").and_then(Value::as_str).unwrap_or("");
                    if d_uri == uri {
                        diags = msg
                            .pointer("/params/diagnostics")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    if diags.is_empty() {
        return Ok("No diagnostics.".into());
    }
    let severity_name = |s: u64| match s {
        1 => "error",
        2 => "warning",
        3 => "info",
        4 => "hint",
        _ => "diag",
    };
    let mut out = Vec::new();
    for d in diags {
        let line = d.pointer("/range/start/line").and_then(Value::as_u64).unwrap_or(0) + 1;
        let sev = d.get("severity").and_then(Value::as_u64).unwrap_or(0);
        let msg = d.get("message").and_then(Value::as_str).unwrap_or("");
        let source = d.get("source").and_then(Value::as_str).unwrap_or("");
        out.push(format!(
            "{}:{line} [{}] {msg} ({source})",
            abs.display(),
            severity_name(sev)
        ));
    }
    Ok(out.join("\n"))
}

// --- tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_detection_matches_python_registry() {
        assert_eq!(language_for_suffix(".py"), Some("python"));
        assert_eq!(language_for_suffix(".tsx"), Some("typescript"));
        assert_eq!(language_for_suffix(".hpp"), Some("cpp"));
        assert_eq!(language_for_suffix(".yaml"), Some("yaml"));
        assert_eq!(language_for_suffix(".unknown"), None);
    }

    #[test]
    fn language_id_uses_vscode_identifiers() {
        assert_eq!(language_id_for_suffix(".tsx"), "typescriptreact");
        assert_eq!(language_id_for_suffix(".sh"), "shellscript");
        assert_eq!(language_id_for_suffix(".py"), "python");
    }

    #[test]
    fn server_commands_match_python_registry() {
        assert_eq!(server_command("python").unwrap(), vec!["pylsp"]);
        assert_eq!(
            server_command("typescript").unwrap(),
            vec!["typescript-language-server", "--stdio"]
        );
        assert_eq!(server_command("rust").unwrap(), vec!["rust-analyzer"]);
        assert!(server_command("cobol").is_none());
    }

    #[test]
    fn uri_roundtrip_handles_spaces() {
        let p = PathBuf::from("/tmp/some dir/file.rs");
        let uri = path_to_uri(&p);
        assert!(uri.starts_with("file:///"));
        assert_eq!(uri_to_path(&uri), p);
    }

    #[test]
    fn symbol_kind_names_match_lsp_spec() {
        assert_eq!(symbol_kind_name(5), "class");
        assert_eq!(symbol_kind_name(12), "function");
        assert_eq!(symbol_kind_name(6), "method");
    }

    #[test]
    fn definition_rejects_paths_outside_root() {
        let tmp = std::env::temp_dir().join(format!("codifa-lsp-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let err = definition(tmp.to_str().unwrap(), "../../etc/passwd", 1, 0);
        assert!(err.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
