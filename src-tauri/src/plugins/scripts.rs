use super::*;

/// A runnable starting point, so a script can be created without the caller
/// having to invent boilerplate — and so the DEFAULT language is visible as
/// working Rust code rather than an empty file.
pub(super) fn script_template(language: &str, name: &str) -> String {
    match language {
        "python" => format!(
            "#!/usr/bin/env python3\n\
             \"\"\"{name} — a plugin script.\n\n\
             Arguments arrive in sys.argv[1:]; print to stdout — the caller reads\n\
             that as the tool result.\n\
             \"\"\"\n\
             import sys\n\n\n\
             def main() -> None:\n\
             \x20   args = sys.argv[1:]\n\
             \x20   print(f\"{name} got {{len(args)}} argument(s): {{args!r}}\")\n\n\n\
             if __name__ == \"__main__\":\n\
             \x20   main()\n"
        ),
        "node" => format!(
            "#!/usr/bin/env node\n\
             // {name} — a plugin script.\n\
             // Arguments arrive in process.argv.slice(2); print to stdout.\n\
             const args = process.argv.slice(2);\n\
             console.log(`{name} got ${{args.length}} argument(s):`, args);\n"
        ),
        "bash" => format!(
            "#!/usr/bin/env bash\n\
             # {name} — a plugin script.\n\
             # Arguments arrive in \"$@\"; print to stdout.\n\
             set -euo pipefail\n\
             echo \"{name} got $# argument(s): $*\"\n"
        ),
        _ => format!(
            "//! {name} — a plugin script.\n\
             //!\n\
             //! Arguments arrive in `std::env::args()`; print to stdout — the\n\
             //! caller reads that as the tool result.\n\n\
             fn main() {{\n\
             \x20   let args: Vec<String> = std::env::args().skip(1).collect();\n\
             \x20   println!(\"{name} got {{}} argument(s): {{:?}}\", args.len(), args);\n\
             }}\n"
        ),
    }
}

/// Create/update/delete the scripts named by a create/update call.
///
/// Same shape as the skills branch above: only what the call names changes, so
/// adding one script never rewrites the others.
pub(super) fn apply_scripts(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    if let Some(list) = body["scripts"].as_array() {
        if list.len() > MAX_SCRIPTS {
            return Err(format!("a plugin can hold at most {MAX_SCRIPTS} scripts"));
        }
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() {
                return Err("every entry in `scripts` needs a name".into());
            }
            let dir = script_dir(root, slug, &name);
            let previous = item["previous_name"].as_str().unwrap_or("").trim();
            if !previous.is_empty() && previous != name {
                let old = script_dir(root, slug, previous);
                if old.is_dir() {
                    fs::rename(&old, &dir).map_err(|e| e.to_string())?;
                }
            }
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            // PATCH, not replace: a call that only rewrites the description or
            // the Persian keywords keeps the language and the body the script
            // already has. Naming neither used to fall back to Rust plus the
            // boilerplate template, so editing a Python script's description
            // silently replaced its source with Rust code nothing could run.
            let stored = read_script(root, slug, &name);
            let language = match item["language"].as_str().map(str::trim).filter(|l| !l.is_empty()) {
                Some(raw) => script_language(raw)?,
                None => stored
                    .as_ref()
                    .and_then(|m| m["language"].as_str())
                    .filter(|l| SCRIPT_LANGUAGES.contains(l))
                    .unwrap_or(DEFAULT_SCRIPT_LANGUAGE)
                    .to_string(),
            };
            // The stored body is only inherited when the language did not
            // change: keeping Rust source in a file that is now `main.py` would
            // be worse than starting from that language's template.
            let kept_source = stored
                .as_ref()
                .filter(|m| m["language"].as_str().unwrap_or(DEFAULT_SCRIPT_LANGUAGE) == language)
                .and_then(|m| read_script_source(root, slug, &name, m));
            let content = item["content"]
                .as_str()
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| kept_source.unwrap_or_else(|| script_template(&language, &name)));
            let description = match item.get("description").and_then(Value::as_str) {
                Some(text) => text.to_string(),
                None => stored
                    .as_ref()
                    .and_then(|m| m["description"].as_str())
                    .unwrap_or("")
                    .to_string(),
            };
            // An absent field keeps the stored keywords; an explicit empty one
            // clears them, exactly like `update_plugin` treats the bundle's own.
            let keywords = if has_keywords(item) {
                keywords_of(&item[KEYWORDS])
            } else {
                stored
                    .as_ref()
                    .map(|m| keywords_of(&m[KEYWORDS]))
                    .unwrap_or_default()
            };
            let now = now_secs();
            let created = stored
                .as_ref()
                .and_then(|m| m["created_at"].as_u64())
                .unwrap_or(now);
            let mut meta = json!({
                "name": name,
                "language": language,
                "description": description,
                "created_at": created,
                "updated_at": now,
            });
            if !keywords.is_empty() {
                meta[KEYWORDS] = json!(keywords);
            }
            fs::write(
                dir.join(script_file(&language)),
                content.trim_end().to_string() + "\n",
            )
            .map_err(|e| e.to_string())?;
            fs::write(
                dir.join(SCRIPT_MANIFEST),
                serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(list) = body["deleted_scripts"].as_array() {
        for item in list {
            let Some(name) = item.as_str() else { continue };
            let dir = script_dir(root, slug, name);
            if dir.is_dir() {
                fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Shell-quote one argument.
///
/// Every part of a script command is built from disk state (a slug, a path in
/// the data root), but quoting is what makes that safe by construction instead
/// of by argument about what `safe_file` happens to allow today.
pub(super) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Where a Rust script's compiled binary lives (inside the script's own folder,
/// so deleting the script deletes its build).
pub(super) fn rust_binary(dir: &Path, name: &str) -> PathBuf {
    dir.join(".build").join(crate::skills::safe_file(&name.to_lowercase(), "script"))
}

/// Run one of a plugin's scripts, bounded exactly like `run_terminal`.
///
/// KEY=VALUE pairs of the bundle's own `.env` — the home for API keys and other
/// secrets so they never hard-code into a script source. Blank lines, `#`
/// comments and malformed keys are skipped; an optional `export ` prefix and
/// one pair of matching quotes are stripped. Values are never logged.
pub(crate) fn load_plugin_env(dir: &Path) -> Vec<(String, String)> {
    let Ok(text) = fs::read_to_string(dir.join(".env")) else {
        return Vec::new();
    };
    let mut vars = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let mut value = value.trim().to_string();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_string();
        }
        vars.push((key.to_string(), value));
    }
    vars
}

/// How long one script run may block: its own `timeout` when the call names
/// one, else `0` = no deadline at all.
///
/// A plugin script has NO ceiling of its own, and no ceiling is imposed on it
/// from outside either. It used to have two (600 s, then an hour) and both were
/// smaller than the work they bounded: the script was killed AFTER a paid
/// article call, and the retry paid for it again. See
/// [`crate::tools::run_terminal_bounded`] for what `0` means there.
pub(super) fn script_timeout(body: &Value) -> u64 {
    body["timeout"].as_u64().unwrap_or(0)
}

/// Run one of a bundle's scripts. Rust is compiled with `rustc` on first use
/// and re-used until the source or the binary changes, so a repeat run costs
/// nothing; the other languages go straight to their interpreter.
pub fn run_plugin_script(root: &Path, body: &Value) -> Result<Value, String> {
    let plugin = plugin_ref(body);
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("a script name is required".into());
    }
    // The bundle's own switch governs its scripts too — see `plugin_enabled`.
    if !plugin_enabled(root, &plugin) {
        return Err(format!(
            "plugin {plugin} is switched off — enable it under Settings → Plugins to run its \
scripts"
        ));
    }
    let meta = read_script(root, &plugin, &name).ok_or_else(|| {
        format!(
            "plugin {plugin} has no script {name:?}. Scripts: {}",
            match script_names(root, &plugin) {
                names if names.is_empty() => "(none)".to_string(),
                names => names.join(", "),
            }
        )
    })?;
    let language = meta["language"].as_str().unwrap_or(DEFAULT_SCRIPT_LANGUAGE);
    // Rust is the project's own backend language, so it stays the default; the
    // other runtimes are accepted only when the bundle names one explicitly.
    // An artifact that needs a non-Rust backend asks the user first (see the
    // `artifact` schema), so an unknown runtime is refused rather than guessed:
    // no silent fallback to an interpreter the user never approved.
    if !matches!(language, "rust" | "python" | "node" | "bash") {
        return Err(format!(
            "plugin {plugin} script {name:?} asks for language {language:?}; supported: \
rust, python, node, bash"
        ));
    }
    let dir = script_dir(root, &plugin, &name);
    let source = dir.join(script_file(language));
    if !source.is_file() {
        return Err(format!(
            "script {name:?} of plugin {plugin} has no {} on disk",
            script_file(language)
        ));
    }

    let mut args: Vec<String> = body["args"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|a| a.as_str().map(str::to_string).unwrap_or_else(|| a.to_string()))
                .collect()
        })
        .unwrap_or_default();
    // Models often repeat the script's own name as the first argument (seen on
    // every call of a scheduled run), and the script then reads it as DATA: a
    // topic became "generate-article <topic>". The name is never an argument.
    if args.first().map(|a| a.trim()) == Some(name.as_str()) {
        args.remove(0);
    }
    // The script's OWN window: `timeout` from the call, else none at all.
    // No plugin default and no caller ceiling: a paid script must never be
    // killed after the money was spent.
    let timeout = script_timeout(body);
    // Default to the plugin folder: a script that ships data beside itself
    // resolves relative paths without the caller having to explain where it is.
    let cwd = body["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| plugin_dir(root, &plugin));
    if !cwd.is_dir() {
        return Err(format!("working folder {} does not exist", cwd.display()));
    }
    let cwd = cwd.to_string_lossy().to_string();

    let program = match language {
        "python" => "python3".to_string(),
        "node" => "node".to_string(),
        "bash" => "bash".to_string(),
        _ => {
            let bin = rust_binary(&dir, &name);
            if rust_needs_build(&source, &bin) {
                fs::create_dir_all(bin.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
                let build = format!(
                    "PATH={} {} -O -o {} {}",
                    sh_quote(&crate::shell_env::shell_path()),
                    sh_quote("rustc"),
                    sh_quote(&bin.to_string_lossy()),
                    sh_quote(&source.to_string_lossy()),
                );
                let out = crate::tools::run_terminal(&cwd, &build, SCRIPT_BUILD_TIMEOUT_SECS)?;
                if !bin.is_file() {
                    // `rustc` missing or the source does not compile: hand the
                    // compiler's own words back instead of a bare failure.
                    return Err(format!("could not build Rust script {name:?}:\n{out}"));
                }
            }
            bin.to_string_lossy().to_string()
        }
    };

    // Secrets come from the bundle's own `.env` (see `load_plugin_env`): they
    // are prefixed as shell assignments BEFORE our PATH assignment, so a plugin
    // may shadow any variable it needs while PATH stays ours (the LAST
    // duplicate assignment wins).
    //
    // Every piece — each KEY=VALUE, our PATH and the program path — is quoted
    // SEPARATELY and joined with explicit spaces. The old concatenation glued
    // them into ONE word, so `sh` saw a single never-found command and the
    // args became its arguments: every run of a bundle with a .env died with
    // exit 127 "command not found".
    let mut command = String::new();
    for (k, v) in load_plugin_env(&plugin_dir(root, &plugin)) {
        command.push_str(&format!("{k}={}", sh_quote(&v)));
        command.push(' ');
    }
    command.push_str(&format!(
        "PATH={}",
        sh_quote(&crate::shell_env::shell_path())
    ));
    command.push(' ');
    command.push_str(&sh_quote(&program));
    // An interpreter needs the FILE as its own first argument. The Rust branch's
    // `program` is the compiled binary, which is self-contained — passing the
    // source to it would only be read as an argument.
    if language != DEFAULT_SCRIPT_LANGUAGE {
        command.push(' ');
        command.push_str(&sh_quote(&source.to_string_lossy()));
    }
    for a in &args {
        command.push(' ');
        command.push_str(&sh_quote(a));
    }
    // The script's own window may exceed the terminal default (a paid article
    // call takes minutes), so the bound is passed explicitly instead of
    // inheriting the global one — and `ceiling = 0` means the plugin layer
    // imposes none: the script is never clipped.
    let output = crate::tools::run_terminal_bounded(&cwd, &command, timeout, 0)?;
    Ok(json!({
        "plugin": plugin,
        "script": name,
        "language": language,
        "args": args,
        "cwd": cwd,
        "output": output,
    }))
}

/// Whether a Rust script has to be compiled again: no binary yet, or either
/// side of the pair moved since the last build.
pub(super) fn rust_needs_build(source: &Path, bin: &Path) -> bool {
    let Ok(built) = fs::metadata(bin).and_then(|m| m.modified()) else {
        return true;
    };
    match fs::metadata(source).and_then(|m| m.modified()) {
        Ok(src) => src > built,
        // An unreadable source is not a reason to skip the build: `rustc` gives
        // a far better message than "up to date" would.
        Err(_) => true,
    }
}

