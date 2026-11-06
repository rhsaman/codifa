use super::*;

/// Overwrite a file with new content (brand-new files or full rewrites).
pub fn write_file(root: &str, path: &str, content: &str, permit: Option<&Value>) -> Result<String, String> {
    // `true`: ~/.codifa (plugins, skills) is the agent's own store — writing it
    // without a popup is the same trust reading already has.
    let target = resolve_safe(root, path, true, permit)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create parent dir: {e}"))?;
    }
    fs::write(&target, content).map_err(|e| format!("cannot write file: {e}"))?;
    Ok(format!("Successfully wrote {path} ({} bytes).", content.len()))
}

/// One old_string -> new_string replacement (byte-exact match, uniqueness
/// enforced unless replace_all). Returns a summary or an error message.
pub fn edit_file(
    root: &str,
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    permit: Option<&Value>,
) -> Result<String, String> {
    if old_string == new_string {
        return Err("old_string and new_string are identical".into());
    }
    let target = resolve_safe(root, path, true, permit)?;
    if !target.exists() {
        return Err("file not found".into());
    }
    if target.is_dir() {
        return Err("path is a directory".into());
    }
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_READ_BYTES {
        return Err("file too large to edit safely".into());
    }
    let content = read_editable_text(&target)?;

    let occurrences = content.matches(old_string).count();
    if occurrences == 0 {
        return Err(format!(
            "old_string not found in file.{}",
            nearest_hint(&content, old_string)
        ));
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "old_string appears {occurrences} times — include more surrounding lines to make it unique, or pass replace_all=true{}",
            ambiguous_hint(&content, old_string)
        ));
    }
    let new_content = if replace_all {
        content.replace(old_string, new_string)
    } else {
        content.replacen(old_string, new_string, 1)
    };
    fs::write(&target, &new_content).map_err(|e| format!("cannot write file: {e}"))?;
    let n = if replace_all { occurrences } else { 1 };
    Ok(format!(
        "Successfully edited {path} ({n} occurrence{} replaced).",
        if n == 1 { "" } else { "s" }
    ))
}

/// Group a batch `edits` list by the file each entry targets.
///
/// Entries without their own `path` inherit the call's top-level one. Files are
/// kept in first-appearance order so a batch still applies in the order the
/// model wrote it.
pub(super) fn edits_by_path(edits: &[Value], default_path: &str) -> Vec<(String, Vec<Value>)> {
    let mut order: Vec<String> = Vec::new();
    let mut by_file: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for item in edits {
        let file = item["path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .unwrap_or(default_path)
            .to_string();
        if !by_file.contains_key(&file) {
            order.push(file.clone());
        }
        by_file.entry(file).or_default().push(item.clone());
    }
    order
        .into_iter()
        .map(|f| {
            let items = by_file.remove(&f).unwrap_or_default();
            (f, items)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// terminal (bounded, non-PTY — the interactive PTY stays in pty.rs)
// ---------------------------------------------------------------------------

