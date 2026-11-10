    use super::*;

    #[test]
    fn plugin_list_answers_one_line_per_bundle_and_slug_drills_in() {
        // "what plugins exist" used to pay every bundle's whole manifest
        // (manifest + keywords + commands + agents + hooks + dir) as JSON. The
        // compact list is one line per bundle; the full manifest of ONE bundle
        // is a `slug` away.
        let root = std::env::temp_dir().join(format!("codifa-plugin-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let base = root.to_str().unwrap();
        for (name, on) in [("Trade Bundle", true), ("Docs Bundle", false)] {
            dispatch_with_data_root(
                base,
                "plugin",
                &json!({
                    "action": "create",
                    "name": name,
                    "description": "fixture bundle",
                    "enabled": on,
                    "skills": [{"name": format!("{name} Skill"), "content": "BODY"}],
                    "scripts": [{"name": "run-me", "content": "fn main() {}"}]
                }),
                None,
                Some(base),
            )
            .unwrap();
        }
        let listed =
            dispatch_with_data_root(base, "plugin", &json!({"action": "list"}), None, Some(base))
                .unwrap();
        let lines: Vec<&str> = listed.lines().filter(|l| l.starts_with("- ")).collect();
        assert_eq!(lines.len(), 2, "{listed}");
        let trade = lines.iter().find(|l| l.contains("trade-bundle")).unwrap();
        assert!(trade.contains("[on]"), "{trade}");
        assert!(trade.contains("1 skill(s)"), "{trade}");
        assert!(trade.contains("connectors: none"), "{trade}");
        assert!(trade.contains("scripts: run-me"), "{trade}");
        assert!(lines.iter().any(|l| l.contains("[off]")), "{listed}");
        // No manifest noise rides on the compact line.
        assert!(!listed.contains("created_at"), "{listed}");
        assert!(!listed.contains("BODY"), "{listed}");

        // The drill-in: one bundle's FULL manifest, still machine-readable.
        let detail = dispatch_with_data_root(
            base,
            "plugin",
            &json!({"action": "list", "slug": "trade-bundle"}),
            None,
            Some(base),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(detail.trim()).expect("detail is JSON");
        assert_eq!(parsed["slug"], json!("trade-bundle"));
        assert_eq!(parsed["scripts"][0], json!("run-me"));
        // Unknown slug: a plain error naming the way out.
        let err = dispatch_with_data_root(
            base,
            "plugin",
            &json!({"action": "list", "slug": "ghost"}),
            None,
            Some(base),
        )
        .unwrap_err();
        assert!(err.contains("not found") && err.contains("action=list"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }


    #[test]
    fn batch_runs_every_op_in_order_with_full_results() {
        // The round-elimination executor: a whole step (read + grep + write +
        // terminal) in ONE dispatch, each sub-result the FULL output of the
        // same tool, labeled per op, run in order.
        let root = std::env::temp_dir().join(format!("codifa-batch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "hello todo list").unwrap();
        let base = root.to_str().unwrap();
        let out = dispatch_with_data_root(
            base,
            "batch",
            &json!({"ops": [
                {"tool": "read", "args": {"filePath": "a.txt"}},
                {"tool": "grep", "args": {"pattern": "todo", "path": ".", "include": "*.txt"}},
                {"tool": "write_file", "args": {"path": "new.txt", "content": "written by batch"}},
                {"tool": "run_terminal", "args": {"command": "echo batch-terminal-ok"}},
            ]}),
            None,
            Some(base),
        )
        .unwrap();
        assert!(out.contains("[1/4] read"), "{out}");
        assert!(out.contains("[2/4] grep"), "{out}");
        assert!(out.contains("[3/4] write_file"), "{out}");
        assert!(out.contains("[4/4] run_terminal"), "{out}");
        assert!(out.contains("hello todo list"), "read sub-result carries the file: {out}");
        assert!(out.contains("batch-terminal-ok"), "terminal sub-result ran: {out}");
        // The write HAPPENED (in-order execution the later ops could see).
        assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "written by batch");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn batch_resolves_a_foreign_tool_name_instead_of_refusing_the_round() {
        // A top-level call is alias-resolved at the turn's call boundary, but an
        // op inside a batch skipped that step — so the model's habitual
        // `{"tool":"run_command"}` was refused here while the SAME name worked
        // one level up. Traced (`mwab8nku`): 14 such ops across 4 rounds, each
        // refused round costing a full retry.
        let root = std::env::temp_dir().join(format!("codifa-batch-alias-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let base = root.to_str().unwrap();
        let args = json!({
            "ops": [
                {"tool": "run_command", "args": {"command": "echo hello-alias"}},
                {"tool": "shell", "args": {"command": "echo second-alias"}}
            ]
        });
        let out = dispatch_bounded(base, "batch", &args, None, None).unwrap();
        assert!(!out.contains("is not a batch tool"), "both names must resolve: {out}");
        assert!(out.contains("hello-alias"), "the resolved command really ran: {out}");
        assert!(out.contains("second-alias"), "and so did the second one: {out}");
        let _ = fs::remove_dir_all(&root);
    }

    /// A stringified `ops` array is a REAL batch, not a malformed one.
    ///
    /// Several providers double-encode nested JSON: the model means an array but
    /// the wire carries it as a string. Traced (`mwam7hcn`, `mwanphb7`): 11 such
    /// calls were refused with "batch needs ops" while the ops inside were valid,
    /// and every refusal burned the whole round (~26K prompt tokens) on a retry.
    #[test]
    fn batch_accepts_a_stringified_ops_array_instead_of_burning_the_round() {
        let root = std::env::temp_dir().join(format!("codifa-batch-strops-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let base = root.to_str().unwrap();
        let inner = json!([
            {"tool": "run_terminal", "args": {"command": "echo from-string-ops"}},
            {"tool": "read", "args": {"filePath": "missing-string-ops.txt"}}
        ])
        .to_string();
        let out = dispatch_bounded(base, "batch", &json!({"ops": inner}), None, None).unwrap();
        assert!(!out.contains("ops must be"), "the string form is parsed, not refused: {out}");
        assert!(out.contains("from-string-ops"), "the op really ran: {out}");
        assert!(out.contains("[1/2]") && out.contains("[2/2]"), "both ops kept: {out}");
        let _ = fs::remove_dir_all(&root);
    }

    /// The tolerant reader is shared with the caps gate, so a shape the gate
    /// could not see is exactly the shape that used to bypass mode caps.
    #[test]
    fn batch_ops_reads_every_shape_the_model_emits() {
        // Array form.
        let a = batch_ops(&json!({"ops": [{"tool": "read", "args": {}}]})).unwrap();
        assert_eq!(a.len(), 1);
        // Stringified array.
        let s = batch_ops(&json!({"ops": "[{\"tool\":\"read\",\"args\":{}}]"})).unwrap();
        assert_eq!(s.len(), 1);
        // Fenced stringified array (a model that thinks in prose).
        let f = batch_ops(&json!({"ops": "```json\n[{\"tool\":\"read\",\"args\":{}}]\n```"}))
            .unwrap();
        assert_eq!(f.len(), 1);
        // An op that is itself a stringified object.
        let o = batch_ops(&json!({"ops": ["{\"tool\":\"read\",\"args\":{}}"]})).unwrap();
        assert_eq!(o[0]["tool"].as_str(), Some("read"));
        // Everything unusable collapses into ONE actionable message.
        for bad in [json!({}), json!({"ops": []}), json!({"ops": "not json"}), json!({"ops": [1, 2]})] {
            let err = batch_ops(&bad).unwrap_err();
            assert!(err.contains("ops"), "{err}");
            assert!(err.contains("non-empty") || err.contains("NON-empty"), "actionable: {err}");
        }
    }

    #[test]
    fn batch_refuses_nested_unknown_and_over_cap_ops_without_dying() {
        let root = std::env::temp_dir().join(format!("codifa-batch-guard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let base = root.to_str().unwrap();
        // A failing op comes back as an inline ERROR; the rest still run.
        let out = dispatch_with_data_root(
            base,
            "batch",
            &json!({"ops": [
                {"tool": "read", "args": {"filePath": "missing.txt"}},
                {"tool": "batch", "args": {"ops": []}},
                {"tool": "teleport", "args": {}},
            ]}),
            None,
            Some(base),
        )
        .unwrap();
        assert!(out.contains("ERROR:"), "the failed read is inline: {out}");
        assert!(out.contains("nested batch is not allowed"), "{out}");
        assert!(out.contains("is not a batch tool"), "{out}");        // Over the op cap: a plain error naming the cap.
        let mut ops = Vec::new();
        for _ in 0..11 {
            ops.push(json!({"tool": "current_time", "args": {}}));
        }
        let err = dispatch_with_data_root(base, "batch", &json!({"ops": ops}), None, Some(base))
            .unwrap_err();
        assert!(err.contains("exceed the 10 cap"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn terminal_timeout_is_clamped_to_the_ceiling() {
        // The MODEL picks `timeout` via the schema; a monitor-style prompt once
        // sent 5400 and the foreground call sat on it for 90 minutes with the
        // run row parked on "running". The clamp (not the model) decides.
        assert_eq!(
            run_terminal("/tmp", "echo ok", MAX_TERMINAL_TIMEOUT_SECS + 3_600)
                .unwrap()
                .trim(),
            "ok"
        );
    }

    /// A plugin write answers machine-readable JSON: one line, parseable, with
    /// no trailing prose attached (the old keyword warning appended a WARNING
    /// line after the JSON — keyword routing is gone, and with it that line).
    #[test]
    fn every_plugin_write_answers_plain_json() {
        let root = std::env::temp_dir().join(format!("codifa-plugin-warn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let base = root.to_str().unwrap();

        let made = dispatch_with_data_root(
            base,
            "plugin",
            &json!({
                "action": "create",
                "name": "Bare Bundle",
                "description": "A bundle with a single skill",
                "skills": [{"name": "Bare Skill", "content": "BODY"}]
            }),
            None,
            Some(base),
        )
        .unwrap();
        assert!(!made.contains("WARNING"), "no keyword warning anymore: {made}");
        assert!(made.contains("Bare Skill"), "the skill must be listed: {made}");
        // The reply stays machine-readable: the JSON comes FIRST.
        let first_line = made.lines().next().unwrap();
        let parsed: Value = serde_json::from_str(first_line).expect("line 1 is still JSON");
        assert_eq!(parsed["slug"], json!("bare-bundle"));

        let _ = fs::remove_dir_all(&root);
    }

    /// A grep result must name the cheaper next step when its own output shows one.
    ///
    /// MEASURED: 53 of 118 main greps were followed by a read of a file the grep
    /// had just listed (18 of them re-fetching a window that already contained a
    /// printed hit line) and 12 rounds were spent on a pattern that matched
    /// nothing. The three cases below are exactly those, and the fourth pins the
    /// silent case so a plain word search never grows a hint it cannot pay for.
    #[test]
    fn grep_appends_a_followup_hint_only_when_it_pays() {
        // A miss: never answer with a re-read of the same file.
        let miss = grep_followup_hint("no_such_token_xyz", "no matches");
        assert!(miss.contains("do not re-read"), "{miss}");

        // Identifier-only patterns are what `find_symbol` takes.
        let ident = grep_followup_hint("TracePanel", "src/a.ts:\n 12: class TracePanel {}\n");
        assert!(ident.contains("find_symbol"), "{ident}");
        let alt = grep_followup_hint("LLM|TOOL|FOLD", "src/a.rs:\n 3: const LLM: u8 = 1;\n");
        assert!(alt.contains("find_symbol"), "{alt}");

        // A regex/word pattern is grep-only: no identifier hint, but a many-file
        // result still points at an outline instead of one read per file.
        let many = "a.rs:\n 1: x\nb.rs:\n 2: x\nc.rs:\n 3: x\nd.rs:\n 4: x\ne.rs:\n 5: x\n";
        let wide = grep_followup_hint("fn\\s+[a-z]+", many);
        assert!(wide.contains("5 files matched"), "{wide}");
        assert!(!wide.contains("plain identifier"), "{wide}");

        // A small scoped result needs no advice at all.
        let quiet = grep_followup_hint("fn\\s+x", "a.rs:\n 1: fn x() {}\n");
        assert!(quiet.is_empty(), "{quiet}");

        // The hint can never outgrow its budget, whatever the pattern looks like.
        let huge: String = (0..400).map(|i| format!("sym{i}|")).collect();
        let clipped = grep_followup_hint(&huge, "a.rs:\n 1: x\n");
        assert!(clipped.chars().count() <= GREP_HINT_MAX + 1, "{}", clipped.chars().count());
    }

    /// An identifier grep must arrive WITH its `find_symbol` answer attached.
    ///
    /// MEASURED: 53 of 118 main greps were followed by a read of a file the grep
    /// had just listed, and 19 patterns were bare identifiers — one `find_symbol`
    /// answers those. Naming the tool in prose was refuted (423 of 863 rounds
    /// carried the hint and the next rounds stayed single-call), so the answer is
    /// fetched IN the grep round. The guards below pin why it stays silent for
    /// everything else: a multi-alternative pattern asks several questions, a
    /// miss is already covered by the miss hint, and a regex is not an identifier.
    #[test]
    fn identifier_grep_carries_the_symbol_answer_in_the_same_round() {
        let tmp = std::env::temp_dir().join("codifa-ident-block-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("a.rs"),
            "pub fn resolve_slot_chain() {}\nfn other() { resolve_slot_chain(); }\n",
        )
        .unwrap();
        let root = tmp.to_str().unwrap();
        let hits = "a.rs:\n 1: pub fn resolve_slot_chain() {}\n";

        // A bare identifier with hits: the block carries definitions AND usages.
        let block = identifier_symbol_block(root, "resolve_slot_chain", hits);
        assert!(block.contains("find_symbol resolve_slot_chain"), "{block}");
        assert!(block.contains("USAGES"), "{block}");

        // A miss is the miss-hint's job — never fetch a symbol twice.
        assert!(identifier_symbol_block(root, "resolve_slot_chain", "no matches").is_empty());
        // Several alternatives ask several questions; only one has a definite answer.
        assert!(identifier_symbol_block(root, "LLM|TOOL", hits).is_empty());
        // A regex/word pattern is grep-only.
        assert!(identifier_symbol_block(root, r"fn\s+x", hits).is_empty());
        // A symbol the workspace does not contain adds nothing.
        assert!(identifier_symbol_block(root, "no_such_symbol_xyz", hits).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// `grep` attaches the outline of the file it just hit, so the follow-up
    /// `read` that walk-the-file round used to cost is already answered.
    ///
    /// MEASURED on trace `mvxsy14e`: 5 of 7 lone `grep` rounds were followed by a
    /// `read`, and the hint naming `find_symbol`/`lsp_symbols` was already on
    /// those results and changed nothing. The block is what has to be there.
    ///
    /// Goes through `dispatch`, not the helper: a helper-only test passes even
    /// with the payload unwired from the grep arm, which is the "test that lies"
    /// shape this guards against.
    #[test]
    fn a_grep_hit_carries_the_outline_of_the_file_it_found() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-grep-outline-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _claim = outline_claim_lock();
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // Larger than READ_OUTLINE_MIN_LINES, or a window IS the outline.
        let mut big = String::from("pub fn first_entry() {}\n");
        for i in 0..READ_OUTLINE_MIN_LINES {
            big.push_str(&format!("fn filler_{i}() {{}}\n"));
        }
        big.push_str("pub fn last_entry() {}\n");
        fs::write(tmp.join("big.rs"), &big).unwrap();
        fs::write(tmp.join("small.rs"), "pub fn only() {}\n").unwrap();
        let root = tmp.to_str().unwrap();
        // `pub fn first` is not a bare identifier, so the symbol lever stays out
        // of this text and only the outline can put `READ_OUTLINE_MARK` there.
        let args = json!({"pattern": "pub fn first", "path": "big.rs"});

        reset_outline_claims();
        let out = dispatch(root, "grep", &args, None).unwrap();
        assert!(out.contains(READ_OUTLINE_MARK), "{out}");
        assert!(out.contains("first_entry"), "{out}");
        assert_eq!(levers_fired("grep", &out), vec!["grep_outline"]);

        // The same file again in the SAME turn is already on the wire.
        let again = dispatch(root, "grep", &args, None).unwrap();
        assert!(!again.contains(READ_OUTLINE_MARK), "{again}");

        // A small file earns no outline: an outline would be pure overhead.
        reset_outline_claims();
        let small = dispatch(root, "grep", &json!({"pattern": "pub fn only", "path": "small.rs"}), None)
            .unwrap();
        assert!(!small.contains(READ_OUTLINE_MARK), "{small}");

        // A miss has no file to outline (the miss hint covers that case).
        reset_outline_claims();
        let miss = dispatch(root, "grep", &json!({"pattern": "zzz_absent_zzz", "path": "big.rs"}), None)
            .unwrap();
        assert!(!miss.contains(READ_OUTLINE_MARK), "{miss}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// The trace flag must name EXACTLY the levers whose payload is in the text.
    ///
    /// The lever was previously judged by the round count alone, and that is how
    /// the textual single-call hint looked effective for eight phases (423 of
    /// 863 rounds carried it and nothing changed). The flag makes "did it fire"
    /// a recorded fact, so it must track the marker, not the tool name.
    #[test]
    fn levers_fired_reads_the_marker_not_the_tool_name() {
        let diag = format!("Successfully edited a.rs (1 edits applied).\n\n{POST_EDIT_DIAGNOSTICS_MARK} a.rs:1:1 error: nope");
        assert_eq!(levers_fired("edit_file", &diag), vec!["post_edit_diagnostics"]);
        // A silent edit (cold server, clean file) must NOT claim the lever.
        assert!(levers_fired("edit_file", "Successfully edited a.rs").is_empty());
        // The stale-source lever: a writer landing on a file read earlier in
        // the same step records it, so the trace can count the loop off
        // `detail.levers` without re-parsing messages.
        let stamped = format!("Successfully edited a.rs{}", POST_EDIT_STALE_NOTE);
        assert_eq!(
            levers_fired("edit_file", &stamped),
            vec!["stale_source_note"]
        );
        assert!(levers_fired("grep", &stamped).is_empty());
        // The marker in the WRONG tool's result is not that tool's lever.
        assert!(levers_fired("read", &diag).is_empty());

        let sym = format!("a.rs:\n 1: fn x() {{}}\n\n{IDENTIFIER_SYMBOL_MARK}x — same round, no extra call]\nUSAGES\n 2: x();");
        assert_eq!(levers_fired("grep", &sym), vec!["identifier_grep_symbol"]);
        // The two read-side levers are counted from their own markers, so the
        // ruler sees "merged N windows" / "already served" as a recorded fact.
        let merged = format!("a.rs (lines 1-400):\n1: x\n{READ_MERGED_MARK}2 overlapping window(s)");
        assert_eq!(levers_fired("read", &merged), vec!["read_windows_merged"]);
        let served = "already returned above — these lines are in your context";
        assert_eq!(levers_fired("read", served), vec!["read_already_served"]);
        // The marker in the WRONG tool's result is not that tool's lever.
        assert!(levers_fired("grep", &merged).is_empty());
        // `find_symbol` in the schema is the MODEL calling it — a different
        // thing from the backend attaching the answer to a grep.
        assert!(levers_fired("grep", "no matches").is_empty());
    }

    /// Post-edit diagnostics must NEVER start a language server.
    ///
    /// A cold `rust-analyzer` (1921 MB, minutes of indexing) would turn a cheap
    /// edit into a stall, so the helper returns silence unless a server is
    /// already warm. This test pins that silence — and the bound, so a server
    /// that lists hundreds of errors cannot blow the edit's own budget.
    #[test]
    fn post_edit_diagnostics_stays_silent_without_a_warm_server() {
        let tmp = std::env::temp_dir().join("codifa-post-edit-diag-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.rs"), "fn a() {}\n").unwrap();
        let root = tmp.to_str().unwrap();

        // No server has ever run for this throwaway project, so this must return
        // the empty string instead of spawning one.
        let quiet = post_edit_diagnostics(root, "a.rs", None);
        assert!(quiet.is_empty(), "{quiet}");
        // An unusable path is silent too — diagnostics are a bonus, not a failure.
        assert!(post_edit_diagnostics(root, "missing.rs", None).is_empty());
        assert!(post_edit_diagnostics(root, "../escape.rs", None).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A failed edit must hand the model the CURRENT text, not just a line number.
    ///
    /// MEASURED: 20 of 25 traced edit failures sent text the file no longer had,
    /// and the bare "old_string not found" left the model to answer with a full
    /// re-read (4 cases) or a re-sent stale batch (median 2 extra rounds per
    /// failure). Both halves are pinned here: a NEAR-EXACT miss comes back as a
    /// numbered window of the real text, and a weaker miss prints NO window —
    /// pointing at one anchored the model to another wrong neighbourhood (the
    /// traced 4-round loop, run=106) and instead names the staleness and the
    /// cheap lookup that finds the current text.
    #[test]
    fn a_missed_edit_shows_the_current_text_window() {
        let content = "fn alpha() {}\n\n    let total = compute_total(items);\n";

        // A drifted copy of line 3: same start, different wording later on.
        let hint = nearest_hint(content, "let total = compute_sum(items);");
        assert!(hint.contains("current text"), "expected a window, got: {hint}");
        assert!(hint.contains("compute_total"), "expected the real text, got: {hint}");
        assert!(hint.contains("3:"), "expected line numbers, got: {hint}");
        assert!(
            hint.contains("do NOT re-read the whole file"),
            "the window must forbid the re-read it replaces, got: {hint}"
        );

        // Whitespace-only drift: the text IS there, so the real line comes back.
        let ws = nearest_hint(content, "        let total = compute_total(items);");
        assert!(
            ws.contains("compute_total") && ws.contains("current text"),
            "expected the current text for a whitespace drift, got: {ws}"
        );

        // The traced loop, re-created: the model's copy carries the real head
        // of the line and invents the rest (4 of 7 words shared = 0.57, under
        // the 0.75 floor). Pointing at that window is what let the model fail
        // the SAME edit 4 rounds in a row — so only the stale-copy guidance
        // may come back, never a window.
        let half = nearest_hint(
            content,
            "let total = compute_total(items) and then log_the_result_with_a_note;",
        );
        assert!(
            half.contains("STALE") && !half.contains("current text"),
            "a half-matching copy must get the stale guidance, not a window, got: {half}"
        );

        // Nothing recognisable in the file: the model's copy is stale, so NO
        // window is printed — pointing at one would anchor it to another wrong
        // neighbourhood (the measured 4-round edit-fail loop). The guidance
        // instead sends the model to the CURRENT text with a cheap lookup.
        let none = nearest_hint(content, "a_completely_unrelated_statement_xyz");
        assert!(
            none.contains("STALE") && none.contains("grep") && none.contains("old_string"),
            "expected stale-copy guidance, got: {none}"
        );
        assert!(
            !none.contains("current text"),
            "no window must be printed below the floor, got: {none}"
        );
    }


    /// delete_memory must remove exactly one note by the id search_memory hands
    /// out, answer a plain miss for an unknown id, and refuse an empty id.
    #[test]
    fn delete_memory_dispatch_removes_one_note() {
        let _guard = crate::memory::tests::DATA_DIR_LOCK.lock();
        let data = std::env::temp_dir().join(format!("codifa-delmem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        fs::create_dir_all(&data).unwrap();
        let project = std::env::temp_dir().join(format!("codifa-delmem-proj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&project);
        fs::create_dir_all(&project).unwrap();
        let prev = std::env::var("CODER_DATA_DIR").ok();
        std::env::set_var("CODER_DATA_DIR", &data);
        let root = project.to_str().unwrap();

        let added = dispatch(root, "save_memory", &json!({"content": "keep this note"}), None).unwrap();
        let id = serde_json::from_str::<Value>(&added).unwrap()["memory"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(dispatch(root, "search_memory", &json!({"query": "note"}), None)
            .unwrap()
            .contains(&id));

        let del = dispatch(root, "delete_memory", &json!({"memory_id": &id}), None).unwrap();
        assert!(del.contains("deleted memory"), "{del}");
        assert_eq!(
            dispatch(root, "search_memory", &json!({"query": "note"}), None).unwrap(),
            "no matching memories"
        );
        // The bare `id` spelling (copied straight from a search hit) works too,
        // and an unknown id is a plain miss rather than an error.
        assert!(dispatch(root, "delete_memory", &json!({"id": "no-such-id"}), None)
            .unwrap()
            .contains("no memory with id"));
        // No id at all is a usage error, never a silent success.
        assert!(dispatch(root, "delete_memory", &json!({}), None).is_err());

        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&project);
    }

    fn find_symbol_fixture() -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-findsym-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::create_dir_all(tmp.join("backend")).unwrap();
        fs::create_dir_all(tmp.join("target")).unwrap();
        fs::write(tmp.join("src/compact.rs"), "// compact_history docs\npub async fn compact_history(\n    a: u8,\n) -> u8\nwhere\n    u8: Copy,\n{\n    let x = 1;\n    x\n}\n\nfn other() {}\n").unwrap();
        fs::write(tmp.join("src/main.rs"), "fn main() {\n    compact_history(1);\n    // سلام compact_history\n}\n").unwrap();
        fs::write(tmp.join("backend/srv.py"), "def compact_history(x):\n    y = x\n    return y\n\ndef other():\n    pass\n").unwrap();
        fs::write(tmp.join("backend/g.go"), "package b\nfunc (s *S) Handle(x int) int {\n\treturn x\n}\n").unwrap();
        fs::write(tmp.join("target/junk.rs"), "fn compact_history() {}\n").unwrap();
        tmp
    }

    #[test]
    fn definition_end_handles_rust_signatures_python_and_one_liners() {
        let rs: Vec<&str> = "pub fn f(\n    a: u8,\n) -> u8\nwhere\n    u8: Copy,\n{\n    a\n}\n\nfn g() {}".lines().collect();
        assert_eq!(definition_end(&rs, 0), 7);
        let py: Vec<&str> = "def f(x):\n    y = 1\n\n    return y\n\ndef g():\n    pass".lines().collect();
        assert_eq!(definition_end(&py, 0), 3);
        let one: Vec<&str> = "const A: u8 = 1;\nconst B: u8 = 2;".lines().collect();
        assert_eq!(definition_end(&one, 0), 0);
    }

    /// The native outline is what makes `lsp_symbols` instant: it must find real
    /// declarations across languages and never report a statement as one.
    #[test]
    fn native_outline_finds_declarations_and_ignores_statements() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-outline-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let rs = tmp.join("a.rs");
        fs::write(
            &rs,
            "//! docs\n\n#[derive(Debug)]\npub struct Store {\n    n: u8,\n}\n\npub(crate) fn load(\n) -> u8 {\n    let n = 1;\n    n\n}\n\nimpl Store {\n    fn new() -> Self { Self { n: 0 } }\n}\n",
        )
        .unwrap();
        let out = native_outline(&rs, "").unwrap();
        assert!(out.contains("pub struct Store"), "{out}");
        assert!(out.contains("pub(crate) fn load"), "{out}");
        assert!(out.contains("fn new()"), "{out}");
        // A binding INSIDE a body is a statement, not a declaration.
        assert!(!out.contains("let n = 1"), "a body statement leaked: {out}");

        // `query` narrows by name, and a miss says so instead of lying.
        assert!(native_outline(&rs, "load").unwrap().contains("load"));
        assert!(!native_outline(&rs, "load").unwrap().contains("struct Store"));

        // TypeScript: export/default/async modifiers are skipped, not reported.
        let ts = tmp.join("a.ts");
        fs::write(&ts, "export default async function run() {}\nexport const VERSION = 1;\nfunction inner() { const x = 1; }\n").unwrap();
        let t = native_outline(&ts, "").unwrap();
        assert!(t.contains("function run()"), "{t}");
        assert!(t.contains("const VERSION"), "{t}");
        // A statement inside a body gets NO ROW of its own: exactly the two
        // declarations — and the `inner` row may still quote `const x` on its
        // own source line, which is not a row of its own.
        let rows = t.lines().filter(|l| l.starts_with(|c: char| c.is_ascii_digit())).count();
        assert_eq!(rows, 3, "only declarations get rows: {t}");

        fs::remove_dir_all(&tmp).ok();
    }

    /// A file that declares nothing still gets a map that SPANS it.
    ///
    /// Traced (`mvyy1qf7`): one turn took 30 separate `read` windows of
    /// `src/styles/global.css` because the outline answered "no definition
    /// lines" — the model had no map of a 30k-line stylesheet and walked it.
    #[test]
    fn native_outline_maps_a_stylesheet_by_landmarks() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-landmark-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let css = tmp.join("a.css");
        let mut body = String::from("/* \u{2500}\u{2500} tokens \u{2500}\u{2500} */\n:root {\n  --bg: #000;\n}\n");
        // Far more lines than the row budget, so the map must SAMPLE rather than
        // spend every row on the top of the file.
        for i in 0..2_000 {
            body.push_str(&format!(".rule-{i} {{\n  color: red;\n}}\n"));
        }
        body.push_str("/* \u{2500}\u{2500} the very last section \u{2500}\u{2500} */\n.tail {\n  color: blue;\n}\n");
        fs::write(&css, &body).unwrap();

        let out = native_outline(&css, "").unwrap();
        assert!(out.contains("landmark map"), "must say what kind of map: {out}");
        // Spans the file: a row near the end proves it is not the first-N cap.
        assert!(out.contains("the very last section"), "map stops early: {out}");
        let rows = out.lines().filter(|l| l.starts_with(|c: char| c.is_ascii_digit())).count();
        assert!(rows > 20, "too coarse to navigate: {rows} rows");

        // A real declaration file is unaffected: definitions win over landmarks.
        let rs = tmp.join("b.rs");
        fs::write(&rs, "pub fn only() {}\n").unwrap();
        let r = native_outline(&rs, "").unwrap();
        assert!(!r.contains("landmark map"), "{r}");

        fs::remove_dir_all(&tmp).ok();
    }

    /// The map is claimed ONCE per file per turn: the first window carries it,
    /// every later window of that same file stays plain.
    #[test]
    fn the_outline_is_sent_once_per_file_per_turn() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-outline-once-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _claim = outline_claim_lock();
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let big = tmp.join("big.rs");
        let body: String = (0..(READ_OUTLINE_MIN_LINES + 20))
            .map(|i| format!("pub fn f{i}() {{}}\n"))
            .collect();
        fs::write(&big, body).unwrap();

        reset_outline_claims();
        let first = outline_note_once(&big, "big.rs");
        assert!(first.contains(READ_OUTLINE_MARK), "first window must carry the map");
        assert!(first.contains("pub fn f0"), "{first}");
        // Same file, second window: nothing (the map is already above).
        assert!(outline_note_once(&big, "big.rs").is_empty());
        // A NEW turn re-sends it: the fresh transcript has no copy.
        reset_outline_claims();
        assert!(outline_note_once(&big, "big.rs").contains(READ_OUTLINE_MARK));

        // A small file never earns one — a window already IS the whole file.
        let small = tmp.join("small.rs");
        fs::write(&small, "pub fn only() {}\n").unwrap();
        reset_outline_claims();
        assert!(outline_note_once(&small, "small.rs").is_empty());

        fs::remove_dir_all(&tmp).ok();
    }

    /// An attempt that attaches NO map must leave the file's one claim open.
    ///
    /// Traced (`mvyy1qf7`): one turn took 30 windows of `src/styles/global.css`
    /// and only the last carried a map — the earlier attempt answered empty (the
    /// file declares nothing) but had already consumed the claim, so every window
    /// after it stayed blind for the rest of the turn.
    #[test]
    fn an_empty_outline_does_not_consume_the_file_claim() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-outline-claim-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _claim = outline_claim_lock();
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("blank.css");
        // Big enough to earn an outline, but nothing to name yet: the map is empty.
        let blank: String = (0..(READ_OUTLINE_MIN_LINES + 20)).map(|_| "\n").collect();
        fs::write(&f, blank).unwrap();

        reset_outline_claims();
        assert!(outline_note_once(&f, "blank.css").is_empty());
        // The file gains real sections. The claim must still be open, so THIS call
        // is the one that carries the map.
        let real: String = (0..(READ_OUTLINE_MIN_LINES + 20))
            .map(|i| format!(".rule-{i} {{\n  color: red;\n}}\n"))
            .collect();
        fs::write(&f, real).unwrap();
        let after = outline_note_once(&f, "blank.css");
        assert!(
            after.contains(READ_OUTLINE_MARK),
            "an empty attempt must not burn the claim: {after:?}"
        );
        // And the claim IS spent once a map actually went out.
        assert!(outline_note_once(&f, "blank.css").is_empty());

        fs::remove_dir_all(&tmp).ok();
    }

    /// A comma/space separated `include` is what the model actually writes
    /// (`*.ts,*.tsx,*.rs`), and passing it as ONE `--glob` matched nothing —
    /// 12 of 27 traced greps answered a FALSE "no matches". Each entry gets its
    /// own glob; a brace group stays intact.
    #[test]
    fn include_globs_splits_lists_and_keeps_brace_groups() {
        assert_eq!(include_globs("*.rs"), vec!["*.rs"]);
        assert_eq!(
            include_globs("*.ts,*.tsx,*.rs"),
            vec!["*.ts", "*.tsx", "*.rs"]
        );
        assert_eq!(
            include_globs("*.ts, *.tsx"),
            vec!["*.ts", "*.tsx"],
            "space after the comma must not leave a leading space in the glob"
        );
        assert_eq!(include_globs("*.{ts,tsx}"), vec!["*.{ts,tsx}"], "a brace group is one glob");
        assert_eq!(include_globs(""), Vec::<String>::new());
        assert_eq!(include_globs(" , "), Vec::<String>::new());
    }

    /// The end-to-end shape of the traced bug: a comma list must FIND the file,
    /// where it used to answer "no matches".
    #[test]
    fn grep_with_a_comma_include_finds_the_file() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-comma-include-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::write(tmp.join("src/a.ts"), "const compact = 1;\n").unwrap();
        fs::write(tmp.join("src/b.rs"), "fn compact() {}\n").unwrap();

        let hit = grep_scope(&tmp, "src", "compact", "*.ts,*.tsx,*.rs", 20, 0, false).unwrap();
        assert!(hit.contains("a.ts"), "{hit}");
        assert!(hit.contains("b.rs"), "{hit}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn find_symbol_returns_definitions_with_bodies_and_usages_in_one_call() {
        let tmp = find_symbol_fixture();
        let out = find_symbol(&tmp, "compact_history", "", "").unwrap();
        assert!(out.contains("2 definition(s)") && out.contains("usage(s)"), "{out}");
        // Rust def: whole multi-line signature + body, found by indentation.
        assert!(out.contains("src/compact.rs:2-10"), "{out}");
        assert!(out.contains("  8:     let x = 1;") && out.contains("  10: }"), "{out}");
        // Python def too, and build output (target/) is never searched.
        assert!(out.contains("backend/srv.py:1-3") && !out.contains("target/"), "{out}");
        // Usages exclude the definition lines themselves and keep Persian text intact.
        assert!(out.contains("USAGES") && out.contains("src/main.rs:2  compact_history(1);"), "{out}");
        assert!(out.contains("src/main.rs:3  // سلام compact_history"), "{out}");
        assert!(!out.contains("src/compact.rs:2  "), "definition leaked into usages: {out}");
        // Scoped to one file.
        let one = find_symbol(&tmp, "compact_history", "backend/srv.py", "").unwrap();
        assert!(one.contains("1 definition(s)") && !one.contains("src/compact.rs"), "{one}");
        // Go method receivers count as definitions.
        let go = find_symbol(&tmp, "Handle", "", "*.go").unwrap();
        assert!(go.contains("backend/g.go:2-4"), "{go}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_symbol_rejects_patterns_and_reports_misses_as_final() {
        let tmp = find_symbol_fixture();
        assert!(find_symbol(&tmp, "a.*b", "", "").unwrap_err().contains("bare identifier"));
        assert!(find_symbol(&tmp, "", "", "").is_err());
        let miss = find_symbol(&tmp, "nothing_here_xyz", "", "").unwrap();
        assert!(miss.starts_with("no matches for symbol") && miss.contains("final"), "{miss}");
        assert!(find_symbol(&tmp, "x", "../../etc", "").is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn long_bodies_are_cut_with_a_pointer_to_the_rest() {
        let tmp = std::env::temp_dir().join(format!("codifa-findsym-long-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let mut body = String::from("fn big() {\n");
        for i in 0..100 { body.push_str(&format!("    let v{i} = {i};\n")); }
        body.push_str("}\n");
        fs::write(tmp.join("a.rs"), body).unwrap();
        let out = find_symbol(&tmp, "big", "", "").unwrap();
        assert!(out.contains("a.rs:1-102") && out.contains("more lines — read a.rs offset=41"), "{out}");
        assert!(!out.contains("v90"), "{out}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_window_past_the_end_explains_itself() {
        // A silent blank window made a traced run read offset=100000 of a short
        // file and burn a round guessing why it got nothing.
        let dir = std::env::temp_dir().join(format!("codifa-readwin-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let short = dir.join("short.txt");
        fs::write(&short, "a\nb\nc\n").unwrap();
        let out = read_window(&short, 100000, 400).unwrap();
        assert!(out.contains("past the end") && out.contains("3 lines"), "{out}");
        let empty = dir.join("empty.txt");
        fs::write(&empty, "").unwrap();
        assert!(read_window(&empty, 1, 400).unwrap().contains("is empty"));
        // A directory listing past the end explains itself the same way.
        assert!(list_dir(&dir, 999, 10).unwrap().contains("past the end"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_big_batch_keeps_every_window_instead_of_dropping_the_last_ones() {
        // Measured on the real corpus: 5 of 61 `read` calls hit the flat 16_000
        // char model cap, and 4 of those were followed by the SAME file again
        // (backend_light.rs 10x, plugins.ts 7x, repo.rs 6x, TVKit.mq5 3x). The
        // batch merged several windows into one string and the tail cut removed
        // the last files outright, so the model re-read what it had just asked
        // for — a batch that costs a round trip instead of saving one.
        let dir = std::env::temp_dir().join(format!("codifa-readbig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 8 files x 120 lines of ~60 chars => ~60K chars, far past the 16K cap.
        let mut ranges = Vec::new();
        for i in 0..8 {
            let name = format!("f{i}.txt");
            let body: String = (1..=120).map(|l| format!("file{i} line{l} {}\n", "x".repeat(40))).collect();
            fs::write(dir.join(&name), body).unwrap();
            ranges.push(json!({"path": name, "offset": 1, "limit": 120}));
        }
        let root = dir.to_str().unwrap().to_string();
        let out = dispatch(&root, "read", &json!({"ranges": ranges}), None).unwrap();

        // Every one of the 8 windows is represented — none silently vanished.
        for i in 0..8 {
            assert!(
                out.contains(&format!("f{i}.txt (lines")),
                "window {i} was dropped from the batch"
            );
        }
        // The whole result still respects the one budget the turn loop enforces.
        assert!(
            out.chars().count() <= crate::agent::MODEL_RESULT_CAP,
            "batch produced {} chars, over the model cap",
            out.chars().count()
        );
        // What had to be cut says exactly where to resume.
        assert!(
            out.contains("window truncated at line") && out.contains("offset="),
            "a cut window must name its resume offset, got: {out}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_multi_megabyte_text_file_reads_in_windows_instead_of_refusing() {
        // A 2 MB byte gate refused `read` on exactly the files the user wanted
        // read (a log, a dump, a big export) and named no way through. The
        // window is streamed from disk now: the first call serves up to the
        // result budget and states the exact resume offset, so successive calls
        // reach the whole file.
        let dir = std::env::temp_dir().join(format!("codifa-readhuge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.log");
        let body: String = (1..=70_000)
            .map(|i| format!("line {i:06}: the payload for this row\n"))
            .collect();
        fs::write(&path, &body).unwrap();
        assert!(
            fs::metadata(&path).unwrap().len() > MAX_READ_BYTES as u64,
            "fixture must exceed the old 2 MB refusal"
        );

        let root = dir.to_str().unwrap().to_string();
        let first = dispatch(&root, "read", &json!({"filePath": "big.log"}), None).unwrap();
        assert!(!first.contains("too large"), "{first}");
        assert!(
            first.contains("of 70000"),
            "the header must state the real length: {first}"
        );
        assert!(first.contains("line 000001:"), "{first}");
        // The WINDOW obeys the result budget. A large file's one-per-turn
        // outline rides AFTER the window, so it is not part of this bound.
        let window = first.split(READ_OUTLINE_MARK).next().unwrap_or(&first);
        assert!(
            window.chars().count() <= crate::agent::MODEL_RESULT_CAP,
            "the block must stay inside the result cap: {} chars",
            window.chars().count()
        );
        let rest = first
            .split_once("Read the rest with offset=")
            .expect("a cut window names its resume offset")
            .1;
        let resume: usize = rest
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|d| d.parse().ok())
            .expect("resume offset is a number");
        assert!(resume > 1, "{first}");

        // The named offset continues exactly at the cut — the whole file is
        // reachable call by call, nothing hides behind a "too large" gate.
        let second = dispatch(
            &root,
            "read",
            &json!({"filePath": "big.log", "offset": resume, "limit": 3}),
            None,
        )
        .unwrap();
        assert!(
            second.contains(&format!("line {resume:06}:")),
            "offset {resume} must resume at that line: {second}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pptx_read_returns_slide_text_not_zip_bytes() {
        // `.pptx` is a ZIP: reading its bytes as text returned binary noise,
        // which pushed the model into shell unzip tricks that a read-only turn
        // refuses. `read` now dispatches to the native slide reader.
        let dir = std::env::temp_dir().join(format!("codifa-readpptx-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("deck.pptx");
        let file = fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (n, text) in [(1, "Quarterly numbers"), (2, "Next steps")] {
            zip.start_file(
                format!("ppt/slides/slide{n}.xml"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            let xml = format!(
                r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p><a:p><a:r><a:t>bullet</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
            );
            std::io::Write::write_all(&mut zip, xml.as_bytes()).unwrap();
        }
        zip.finish().unwrap();

        let root = dir.to_str().unwrap().to_string();
        let out = dispatch(&root, "read", &json!({"filePath": "deck.pptx"}), None).unwrap();
        assert!(out.contains("PPTX: 2 slide(s)"), "{out}");
        assert!(
            out.contains("Quarterly numbers") && out.contains("Next steps"),
            "both slides' text must be present: {out}"
        );
        assert!(!out.contains("PK\u{3}\u{4}"), "raw zip bytes leaked: {out}");
        assert!(!out.contains('\u{FFFD}'), "binary noise leaked: {out}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overlapping_windows_of_one_file_merge_into_their_union() {
        // Traced on the real corpus: 42 batches carried overlapping windows of
        // the SAME file (6_928 lines ~ 381K chars delivered twice inside one
        // call), because the model stitches a file together from the pieces a
        // precedent grep or report named. The union is lossless.
        let merged = merge_read_targets(vec![
            ("a.rs".into(), 100, 50, true),
            ("a.rs".into(), 120, 80, true),
            ("a.rs".into(), 9000, 20, true),
            ("b.rs".into(), 1, 400, true),
        ]);
        assert_eq!(
            merged,
            vec![
                ("a.rs".to_string(), 100, 100, true),
                ("a.rs".to_string(), 9000, 20, true),
                ("b.rs".to_string(), 1, 400, true),
            ]
        );
        // Adjacent windows (a top-down walk) join too — one header instead of
        // two, and no seam the model has to re-read.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 130, true),
                ("a.rs".into(), 130, 120, true),
            ]),
            vec![("a.rs".to_string(), 1, 249, true)]
        );
        // An exact duplicate collapses (the old dedupe behaviour is preserved).
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 400, true),
                ("a.rs".into(), 1, 400, true),
            ]),
            vec![("a.rs".to_string(), 1, 400, true)]
        );
        // Disjoint windows stay separate: a merge must never invent a range
        // that pulls in lines nobody asked for.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 10, true),
                ("a.rs".into(), 500, 10, true),
            ]),
            vec![
                ("a.rs".to_string(), 1, 10, true),
                ("a.rs".to_string(), 500, 10, true)
            ]
        );
        // A zero limit means the DEFAULT window only when it is ABSENT — an
        // explicit 0 selects no line, and the merge must not inflate it.
        assert_eq!(
            merge_read_targets(vec![("a.rs".into(), 5, 0, true)]),
            vec![("a.rs".to_string(), 5, 0, true)]
        );
        // A deliberate narrow window keeps `extend = false` through a union with
        // a default one: the stretch-to-EOF lever must never widen a window the
        // model sized on purpose.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 400, true),
                ("a.rs".into(), 395, 10, false),
            ]),
            vec![("a.rs".to_string(), 1, 404, false)]
        );
    }

    #[test]
    fn read_ranges_carry_the_file_and_never_repeat_it() {
        // A bare `paths` list forced ONE window on every file and could name the
        // same file twice — the same bytes sent to the model twice. Batches now
        // live in `ranges`, where every entry carries its own file AND window,
        // so several known files still cost ONE call with nothing read twice.
        let dir = std::env::temp_dir().join(format!("codifa-readranges-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "a1\na2\n").unwrap();
        fs::write(dir.join("b.txt"), "b1\nb2\n").unwrap();
        let root = dir.to_str().unwrap().to_string();

        // ONE call, two files, a different window each.
        let out = dispatch(
            &root,
            "read",
            &json!({"ranges": [
                {"path": "a.txt", "offset": 1, "limit": 1},
                {"path": "b.txt", "offset": 2, "limit": 1}
            ]}),
            None,
        )
        .unwrap();
        assert!(out.contains("a1") && out.contains("b2"), "{out}");
        assert!(!out.contains("a2") && !out.contains("b1"), "{out}");

        // A repeated entry collapses, so identical bytes never go twice. The
        // collapse is ANNOUNCED (the marker the ruler counts) — strip it before
        // comparing, so this assertion stays about the payload, not the note.
        let once = dispatch(&root, "read", &json!({"ranges": [{"path": "a.txt"}]}), None).unwrap();
        let twice = dispatch(
            &root,
            "read",
            &json!({"ranges": [{"path": "a.txt"}, {"path": "a.txt"}]}),
            None,
        )
        .unwrap();
        let body = |s: &str| {
            s.split(READ_MERGED_MARK).next().unwrap_or(s).trim_end().to_string()
        };
        assert_eq!(body(&once), body(&twice), "a duplicate range must collapse");
        assert!(
            twice.contains(READ_MERGED_MARK),
            "the collapse is recorded in the result: {twice}"
        );

        // An entry without `path` inherits the top-level filePath, so a
        // single-file multi-window read stays short.
        let inherited = dispatch(
            &root,
            "read",
            &json!({"filePath": "b.txt", "ranges": [{"offset": 2, "limit": 1}]}),
            None,
        )
        .unwrap();
        assert!(inherited.contains("b2") && !inherited.contains("b1"), "{inherited}");

        // `ranges` spelled as a serialized JSON STRING is the same request.
        // Traced (mvxqpye6 r0): the string form matched no shape check, fell
        // through to `resolve_safe(root, "")`, and answered with a directory
        // listing flagged `ok` — two extra rounds spent disproving it.
        let as_string = dispatch(
            &root,
            "read",
            &json!({
                "ranges": "[{\"path\":\"a.txt\",\"offset\":2,\"limit\":1}]"
            }),
            None,
        )
        .unwrap();
        assert!(as_string.contains("a2"), "string ranges must be honoured: {as_string}");
        assert!(
            !as_string.contains("b.txt"),
            "a string `ranges` must never degrade to a directory listing: {as_string}"
        );

        // A read that names NO file is an error, never the workspace root.
        let nameless = dispatch(&root, "read", &json!({}), None).unwrap_err();
        assert!(nameless.contains("no file named"), "{nameless}");

        // The legacy list form still WORKS (a stale transcript must not burn a
        // round trip) but is no longer advertised, and the shared dedupe
        // collapses the repeated file the old shape allowed.
        let legacy = dispatch(
            &root,
            "read",
            &json!({"paths": ["a.txt", "a.txt", "b.txt"]}),
            None,
        )
        .unwrap();
        assert_eq!(
            legacy.matches("a1").count(),
            1,
            "the legacy list form must not read a file twice: {legacy}"
        );
        assert!(legacy.contains("b1"), "{legacy}");

        // A range entry that names no file at all is an explicit error.
        let err = dispatch(&root, "read", &json!({"ranges": [{"offset": 1}]}), None).unwrap_err();
        assert!(err.contains("names no file"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dispatch_routes_find_symbol_with_its_own_args() {
        // The tool is only usable if the dispatcher knows the name AND reads
        // symbol/path/include (not the LSP filePath shape).
        let tmp = find_symbol_fixture();
        let root = tmp.to_str().unwrap();
        let out = dispatch(root, "find_symbol", &json!({"symbol": "compact_history"}), None).unwrap();
        assert!(out.contains("definition(s)") && out.contains("src/compact.rs"), "{out}");
        // path/include scope the search like every other search tool.
        let scoped = dispatch(
            root,
            "find_symbol",
            &json!({"symbol": "Handle", "path": "backend", "include": "*.go"}),
            None,
        )
        .unwrap();
        assert!(scoped.contains("backend/g.go") && !scoped.contains("src/compact.rs"), "{scoped}");
        // A regex is rejected with the bare-identifier hint, not a silent miss.
        let err = dispatch(root, "find_symbol", &json!({"symbol": "a.*b"}), None).unwrap_err();
        assert!(err.contains("bare identifier"), "{err}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn system_stats_lists_processes() {
        let out = system_stats("", 5).expect("system_stats should work");
        assert!(out.contains("total RSS"), "missing header: {out}");
        assert!(out.lines().count() > 1, "no rows: {out}");
    }

    #[test]
    fn system_stats_filters_by_name() {
        let out = system_stats("codifa", 10).expect("system_stats should work");
        for line in out.lines().skip(1) {
            assert!(
                line.to_lowercase().contains("codifa") || line.trim().is_empty(),
                "non-matching row leaked: {line}"
            );
        }
    }

    #[test]
    fn resolve_safe_rejects_escapes() {
        let tmp = std::env::temp_dir().join("codifa-tools-test");
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();
        assert!(resolve_safe(root, "src/a.ts", false, None).is_ok());
        assert!(resolve_safe(root, "/etc/passwd", false, None).is_err());
        assert!(resolve_safe(root, "../../outside.txt", false, None).is_err());
        // Temp dir is always allowed.
        let t = std::env::temp_dir().join("codifa-allowed.txt");
        assert!(resolve_safe(root, &t.to_string_lossy(), false, None).is_ok());
        // The shared /tmp root is allowed too (Unix; skipped where absent).
        #[cfg(unix)]
        {
            fs::write("/tmp/codifa-tmp-allowed.txt", "x").unwrap();
            assert!(resolve_safe(root, "/tmp/codifa-tmp-allowed.txt", false, None).is_ok());
            let _ = fs::remove_file("/tmp/codifa-tmp-allowed.txt");
        }
        // permit folders grant only their subtree.
        let permit = json!({ "folders": [tmp.parent().unwrap().to_str().unwrap()] });
        assert!(resolve_safe(root, "/etc/passwd", false, Some(&permit)).is_err());
        let granted = tmp.join("sub/x");
        assert!(resolve_safe(root, &granted.to_string_lossy(), false, Some(&permit)).is_ok());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_window_block_numbers_lines_under_a_range_header() {
            let dir = std::env::temp_dir().join("codifa_read_block_test");
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join("sample.txt");
            fs::write(&file, "alpha\nbeta\ngamma\ndelta\n").unwrap();

            // Every line carries its 1-based number under the window's header, so
            // the caller can cite a line without re-reading the file.
            let block = read_window_block(&file, "sample.txt", 2, 2).unwrap();
            // The header states the file's TOTAL too: without it the model cannot
            // tell a window near EOF from one near the top of a long file, and
            // walks the file one blind window per round trip.
            assert_eq!(block, "sample.txt (lines 2-3 of 4):\n2: beta\n3: gamma\n");

            // offset 0 reads the same first line as offset 1, and the header must
        // not announce a line 0 that no file has.
        let zero = read_window_block(&file, "sample.txt", 0, 1).unwrap();
        assert_eq!(zero, "sample.txt (lines 1-1 of 4):\n1: alpha\n");

        // A window that reaches EOF omits the `of N` (it would be redundant).
        let tail = read_window_block(&file, "sample.txt", 3, 99).unwrap();
        assert_eq!(tail, "sample.txt (lines 3-4):\n3: gamma\n4: delta\n");

        // A window past the end still explains itself instead of a blank.
            let past = read_window_block(&file, "sample.txt", 99, 5).unwrap();
            assert!(past.contains("past the end"), "{past}");

            // Long lines are cut at the byte cap without splitting a character.
            let long = format!("{}{}{}", "x".repeat(MAX_LINE_LENGTH - 10), "\u{1F600}", "y".repeat(20));
            fs::write(&file, format!("{long}\n")).unwrap();
            let block = read_window_block(&file, "sample.txt", 1, 1).unwrap();
            assert!(block.ends_with("[truncated]\n"), "{block}");
            assert!(block.contains('\u{1F600}'), "{block}");

            let plain = read_window(&file, 1, 1).unwrap();
            assert!(plain.starts_with("xxxx"), "{plain}");
            assert!(!plain.contains("1: "), "{plain}");

            let _ = fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_docx_read_returns_extracted_text_not_zip_bytes() {
        // MEASURED (mw94lr47): a read-only turn could not read a `.docx` at
        // all — its bytes are a ZIP, so the model fell back to
        // `unzip -p … | sed …`, and the write gate refused that over a `>`
        // inside the sed regex. `read` now extracts the document text with the
        // same native reader the right-hand viewer uses.
        let dir = std::env::temp_dir().join(format!("codifa-docx-read-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("report.docx");
        let file = fs::File::create(&docx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(
            &mut zip,
            br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue grew 12%</w:t></w:r></w:p></w:body></w:document>"#,
        )
        .unwrap();
        zip.finish().unwrap();

        let block = read_window_block(&docx, "report.docx", 1, 20).unwrap();
        assert!(block.contains("Quarterly report"), "{block}");
        assert!(block.contains("Revenue grew 12%"), "{block}");
        assert!(!block.contains("PK\u{3}"), "raw zip bytes leaked: {block}");
        let _ = fs::remove_dir_all(&dir);
        }

        #[test]
        fn read_window_truncates_long_lines() {
        let tmp = std::env::temp_dir().join("codifa-read-test.txt");
        let long = "x".repeat(3000);
        fs::write(&tmp, format!("short\n{long}\n")).unwrap();
        let out = read_window(&tmp, 1, 100).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "short");
        assert!(lines[1].contains("…[truncated]"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn parse_ranges_handles_all_forms() {
        let (jobs, bad) = parse_ranges(&["a.py:10:5".into()], "");
        assert_eq!(jobs, vec![("a.py".into(), 10, 5)]);
        assert!(bad.is_empty());
        let (jobs, _) = parse_ranges(&["30:40".into()], "x.ts");
        assert_eq!(jobs, vec![("x.ts".into(), 30, 11)]);
        let (jobs, _) = parse_ranges(&["[7,9]".into()], "x.ts");
        assert_eq!(jobs, vec![("x.ts".into(), 7, 3)]);
        let (_, bad) = parse_ranges(&["nope".into()], "x.ts");
        assert_eq!(bad, vec!["nope".to_string()]);
    }

    #[test]
    fn grep_alternative_counting_ignores_grouped_pipes() {
        assert_eq!(count_grep_alternatives("foo|bar|baz"), 3);
        assert_eq!(count_grep_alternatives("(a|b)|c"), 2);
        assert_eq!(count_grep_alternatives("function\\s+\\w+"), 1);
    }

    #[test]
    fn grep_scope_drops_context_past_the_cap() {
        // rg's --max-count is per FILE while the cap counts every match, so
        // later files kept emitting context lines after the cap was already
        // hit: the output ended with blocks that had no match marker at all.
        let tmp = std::env::temp_dir().join("codifa-grep-cap-test");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("a.rs"),
            "hit one\nalpha\nhit two\nbeta\nhit three\ngamma\n",
        )
        .unwrap();
        fs::write(tmp.join("b.rs"), "hit four\ndelta\nhit five\nepsilon\n").unwrap();
        let out = grep_scope(&tmp, "", "hit", "", 3, 1, false).unwrap();
        for block in out.split("\n\n") {
            let body: Vec<&str> = block.lines().skip(1).collect();
            assert!(
                body.is_empty() || body.iter().any(|l| l.starts_with('>')),
                "a context-only block leaked past the cap:\n{out}"
            );
        }
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_scope_finds_matches_with_context() {
        // pid-unique + recreated: the fixture lives in the shared OS temp root,
        // which ripgrep's ignore/`--max-count` walker inspects — a leftover dir
        // from an interrupted run or a concurrent `cargo test` process sharing
        // the fixed name used to make this test flaky (rg reported no matches).
        let tmp = std::env::temp_dir().join(format!("codifa-grep-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("sub/a.rs"), "fn alpha() {}\nfn beta() {}\n").unwrap();
        let out = grep_scope(&tmp, "sub", "alpha", "", 10, 1, false).unwrap();
        assert!(out.contains("a.rs"));
        assert!(out.contains(">1: fn alpha"));
        assert!(out.contains("2: fn beta"));
        assert_eq!(
            grep_scope(&tmp, "sub", "zzz_nothing", "", 10, 1, false).unwrap(),
            "no matches"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_scope_accepts_single_file_scope() {
        // A file (not a directory) as the scope: rg cannot current_dir into a
        // file (ENOTDIR, "Not a directory") — the scope must resolve to the
        // file's parent with the file as the search target.
        let tmp = std::env::temp_dir().join("codifa-grep-file-test");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("one.rs"), "fn alpha() {}\n").unwrap();
        let file_scope = tmp.join("one.rs").to_string_lossy().into_owned();
        let out = grep_scope(&tmp, &file_scope, "alpha", "", 10, 1, false).unwrap();
        assert!(out.contains("alpha"), "file-scope grep failed: {out}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_budget_spends_definition_lines_first_and_spreads_across_files() {
        // Traced refinement chains started from a cap that spent its lines on
        // call-site hits in the FIRST file (rg's walk order) while the
        // declaration the model was hunting sat in a later file, past the cut
        // — the model then re-grepped with a narrower pattern (a wasted round
        // trip). The budget must buy definition lines FIRST and give every
        // matching file a share, with the unseen files' mass reported.
        let tmp = std::env::temp_dir().join("codifa-grep-fair-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // Walk-order FIRST file: one declaration buried in noise.
        fs::write(
            tmp.join("a_noise.rs"),
            "token call 1\ntoken call 2\ntoken call 3\nstruct token_def { x: u8 }\ntoken call 4\ntoken call 5\ntoken call 6\ntoken call 7\n",
        )
        .unwrap();
        // A middle file with NO declarations: the fair spread must skip its
        // call sites first and report its mass instead of hiding it.
        fs::write(tmp.join("m_mid.rs"), "token mid 1
token mid 2
token mid 3
").unwrap();
        // Walk-order LAST file: the target declaration.
        fs::write(tmp.join("z_late.rs"), "let token = 1;\nstruct token_target;\n").unwrap();
        let out = grep_scope(&tmp, "", "token", "", 3, 0, false).unwrap();
        // rg's file walk order is NOT stable, so these assertions are written
        // order-independently: they hold whichever file rg emits first.
        //
        // Both declarations made the budget: one file carrying a declaration can
        // no longer spend the whole allowance and starve the file that DEFINES
        // the symbol the model is hunting.
        assert!(
            out.contains("struct token_def"),
            "definition line must beat call sites inside the budget:\n{out}"
        );
        assert!(
            out.contains("struct token_target"),
            "a later file's definition must not be eaten by the first file:\n{out}"
        );
        // Every matching file is ACCOUNTED FOR: it either shows a block or is
        // named with its hit count. A file silently dropped is a round trip the
        // model spends re-grepping to discover it existed.
        for name in ["a_noise.rs", "m_mid.rs", "z_late.rs"] {
            assert!(
                out.contains(name),
                "{name} vanished from the budget report:\n{out}"
            );
        }
        assert!(
            out.contains("not shown") || !out.contains("truncated"),
            "a truncated budget must say what it hid:\n{out}"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// Whatever the budget cuts must still be NAMED with its hit count.
    ///
    /// A file silently dropped from the display is a round trip the model spends
    /// re-grepping to learn it existed. Cap 1 with two declaring files makes the
    /// cut unavoidable, so the announcement is asserted without depending on
    /// rg's file order.
    #[test]
    fn a_file_the_budget_cannot_reach_is_named_with_its_mass() {
        let tmp = std::env::temp_dir().join(format!("codifa-grep-mass-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("one.rs"), "struct token_one;\n").unwrap();
        fs::write(tmp.join("two.rs"), "struct token_two;\n").unwrap();
        let out = grep_scope(&tmp, "", "struct token_", "", 1, 0, false).unwrap();
        // Exactly one of the two fits; the other must be announced, not hidden.
        let hidden = out.matches("not shown").count();
        assert_eq!(hidden, 1, "exactly one file must be reported unseen:\n{out}");
        let shown = out.matches("struct token_").count();
        assert_eq!(shown, 1, "the budget of 1 must show exactly one hit:\n{out}");
        for name in ["one.rs", "two.rs"] {
            assert!(out.contains(name), "{name} vanished from the report:\n{out}");
        }
        fs::remove_dir_all(&tmp).ok();
    }

    /// One declaration-heavy file must not starve every other file's.
    ///
    /// Traced (`mvyy1qf7`, 74 rounds): refinement chains re-grepped with a
    /// narrower pattern because the first file's declarations filled the budget
    /// and the file defining the symbol was cut. Pass 1 now gives every
    /// declaring file a share before ANY file takes a second line.
    #[test]
    fn one_declaration_heavy_file_cannot_starve_the_others() {
        let tmp = std::env::temp_dir().join(format!("codifa-grep-starve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // Many declarations, so a per-file allowance of several would fill a
        // small budget with this file alone.
        let mut heavy = String::new();
        for i in 0..8 {
            heavy.push_str(&format!("struct token_heavy_{i} {{ x: u8 }}\n"));
        }
        fs::write(tmp.join("a_heavy.rs"), heavy).unwrap();
        fs::write(tmp.join("z_only.rs"), "struct token_only { y: u8 }\n").unwrap();
        let out = grep_scope(&tmp, "", "token_", "", 3, 0, false).unwrap();
        // Whichever file rg walked first, the single-declaration file keeps a
        // slot: the fair share is decided BEFORE any file gets a second line.
        assert!(
            out.contains("struct token_only"),
            "the only declaration of a second file must survive a heavy neighbour:\n{out}"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_miss_searches_spelling_variants_in_the_same_call() {
        // Traced: a literal miss (`script.json`) cost a second round-trip
        // before the model tried `script_json`. The variant pass runs HERE, in
        // the same call, labeled so the model knows the literal is absent.
        let tmp = std::env::temp_dir().join("codifa-grep-variant-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("m.rs"), "const SCRIPT_JSON_NAME: &str = \"script_json\";\n").unwrap();
        // The traced miss shape: the model writes the literal dot ESCAPED
        // (`script\.json`), which no longer matches `script_json` as a regex.
        let out = grep_scope(&tmp, "", "script\\.json", "", 10, 0, false).unwrap();
        assert!(
            out.contains("SPELLING-VARIANT"),
            "a literal miss must run the variant pass:\n{out}"
        );
        assert!(out.contains("script_json"), "{out}");
        // A miss whose variants also miss stays a plain miss.
        let miss = grep_scope(&tmp, "", "zzz_nothing", "", 10, 0, false).unwrap();
        assert_eq!(miss, "no matches");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn name_variants_cover_the_naming_conventions() {
        // `script.json` → the four code conventions; separators normalize to _.
        let v = name_variant_pattern("script.json").unwrap();
        assert!(v.contains("script_json") && v.contains("ScriptJson") && v.contains("scriptJson"), "{v}");
        assert!(v.contains("SCRIPT_JSON"), "{v}");
        // ALL-CAPS and kebab inputs split to the same segments.
        let v2 = name_variant_pattern("SCRIPT_TIMEOUT").unwrap();
        assert!(v2.contains("script_timeout") && v2.contains("ScriptTimeout"), "{v2}");
        let v3 = name_variant_pattern("my-var_name").unwrap();
        assert!(v3.contains("myVarName"), "{v3}");
        // A single lowercase word still gains its case variants (constants!).
        let v4 = name_variant_pattern("timeout").unwrap();
        assert!(v4.contains("TIMEOUT"), "{v4}");
        // Regex-ish or multi-alternative input never goes through variants.
        assert!(name_variant_pattern("a|b").is_none());
        assert!(name_variant_pattern("fn\\s+[a-z]+").is_none());
        assert!(name_variant_pattern("").is_none());
    }

    #[test]
    fn grep_refuses_unscoped_broad_patterns() {
        let tmp = std::env::temp_dir().join("codifa-grep-broad");
        fs::create_dir_all(&tmp).unwrap();
        let args = json!({ "pattern": "a|b|c|d" });
        let err = dispatch(tmp.to_str().unwrap(), "grep", &args, None).unwrap_err();
        // The refusal has to carry the way OUT, or the model spends a round
        // inventing another over-broad spelling (measured: 65-138K per round).
        assert!(err.contains("broad pattern refused"), "{err}");
        assert!(err.contains("add a scope"), "{err}");
        assert!(err.contains("SEPARATE grep calls in ONE step"), "{err}");
        assert!(err.contains("Do NOT retry"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn glob_scope_matches_nested_and_flat() {
        let tmp = std::env::temp_dir().join("codifa-glob-test");
        fs::create_dir_all(tmp.join("deep/nest")).unwrap();
        fs::write(tmp.join("deep/nest/x.test.ts"), "").unwrap();
        fs::write(tmp.join("top.py"), "").unwrap();
        let hits = glob_scope(&tmp, "deep", "**/*.test.ts", 10).unwrap();
        assert_eq!(hits, vec!["deep/nest/x.test.ts".to_string()]);
        let hits = glob_scope(&tmp, "", "*.py", 10).unwrap();
        assert_eq!(hits, vec!["top.py".to_string()]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn glob_double_star_matches_root_level_and_scope_relative() {
        let tmp = std::env::temp_dir().join("codifa-glob-root-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("backend")).unwrap();
        fs::create_dir_all(tmp.join("src-tauri/src")).unwrap();
        fs::write(tmp.join("backend/server.py"), "").unwrap();
        fs::write(tmp.join("src-tauri/src/agent.rs"), "").unwrap();
        // Regression: `**/` demanded a parent dir, so root-level paths never matched.
        let hits = glob_scope(&tmp, "", "**/backend/server.py", 10).unwrap();
        assert_eq!(hits, vec!["backend/server.py".to_string()]);
        // Pattern relative to the scope (path=src-tauri, pattern=src/*).
        let hits = glob_scope(&tmp, "src-tauri", "src/*", 10).unwrap();
        assert_eq!(hits, vec!["src-tauri/src/agent.rs".to_string()]);
        // A missing scope is an error, not a silent "no matches".
        let err = glob_scope(&tmp, "nope", "*.rs", 10).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn layout_snapshot_lists_real_paths_and_skips_noise() {
        let tmp = std::env::temp_dir().join("codifa-layout-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("backend/tests")).unwrap();
        fs::create_dir_all(tmp.join("node_modules/x")).unwrap();
        fs::create_dir_all(tmp.join(".git")).unwrap();
        fs::write(tmp.join("backend/server.py"), "").unwrap();
        fs::write(tmp.join("backend/tests/t.py"), "").unwrap();
        fs::write(tmp.join("package.json"), "").unwrap();
        let snap = layout_snapshot(tmp.to_str().unwrap(), 4000);
        assert!(snap.contains("./: backend/, package.json"), "{snap}");
        assert!(snap.contains("backend/: server.py, tests/"), "{snap}");
        assert!(snap.contains("backend/tests/: t.py"), "{snap}");
        assert!(!snap.contains("node_modules") && !snap.contains(".git"), "{snap}");
        assert!(layout_snapshot(tmp.to_str().unwrap(), 40).len() <= 40);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn lsp_tools_resolve_symbol_or_fail_fast_without_spawning_a_server() {
        let tmp = std::env::temp_dir().join("codifa-lsp-dispatch-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.rs"), "fn alpha() {}\n").unwrap();
        let root = tmp.to_str().unwrap();
        // Neither symbol nor line: clear error instead of a bogus 1:0 lookup.
        let err = dispatch(root, "lsp_definition", &json!({ "filePath": "a.rs" }), None).unwrap_err();
        assert!(err.contains("symbol"), "{err}");
        // Unknown symbol: reported before any language server is started.
        let err = dispatch(root, "lsp_hover", &json!({ "filePath": "a.rs", "symbol": "missing_fn" }), None).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn edit_enforces_uniqueness_and_batch_order() {
        let tmp = std::env::temp_dir().join("codifa-edit-test");
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("f.txt");
        fs::write(&file, "one\ntwo\none\n").unwrap();
        let root = tmp.to_str().unwrap();

        let err = edit_file(root, "f.txt", "one", "ONE", false, None).unwrap_err();
        assert!(err.contains("appears 2 times"));
        let msg = edit_file(root, "f.txt", "one", "ONE", true, None).unwrap();
        assert!(msg.contains("2 occurrences"));

        let args = json!({
            "path": "f.txt",
            "edits": [
                { "old_string": "ONE", "new_string": "uno", "replace_all": true },
                { "old_string": "missing", "new_string": "x" }
            ]
        });
        // PARTIAL, not all-or-nothing: the good edit is WRITTEN and the bad one
        // is named. Traced on the live corpus, the old atomic form made 8 of 84
        // batch edits throw away their good half, and each recovery cost a median
        // of 2 extra rounds (18 rounds, 4 of them a blind re-read of the file).
        let msg = dispatch(root, "edit_file", &args, None).unwrap();
        assert!(msg.contains("PARTIAL"), "{msg}");
        assert!(msg.contains("1/2"), "{msg}");
        assert!(msg.contains("edit 2/2: old_string not found"), "{msg}");
        assert!(msg.contains("send ONLY the failed one"), "{msg}");
        assert!(fs::read_to_string(&file).unwrap().contains("uno"));

        // A batch where NOTHING applies still fails, so the caller sees an error.
        let args = json!({
            "path": "f.txt",
            "edits": [{ "old_string": "nope", "new_string": "x" }]
        });
        let err = dispatch(root, "edit_file", &args, None).unwrap_err();
        assert!(err.contains("no edit applied"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// Naming a DIRECTORY to `lsp_symbols` answers with its entries instead of
    /// refusing. The model often has the folder but no file in it, and the old
    /// refusal ("outlines ONE file — src is a directory") spent a whole round
    /// teaching it nothing the listing does not say.
    #[test]
    fn lsp_symbols_on_a_directory_lists_its_entries() {
        let tmp = std::env::temp_dir().join(format!("codifa-lsp-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("one.rs"), "fn a() {}\n").unwrap();
        fs::write(tmp.join("two.rs"), "fn b() {}\n").unwrap();
        fs::write(tmp.join("sub/three.rs"), "fn c() {}\n").unwrap();
        let root = tmp.to_str().unwrap();

        let out = dispatch(root, "lsp_symbols", &json!({ "filePath": "" }), None)
            .err()
            .unwrap_or_default();
        // An empty filePath is still an error — this guards the arm below from
        // swallowing it.
        assert!(!out.contains("DIRECTORY"), "empty path is not a listing: {out}");

        let out = dispatch(root, "lsp_symbols", &json!({ "filePath": "." }), None).unwrap();
        assert!(out.contains("DIRECTORY"), "says what it is: {out}");
        assert!(out.contains("one.rs") && out.contains("two.rs"), "lists files: {out}");
        assert!(out.contains("sub/"), "marks subdirectories: {out}");
        // The next round must be exact: one of the files it just listed.
        assert!(out.contains("lsp_symbols on it"), "names the follow-up: {out}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A `write_file` that arrives WITHOUT `content` must not report success.
    ///
    /// `fs::write(.., "")` truncated the target to zero bytes and the answer was
    /// still "Successfully wrote … (0 bytes)", which reads as done. One traced
    /// chat sent the SAME bodiless call 16 times (each args object was `{path}`
    /// only) because nothing in the result said the body had never arrived.
    #[test]
    fn write_file_without_content_is_refused_not_a_silent_truncation() {
        let tmp = std::env::temp_dir().join(format!("codifa-wf-nocontent-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();
        let file = tmp.join("keep.txt");
        fs::write(&file, "original body\n").unwrap();

        let err = dispatch(root, "write_file", &json!({ "path": "keep.txt" }), None).unwrap_err();
        assert!(err.contains("content"), "names the missing argument: {err}");
        assert!(err.contains("keep.txt"), "names the file it refused: {err}");
        // The refusal must leave the file ALONE — a truncated file is the bug.
        assert_eq!(fs::read_to_string(&file).unwrap(), "original body\n");

        // An explicit empty body stays legal: it empties the file on purpose.
        let ok = dispatch(root, "write_file", &json!({ "path": "keep.txt", "content": "" }), None)
            .unwrap();
        assert!(ok.contains("(0 bytes)"), "{ok}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "");
        fs::remove_dir_all(&tmp).ok();
    }

    /// A write the user approved OUTSIDE the workspace can still be snapshotted,
    /// which is what makes its diff (and therefore the card + Review entry)
    /// possible.
    ///
    /// `read_pre_edit` used to resolve with no permit at all. Workspace, temp and
    /// `~/.codifa` never needed one, so this only ever bit a path in the user's
    /// HOME (traced: `edit_file ~/local-models-server/stt-server.py`, approved in
    /// the popup, then reported as a bare "Edited" with no +N/-M anywhere).
    #[cfg(unix)]
    #[test]
    fn a_permitted_out_of_tree_edit_can_still_be_snapshotted_for_its_diff() {
        // `/etc/hosts` is guaranteed to exist and to sit outside EVERY free root
        // (workspace, temp, ~/.codifa), so the permit is the only way in.
        let tmp = std::env::temp_dir().join("codifa-read-pre-edit-permit");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();

        // No permit: outside every free root, so there is nothing to snapshot.
        assert!(read_pre_edit(root, "/etc/hosts", None).is_none());

        // The user approved it: the snapshot now exists, which is what lets the
        // diff be computed at all.
        let permit = json!({ "outside": true, "folders": [] });
        let before = read_pre_edit(root, "/etc/hosts", Some(&permit));
        assert!(before.is_some(), "an approved path must be readable for diffing");
        let diff = unified_diff("/etc/hosts", &before.unwrap(), "only one line\n");
        assert!(!diff.is_empty(), "an approved edit must produce a diff");
        fs::remove_dir_all(&tmp).ok();
    }

    /// An `edit_file` that names NO file refuses in terms of the missing
    /// argument instead of trying to read the workspace root.
    #[test]
    fn edit_file_with_no_file_named_says_so() {
        let tmp = std::env::temp_dir().join("codifa-edit-no-path");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();

        let err = dispatch(
            root,
            "edit_file",
            &json!({ "edits": [{ "old_string": "a", "new_string": "b" }] }),
            None,
        )
        .unwrap_err();
        assert!(err.contains("no file named"), "says what is missing: {err}");
        // The old failure leaked the OS error and the ROOT path instead.
        assert!(!err.contains("Is a directory"), "no errno soup: {err}");
        assert!(err.contains("`path`"), "names the argument: {err}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// A batch that names its file ONLY per entry must reach that file.
    ///
    /// The schema advertises `edits: [{path, old_string, new_string}]` with no
    /// top-level `path`, so a batch of same-file entries resolved the EMPTY
    /// path to the workspace ROOT and died with
    /// `cannot read <root> for editing: Is a directory (os error 21)` — a
    /// message naming no file, so recovering from it meant re-reading the whole
    /// request rather than fixing one argument. Reproduced on the live corpus
    /// (`agent/mod.rs`), where the model had obeyed the documented shape.
    #[test]
    fn a_batch_that_names_its_file_only_per_entry_reaches_that_file() {
        let tmp = std::env::temp_dir().join("codifa-edit-per-entry-path");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("f.txt");
        fs::write(&file, "alpha\nbeta\n").unwrap();
        let root = tmp.to_str().unwrap();

        // No top-level `path` at all: exactly the advertised batch shape.
        let args = json!({
            "edits": [
                { "path": "f.txt", "old_string": "alpha", "new_string": "ALPHA" },
                { "path": "f.txt", "old_string": "beta", "new_string": "BETA" }
            ]
        });
        let msg = dispatch(root, "edit_file", &args, None).unwrap();
        assert!(msg.contains("Successfully edited f.txt"), "{msg}");
        let after = fs::read_to_string(&file).unwrap();
        assert_eq!(after, "ALPHA\nBETA\n");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn an_ambiguous_edit_names_each_site_instead_of_only_a_count() {
        // MEASURED (traces `mvy0ausq` / `mvxsy14e`): 5 ambiguous edits failed and
        // each cost 1-2 recovery rounds at 65-138K re-sent tokens, because the
        // error named only a COUNT and the model re-grepped or re-read the file
        // to find text that would make its string unique. The sites are already
        // open here, so they are shown with real line numbers.
        let tmp = std::env::temp_dir().join(format!("codifa-ambig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("f.txt");
        fs::write(&file, "alpha\none\nbeta\none\ngamma\n").unwrap();
        let root = tmp.to_str().unwrap();

        let err = edit_file(root, "f.txt", "one", "ONE", false, None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{err}");
        // Both occurrences are located, with their neighbours, so the fix needs
        // no extra call.
        assert!(err.contains("site at line 2"), "{err}");
        assert!(err.contains("site at line 4"), "{err}");
        assert!(err.contains("alpha"), "{err}");
        assert!(err.contains("gamma"), "{err}");
        assert!(!err.contains("\n\n\n"), "{err}");
        // Still a failure: nothing was written.
        assert_eq!(fs::read_to_string(&file).unwrap(), "alpha\none\nbeta\none\ngamma\n");

        // The batch path carries the same sites in its suffix.
        let args = json!({
            "path": "f.txt",
            "edits": [{ "old_string": "one", "new_string": "ONE" }]
        });
        let err = dispatch(root, "edit_file", &args, None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{err}");
        assert!(err.contains("site at line 2"), "{err}");

        // Two occurrences on the SAME line are one place in the file, so the
        // hint names it once: a duplicated window reads as two distinct sites.
        fs::write(&file, "alpha\nfoo foo\nbeta\n").unwrap();
        let err = edit_file(root, "f.txt", "foo", "FOO", false, None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{err}");
        assert_eq!(err.matches("site at line 2").count(), 1, "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn edit_batch_honours_a_path_per_entry() {
        // The schema advertises `edits: [{path, old_string, new_string}]`, but the
        // per-entry `path` used to be IGNORED: every entry was applied to the
        // top-level path, so a cross-file batch failed with "old_string not found"
        // on the WRONG file and the model re-read and retried once per file —
        // traced, 13 edits over 2 files took 11 rounds.
        let tmp = std::env::temp_dir().join(format!("codifa-editmulti-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let a = tmp.join("a.txt");
        let b = tmp.join("b.txt");
        fs::write(&a, "alpha\nbeta\n").unwrap();
        fs::write(&b, "gamma\ndelta\n").unwrap();
        let root = tmp.to_str().unwrap().to_string();

        // ONE call, two files, each entry naming its own path.
        let out = dispatch(
            &root,
            "edit_file",
            &json!({
                "edits": [
                    {"path": "a.txt", "old_string": "alpha", "new_string": "ALPHA"},
                    {"path": "b.txt", "old_string": "delta", "new_string": "DELTA"}
                ]
            }),
            None,
        )
        .unwrap();
        assert!(fs::read_to_string(&a).unwrap().contains("ALPHA"), "{out}");
        assert!(fs::read_to_string(&b).unwrap().contains("DELTA"), "{out}");
        assert!(out.contains("a.txt") && out.contains("b.txt"), "{out}");

        // One file landing and one missing reports BOTH halves, naming the file
        // that still needs work (so the next call is one targeted edit, not a
        // blind re-read).
        let out = dispatch(
            &root,
            "edit_file",
            &json!({
                "edits": [
                    {"path": "a.txt", "old_string": "ALPHA", "new_string": "alpha"},
                    {"path": "b.txt", "old_string": "absent", "new_string": "x"}
                ]
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("FAILED") && out.contains("b.txt"), "{out}");
        assert!(fs::read_to_string(&a).unwrap().contains("alpha"));
        assert!(fs::read_to_string(&b).unwrap().contains("DELTA"), "b must be untouched");

        // An entry without a `path` still inherits the top-level one, so the
        // single-file batch form keeps working unchanged.
        let out = dispatch(
            &root,
            "edit_file",
            &json!({
                "path": "b.txt",
                "edits": [
                    {"old_string": "DELTA", "new_string": "delta"},
                    {"old_string": "gamma", "new_string": "GAMMA"}
                ]
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("2") || out.contains("Successfully"), "{out}");
        let btext = fs::read_to_string(&b).unwrap();
        assert!(btext.contains("delta") && btext.contains("GAMMA"), "{btext}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn write_rejects_paths_outside_root() {
        let tmp = std::env::temp_dir().join("codifa-write-test");
        fs::create_dir_all(&tmp).unwrap();
        let err = write_file(tmp.to_str().unwrap(), "/etc/codifa-evil.txt", "x", None).unwrap_err();
        assert!(err.contains("escapes project root"));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn terminal_captures_output_and_exit_codes() {
        let tmp = std::env::temp_dir().join("codifa-term-test");
        fs::create_dir_all(&tmp).unwrap();
        let out = run_terminal(tmp.to_str().unwrap(), "echo hello", 10).unwrap();
        assert!(out.contains("hello"));
        let out = run_terminal(tmp.to_str().unwrap(), "exit 3", 10).unwrap();
        assert!(out.contains("EXIT CODE: 3"));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn terminal_streams_live_tail_while_running() {
        let tmp = std::env::temp_dir().join("codifa-term-tail-test");
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap().to_string();
        // A command that prints a progress-style line every ~200 ms for ~1.5 s:
        // the sink must fire SEVERAL times while the child is still alive,
        // each time with the newest line in the tail.
        let sink: TailSink = Arc::new(|tail: &str| {
            TAILS.with(|t| t.borrow_mut().push(tail.to_string()));
        });
        let out = run_terminal_bounded_with(
            &root,
            "for i in 1 2 3 4 5 6 7; do echo \"tick $i\"; sleep 0.2; done",
            15,
            MAX_TERMINAL_TIMEOUT_SECS,
            Some(&sink),
        )
        .unwrap();
        let tails = TAILS.with(|t| std::mem::take(&mut *t.borrow_mut()));
        assert!(out.contains("tick 7"), "{out}");
        // At least two mid-run emissions (the command runs ~1.4 s; the gate is
        // 500 ms), and the last one already saw a later tick than the first.
        assert!(tails.len() >= 2, "expected >=2 live tails, got {}", tails.len());
        assert!(!tails[0].contains("tick 7"), "first tail must be mid-run");
        assert!(tails.last().unwrap().contains("tick"), "{}", tails.last().unwrap());
        fs::remove_dir_all(&tmp).ok();
    }

    thread_local! {
        static TAILS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    #[test]
    fn tmp_read_missing_file_lists_siblings() {
        let dir = std::env::temp_dir().join(format!("codifa-sib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stats.py"), "x=1").unwrap();
        std::fs::write(dir.join("test_stats.py"), "t").unwrap();
        std::fs::write(dir.join("README.md"), "r").unwrap();
        let root = dir.to_str().unwrap().to_string();
        let err = dispatch(&root, "read", &json!({"filePath": "stat.py"}), None).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        assert!(err.contains("stats.py"), "{err}");
        assert!(err.contains("test_stats.py"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
