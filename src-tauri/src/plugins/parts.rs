use super::*;

/// Skills + connectors carried by a create/update call.
pub(super) fn apply_parts(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    let dir = plugin_dir(root, slug);
    if let Some(list) = body["skills"].as_array() {
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim();
            if name.is_empty() {
                return Err("every entry in `skills` needs a name".into());
            }
            // An entry that names no keywords at all inherits the bundle's;
            // an explicit (even empty) list is respected as written, so a
            // skill can opt out of keywords.
            let empty = item.get("fa_keywords").is_none_or(|v| match v {
                Value::Null => true,
                Value::String(s) => s.trim().is_empty(),
                Value::Array(a) => a.is_empty(),
                _ => false,
            });
            // A skill that names no keywords is seeded from its own NAME — the
            // only fact about it that is known to be relevant. The bundle's list
            // is deliberately NOT used here: it belongs to the bundle, and
            // copying it onto every skill of a mixed library gave all of them
            // one identical, half-irrelevant trigger.
            let keywords = if empty {
                let seed = category_keywords(name);
                // Empty seed → Null ("keep what is stored"), never "": a bare
                // reinstall would otherwise wipe a list the user typed in.
                if seed.is_empty() {
                    Value::Null
                } else {
                    json!(seed)
                }
            } else {
                item["fa_keywords"].clone()
            };
            // A rename and an extra-file deletion were dropped here, so a rename
            // built a second folder and a "deleted" extra file stayed on disk.
            // `sync_skill` accepts both spellings, so pass whichever came in.
            let deleted = if item.get("deleted_files").is_some() {
                item["deleted_files"].clone()
            } else {
                item["deletedFiles"].clone()
            };
            // The plugin folder IS a skill-store root, so the existing writer
            // owns the frontmatter/slug/extra-file rules for both stores.
            // Both spellings reach here (the renderer sends camelCase) and
            // `sync_skill` accepts either, so pass whichever arrived — passing
            // only `extra_files` silently dropped an editor's added files.
            crate::skills::sync_skill(
                &dir,
                &json!({
                    "name": name,
                    "previous_name": item["previous_name"].clone(),
                    "content": item["content"].clone(),
                    "description": item["description"].clone(),
                    "fa_keywords": keywords,
                    "extra_files": if item.get("extra_files").is_some() {
                        item["extra_files"].clone()
                    } else {
                        item["files"].clone()
                    },
                    "deleted_files": deleted,
                }),
            )?;
        }
    }
    if let Some(list) = body["deleted_skills"].as_array() {
        for item in list {
            let Some(name) = item.as_str() else { continue };
            if let Some(skill) = crate::skills::find_skill_dir_pub(&dir, name) {
                fs::remove_dir_all(skill).map_err(|e| e.to_string())?;
            }
        }
    }
    if body["mcp"].is_object() || body["deleted_mcp"].is_array() {
        // Merge, never replace: an update that only touches a skill must not
        // drop the connectors the call did not mention.
        let mut servers = read_connectors(root, slug);
        if let Some(map) = body["mcp"].as_object() {
            for (name, cfg) in map {
                servers.insert(name.clone(), cfg.clone());
            }
        }
        if let Some(list) = body["deleted_mcp"].as_array() {
            for item in list {
                if let Some(name) = item.as_str() {
                    servers.remove(name);
                }
            }
        }
        write_connectors(&dir, &servers)?;
    }
    // Last, so a bundle that ships code lands with it: `scripts/` is written
    // through the same branch a hand-authored one takes.
    apply_scripts(root, slug, body)?;
    apply_commands(root, slug, body)?;
    apply_agents(root, slug, body)?;
    apply_hooks(root, slug, body)?;
    Ok(())
}

/// Write a bundle's slash commands.
///
/// PATCH by name like the other parts: a command named in the call is written,
/// every other one on disk is left alone, and `deleted_commands` removes the
/// ones the call drops. A command's file name IS its name (see [`list_commands`]).
pub(super) fn apply_commands(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    if let Some(list) = body[COMMANDS].as_array() {
        if list.len() > MAX_COMMANDS {
            return Err(format!(
                "a plugin may hold at most {MAX_COMMANDS} commands (got {})",
                list.len()
            ));
        }
        let dir = commands_dir(root, slug);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim();
            if name.is_empty() {
                return Err("every entry in `commands` needs a name".into());
            }
            // `safe_file` lowercases nothing and keeps dots, so the file stem is
            // sanitized explicitly: a name with a separator must never escape
            // the commands folder.
            let stem = crate::skills::safe_file(name, "command");
            let content = match item["content"].as_str().map(str::trim) {
                Some(text) if !text.is_empty() => text.to_string(),
                // A call that only names the command (install of a repo that
                // carries no body, `/plugin create commands:[{name: "x"}]`) keeps
                // whatever body it already has, so a description-only edit never
                // wipes the prompt.
                _ => fs::read_to_string(dir.join(format!("{stem}.md")))
                    .map(|previous| previous.trim().to_string())
                    .unwrap_or_else(|_| command_template(name)),
            };
            fs::write(dir.join(format!("{stem}.md")), content.trim_end().to_string() + "\n")
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some(list) = body["deleted_commands"].as_array() {
        let dir = commands_dir(root, slug);
        for item in list {
            let Some(name) = item.as_str() else { continue };
            let path = dir.join(format!("{}.md", crate::skills::safe_file(name, "command")));
            if path.is_file() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Write a bundle's sub-agent profiles.
///
/// Stored verbatim (frontmatter and body as the repo shipped them) so the file
/// stays a real Claude Code profile, readable by `subagents::read_agents` here
/// and by Claude Code itself.
pub(super) fn apply_agents(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    if let Some(list) = body[crate::subagents::AGENTS].as_array() {
        if list.len() > crate::subagents::MAX_AGENTS {
            return Err(format!(
                "a plugin may hold at most {} sub-agents (got {})",
                crate::subagents::MAX_AGENTS,
                list.len()
            ));
        }
        let dir = agents_dir(root, slug);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for item in list {
            let name = item["name"].as_str().unwrap_or("").trim();
            if name.is_empty() {
                return Err("every entry in `agents` needs a name".into());
            }
            let stem = crate::skills::safe_file(name, "agent");
            // A repo install hands the file over AS IT WAS (`content`); a call
            // from chat hands the fields over instead, so the frontmatter is
            // assembled here rather than making the model write YAML.
            let text = match item["content"].as_str().map(str::trim) {
                Some(raw) if !raw.is_empty() => raw.to_string(),
                _ => {
                    let prompt = item["prompt"].as_str().unwrap_or("").trim();
                    if prompt.is_empty() {
                        return Err(format!(
                            "sub-agent \"{name}\" needs a `prompt` (or the raw `content` of its file)"
                        ));
                    }
                    let description = item["description"].as_str().unwrap_or("").trim();
                    let tools = item["tools"]
                        .as_array()
                        .map(|list| {
                            list.iter()
                                .filter_map(Value::as_str)
                                .map(str::trim)
                                .filter(|t| !t.is_empty())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    let mut head = format!("---\nname: {name}\n");
                    if !description.is_empty() {
                        head.push_str(&format!("description: {description}\n"));
                    }
                    if !tools.is_empty() {
                        head.push_str(&format!("tools: {tools}\n"));
                    }
                    head.push_str("---\n\n");
                    head.push_str(prompt);
                    head
                }
            };
            fs::write(dir.join(format!("{stem}.md")), text.trim_end().to_string() + "\n")
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some(list) = body["deleted_agents"].as_array() {
        let dir = agents_dir(root, slug);
        for item in list {
            let Some(name) = item.as_str() else { continue };
            let path = dir.join(format!("{}.md", crate::skills::safe_file(name, "agent")));
            if path.is_file() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Write a bundle's hook declarations.
///
/// The file is written as given, then VALIDATED through the same reader the
/// agent loop uses: what cannot run as written is rejected at write time instead
/// of becoming a hook that silently never fires. The handlers run while the
/// bundle itself is enabled — the bundle's switch is the approval.
///
/// Three shapes are accepted: the canonical `{"hooks": {...}}` document a repo
/// ships, the bare event map a chat call writes, and the FLAT row list
/// (`[{event, matcher, command}]`) the repo reader produces — that last one is
/// what an install carries, and reading it as an object dropped every hook.
pub(super) fn apply_hooks(root: &Path, slug: &str, body: &Value) -> Result<(), String> {
    let document = match &body["hooks"] {
        Value::Object(doc) if doc.contains_key("hooks") => Value::Object(doc.clone()),
        Value::Object(doc) => json!({ "hooks": Value::Object(doc.clone()) }),
        Value::Array(rows) => hooks_document_from_rows(rows),
        _ => return Ok(()),
    };
    let dir = crate::hooks::hooks_dir(&plugin_dir(root, slug));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(crate::hooks::HOOKS_FILE);
    let declared = crate::hooks::hooks_of_in(&document, &plugin_dir(root, slug));
    if declared.is_empty() {
        return Err(
            "`hooks` carried no usable handler — every command was empty, left the plugin \
             folder, or named an event Codifa does not know"
                .into(),
        );
    }
    write_hook_files(root, slug, &body["hook_files"])?;
    fs::write(
        &file,
        serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Rebuild a hooks document out of the flat `{event, matcher, command}` rows.
pub(super) fn hooks_document_from_rows(rows: &[Value]) -> Value {
    let mut events: serde_json::Map<String, Value> = serde_json::Map::new();
    for row in rows {
        let Some(event) = row["event"].as_str().map(str::trim).filter(|e| !e.is_empty()) else {
            continue;
        };
        let Some(command) = row["command"].as_str().map(str::trim).filter(|c| !c.is_empty()) else {
            continue;
        };
        let matcher = row["matcher"].as_str().unwrap_or("").trim();
        let mut entry = json!({ "hooks": [{"type": "command", "command": command}] });
        if !matcher.is_empty() {
            entry["matcher"] = json!(matcher);
        }
        events
            .entry(event.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .map(|list| list.push(entry));
    }
    json!({ "hooks": Value::Object(events) })
}

/// Write the handler scripts a bundle's declarations point at.
///
/// Each entry is `{path, content}` with `path` relative to the bundle folder
/// (`hooks-handlers/session-start.sh`), which is exactly how the declaration
/// spells it after the `${CLAUDE_PLUGIN_ROOT}/` prefix. Anything absolute or
/// escaping the folder is refused: this writes files FROM A REMOTE REPO, so the
/// path is untrusted input, not a convenience.
pub(super) fn write_hook_files(root: &Path, slug: &str, list: &Value) -> Result<(), String> {
    let Some(files) = list.as_array() else {
        return Ok(());
    };
    let base = plugin_dir(root, slug);
    for item in files {
        let Some(rel) = item["path"].as_str().map(str::trim).filter(|p| !p.is_empty()) else {
            continue;
        };
        let path = Path::new(rel);
        let safe = !path.is_absolute()
            && path
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)));
        if !safe {
            return Err(format!(
                "hook file {rel:?} must be a relative path inside the plugin folder"
            ));
        }
        let dest = base.join(path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, item["content"].as_str().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        // A handler that is not executable fails to start, and the one thing a
        // hook must never do is fail silently at runtime. Unix only: elsewhere
        // the shell runs it by extension.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

/// Starting point for a command created from chat: the documented argument
/// placeholders, so a command that forgets them is the exception.
pub(super) fn command_template(name: &str) -> String {
    format!(
        "Run the `{name}` command.\n\n\
         Arguments: $ARGUMENTS\n"
    )
}

