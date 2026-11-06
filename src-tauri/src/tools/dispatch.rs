use super::*;

/// Execute one tool call by name with JSON args; returns the ToolMessage text.
/// LSP-backed tools (lsp_*) and MCP connector tools are routed by the agent
/// loop before this dispatcher; unknown names reaching here are a real error.
pub fn dispatch(root: &str, name: &str, args: &Value, permit: Option<&Value>) -> Result<String, String> {
    dispatch_with_data_root(root, name, args, permit, None)
}

pub fn dispatch_with_data_root(
    root: &str,
    name: &str,
    args: &Value,
    permit: Option<&Value>,
    data_root: Option<&str>,
) -> Result<String, String> {
    dispatch_bounded(root, name, args, permit, data_root)
}

/// The dispatch every caller ends up in, whatever spawned it (main agent,
/// sub-agent, scheduler, HTTP route).
///
/// There is no headless/interactive distinction here on purpose: one budget
/// ([`MAX_TERMINAL_TIMEOUT_SECS`]) covers every foreground wait, so a scheduled
/// run and a chat turn can never disagree about how long work may take.
pub fn dispatch_bounded(
    root: &str,
    name: &str,
    args: &Value,
    permit: Option<&Value>,
    data_root: Option<&str>,
) -> Result<String, String> {
    dispatch_bounded_with(root, name, args, permit, data_root, None)
}

/// Same as [`dispatch_bounded`], with an optional [`TailSink`] for the
/// `run_terminal` handler: while a dispatched command runs, its live output
/// tail flows to the sink (the agent loop turns it into UI events). Every
/// other handler ignores it. Callers that hold the sink keep the call alive —
/// the sink is `Option<&TailSink>`, borrowed for the dispatch's duration.
pub fn dispatch_bounded_with(
    root: &str,
    name: &str,
    args: &Value,
    permit: Option<&Value>,
    data_root: Option<&str>,
    on_tail: Option<&TailSink>,
) -> Result<String, String> {
    // One number for every wait this dispatch may block on.
    let ceiling = MAX_TERMINAL_TIMEOUT_SECS;
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    // Bounded discovery — the ONE place every search passes through, so no
    // caller (main agent, sub-agent, MCP) can flood a context by accident.
    //
    // Measured on the traced corpus: 67% of all tool calls are raw search, and
    // the explore sub-agent re-sends every result on each of its ~4 rounds, so
    // 14.98M result chars (~3.74M tokens) were paid again and again. Two of the
    // three search verbs also default to a WIDER window than any agent needs:
    // `grep` handed back 50 hits with a context line each, `glob` up to 100
    // paths. The model asked for none of that — it asked for one hit list.
    //
    // Only the DEFAULT shrinks. An explicit bigger `max_results` still wins, so
    // nothing becomes impossible; the model pays for size only when it says so.
    let search = |k: &str, fallback: u64| -> usize {
        args[k].as_u64().unwrap_or(fallback) as usize
    };
    // Where the skill/connector store lives for THIS call: the data root when
    // the caller knows it, else the workspace root.
    let store_base = match data_root {
        Some(d) if !d.trim().is_empty() => d,
        _ => root,
    };
    match name {
        "read" => {
            let path = {
                let p = s("filePath");
                if p.is_empty() { s("path") } else { p }
            };
            // Batching lives in `ranges`: every entry carries its own file AND
            // its own window, so several KNOWN files still cost ONE call (a main
            // round re-sends the whole conversation for ~7.7K uncached tokens
            // against ~26K for a narrow `explore` delegation) — and no file can
            // be named twice with one shared window forced on all of them.
            //
            // `paths` is a legacy spelling that is NOT advertised any more. It
            // is normalised here rather than refused: a stale transcript must
            // not burn a round trip, and the shared dedupe below removes the
            // repeated file the old form allowed.
            let mut targets: Vec<(String, usize, usize, bool)> = Vec::new();
            if let Some(ranges) = ranges_of(args) {
                for r in ranges {
                    let file = r["path"].as_str().unwrap_or(path.as_str()).to_string();
                    if file.is_empty() {
                        return Err(
                            "read: a `ranges` entry names no file — give every entry a `path` (or pass one top-level filePath)".into(),
                        );
                    }
                    targets.push((
                        file,
                        r["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize,
                        r["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize,
                        // A window the model SIZED ITSELF is served exactly; only
                        // the default window may stretch to the file tail.
                        r["limit"].is_null(),
                    ));
                }
            } else if let Some(paths) = args["paths"].as_array() {
                if paths.is_empty() {
                    return Err("read: `paths` was empty — pass `ranges` entries instead".into());
                }
                let offset = args["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize;
                let limit = args["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize;
                for p in paths.iter().filter_map(Value::as_str) {
                    targets.push((p.to_string(), offset, limit, args["limit"].is_null()));
                }
            }
            if !targets.is_empty() {
                // A batch whose top-level `filePath` names a DIRECTORY resolves
                // each RELATIVE `ranges` entry against it. MEASURED
                // (mvrv45fv r0+r29): `filePath=<src dir>` with
                // `path:"secrets.rs"` fell back to the workspace root, every
                // window died with ENOENT, and each one cost a retry round.
                if !path.is_empty() {
                    if let Ok(abs_dir) = resolve_safe(root, &path, true, permit) {
                        if abs_dir.is_dir() {
                            let base = abs_dir.to_string_lossy().trim_end_matches('/').to_string();
                            for t in targets.iter_mut() {
                                if !t.0.starts_with('/') && !t.0.starts_with('~') && !t.0.is_empty() {
                                    t.0 = format!("{base}/{}", t.0);
                                }
                            }
                        }
                    }
                }
                // Overlapping windows of one file collapse into their union
                // (see `merge_read_targets`) before a single byte is read, so
                // the model never pays twice for lines it asked for once.
                let asked = targets.len();
                let targets = merge_read_targets(targets);
                let collapsed = asked.saturating_sub(targets.len());
                let mut out = String::new();
                // Every window gets an equal share of the one budget the turn
                // loop will enforce anyway (`MODEL_RESULT_CAP`): a flat tail cut
                // would drop the last windows of any 4+ entry batch, which is
                // what made a traced batch re-read its own file 10 times.
                let per_block = (crate::agent::MODEL_RESULT_CAP / targets.len().max(1))
                    .max(READ_BLOCK_MIN);
                for (file, offset, limit, extend) in targets {
                    let abs = resolve_safe(root, &file, true, permit)?;
                    // An image has no text window: hand back a marker the turn
                    // loop turns into a real image block, instead of the byte-cap
                    // refusal this read used to end in.
                    if let Some(note) = crate::commands::image_read_note(&abs.to_string_lossy()) {
                        if !out.is_empty() {
                            out.push_str("\n\n");
                        }
                        out.push_str(&note);
                        continue;
                    }
                    if !out.is_empty() {
                        out.push_str("\n\n");
                    }
                    out.push_str(&read_window_block_capped(
                        &abs, &file, offset, limit, per_block, extend,
                    )?);
                    // ONE map per file per turn, on the FIRST window taken from
                    // it — including when the model asks for ranges. MEASURED:
                    // all 205 read windows of a 234-round trace were 40-70 line
                    // peeks, so the single-path-only outline never fired and the
                    // model walked `agent.rs` 94 times blind.
                    out.push_str(&outline_note_once(&abs, &file));
                }
                // The note rides on the result the model already pays for: it
                // says the collapse happened (so the ruler counts it as FACT) and
                // stops the model from re-asking for a window it just received.
                if collapsed > 0 {
                    out.push_str(&format!(
                        "\n{READ_MERGED_MARK}{collapsed} overlapping window(s) of the same file \
into one union — those lines are all above; do NOT re-read them]"
                    ));
                }
                return Ok(out);
            }
            // `filePaths` is the oldest batch spelling; it points at `ranges`.
            if path.is_empty() && args["filePaths"].is_array() {
                return Err(
                    "read takes one filePath — to read several files or several windows in ONE call pass ranges=[{\"path\":\"a.rs\",\"offset\":1,\"limit\":400},…]".into(),
                );
            }
            // An empty path resolves to the workspace ROOT, which answers every
            // window request with a directory listing marked `ok`. That is never
            // what a read meant, so say so instead of billing a useless round.
            if path.trim().is_empty() {
                return Err(
                    "read: no file named — pass `filePath`, or \
                     ranges=[{\"path\":\"a.rs\",\"offset\":1,\"limit\":400},…] for several windows".into(),
                );
            }
            let offset = args["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize;
            // Windowed-read discipline: a whole-file read floods the context
            // and slows the agent down. Cap the default window; larger reads
            // must be explicit (offset/limit).
            let limit = args["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize;
            let abs = resolve_safe(root, &path, true, permit)?;
            // Same as the batch path above: an image file is described, never
            // windowed.
            if let Some(note) = crate::commands::image_read_note(&abs.to_string_lossy()) {
                return Ok(note);
            }
            // A single window gets the same budget as one batch entry: a file
            // window larger than the model cap used to be cut by the turn loop
            // with no marker at all (the traced TVKit.mq5 read came back as
            // 16_086 of 17_534 chars, and the model re-read it 3 times).
            let block = read_window_block_capped(
                &abs,
                &path,
                offset,
                limit,
                crate::agent::MODEL_RESULT_CAP,
                args["limit"].is_null(),
            )?;
            // A LARGE file gets its own outline in the same result. Traced
            // (mvxqpye6): the model walked a 16_861-line file in 120-line windows
            // — 98 reads, 73% of every byte it pulled in — because nothing told
            // it where anything was. The map is a few hundred bytes and turns
            // the rest of that walk into targeted windows.
            Ok(format!("{block}{}", outline_note_once(&abs, &path)))
        }
        "grep" => {
            let mut patterns = vec![s("pattern")];
            if let Some(extra) = args["patterns"].as_array() {
                patterns.extend(extra.iter().filter_map(|p| p.as_str().map(String::from)));
            }
            let combined: Vec<&str> = patterns.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
            if combined.is_empty() {
                return Err("empty pattern: pass pattern='...' or patterns=[...]".into());
            }
            let joined = combined.join("|");
            // Catch-all patterns (".", ".*", …) match every line of every file —
            // a whole-tree scan disguised as a grep. Refuse them outright.
            if matches!(joined.trim(), "." | ".*" | ".+" | "^" | "$" | "^$") {
                return Err(format!(
                    "catch-all pattern {joined:?} refused — grep a real token instead \
(to read a file use read with offset/limit)"
                ));
            }
            if count_grep_alternatives(&joined) > MAX_GREP_ALTERNATIVES
                && s("path").is_empty()
                && s("include").is_empty()
            {
                return Err(broad_pattern_refusal(&joined));
            }
            let max = search("max_results", 20);
            // Context lines per hit (default 1 — 3 was hardcoded and tripled the
            // output) and case sensitivity (case-SENSITIVE by default; opt in to
            // ignore_case). These two are grep's biggest token levers.
            let context = args["context"].as_u64().unwrap_or(1).min(5) as usize;
            let ignore_case = args["ignore_case"].as_bool().unwrap_or(false);
            let result = grep_scope_in(
                Path::new(root),
                &s("path"),
                &joined,
                &s("include"),
                max,
                context,
                ignore_case,
                permit,
            )?;
            // Order matters: the result cap is a TAIL cut, so what is appended
            // LAST survives. The follow-up hint keeps the final slot (it is the
            // instruction), and the symbol answer sits ABOVE it because a real
            // definition+usages payload is worth more than an outline when a
            // huge grep result forces one of them out.
            Ok(format!(
                "{result}{}{}{}",
                grep_outline_block(root, &result, permit),
                identifier_symbol_block(root, &joined, &result),
                grep_followup_hint(&joined, &result)
            ))
        }
        "find_symbol" => {
            find_symbol_in(Path::new(root), &s("symbol"), &s("path"), &s("include"), permit)
        }
        "glob" => {
            let mut patterns = vec![s("pattern")];
            if let Some(extra) = args["patterns"].as_array() {
                patterns.extend(extra.iter().filter_map(|p| p.as_str().map(String::from)));
            }
            let pattern = patterns.into_iter().find(|p| !p.is_empty()).unwrap_or_default();
            if pattern.is_empty() {
                return Err("empty pattern: pass pattern='...' or patterns=[...]".into());
            }
            let scope = s("path");
            if scope.is_empty() {
                return Err("Workspace-wide glob is not allowed. Provide path=... to scope the search".into());
            }
            let max = search("max_results", 40);
            let hits = glob_scope_in(Path::new(root), &scope, &pattern, max, permit)?;
            if hits.is_empty() {
                Ok(format!(
                    "no matches for {pattern:?} under {scope:?}. glob lists FILES only (never directories), skips hidden dirs and node_modules/target/dist/build, and `**/` matches zero or more directories. This answer is final — do not retry variations: use grep, or read a directory path to list its entries."
                ))
            } else {
                Ok(hits.join("\n"))
            }
        }
        "write_file" => {
            // `write_file` plans a WHOLE file, so a call that arrives without one
            // is not a small write — it is the model having dropped the argument.
            // Answering it with `fs::write(.., "")` truncated the target to zero
            // bytes and still reported "Successfully wrote … (0 bytes)", which
            // reads as done. Traced in one chat: 16 identical calls to the same
            // path, each `{path}` only, each "0 bytes" — the model could not see
            // that its content never arrived, so it re-sent the same call until
            // the turn ran out. Refuse instead, and name the argument.
            // An EXPLICIT empty string stays legal (it empties a file on
            // purpose); only an ABSENT/short-circuited body is refused.
            // A `files` ARRAY writes several files IN ORDER in this one call:
            // the model answers with exactly one tool call per reply, so
            // multi-file work otherwise costs one full-context round-trip per
            // file. The single `path`/`content` form stays as-is.
            let batch: Vec<(String, String)> = args["files"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|f| {
                            let p = f["path"].as_str()?.trim();
                            if p.is_empty() {
                                return None;
                            }
                            Some((p.to_string(), f["content"].as_str().unwrap_or_default().to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !batch.is_empty() {
                let mut out = String::new();
                for (path, content) in &batch {
                    write_file(root, path, content, permit)?;
                    out.push_str(&format!("wrote {path} ({} bytes)\n", content.len()));
                }
                return Ok(out);
            }
            let content = args["content"].as_str();
            let content = match content {
                Some(c) => c,
                None => {
                    return Err(format!(
                        "write_file needs `content` and this call sent none (path={:?}). For a brand-new file pass the WHOLE file as `content`; for an existing one use `edit_file` with the exact old_string/new_string instead of rewriting it.",
                        s("path")
                    ))
                }
            };
            write_file(root, &s("path"), content, permit)
        }
        "edit_file" => {
            let path = {
                let p = s("path");
                if p.is_empty() { s("filePath") } else { p }
            };
            // A batch may name its file ONLY per entry (`edits: [{path, …}]`, the
            // shape the schema advertises). The top-level `path` is then absent,
            // so resolving it landed on the workspace ROOT and the edit died with
            // "cannot read <root> for editing: Is a directory (os error 21)" — a
            // message that named no file at all. Correcting it therefore needed a
            // reinterpretation of the request rather than a retry, and it cost a
            // whole round.
            let path = if path.is_empty() {
                args["edits"]
                    .as_array()
                    .and_then(|edits| edits.first())
                    .and_then(|first| first["path"].as_str())
                    .filter(|p| !p.is_empty())
                    .map(str::to_string)
                    .unwrap_or(path)
            } else {
                path
            };
            // A writer needs a FILE. When neither shape named one, the empty
            // path resolved to the workspace ROOT and died inside
            // `read_editable_text` as "cannot read <root> for editing: Is a
            // directory (os error 21)" — a message that names no file, so the
            // model had to reinterpret the whole call instead of correcting it.
            // Refuse at the boundary, in the words of the argument it lacked.
            if path.trim().is_empty() {
                return Err(
                    "edit_file: no file named — pass `path`, or a `path` on each entry of \
                     `edits` ({\"path\": \"src/a.ts\", \"old_string\": …, \"new_string\": …})"
                        .into(),
                );
            }
            // A batch may name a DIFFERENT file per entry (`edits: [{path, …}]`,
            // the shape the schema advertises). The single-file body below
            // presumes one target, so a multi-file batch is applied here, one
            // recursive call per file, and reported together.
            //
            // Without this the per-entry `path` was silently IGNORED and every
            // entry landed on the top-level path: a cross-file batch failed with
            // "old_string not found" on the wrong file, the model could not tell
            // which file had been edited, and it paid a re-read plus a retry
            // round per file (traced: 13 edits over 2 files took 11 rounds — the
            // exact "several round trips to edit one file" shape).
            if let Some(edits) = args["edits"].as_array() {
                let groups = edits_by_path(edits, &path);
                if groups.len() > 1 {
                    let mut done: Vec<String> = Vec::new();
                    let mut failed: Vec<String> = Vec::new();
                    for (file, items) in groups {
                        let sub = json!({ "path": file, "edits": Value::Array(items) });
                        match dispatch_bounded(root, "edit_file", &sub, permit, data_root) {
                            // Reuse the single-file result verbatim: it already
                            // carries the partial-success wording and the
                            // post-edit diagnostics for its own file.
                            Ok(msg) => done.push(msg),
                            Err(e) => failed.push(format!("{file}: {e}")),
                        }
                    }
                    if done.is_empty() {
                        return Err(format!("no edit applied to any file. {}", failed.join("; ")));
                    }
                    let mut out = done.join("\n");
                    if !failed.is_empty() {
                        out.push_str(&format!(
                            "\n{} file(s) FAILED and were NOT edited — fix ONLY these next: {}",
                            failed.len(),
                            failed.join("; ")
                        ));
                    }
                    return Ok(out);
                }
            }
            // Batch edits apply sequentially in list order.
            if let Some(edits) = args["edits"].as_array() {
                if edits.is_empty() {
                    return Err("edits must be a non-empty list".into());
                }
                // `true`: plugin trees live under ~/.codifa — traced batch edits
                // there died on "path escapes project root".
                let target = resolve_safe(root, &path, true, permit)?;
                // Same size guard as the single-edit path below. Without it the
                // batch form read (and then copied 1-2 more times via
                // replace/replacen) an arbitrarily large file — a multi-GB
                // allocation that froze the UI, while the single-edit form
                // correctly refused with "file too large to edit safely".
                let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
                if meta.len() as usize > MAX_READ_BYTES {
                    return Err("file too large to edit safely".into());
                }
                let mut content = read_editable_text(&target)?;
                // ONE bad entry must not throw away the good ones. Measured on
                // the live corpus: 8 of 84 batch edits failed this way and each
                // cost a median of 2 extra rounds (18 rounds total, 4 of them a
                // blind re-read of the same file) — the model had no idea which
                // edits had landed, so it re-sent the whole batch. Apply what
                // applies, write it, and name exactly what did not.
                let mut applied = 0usize;
                let mut failures: Vec<String> = Vec::new();
                // The current-text window rides on the FIRST missing entry only.
                // One window is what the model needs (it fixes one string at a
                // time), and keeping the other failures bare bounds the whole
                // message at ~one window instead of one per failure.
                let mut hint: Option<String> = None;
                for (idx, item) in edits.iter().enumerate() {
                    let old = item["old_string"].as_str().unwrap_or_default();
                    let new = item["new_string"].as_str().unwrap_or_default();
                    let all = item["replace_all"].as_bool().unwrap_or(false);
                    if old.is_empty() {
                        failures.push(format!("edit {}/{}: old_string is empty", idx + 1, edits.len()));
                        continue;
                    }
                    if old == new {
                        failures.push(format!(
                            "edit {}/{}: old_string and new_string are identical",
                            idx + 1,
                            edits.len()
                        ));
                        continue;
                    }
                    let occ = content.matches(old).count();
                    if occ == 0 {
                        failures.push(format!("edit {}/{}: old_string not found", idx + 1, edits.len()));
                        if hint.is_none() {
                            hint = Some(nearest_hint(&content, old));
                        }
                        continue;
                    }
                    if occ > 1 && !all {
                        failures.push(format!(
                            "edit {}/{}: old_string appears {occ} times — make it unique",
                            idx + 1,
                            edits.len()
                        ));
                        if hint.is_none() {
                            hint = Some(ambiguous_hint(&content, old));
                        }
                        continue;
                    }
                    content = if all { content.replace(old, new) } else { content.replacen(old, new, 1) };
                    applied += 1;
                }
                if applied > 0 {
                    fs::write(&target, &content).map_err(|e| format!("cannot write file: {e}"))?;
                }
                let suffix = hint.unwrap_or_default();
                if failures.is_empty() {
                    return Ok(format!(
                        "Successfully edited {path} ({} edits applied).{}",
                        edits.len(),
                        post_edit_diagnostics(root, &path, permit)
                    ));
                }
                if applied == 0 {
                    return Err(format!("no edit applied to {path}. {}{suffix}", failures.join("; ")));
                }
                return Ok(format!(
                    "PARTIAL edit of {path}: {applied}/{} edits were applied and WRITTEN; {} failed and were NOT applied — send ONLY the failed one(s) next, copying the text as it is in the file AFTER these edits: {}{suffix}{}",
                    edits.len(),
                    failures.len(),
                    failures.join("; "),
                    post_edit_diagnostics(root, &path, permit)
                ));
            }
            let edit = edit_file(
                root,
                &path,
                &s("old_string"),
                &s("new_string"),
                args["replace_all"].as_bool().unwrap_or(false),
                permit,
            )?;
            Ok(format!("{edit}{}", post_edit_diagnostics(root, &path, permit)))
        }
        "run_terminal" => {
            let requested = args["timeout"].as_u64().unwrap_or(120);
            // Validation at the boundary: the MODEL picks this number via the
            // schema, and an unclamped large value pinned a worker for the
            // whole of it (a scheduled monitor call ran 90 minutes with the
            // run row parked on "running" and not one line in rust.log).
            // Long jobs belong in `background=true` terminals, so anything
            // past the ceiling is CLAMPED, not failed.
            let timeout = requested.min(ceiling);
            if timeout != requested {
                eprintln!(
                    "[tool] run_terminal: requested timeout {requested}s exceeds the {ceiling}s \
ceiling; clamped to {timeout}s (long jobs must use background=true)"
                );
            }
            // The ceiling is passed through explicitly so the inner clamp
            // cannot re-open a smaller bound than the one this dispatch chose.
            // A `commands` ARRAY runs several commands IN ORDER in this one
            // call, one result block each: the traced turns spent SIX model
            // rounds on six inspection commands (every round re-sending the
            // whole conversation), because the model answers with exactly one
            // tool call per reply. Batching lives in the TOOL, not in a hint.
            let batch: Vec<String> = args["commands"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|c| !c.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if batch.len() > 1 || (batch.len() == 1 && s("command").trim().is_empty()) {
                let mut out = String::new();
                for (i, cmd) in batch.iter().enumerate() {
                    if i > 0 {
                        out.push('\n');
                    }
                    out.push_str(&format!("$ {cmd}\n"));
                    match run_terminal_bounded_with(root, cmd, timeout, ceiling, on_tail) {
                        Ok(res) => out.push_str(&res),
                        Err(e) => {
                            out.push_str(&format!("(failed: {e})\n"));
                            break;
                        }
                    }
                }
                return Ok(out);
            }
            run_terminal_bounded_with(root, &s("command"), timeout, ceiling, on_tail)
        }
        "current_time" => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            Ok(json!({ "unix_ms": now.as_millis() as u64 }).to_string())
        }
        // Activity Monitor for the agent: per-process RSS/CPU so it can
        // diagnose memory/CPU issues itself (read-only, all modes).
        "system_stats" => system_stats(&s("filter"), args["top"].as_u64().unwrap_or(15) as usize),
        // LSP-backed tools (phase 3-3 parity with tools.py) — served by the
        // native stdio JSON-RPC client in lsp.rs.
        // The schemas advertise `symbol=` (the model rarely knows line/column);
        // it used to be ignored, so position defaulted to 1:0 and every call
        // answered "No definition found". Resolve the symbol to a real position;
        // an explicit `line` is kept as a disambiguation hint.
        "lsp_definition" | "lsp_references" | "lsp_hover" => {
            let file = s("filePath");
            let symbol = s("symbol");
            let (line, character) = if !symbol.trim().is_empty() {
                crate::lsp::locate_symbol(root, &file, symbol.trim(), args["line"].as_i64(), permit)?
            } else if let Some(line) = args["line"].as_i64() {
                (line, args["character"].as_i64().unwrap_or(0))
            } else {
                return Err("pass filePath + symbol=<identifier> (preferred), or filePath + line + character".into());
            };
            match name {
                "lsp_definition" => {
                    if !crate::lsp::is_warm(root, &file, permit) {
                        return find_symbol_in(Path::new(root), symbol.trim(), &file, "", permit);
                    }
                    crate::lsp::definition(root, &file, line, character, permit)
                }
                "lsp_references" => {
                    if !crate::lsp::is_warm(root, &file, permit) {
                        return find_symbol_in(Path::new(root), symbol.trim(), &file, "", permit);
                    }
                    crate::lsp::references(root, &file, line, character, permit)
                }
                _ => {
                    // A hover with no warm server would cold-start rust-analyzer
                    // for one tooltip. Answer with the definition body instead:
                    // the same information, instantly, no index.
                    if !crate::lsp::is_warm(root, &file, permit) {
                        return find_symbol_in(Path::new(root), symbol.trim(), &file, "", permit);
                    }
                    crate::lsp::hover(root, &file, line, character, permit)
                }
            }
        }
        // Outline a file WITHOUT paying a cold language server: the native
        // outline answers instantly for every language, and a warm server gives
        // the exact LSP symbols. Only when neither exists does this start one
        // (see `lsp::symbols`), because that is the case a cheap outline cannot
        // cover — exact kinds and ranges from a real index.
        "lsp_symbols" => {
            let file = s("filePath");
            if let Some(found) = crate::lsp::symbols_if_warm(root, &file, &s("query"), permit) {
                return Ok(found);
            }
            match resolve_safe(root, &file, false, permit) {
                Ok(abs) if abs.is_file() => tools_outline(&abs, &s("query")),
                // A directory is a legitimate thing to name — the model has the
                // path but not a file in it. Refusing cost a whole round (traced
                // as `lsp_symbols "src"` → "outlines ONE file — src is a
                // directory") when the answer it wanted, that folder's entries,
                // was one read away. Answer it here instead, and name the one
                // call that DOES outline a file so the next round is exact.
                Ok(abs) if abs.is_dir() => {
                    let listing = list_dir(&abs, DEFAULT_READ_OFFSET, DEFAULT_READ_LIMIT)?;
                    let files: Vec<&str> = listing
                        .lines()
                        .filter(|e| !e.ends_with('/') && !e.starts_with('('))
                        .take(3)
                        .collect();
                    let named = if files.is_empty() {
                        "none of its entries is a file".to_string()
                    } else {
                        format!("pick one (`{}`) and call lsp_symbols on it", files.join("`, `"))
                    };
                    Ok(format!(
                        "{file}/ is a DIRECTORY — lsp_symbols outlines ONE file, so here are its \
                         entries instead:\n{listing}\n\n{named}, or pass a `query` with a glob-shaped \
                         `path` to `grep`."
                    ))
                }
                Ok(_) => crate::lsp::symbols(root, &file, &s("query"), permit),
                Err(e) => Err(e),
            }
        }
        "lsp_diagnostics" => crate::lsp::diagnostics(root, &s("filePath"), permit),
        // Native memory store (JSONL layer of memory_manager.py).
        "delete_memory" => {
            // Accept both spellings: the schema advertises `memory_id`, but a
            // model copying an id out of a search result often writes `id`.
            let mid = {
                let m = s("memory_id");
                if m.is_empty() { s("id") } else { m }
            };
            let mid = mid.trim();
            if mid.is_empty() {
                return Err("delete_memory requires memory_id (the id from search_memory)".into());
            }
            Ok(if crate::memory::delete(mid) {
                format!("deleted memory {mid}")
            } else {
                format!("no memory with id {mid}")
            })
        }
        "save_memory" => {
            let t = s("memory_type");
            let mtype: &str = if t.is_empty() { "long_term" } else { &t };
            let rec = crate::memory::add(&s("content"), mtype, root);
            Ok(rec.to_string())
        }
        "search_memory" => {
            let limit = args["max_results"].as_u64().unwrap_or(15) as usize;
            let hits = crate::memory::search(&s("query"), root, limit);
            if hits.is_empty() {
                Ok("no matching memories".into())
            } else {
                Ok(serde_json::to_string(&hits).unwrap_or_else(|_| "[]".into()))
            }
        }
        // Create or update a skill from a command (the Codex/Claude
        // `create_skill` flow). `fa_keywords` is what makes the skill findable
        // from a Persian request: the catalog line carries them, so the model
        // can match the user's own wording without any embedding or classifier.
        "create_skill" => {
            // A repo is an alternative SOURCE for the whole skill: read it first,
            // then hand it to `sync_skill` exactly like a model-written body, so
            // the frontmatter, slug and extra-file rules stay in one place
            // (the same trick `plugins::apply_parts` uses).
            let repo_spec = args["repo"].as_str().unwrap_or("").trim().to_string();
            let from_repo = if repo_spec.is_empty() {
                None
            } else {
                Some(crate::repo::read_skill(
                    &repo_spec,
                    args["repo_path"].as_str().unwrap_or(""),
                    args["repo_ref"].as_str().unwrap_or(""),
                    &s("name"),
                )?)
            };
            let name = if !s("name").trim().is_empty() {
                s("name")
            } else {
                from_repo
                    .as_ref()
                    .and_then(|r| r["name"].as_str())
                    .unwrap_or("")
                    .to_string()
            };
            if name.trim().is_empty() {
                return Err("create_skill requires name (or a repo that names the skill)".into());
            }
            // An empty body is allowed on purpose: `sync_skill` keeps the
            // stored body when one exists and fails only when a NEW skill would
            // be written with nothing in it. A delete, a rename, or a call that
            // only touches an extra file must not have to resend the whole
            // markdown — the old guard rejected exactly those calls.
            let mut content = s("content");
            if content.trim().is_empty() {
                if let Some(r) = &from_repo {
                    content = r["content"].as_str().unwrap_or("").to_string();
                }
            }
            let mut body = json!({
                "name": name,
                "previous_name": s("previous_name"),
                "content": content,
                // Pass the raw JSON through (not `s(...)`, which turns a
                // missing field into ""): `sync_skill` treats null/absent as
                // "keep whatever the file already has", so a model that omits
                // fa_keywords on an EDIT no longer wipes the existing ones.
                "description": args["description"].clone(),
                "fa_keywords": args["fa_keywords"].clone(),
            });
            if let Some(r) = &from_repo {
                // The repo fills only what the call left out.
                for key in ["description", "fa_keywords"] {
                    if body[key].is_null() {
                        body[key] = r[key].clone();
                    }
                }
                if let Some(files) = r["extra_files"].as_object() {
                    if !files.is_empty() {
                        body["extra_files"] = json!(files);
                    }
                }
            }
            if args["delete"].as_bool().unwrap_or(false) {
                body["delete"] = json!(true);
            }
            if let Some(extra) = args["extra_files"].as_object() {
                // Explicit files win over the ones that came with the repo.
                let mut merged = body["extra_files"].as_object().cloned().unwrap_or_default();
                for (k, v) in extra {
                    merged.insert(k.clone(), v.clone());
                }
                body["extra_files"] = json!(merged);
            }
            if let Some(del) = args["deleted_files"].as_array() {
                body["deleted_files"] = json!(del);
            }
            // A delete is answered by the bundle writer: the skill's folder is
            // removed, and a bundle that held ONLY that skill goes with it.
            if body["delete"].as_bool().unwrap_or(false) {
                return crate::plugins::delete_bundle_skill(Path::new(store_base), &name)
                    .map(|_| format!("Skill deleted: {name}"));
            }
            let res = crate::plugins::save_bundle_skill(Path::new(store_base), body.clone())?;
            let name_out = body["name"].as_str().unwrap_or(&name).to_string();
            // A skill the model just wrote is the USER's text: mark it so the
            // startup seeder cannot revert it behind their back.
            if let Some(dir) = crate::plugins::skill_dir_for(Path::new(store_base), &name_out) {
                crate::skills::mark_user_edit(&dir);
            }
            Ok(format!(
                "Skill saved: {name_out} (bundle: {})\nThe catalog in the system prompt now lists \
                 it, so it can be loaded on demand in later turns.",
                res["slug"].as_str().unwrap_or("")
            ))
        }
        // Create or update an MCP connector from a command (`/plugin create`
        // with a connector part). A connector is either a stdio server (command + args) or an
        // HTTP one (url), so both shapes are accepted and stored verbatim.
        // Editing an existing connector works two ways: pass the SAME name to
        // overwrite it in place, or pass previous_name to rename it (the old
        // file is removed so no stale duplicate is left behind).
        "create_mcp" => {
            let name = s("name");
            if name.trim().is_empty() {
                return Err("create_mcp requires name".into());
            }
            let mut cfg = serde_json::Map::new();
            let command = s("command");
            let url = s("url");
            if !command.trim().is_empty() {
                cfg.insert("command".into(), json!(command));
                if let Some(args) = args["args"].as_array() {
                    cfg.insert("args".into(), json!(args));
                }
            } else if !url.trim().is_empty() {
                cfg.insert("url".into(), json!(url));
            } else {
                return Err("create_mcp requires either command (stdio) or url (http)".into());
            }
            if let Some(env) = args["env"].as_object() {
                cfg.insert("env".into(), json!(env));
            }
            let prev = s("previous_name");
            let res = crate::plugins::save_bundle_connector(
                Path::new(store_base),
                &json!({"name": name, "previous_name": prev, "cfg": Value::Object(cfg)}),
            )?;
            Ok(format!(
                "Connector saved: {} (bundle: {})\nIt reaches the agent while that bundle is on.",
                name,
                res["slug"].as_str().unwrap_or("")
            ))
        }
        // Plugins: one folder bundling skills + MCP connectors behind a single
        // on/off switch (see plugins.rs for the layout). Kept as ONE tool with
        // an `action` multiplexer so the catalog stays short.
        "plugin" => {
            let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            let store = Path::new(store_base);
            match action.as_str() {
                // Compact by default: one line per bundle. One bundle's full
                // manifest is a `slug` away — a model that asked "what plugins
                // exist" should not pay every bundle's whole manifest for it.
                "list" => {
                    let slug = args["slug"].as_str().map(str::trim).unwrap_or_default();
                    if slug.is_empty() {
                        Ok(crate::plugins::list_plugins_summary(store))
                    } else {
                        crate::plugins::plugin_detail(store, slug).map(|v| v.to_string())
                    }
                }
                "install" => crate::plugins::install_plugin(store, args).map(|v| {
                    let detached = plugin_detached_path_warning(store, &v["plugin"]);
                    format!("{v}{detached}")
                }),
                // Creating and updating a bundle writes skills exactly like an
                // install does, so both say the same thing when they land bare.
                "create" => crate::plugins::create_plugin(store, args).map(|v| {
                    let detached = plugin_detached_path_warning(store, &v);
                    format!("{v}{detached}")
                }),
                "update" => crate::plugins::update_plugin(store, args).map(|v| {
                    let detached = plugin_detached_path_warning(store, &v);
                    format!("{v}{detached}")
                }),
                "toggle" => crate::plugins::toggle_plugin(store, args).map(|v| {
                    let on = v["enabled"].as_bool().unwrap_or(false);
                    format!("{}\n{}", if on { "Plugin enabled" } else { "Plugin disabled" }, v)
                }),
                "delete" => crate::plugins::delete_plugin(store, args).map(|v| v.to_string()),
                // The script's own window is decided by the plugin layer alone:
                // no plugin default and no caller ceiling, so a paid script is
                // never cut off mid-flight.
                "run" => crate::plugins::run_plugin_script(store, args).map(|v| v.to_string()),
                other => Err(format!(
                    "plugin requires action one of list/install/create/update/toggle/delete/run \
                     (got {other:?})"
                )),
            }
        }
        // Schedules as data: the agent writes the task, the Schedule page only
        // displays it. A task carries its own skills/connectors so a headless
        // run gets the same context as a normal turn.
        "schedule" => {
            let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            let store_base_sched = data_root.ok_or("schedule needs a data root")?;
            let store = Path::new(store_base_sched);
            match action.as_str() {
                "list" => Ok(crate::appstate::list_schedules(store).to_string()),
                "create" | "update" => {
                    let id = s("id");
                    let existing: Option<Value> = if action == "create" {
                        None
                    } else {
                        if id.trim().is_empty() {
                            return Err("update requires the schedule id".into());
                        }
                        match crate::appstate::get_schedule(store, &id) {
                            Some(t) => Some(t),
                            None => return Err(format!("schedule not found: {id}")),
                        }
                    };
                    let mut task = existing.unwrap_or_else(|| json!({}));
                    let obj = task.as_object_mut().expect("task starts as an object");
                    for key in ["name", "prompt", "mode"] {
                        if let Some(v) = args[key].as_str() {
                            if !v.trim().is_empty() {
                                obj.insert(key.into(), json!(v));
                            }
                        }
                    }
                    let root_arg = args["root"].as_str().unwrap_or("").trim();
                    if !root_arg.is_empty() {
                        obj.insert("root".into(), json!(root_arg));
                    } else if action == "create" {
                        obj.insert("root".into(), json!(root));
                    }
                    if let Some(cron) = args["cron"].as_str() {
                        if !cron.trim().is_empty() && !crate::scheduler::is_valid_cron(cron) {
                            return Err(format!("invalid cron expression: {cron}"));
                        }
                        obj.insert("cron".into(), json!(cron.trim()));
                    }
                    if let Some(on) = args["enabled"].as_bool() {
                        obj.insert("enabled".into(), json!(on));
                    }
                    // Opt-in browser access for every run of this task: the
                    // turn drives the shared Chromium and profile (its saved
                    // logins included) while nobody watches — a deliberate,
                    // per-task choice, never a default.
                    if let Some(on) = args["allow_browser"].as_bool() {
                        obj.insert("allow_browser".into(), json!(on));
                    }
                    // The run context is a list of plugin slugs: their skills,
                    // scripts and connectors are expanded at run time (see
                    // scheduler::execute_schedule). Legacy `skills`/`mcp_servers`
                    // fields are still READ by the scheduler for old tasks, but
                    // new tool calls cannot write them.
                    if let Some(list) = args["plugins"].as_array() {
                        obj.insert("plugins".into(), json!(list));
                    }
                    let saved = crate::appstate::save_schedule(store, task)?;
                    Ok(format!("Schedule saved:\n{saved}"))
                }
                "toggle" => {
                    let id = s("id");
                    let Some(mut task) = crate::appstate::get_schedule(store, &id) else {
                        return Err(format!("schedule not found: {id}"));
                    };
                    let on = args["enabled"]
                        .as_bool()
                        .unwrap_or_else(|| !task["enabled"].as_bool().unwrap_or(true));
                    task["enabled"] = json!(on);
                    let saved = crate::appstate::save_schedule(store, task)?;
                    Ok(format!(
                        "Schedule {}:\n{saved}",
                        if on { "resumed" } else { "paused" }
                    ))
                }
                "delete" => {
                    let id = s("id");
                    if id.trim().is_empty() {
                        return Err("delete requires the schedule id".into());
                    }
                    crate::appstate::delete_schedule(store, &id);
                    Ok(format!("Schedule deleted: {id}"))
                }
                other => Err(format!(
                    "schedule requires action one of list/create/update/toggle/delete (got {other:?})"
                )),
            }
        }
        // Load one stored skill's body on demand: the prompt lists only a slice
        // of the installed skills, so a body costs one tool call instead of
        // carrying all of them in the prompt. `file` reads an extra file of it;
        // `query` searches the WHOLE store, which is what keeps a store with
        // hundreds of skills reachable from a prompt that cannot list them.
        "load_skill" => {
            // ONE call, SEVERAL skills: `names=[...]` returns every body
            // together, labeled — the whole skill set the task needs costs ONE
            // round-trip instead of one per skill. Resolution is the same as
            // the single form (name or slug, case-insensitive); a name that
            // matches nothing is listed at the end instead of failing the
            // batch, so one typo cannot lose the bodies that did resolve.
            let names_list: Vec<String> = args["names"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|n| !n.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if !names_list.is_empty() {
                let all = crate::skill_router::load_skills(store_base);
                let resolve = |wanted: &str| {
                    all.iter().find(|sk| {
                        let n = sk["name"].as_str().unwrap_or_default().trim().to_lowercase();
                        let slug = sk["slug"].as_str().unwrap_or_default().trim().to_lowercase();
                        n == wanted.to_lowercase() || slug == wanted.to_lowercase()
                    })
                };
                let mut out = String::new();
                let mut missing: Vec<String> = Vec::new();
                for wanted in &names_list {
                    match resolve(wanted) {
                        Some(sk) => out.push_str(&skill_body(sk)),
                        None => missing.push(wanted.clone()),
                    }
                }
                if !missing.is_empty() {
                    out.push_str(&format!(
                        "not found: {} — Available: {}",
                        missing.join(", "),
                        available_hint(&all)
                    ));
                }
                return Ok(out);
            }
            let name = s("name");
            if name.trim().is_empty() {
                // bundle=<slug> drills into one plugin bundle: the catalog cap
                // can leave a whole bundle unnamed, and this is how its skills
                // stay reachable. Checked before `query` so a call carrying
                // both does the cheaper, more specific thing.
                let bundle = s("bundle");
                if !bundle.trim().is_empty() {
                    return list_bundle_skills(store_base, bundle.trim());
                }
                let query = s("query");
                if query.trim().is_empty() {
                    return Err(
                        "load_skill requires name, or query to search the installed skills".into(),
                    );
                }
                return search_skills(store_base, &query);
            }
            let file = s("file");
            if !file.trim().is_empty() {
                // A skill lives either in the standalone store or inside an
                // ENABLED plugin folder, and only this branch needs the plugin
                // dir — so it is resolved here instead of on every call.
                let store = Path::new(store_base);
                let plugin_dir = crate::plugins::plugin_of_skill(store, &name)
                    .and_then(|slug| crate::plugins::find_skill_dir(store, &slug, &name));
                let read = match &plugin_dir {
                    Some(dir) => crate::skills::read_extra_file(dir, &name, &file),
                    None => crate::skills::read_skill_file(store, &name, &file),
                };
                return Ok(read?["content"].as_str().unwrap_or_default().to_string());
            }
            // Same list the catalog is built from (`skill_router::load_skills`),
            // so the NOT-FOUND hint names exactly what the model was shown.
            let all = crate::skill_router::load_skills(store_base);
            let wanted = name.trim().to_lowercase();
            let hit = all.iter().find(|sk| {
                let n = sk["name"].as_str().unwrap_or_default().trim().to_lowercase();
                let slug = sk["slug"].as_str().unwrap_or_default().trim().to_lowercase();
                n == wanted || slug == wanted
            });
            match hit {
                Some(sk) => Ok(skill_body(sk)),
                None => Err(format!(
                    "skill not found: {name}. Available: {}",
                    available_hint(&all)
                )),
            }
        }
        // The ROUND-ELIMINATION executor: ONE call carries up to `BATCH_MAX_OPS`
        // tool calls, run IN ORDER, every sub-result the FULL output of the same
        // tool (nothing reduced), labeled per op. A whole step — the lookups,
        // the edits, the verification command — costs ONE round-trip instead of
        // one per call; a wave that needs a result it does not have yet waits
        // for the model's next round. Ops the TURN may not run are pre-marked
        // `refused` by the loop's caps gate (the only place caps live) and come
        // back as inline refusals without executing.
        "batch" => {
            let ops = args["ops"]
                .as_array()
                .ok_or("batch needs ops: [{tool, args}]")?;
            if ops.is_empty() {
                return Err("batch: ops is empty".into());
            }
            if ops.len() > BATCH_MAX_OPS {
                return Err(format!(
                    "batch: {} ops exceed the {BATCH_MAX_OPS} cap — split into two batches",
                    ops.len()
                ));
            }
            let mut out = String::new();
            for (i, op) in ops.iter().enumerate() {
                let tool = op["tool"].as_str().unwrap_or_default().trim().to_string();
                let label = format!("[{}/{}] {}", i + 1, ops.len(), tool);
                if let Some(reason) = op["refused"].as_str() {
                    out.push_str(&format!("\n=== {label} → REFUSED ===\n{reason}\n"));
                    continue;
                }
                if tool == "batch" {
                    out.push_str(&format!(
                        "\n=== {label} → REFUSED ===\nnested batch is not allowed — one level only\n"
                    ));
                    continue;
                }
                if !BATCH_TOOLS.contains(&tool.as_str()) {
                    out.push_str(&format!(
                        "\n=== {label} → REFUSED ===\n{tool:?} is not a batch tool. Batchable: {}\n",
                        BATCH_TOOLS.join(", ")
                    ));
                    continue;
                }
                let sub_args = op.get("args").cloned().unwrap_or_else(|| json!({}));
                out.push_str(&format!("\n=== {label} ===\n"));
                // Same-depth recursion through the WITH variant so a terminal
                // op's output still streams live through `on_tail`.
                match dispatch_bounded_with(root, &tool, &sub_args, permit, data_root, on_tail) {
                    Ok(r) => out.push_str(&r),
                    Err(e) => out.push_str(&format!("ERROR: {e}")),
                }
            }
            Ok(out)
        }
        _ => Err(format!("tool {name:?} is not available")),
    }
}

/// Batchable tools for the `batch` executor — the read-only search family plus
/// the writers and the terminal, so a WHOLE step (lookups → edits → verify)
/// rides one round-trip. `load_skill` and the delegation tools stay out: their
/// results are turn-shaping decisions the model should make on its own round.
pub(super) const BATCH_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "find_symbol",
    "lsp_symbols",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_diagnostics",
    "run_terminal",
    "edit_file",
    "write_file",
    "current_time",
    "system_stats",
];

/// How many tool calls ONE batch may carry. 10-call steps fit; the cap keeps
/// a single result from growing unbounded (each sub-result keeps its own
/// tool's normal cap).
pub(super) const BATCH_MAX_OPS: usize = 10;

/// Activity Monitor for the agent: per-process RSS/CPU via `ps` (read-only,
/// available in every mode so the agent can diagnose memory/CPU issues).
pub(super) fn system_stats(filter: &str, top: usize) -> Result<String, String> {
    let out = std::process::Command::new("ps")
        .args(["-axo", "rss,pcpu,comm"])
        .output()
        .map_err(|e| format!("ps failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("ps exited with {}", out.status));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows: Vec<(f64, f64, String)> = Vec::new();
    for line in text.lines().skip(1) {
        let mut it = line.split_whitespace();
        let (Some(rss), Some(cpu)) = (it.next(), it.next()) else { continue };
        let comm = it.collect::<Vec<_>>().join(" ");
        let rss_mb: f64 = rss.parse().unwrap_or(0.0);
        let cpu: f64 = cpu.parse().unwrap_or(0.0);
        let f = filter.to_lowercase();
        if !f.is_empty() && !comm.to_lowercase().contains(&f) {
            continue;
        }
        rows.push((rss_mb / 1024.0, cpu, comm));
    }
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = rows.iter().map(|r| r.0).sum();
    let mut s = format!("total RSS of listed processes: {total:.0} MB\n");
    for (rss, cpu, comm) in rows.iter().take(top.max(1)) {
        s.push_str(&format!("{rss:8.0} MB  {cpu:5.1}%  {comm}\n"));
    }
    Ok(s)
}

// ---------------------------------------------------------------------------
// find_symbol: definition + body + usages of an identifier in ONE call
// ---------------------------------------------------------------------------

