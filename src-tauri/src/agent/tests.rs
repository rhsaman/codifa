// Tests
// ---------------------------------------------------------------------------


    use super::*;

    #[test]
    fn edit_target_event_serializes_target_action_name_and_path() {
        let v = AgentEvent::EditTarget {
            target: "plugin".into(),
            action: "update".into(),
            name: "healer".into(),
            path: "/data/plugins/healer".into(),
        }
        .to_json();
        assert_eq!(v["kind"], "edit_target");
        assert_eq!(v["target"], "plugin");
        assert_eq!(v["action"], "update");
        assert_eq!(v["name"], "healer");
        assert_eq!(v["path"], "/data/plugins/healer");
    }

    #[test]
    fn edit_target_of_marks_existing_skill_and_mcp_as_update_new_ones_as_none() {
        let dir = std::env::temp_dir().join(format!("codifa-edit-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("skills")).unwrap();
        // Nothing stored under the name yet: a first create is not an update.
        assert!(edit_target_of("create_skill", &json!({"name": "Probe Skill"}), &dir).is_none());
        // Create the skill for real, then the EDIT is recognized and pins its
        // own folder.
        crate::tools::dispatch_with_data_root(
            dir.to_str().expect("temp path is utf-8"),
            "create_skill",
            &json!({
                "name": "Probe Skill",
                "description": "probe",
                "content": "step 1",
            }),
            None,
            None,
        )
        .expect("create the probe skill");
        let pin = edit_target_of("create_skill", &json!({"name": "Probe Skill"}), &dir)
            .expect("an existing skill counts as an update");
        assert_eq!(pin.0, "skill");
        assert!(
            std::path::Path::new(&pin.2).is_dir(),
            "the pinned folder must be the skill's own folder: {}",
            pin.2
        );
        // A delete call never pins the badge.
        assert!(edit_target_of(
            "create_skill",
            &json!({"name": "Probe Skill", "delete": true}),
            &dir,
        )
        .is_none());
        // Connectors: none stored yet → no pin.
        assert!(edit_target_of(
            "create_mcp",
            &json!({"name": "Probe MCP", "command": "echo"}),
            &dir,
        )
        .is_none());
    }

    /// Model choice on media tools is a USER setting (Settings → Media
    /// Providers), never an agent lever: no media schema may expose a
    /// per-call `model` argument, otherwise the agent could silently pick
    /// other providers' models and spend the user's credit elsewhere.
    #[test]
    fn media_tool_schemas_expose_no_per_call_model_override() {
        let schemas = media_tool_schemas("ag/gemini-3.1-flash-image", "sora-2");
        let by_name: std::collections::HashMap<&str, &Value> = schemas
            .iter()
            .map(|s| (s["function"]["name"].as_str().expect("tool name"), s))
            .collect();
        for tool in ["generate_image", "edit_image", "generate_video"] {
            let schema = by_name
                .get(tool)
                .unwrap_or_else(|| panic!("{tool} schema missing"));
            let props = &schema["function"]["parameters"]["properties"];
            assert!(
                !props.get("model").is_some(),
                "{tool} must not expose a per-call `model` argument"
            );
            // The user-facing arguments that DO belong to the agent survive.
            assert!(props.get("prompt").is_some(), "{tool} needs prompt");
            assert!(props.get("output").is_some(), "{tool} needs output");
        }
        // The descriptions still name the slot defaults so the model knows
        // what it will hit before the call costs anything.
        let gen = by_name.get("generate_image").expect("generate_image");
        assert!(gen["function"]["description"]
            .as_str()
            .unwrap_or_default()
            .contains("ag/gemini-3.1-flash-image"));
    }

    /// Every delegation tool goes through ONE branch: the builtin `explore` and
    /// each installed profile. The prefix is what keeps a bundle's `reviewer`
    /// from shadowing a native tool, so it must be recognised and stripped.
    #[test]
    fn a_plugin_profile_is_advertised_under_the_delegation_prefix() {
        assert!(is_delegation("explore"));
        assert!(is_delegation(&delegation_tool_name("Code Reviewer")));
        assert_eq!(delegation_tool_name("Code Reviewer"), "agent__code_reviewer");
        // A native tool is never mistaken for a sub-agent, however it is spelled.
        assert!(!is_delegation("read"));
        assert!(!is_delegation("reviewer"));
    }

    /// A profile can only NARROW: naming a tool the research set does not hold
    /// must not add it, and an empty declaration keeps the full set.
    #[test]
    fn a_profile_narrows_the_research_tool_set_and_never_widens_it() {
        let mut schemas = research_schemas();
        let before = schemas.len();
        retain_subagent_tools(
            &mut schemas,
            &["read".to_string(), "write_file".to_string()],
        );
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert_eq!(names, vec!["read"], "only the declared, existing tool survives");

        // No declaration at all = the builtin explore set, untouched.
        let mut schemas = research_schemas();
        retain_subagent_tools(&mut schemas, &[]);
        assert_eq!(schemas.len(), before);
    }

    /// The single model decision: EVERY sub-agent reads the `explore` slot, so
    /// one Settings row controls what all of them cost.
    #[test]
    fn every_subagent_resolves_its_model_from_the_explore_slot() {
        let mut req = base_req();
        req.model = "main-model".into();
        req.subagent_models = std::collections::HashMap::from([(
            "explore".to_string(),
            "second-model".to_string(),
        )]);
        let (model, _, _, _) = resolve_subagent_target(&req);
        assert_eq!(model, "second-model", "the explore row must win");

        // An empty slot falls back to the parent model rather than inventing one.
        req.subagent_models.clear();
        let (model, _, _, _) = resolve_subagent_target(&req);
        assert_eq!(model, "main-model");
    }

    /// A plugin PROFILE cannot pick its own model: an installed sub-agent runs on
    /// the `explore` row of Settings → Tools, exactly like the builtin `explore`,
    /// and walks the SAME `tool_fallbacks["explore"]` list. Otherwise a bundle
    /// would silently introduce a model the user never chose and cannot see.
    #[test]
    fn a_plugin_profile_runs_on_the_explore_slot_not_one_of_its_own() {
        let mut req = base_req();
        req.model = "main-model".into();
        req.subagent_models = std::collections::HashMap::from([
            ("explore".to_string(), "slot-model".to_string()),
            // A bundle naming its own slot must be ignored: only `explore` is read.
            ("reviewer".to_string(), "bundle-model".to_string()),
        ]);
        req.tool_fallbacks = std::collections::HashMap::from([(
            "explore".to_string(),
            vec!["fallback-a".to_string(), "fallback-b".to_string()],
        )]);

        // The chain one profile's ladder would walk: the slot model first, then
        // the explore row's fallbacks in the user's order.
        let chain = crate::backend_light::resolve_slot_chain(
            "slot-model",
            req.tool_fallbacks.get("explore").map(Vec::as_slice).unwrap_or(&[]),
            &req.model,
            &req.base_url,
            &req.api_keys,
            &req.provider_id,
            &req.provider,
            &req.providers,
        );
        let models: Vec<&str> = chain.iter().map(|rung| rung.0.as_str()).collect();
        assert_eq!(models.first(), Some(&"slot-model"), "the Explore row comes first");
        assert_eq!(
            models,
            vec!["slot-model", "fallback-a", "fallback-b"],
            "a profile walks the explore fallback list, in order"
        );
        // And the bundle's own slot entry is NOT what the ladder resolved.
        assert!(!models.contains(&"bundle-model"));
    }

    #[test]
    fn load_plugin_env_parses_pairs_and_skips_comments_and_junk() {
        let dir = std::env::temp_dir().join(format!("codifa-plugin-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".env"),
            "# comment\n\nKEY=value\nQUOTED=\"v 1\"\nexport SEC=2\nBAD-KEY=x\n=",
        )
        .unwrap();
        let vars = crate::plugins::load_plugin_env(&dir);
        assert_eq!(
            vars,
            vec![
                ("KEY".to_string(), "value".to_string()),
                ("QUOTED".to_string(), "v 1".to_string()),
                ("SEC".to_string(), "2".to_string()),
            ]
        );
    }

    /// A gate must name its chat, and deleting a chat must release its gates.
    ///
    /// The old map held only the oneshot, so the only removals were
    /// `deliver_answer` and the waiter's own cancel tick. A chat deleted while
    /// its popup was still open left the blocked turn task parked forever — and
    /// that task owns the chat's entire `Vec<Value>` message history.
    #[test]
    fn deleting_a_chat_releases_its_answer_gates() {
        let (tx_a, _rx_a) = tokio::sync::oneshot::channel::<Value>();
        let (tx_b, _rx_b) = tokio::sync::oneshot::channel::<Value>();
        {
            let mut gates = answer_gates().lock().unwrap_or_else(|e| e.into_inner());
            gates.insert("gate-a".into(), ("chat-a".into(), tx_a));
            gates.insert("gate-b".into(), ("chat-b".into(), tx_b));
        }

        forget_chat("chat-a");

        let gates = answer_gates().lock().unwrap_or_else(|e| e.into_inner());
        assert!(!gates.contains_key("gate-a"), "chat-a's gate must be gone");
        assert!(gates.contains_key("gate-b"), "chat-b's gate must survive");
        drop(gates);

        // An empty id must never sweep the whole map (an unset chat id is a
        // programming error, not "delete everything").
        forget_chat("   ");
        assert!(answer_gates()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key("gate-b"));
    }

    /// The gate record carries the owning chat, which is what makes the release
    /// above possible at all.
    #[test]
    fn a_gate_records_its_owning_chat() {
        let (tx, _rx) = tokio::sync::oneshot::channel::<Value>();
        answer_gates()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("gate-owner".into(), ("chat-owner".into(), tx));
        let gates = answer_gates().lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(gates.get("gate-owner").map(|(c, _)| c.as_str()), Some("chat-owner"));
        drop(gates);
        forget_chat("chat-owner");
    }

    #[test]
    fn clip_trace_text_cuts_on_a_utf8_boundary() {
        // A multi-byte char straddling the cap must not panic (byte slicing
        // mid-char is exactly what broke Persian text before).
        let s = "سلام دنیا".repeat(10);
        let clipped = clip_trace_text(&s, 7);
        assert!(clipped.ends_with("… (truncated)"));
        assert!(clipped.chars().next().is_some());
        // Short input is returned untouched — no marker, no copy damage.
        assert_eq!(clip_trace_text("abc", 100), "abc");
    }

    #[test]
    fn trace_prompt_text_keeps_the_wire_conversation() {
        // The llm row's `prompt` must show what the model was actually sent:
        // the user line, prior assistant text and tool results — with the
        // system message reduced to a size marker (it lives on the `prompt`
        // row in full).
        let messages = vec![
            serde_json::json!({"role": "system", "content": "you are helpful"}),
            serde_json::json!({"role": "user", "content": "سلام"}),
            serde_json::json!({
                "role": "assistant",
                "content": "checking",
                "tool_calls": [{
                    "id": "c1",
                    "function": {"name": "read", "arguments": "{\"filePath\":\"a.ts\"}"}
                }],
            }),
            serde_json::json!({"role": "tool", "tool_call_id": "c1", "content": "line 1"}),
        ];
        let text = trace_prompt_text(&messages);
        assert!(text.contains("[system] 15 chars"), "system marker missing: {text}");
        assert!(!text.contains("you are helpful"), "system body must be elided");
        assert!(text.contains("[user]\nسلام"));
        assert!(text.contains("[assistant]\nchecking"));
        assert!(text.contains("→ read("), "tool call shorthand missing: {text}");
        assert!(text.contains("[tool]\nline 1"));
        // An empty conversation must not produce a row body of whitespace.
        assert_eq!(trace_prompt_text(&[]), "");
    }

    #[test]
    fn trace_prompt_text_keeps_the_newest_block_within_the_cap() {
        // `clip_trace_text` keeps the HEAD, so an over-cap wire prompt used to
        // drop the newest tool result — and with it any batching hint appended
        // to that same message, which made the single-call lever impossible to
        // verify from a trace. The newest block must survive the cap.
        let big = "x".repeat(9_000);
        let messages = vec![
            serde_json::json!({"role": "system", "content": "sys"}),
            serde_json::json!({"role": "user", "content": "older turn"}),
            serde_json::json!({"role": "tool", "content": big}),
            serde_json::json!({"role": "tool", "content": "NEWEST-RESULT\n\n[hint] That step had ONE call."}),
        ];
        let text = trace_prompt_text(&messages);
        assert!(text.len() <= LLM_TRACE_PROMPT_CAP, "row body must stay capped: {}", text.len());
        assert!(text.contains("NEWEST-RESULT"), "newest block was cut: {text}");
        assert!(text.contains("[hint] That step had ONE call."), "hint was cut: {text}");
        // The head is still there, and the elision is explicit rather than silent.
        assert!(text.contains("[system] 3 chars"), "head lost: {text}");
        assert!(text.contains("elided middle"), "elision must be visible: {text}");
        // Under the cap nothing is elided at all.
        let small = trace_prompt_text(&[serde_json::json!({"role": "user", "content": "hi"})]);
        assert!(!small.contains("elided middle"), "{small}");
    }

    /// Model id the live explore test asserts on (mirror of the backend_light
    /// live-test constant): distinctive enough that a bug which sends the
    /// parent's model instead of the slot's can never pass by luck.
    const MOCK_MODEL: &str = "slot-mock/sentinel-model";

    #[test]
    fn event_json_shapes_match_python_protocol() {
        assert_eq!(
            AgentEvent::Text { content: "hi".into() }.to_json(),
            json!({"kind": "text", "content": "hi"})
        );
        assert_eq!(
            AgentEvent::Done { aborted: true }.to_json(),
            json!({"kind": "done", "aborted": true})
        );
        let t = AgentEvent::Tool {
            id: "call1".into(),
            name: "read".into(),
            args: json!({"filePath": "a"}),
            result: "x".into(),
            ok: true,
            results: None,
            engine: None,
        }
        .to_json();
        // Finished tools resolve the running card minted by ToolStart.
        assert_eq!(t["kind"], "tool_result");
        assert_eq!(t["name"], "read");
        assert_eq!(t["ok"], true);
        // The provider tool_call id rides along so the frontend can dedup
        // (no duplicate cards) and re-pair start/result events.
        assert_eq!(t["id"], "call1");
        let t = AgentEvent::Usage {
            input_tokens: 3,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_read_reported: false,
            cache_write_reported: false,
            model: "sub-model".into(),
            provider_id: "p2".into(),
            sub: true,
            context_tokens: 0,
            context_window: 0,
            reasoning_chars: 0,
        }
        .to_json();
        // Sub-agent usage is flagged so the context meter ignores it.
        assert_eq!(t["sub"], true);
        // The usage event names the model/provider that served the request so
        // sub-agent tokens land under the SUB model in Model usage.
        assert_eq!(t["model"], "sub-model");
        assert_eq!(t["provider_id"], "p2");
        // `context_tokens` is the prompt the provider billed — the number the
        // auto-compaction trigger compares against, so the meter and the fold
        // agree.
        assert_eq!(t["context_tokens"], 0);
        let t = AgentEvent::Usage {
            input_tokens: 900,
            output_tokens: 10,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_read_reported: false,
            cache_write_reported: false,
            model: "main".into(),
            provider_id: "p1".into(),
            sub: false,
            context_tokens: 900,
            context_window: 200_000,
            reasoning_chars: 120,
        }
        .to_json();
        // The observed reasoning size rides the usage event, so the renderer
        // can learn that a capability-silent gateway model really reasons.
        assert_eq!(t["reasoning_chars"], 120);
        assert_eq!(t["context_tokens"], 900);
        // The denominator the trigger uses — the renderer divides by it so the
        // ring and the fold cannot drift apart.
        assert_eq!(t["context_window"], 200_000);
        let ts = AgentEvent::ToolStart {
            id: "call1".into(),
            name: "explore".into(),
            args: json!({}),
        }
        .to_json();
        assert_eq!(ts["kind"], "tool");
        assert_eq!(ts["tool"], "explore");
        assert_eq!(ts["id"], "call1");
    }

    #[test]
    fn branch_wrapper_tags_the_inner_event_without_changing_its_shape() {
        let inner_call = AgentEvent::ToolStart {
            id: "c9".into(),
            name: "grep".into(),
            args: json!({"pattern": "x"}),
        };
        let v = AgentEvent::Branch { branch: 7, sub: true, inner: Box::new(inner_call) }.to_json();
        assert_eq!(v["kind"], "tool");
        assert_eq!(v["tool"], "grep");
        assert_eq!(v["id"], "c9");
        assert_eq!(v["branch"], 7);
        assert_eq!(v["sub"], true);
        // The explore card's own start carries the branch but is NOT a sub
        // event — it has to stay a top-level card the children nest under.
        let card = AgentEvent::Branch {
            branch: 7,
            sub: false,
            inner: Box::new(AgentEvent::ToolStart {
                id: "e1".into(),
                name: "explore".into(),
                args: json!({}),
            }),
        }
        .to_json();
        assert_eq!(card["branch"], 7);
        assert_eq!(card["sub"], false);
    }

    #[test]
    fn compact_subagent_never_orphans_tool_messages() {
        // If the tail boundary lands on a `tool` message whose assistant
        // tool_calls were compacted away, providers reject the orphan with
        // a 400. The tail must extend back to keep the pair together.
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        for _ in 0..40 {
            messages.push(json!({
                "role": "user",
                "content": "متن فارسی طولانی برای عبور از بودجه ی اتوکامپکت ".repeat(30),
            }));
        }
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{ "id": "c1", "type": "function" }],
        }));
        messages.push(json!({ "role": "tool", "tool_call_id": "c1", "content": "نتیجه ابزار" }));
        messages.push(json!({ "role": "user", "content": "ادامه بده" }));
        messages.push(json!({ "role": "assistant", "content": "پاسخ" }));
        messages.push(json!({ "role": "user", "content": "یکی دیگر" }));
        compact_subagent_messages(&mut messages, 4096);
        // Every tool message must be preceded by its assistant tool_calls.
        for (i, m) in messages.iter().enumerate().skip(1) {
            if m["role"] == "tool" {
                assert!(
                    messages[i - 1]["tool_calls"].is_array(),
                    "orphan tool message at index {i}"
                );
            }
        }
    }

    #[test]
    fn history_recap_carries_tool_results_not_just_calls() {
        // A recap that lists only tool names tells the model a grep ran but
        // not what it found, so it re-runs the same search next turn. The
        // result digest must survive into the recap.
        let m = json!({
            "role": "assistant",
            "content": "done",
            "toolActivity": [
                {"tool": "grep", "args": {"pattern": "foo"}, "status": "done",
                 "summary": "3 hits in 2 files"},
                {"tool": "read", "status": "running"}
            ]
        });
        let recap = history_recap(&m);
        assert!(recap.contains("grep"), "{recap}");
        assert!(recap.contains("3 hits in 2 files"), "{recap}");
        // A still-running call is not reported as completed work.
        // (Match the list item, not the bare word: "already" contains "read".)
        assert!(!recap.contains("- read"), "{recap}");
    }

    #[test]
    fn history_recap_carries_explore_findings_at_length() {
        // explore's findings reach the backend only as `resultText` (the
        // frontend stores prose results verbatim for prose-only tools, and
        // explore/task are among them). Recap the call without the findings and
        // the next turn re-delegates research it already paid for, so the
        // report must survive AND keep more than an ordinary tool's digest.
        let report = "x".repeat(2_000);
        let m = json!({
            "role": "assistant",
            "content": "researched",
            "toolActivity": [
                {"tool": "explore", "args": {"prompt": "trace usage"}, "status": "done",
                 "resultText": report},
                {"tool": "lsp_hover", "args": {}, "status": "done",
                 "resultText": "fn usage_meter() -> Usage"}
            ]
        });
        let recap = history_recap(&m);
        assert!(
            recap.contains(&"x".repeat(1_000)),
            "explore report must survive beyond the ordinary digest cap: {}",
            recap.len()
        );
        assert!(recap.contains("usage_meter"), "{recap}");
    }

    #[test]
    fn explore_report_echo_is_not_cut_below_the_recap_budget() {
        // The recap can only carry what the UI echo kept (`resultText`), so the
        // echo budget for a report may never be smaller than the recap's.
        assert!(ui_echo_cap("explore") >= RECAP_EXPLORE_CHARS);
        assert_eq!(ui_echo_cap("grep"), TOOL_RESULT_CAP);
    }

    #[test]
    fn compact_subagent_messages_persian_char_boundaries() {
        // The explore sub-agent compacts Persian content — the 400-byte cut
        // used to slice mid-char and panic (compact.rs:103 crash report).
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        for _ in 0..50 {
            messages.push(json!({
                "role": "user",
                "content": "این یک متن فارسی طولانی برای آزمایش برش ایمن نویسه‌هاست ".repeat(20),
            }));
        }
        messages.push(json!({ "role": "user", "content": "گزارش نهایی" }));
        compact_subagent_messages(&mut messages, 4096);
        // Head + summary + tail survive, all valid UTF-8 (no panic above).
        assert!(messages.len() >= 3);
        assert!(messages[0]["content"] == "sys");
        let summary = messages[1]["content"].as_str().unwrap();
        assert!(summary.contains("[Earlier research compacted]"));
        assert!(messages.last().unwrap()["content"] == "گزارش نهایی");
    }

    #[test]
    fn tool_schemas_main_agent_has_bounded_reads_but_no_discovery() {
        let schemas = tool_schemas(false, true);
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        // The main agent may read files its step already NAMED, grep one
        // known token, and locate a symbol it already knows the NAME of: a
        // narrow question used to cost a full `explore` delegation (~26K
        // uncached tokens, ~4 rounds) or a line-hunting read storm when one
        // main round (~7.7K) answers it. What stays delegated is DISCOVERY —
        // finding out WHICH files exist — plus the tools that are not a
        // lookup at all.
        for allowed in [
            "read",
            "grep",
            "find_symbol",
            "lsp_symbols",
            // The three position-based LSP lookups: 92.2% of every read window
            // in the corpus sits in a language with a registered server, so
            // these serve the targeted search wherever the model actually reads.
            "lsp_definition",
            "lsp_references",
            "lsp_hover",
            // Diagnostics belong to the same family and were the gap that
            // mattered most: they were NEVER called in the traced corpus (0 of
            // 1_035 tool calls) while 37 manual typecheck/build rounds ran, 12
            // of them right after an edit. This tool runs NO build — it reads
            // the `publishDiagnostics` a live server has already published, so
            // it replaces a whole round-trip with an answer about the same
            // file. (An earlier version of this test banned it, claiming it
            // re-ran `cargo check`; that was wrong and cost the lever.)
            "lsp_diagnostics",
            // The memory tools are shared with the explore sub-agent: a saved
            // note is the project's own context, and reaching it through a
            // delegation charged a whole sub-agent round for one lookup.
            "search_memory",
            "save_memory",
            "delete_memory",
        ] {
            assert!(names.contains(&allowed), "main agent must have {allowed}");
        }
        for banned in [
            // Pure discovery: finding out WHICH files exist stays with the
            // sub-agent, whose report the main agent works from.
            "glob",
        ] {
            assert!(!names.contains(&banned), "main agent must not have {banned}");
        }
        assert!(names.contains(&"explore"));
        assert!(names.contains(&"edit_file"));
        assert!(names.contains(&"run_terminal"));
        // Web search is not file discovery: the main agent may search the web
        // itself (the engines come from Settings → Plugins).
        assert!(names.contains(&"web_search"));

        // Batching lives in `ranges`, never in a bare file list: `paths` forced
        // ONE window on every file and could name a file twice, sending the same
        // bytes to the model twice. Neither agent may offer it again.
        for listed in [tool_schemas(false, true), research_schemas()] {
            let read = listed
                .iter()
                .find(|s| s["function"]["name"] == "read")
                .expect("read schema");
            let props = &read["function"]["parameters"]["properties"];
            assert!(
                props["paths"].is_null(),
                "read must batch through ranges, not paths: {props}"
            );
            assert!(props["ranges"].is_object(), "read must keep ranges: {props}");
        }
    }

    #[test]
    fn plugin_run_follows_the_terminal_cap_not_write_files() {
        // "ترید کن" in Ask must fire an MT5-style plugin script: the script is
        // a command like any other and Ask's mutating-command gate covers its
        // effect. The old gate demanded `write_files` too, so Ask refused every
        // plugin run purely for not allowing edits — while shell commands ran.
        assert!(plugin_mode_refusal("run", &caps_for_mode("ask")).is_none());
        assert!(plugin_mode_refusal("run", &caps_for_mode("build")).is_none());
        // Without the terminal there is nothing to run the script with.
        assert!(plugin_mode_refusal(
            "run",
            &ToolCaps {
                run_terminal: false,
                ..ToolCaps::default()
            }
        )
        .is_some());
        // The mirror image: authoring actions WRITE the bundle, so a read-only
        // mode refuses them even when sticky allow_create armed the tool —
        // this is the gate that stops Ask from "updating the plugin" instead
        // of running it. Build may still author.
        assert!(plugin_mode_refusal("update", &caps_for_mode("ask")).is_some());
        assert!(plugin_mode_refusal("toggle", &caps_for_mode("ask")).is_some());
        assert!(plugin_mode_refusal("update", &caps_for_mode("build")).is_none());
        assert!(plugin_mode_refusal("list", &caps_for_mode("plan")).is_none());
    }

    #[test]
    fn schedule_refusal_mirrors_the_plugin_gate() {
        // Listing is reading: every mode may do it, and Build/unknown may write.
        assert!(schedule_mode_refusal("list", &caps_for_mode("ask")).is_none());
        assert!(schedule_mode_refusal("list", &caps_for_mode("plan")).is_none());
        assert!(schedule_mode_refusal("create", &caps_for_mode("build")).is_none());
        // The writes follow `write_files`: a read-only turn refuses them even
        // with a sticky allow_create, in the same words the plugin gate uses.
        for action in ["create", "update", "toggle", "delete"] {
            let refusal = schedule_mode_refusal(action, &caps_for_mode("ask"))
                .unwrap_or_else(|| panic!("ask must refuse schedule {action}"));
            assert!(refusal.contains("read-only"), "{refusal}");
            assert!(refusal.contains("action=list"), "{refusal}");
        }
    }

    #[test]
    fn authoring_tools_follow_write_files_wherever_they_come_from() {
        // A sticky `allow_create` (an authoring request earlier in the chat)
        // must not arm the authoring tools in a read-only turn: the schema
        // filter drops them for a non-authoring turn, and `denied_by_caps`
        // drops AND refuses them for a turn that cannot write — the second
        // gate a stale transcript or a hallucinated call meets.
        let caps = ToolCaps { write_files: false, ..ToolCaps::default() };
        for name in ["create_skill", "create_mcp"] {
            let refusal = denied_by_caps(&caps, name)
                .unwrap_or_else(|| panic!("{name} must be gated on write_files"));
            assert!(refusal.contains("read-only"), "{refusal}");
        }
        // A writable turn keeps them (the allow_create filter governs there).
        assert!(denied_by_caps(&caps_for_mode("build"), "create_mcp").is_none());
    }

    #[test]
    fn read_only_turns_see_the_compact_read_schema() {
        // Ask (caps.write_files=false): the schema list is the first gate —
        // authoring is ABSENT, plugin is list/run only, and schedule stays
        // reachable but list-only, so "what is scheduled" costs no refusal.
        let mut schemas = tool_schemas(false, false);
        let ask = caps_for_mode("ask");
        retain_allowed_tools(&mut schemas, &ask, "ask");
        compact_plugin_schema(&mut schemas);
        compact_schedule_schema(&mut schemas);
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(!names.contains(&"create_skill"), "ask must not offer create_skill");
        assert!(!names.contains(&"create_mcp"), "ask must not offer create_mcp");
        assert!(names.contains(&"plugin"), "ask keeps the plugin door");
        assert!(names.contains(&"schedule"), "ask keeps schedule for listing");
        let plugin = schemas
            .iter()
            .find(|s| s["function"]["name"] == "plugin")
            .unwrap();
        let plugin_enum: Vec<&str> = plugin["function"]["parameters"]["properties"]["action"]
            ["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(plugin_enum, ["list", "run"], "ask plugin enum");
        let schedule = schemas
            .iter()
            .find(|s| s["function"]["name"] == "schedule")
            .unwrap();
        let schedule_enum: Vec<&str> = schedule["function"]["parameters"]["properties"]["action"]
            ["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(schedule_enum, ["list"], "ask schedule enum");
    }

    #[test]
    fn authoring_turns_keep_the_full_schedule_schema() {
        // Build with allow_create: the full schedule enum rides, and the
        // authoring tools are present — the compact forms must only ever
        // narrow a turn that cannot write.
        let schemas = tool_schemas(true, false);
        let schedule = schemas
            .iter()
            .find(|s| s["function"]["name"] == "schedule")
            .expect("schedule must stay in the base list");
        let schedule_enum: Vec<&str> = schedule["function"]["parameters"]["properties"]["action"]
            ["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            schedule_enum,
            ["list", "create", "update", "toggle", "delete"],
            "authoring schedule enum"
        );
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"create_skill"));
        assert!(names.contains(&"create_mcp"));
    }

    #[test]
    fn a_headless_build_run_still_lists_but_not_authors_schedules() {
        // The scheduler sends `allow_create: false` with writable caps: today
        // such a run had NO schedule tool at all and could not even answer
        // "what is scheduled". It must get the list-only schema — the writes
        // stay with an authoring turn.
        let mut schemas = tool_schemas(false, false);
        let caps = caps_for_mode("build");
        retain_allowed_tools(&mut schemas, &caps, "build");
        compact_schedule_schema(&mut schemas);
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(!names.contains(&"create_skill"));
        assert!(!names.contains(&"create_mcp"));
        assert!(names.contains(&"schedule"));
        let schedule = schemas
            .iter()
            .find(|s| s["function"]["name"] == "schedule")
            .unwrap();
        assert_eq!(
            schedule["function"]["parameters"]["properties"]["action"]["enum"],
            json!(["list"])
        );
    }

    #[test]
    fn discovery_tools_are_withheld_from_the_main_agent_by_name() {
        // The schema list is not the only gate: a stale transcript can still
        // call a withheld name, so the retainer must drop it for the main agent
        // and keep it for the sub-agent.
        let mut main: Vec<Value> = tool_schemas(false, false);
        retain_allowed_tools(&mut main, &caps_for_mode("build"), "build");
        let main_names: Vec<&str> = main
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(!main_names.contains(&"glob"));
        // `read` follows the read capability, so a mode that may not read the
        // workspace cannot reach it either.
        let mut ask: Vec<Value> = tool_schemas(false, false);
        retain_allowed_tools(&mut ask, &caps_for_mode("ask"), "ask");
        assert!(ask
            .iter()
            .any(|s| s["function"]["name"].as_str() == Some("read")));
        let mut no_read: Vec<Value> = tool_schemas(false, false);
        retain_allowed_tools(
            &mut no_read,
            &ToolCaps {
                read_files: false,
                ..ToolCaps::default()
            },
            "build",
        );
        assert!(!no_read
            .iter()
            .any(|s| matches!(
                s["function"]["name"].as_str(),
                Some("read") | Some("grep") | Some("glob")
            )));
        // A sub-agent keeps the whole search set.
        let mut sub: Vec<Value> = research_schemas();
        retain_allowed_tools(&mut sub, &caps_for_mode("subagent"), "subagent");
        assert!(sub
            .iter()
            .any(|s| s["function"]["name"].as_str() == Some("glob")));
    }

    #[test]
    fn ask_mode_withholds_the_mutating_tools() {
        // Ask is read-only for real: the model must not even see a tool that
        // could touch the disk, and a call that still arrives is refused.
        let names = |caps: &ToolCaps| -> Vec<String> {
            let mut schemas = tool_schemas(true, false);
            retain_allowed_tools(&mut schemas, caps, "build");
            schemas
                .iter()
                .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
                .collect()
        };

        let ask = names(&caps_for_mode("ask"));
        for banned in ["write_file", "edit_file"] {
            assert!(
                !ask.contains(&banned.to_string()),
                "ask must not bind {banned}"
            );
        }
        // Reading stays wide open: the sub-agent, the web, and the SHELL —
        // inspecting IS reading (`du -sh`, `df -h`, `ps`, `git status`), so the
        // terminal is bound in every mode and only WRITES are refused.
        assert!(ask.contains(&"explore".to_string()));
        assert!(ask.contains(&"web_search".to_string()));
        assert!(ask.contains(&"fetch_url".to_string()));
        assert!(ask.contains(&"run_terminal".to_string()));

        // Plan may inspect with the terminal but still never writes.
        let plan = names(&caps_for_mode("plan"));
        assert!(!plan.contains(&"write_file".to_string()));
        assert!(!plan.contains(&"edit_file".to_string()));
        assert!(plan.contains(&"run_terminal".to_string()));

        // Build keeps everything, and an id this build does not know stays
        // permissive — a missing table row must not disarm a mode.
        let build = names(&caps_for_mode("build"));
        for kept in ["write_file", "edit_file", "run_terminal"] {
            assert!(build.contains(&kept.to_string()), "build must bind {kept}");
        }
        assert_eq!(build.len(), names(&ToolCaps::default()).len());

        // The backstop, for a call that bypassed the schema list.
        assert!(denied_by_caps(&caps_for_mode("ask"), "write_file").is_some());
        // The terminal is allowed in ask; the COMMAND is what gets refused, by
        // the `!caps.write_files` gate in the tool loop.
        assert!(denied_by_caps(&caps_for_mode("ask"), "run_terminal").is_none());
        assert!(denied_by_caps(&caps_for_mode("build"), "write_file").is_none());
        // A tool the capability table has no opinion on is never gated.
        assert!(denied_by_caps(&ToolCaps::default(), "explore").is_none());
    }

    #[test]
    fn tool_caps_follow_the_renderer_contract() {
        // The renderer sends the `ModeCapabilities` object verbatim, so the keys
        // are camelCase; a missing object must parse as `None` so `run_turn`
        // derives the table from `mode` instead of falling back to permissive.
        let caps: ToolCaps = serde_json::from_value(json!({
            "readFiles": true,
            "writeFiles": false,
            "runTerminal": false,
            "web": true
        }))
        .unwrap();
        assert!(caps.read_files);
        assert!(!caps.write_files);
        assert!(!caps.run_terminal);
        assert!(caps.web);

        let absent: Option<ToolCaps> = serde_json::from_value(json!(null)).unwrap();
        assert!(absent.is_none());
    }

    #[test]
    fn read_only_modes_cannot_write_through_the_terminal() {
        // Plan keeps `run_terminal` (it must run builds and tests), so the
        // capability gate on the tool NAME cannot be the whole story: a shell
        // command can write a file without ever calling `write_file`. Every
        // command that changes the workspace must be refused while the turn may
        // not write, or "read-only" is a lie.
        for cmd in [
            "echo hi > src/app.ts",
            "echo hi >> notes.md",
            "du -sh . 2> disk.log",
            "df -h > usage.txt",
            "cat a.txt > b.txt",
            "sed -i 's/a/b/' src/app.ts",
            "sed -i.bak 's/a/b/' f.ts",
            "perl -pi -e 's/a/b/' f.ts",
            "rm -rf node_modules",
            "/bin/rm -rf build",
            "mv a.ts b.ts",
            "cp a.ts b.ts",
            "mkdir -p src/new",
            "touch newfile.ts",
            "truncate -s 0 app.log",
            "ls | xargs rm",
            "find . -name '*.ts' -delete",
            "git commit -m wip",
            "git add .",
            "git checkout -- src/app.ts",
            "git reset --hard",
            "git stash",
            "npm install left-pad",
            "npm i",
            "pnpm add react",
            "cargo add serde",
            "cargo fmt",
            "pip install requests",
            "brew install jq",
            "prettier --write src",
            "eslint --fix src",
        ] {
            assert!(
                is_mutating_command(cmd),
                "{cmd:?} changes the workspace and must be refused in a read-only mode"
            );
        }

        // The read-only inspection the modes exist for must keep working.
        for cmd in [
            "git status",
            "git diff",
            "git diff --staged",
            "git log --oneline -5",
            "pwd",
            "node --version",
            "npm run build",
            "npm test",
            "cargo test",
            "cargo check 2>&1 | tail -20",
            // The user's real command: a device redirect is not a write.
            "du -sh ~ 2>/dev/null",
            "df -h > /dev/null",
            "du -sh * 2>/dev/null | sort -h",
            "npx tsc --noEmit",
            "prettier --check src",
            "eslint src",
            "find . -iname '*.ts'",
            "sed -n '1,20p' src/app.ts",
        ] {
            assert!(
                !is_mutating_command(cmd),
                "{cmd:?} only inspects and must still run in a read-only mode"
            );
        }
    }

    #[test]
    fn listing_and_measuring_are_reads_but_searching_stays_delegated() {
        let root = env!("CARGO_MANIFEST_DIR");
        // The user's rule: every READ works in every mode, only APPLYING a
        // change needs Build. Listing and measuring read what the caller
        // already knows about, so they must never be refused.
        //
        // Shell SEARCH is refused: the main agent owns `read`/`grep`, so
        // `run_terminal` stays a measurement/build verb.
        for cmd in [
            "ls",
            "ls -la src",
            "ls -1 | head -20",
            "du -sh * | sort -h",
            "df -h",
        ] {
            assert!(
                !is_file_search_command(cmd, root),
                "{cmd:?} lists or reads a known target and must stay allowed"
            );
        }
        for cmd in [
            "grep -rn foo src",
            "rg TODO",
            "find . -name '*.ts'",
            "locate lib.rs",
            "fd main",
            "tree src",
        ] {
            assert!(
                is_file_search_command(cmd, root),
                "{cmd:?} searches and must be delegated to `explore`"
            );
        }
        // A search that FILTERS a command's own output is not file discovery:
        // it inspects a build/test the model just ran, and refusing it cost an
        // extra, larger round trip in real traces.
        for cmd in [
            "cargo test 2>&1 | grep -E \"^(error|test result)\"",
            "npm run build 2>&1 | tail -20 | rg error",
            "git diff | grep '^+'",
            "cargo test > /tmp/t.out 2>&1; echo exit=$?",
        ] {
            assert!(
                !is_file_search_command(cmd, root),
                "{cmd:?} filters a build's own output and must stay allowed"
            );
        }
        // A discovery verb with no bounded native equivalent is refused even
        // in a later segment: `sed -n '1,20p' f.ts | grep foo` filters, but
        // `ls; tree src` still walks the tree.
        assert!(is_file_search_command("ls; tree src", root));
        assert!(is_file_search_command("cargo build && find . -name '*.rs'", root));
    }

    #[test]
    fn traced_oct28_refusals_stay_free() {
        // Five parsing bugs billed a full retry round each on the live traces
        // (26 refusals in one day, 14 of them followed by a SAME-tool retry).
        // One guard per root cause, straight from the traced command text.
        let root = env!("CARGO_MANIFEST_DIR");
        let free = [
            // mvrv45fv r29: sed PROGRAM text (`s/[0-9;]*m//g`) read as a scope
            // dragged a /tmp/-targeted pipeline into "workspace search" and the
            // dump reader judged the program text the file target.
            "sed 's/ESC\\[[0-9;]*m//g' /tmp/win.log | grep -E \"^error|-->\" | head -50",
            // mvrvau0r r7: grep over $D (cargo registry), fd shim 2>/dev/null
            // used to resolve as a bare RELATIVE scope inside the workspace.
            "D=~/.cargo/registry/src/i/windows-sys; grep -rE \"pub fn\" $D/src/lib.rs 2>/dev/null | head -40",
            // mvnrjdlx r37: ~/.codifa plugin/skills grep — allowed tree.
            "grep -ril -E \"metatrader\" ~/.codifa/plugins ~/.codifa/skills 2>/dev/null | head -30",
            // mvrxj97c r21: backslash-escaped space split the token and the
            // orphan half (`Support`) resolved as a relative workspace path.
            "find ~/Library/Application\\ Support -maxdepth 3 -name runs 2>/dev/null",
            // mvrxj97c r21: ~/Library/Logs grep, same fd-shim scope bug.
            "grep -rn \"schedule\" ~/Library/Logs/Codifa/rust.log 2>/dev/null | tail -20",
            // heredoc bodies keep their own statement semantics; `<<'PY'` must
            // never turn a python filter into a scope (mvptzxmh r23 class).
            "cat > /tmp/x.py <<'PY'\nprint(1)\nPY",
        ];
        for cmd in free {
            assert!(
                !workspace_file_read(cmd, root),
                "read-gate refused a free traced command: {cmd}"
            );
            assert!(
                !is_file_search_command(cmd, root),
                "search gate refused a free traced command: {cmd}"
            );
        }
    }


    #[test]
    fn traced_gates_still_catch_the_real_thing() {
        let root = env!("CARGO_MANIFEST_DIR");
        // The refusals that were CORRECT must stay refusals — the native tool
        // answers them in the same round instead of a second terminal round.
        assert!(workspace_file_read(
            "sed -n '6906,7000p' src/agent.rs",
            root
        )); // mvctumh7 r48 class: `read` serves it
        assert!(is_file_search_command(
            "grep -rn \"run_terminal\" src/agent.rs | head -8",
            root
        )); // mvrxj97c r30 class: native grep serves it
        assert!(is_file_search_command(
            "grep -n stream src-tauri/src/llm.rs | head -40",
            root
        )); // mvrxj97c r24 class
        // NEW-build retraces (Oct 28 evening, mvrxj97c r15/r21/r36): a shell
        // VARIABLE as the dump target ($B, "$NEW") names no judgeable file —
        // the old gate resolved it RELATIVELY into "<ws>/$B", a path that only
        // exists inside the gate, and billed 6+ false dump refusals while the
        // model retried the same probe.
        let home = home_dir_str();
        for c in [
            format!("B={home}/Documents/code/codifa/src-tauri/target/release/codifa; strings \"$B\" | grep -c \"sent no response headers\""),
            "NEW=$(ls -t \"$HOME/Library/Application Support/com.codifa.app/terminal-logs/\"*.log | head -1); tail -c 600 \"$NEW\"".to_string(),
            // `[1] strings(...)`: the app's own data root — same trusted class
            // as ~/.codifa — stays a terminal read, not a workspace dump.
            "grep -rn \"schedule\" \"$HOME/Library/Application Support/com.codifa.app/\" 2>/dev/null | tail -20".to_string(),
        ] {
            assert!(
                !workspace_file_read(&c, root),
                "{c:?} must stay a legal terminal read"
            );
        }
        assert!(workspace_file_read("tail -c 800 src-tauri/src/llm.rs", root));
        assert!(is_file_search_command(
            "grep -c \"single.instance\" src-tauri/Cargo.toml",
            root
        ));
        // mvrv45fv r47: the read-only turn guard keeps its teeth for the traced
        // write shape `git push`.
        assert!(is_mutating_command("cd . && git push origin main 2>&1 | tail -3"));
        // mvjpmw3h r63: a GUI-app launcher (`open -a`) is deliberately a READ —
        // it starts a program and writes no files, so a read-only turn can
        // raise MetaTrader 5 and act through its plugin.
        assert!(!is_mutating_command(
            "if ! pgrep -f terminal64 >/dev/null; then\n  open -a MT5\nfi"
        ));
        // ...and stays a READ when only /dev absorbs the stream.
        assert!(!is_mutating_command(
            "for f in ~/.zshenv ~/.zshrc; do grep -n path \"$f\" 2>/dev/null | head; done; uptime"
        ));
    }

    #[test]
    fn ssh_destinations_finds_the_servers_a_command_would_reach() {
        // The direct shapes, with the option noise skipped.
        assert_eq!(
            ssh_destinations("ssh deploy@203.0.113.7 'df -h'"),
            vec!["deploy@203.0.113.7"]
        );
        assert_eq!(
            ssh_destinations("ssh -p 2222 -i ~/.keys/id_ed25519 -o BatchMode=yes prod.db"),
            vec!["prod.db"]
        );
        assert_eq!(
            ssh_destinations("/usr/bin/ssh root@10.0.0.2 systemctl status nginx"),
            vec!["root@10.0.0.2"]
        );
        // scp: either endpoint may be the remote.
        assert_eq!(ssh_destinations("scp out.tar.gz deploy@srv:/tmp/"), vec!["deploy@srv"]);
        assert_eq!(ssh_destinations("scp -P 2200 deploy@srv:/var/x.log ./"), vec!["deploy@srv"]);
        // rsync, sshpass wrapper, sh -c payload.
        assert_eq!(ssh_destinations("rsync -avz ./dist/ admin@web:/srv/app/"), vec!["admin@web"]);
        assert_eq!(ssh_destinations("sshpass -p PW ssh ops@bastion uptime"), vec!["ops@bastion"]);
        assert_eq!(ssh_destinations("sh -c 'ssh git@github.com true'"), vec!["git@github.com"]);
        // Several servers on one line: EVERY new destination must prompt.
        assert_eq!(
            ssh_destinations("ssh a@h1 x; ssh b@h2 y"),
            vec!["a@h1", "b@h2"]
        );
        // The same host twice asks once.
        assert_eq!(ssh_destinations("ssh h1 a && ssh h1 b"), vec!["h1"]);
    }

    #[test]
    fn ssh_destinations_stays_silent_without_a_connection() {
        // Local-only work must never open the popup.
        for cmd in [
            "cargo test 2>&1 | tail -3",
            "git status && git diff --stat",
            "rsync -a src/ dst/ && echo done",
            "cp build/out.tar.gz C:/temp/out.tar.gz",
            "du -sh . ; df -h",
            "echo 'run ssh later'",
        ] {
            assert!(
                ssh_destinations(cmd).is_empty(),
                "{cmd:?} opens no SSH session"
            );
        }
    }

    #[test]
    fn a_trusted_ssh_host_never_prompts_again() {
        let dir = std::env::temp_dir().join(format!("codifa-ssh-hosts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.to_str().unwrap();
        assert!(trusted_hosts(root).is_empty());
        let stored = add_trusted_host(root, "deploy@203.0.113.7").unwrap();
        assert_eq!(stored, "deploy@203.0.113.7");
        // A duplicate stays a single entry; the file survives a re-read.
        add_trusted_host(root, "deploy@203.0.113.7").unwrap();
        assert_eq!(trusted_hosts(root), vec!["deploy@203.0.113.7".to_string()]);
        assert!(add_trusted_host(root, "  ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_prefixed_search_cannot_sneak_past_the_gate() {
        let root = env!("CARGO_MANIFEST_DIR");
        // MEASURED on the live build: 63% of `run_terminal` calls arrive as
        // `cd <path> && …` or with an `export`/assignment prefix. A gate that
        // reads only the raw string's first WORD lets `cd x && grep -rn foo`
        // through — the very shell search this predicate exists to refuse.
        for cmd in [
            "cd src && grep -rn foo .",
            "export PATH=/usr/bin:$PATH; grep -rn foo src",
            "FOO=1 cd src && find . -name '*.rs'",
            "cd a && cd b && tree src",
        ] {
            assert!(
                is_file_search_command(cmd, root),
                "{cmd:?} searches the tree behind its prefix and must be refused"
            );
        }
        // An unrelated absolute `cd` must NOT open the gate for a workspace
        // search, and — the other way round — a search whose OWN scope leaves
        // the workspace is the terminal's job: every native lookup is scoped to
        // the workspace, so refusing it billed one answer twice (the model
        // re-asked with `grep` and failed on the very same path).
        assert!(is_file_search_command("cd src-tauri && grep -rn foo src", root));
        assert!(!is_file_search_command("cd /tmp && grep -rn foo src", root));
        assert!(!is_file_search_command("cd /Users/x/src-tauri && rg TODO src", root));
        assert!(!is_file_search_command("grep -rn foo /tmp/logs", root));
        assert!(!is_file_search_command("rg TODO ~/.config", root));
        // `grep -n "fn a\|fn b" -A 40 file.rs` — the PATTERN is one quoted
        // token, `-A 40` is flag+value, and neither is a path scope: a
        // quote-blind split read both as scopes and refused a grep that lives
        // entirely outside the workspace (mvqksnvw run59, billed one round).
        assert!(!is_file_search_command(
            &format!(
                "grep -n \"fn build_article_prompt\\|fn article_prompt\\|build_prompt\" -A 40 {}/.codifa/plugins/healer-article/scripts/generate-article/main.rs",
                home_dir_str()
            ),
            root
        ));
        // A redirect must not blind the gate either way: `rg foo src/ >
        // /tmp/o` still SEARCHES the workspace (the early-return escape),
        // while `grep -rn pattern /tmp/hg_home.html` (a temp FILE) stays a
        // terminal job under the always-allowed rule.
        assert!(is_file_search_command("rg foo src/ > /tmp/o.txt", root));
        assert!(!is_file_search_command(
            "grep -oE 'blogs' /tmp/hg_home.html | sort -u | head -40",
            root
        ));
        // Filtering a command's OWN output is not file discovery, even after a
        // prefix: it inspects a build the model just ran.
        for cmd in [
            "cargo test 2>&1 | grep -E '^error'",
            "cd src-tauri && cargo test 2>&1 | tail -20 | rg error",
        ] {
            assert!(
                !is_file_search_command(cmd, root),
                "{cmd:?} filters its own build output and must stay allowed"
            );
        }
    }

    #[test]
    fn a_workspace_file_is_read_with_read_not_with_cat() {
        // The user's rule: the terminal is for what only the terminal can do.
        // `read` takes several files and windows in ONE call and bounds its
        // output, so a dump of a WORKSPACE file is a refused shell detour.
        let root = env!("CARGO_MANIFEST_DIR");
        for cmd in [
            "cat src/main.rs",
            "sed -n '1,20p' src/main.rs",
            "head -30 src/tools.rs",
            "cd src && cat main.rs",
            "cd . && tac Cargo.toml",
            "awk '{print}' src/main.rs",
        ] {
            assert!(
                workspace_file_read(cmd, root),
                "{cmd:?} dumps a workspace file and must be refused"
            );
        }
        // Out-of-tree reads stay a terminal job: `read` is workspace-scoped,
        // and a build's own output is not a file the model needs bounded.
        for cmd in [
            "cat /tmp/codifa-probe.log",
            "tail -20 /var/log/system.log",
            "cargo test 2>&1 | tail -20",
            "git diff | head -40",
            "ls -la",
            "du -sh *",
        ] {
            assert!(
                !workspace_file_read(cmd, root),
                "{cmd:?} reads outside the workspace or filters output — allowed"
            );
        }
        // `sed -i` REWRITES: that is the mutation gate's business, not this one.
        assert!(!workspace_file_read("sed -i 's/a/b/' src/main.rs", root));
        // Redirect SHIMS must not become the read target. The raw last-token
        // read judged `2>/dev/null` a relative (hence "workspace") path and
        // refused `cat <plugin>/models.json 2>/dev/null` — an ALWAYS-allowed
        // area — and billed run59 a whole round. A write redirect, by
        // contrast, is the mutation gate's business: `> f` is not a dump.
        assert!(!workspace_file_read(
            &format!(
                "cat {}/.codifa/plugins/healer-article/models.json 2>/dev/null | python3 -m json.tool 2>/dev/null | head -60",
                home_dir_str()
            ),
            root
        ));
        assert!(!workspace_file_read(
            "grep -cE 'Key|TOKEN' ~/.codifa/plugins/healer-article/.env",
            root
        ));
        assert!(!workspace_file_read(
            "cat src/main.rs > /tmp/copy.rs 2>&1",
            root
        ));
        // A workspace dump right beside the shims is still refused.
        assert!(workspace_file_read(
            &format!(
                "cat {}/.codifa/x 2>/dev/null; cat src/main.rs",
                home_dir_str()
            ),
            root
        ));
    }

    #[test]
    fn traced_terminal_refusals_stay_allowed() {
        let root = env!("CARGO_MANIFEST_DIR");
        // mvrv45fv r29: a shell VARIABLE is a named-but-unresolvable scope — it
        // must not silently become a workspace scope (cargo-registry grep).
        assert!(!is_file_search_command(
            "D=~/.cargo/registry/src/index.crates.io-1/windows-sys-0.52.0; grep -rE \"pub fn OpenProcess\" $D/src/Windows/Win32/System/Threading/mod.rs",
            root
        ));
        // mvrxj97c r21/24/30: greps over ~/.codifa and /tmp have NO cheaper
        // native substitute (they are outside `read`'s reach) — allowed.
        assert!(!is_file_search_command(
            "grep -ril -E \"metatrader|mql5\" ~/.codifa/plugins ~/.codifa/skills 2>/dev/null | head -30; ls ~/.codifa 2>/dev/null",
            root
        ));
        assert!(!is_file_search_command(
            "grep -c ERR /tmp/agent-bench.log",
            root
        ));
        // mvrv45fv r31 + mvrvau0r r1: middle/last pipeline stages FILTER a
        // stream; they own no file scope at all.
        assert!(!is_file_search_command(
            "perl -ne 'print if /mod.rs/' list.txt | grep -nE \"fn OpenProcess\" | head -20",
            root
        ));
        // Negatives: a named workspace search stays refused…
        assert!(is_file_search_command("grep -rn TODO src/", root));
        // …and so does an owning grep that names NO scope (implied CWD = root).
        assert!(is_file_search_command("rg foo", root));
    }

    #[test]
    fn readonly_shell_probes_stay_allowed_when_the_payload_is_clean() {
        // mvrvau0r r1: the login-PATH probe through `zsh -l -c` inspects, not
        // writes — the payload gate now decides.
        assert!(!is_mutating_command(
            "echo \"== nvim:\"; command -v -a nvim 2>/dev/null; /bin/zsh -l -c 'echo -n $PATH'"
        ));
        // A writing payload through the same shell is still refused…
        assert!(is_mutating_command("/bin/zsh -c 'echo x > src/main.rs'"));
        // …and a redirect into the always-allowed areas stays a read.
        assert!(!is_mutating_command(
            "cargo build > ~/.codifa/traces/build.log 2>&1"
        ));
    }

    #[test]
    fn a_read_only_shell_call_shares_the_round_but_a_writer_never_does() {
        // MEASURED on the live build: one chat spent 10 whole rounds on shell
        // reads (`ls`, `du`, `git status`) that could have run beside its other
        // reads — and every round costs the model ~6-8K uncached tokens.
        let root = env!("CARGO_MANIFEST_DIR");
        for cmd in [
            "ls -la src",
            "du -sh *",
            "git status --short",
            "cargo test 2>&1 | tail -5",
            "lsof -nP -iTCP:5199",
        ] {
            assert!(
                is_shell_read_only(cmd, root),
                "{cmd:?} only reads and may share the round"
            );
        }
        // A writer keeps its own round: the batch runs BEFORE the sequential
        // calls, so a read batched beside a write would run before it.
        for cmd in [
            "git add -A",
            "npm install",
            "cat src/main.rs",
            "grep -rn foo src",
            "cargo test 2>&1 | tee out.log",
        ] {
            assert!(
                !is_shell_read_only(cmd, root),
                "{cmd:?} mutates, searches or dumps — it must keep its own round"
            );
        }
    }

    #[test]
    fn shell_targets_ignores_regex_operands_that_are_not_paths() {
        // MEASURED on the live traces: regex operands landed in the path set
        // and made the access gate ask for `/[Cc]hromium` and `/forkChat/,/^PASS\`
        // — directories that cannot exist, so the round was spent on a prompt
        // the user could only deny.
        for fake in [
            "/[Cc]hromium",
            "/forkChat/,/^PASS\\",
            "/opt/homebrew/opt/node*/bin",
            "foo//bar",
        ] {
            assert!(
                looks_like_pattern(fake),
                "{fake:?} is a pattern operand, never a filename"
            );
        }
        // The real paths the same commands carry must survive.
        for real in [
            "/opt/homebrew/bin/node",
            "~/.nvm/versions/node",
            "/tmp/codifa-live.log",
            "src/lib/store.ts",
            "./node_modules/.bin/tsc",
        ] {
            assert!(
                !looks_like_pattern(real),
                "{real:?} is a real path and must stay in the target set"
            );
        }
    }

    #[test]
    fn the_three_free_roots_never_ask_for_permission() {
        // The user's rule: the workspace, the OS temp folder and ~/.codifa are
        // already trusted — a call that stays inside them must run with no popup.
        // The free-root set is env-dependent (CODER_DATA_DIR moves the store),
        // and the trace/scenario tests mutate that var under DATA_DIR_LOCK —
        // this test must hold the same lock or it races them and reads a
        // temp-dir world in which ~/.codifa is nobody's free root.
        let _lock = crate::memory::tests::DATA_DIR_LOCK.lock();
        let root = env!("CARGO_MANIFEST_DIR");
        let tmp = std::env::temp_dir();
        let probes: Vec<String> = vec![
            "src/main.rs".to_string(),
            "src".to_string(),
            format!("{}/t.rs", tmp.display()),
            "/tmp/codifa-live.log".to_string(),
            // `~` expands via `absolute_target`, so this reaches the real store.
            "~/.codifa/skills".to_string(),
        ];
        for p in probes {
            assert!(
                matches!(
                    crate::tools::path_access(root, &p, None),
                    crate::tools::PathAccess::Free
                ),
                "{p} is inside a free root and must never prompt"
            );
        }
    }

    #[test]
    fn shell_targets_never_reads_a_quoted_program_as_a_path() {
        // MEASURED on a live turn: this exact shape was refused with "The user
        // DENIED access to /Users/<user>" — the workspace's PARENT, a folder the
        // agent was already working inside. The `;` inside the quoted awk
        // program split the command line, one fragment collapsed to a bare `~`
        // (awk's match operator), and the access gate read that as $HOME.
        let cmd = r#"cd /Users/me/proj/src && awk 'NR>=11163 { if (guard) {print start": "name}; start=NR; name=$0; guard=0 } END {print NR": END"}' src/agent.rs | sed 's/^ *//' | head -200"#;
        let targets = shell_targets(cmd);
        assert!(
            !targets.iter().any(|t| t == "~"),
            "a bare `~` is an operator, never home: {targets:?}"
        );
        // The real paths the same command names must survive.
        assert!(
            targets.iter().any(|t| t == "/Users/me/proj/src"),
            "the `cd` target is a real path: {targets:?}"
        );
    }

    #[test]
    fn shell_targets_keeps_a_quoted_path_that_is_really_a_path() {
        // The cure must not un-gate a quoted target: a path with a space is
        // still a path, and writing there still needs permission.
        let targets = shell_targets(r#"cp a.txt "/Users/other/my file.txt""#);
        assert!(
            targets.iter().any(|t| t == "/Users/other/my file.txt"),
            "a quoted absolute path stays in the target set: {targets:?}"
        );
        // Home-relative survives too, so the gate still sees `~/.zshrc`.
        let home = shell_targets("cat ~/.zshrc");
        assert!(home.iter().any(|t| t == "~/.zshrc"), "{home:?}");
    }

    #[test]
    fn a_tool_on_the_users_path_is_never_outside() {
        // MEASURED on the live traces: a plain `node script.js` was classified
        // OUTSIDE (39 touches, 19 unique) and asked for /opt/homebrew/bin or
        // ~/.nvm/... — the very binaries the user's terminal runs unasked.
        let dirs = crate::tools::tool_dirs();
        assert!(
            dirs.iter().any(|d| d.join("node").exists() || d.ends_with("bin")),
            "the user's PATH must resolve to real directories"
        );
        // A binary on the user's OWN PATH, taken from it so the assertion is
        // environment-independent (a test runner's PATH is not the login one).
        let on_path = dirs
            .iter()
            .find(|d| d.ends_with("bin"))
            .expect("a PATH entry ending in `bin`")
            .join("node");
        for rel in [on_path.to_str().unwrap(), "/tmp/x.py"] {
            assert!(
                matches!(
                    crate::tools::path_access(env!("CARGO_MANIFEST_DIR"), rel, None),
                    crate::tools::PathAccess::Free
                ),
                "{rel:?} runs in any terminal without a prompt"
            );
        }
    }

    /// The traced two-round dance this closes: an out-of-tree `edit_file` died
    /// on "path escapes project root" (mvpalezr t1595), the model re-attempted
    /// the change through a shell one-liner, and THAT asked the popup the write
    /// should have asked. The writer must pre-flight like a read does.
    #[test]
    fn a_writer_outside_every_root_asks_before_it_runs() {
        // The "outside" folder must sit outside EVERY free root, so temp is
        // out (it is always open) — this repo itself is the stand-in.
        let outside =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-gate-outside");
        let root = std::env::temp_dir().join("codifa-writer-gate-root");
        std::fs::create_dir_all(&root).unwrap();
        let mut caps = caps_for_mode("build");
        let args = json!({
            "path": outside.join("stt-server.py").to_string_lossy(),
            "old_string": "a", "new_string": "b",
        });
        let folder = outside_target("edit_file", &args, root.to_str().unwrap(), None, &caps)
            .expect("an out-of-tree write must pre-flight");
        assert!(
            outside.starts_with(&folder),
            "the grant must cover the write's own folder: {folder:?}"
        );
        // A read-only mode refuses the call by caps anyway: no popup.
        caps.write_files = false;
        assert!(
            outside_target("edit_file", &args, root.to_str().unwrap(), None, &caps).is_none(),
            "a read-only mode must not show a popup a refusal follows anyway"
        );
        // Inside the workspace no writer asks.
        caps.write_files = true;
        let inside = json!({ "path": "src/a.rs", "old_string": "a", "new_string": "b" });
        assert!(
            outside_target("edit_file", &inside, root.to_str().unwrap(), None, &caps).is_none(),
            "a workspace write never asks"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A plugin script run with an explicit working folder outside the free
    /// set (the bundle folder, ~/.codifa, temp) pre-flights like any other
    /// call; the DEFAULT working folder (the bundle's own) never does.
    #[test]
    fn a_plugin_script_with_an_explicit_outside_cwd_asks() {
        let outside =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-gate-outside");
        let root = std::env::temp_dir().join("codifa-plugin-cwd-root");
        std::fs::create_dir_all(&root).unwrap();
        let caps = caps_for_mode("build");
        let explicit = json!({ "slug": "t", "name": "s", "action": "run",
            "cwd": outside.to_string_lossy() });
        assert!(
            outside_target("plugin", &explicit, root.to_str().unwrap(), None, &caps).is_some(),
            "an explicit outside working folder must ask"
        );
        let default_cwd = json!({ "slug": "t", "name": "s", "action": "run" });
        assert!(
            outside_target("plugin", &default_cwd, root.to_str().unwrap(), None, &caps).is_none(),
            "the default (bundle folder) cwd never asks"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// "Always allow" must outlive the session: the folder is persisted in the
    /// data root and merged into every later turn's permit — including a
    /// headless one, which then never prompts on it.
    #[test]
    fn an_always_allow_folder_survives_into_later_turns() {
        let data = std::env::temp_dir().join(format!("codifa-trust-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        let folder = std::env::temp_dir().join("codifa-trust-folder");
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();

        let mut req = base_req();
        req.data_root = data.to_string_lossy().to_string();
        // No session grant and nothing persisted: no permit, old refusals stay.
        assert!(outside_permit(&req).is_none());
        // Approve for keeps… (the stored path is canonical: /var -> /private/var
        // on macOS, so compare against the canonicalized temp root).
        let stored = add_trusted_folder(&req.data_root, folder.to_str().unwrap()).unwrap();
        let temp_canon = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(std::path::Path::new(&stored).starts_with(&temp_canon));
        // …and the NEXT turn (fresh request, no renderer grant) already has it.
        let permit = outside_permit(&req).expect("a persisted grant must open a permit");
        let folders = permit["folders"].as_array().cloned().unwrap_or_default();
        assert!(
            folders.iter().any(|f| f.as_str() == Some(stored.as_str())),
            "the permit must carry the trusted folder: {folders:?}"
        );
        // And the sandbox actually accepts a path inside it, with no other grant.
        let root = std::env::temp_dir().join("codifa-trust-empty-root");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let target = folder.join("file.txt");
        assert!(
            crate::tools::resolve_safe(
                root.to_str().unwrap(),
                &target.to_string_lossy(),
                true,
                Some(&permit),
            )
            .is_ok(),
            "a trusted folder must open its subtree in resolve_safe"
        );
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&folder);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A headless run must never advertise the ask/confirm tools: there is no
    /// renderer, and a call would park on a gate nobody can resolve.
    #[test]
    fn a_headless_run_is_not_advertised_the_ask_tools() {
        let mut schemas = tool_schemas(false, false);
        assert!(
            schemas.iter().any(|s| s["function"]["name"].as_str() == Some("ask_user")),
            "an interactive build turn keeps ask_user"
        );
        // The same retain the headless branch in run_turn applies.
        schemas.retain(|s| {
            !matches!(
                s["function"]["name"].as_str().unwrap_or(""),
                "ask_user" | "confirm_action" | "request_permission"
            )
        });
        for gone in ["ask_user", "confirm_action", "request_permission"] {
            assert!(
                schemas
                    .iter()
                    .all(|s| s["function"]["name"].as_str() != Some(gone)),
                "{gone} must not be advertised to a scheduled run"
            );
        }
    }

    #[test]
    fn stale_hints_are_elided_but_the_newest_survives() {
        // Every round re-sends the whole conversation, so a hint left in the
        // history is re-billed forever. Only the freshest can still steer the
        // NEXT step; the payload it rode in on must survive untouched.
        let mut msgs = vec![
            json!({"role": "tool", "tool_call_id": "1", "content": "body one\n\n[hint] OLD"}),
            json!({"role": "tool", "tool_call_id": "2", "content": "body two\n\n[hint] MID"}),
            json!({"role": "tool", "tool_call_id": "3", "content": "body three"}),
            json!({"role": "tool", "tool_call_id": "4", "content": "body four\n\n[hint] FRESH"}),
        ];
        strip_stale_hints(&mut msgs);
        assert_eq!(msgs[0]["content"], json!("body one"));
        assert_eq!(msgs[1]["content"], json!("body two"));
        assert_eq!(msgs[2]["content"], json!("body three"));
        assert_eq!(msgs[3]["content"], json!("body four\n\n[hint] FRESH"));
        // Untouched history (no hint at all) is left exactly as it was.
        let mut plain = vec![json!({"role": "tool", "tool_call_id": "1", "content": "x"})];
        strip_stale_hints(&mut plain);
        assert_eq!(plain[0]["content"], json!("x"));
    }

    #[test]
    fn the_terminal_schema_states_the_division_of_labour() {
        // MEASURED on the live build, before this text existed: the model ran
        // 10 rounds of shell reads (`ls`, `du`, `git status`, `cat`) in one chat
        // that its other read-only calls could have shared, and the schema said
        // only "Run a shell command in the workspace with a timeout." A schema
        // that names the wrong tool is paid on every round-trip AND costs the
        // extra rounds, so the division of labour is asserted here.
        let desc = tool_schemas(false, false)
            .iter()
            .find(|s| s["function"]["name"].as_str() == Some("run_terminal"))
            .map(|s| s["function"]["description"].as_str().unwrap_or_default().to_string())
            .expect("run_terminal must be advertised to the main agent");
        for expected in ["does NOT read workspace files", "does NOT locate files", "read", "grep"] {
            assert!(
                desc.contains(expected),
                "the run_terminal schema must name the division of labour ({expected:?} missing): {desc}"
            );
        }
    }

    #[test]
    fn redirects_into_devices_are_reads_but_redirects_into_files_are_writes() {
        // The reported bug: `du -sh ~ 2>/dev/null` was refused in a read-only
        // mode because ANY `>` counted as a write. A device node absorbs the
        // stream and leaves the workspace untouched, so it is a read.
        for cmd in [
            "du -sh ~ 2>/dev/null",
            "df -h > /dev/null",
            "du -sh * 2>/dev/null | sort -h",
            "git status >/dev/null 2>&1",
            "ps aux 2>&1 | head -5",
        ] {
            assert!(
                !is_mutating_command(cmd),
                "{cmd:?} only writes to a descriptor or a device, never to the workspace"
            );
        }
        for cmd in [
            "du -sh . 2> disk.log",
            "df -h > usage.txt",
            "ls >> notes.md",
        ] {
            assert!(
                is_mutating_command(cmd),
                "{cmd:?} redirects into a real file and must be refused"
            );
        }
    }

    #[test]
    fn a_read_only_turn_cannot_smuggle_a_write_through_an_interpreter() {
        // `node -e "fs.writeFileSync(...)"` changes the workspace without naming
        // a single mutating binary, so the eval forms are refused while the turn
        // may not write. A plain run of the same binary stays allowed.
        for cmd in [
            r#"node -e "require('fs').writeFileSync('a','b')""#,
            "python3 -c \"open('a','w')\"",
            "sh -c 'rm -rf src'",
            "bash -c 'echo x > f'",
            "eval $(cat script)",
        ] {
            assert!(
                is_mutating_command(cmd),
                "{cmd:?} can write through an interpreter"
            );
        }
        for cmd in ["node --version", "python --version", "node scripts/build.js"] {
            assert!(
                !is_mutating_command(cmd),
                "{cmd:?} runs code without an eval form and must stay allowed"
            );
        }
    }

    #[test]
    fn authoring_tools_are_bound_only_when_the_turn_asks_for_them() {
        // An ordinary turn must not be able to rewrite the skill store or the
        // connector list, so the authoring tools are gated on allow_create.
        let names = |allow: bool| -> Vec<String> {
            tool_schemas(allow, true)
                .iter()
                .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
                .collect()
        };
        let plain = names(false);
        assert!(!plain.contains(&"create_skill".to_string()));
        assert!(!plain.contains(&"create_mcp".to_string()));
        // load_skill stays available: reading a skill is not authoring.
        assert!(plain.contains(&"load_skill".to_string()));

        let authoring = names(true);
        assert!(authoring.contains(&"create_skill".to_string()));
        assert!(authoring.contains(&"create_mcp".to_string()));
    }

    #[test]
    fn explore_schema_asks_for_parallel_calls() {
        // The model only parallelizes when the tool description says so: one
        // broad explore used to be the default and made turns slow/shallow.
        let schemas = tool_schemas(false, true);
        let desc = schemas
            .iter()
            .find(|s| s["function"]["name"] == "explore")
            .and_then(|s| s["function"]["description"].as_str())
            .unwrap();
        assert!(desc.contains("SEVERAL TIMES IN THE SAME STEP"), "{desc}");
        assert!(desc.contains("CONCURRENTLY"), "{desc}");
    }

    #[test]
    fn research_schemas_cover_search_set() {
        let schemas = research_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        for expected in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_definition",
            "lsp_references",
            "lsp_hover",
            "lsp_symbols",
            "lsp_diagnostics",
            "search_memory",
            "save_memory",
            "delete_memory",
        ] {
            assert!(names.contains(&expected), "missing schema: {expected}");
        }
        // The sub-agent must not be able to write or spawn agents.
        assert!(!names.contains(&"write_file"));
        assert!(!names.contains(&"explore"));
    }

    #[test]
    fn browser_tools_are_bound_only_while_the_switch_is_on() {
        // The composer's Browser switch is the ONLY thing that puts a browser
        // tool in front of the model. Regression guard: these 22 tools used to
        // be injected unconditionally, so a chat could open a Chromium window
        // even with the switch off and nothing in the UI explained why.
        let browser_names = |allow_browser: bool| -> Vec<String> {
            tool_schemas(false, allow_browser)
                .iter()
                .filter_map(|s| s["function"]["name"].as_str())
                .filter(|n| n.starts_with("browser_"))
                .map(str::to_string)
                .collect()
        };
        assert!(
            browser_names(false).is_empty(),
            "browser tools must not be bound while the switch is off"
        );
        assert_eq!(
            browser_names(true).len(),
            crate::browser_driver::ACTIONS.len(),
            "every driver action must be exposed while the switch is on"
        );
    }

    #[test]
    fn tool_schemas_stay_within_a_token_budget() {
        // The tool array is resent on EVERY model call of a turn, so its size is
        // paid once per round-trip. A description added without watching this
        // number silently taxes every turn, so the budget is asserted here.
        //
        // The native browser tools (`browser_driver`) are a deliberate, LARGE
        // addition: 22 tools, bound only while the composer's Browser switch is
        // on — with it off the model sees no browser tool at all, so no Chromium
        // can be started by a turn. When bound they measure ~3_500 chars, which
        // is why "main+browser" budgets more than the base tool set was fitted
        // to: the number is explicit here so the growth stays a decision rather
        // than a drift. Trimming them is not free: every tool corresponds to a
        // browser action the prompts and skills reference by name.
        //
        // `fetch_url` is the other deliberate addition: page fetching is a
        // capability the prompts and skills already describe (and the model was
        // already calling for it), so it costs its description on every turn
        // rather than staying a ghost tool.
        let chars = |v: &Vec<Value>| serde_json::to_string(v).unwrap().chars().count();
        // Report EVERY label at once: asserting inside the loop showed only the
        // first over-budget set, so one run could not tell how far the others
        // were from their limit.
        //
        // The two `+authoring` budgets grew from 9_900/14_200 because three
        // tools joined the authoring set — `plugin`, `artifact` and `schedule`
        // — and they measure ~2_7OO chars AFTER the prose was cut back to the
        // parameter names and enum values (they first landed at ~3_500, which
        // broke both budgets: 12_721/12_000 and 18_303/17_600). They are BOUND
        // only on a turn whose text asked for one of those capabilities
        // (`AgentRequest::allow_create`), so the base `main` turn still pays
        // 5_868 chars and never sees them. Every char here is re-sent on every
        // round-trip OF SUCH A TURN (~2_913 tokens for the authoring set),
        // which is why the descriptions were trimmed as well as accommodated:
        // the model needs the parameter names and enum values, not the prose.
        // `read` + `grep` joined the MAIN set deliberately, and their two
        // schemas cost 603 chars (~150 tokens) on every main round-trip. That
        // is paid back by the round it prevents: on the traced corpus a narrow
        // question ("read these 4 files / grep this token under this path")
        // cost either a shell detour (320 of 606 `run_terminal` calls were
        // `cat`/`sed -n`) or a full `explore` delegation at ~26_139 tokens,
        // 89% of delegations being exactly that narrow. So the three budgets
        // that include `read`+`grep` were re-based by the measured delta rather
        // than trimmed: the descriptions are already at parameter-name density
        // and cutting them back would cost the model the arg semantics the
        // whole lever depends on.
        //
        // `find_symbol` + `lsp_symbols` are the second deliberate addition to
        // the MAIN set, re-based the same way. `glob` stays OUT (discovery is
        // the sub-agent's job), which is why the BASE "main" ceiling only moved
        // by the locators' own chars. Measured on the live corpus, the main
        // agent spent 376 EXTRA same-file reads (3.05M chars ≈ 763K tokens)
        // hunting lines it could have located, 62 of them re-sending windows
        // that overlapped what it had already read, and 35 rounds whose very
        // next round was a plain read of a grep hit. Outline-by-symbol removes
        // that hunt for the two tools' combined ~1_500 chars (~375 tokens) per
        // main round-trip — a price paid on every round, but one that kills a
        // whole class of rounds.
        //
        // The POSITION-based LSP lookups (`lsp_definition`, `lsp_references`,
        // `lsp_hover`) joined the MAIN set in the same move
        // and share their prose with the explore set through
        // `lsp_position_schemas`, so no description is stored twice. They
        // measure 1_745 chars (~436 tokens) on every main round-trip. The
        // measured case for them: 92.2% of every read window in the corpus
        // (1_645 of 1_785) sits in a language with a REGISTERED language server,
        // so a symbol jump is available wherever the model actually reads.
        //
        // `lsp_diagnostics` joined them last, and the reason it was held back
        // before was a WRONG note in this very comment ("re-runs the project's
        // own build"). It runs NO build: it reads the `publishDiagnostics` a
        // live server has already published, and its window is bounded
        // (3s here, 1.5s when it rides an edit result). Measured: 0 calls in
        // the whole corpus, while 37 manual typecheck/build rounds ran and 12
        // of those sat in the round right after an edit — a whole round-trip
        // each on a question the server already answers. It also rides every
        // successful `edit_file` automatically (see
        // `tools::post_edit_diagnostics`), so the common case costs the model
        // nothing and removes the round entirely.
        //
        // Every ceiling below was re-based to the measured size + the same
        // ~3.5% headroom the earlier budgets used, so an UNINTENDED addition
        // still trips this test while a deliberate one stays a readable diff.
        //
        // The last re-base came from the `run_terminal` description, which now
        // states the DIVISION OF LABOUR instead of one line: while it did not,
        // the model reached for `cat`/`sed -n` for every file it wanted to see
        // (measured on the live build: 10 whole rounds of shell reads in one
        // chat, each round ~6-8K uncached tokens). A schema that names the
        // wrong tool is paid on every round-trip AND costs the extra rounds.
        let mut report = String::new();
        let mut over = false;
        for (label, schemas, budget) in [
            // `main`/`main+browser` were re-based when a plain turn gained the
            // `plugin` door (`list`/`run`, see `tool_schemas`): a scheduled run
            // has nobody to ask, so a bundle's scripts must be reachable there.
            // The step is the compact schema's own chars — the authoring prose
            // stays out, and the ~3.5% headroom convention still holds.
            // The memory tools became main-agent tools as well, so the four
            // main budgets moved with them: the ceilings stay measured-size +
            // the same ~3.5% headroom convention, and only `explore` is
            // unchanged (it never lost the schemas).
            //
            // `main`/`main+browser` were re-based one last time when the
            // `artifact` schema stop being gated behind `allow_create`: the
            // gate guessed intent from the prompt text, so a correctly phrased
            // build request could reach the model with no artifact tool at all
            // and ship a hard-coded HTML mock instead of a backed page. The
            // tool is now always present, which is the point — a capability
            // that belongs to the model's own judgement must not depend on a
            // regex — and the step is exactly that schema's chars.
            // Re-based again for the plugin bundle's new primitives: `commands`,
            // `agents` and `hooks` joined the `plugin` schema (a Claude Code
            // bundle ships them), so `create`/`update` can carry them. The step
            // is those field declarations, and it lands on the PLAIN budgets too
            // because `tool_schemas` always holds the full form — the compact
            // swap happens at request assembly (`compact_plugin_schema`).
            // Re-based when `edit_file`'s batch shape and `browser_evaluate`'s
            // description started stating their own rules: a batch entry MUST
            // carry `path` (a nameless batch cost a traced round), and an eval
            // runs in page scope (nine traced rounds died trying to reach React
            // from it). Both are one-time prose, paid on every round, so the
            // ceilings move with the measurement as usual.
            // Re-based once more when `schedule` joined every NON-authoring set
            // as the list-only compact schema (~0.4K chars: "what is scheduled"
            // no longer costs a refusal round in a read-only turn), and
            // `load_skill` learned the `bundle` drill-in + the `plugin` schema's
            // `list` line grew its slug-detail hint. The step is those schemas
            // themselves; the ~3.5% headroom convention still holds.
            // Re-based for the batch params the round-elimination work added:
            // `run_terminal` learned `commands` and `write_file` learned
            // `files` — each batches a whole step of work into ONE call, which
            // is exactly the trade this ceiling exists to price deliberately.
            // Re-based again for `ask_user`'s optional `sections` param: the
            // multi-part card (~0.3K chars) buys ONE round-trip instead of
            // several serial ask gates on a multi-facet fork.
            // Re-based when the `batch` executor joined the main set: the
            // whole-step tool is the round-elimination lever itself — ~1.1K
            // chars of schema buys back 3-7 round-trips on a search-heavy
            // step, the exact trade this ceiling prices deliberately.
            // +87: the ask_user/confirm_action same-step clause (the anti-solo
            // teaching for the interactive tools).
            // +111: the glob/grep/terminal ownership lines (file discovery =
            // glob, content = grep — the traced batch used grep+ls for what
            // one glob answers).
            ("main", tool_schemas(false, false), 19_500usize),
            ("main+browser", tool_schemas(false, true), 26_350),
            // Raised when the `plugin` tool learned `scripts`/`run`: a capability
            // addition is exactly what this ceiling exists to make deliberate.
            // Raised again for the `artifact` schema's `files` field: an artifact
            // may now carry a Rust backend, which is what makes the tool a
            // project builder instead of a document writer. The step is the
            // added prose itself; the ~3.5% headroom convention still holds.
            // Raised once more for `use_mcp`, the native tool that replaced the
            // EAGER inlining of every connector's whole catalogue. That trade is
            // the point: +243 chars of native schema bought back ~236K chars of
            // connector schemas on a trace where one connector was switched on.
            // Raised for `ask_user` `sections` (see the `main` note above).
            ("main+authoring", tool_schemas(true, false), 26_450),
            ("main+authoring+browser", tool_schemas(true, true), 33_300),
            // Re-based when `batch` joined the RESEARCH set: the explore
            // sub-agent is the heaviest search caller, so the whole-step
            // executor rides there too (that is where the round-trips are).
            ("explore", research_schemas(), 9_950),
        ] {
            let got = chars(&schemas);
            if got > budget {
                over = true;
            }
            report.push_str(&format!("{label}={got}/{budget} "));
        }
        assert!(
            !over,
            "tool schemas over budget (chars/budget): {report}"
        );
    }

    #[test]
    fn a_plain_turn_keeps_the_script_door_but_not_the_authoring_actions() {
        // A scheduled Build run sends `allow_create: false` and has nobody to
        // ask, so binding the WHOLE `plugin` tool behind that flag meant a
        // bundle's scripts were unreachable there — the plugin was installed,
        // on, and invisible. `list`/`run` are acts like `run_terminal`, so a
        // plain turn keeps exactly those two, and the write actions stay out.
        let schemas = tool_schemas(false, false);
        let plugin = schemas
            .iter()
            .find(|s| s["function"]["name"] == "plugin")
            .expect("a plain turn must still reach a bundle's scripts");
        let actions: Vec<&str> = plugin["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(actions, vec!["list", "run"], "{actions:?}");
        // The authoring prose must NOT ride along: it is ~2.9K chars re-sent on
        // every round-trip of every ordinary turn.
        let desc = plugin["function"]["description"].as_str().unwrap_or("");
        assert!(
            !desc.contains("git repo"),
            "the authoring description must stay out of a plain turn: {desc}"
        );
        // The authoring turn keeps the full set.
        let full = tool_schemas(true, false);
        let authored = full
            .iter()
            .find(|s| s["function"]["name"] == "plugin")
            .expect("an authoring turn keeps the plugin tool");
        let all: Vec<&str> = authored["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for action in ["install", "create", "update", "toggle", "delete", "run"] {
            assert!(all.contains(&action), "authoring must keep {action}: {all:?}");
        }
    }

    #[test]
    fn plugin_scripts_are_rust_unless_the_user_named_a_language() {
        // The default lives in `plugins::DEFAULT_SCRIPT_LANGUAGE`, but the model
        // is the one that chooses — so the SCHEMA is where the rule has to be
        // stated. While it only said "Defaults to rust", a model could still
        // pick python on its own and ship a script nobody asked for.
        let schemas = tool_schemas(true, false);
        let plugin = schemas
            .iter()
            .find(|s| s["function"]["name"] == "plugin")
            .expect("the authoring turn must advertise the plugin tool");
        let props = &plugin["function"]["parameters"]["properties"];
        let script = &props["scripts"];
        let text = format!(
            "{} {}",
            script["description"].as_str().unwrap_or(""),
            script["items"]["properties"]["language"]["description"]
                .as_str()
                .unwrap_or("")
        )
        .to_lowercase();
        assert!(
            text.contains("rust"),
            "the schema must name Rust as the default language: {text}"
        );
        assert!(
            text.contains("omit") || text.contains("leave `language` out"),
            "the schema must say the language field is left OUT for Rust: {text}"
        );
        assert!(
            text.contains("user"),
            "another language must be tied to an explicit user request: {text}"
        );
    }

    #[test]
    fn the_artifact_schema_asks_for_a_rust_backend_before_anything_else() {
        // The user's rule: an artifact that needs logic gets a real backend, and
        // that backend is Rust unless Rust genuinely cannot do it — in which case
        // the model ASKS instead of picking a language on its own. The schema is
        // the only place the model reads that rule, so it is asserted here.
        let schemas = tool_schemas(true, false);
        let artifact = schemas
            .iter()
            .find(|s| s["function"]["name"] == "artifact")
            .expect("the authoring turn must advertise the artifact tool");
        let props = &artifact["function"]["parameters"]["properties"];
        let files = props["files"]["description"]
            .as_str()
            .unwrap_or("")
            .to_lowercase();
        assert!(
            files.contains("rust first"),
            "the schema must make Rust the first choice: {files}"
        );
        assert!(
            files.contains("user agreed") && files.contains("asked"),
            "another language must require asking the user first: {files}"
        );
        // A UI that needs live data must not fake it in the page: the schema has
        // to point at the backend route, or the model ships a static mock.
        let content = props["content"]["description"]
            .as_str()
            .unwrap_or("")
            .to_lowercase();
        assert!(
            content.contains("backend") && content.contains("files"),
            "the content field must route live data through a backend file: {content}"
        );
        // Omitting `files` on an update must not wipe the backend it added.
        assert!(
            files.contains("keeps the files already stored"),
            "an update without files must be documented as non-destructive: {files}"
        );
    }

    #[test]
    fn edit_file_schema_forbids_a_nameless_batch() {
        // Traced: the model sent `{edits:[{old_string,new_string}]}` — no `path`
        // anywhere — because the schema said an entry MAY carry one. The call was
        // refused as "no file named" and the correction cost a whole round. The
        // nameless shape must not be constructible, so the requirement is in the
        // JSON schema itself, not only in the handler's message.
        let schemas = tool_schemas(false, false);
        let edit = schemas
            .iter()
            .find(|s| s["function"]["name"] == "edit_file")
            .expect("edit_file must be advertised");
        let params = &edit["function"]["parameters"];
        let required: Vec<&str> = params["properties"]["edits"]["items"]["required"]
            .as_array()
            .expect("every edits entry declares its required fields")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(required.contains(&"path"), "a batch entry must name its file: {required:?}");
        let desc = edit["function"]["description"].as_str().unwrap_or_default();
        assert!(
            desc.to_lowercase().contains("every entry"),
            "the prose must match the schema: {desc}"
        );
    }

    #[test]
    fn tool_schemas_serialize_byte_identically() {
        // Prefix caching (automatic on OpenAI-compatible gateways, explicit via
        // `cache_control` on Anthropic) only hits while the PREFIX is byte
        // stable. The tool array sits in that prefix, so a schema list whose
        // order or formatting wobbles between calls silently destroys the cache
        // for the whole turn — and would make the cache-hit number in the trace
        // read 0 for no visible reason. `serde_json` is built without
        // `preserve_order` (deterministic key order), and this pins the rest.
        for schemas in [
            tool_schemas(false, true),
            tool_schemas(true, true),
            research_schemas(),
        ] {
            let a = serde_json::to_string(&schemas).unwrap();
            let b = serde_json::to_string(&schemas).unwrap();
            assert_eq!(a, b, "schema serialization must be deterministic");
        }
        // A rebuilt list must match too — the cache survives across turns only
        // if the same inputs produce the same bytes.
        assert_eq!(
            serde_json::to_string(&tool_schemas(false, true)).unwrap(),
            serde_json::to_string(&tool_schemas(false, true)).unwrap()
        );
    }

    #[test]
    fn explore_prompt_carries_layout_and_lsp_guidance() {
        let dir = std::env::temp_dir().join(format!("codifa-explore-prompt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        std::fs::write(dir.join("backend/server.py"), "").unwrap();
        let p = explore_system_prompt(dir.to_str().unwrap());
        // Real paths up front, so the model never has to glob for them.
        assert!(p.contains("backend/: server.py"), "{p}");
        // LSP + glob semantics are spelled out (the old prompt never named LSP).
        assert!(p.contains("lsp_definition") && p.contains("lsp_references") && p.contains("lsp_symbols"));
        // find_symbol is the one-call replacement for the grep -> lsp chain.
        assert!(p.contains("find_symbol"), "{p}");
        // The single-call rule and the offset rule are what stop the 4-round
        // serial runs seen in a real trace.
        assert!(p.contains("HARD RULE") && p.contains("never guess an"), "{p}");
        assert!(p.contains("FILES only") && p.contains("no matches"));
        // Still read-only and English-reporting.
        assert!(p.contains("NO write tools") && p.contains("Report in English"));
        // Report contract: answer first, verbatim code only where it is needed.
        assert!(p.contains("ANSWER") && p.contains("VERBATIM") && p.contains("nothing between tool calls"));
        // Latency guidance: rounds (not calls) are the cost, batch in ONE step.
        assert!(p.contains("ROUNDS") && p.contains("ONE step"), "{p}");
        // `read` numbers its lines; the report must not carry that scaffolding
        // into CODE excerpts the main agent will use as exact-match edit strings.
        assert!(p.contains("line number") && p.contains("never copy the header"), "{p}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn explore_prompt_budgets_rounds_and_says_why() {
        // Measured on real traces: one explore ROUND costs ~7.7K uncached tokens
        // (a 9-round run paid ~78K), so rounds — not calls — are the price. The
        // old prompt only said "aim for 2-3 rounds" and the model drifted to a
        // median of 4-5 with a tail of 11. The budget must be explicit and the
        // reason a read now is cheap (stable prefix) must be stated, otherwise
        // the model saves one cheap read and pays a whole round for it later.
        let p = explore_system_prompt(std::env::temp_dir().to_str().unwrap());
        assert!(p.contains("3-step budget"), "{p}");
        assert!(p.contains("STEP 1 - LOCATE"), "{p}");
        assert!(p.contains("STEP 2 - READ"), "{p}");
        assert!(p.contains("PREFIX"), "{p}");
        // The old "aim for 2-3 rounds" wish is gone — replaced by a budget.
        assert!(!p.contains("Aim for 2-3 rounds"), "{p}");
        // STEP 1 must be skippable. On a real trace, 31 of 37 explore runs whose
        // question ALREADY named the file and line window still spent a round
        // locating: 8.7K uncached tokens per run against 6.7K for the runs that
        // read straight away (87% of that group's cost). "Do not read yet" was
        // an unconditional command, so the model obeyed it against the evidence
        // in front of it.
        assert!(p.contains("SKIP this step entirely"), "{p}");
        assert!(p.contains("already names the files and line windows"), "{p}");
    }

    #[test]
    fn subagent_report_keeps_only_text_after_the_last_search_tool() {
        let mut report = String::new();
        let mut err = String::new();
        let text = |s: &str| AgentEvent::Text { content: s.into() };
        let tool = |n: &str| AgentEvent::ToolStart { id: "i".into(), name: n.into(), args: json!({}) };
        fold_subagent_event(&mut report, &mut err, &text("Let me search..."));
        fold_subagent_event(&mut report, &mut err, &tool("grep"));
        fold_subagent_event(&mut report, &mut err, &text("Now reading..."));
        fold_subagent_event(&mut report, &mut err, &tool("read"));
        fold_subagent_event(&mut report, &mut err, &text("ANSWER: x"));
        assert_eq!(report, "ANSWER: x");
        // A report written in the same step as save_memory survives it.
        fold_subagent_event(&mut report, &mut err, &tool("save_memory"));
        fold_subagent_event(&mut report, &mut err, &text(" (saved)"));
        assert_eq!(report, "ANSWER: x (saved)");
        fold_subagent_event(&mut report, &mut err, &AgentEvent::Error { content: "boom".into() });
        assert_eq!(err, "boom");
    }

    #[test]
    fn repeated_lookups_are_detected_but_distinct_windows_are_not() {
        // Same file + same window (an omitted offset/limit means the default
        // window) is a repeat: the body is already in the context.
        let a = json!({"filePath": "src/a.ts", "offset": 1, "limit": 400});
        let b = json!({"filePath": "src/a.ts"});
        assert_eq!(lookup_key("read", &a), lookup_key("read", &b));
        // A different window of the same file is a real read.
        let c = json!({"filePath": "src/a.ts", "offset": 401, "limit": 400});
        assert_ne!(lookup_key("read", &a), lookup_key("read", &c));
        // Different `ranges` of one file are different lookups (same ranges repeat).
        let r1 = json!({"filePath": "src/a.ts", "ranges": [{"offset": 1, "limit": 50}]});
        let r2 = json!({"filePath": "src/a.ts", "ranges": [{"offset": 200, "limit": 50}]});
        assert_ne!(lookup_key("read", &r1), lookup_key("read", &r2));
        assert_eq!(lookup_key("read", &r1), lookup_key("read", &r1.clone()));
        // Grep keys carry the scope, so the same pattern in another directory
        // is a different lookup.
        let g1 = json!({"pattern": "foo", "path": "src"});
        let g2 = json!({"pattern": "foo", "path": "backend"});
        assert_ne!(lookup_key("grep", &g1), lookup_key("grep", &g2));
        assert_eq!(
            lookup_key("grep", &g1),
            lookup_key("grep", &json!({"pattern": "foo", "path": "src"}))
        );
        // The `patterns` array form keys the same way as a single pattern.
        assert_eq!(
            lookup_key("grep", &json!({"patterns": ["a", "b"]})),
            lookup_key("grep", &json!({"patterns": ["a", "b"]}))
        );
        // find_symbol dumps definition bodies + usages: the same symbol in the
        // same scope is a repeat, a different scope is a real lookup.
        let f1 = json!({"symbol": "foo", "path": "src"});
        assert_eq!(lookup_key("find_symbol", &f1), lookup_key("find_symbol", &f1.clone()));
        assert_ne!(lookup_key("find_symbol", &f1), lookup_key("find_symbol", &json!({"symbol": "foo", "path": "backend"})));
        assert!(lookup_key("find_symbol", &json!({"path": "src"})).is_none());
        // Shapes without a target are never deduped (nothing to compare).
        // `path` IS a real alias the dispatch accepts (a guard blind to it let
        // one fixture file re-read at full size three times in a single run),
        // so an alias-only read is DEDUPABLE; only a call naming no file at
        // all stays keyless.
        assert_eq!(
            lookup_key("read", &json!({"path": "src/a.ts"})),
            lookup_key("read", &json!({"filePath": "src/a.ts"})),
            "the alias and the canonical form are the same lookup"
        );
        assert!(lookup_key("read", &json!({})).is_none());
        assert!(lookup_key("grep", &json!({"path": "src"})).is_none());
        // A multi-FILE read carries no top-level filePath, yet it is exactly the
        // call that moves the most bytes: it must still be deduped, and two
        // different file lists must never share a key.
        let many = json!({"ranges": [{"path": "a.rs"}, {"path": "b.ts"}]});
        let many_key = lookup_key("read", &many).expect("a multi-file read is dedupable");
        assert_eq!(many_key, lookup_key("read", &many.clone()).unwrap());
        assert_ne!(
            many_key,
            lookup_key("read", &json!({"ranges": [{"path": "a.rs"}]})).unwrap()
        );
        // `glob` IS deduped now (it was not, and a traced run re-listed the
        // same directory): a pattern is a real target, a bare scope is not.
        assert!(lookup_key("glob", &json!({"pattern": "**/*.ts"})).is_some());
        assert!(lookup_key("glob", &json!({"path": "src"})).is_none());
    }

    #[test]
    fn stale_screenshots_leave_the_wire_oldest_first() {
        // Every past capture re-bills as vision tokens on EVERY following
        // step; the model aims at the latest capture (and the one before it
        // for aim-correction), so older ones become a text note.
        let img = |u: &str| json!({"type": crate::llm::IMAGE_BLOCK_TYPE, "data_url": u});
        let shot_msg = |u: &str| {
            json!({"role": "user", "content": [json!({"type": "text", "text": "Screenshot taken:\n  after click — 100x100 px."}), img(u)]})
        };
        let composer_msg = || {
            // The user's own attachments are CONTENT: never elided.
            json!({"role": "user", "content": [json!({"type": "text", "text": "what is in this picture?"}), img("data:attachment")]})
        };
        let mut msgs = vec![
            json!({"role": "system", "content": "s"}),
            composer_msg(),
            shot_msg("data:s1"),
            json!({"role": "assistant", "content": "a"}),
            shot_msg("data:s2"),
            shot_msg("data:s3"),
            shot_msg("data:s4"),
        ];
        elide_stale_screenshots(&mut msgs, MAX_HISTORY_SHOTS);
        let count = |m: &Value| {
            m["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["type"] == crate::llm::IMAGE_BLOCK_TYPE)
                .count()
        };
        assert_eq!(count(&msgs[2]), 0, "oldest shot must be elided");
        assert_eq!(count(&msgs[4]), 0, "second-oldest must be elided");
        assert_eq!(count(&msgs[5]), 1, "third keeps (within the 2 cap)");
        assert_eq!(count(&msgs[6]), 1, "newest keeps");
        assert_eq!(count(&msgs[1]), 1, "a composer attachment is never touched");
        // The elided blocks say what happened and how to get the image back.
        let elided = msgs[2]["content"][1]["text"].as_str().unwrap();
        assert!(elided.contains("removed"), "{elided}");
        assert!(elided.contains("action=screenshot"), "{elided}");
        // Nothing to elide under the cap: no message is rewritten.
        let mut small = vec![shot_msg("data:s1"), shot_msg("data:s2")];
        elide_stale_screenshots(&mut small, MAX_HISTORY_SHOTS);
        assert_eq!(count(&small[0]), 1);
        assert_eq!(count(&small[1]), 1);
    }

    #[test]
    fn single_call_steps_get_a_batching_hint() {
        let root = env!("CARGO_MANIFEST_DIR");
        let one = |name: &str| vec![("c1".to_string(), name.to_string(), "{}".to_string())];
        // The explore sub-agent: one lookup per step burns rounds.
        assert!(single_call_hint("subagent", &one("grep"), 1, root)
            .unwrap()
            .contains("NEXT step"));
        // The main agent: a single broad explore wastes the concurrent fan-out
        // (a traced turn fired one wide explore and got a 4-round report).
        let main = single_call_hint("agent", &one("explore"), 1, root).unwrap();
        assert!(main.contains("CONCURRENTLY") && main.contains("2-4 focused explores"), "{main}");
        // Batched steps are left alone, and so is a single non-explore call.
        let two = vec![
            ("a".to_string(), "grep".to_string(), "{}".to_string()),
            ("b".to_string(), "read".to_string(), "{}".to_string()),
        ];
        assert!(single_call_hint("subagent", &two, 1, root).is_none());
        // Native WRITE tools still get the hint: a lone file write is precisely
        // the shape a batch fixes, so the wording promises ordering, not
        // parallelism. `run_terminal` and the browser act-then-observe tools were
        // REMOVED from this set: traced, their lone rounds are probe chains whose
        // arguments come from the previous result, so the hint is an instruction
        // the model cannot obey (59 such rounds, 50 firings, zero effect).
        for name in ["edit_file", "write_file"] {
            let hint = single_call_hint("agent", &one(name), 1, root).unwrap();
            // The batch FORMS are named explicitly now: files=[…] for writes,
            // edits=[…] for replacements, commands=[…] for the shell — the
            // traced model answers with exactly one call per reply, so the
            // hint must teach the exact parameter, not the concept.
            assert!(hint.contains("files:[{path, content}]"), "{name}: {hint}");
            assert!(hint.contains("edits:[{path, old_string, new_string, replace_all}]"), "{name}: {hint}");
            assert!(hint.contains("commands:"), "{name}: {hint}");
            assert!(!hint.contains("parallel"), "{name} must not promise parallelism: {hint}");
        }
        // A SHELL round is a chain only when its command MUTATES, so a bare
        // `run_terminal` with no command carries nothing to batch and stays silent.
        assert!(single_call_hint("agent", &one("run_terminal"), 1, root).is_none());
        for name in ["browser_evaluate", "browser_navigate"] {
            assert!(
                single_call_hint("agent", &one(name), 1, root).is_none(),
                "{name} is a probe chain, not a missed batch — it must stay silent"
            );
        }
        let mutating = |cmd: &str| {
            vec![(
                "c1".to_string(),
                "run_terminal".to_string(),
                json!({"command": cmd}).to_string(),
            )]
        };
        for cmd in ["rm -rf /tmp/x", "mv a b", "touch new.rs", "echo hi > f.txt"] {
            assert!(
                single_call_hint("agent", &mutating(cmd), 1, root).is_none(),
                "{cmd} mutates and must stay silent"
            );
        }
        // A READ-ONLY command is the one shell shape that IS a missed batch: the
        // backend already runs it in the concurrent lookup batch.
        let read_hint = single_call_hint("agent", &mutating("git status --porcelain"), 1, root)
            .expect("a read-only command must be named as batchable");
        assert!(read_hint.contains("concurrent"), "{read_hint}");
        assert!(read_hint.contains("same step"), "{read_hint}");
        // The batch FORM is named: commands=[…] is what the model must emit.
        assert!(read_hint.contains("commands="), "{read_hint}");
        assert!(
            !read_hint.contains("IN ORDER"),
            "a read is concurrent, never ordered: {read_hint}"
        );
        // A whole-artifact write is a file write and stays in the set; the
        // browser viewport/emulation calls are act-then-observe like the rest of
        // the browser group and must stay silent.
        for name in ["artifact"] {
            let hint = single_call_hint("agent", &one(name), 1, root)
                .unwrap_or_else(|| panic!("{name} has no hint"));
            assert!(hint.contains("files:[{path, content}]"), "{name}: {hint}");
            assert!(!hint.contains("parallel"), "{name} must not promise parallelism: {hint}");
        }
        for name in ["browser_resize", "browser_emulate_media"] {
            assert!(
                single_call_hint("agent", &one(name), 1, root).is_none(),
                "{name} acts on one shared page in a chain — it must stay silent"
            );
        }
        // Read-only natives are the one group that DOES batch concurrently.
        // `grep` joined on the Oct 30 corpus (41 lone rounds, streaks of 4+
        // same-tool searches — all of it batchable the moment the second search
        // was foreseeable); `glob` joins for the same execution semantics (it
        // runs in the concurrent batch phase, so the wording stays truthful).
        for name in [
            "read", "grep", "glob", "fetch_url", "load_skill", "find_symbol", "lsp_symbols",
        ] {
            let hint = single_call_hint("agent", &one(name), 1, root)
                .unwrap_or_else(|| panic!("{name} has no hint"));
            assert!(hint.contains("CONCURRENTLY"), "{name}: {hint}");
        }
        // Interactive / whole-state tools legitimately stand alone: hinting at
        // them would push the model to fire a second blocking question or a
        // second full checklist rewrite in one step, so they stay silent.
        for name in ["ask_user", "update_plan"] {
            assert!(
                single_call_hint("agent", &one(name), 1, root).is_none(),
                "{name} must stay silent"
            );
        }
    }

    #[test]
    fn the_lone_serial_hint_escalates_instead_of_repeating() {
        // A fixed string fired on 16 consecutive rounds of one fresh chat and the
        // model batched on ZERO of them: past the second delivery the text must
        // carry the accumulated price, not the same instruction again.
        let root = env!("CARGO_MANIFEST_DIR");
        let one = vec![("c1".to_string(), "edit_file".to_string(), "{}".to_string())];
        let first = single_call_hint("agent", &one, 1, root).unwrap();
        assert!(first.contains("That step had ONE call"), "{first}");
        assert!(!first.contains("rounds in a row"), "{first}");
        let fifth = single_call_hint("agent", &one, 5, root).unwrap();
        assert!(fifth.contains("5 rounds in a row"), "{fifth}");
        assert!(fifth.contains("Batch NOW"), "{fifth}");
        assert_ne!(first, fifth, "the text must change as the streak grows");
    }

    #[test]
    fn a_lone_shell_probe_is_never_told_to_batch() {
        // Traced: 59 consecutive rounds of one chat were all lone `run_terminal`,
        // each command a probe whose arguments came from the previous result, and
        // the hint fired on 50 of them — an instruction the model could not obey,
        // left in the re-sent history (~350 chars on every later round) while it
        // batched on 2 rounds out of 59. A shell round must therefore stay silent
        // and must not grow the streak either, or the counter would report waste
        // that was never addressable.
        let root = env!("CARGO_MANIFEST_DIR");
        // A genuinely MUTATING command is a probe chain and stays silent.
        let mutating = vec![(
            "c1".to_string(),
            "run_terminal".to_string(),
            json!({"command": "rm -rf /tmp/codifa-nope"}).to_string(),
        )];
        assert!(single_call_hint("agent", &mutating, 3, root).is_none());
        assert!(!single_call_is_serial("agent", &mutating, root));
        // The act-then-observe browser tools are the same chain and stay silent.
        let browser = vec![("c1".to_string(), "browser_evaluate".to_string(), "{}".to_string())];
        assert!(single_call_hint("agent", &browser, 1, root).is_none());
        assert!(!single_call_is_serial("agent", &browser, root));
        // A lone file write is the shape a batch CAN fix, so it still counts.
        let write = vec![("c1".to_string(), "edit_file".to_string(), "{}".to_string())];
        assert!(single_call_is_serial("agent", &write, root));
        // A lone read-only lookup is the OTHER batchable shape and the most
        // common one: it must grow the streak, or the escalating text never
        // escalates on the rounds that dominate the wire cost. The whole
        // `lsp_*` family is included because it runs in the same concurrent
        // batch and the system prompt advertises it as batchable — while the
        // hint list named only `lsp_symbols`, so a lone `lsp_definition` spent
        // its round in silence.
        for name in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_symbols",
            "lsp_definition",
            "lsp_references",
            "lsp_hover",
            "lsp_diagnostics",
            "fetch_url",
            "load_skill",
        ] {
            let lookup = vec![("c1".to_string(), name.to_string(), "{}".to_string())];
            assert!(
                single_call_is_serial("agent", &lookup, root),
                "a lone {name} must count as a batchable round"
            );
            // Same set on BOTH sides: a name the counter accepts but the hint
            // refuses would grow the streak while the round stays silent.
            assert!(
                single_call_hint("agent", &lookup, 2, root).is_some(),
                "a lone {name} must deliver the batching hint"
            );
        }
        // The sub-agent's rounds are governed by its own report, not this lever.
        assert!(!single_call_is_serial("subagent", &write, root));
    }

    /// A lone READ-ONLY shell round is batchable and must be named as such.
    ///
    /// Traced (`mvxsy14e`): 80 lone `run_terminal` rounds, 39 of them pure reads
    /// (`git log`, `du -sh`, a `python3` script over trace JSON). They ran in the
    /// same concurrent batch as the lookups, yet the "probe chain" rule silenced
    /// every `run_terminal` round — 39 full round-trips, each re-sending the whole
    /// conversation, with nothing said. What makes a shell round a chain is
    /// MUTATION, not the shell.
    #[test]
    fn a_lone_read_only_shell_round_is_told_it_runs_concurrently() {
        let root = env!("CARGO_MANIFEST_DIR");
        let read = vec![(
            "c1".to_string(),
            "run_terminal".to_string(),
            json!({"command": "git log --oneline -5"}).to_string(),
        )];
        assert!(
            single_call_is_serial("agent", &read, root),
            "a read-only command shares the concurrent batch, so it is batchable"
        );
        let first = single_call_hint("agent", &read, 1, root).expect("must speak");
        assert!(first.contains("CONCURRENT") || first.contains("concurrent"), "{first}");
        // Escalates off the streak instead of repeating itself.
        let later = single_call_hint("agent", &read, 4, root).expect("must speak");
        assert!(later.contains("4 rounds in a row"), "{later}");
        // The wording must never promise ordering for a read, and never promise
        // concurrency for a MUTATING command — that one stays silent.
        let mutating = vec![(
            "c1".to_string(),
            "run_terminal".to_string(),
            json!({"command": "mv a.rs b.rs"}).to_string(),
        )];
        assert!(single_call_hint("agent", &mutating, 3, root).is_none());
        assert!(!single_call_is_serial("agent", &mutating, root));
    }

    /// The hint and the step runner must classify a shell round the SAME way.
    ///
    /// The executor decides what runs in the concurrent batch (`is_shell_read_only`),
    /// while this lever decides what the model is told it can batch. Drift between
    /// them is silent in both directions: a command the runner batches but the hint
    /// ignores is a round-trip nobody named (traced: 39 of them in `mvxsy14e`), and
    /// a command the hint names but the runner serializes tells the model to fire a
    /// batch that silently becomes an ordered chain.
    #[test]
    fn the_batching_hint_agrees_with_the_step_runner_on_every_shell_shape() {
        let root = env!("CARGO_MANIFEST_DIR");
        // Reads the runner batches concurrently, and mutators it always serializes.
        for cmd in [
            "git status --porcelain",
            "du -sh src",
            "git log --oneline -5",
            "ls -l src-tauri/src",
            "rm -rf /tmp/codifa-nope",
            "mv a.rs b.rs",
            "sed -i '' s/a/b/ x.txt",
            "touch src/new.rs",
            "echo hi > out.txt",
        ] {
            let call = vec![(
                "c1".to_string(),
                "run_terminal".to_string(),
                json!({"command": cmd}).to_string(),
            )];
            let executor_batches = shell_read_is_batchable(&call[0].2, root);
            assert_eq!(
                executor_batches,
                is_shell_read_only(cmd, root),
                "the helper must not invent its own rule for {cmd:?}"
            );
            let told = single_call_hint("agent", &call, 1, root).is_some();
            assert_eq!(
                told, executor_batches,
                "{cmd:?}: hint says batchable={told} but the runner says {executor_batches}"
            );
            assert_eq!(
                single_call_is_serial("agent", &call, root),
                executor_batches,
                "{cmd:?}: a batchable round must grow the streak, a chain must not"
            );
        }
    }

    #[test]
    fn a_lone_lookup_streak_escalates_instead_of_repeating_its_first_wording() {
        // Measured on trace `mvy0ausq`: 54 of 65 rounds carried a single
        // read-only call and 91% of the turn's wire tokens, but the streak
        // counter ignored them, so the hint said "That step had ONE call" on
        // every one of them and never named the accumulated price.
        let root = env!("CARGO_MANIFEST_DIR");
        let one = vec![("c1".to_string(), "read".to_string(), "{}".to_string())];
        let first = single_call_hint("agent", &one, 1, root).unwrap();
        assert!(first.contains("ONE call"), "{first}");
        assert!(first.contains("ranges:"), "{first}");
        let ninth = single_call_hint("agent", &one, 9, root).unwrap();
        assert!(ninth.contains("9 rounds in a row"), "{ninth}");
        assert!(ninth.contains("CONCURRENTLY"), "{ninth}");
        assert_ne!(first, ninth, "the wording must change as the streak grows");
        // A lookup must never be told edits run "IN ORDER" — that is the write
        // path's wording, and the two families batch differently.
        assert!(!ninth.contains("IN ORDER"), "{ninth}");
    }

    #[test]
    fn discovery_streak_nudge_fires_once_at_the_boundary() {
        // The per-round single-call hint was measured as wallpaper (423 of 863
        // rounds carried it, 315 single-call rounds followed it), so the streak
        // nudge fires ONCE per streak — at the boundary, never before and never
        // again inside the same streak. Firing earlier or repeatedly would put it
        // back on the same footing as the hint it replaces.
        for streak in 1..STREAK_NUDGE_AT {
            assert!(
                discovery_streak_hint("agent", streak).is_none(),
                "streak {streak} must stay silent"
            );
        }
        let hint = discovery_streak_hint("agent", STREAK_NUDGE_AT).unwrap();
        assert!(hint.contains("`explore`"), "{hint}");
        // Past the boundary stays silent until the LATE boundary, where the
        // measured waste says the streak is no longer a finishing move: 1_443_180
        // of the 2_361_303 uncached tokens past the third round sat at round 7+.
        for streak in (STREAK_NUDGE_AT + 1)..STREAK_NUDGE_LATE {
            assert!(discovery_streak_hint("agent", streak).is_none(), "streak {streak}");
        }
        let late = discovery_streak_hint("agent", STREAK_NUDGE_LATE).unwrap();
        assert!(late.contains("`explore`"), "{late}");
        for streak in (STREAK_NUDGE_LATE + 1)..=25 {
            assert!(discovery_streak_hint("agent", streak).is_none(), "streak {streak}");
        }
        // The explore sub-agent has no `explore` of its own and a 3-round
        // budget, so it must never receive the delegation nudge.
        assert!(discovery_streak_hint("subagent", STREAK_NUDGE_AT).is_none());
        assert!(discovery_streak_hint("subagent", STREAK_NUDGE_LATE).is_none());
    }

    #[test]
    fn round_hint_gives_the_streak_boundary_priority() {
        // Traced: the per-round hint would take the slot in 24 of the 72 rounds
        // sitting exactly on a streak boundary, starving the one nudge that has a
        // measured boundary on its side. The streak hint wins there, the
        // per-round hint still fires everywhere else, and a round never carries
        // both.
        let root = env!("CARGO_MANIFEST_DIR");
        let one = vec![("c1".to_string(), "read".to_string(), "{}".to_string())];
        for boundary in [STREAK_NUDGE_AT, STREAK_NUDGE_LATE] {
            let got = round_hint("agent", &one, boundary, 1, root).unwrap();
            assert_eq!(&*got, discovery_streak_hint("agent", boundary).unwrap());
        }
        // Off the boundaries the per-round hint keeps its slot.
        let off = round_hint("agent", &one, 1, 1, root).unwrap();
        assert_eq!(&*off, &*single_call_hint("agent", &one, 1, root).unwrap());
        // A multi-call round off every boundary carries nothing.
        let many = vec![
            ("c1".to_string(), "read".to_string(), "{}".to_string()),
            ("c2".to_string(), "read".to_string(), "{}".to_string()),
        ];
        assert!(round_hint("agent", &many, 2, 0, root).is_none());
    }

    #[test]
    fn a_deep_lone_streak_is_never_silenced_by_the_streak_lever() {
        // Traced: one chat ran 34 consecutive lone-serial rounds and the quiet
        // rounds delivered NOTHING, because the streak hint holds the slot on
        // `lone_mutating_rounds > 1 && % 3 != 0` and returns `None` whenever the
        // discovery streak is below its boundary. For a lone FILE WRITE — the
        // shape a batch can fix — the fallback keeps it audible.
        let root = env!("CARGO_MANIFEST_DIR");
        let one = vec![("c1".to_string(), "edit_file".to_string(), "{}".to_string())];
        for rounds in 1..=12 {
            let quiet = rounds > 1 && rounds % 3 != 0;
            let hint = if quiet {
                discovery_streak_hint("agent", 0)
                    .map(std::borrow::Cow::Borrowed)
                    .or_else(|| single_call_hint("agent", &one, rounds, root))
            } else {
                round_hint("agent", &one, 0, rounds, root)
            };
            assert!(hint.is_some(), "round {rounds} (quiet={quiet}) delivered nothing");
        }
        // The quiet rounds that used to go silent now carry the escalating text,
        // which names the price instead of repeating the same instruction.
        let text = single_call_hint("agent", &one, 4, root).unwrap();
        assert!(text.contains("4 rounds in a row"), "{text}");
    }

    #[test]
    fn the_batching_lever_stays_audible_on_a_long_lone_streak() {
        // MEASURED (trace `mvxsy14e`): the lever used to go PERMANENTLY silent
        // past `LONE_CALL_HINT_MAX_PER_TURN` deliveries, on the premise that each
        // delivery rides the rest of the turn and is re-billed every round. That
        // premise is false — `strip_stale_hints` elides all but the newest hint
        // before each request — so the cap only bought silence: the turn hit it
        // at step 3 and then ran 14 more single-call rounds with nothing said.
        // This replays the loop guard over a long lone streak and pins the two
        // properties that matter: the counter keeps climbing past the old cap,
        // and the lever still speaks on the escalating rounds.
        let root = env!("CARGO_MANIFEST_DIR");
        let one = vec![("c1".to_string(), "edit_file".to_string(), "{}".to_string())];
        let mut lone_call_hints: usize = 0;
        let mut escalating_after_cap = 0;
        for rounds in 1..=30 {
            let hints_are_quiet = rounds > 1 && rounds % 3 != 0;
            let hint = if hints_are_quiet {
                discovery_streak_hint("agent", 0)
                    .map(std::borrow::Cow::Borrowed)
                    .or_else(|| single_call_hint("agent", &one, rounds, root))
            } else {
                round_hint("agent", &one, 0, rounds, root)
            };
            if let Some(h) = hint.as_deref() {
                if h.contains("ONE call") || h.contains("rounds in a row") {
                    lone_call_hints += 1;
                    if lone_call_hints > LONE_CALL_HINT_MAX_PER_TURN {
                        escalating_after_cap += 1;
                    }
                }
            }
        }
        assert!(
            lone_call_hints > LONE_CALL_HINT_MAX_PER_TURN,
            "the lever must keep delivering past the old cap, got {lone_call_hints}"
        );
        assert!(
            escalating_after_cap > 0,
            "the rounds after the old cap must still carry the batching text"
        );
    }

    #[test]
    fn a_round_carries_at_most_one_nudge() {
        // Both hints ride on the SAME slot (the step's last tool result), and the
        // streak hint is the `or_else` fallback: a lone `read` in round 3 of a
        // streak carries the single-call hint only, never both.
        let root = env!("CARGO_MANIFEST_DIR");
        let one = vec![("c1".to_string(), "read".to_string(), "{}".to_string())];
        assert!(single_call_hint("agent", &one, 1, root).is_some());
        assert!(discovery_streak_hint("agent", STREAK_NUDGE_AT).is_some());
        let batched = vec![
            ("a".to_string(), "read".to_string(), "{}".to_string()),
            ("b".to_string(), "grep".to_string(), "{}".to_string()),
        ];
        // A batched discovery round: no single-call hint, so the streak nudge is
        // the one that lands — the case the batching lever alone cannot catch.
        assert!(single_call_hint("agent", &batched, 1, root).is_none());
        assert!(discovery_streak_hint("agent", STREAK_NUDGE_AT).is_some());
    }

    #[test]
    fn the_explore_spent_budget_nudge_lands_before_the_exhaustion_nudge() {
        // The round-3 nudge only helps while rounds remain, and it has to be
        // distinguishable from the "nearly exhausted" one (step + 3 == max).
        assert!(EXPLORE_BUDGET_STEPS < SUBAGENT_MAX_STEPS);
        assert!(EXPLORE_BUDGET_STEPS < SUBAGENT_MAX_STEPS - 3);
    }

    #[test]
    fn explore_report_truncation_keeps_head_and_tail_and_never_points_at_read() {
        let mut messages: Vec<Value> = Vec::new();
        let mut emit = |_: &AgentEvent| {};
        let trace = crate::trace::TraceStore::new(String::new());
        // A report longer than the report cap: the head (answer) AND the tail
        // (search results / file list) must both survive — the main agent works
        // from this report, so a lost tail is lost work it would re-delegate.
        let big = format!("HEAD{}TAIL", "x".repeat(EXPLORE_REPORT_CAP + 100));
        finish_tool(&mut messages, &mut emit, &trace, "c1", "explore", &json!({}), big, true, false, None, None);
        let c = messages[0]["content"].as_str().unwrap();
        assert!(c.contains("HEAD") && c.contains("TAIL"), "head and tail must survive");
        assert!(c.contains("ask explore") && !c.contains("offset/limit"));
        // A raw tool result still points at a narrower read window — and now
        // names the exact resume offset, because "truncated" alone made the
        // model re-read the whole file to find out where it stopped.
        let big2 = "x".repeat(MODEL_RESULT_CAP + 100);
        finish_tool(&mut messages, &mut emit, &trace, "c2", "read", &json!({}), big2, true, true, None, None);
        let c = messages[1]["content"].as_str().unwrap();
        assert!(c.contains("read the rest with offset="), "got: {c}");
    }

    #[test]
    fn a_subagent_provider_error_fails_the_attempt_even_with_partial_text() {
        // The bug this guards: an attempt that streamed some text and THEN hit
        // a provider error used to be reported as a SUCCESS (only an EMPTY
        // report counted as a failure), so the retry ladder never ran and the
        // parent got a truncated report as its tool result.
        let partial = "I searched the repo and found";
        assert_eq!(
            classify_subagent_attempt(&Ok(()), partial, "429 rate limit exceeded").is_err(),
            true,
            "partial text must NOT mask a provider error"
        );
        assert!(classify_subagent_attempt(&Ok(()), partial, "invalid api key")
            .unwrap_err()
            .contains("invalid api key"));
        // A clean, complete report still succeeds.
        assert!(classify_subagent_attempt(&Ok(()), partial, "").is_ok());
        assert!(classify_subagent_attempt(&Ok(()), "  \n report \t", "   ").is_ok());
        // Nothing at all: a failure, and the reason names the empty output.
        assert!(classify_subagent_attempt(&Ok(()), "   ", "")
            .unwrap_err()
            .contains("no output"));
        // The idle guard's hang is carried straight through.
        assert_eq!(
            classify_subagent_attempt(&Err("sub-agent hung: no activity for 300s".into()), "", ""),
            Err("sub-agent failed: sub-agent hung: no activity for 300s".to_string())
        );
    }

    #[test]
    fn a_provider_error_names_the_provider_not_its_wire_kind() {
        // The reported bug: the banner said "custom reported an error
        // mid-stream", and the user answered "I don't have this provider in my
        // fallback list". `custom` is the KIND every OpenAI-compatible endpoint
        // shares, so the message named nothing they had ever configured.
        let providers: std::collections::HashMap<String, Value> = serde_json::from_value(json!({
            "p9": {
                "kind": "custom",
                "name": "9router",
                "baseUrl": "https://x/v1",
                "apiKeys": ["k"]
            }
        }))
        .unwrap();
        let err = "custom reported an error mid-stream: Failed to create stream";
        assert_eq!(
            name_the_provider_in_error(err.to_string(), &providers, "p9", "custom"),
            "9router reported an error mid-stream: Failed to create stream"
        );
        // A later mention deeper in the body is left alone: the gateway may name
        // "custom" itself and rewriting it would corrupt the provider's message.
        assert_eq!(
            name_the_provider_in_error(
                "custom returned no content — rejected by custom".to_string(),
                &providers,
                "p9",
                "custom"
            ),
            "9router returned no content — rejected by custom"
        );
        // Unknown provider id, a nameless provider and a mismatched kind all
        // leave the message exactly as the provider wrote it.
        assert_eq!(
            name_the_provider_in_error(err.to_string(), &providers, "", "custom"),
            err
        );
        assert_eq!(
            name_the_provider_in_error(err.to_string(), &providers, "p9", "anthropic"),
            err
        );
    }

    #[test]
    fn fatal_subagent_errors_are_told_apart_from_transient_ones() {
        // Fatal: retrying the SAME model can never help, so the ladder must
        // fall back to the main model instead of burning all 10 attempts.
        assert!(subagent_error_is_fatal("key rejected (401): invalid api key"));
        assert!(subagent_error_is_fatal(
            "{\"error\":{\"message\":\"model `gpt-x` not found\"}}"
        ));
        assert!(subagent_error_is_fatal("no api key configured"));
        assert!(subagent_error_is_fatal("403 Forbidden"));
        // The model NAME sits between the halves of the sentence.
        assert!(subagent_error_is_fatal("model `claude-x` is unavailable"));
        // Transient: retrying the same model is exactly right, so these must
        // NOT trip the fallback.
        assert!(!subagent_error_is_fatal("429 rate limit exceeded"));
        assert!(!subagent_error_is_fatal("500 internal server error"));
        assert!(!subagent_error_is_fatal("connection refused"));
        assert!(!subagent_error_is_fatal("sub-agent hung: no activity for 300s"));
        assert!(!subagent_error_is_fatal("explore returned no findings: empty"));
        assert!(!subagent_error_is_fatal(""));
    }

    /// The explore ladder's attempt budget must scale with the configured chain.
    ///
    /// With the fixed 10-attempt budget and a rung that fails non-fatally (a
    /// timeout, a 5xx) costing SUBAGENT_RUNG_ATTEMPTS attempts, only the first
    /// five rungs were ever reachable — a six-model fallback list was silently
    /// truncated and the models at its tail were never called, so the user saw
    /// "all my fallbacks are ignored".
    #[test]
    fn explore_attempt_budget_covers_every_rung_of_a_long_chain() {
        // Mirrors the expression in `run_subagent`: every rung gets its own
        // retry budget, and a short chain keeps the original 10 attempts.
        let budget = |chain_len: usize, parent_is_rung: bool| {
            SUBAGENT_MAX_ATTEMPTS.max(
                chain_len.saturating_add(usize::from(parent_is_rung)) * SUBAGENT_RUNG_ATTEMPTS,
            )
        };
        // A long list is fully reachable: 1 slot model + 8 fallbacks + parent.
        let rungs = 1 + 8 + 1;
        assert_eq!(budget(1 + 8, true), rungs * SUBAGENT_RUNG_ATTEMPTS);
        assert!(
            budget(1 + 8, true) >= rungs,
            "every rung must be reachable, got {} attempts for {rungs} rungs",
            budget(1 + 8, true)
        );
        // Non-fatal failures cost a full rung budget each, and even then the
        // whole chain fits.
        assert!(budget(1 + 8, true) / SUBAGENT_RUNG_ATTEMPTS >= rungs);
        // A short chain is unchanged: the historical 10 attempts still apply.
        assert_eq!(budget(1, false), SUBAGENT_MAX_ATTEMPTS);
        assert_eq!(budget(1, true), SUBAGENT_MAX_ATTEMPTS);
        assert_eq!(budget(2, true), SUBAGENT_MAX_ATTEMPTS);
    }

    #[test]
    fn a_rate_limited_slot_model_still_falls_back() {
        // The reported bug: the banner sat on "Sub-agent retrying (7/10) … key
        // rejected (429)" while the user's configured Fallbacks were never
        // tried. A rate limit is correctly classified TRANSIENT, but the
        // ladder's rule is uniform now: ONE try per rung, whatever the failure
        // — a rate limit, a 5xx or a dropped stream all hand the call to the
        // NEXT model immediately, and the walk returns to this rung on the
        // next pass (separated by the pause, not by a same-model retry).
        let budget_spent = |rung_attempts: usize, fatal: bool, can_advance: bool| {
            can_advance && (fatal || rung_attempts >= SUBAGENT_RUNG_ATTEMPTS)
        };
        // A 429 stays transient, so it never forces an immediate jump…
        assert!(!subagent_error_is_fatal(
            "key rejected (429): Rate limit exceeded. Please try again later."
        ));
        // …but a single failure already spends the rung: the NEXT model takes
        // the call with no same-model retry in between.
        assert!(budget_spent(SUBAGENT_RUNG_ATTEMPTS, false, true));
        assert!(budget_spent(1, false, true));
        // A fatal error advances immediately, without waiting for the budget.
        assert!(budget_spent(1, true, true));
    }

    #[test]
    fn a_gateway_without_upstream_credentials_moves_to_the_next_model() {
        // A 9router-style gateway answers every `oc/*` model with "No active
        // credentials for provider: openrouter". That is the GATEWAY saying it
        // holds no credential for its own upstream — retrying the same model can
        // never succeed, so this must reach the user's fallback list instead of
        // burning every attempt on rung 0. Reported by the user as "به فالبک
        // سوئیچ نمیکنه" with the Explore row set to 9router.
        assert!(subagent_error_is_fatal(
            "custom reported an error mid-stream: No active credentials for provider: openrouter"
        ));
        assert!(subagent_error_is_fatal(
            "9router reported an error mid-stream: No active credentials for provider: openrouter"
        ));
        // Prefixes the ladder adds on its way through.
        assert!(subagent_error_is_fatal(
            "explore failed: No active credentials for provider: openrouter"
        ));
        assert!(subagent_error_is_fatal(
            "sub-agent failed: No active credentials for provider: openrouter"
        ));
        // Still transient: a plain 429 must keep the same model.
        assert!(!subagent_error_is_fatal("429 rate limit exceeded"));
        // …and a transport failure must never be read as a broken model.
        assert!(!subagent_error_is_fatal("error sending request: connect timeout"));
    }

    #[test]
    fn subagent_rejects_missing_prompt() {
        // Synchronous guard check: empty prompt must fail fast (no model call).
        let args = json!({"description": "d"});
        assert!(args["prompt"].as_str().unwrap_or_default().is_empty());
    }

    #[test]
    fn retry_live_marker_tracks_the_owning_chat_only() {
        // The Retry endpoint answers from this registry, so it must be per-chat
        // and ref-counted: parallel explore calls in one turn can each retry at
        // the same time, and a marker left behind by one of them would keep
        // promising the button that something is listening.
        assert!(!retry_ladder_live("chat-a"));
        assert!(!retry_ladder_live("chat-b"));

        let a1 = RetryLive::new("chat-a");
        let a2 = RetryLive::new("chat-a");
        let b = RetryLive::new("chat-b");
        assert!(!retry_ladder_live("chat-a"), "unarmed ladder must not count");

        let a1 = {
            let mut a1 = a1;
            a1.arm();
            a1
        };
        let a2 = {
            let mut a2 = a2;
            a2.arm();
            a2
        };
        let b = {
            let mut b = b;
            b.arm();
            b
        };
        assert!(retry_ladder_live("chat-a"));
        assert!(retry_ladder_live("chat-b"));

        // Releasing ONE of the two ladders on chat-a must not clear it.
        drop(a1);
        assert!(retry_ladder_live("chat-a"), "second ladder still live");
        drop(a2);
        assert!(!retry_ladder_live("chat-a"));
        // Chat-b is untouched by chat-a's lifetimes.
        assert!(retry_ladder_live("chat-b"));
        drop(b);
        assert!(!retry_ladder_live("chat-b"));

        // Marking the same ladder twice (arm is idempotent) must not inflate the
        // count and leave a permanently-live chat behind.
        let mut again = RetryLive::new("chat-c");
        again.arm();
        again.arm();
        assert!(retry_ladder_live("chat-c"));
        drop(again);
        assert!(!retry_ladder_live("chat-c"));
    }

    #[test]
    fn nudge_reports_whether_a_ladder_is_listening() {
        // The honest half of POST /chat/retry_now: a banner can outlive its
        // ladder, and a click nothing consumes must NOT be reported as accepted.
        assert!(!nudge_subagent_retry("chat-nobody"));
        let mut live = RetryLive::new("chat-live");
        live.arm();
        assert!(nudge_subagent_retry("chat-live"));
        drop(live);
        assert!(!nudge_subagent_retry("chat-live"));
    }

    #[test]
    fn a_slot_model_change_is_visible_to_a_running_ladder() {
        // The reported bug: "I change the sub-agent model while it is retrying
        // and it still retries with the old one". `subagent_models` reaches the
        // backend only as a snapshot in the turn's request body, so the ladder
        // must be able to see a change made afterwards — and must notice that it
        // differs from the entry it last applied.
        let mut req = base_req();
        req.providers.insert(
            "p2".into(),
            json!({"kind": "custom", "baseUrl": "http://other/v1", "apiKeys": ["k2"]}),
        );
        req.model = "parent-model".into();

        // Anything reported BEFORE the ladder started is already in the turn's
        // snapshot, so it must be ignored — otherwise a stale entry from an
        // earlier turn would clobber this turn's own value.
        let stale = live_slot_seq();
        set_live_slot_entry("explore", "p2/new-model");
        assert_eq!(live_slot_entry_since("explore", stale).as_deref(), Some("p2/new-model"));
        // …but it is invisible to a ladder that started AFTERWARDS.
        let later = live_slot_seq();
        assert_eq!(live_slot_entry_since("explore", later), None);

        // The ladder resolves the LIVE entry, not the request snapshot.
        let live = live_slot_entry_since("explore", stale).unwrap_or_default();
        let (model, base, keys, pid) = resolve_slot_target(&req, &live);
        assert_eq!(model, "new-model");
        assert_eq!(pid, "p2");
        assert_eq!(base, "http://other/v1");
        assert_eq!(keys, vec!["k2".to_string()]);

        // Clearing the slot ("" = parent model) must resolve to the parent, so a
        // user who removes their override stops hit the broken model too.
        set_live_slot_entry("explore", "");
        let live = live_slot_entry_since("explore", stale).unwrap_or_default();
        let (model, _, _, pid) = resolve_slot_target(&req, &live);
        assert_eq!(model, "parent-model");
        assert_eq!(pid, req.provider_id);
    }

    #[tokio::test]
    async fn a_nudge_ends_an_attempt_that_is_already_running() {
        // The reported bug: the banner said "retrying now (requested)" and then
        // nothing happened, because the click could only shorten the backoff —
        // never an attempt already sitting inside a model call. This mirrors the
        // wait the ladder races against that call.
        let from = retry_nudge();
        let waiter = async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                if retry_nudge() != from {
                    return;
                }
            }
        };
        let clicked = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            nudge_subagent_retry("chat-running");
        });
        let ended = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            std::pin::pin!(waiter),
        )
        .await;
        let _ = clicked.await;
        assert!(
            ended.is_ok(),
            "a click must end a RUNNING attempt, not only a backoff wait"
        );
    }

    #[test]
    fn usage_tuple_maps_both_vocabularies() {
        let mut acc = StreamAcc::default();
        acc.usage = Some(json!({"prompt_tokens": 10, "completion_tokens": 5}));
        assert_eq!(usage_tuple(&acc), (10, 5));
        acc.usage = Some(json!({"input_tokens": 7, "output_tokens": 3}));
        assert_eq!(usage_tuple(&acc), (7, 3));
        acc.usage = None;
        assert_eq!(usage_tuple(&acc), (0, 0));
    }

    #[test]
    fn cache_read_is_read_from_every_provider_spelling() {
        // The number that proves prefix caching works on the active gateway.
        // Each provider names it differently, so all spellings must land.
        let mut acc = StreamAcc::default();
        assert_eq!(cache_read_tuple(&acc), 0, "no usage at all is not a hit");
        acc.usage = Some(json!({"prompt_tokens": 1000}));
        assert_eq!(cache_read_tuple(&acc), 0, "absent field means not measured");
        acc.usage = Some(json!({"prompt_cache_hit_tokens": 640}));
        assert_eq!(cache_read_tuple(&acc), 640);
        acc.usage = Some(json!({"cache_read_input_tokens": 512}));
        assert_eq!(cache_read_tuple(&acc), 512);
        acc.usage = Some(json!({"cachedContentTokenCount": 256}));
        assert_eq!(cache_read_tuple(&acc), 256);
        acc.usage = Some(json!({"prompt_tokens_details": {"cached_tokens": 128}}));
        assert_eq!(cache_read_tuple(&acc), 128);
        // The plain `prompt_tokens` count is NEVER a cache hit: counting it
        // would report a 100% hit rate on every gateway that omits the field.
        acc.usage = Some(json!({"prompt_tokens": 999, "cached_tokens": 0}));
        assert_eq!(cache_read_tuple(&acc), 0);
    }

    #[test]
    fn create_skill_persists_the_description_into_the_catalog() {
        use crate::tools::dispatch;
        let dir = std::env::temp_dir().join(format!("codifa-create-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        let out = dispatch(
            root,
            "create_skill",
            &json!({
                "name": "Movie Finder",
                "description": "find movies",
                "content": "Step 1: ask for the genre.",
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("Movie Finder"), "{out}");

        // The description is the trigger: the catalog lists the skill with it,
        // and a legacy keyword line never becomes a catalog line.
        let section = crate::skill_router::build_section(root, &[]);
        assert!(section.text.contains("- Movie Finder"), "{}", section.text);
        assert!(section.text.contains("find movies"), "{}", section.text);
        assert!(!section.text.contains("[fa:"), "{}", section.text);

        // A missing name/content is rejected instead of writing a broken skill.
        assert!(dispatch(root, "create_skill", &json!({"content": "x"}), None).is_err());
        assert!(dispatch(root, "create_skill", &json!({"name": "x"}), None).is_err());

        // The saved skill is marked user-owned, so a later launch cannot revert
        // an edit made here on the user's behalf.
        let dir_path = crate::skills::find_skill_dir_pub(&dir, "Movie Finder").expect("folder");
        assert!(
            crate::skills::marker_origin(&dir_path).as_deref() == Some("user"),
            "create_skill must claim the file so the seeder leaves it alone"
        );

        // A plain create is ordinary: selection runs off the description.
        let out = dispatch(
            root,
            "create_skill",
            &json!({"name": "No Keywords", "description": "d", "content": "c"}),
            None,
        )
        .unwrap();
        assert!(out.contains("No Keywords"), "{out}");

        // deleted_files from the model actually removes the extra file.
        dispatch(
            root,
            "create_skill",
            &json!({
                "name": "Movie Finder",
                "extra_files": {"note.txt": "hello"}
            }),
            None,
        )
        .unwrap();
        let dir_path = crate::skills::find_skill_dir_pub(&dir, "Movie Finder").expect("folder");
        assert!(dir_path.join("note.txt").is_file());
        dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder", "deleted_files": ["note.txt"]}),
            None,
        )
        .unwrap();
        assert!(!dir_path.join("note.txt").exists(), "deleted_files is wired");

        // An OMITTED body must not destroy the stored one: an extra-file-only
        // save, a frontmatter-only edit and a delete all arrive without it.
        dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder"}),
            None,
        )
        .unwrap();
        let kept = std::fs::read_to_string(dir_path.join("skill.md")).unwrap();
        assert!(
            kept.contains("Step 1: ask for the genre."),
            "the stored body survives a body-less save: {kept}"
        );
        // …and the empty body must never be treated as "erase the description".
        assert!(kept.contains("description: find movies"), "{kept}");

        // A NEW skill with no body is still rejected (no empty skill.md).
        assert!(dispatch(
            root,
            "create_skill",
            &json!({"name": "Bodyless", "description": "d"}),
            None,
        )
        .is_err());

        // Deleting needs no body either — the old guard rejected this call.
        let out = dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder", "delete": true}),
            None,
        )
        .unwrap();
        assert!(out.contains("Movie Finder"), "{out}");
        assert!(!dir_path.exists(), "delete removes the folder: {out}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_returns_body_and_lists_names_when_missing() {
        use crate::tools::dispatch;
        let dir = std::env::temp_dir().join(format!("codifa-load-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A skill lives inside a bundle now, so the fixture builds that folder —
        // the same shape `create_skill` writes.
        let bundle = dir.join("plugins").join("movie-finder");
        let sdir = bundle.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            bundle.join("plugin.json"),
            r#"{"name":"Movie Finder","slug":"movie-finder","enabled":true}"#,
        )
        .unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\n---\nBODY HERE\n",
        )
        .unwrap();
        std::fs::write(sdir.join("extra.md"), "EXTRA BODY").unwrap();
        let root = dir.to_str().unwrap();

        let body = dispatch(root, "load_skill", &json!({"name": "Movie Finder"}), None).unwrap();
        assert!(body.contains("BODY HERE"), "{body}");
        assert!(body.contains("Extra files: extra.md"), "{body}");
        // Slug works too, and an extra file is readable on demand.
        let extra = dispatch(root, "load_skill", &json!({"name": "movie-finder", "file": "extra.md"}), None).unwrap();
        assert_eq!(extra, "EXTRA BODY");
        // A miss names the available skills instead of a bare error.
        let err = dispatch(root, "load_skill", &json!({"name": "Ghost"}), None).unwrap_err();
        assert!(err.contains("Movie Finder"), "{err}");
        assert!(dispatch(root, "load_skill", &json!({}), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_query_finds_a_skill_a_huge_store_cannot_list() {
        use crate::tools::dispatch;
        // The prompt's catalog is byte-capped, so a store with hundreds of
        // skills cannot be listed there. `query` is the way to the ones it had
        // to leave out: scoring runs over EVERY installed skill.
        let dir = std::env::temp_dir().join(format!("codifa-skill-query-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for i in 0..40 {
            let name = format!("Bulk Skill {i}");
            let slug = name.to_lowercase().replace(' ', "-");
            let bundle = dir.join("plugins").join(&slug);
            let sdir = bundle.join("skills").join(&slug);
            std::fs::create_dir_all(&sdir).unwrap();
            std::fs::write(
                bundle.join("plugin.json"),
                format!(r#"{{"name":"{name}","slug":"{slug}","enabled":true}}"#),
            )
            .unwrap();
            // One distinctive description per findable skill, the rest filler —
            // the description is the one thing a real query has to find.
            let description = match i {
                39 => "bewildering xylophone maintenance",
                38 => "earthquake drill — زلزله",
                _ => "a filler skill",
            };
            std::fs::write(
                sdir.join("skill.md"),
                format!(
                    "---\nname: {name}\ndescription: {description}\n---\nBODY OF {i}\n"
                ),
            )
            .unwrap();
        }
        let root = dir.to_str().unwrap();

        // Exactly one match returns its body: the model never guesses a name.
        let hit = dispatch(root, "load_skill", &json!({"query": "xylophone"}), None).unwrap();
        assert!(hit.contains("BODY OF 39"), "{hit}");
        // A Persian query term finds its skill through the description — the
        // matcher is Unicode-aware, so a Persian word works like any other.
        let fa = dispatch(root, "load_skill", &json!({"query": "زلزله"}), None).unwrap();
        assert!(fa.contains("BODY OF 38"), "{fa}");
        // Several matches list the candidates instead of inlining a wrong body.
        let many = dispatch(root, "load_skill", &json!({"query": "filler"}), None).unwrap();
        assert!(many.contains("Bulk Skill 0"), "{many}");
        assert!(!many.contains("BODY OF"), "an ambiguous query must not inline a body: {many}");
        // A query that names its skill in SEVERAL words beats the filler matches
        // outright, so it answers on the FIRST call. Traced (`mvyy1qf7`): such a
        // query listed the right skill beside three one-word matches and the model
        // then spent a second call naming it — twice in one turn. Under IDF the
        // lead only grows: one unique word against boilerplate ("skill" is in
        // every name) is already a clear winner, so the one-unique-word query
        // below answers with the body too. A GENUINE tie — every candidate
        // matching the same words — is what still lists candidates.
        let dominant = dispatch(
            root,
            "load_skill",
            &json!({"query": "bewildering xylophone maintenance skill"}),
            None,
        )
        .unwrap();
        assert!(dominant.contains("BODY OF 39"), "a clear winner answers at once: {dominant}");
        let one_unique = dispatch(
            root,
            "load_skill",
            &json!({"query": "maintenance skill"}),
            None,
        )
        .unwrap();
        assert!(one_unique.contains("BODY OF 39"), "the unique word decides: {one_unique}");
        let tied = dispatch(
            root,
            "load_skill",
            &json!({"query": "filler skill"}),
            None,
        )
        .unwrap();
        assert!(tied.contains("Bulk Skill 0"), "{tied}");
        assert!(!tied.contains("BODY OF"), "a real tie must still list candidates: {tied}");
        // A miss answers with a HINT, not with 40 names: a store with hundreds
        // of skills would spend a turn's worth of tokens on a failed lookup.
        let miss = dispatch(root, "load_skill", &json!({"query": "zzzz"}), None).unwrap_err();
        assert!(miss.contains("no skill matches"), "{miss}");
        assert!(miss.contains("and 10 more"), "the hint must say it is truncated: {miss}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_reaches_a_skill_that_lives_inside_a_plugin() {
        // Regression: the catalog advertises enabled-plugin skills, but this
        // tool read only the standalone store, so a plugin skill answered
        // "skill not found: … Available: (none)" right after being listed.
        use crate::tools::dispatch_with_data_root;
        let root = std::env::temp_dir().join(format!("codifa-plugin-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        crate::plugins::create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "READ THE GIT LOG",
                    "extra_files": {"checklist.md": "- tag it"}
                }]
            }),
        )
        .unwrap();
        let r = root.to_str().unwrap();

        // Part of the catalog…
        let section = crate::skill_router::build_section(r, &[]);
        assert!(section.text.contains("- Release Notes"), "{}", section.text);
        // …loadable by name and by slug…
        let body = dispatch_with_data_root(r, "load_skill", &json!({"name": "Release Notes"}), None, Some(r)).unwrap();
        assert!(body.contains("READ THE GIT LOG"), "{body}");
        let by_slug = dispatch_with_data_root(r, "load_skill", &json!({"name": "release-notes"}), None, Some(r)).unwrap();
        assert!(by_slug.contains("READ THE GIT LOG"), "{by_slug}");
        // …and its extra files are readable too.
        let extra = dispatch_with_data_root(r, "load_skill", &json!({"name": "Release Notes", "file": "checklist.md"}), None, Some(r)).unwrap();
        assert_eq!(extra, "- tag it");
        // A plugin skill is listed in the catalog (with its clipped detail), so
        // the model can load it by name — an unrelated prompt carries no body.
        let cat = crate::skill_router::build_section(r, &[]);
        assert!(cat.text.contains("- Release Notes"), "{}", cat.text);
        assert!(!cat.text.contains("READ THE GIT LOG"), "{}", cat.text);

        // …and the skill's own keyword in the prompt attaches NOTHING: picking a
        // skill is the model's call, made from the catalog (load_skill).
        let matched = crate::skill_router::build_section(r, &[]);
        assert!(matched.text.contains("- Release Notes"), "{}", matched.text);
        assert!(!matched.text.contains("READ THE GIT LOG"), "{}", matched.text);

        // Disabled plugin = gone from the catalog AND unloadable.
        crate::plugins::toggle_plugin(&root, &json!({"slug": "release-notes", "enabled": false})).unwrap();
        assert!(!crate::skill_router::build_section(r, &[]).text.contains("- Release Notes"));
        let err = dispatch_with_data_root(r, "load_skill", &json!({"name": "Release Notes"}), None, Some(r)).unwrap_err();
        assert!(err.contains("skill not found"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_skill_resolves_from_the_data_root_not_the_workspace() {
        // The catalog is built from the DATA root, but dispatch used to resolve
        // skills against the WORKSPACE root: a real chat showed the catalog and
        // then failed every load with "Available: (none)" (in a trace). A bare
        // workspace must still load a skill that lives in the data root.
        use crate::tools::dispatch_with_data_root;
        let base = std::env::temp_dir().join(format!("codifa-skill-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let ws = base.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let sdir = data
            .join("plugins")
            .join("playwrite")
            .join("skills")
            .join("playwrite");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            data.join("plugins").join("playwrite").join("plugin.json"),
            r#"{"name":"Playwrite","slug":"playwrite","enabled":true}"#,
        )
        .unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Playwrite\ndescription: browser automation\n---\nBROWSER BODY\n",
        )
        .unwrap();
        let data = data.to_str().unwrap();
        let ws = ws.to_str().unwrap();

        // Data root known -> found even though the workspace has no skills.
        let body = dispatch_with_data_root(
            ws,
            "load_skill",
            &json!({"name": "Playwrite"}),
            None,
            Some(data),
        )
        .unwrap();
        assert!(body.contains("BROWSER BODY"), "{body}");

        // No data root given -> the old workspace-relative behaviour stays.
        let err = dispatch_with_data_root(
            ws,
            "load_skill",
            &json!({"name": "Playwrite"}),
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("(none)"), "{err}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dispatch_via_tools_roundtrip() {
        let dir = std::env::temp_dir().join(format!("codifa-agent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let (msg, ok) = match tools::dispatch(&root, "write_file", &json!({"path": "a.txt", "content": "hello"}), None) {
            Ok(m) => (m, true),
            Err(m) => (m, false),
        };
        assert!(ok, "{msg}");
        let (msg, ok) = match tools::dispatch(&root, "read", &json!({"filePath": "a.txt"}), None) {
            Ok(m) => (m, true),
            Err(m) => (m, false),
        };
        assert!(ok && msg.contains("hello"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_request_deserializes_minimal_body() {
        let body = json!({
            "provider": "custom",
            "model": "m1",
            "root": "/tmp/x",
            "prompt": "hi"
        });
        let req: AgentRequest = serde_json::from_value(body).unwrap();
        assert_eq!(req.mode, "build");
        assert!(req.api_keys.is_empty());
    }

    #[test]
    fn fold_prefix_never_orphans_tool_or_user_tail() {
        // A turn with no assistant answer yet is not foldable at all.
        assert_eq!(
            fold_prefix_len(&[json!({"role": "user", "content": "hi"})]),
            0
        );
        // Last assistant is the boundary: the trailing live user prompt is
        // never folded, and the tail never starts with a `tool` reply.
        let hist = vec![
            json!({"role": "user", "content": "task"}),
            json!({"role": "assistant", "tool_calls": [{"id": "t1"}]}),
            json!({"role": "tool", "tool_call_id": "t1", "content": "r1"}),
            json!({"role": "assistant", "content": "answer"}),
            json!({"role": "user", "content": "next"}),
        ];
        assert_eq!(fold_prefix_len(&hist), 3);
        let tail = &hist[fold_prefix_len(&hist)..];
        assert_eq!(tail[0]["role"].as_str(), Some("assistant"));
    }

    #[test]
    fn fold_keeps_every_tool_result_with_its_call() {
        let hist = vec![
            json!({"role": "user", "content": "a"}),
            json!({"role": "assistant", "tool_calls": [{"id": "t1"}]}),
            json!({"role": "tool", "tool_call_id": "t1", "content": "r1"}),
            json!({"role": "assistant", "tool_calls": [{"id": "t2"}]}),
            json!({"role": "tool", "tool_call_id": "t2", "content": "r2"}),
        ];
        let cut = fold_prefix_len(&hist);
        assert_eq!(cut, 3);
        let tail = &hist[cut..];
        assert_eq!(tail[0]["role"].as_str(), Some("assistant"));
        // Providers reject an orphaned tool reply, so every `tool` message kept
        // verbatim must still sit directly after its assistant call.
        for (i, m) in tail.iter().enumerate() {
            if m["role"] == "tool" {
                assert_eq!(tail[i - 1]["role"].as_str(), Some("assistant"));
            }
        }
    }

    #[test]
    fn fold_shrinks_stale_edit_file_arguments_and_keeps_the_call() {
        // A stale edit call whose arguments carry the whole rewritten body: the
        // `tool` result is folded to a pointer, so the args are dead weight the
        // provider re-bills on every later round.
        let big = "b".repeat(30_000);
        let args = json!({"path": "a.rs", "old_string": big, "new_string": big}).to_string();
        let mut messages: Vec<Value> = Vec::new();
        messages.push(json!({"role": "user", "content": "go"}));
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "function": {"name": "edit_file", "arguments": args}}],
        }));
        messages.push(json!({"role": "tool", "tool_call_id": "c1", "content": "ok"}));
        // Two fresh rounds below `MAIN_FOLD_KEEP_ROUNDS`, so `c1` is stale.
        for n in 0..MAIN_FOLD_KEEP_ROUNDS {
            messages.extend(fold_round(&format!("fresh{n}"), "read", "small"));
        }

        let mut seen = std::collections::HashSet::new();
        let (removed, folded) = fold_stale_tool_results(&mut messages, &mut seen);

        assert!(folded > 0, "the oversized edit args must be folded");
        assert!(removed > 20_000, "most of the 60K args must come off the wire");
        // The call itself survives: dropping it would orphan its `tool` reply,
        // which providers reject outright.
        let calls = messages[1]["tool_calls"].as_array().expect("call kept");
        assert_eq!(calls.len(), 1);
        let folded_args = calls[0]["function"]["arguments"].as_str().unwrap();
        assert!(folded_args.contains(MAIN_FOLD_MARKER));
        // The provider re-parses `arguments` on every later round-trip, so a
        // head-truncated fragment would 400 the turn. The object must stay
        // valid JSON, and the call's identity (`path`) must survive so the model
        // still knows WHICH file an earlier round touched.
        let reparsed: Value = serde_json::from_str(folded_args)
            .expect("folded arguments must remain parseable JSON");
        assert_eq!(reparsed["path"].as_str(), Some("a.rs"));
        assert!(reparsed["old_string"].is_string());
        // The pairing the provider validates is intact.
        assert_eq!(messages[2]["tool_call_id"].as_str(), Some("c1"));
    }

    #[test]
    fn estimate_wire_tokens_counts_content_and_call_arguments() {
        let msgs = vec![json!({"role": "user", "content": "x".repeat(400)})];
        assert_eq!(estimate_wire_tokens(&msgs), 100);
        assert_eq!(estimate_wire_tokens(&[]), 0);

        // A `content`-only estimate read the wire as less than a third of what
        // the provider billed: an assistant call carries its arguments (for
        // `edit_file`, the whole rewritten file body) OUTSIDE `content`.
        let with_call = vec![json!({
            "role": "assistant",
            "content": "x".repeat(400),
            "tool_calls": [{
                "id": "t1",
                "function": {"name": "edit_file", "arguments": "y".repeat(400)},
            }],
        })];
        // 400 content + 9 name + 400 args = 809 chars -> 203 tokens.
        assert_eq!(estimate_wire_tokens(&with_call), 203);
    }

    /// One "round": an assistant message carrying a single tool_call plus the
    /// `tool` result message that call produced.
    fn fold_round(call_id: &str, tool: &str, result: &str) -> Vec<Value> {
        fold_round_args(call_id, tool, "{}", result)
    }

    fn fold_round_args(call_id: &str, tool: &str, args: &str, result: &str) -> Vec<Value> {
        vec![
            json!({"role": "assistant", "content": Value::Null,
                   "tool_calls": [{"id": call_id, "type": "function",
                                   "function": {"name": tool, "arguments": args}}]}),
            json!({"role": "tool", "tool_call_id": call_id, "content": result}),
        ]
    }

    fn seen_set() -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }

    #[test]
    fn a_read_is_covered_by_a_wider_window_already_served() {
        // The exact-key guard only sees a LITERALLY identical call. Traced on
        // the real corpus, 17 whole reads asked for a window already contained
        // in a wider span served earlier in the same turn (the model widens a
        // window it was told about, then narrows back onto the lines it needs)
        // — 190_602 chars re-sent for content already in the context.
        let mut seen = seen_set();
        record_read_coverage(&mut seen, &tools::read_windows_of(&json!({
            "filePath": "src/a.rs", "offset": 100, "limit": 400
        })));

        // A narrower window of the same file is covered.
        assert!(read_windows_covered(
            &seen,
            &tools::read_windows_of(&json!({"filePath": "src/a.rs", "offset": 200, "limit": 50}))
        ));
        // A window that pokes ONE line past the served span is not: the model
        // must still be able to fetch the line it cannot see.
        assert!(!read_windows_covered(
            &seen,
            &tools::read_windows_of(&json!({"filePath": "src/a.rs", "offset": 400, "limit": 101}))
        ));
        // A different file is never covered by another file's span.
        assert!(!read_windows_covered(
            &seen,
            &tools::read_windows_of(&json!({"filePath": "src/b.rs", "offset": 200, "limit": 50}))
        ));
        // EVERY window of a batch must be covered, or the call runs.
        assert!(!read_windows_covered(
            &seen,
            &tools::read_windows_of(&json!({"ranges": [
                {"path": "src/a.rs", "offset": 200, "limit": 50},
                {"path": "src/a.rs", "offset": 9000, "limit": 50}
            ]}))
        ));
        // An omitted offset/limit means the default window, exactly as dispatch
        // reads it — the two must not disagree.
        let mut wide = seen_set();
        record_read_coverage(&mut wide, &tools::read_windows_of(&json!({"filePath": "x.rs"})));
        assert!(read_windows_covered(
            &wide,
            &tools::read_windows_of(&json!({"filePath": "x.rs", "offset": 1, "limit": 400}))
        ));
        // A call naming no file is an error the model must see, never a hit.
        assert!(!read_windows_covered(&wide, &tools::read_windows_of(&json!({}))));
    }

    #[test]
    fn a_folded_read_forgets_the_coverage_its_body_granted() {
        // The fold marker tells the model to re-run the read. If coverage still
        // claims those lines, the re-run is answered with a pointer to a body
        // that is no longer on the wire — the data becomes unreachable.
        let args = r#"{"filePath":"a.txt","offset":1,"limit":400}"#;
        let windows = tools::read_windows_of(&serde_json::from_str(args).unwrap());
        let mut seen = seen_set();
        record_read_coverage(&mut seen, &windows);
        assert!(read_windows_covered(&seen, &windows));

        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round_args("c1", "read", args, &"r".repeat(30_000)));
        messages.extend(fold_round("c2", "read", "small"));
        messages.extend(fold_round("c3", "read", "small"));
        fold_stale_tool_results(&mut messages, &mut seen);

        assert!(messages[1]["content"].as_str().unwrap().ends_with(MAIN_FOLD_MARKER));
        assert!(
            !read_windows_covered(&seen, &windows),
            "a folded read must drop the coverage of the windows it served"
        );
    }

    #[test]
    fn a_cut_window_does_not_count_as_served() {
        // A read whose tail was cut never delivered those lines; its own marker
        // names the resume offset, and coverage must not answer that follow-up
        // with "already returned above".
        assert!(result_was_window_cut(
            "a.rs (lines 1-400):\n1: x\n… (window truncated at line 300 of 1000: …)"
        ));
        assert!(result_was_window_cut(
            "a.rs (lines 1-9): (window too large for the result budget — read it with a smaller limit)"
        ));
        assert!(!result_was_window_cut("a.rs (lines 1-400):\n1: x\n"));
    }

    #[test]
    fn only_a_workspace_writer_forgets_the_lookup_cache() {
        // MEASURED: the blanket rule (`!is_readonly(name)`) wiped the whole cache
        // 247 times, 60 of them from calls that cannot touch a workspace file.
        // Each wipe discarded the read coverage recorded one call earlier, which
        // is why the coverage guard fired 6 times against 137 re-asked windows.
        let root = env!("CARGO_MANIFEST_DIR");
        for (name, args) in [
            ("explore", json!({})),
            ("web_search", json!({})),
            ("fetch_url", json!({})),
            ("system_stats", json!({})),
            ("save_memory", json!({})),
            ("ask_user", json!({})),
            ("load_skill", json!({})),
            ("confirm_action", json!({})),
        ] {
            assert!(
                !mutates_workspace(name, &args),
                "{name} cannot write the workspace and must not wipe the cache"
            );
        }
        assert!(
            !root.is_empty(),
            "the workspace root is only here to keep the assertion honest"
        );
        // A writer still forgets: a pointer would feed the model a pre-edit body.
        for (name, args) in [
            ("write_file", json!({})),
            ("edit_file", json!({})),
            ("artifact", json!({})),
            ("plugin", json!({})),
            ("create_skill", json!({})),
            // The whole terminal counts as a writer, even for a look: `sh -c`
            // cannot be proven non-writing, and the measured cost is zero.
            ("run_terminal", json!({"command": "ls -la src"})),
            ("run_terminal", json!({"command": "git status --short"})),
            ("run_terminal", json!({"command": "cargo test"})),
            ("run_terminal", json!({"command": "python3 build.py"})),
            ("run_terminal", json!({"command": "echo hi > src/a.ts"})),
        ] {
            assert!(
                mutates_workspace(name, &args),
                "{name} can change files and must clear the cached bodies"
            );
        }
    }

    #[test]
    fn lsp_and_glob_lookups_are_deduplicated_too() {
        // These arms were missing, so an explore run traced three identical
        // `lsp_symbols` calls on the SAME file (12_880 model chars each) that
        // the repeat guard never saw. Every field that can change the ANSWER
        // must be in the key.
        let sym = lookup_key("lsp_symbols", &json!({"filePath": "src/a.rs"})).unwrap();
        assert_eq!(sym, "lsp_symbols|src/a.rs|");
        assert_eq!(
            sym,
            lookup_key("lsp_symbols", &json!({"filePath": "src/a.rs"})).unwrap(),
            "identical lookup must produce an identical key"
        );
        assert_ne!(
            sym,
            lookup_key("lsp_symbols", &json!({"filePath": "src/a.rs", "query": "run"})).unwrap(),
            "a query filters a different symbol list"
        );
        assert_ne!(
            sym,
            lookup_key("lsp_symbols", &json!({"filePath": "src/b.rs"})).unwrap()
        );

        assert_eq!(
            lookup_key("lsp_diagnostics", &json!({"filePath": "src/a.rs"})).unwrap(),
            "lsp_diagnostics|src/a.rs"
        );

        // Definition/references/hover share a key SHAPE, so the tool name is
        // what keeps them apart — the definition of X is not the references of X.
        let def = lookup_key("lsp_definition", &json!({"filePath": "a.rs", "symbol": "run"}))
            .unwrap();
        assert_eq!(def, "lsp_definition|a.rs|run|0|0");
        assert_ne!(
            def,
            lookup_key("lsp_references", &json!({"filePath": "a.rs", "symbol": "run"})).unwrap()
        );
        // A repeated name: the line hint selects a different occurrence.
        assert_ne!(
            lookup_key("lsp_hover", &json!({"filePath": "a.rs", "symbol": "run", "line": 10}))
                .unwrap(),
            lookup_key("lsp_hover", &json!({"filePath": "a.rs", "symbol": "run", "line": 20}))
                .unwrap()
        );

        let glob = lookup_key("glob", &json!({"pattern": "**/*.rs", "path": "src"})).unwrap();
        assert_eq!(glob, "glob|**/*.rs|src|100");
        assert_ne!(
            glob,
            lookup_key("glob", &json!({"pattern": "**/*.ts", "path": "src"})).unwrap()
        );
        assert_ne!(
            glob,
            lookup_key("glob", &json!({"pattern": "**/*.rs", "path": "src", "max_results": 5}))
                .unwrap(),
            "a smaller max_results is a different answer"
        );
        // An unusable call yields NO key, so the guard can never answer a call
        // the dispatcher would have rejected differently.
        assert!(lookup_key("lsp_symbols", &json!({})).is_none());
        assert!(lookup_key("lsp_definition", &json!({"filePath": "a.rs"})).is_none());
        assert!(lookup_key("glob", &json!({"path": "src"})).is_none());
    }

    #[test]
    fn a_mutating_call_cannot_be_classified_as_readonly() {
        // The repeat-guard is cleared after every NON-read-only call, so this
        // list is a correctness boundary rather than a speed knob: a mutating
        // tool listed as read-only would let a later `read` be answered with a
        // pointer to the file as it was BEFORE the edit — the model would never
        // see its own change.
        for t in [
            "write_file",
            "edit_file",
            "run_terminal", // arbitrary `sh -c` in the workspace root
            "delete_memory",
            "save_memory",
            "create_skill",
            "create_mcp",
            "explore",
        ] {
            assert!(
                !is_readonly_native(t),
                "{t} can mutate state and must never be treated as a pure read"
            );
        }
        // The pure readers the guard is allowed to answer with a pointer.
        for t in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_symbols",
            "lsp_diagnostics",
        ] {
            assert!(is_readonly_native(t), "{t} is a pure read");
        }
    }

    #[test]
    fn fold_shrinks_only_results_older_than_the_kept_rounds() {
        // Four rounds; the last MAIN_FOLD_KEEP_ROUNDS (2) are the fresh zone.
        let explore_big = "e".repeat(30_000);
        let read_big = "r".repeat(30_000);
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "explore", &explore_big)); // stale
        messages.extend(fold_round("c2", "read", &read_big)); // stale
        messages.extend(fold_round("c3", "grep", &read_big)); // fresh
        messages.extend(fold_round("c4", "glob", &read_big)); // fresh
        let before = messages.clone();

        fold_stale_tool_results(&mut messages, &mut seen_set());

        // The stale explore report gets the explore budget (the report is the
        // main agent's only view of that research)...
        let r1 = messages[1]["content"].as_str().unwrap();
        assert_eq!(
            r1.chars().count(),
            MAIN_FOLD_EXPLORE_CHARS + 1 + MAIN_FOLD_MARKER.chars().count()
        );
        assert!(r1.ends_with(MAIN_FOLD_MARKER));
        // ...an ordinary stale result the smaller generic budget...
        let r2 = messages[3]["content"].as_str().unwrap();
        assert_eq!(
            r2.chars().count(),
            MAIN_FOLD_RESULT_CHARS + 1 + MAIN_FOLD_MARKER.chars().count()
        );
        assert!(r2.ends_with(MAIN_FOLD_MARKER));
        // ...and both kept rounds stay BYTE-IDENTICAL: the model is actively
        // reasoning over those results.
        assert_eq!(messages[5], before[5]);
        assert_eq!(messages[7], before[7]);

        // Idempotence: folding again changes nothing.
        let once = messages.clone();
        fold_stale_tool_results(&mut messages, &mut seen_set());
        assert_eq!(messages, once);
    }

    #[test]
    fn fold_forgets_the_lookup_so_the_pointer_can_be_re_resolved() {
        // The folded marker tells the model to re-run the tool. If the
        // repeat-guard still remembers that lookup, the re-run is answered
        // with "already looked this up" while the body is gone — the data is
        // then unreachable for the rest of the turn.
        let args = r#"{"filePath":"a.txt"}"#;
        let key = lookup_key("read", &serde_json::from_str(args).unwrap()).unwrap();
        let mut seen = seen_set();
        seen.insert(key.clone());
        assert!(seen.contains(&key));

        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round_args("c1", "read", args, &"r".repeat(30_000)));
        messages.extend(fold_round("c2", "read", "small"));
        messages.extend(fold_round("c3", "read", "small"));
        fold_stale_tool_results(&mut messages, &mut seen);

        assert!(messages[1]["content"].as_str().unwrap().ends_with(MAIN_FOLD_MARKER));
        assert!(!seen.contains(&key), "the repeat-guard must forget a folded lookup");
    }

    #[test]
    fn fold_is_a_noop_within_the_kept_rounds() {
        let big = "x".repeat(30_000);
        // Exactly MAIN_FOLD_KEEP_ROUNDS rounds: nothing is stale yet.
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "read", &big));
        messages.extend(fold_round("c2", "read", &big));
        let before = messages.clone();
        fold_stale_tool_results(&mut messages, &mut seen_set());
        assert_eq!(messages, before);

        // No tool_calls at all (and an empty list): also a no-op, no panic.
        let mut plain = vec![json!({"role": "user", "content": "hi"})];
        let plain_before = plain.clone();
        fold_stale_tool_results(&mut plain, &mut seen_set());
        assert_eq!(plain, plain_before);
        let mut empty: Vec<Value> = Vec::new();
        fold_stale_tool_results(&mut empty, &mut seen_set());
        assert!(empty.is_empty());
    }

    #[test]
    fn fold_truncates_on_a_char_boundary_for_persian() {
        // 30K Persian chars: a raw BYTE slice at 2000/8000 would land inside a
        // multi-byte character and panic (with panic=abort it kills the app).
        let persian = "سلام دنیا ".repeat(3_000);
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "read", &persian));
        messages.extend(fold_round("c2", "read", "small"));
        messages.extend(fold_round("c3", "read", "small"));
        fold_stale_tool_results(&mut messages, &mut seen_set());
        let r1 = messages[1]["content"].as_str().unwrap();
        assert!(r1.ends_with(MAIN_FOLD_MARKER));
        assert_eq!(
            r1.chars().count(),
            MAIN_FOLD_RESULT_CHARS + 1 + MAIN_FOLD_MARKER.chars().count()
        );
    }

    /// "Results per search" (Settings → Web Providers) is ONE number with two
    /// effects. These assertions pin the contract the UI promises: it is the
    /// ONLY thing that decides the result count, `0` still returns results (it
    /// only stops the page fetch), and nothing can exceed the hard cap.
    #[test]
    fn web_search_result_count_comes_from_the_settings_number() {
        // Default setting (5) → five results.
        assert_eq!(web_search_result_count(5), 5);
        // Any other setting is used verbatim.
        assert_eq!(web_search_result_count(8), 8);
        // 0 = "don't fetch pages", NOT "return nothing".
        assert_eq!(
            web_search_result_count(0),
            crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
        );
        // Out-of-range values are clamped to a sane range instead of trusted.
        assert_eq!(web_search_result_count(99), crate::websearch::WEB_SEARCH_AUTO_FETCH_MAX);
    }

    fn base_req() -> AgentRequest {
        AgentRequest {
            provider: "custom".into(),
            provider_id: "p1".into(),
            model: "main-model".into(),
            base_url: "http://parent/v1".into(),
            api_key: "pk".into(),
            api_keys: vec!["pk".into()],
            root: "/tmp/x".into(),
            mode: "build".into(),
            prompt: "hi".into(),
            history: Vec::new(),
            system_prompt: String::new(),
            system_suffix: String::new(),
            skills: Vec::new(),
            context_window: 0,
            chat_id: String::new(),
            mcp_servers: Value::Null,
            mcp_active: Vec::new(),
            providers: std::collections::HashMap::new(),
            subagent_models: std::collections::HashMap::new(),
            data_root: String::new(),
            allow_computer: false,
            allow_create: false,
            allow_browser: false,
            allow_outside: false,
            allow_outside_folders: Vec::new(),
            search_plugins: Vec::new(),
            image_provider_id: String::new(),
            image_model: String::new(),
            image_fallbacks: Vec::new(),
            video_provider_id: String::new(),
            video_model: String::new(),
            video_fallbacks: Vec::new(),
            compact_at_percent: 80,
            fallback_provider: String::new(),
            fallback_model: String::new(),
            fallback_base_url: String::new(),
            fallback_api_key: String::new(),
            fallback_api_keys: Vec::new(),
            thinking_level: String::new(),
            model_reasoning: false,
            subagent_thinking: std::collections::HashMap::new(),
            tool_fallbacks: std::collections::HashMap::new(),
            images: Vec::new(),
            subagent_tools: Vec::new(),
            web_search_auto_fetch: crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT,
            // No renderer to send a table: derive it from the mode instead.
            cap: None,
            // Tests exercise the interactive protocol (Error/Done events).
            headless: false,
        }
    }

    #[test]
    fn subagent_model_slot_defaults_to_parent() {
        let req = base_req();
        let (model, base, keys, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "main-model");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(keys, vec!["pk".to_string()]);
        assert_eq!(pid, "p1");
    }

    #[test]
    fn subagent_model_slot_bare_model_uses_parent_provider() {
        let mut req = base_req();
        req.subagent_models
            .insert("explore".into(), "cheap-model".into());
        let (model, base, _, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "cheap-model");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(pid, "p1");
    }

    /// The `fetch_url` payload must be distilled by the "Other" (web) slot
    /// model — the same model that answers `web_search` — with that slot's own
    /// reasoning level, and attributed to the slot's provider.
    #[tokio::test]
    async fn slot_distill_uses_the_web_slot_model_and_reasoning() {
        let (mock_base, rx) = spawn_json_mock_upstream("distilled page summary").await;
        let bodies = drain_bodies(rx);

        let mut req = base_req();
        req.subagent_models
            .insert("web".into(), format!("slot-prov/{MOCK_MODEL}"));
        req.subagent_thinking.insert("web".into(), "max".into());
        req.providers.insert(
            "slot-prov".into(),
            json!({
                "kind": "custom",
                "baseUrl": format!("{mock_base}/v1"),
                "apiKeys": ["sk-slot"],
                // A custom provider is not auto-detected as reasoning-capable,
                // so the capability must be declared exactly like the real
                // settings.json does (Settings → provider → manualReasoningMap).
                "manualReasoningMap": { MOCK_MODEL: true },
                // The levels the model was described with. A level no source
                // enumerated is never sent, so the slot needs one to reason at
                // all (Settings → provider, from the provider's `/models`).
                "thinkingLevelsMap": { MOCK_MODEL: ["none", "low", "medium", "high", "xhigh"] },
            }),
        );
        let main = LlmConfig {
            provider: "custom".into(),
            headers: Vec::new(),
            provider_id: "main-prov".into(),
            model: "main-model".into(),
            base_url: "http://parent/v1".into(),
            api_keys: vec!["pk".into()],
            temperature: Some(0.2),
            max_tokens: Some(1024),
            timeout_secs: 10,
            reasoning_level: "high".into(),
            model_reasoning: false,
            auto_think: false,
        };

        let out = run_slot_distill(
            &reqwest::Client::new(),
            &req,
            &main,
            FETCH_DISTILL_SYSTEM_PROMPT,
            "URL: https://example.com\n\nPAGE:\nbody",
        )
        .await;
        assert_eq!(out.as_deref(), Some("distilled page summary"));

        let sent = bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .expect("the distiller never called the slot provider");
        assert_eq!(
            sent["model"], MOCK_MODEL,
            "the Other slot model must distil the page, not the chat model: {sent}"
        );
        assert_eq!(
            sent["reasoning_effort"], "xhigh",
            "the slot's own level must be sent verbatim, as its source named it: {sent}"
        );
        assert_ne!(
            sent["model"], "main-model",
            "a configured slot must never fall back to the main model: {sent}"
        );
    }

    /// An empty Other row means NO distiller: the raw payload is handed over
    /// untouched and no upstream call is made at all.
    #[tokio::test]
    async fn slot_distill_is_skipped_when_the_slot_is_unset() {
        let (mock_base, rx) = spawn_json_mock_upstream("should never be used").await;
        let bodies = drain_bodies(rx);

        // No `web` entry in subagent_models at all.
        let mut req = base_req();
        req.providers.insert(
            "p1".into(),
            json!({"kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["pk"]}),
        );
        let main = LlmConfig {
            provider: "custom".into(),
            headers: Vec::new(),
            provider_id: "p1".into(),
            model: "main-model".into(),
            base_url: format!("{mock_base}/v1"),
            api_keys: vec!["pk".into()],
            temperature: Some(0.2),
            max_tokens: Some(1024),
            timeout_secs: 10,
            reasoning_level: "high".into(),
            model_reasoning: false,
            auto_think: false,
        };

        let out = run_slot_distill(
            &reqwest::Client::new(),
            &req,
            &main,
            WEB_DISTILL_SYSTEM_PROMPT,
            "QUERY: x\n\nSEARCH RESULTS:\n- a",
        )
        .await;
        assert!(out.is_none(), "an unset slot must not produce a distillation");
        // Give any (wrong) in-flight request a chance to land before asserting.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(
            bodies.lock().unwrap().is_empty(),
            "an unset Other row must not spend the chat model on a side call"
        );
    }

    /// An UNSET web slot with a configured fallback list must still distil.
    ///
    /// The empty slot used to return early before the list was ever read, so a
    /// fallback added in Settings → Tools was silently dead: the row looked
    /// configured and nothing ever called it.
    #[tokio::test]
    async fn slot_distill_runs_the_fallback_list_of_an_unset_slot() {
        let (mock_base, rx) = spawn_json_mock_upstream("distilled by fallback").await;
        let bodies = drain_bodies(rx);

        let mut req = base_req();
        // No `web` model at all — only a fallback list.
        req.tool_fallbacks.insert(
            "web".into(),
            vec![format!("slot-prov/{MOCK_MODEL}")],
        );
        req.providers.insert(
            "slot-prov".into(),
            json!({
                "kind": "custom",
                "baseUrl": format!("{mock_base}/v1"),
                "apiKeys": ["sk-slot"],
            }),
        );
        let main = LlmConfig {
            provider: "custom".into(),
            headers: Vec::new(),
            provider_id: "main-prov".into(),
            model: "main-model".into(),
            base_url: "http://parent/v1".into(),
            api_keys: vec!["pk".into()],
            temperature: Some(0.2),
            max_tokens: Some(1024),
            timeout_secs: 10,
            reasoning_level: "high".into(),
            model_reasoning: false,
            auto_think: false,
        };

        let out = run_slot_distill(
            &reqwest::Client::new(),
            &req,
            &main,
            WEB_DISTILL_SYSTEM_PROMPT,
            "QUERY: x\n\nSEARCH RESULTS:\n- a",
        )
        .await;
        assert_eq!(
            out.as_deref(),
            Some("distilled by fallback"),
            "a configured fallback list must be used even when the slot model is empty"
        );
        let sent = bodies.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "exactly one rung, got {sent:?}");
        assert_eq!(sent[0]["model"], MOCK_MODEL);
        // The unset slot contributes NO rung of its own: the main model must not
        // be spent on a side call the user never asked for.
        assert_ne!(sent[0]["model"], "main-model");
    }

    #[test]
    fn subagent_model_slot_routes_cross_provider() {
        let mut req = base_req();
        req.subagent_models
            .insert("explore".into(), "p2/other-model".into());
        req.providers.insert(
            "p2".into(),
            json!({"baseUrl": "http://other/v1", "apiKeys": ["ok1", "ok2"]}),
        );
        let (model, base, keys, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "other-model");
        assert_eq!(base, "http://other/v1");
        assert_eq!(keys, vec!["ok1".to_string(), "ok2".to_string()]);
        // Cross-provider: the EFFECTIVE provider id, not the parent's "p1".
        assert_eq!(pid, "p2");
    }

    #[test]
    fn subagent_model_slot_keeps_a_slash_bearing_model_name_intact() {
        // `ghost/m` is a MODEL id: `ghost` is not a configured provider, so the
        // entry must NOT be split into provider `ghost` + model `m` (which sent
        // the remainder to the parent's endpoint and 404'd).
        let mut req = base_req();
        req.subagent_models
            .insert("explore".into(), "ghost/m".into());
        let (model, base, keys, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "ghost/m");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(keys, vec!["pk".to_string()]);
        assert_eq!(pid, "p1");
    }

    #[test]
    fn subagent_snapshot_drops_history_but_keeps_settings() {
        // A four-explore step snapshots the parent once per explore. The
        // transcript must not ride along: run_subagent never reads it, so a
        // full clone only copies the whole chat (megabytes on a long one)
        // once per parallel sub-agent before it is thrown away.
        let mut req = base_req();
        req.history = vec![json!({"role": "user", "content": "x".repeat(1000)})];
        req.chat_id = "chat-1".into();
        req.search_plugins = vec![json!({"kind": "duckduckgo"})];
        req.context_window = 200_000;
        req.mcp_servers = json!({"srv": {"command": "x"}});

        let snap = req.subagent_snapshot();

        assert!(snap.history.is_empty(), "snapshot must not carry history");
        // The parent's own history is untouched (the turn keeps using it).
        assert_eq!(req.history.len(), 1);
        // Settings the sub-agent genuinely reads still flow through.
        assert_eq!(snap.model, req.model);
        assert_eq!(snap.root, req.root);
        assert_eq!(snap.chat_id, "chat-1");
        assert_eq!(snap.context_window, 200_000);
        assert_eq!(snap.search_plugins, req.search_plugins);
        assert_eq!(snap.mcp_servers, req.mcp_servers);
        assert_eq!(snap.api_keys, req.api_keys);
    }

    // ---- Plan persistence -------------------------------------------------
    // The save used to depend on a heading that STARTS with "plan", so a model
    // writing `## Implementation Plan`, `## Phase 1` or no heading at all left
    // NO plan file — silently, because the caller dropped the Result. That is
    // the "sometimes it saves, sometimes it doesn't" report.

    #[test]
    fn extract_plan_body_accepts_any_heading() {
        // The canonical opener still works and its heading becomes the title.
        let (t, b) = extract_plan_body("## Plan\ndo the thing").unwrap();
        assert_eq!(t, "Plan");
        assert!(b.contains("do the thing"));

        // A differently-worded heading is still a plan.
        for heading in ["## Implementation Plan", "## Phase 1: wire it up", "## طرح"] {
            let text = format!("{heading}\nstep one\nstep two");
            let (t, b) = extract_plan_body(&text)
                .unwrap_or_else(|| panic!("{heading} produced no plan"));
            assert_eq!(t, heading.trim_start_matches('#').trim());
            assert!(b.contains("step one"), "{b}");
        }
    }

    #[test]
    fn extract_plan_body_accepts_a_plan_without_a_heading() {
        // No heading at all: the reply IS the plan. Previously this returned
        // None and nothing was written to disk.
        let (t, b) = extract_plan_body("1. read the file\n2. edit it").unwrap();
        assert_eq!(t, "1. read the file");
        assert!(b.contains("2. edit it"), "{b}");

        // An empty reply is still refused — there is nothing to save.
        assert!(extract_plan_body("").is_none());
        assert!(extract_plan_body("   \n\n  ").is_none());
    }

    #[test]
    fn plan_roundtrip_is_readable_after_a_save() {
        // A plan saved with the reader's exact keys must come back, including
        // the empty-chat-id case the reader used to refuse outright while the
        // writer happily created `plan/<ws>/default/plan.md`.
        let dir = std::env::temp_dir().join(format!("codifa-plan-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-x");

        for chat_id in ["chat-1", ""] {
            crate::plans::save_plan(root, &ws, "My Plan", "## Plan\nbody here", chat_id).unwrap();
            let got = crate::plans::get_plan(root, &ws, chat_id)
                .unwrap_or_else(|| panic!("plan not readable for chat_id={chat_id:?}"));
            assert_eq!(got["title"], "My Plan");
            assert!(got["content"].as_str().unwrap_or("").contains("body here"));
        }

        // The durable write must not leave temp files behind.
        let plan_folder = std::path::Path::new(root).join("plan").join(&ws);
        let chat_dir = plan_folder.join(if true { "chat-1" } else { "default" });
        let leftovers: Vec<String> = std::fs::read_dir(&chat_dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.contains(".tmp"))
                    .collect()
            })
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_plan_writes_do_not_collide() {
        // The temp name was pid-only, so two writers in one process picked the
        // SAME temp path: the second rename failed and that save vanished.
        let dir = std::env::temp_dir().join(format!("codifa-plan-cc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-y");

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let root = root.to_string();
                let ws = ws.clone();
                std::thread::spawn(move || {
                    crate::plans::save_plan(
                        &root,
                        &ws,
                        &format!("Plan {i}"),
                        &format!("body {i}"),
                        "chat-1",
                    )
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("a concurrent save failed");
        }
        let got = crate::plans::get_plan(root, &ws, "chat-1").expect("plan missing after races");
        assert!(!got["content"].as_str().unwrap_or("").is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A live OpenAI-compatible upstream on 127.0.0.1: the FIRST /chat/completions
    /// request gets a tool_call to `explore`; every later one answers plain text.
    /// Bodies are forwarded over the channel for assertions.
    async fn spawn_explore_mock_upstream(
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        // Shared call counter: each connection runs in its own spawned task,
        // and usize is Copy — a plain counter copied per task made EVERY
        // request look like the first one, so the mock answered tool_calls
        // forever and the turn spun to MAX_STEPS.
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let calls = std::sync::Arc::clone(&calls);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let call_idx = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // run_turn always streams, so the mock answers SSE. The FIRST
                    // request gets ONE complete tool_call frame (arguments merged
                    // in a single frame — the parser concatenates argument chunks
                    // verbatim, so splitting a JSON object across frames would
                    // produce invalid JSON).
                    let resp: String = if call_idx == 0 {
                        let frame = |payload: String| format!("data: {payload}\n\n");
                        let mut sse = String::new();
                        sse.push_str(&frame(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"explore","arguments":"{\"description\":\"look\",\"prompt\":\"what files exist\"}"}}]}}]}).to_string()));
                        sse.push_str(&frame(
                            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":5,"output_tokens":3}}).to_string(),
                        ));
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    } else {
                        let mut sse = String::new();
                        sse.push_str(&format!(
                            "data: {}\n\n",
                            json!({"choices":[{"delta":{"content":"done"}}]}).to_string()
                        ));
                        sse.push_str(&format!(
                            "data: {}\n\n",
                            json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":11,"output_tokens":2}}).to_string()
                        ));
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn explore_live_runs_the_slot_model_and_attributes_usage() {
        // The explore Tool-Models slot routes cross-provider: the SUB request
        // must go out with the slot model, and its usage event must be
        // reported under the SLOT provider id (not the parent's).
        let (mock_base, rx) = spawn_explore_mock_upstream().await;
        let bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        // Drain the channel in the background so the mock never blocks.
        let bodies_c = bodies.clone();
        tokio::spawn(async move {
            let mut rx = rx;
            while let Some(b) = rx.recv().await {
                bodies_c.lock().unwrap().push(b);
            }
        });
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-explore",
            "mode": "build",
            "prompt": "go explore",
            "history": [],
            "subagent_models": { "explore": format!("slot-prov/{MOCK_MODEL}") },
            "subagent_thinking": { "explore": "max" },
            "thinking_level": "high",
            "model_reasoning": true,
            "providers": {
                "slot-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-slot"] }
            },
            "data_root": "/tmp/codifa-live-explore-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev_clone = events.clone();
        let mut emit = move |e: &AgentEvent| {
            ev_clone.lock().unwrap().push(e.to_json());
        };
        let _ = run_turn(&req, &mut emit, &cancel).await;
        let evs = events.lock().unwrap().clone();
        let sent = bodies.lock().unwrap().clone();
        let sent_models: Vec<String> = sent
            .iter()
            .map(|b| b["model"].as_str().unwrap_or("").to_string())
            .collect();
        let evs_dbg = format!("{evs:?}");
        let _ = evs_dbg; // keep for debugging below
        let usage_events: Vec<Value> = evs
            .iter()
            .filter(|e| e["kind"] == "usage")
            .cloned()
            .collect();
        let sub_usage = usage_events
            .iter()
            .find(|e| e["sub"] == true && e["model"] == MOCK_MODEL)
            .unwrap_or_else(|| {
                panic!(
                    "a sub(=explore) usage event for the slot model must fire; got {usage_events:?}; sent_models={sent_models:?}"
                )
            });
        assert_eq!(sub_usage["provider_id"], "slot-prov");
        // And the SUB request really went out with the slot model.
        let sent = bodies.lock().unwrap().clone();
        assert!(
            sent.iter().any(|b| b["model"] == MOCK_MODEL),
            "the explore sub-request must use the slot model; sent models: {:?}",
            sent.iter().map(|b| b["model"].clone()).collect::<Vec<_>>()
        );
    }

    /// Mock upstream for the explore → fetch_url → distiller chain. Streamed
    /// calls (SSE) are counted: 0 = the parent issues `explore`, 1 = the
    /// sub-agent issues `fetch_url`, anything later answers "done". A GET (no
    /// JSON body) is the page fetch and gets a long HTML page; a non-streaming
    /// POST is the distiller's completion.
    async fn spawn_explore_web_distill_mock_upstream(
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        // Prose big enough that the fetched page clears FETCH_DISTILL_MIN_CHARS,
        // so the distiller really fires.
        let page_body: String = (0..400)
            .map(|i| {
                format!(
                    "<p>Paragraph {i} of the mock page body, long enough to exceed the \
                     six-thousand-character distillation threshold.</p>"
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let page = format!("<html><head><title>Mock Page</title></head><body>{page_body}</body></html>");
        let fetch_url: String = format!("http://{addr}/page");
        // ONE counter across ALL connections: a per-connection counter made
        // every streamed call look like the first, so the parent and the
        // sub-agent were both answered with the `explore` tool_call forever.
        let stream_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let page = page.clone();
                let fetch_url = fetch_url.clone();
                let stream_calls = std::sync::Arc::clone(&stream_calls);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body.clone());
                    let frame = |payload: String| format!("data: {payload}\n\n");
                    let resp: String = if body.is_null() {
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            page.len(),
                            page
                        )
                    } else if body["stream"] == json!(true) {
                        let idx = stream_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let mut sse = String::new();
                        if idx == 0 {
                            sse.push_str(&frame(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"explore","arguments":"{\"description\":\"look\",\"prompt\":\"what does the page say\"}"}}]}}]}).to_string()));
                            sse.push_str(&frame(json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":5,"output_tokens":3}}).to_string()));
                        } else if idx == 1 {
                            let args = json!({ "url": fetch_url }).to_string();
                            sse.push_str(&frame(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"fetch_url","arguments":args}}]}}]}).to_string()));
                            sse.push_str(&frame(json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":7,"output_tokens":4}}).to_string()));
                        } else {
                            sse.push_str(&frame(json!({"choices":[{"delta":{"content":"done"}}]}).to_string()));
                            sse.push_str(&frame(json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":11,"output_tokens":2}}).to_string()));
                        }
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    } else {
                        let payload =
                            json!({"choices":[{"message":{"content":"distilled page summary"}}]})
                                .to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            payload.len(),
                            payload
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// The distiller INSIDE an exploration must run at the Other slot's own
    /// level: the sub request inherits the parent's `subagent_thinking`, so a
    /// `fetch_url` the explore performs may not silently drop the web slot's
    /// reasoning effort to "none".
    #[tokio::test]
    async fn explore_distiller_runs_at_the_web_slot_level() {
        let (mock_base, rx) = spawn_explore_web_distill_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-explore",
            "mode": "build",
            "prompt": "go explore",
            "history": [],
            "subagent_models": {
                "explore": format!("slot-prov/{MOCK_MODEL}"),
                "web": format!("slot-prov/{MOCK_MODEL}"),
            },
            "subagent_thinking": { "explore": "high", "web": "max" },
            "thinking_level": "high",
            "model_reasoning": true,
            "providers": {
                "slot-prov": {
                    "kind": "custom",
                    "baseUrl": format!("{mock_base}/v1"),
                    "apiKeys": ["sk-slot"],
                    // The capability flags a custom provider needs before any
                    // reasoning parameter is sent (see the distiller test).
                    "manualReasoningMap": { MOCK_MODEL: true },
                    "thinkingLevelsMap": { MOCK_MODEL: ["none", "low", "medium", "high", "xhigh"] },
                }
            },
            "data_root": "/tmp/codifa-live-explore-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        // The distiller's completion is the only non-streaming call the chain
        // makes; everything else streams.
        let sent = bodies.lock().unwrap().clone();
        let distill_calls: Vec<&Value> =
            sent.iter().filter(|b| b["stream"] == json!(false)).collect();
        assert_eq!(
            distill_calls.len(),
            1,
            "exactly one distiller call expected; bodies: {sent:?}"
        );
        let d = distill_calls[0];
        assert_eq!(
            d["model"], MOCK_MODEL,
            "the distiller must use the web slot model: {d}"
        );
        assert_eq!(
            d["reasoning_effort"], "xhigh",
            "the web slot's level from the PARENT map must reach the distiller inside the explore: {d}"
        );
        let user_text = d["messages"]
            .as_array()
            .and_then(|m| m.last())
            .and_then(|m| m["content"].as_str())
            .unwrap_or_default()
            .to_string();
        assert!(
            user_text.contains("PAGE:") && user_text.contains("Mock Page"),
            "the fetched page must be the distiller's input: {user_text}"
        );
    }

    #[test]
    fn undelivered_steers_are_reported_as_dropped_not_erased() {
        // A turn that ends WITHOUT a model call to carry the steer (provider
        // error, step budget, Stop inside a tool batch) must hand the queued
        // steer back to the renderer. `SteerGuard::drop` used to clear the
        // inbox silently, which is exactly why steering "sometimes worked and
        // sometimes didn't": the outcome depended only on which exit the turn
        // happened to take.
        let chat = "steer-drop-test-chat";
        steer_inbox()
            .lock()
            .unwrap()
            .entry(chat.to_string())
            .or_default()
            .push(SteerMessage { id: "m1".into(), prompt: "keep working".into() });
        let mut seen: Vec<Value> = Vec::new();
        let mut emit = |e: &AgentEvent| seen.push(e.to_json());
        let n = drop_steers(chat, &mut emit);
        assert_eq!(n, 1, "the queued steer must be counted as handed back");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["kind"], "steer_dropped");
        assert_eq!(seen[0]["ids"][0], "m1");
        // The inbox is empty afterwards, so `SteerGuard::drop` finds nothing to
        // erase and the renderer is the single owner of what happens next.
        assert!(
            steer_inbox().lock().unwrap().get(chat).is_none(),
            "the reported steer must not stay queued (it would be delivered twice)"
        );
        // A second call is a no-op: nothing is reported twice.
        let mut again: Vec<Value> = Vec::new();
        let mut emit2 = |e: &AgentEvent| again.push(e.to_json());
        assert_eq!(drop_steers(chat, &mut emit2), 0);
        assert!(again.is_empty());
    }

    #[test]
    fn drop_steers_ignores_a_subagent_and_blank_text() {
        // The explore sub-agent reuses the parent's turn scope with an EMPTY
        // chat id (`SteerGuard::inert`), so it must never touch a real inbox.
        let mut seen: Vec<Value> = Vec::new();
        {
            let mut emit = |e: &AgentEvent| seen.push(e.to_json());
            assert_eq!(drop_steers("", &mut emit), 0);
        }
        assert!(seen.is_empty());
        // A steer whose text is blank was never deliverable: reporting it would
        // make the renderer re-send an empty message.
        let chat = "steer-drop-blank-chat";
        steer_inbox()
            .lock()
            .unwrap()
            .entry(chat.to_string())
            .or_default()
            .push(SteerMessage { id: "blank".into(), prompt: "   ".into() });
        {
            let mut emit = |e: &AgentEvent| seen.push(e.to_json());
            assert_eq!(drop_steers(chat, &mut emit), 0);
        }
        assert!(seen.is_empty());
        // It is still cleared, so it can never leak into a later turn.
        assert!(steer_inbox().lock().unwrap().get(chat).is_none());
    }

    #[tokio::test]
    async fn history_images_are_re_read_and_reach_the_model() {
        // The renderer sends a past message's images as PATHS (inline copies are
        // stripped from history to keep every turn's payload small). Before this
        // was wired, a follow-up like "now fix it" referred to an image the
        // model had never received.
        let dir = std::env::temp_dir().join(format!(
            "codifa-history-img-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // One real 1x1 PNG on disk, read back through the image helper.
        let png: [u8; 67] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let img_path = dir.join("shot.png");
        std::fs::write(&img_path, png).unwrap();

        let (mock_base, rx) = spawn_explore_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": dir.to_string_lossy(),
            "mode": "build",
            "prompt": "now fix it",
            // The PAST turn carried an image; this turn only carries the text.
            "history": [
                { "role": "user", "content": "why is this broken?", "images": [img_path.to_string_lossy()] },
                { "role": "assistant", "content": "I see the error." }
            ],
            "data_root": dir.to_string_lossy()
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        let sent = bodies.lock().unwrap().clone();
        let first = sent.first().cloned().expect("the turn must send a request");
        let hist_msg = first["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["content"].is_array())
            .cloned()
            .unwrap_or_else(|| panic!("the historical image must be sent as blocks: {first}"));
        let blocks = hist_msg["content"].as_array().unwrap();
        assert!(
            blocks
                .iter()
                .any(|b| b["type"] == "image_url"
                    && b["image_url"]["url"]
                        .as_str()
                        .is_some_and(|u| u.starts_with("data:image/png;base64,"))),
            "the past screenshot must be re-read from disk and sent: {first}"
        );
        assert!(
            blocks
                .iter()
                .any(|b| b["type"] == "text"
                    && b["text"].as_str().is_some_and(|t| t.contains("why is this broken?"))),
            "the historical text must survive next to the image: {first}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A valid-looking inline image: the mime prefix is what the per-provider
    /// translation switches on, the payload is opaque to the mock.
    const PNG_URL: &str = "data:image/png;base64,AAAA";
    const JPG_URL: &str = "data:image/jpeg;base64,BBBB";

    /// A NON-streaming OpenAI-compatible upstream: records every request body
    /// and answers a fixed JSON completion. The vision pass is a one-shot
    /// `complete_with_images` call, which parses this shape (not SSE).
    async fn spawn_json_mock_upstream(
        content: &str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let payload = json!({ "choices": [{ "message": { "content": content } }] }).to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let payload = payload.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        payload.len(),
                        payload
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// Drain a mock's body channel into a shared vector in the background, so
    /// the mock never blocks on a full channel while the turn runs.
    fn drain_bodies(
        mut rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) -> std::sync::Arc<std::sync::Mutex<Vec<Value>>> {
        let bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = bodies.clone();
        tokio::spawn(async move {
            while let Some(b) = rx.recv().await {
                sink.lock().unwrap().push(b);
            }
        });
        bodies
    }

    /// A mock upstream that answers every call with an HTTP error status — the
    /// provider-side failure the stream path must surface, never swallow.
    async fn spawn_failing_mock_upstream(status: u16, reason: &str) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = json!({"error": {"message": reason}}).to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let body = body.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut tmp = [0u8; 4096];
                    // Read the request head (best effort) so the client sees a
                    // clean response, then answer with the failure.
                    let _ = sock.read(&mut tmp).await;
                    let resp = format!(
                        "HTTP/1.1 {status} Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    // ------------------------------------------------------------------
    // Scenario suite: deterministic per-scenario call/round accounting.
    // The scripted mock answers each call index from a script (the last
    // entry repeats), so a scenario's LLM-call count and round shape are
    // FACTS, not estimates — the baseline the round-elimination work reports
    // against. Usage events count llm calls; request bodies show the wire.
    // ------------------------------------------------------------------

    fn sse_body(payloads: &[Value]) -> String {
        let mut sse = String::new();
        for p in payloads {
            sse.push_str(&format!("data: {p}\n\n"));
        }
        sse.push_str("data: [DONE]\n\n");
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}",
            sse.len()
        )
    }

    fn tool_call_frame(id: &str, name: &str, arguments: &str) -> Value {
        tool_call_frame_at(0, id, name, arguments)
    }

    /// `index` is the provider's WITHIN-REPLY slot: two calls in one reply
    /// carry different indices, or the accumulator merges them into one.
    fn tool_call_frame_at(index: u32, id: &str, name: &str, arguments: &str) -> Value {
        json!({"choices":[{"delta":{"tool_calls":[{"index":index,"id":id,"function":{"name":name,"arguments":arguments}}]}}]})
    }

    fn finish_frame(reason: &str, input: u64, output: u64) -> Value {
        json!({"choices":[{"delta":{},"finish_reason":reason}],"usage":{"input_tokens":input,"output_tokens":output}})
    }

    fn text_frame(s: &str) -> Value {
        json!({"choices":[{"delta":{"content":s}}]})
    }

    /// Mock upstream scripted per call index; the LAST script entry repeats
    /// forever, so an accidental extra call cannot wedge the test.
    async fn spawn_scripted_mock_upstream(
        script: Vec<Vec<Value>>,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        assert!(!script.is_empty(), "the script needs at least one entry");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let script = std::sync::Arc::new(script);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let calls = std::sync::Arc::clone(&calls);
                let script = std::sync::Arc::clone(&script);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let call_idx = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let payloads = &script[call_idx.min(script.len() - 1)];
                    let _ = sock.write_all(sse_body(payloads).as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    fn scenario_events() -> std::sync::Arc<std::sync::Mutex<Vec<Value>>> {
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()))
    }

    fn count_kind(events: &[Value], kind: &str) -> usize {
        events.iter().filter(|e| e["kind"] == kind).count()
    }

    async fn scenario_turn(
        base: &str,
        chat: &str,
        root: &str,
        events: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    ) -> Result<(), String> {
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/scenario-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": root,
            "mode": "build",
            "prompt": "run the scenario",
            "history": [],
            "chat_id": chat,
            "data_root": root,
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ev_c = events.clone();
        let mut emit = move |e: &AgentEvent| ev_c.lock().unwrap().push(e.to_json());
        run_turn(&req, &mut emit, &cancel).await
    }

    #[tokio::test]
    async fn a_simple_two_round_turn_costs_two_llm_calls() {
        // Scenario 1 — the floor: one tool round + one answer round. No call
        // in this shape is removable without losing the tool's result.
        let dir = std::env::temp_dir().join(format!("codifa-scen-simple-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello scenario").unwrap();
        let (base, _rx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame("c1", "read", r#"{"filePath":"a.txt"}"#),
                finish_frame("tool_calls", 100, 5),
            ],
            vec![text_frame("the file says hello"), finish_frame("stop", 120, 8)],
        ])
        .await;
        let events = scenario_events();
        let res = scenario_turn(&base, "scen-simple", dir.to_str().unwrap(), events.clone()).await;
        assert!(res.is_ok(), "{res:?}");
        let ev = events.lock().unwrap();
        assert_eq!(count_kind(&ev, "usage"), 2, "two rounds = two calls");
        assert_eq!(count_kind(&ev, "tool"), 1);
        assert_eq!(count_kind(&ev, "done"), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_multi_tool_round_runs_both_calls_in_one_round() {
        // Scenario 2 — batching: ONE reply carries two independent lookups and
        // the loop runs BOTH before the next model call. Two tools, still two
        // llm calls total — the round shape the batch parameters target.
        let dir = std::env::temp_dir().join(format!("codifa-scen-multi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello todo list").unwrap();
        let (base, _rx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame("c1", "read", r#"{"filePath":"a.txt"}"#),
                tool_call_frame_at(
                    1,
                    "c2",
                    "grep",
                    r#"{"pattern":"todo","path":".","include":"*.txt"}"#,
                ),
                finish_frame("tool_calls", 100, 6),
            ],
            vec![text_frame("both lookups done"), finish_frame("stop", 140, 8)],
        ])
        .await;
        let events = scenario_events();
        let res = scenario_turn(&base, "scen-multi", dir.to_str().unwrap(), events.clone()).await;
        assert!(res.is_ok(), "{res:?}");
        let ev = events.lock().unwrap();
        assert_eq!(count_kind(&ev, "usage"), 2, "one batched round, one answer");
        let tools: Vec<String> = ev
            .iter()
            .filter(|e| e["kind"] == "tool_result")
            .filter_map(|e| e["name"].as_str().map(str::to_string))
            .collect();
        assert!(tools.contains(&"read".to_string()) && tools.contains(&"grep".to_string()), "{tools:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_failing_tool_surfaces_an_error_and_the_turn_completes() {
        // Scenario 3 — completion contract: a refused tool is NOT silent (the
        // model sees the refusal and answers around it); the turn still ends
        // with a real answer instead of stalling or dying.
        let dir = std::env::temp_dir().join(format!("codifa-scen-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (base, _rx) = spawn_scripted_mock_upstream(vec![
            vec![
                // A hallucinated tool name: the loop's unknown-tool gate refuses
                // it before anything runs.
                tool_call_frame("c1", "teleport_file", r#"{}"#),
                finish_frame("tool_calls", 100, 5),
            ],
            vec![text_frame("worked around the refusal"), finish_frame("stop", 130, 8)],
        ])
        .await;
        let events = scenario_events();
        let res = scenario_turn(&base, "scen-fail", dir.to_str().unwrap(), events.clone()).await;
        assert!(res.is_ok(), "{res:?}");
        let ev = events.lock().unwrap();
        assert_eq!(count_kind(&ev, "usage"), 2, "refusal round + answer round");
        let failed = ev.iter().any(|e| e["kind"] == "tool_result" && e["ok"] == false);
        assert!(failed, "the refusal must be visible as a failed tool row");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn invalid_tool_arguments_surface_an_error_without_crashing() {
        // Scenario 4 — weak model output: arguments that are not JSON must
        // come back to the model as a failed tool row, never as a panic or a
        // silent skip.
        let dir =
            std::env::temp_dir().join(format!("codifa-scen-badargs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (base, _rx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame("c1", "read", "{invalid json here"),
                finish_frame("tool_calls", 100, 5),
            ],
            vec![text_frame("recovered"), finish_frame("stop", 130, 8)],
        ])
        .await;
        let events = scenario_events();
        let res = scenario_turn(&base, "scen-badargs", dir.to_str().unwrap(), events.clone()).await;
        assert!(
            res.is_ok(),
            "a malformed-arguments round must not fail the turn: {res:?}"
        );
        let ev = events.lock().unwrap();
        let failed = ev.iter().any(|e| e["kind"] == "tool_result" && e["ok"] == false);
        assert!(failed, "the parse failure must surface as a failed tool row");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_one_call_model_gets_at_most_two_batching_hints_per_turn() {
        // Scenario 5 — the hint cap: a model that answers with exactly one
        // tool call per reply (traced 6 Nov: 103 deliveries, zero batching)
        // gets the lesson TWICE per turn, then silence. Every delivery rode
        // the tool result and was re-sent on every later round — the cap is
        // where the pure cost stops. The precise count is asserted on the
        // hint counter the loop embeds in the trace's llm rows (the event
        // wire does not carry hint counters), so the turn runs with
        // CODER_DATA_DIR pointed at a temp store.
        let prev = std::env::var("CODER_DATA_DIR").ok();
        let _lock = crate::memory::tests::DATA_DIR_LOCK.lock();
        let data = std::env::temp_dir().join(format!("codifa-scen-hints-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("CODER_DATA_DIR", &data);
        let dir = std::env::temp_dir().join(format!("codifa-scen-hints-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let round = || {
            vec![
                tool_call_frame("c", "read", r#"{"filePath":"a.txt"}"#),
                finish_frame("tool_calls", 100, 5),
            ]
        };
        let mut script = vec![round(), round(), round(), round(), round(), round()];
        script.push(vec![text_frame("done reading"), finish_frame("stop", 200, 8)]);
        let (base, _rx) = spawn_scripted_mock_upstream(script).await;
        let events = scenario_events();
        let chat = format!("scen-hints-{}", std::process::id());
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/scenario-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": dir.to_str().unwrap(),
            "mode": "build",
            "prompt": "run the scenario",
            "history": [],
            "chat_id": chat,
            "data_root": dir.to_str().unwrap(),
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ev_c = events.clone();
        let mut emit = move |e: &AgentEvent| ev_c.lock().unwrap().push(e.to_json());
        let res = run_turn(&req, &mut emit, &cancel).await;
        assert!(res.is_ok(), "{res:?}");
        // 6 tool rounds + 1 answer = 7 calls; nothing was skipped for the cap.
        assert_eq!(count_kind(&events.lock().unwrap(), "usage"), 7);
        let path = data.join("traces").join(format!("{chat}.jsonl"));
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let llm_hints: Vec<u64> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|r| r["kind"] == "llm")
            .filter_map(|r| r["detail"]["lone_call_hints"].as_u64())
            .collect();
        let total = llm_hints.last().copied().unwrap_or(0);
        assert!(
            total <= 2,
            "the cap allows 2 deliveries per turn; last counter = {total} (rows: {llm_hints:?})"
        );
        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", &v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn subagent_retries_are_visible_in_the_trace() {
        // Scenario 6 — instrumentation: a failing slot makes the ladder burn
        // attempts that NEVER produce an llm row; the kind:"retry" rows are
        // what makes them countable (the mission's baseline asks for retries,
        // not just successes).
        let prev = std::env::var("CODER_DATA_DIR").ok();
        let _lock = crate::memory::tests::DATA_DIR_LOCK.lock();
        let data = std::env::temp_dir().join(format!("codifa-scen-retry-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("CODER_DATA_DIR", &data);
        let dir =
            std::env::temp_dir().join(format!("codifa-scen-retry-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Main call succeeds and delegates; the explore SLOT always 500s.
        let base = spawn_failing_mock_upstream(500, "slot exploded").await;
        let (main_base, _mrx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame(
                    "c1",
                    "explore",
                    r#"{"description":"look","prompt":"what files exist"}"#,
                ),
                finish_frame("tool_calls", 100, 5),
            ],
            vec![text_frame("gave up on the research"), finish_frame("stop", 140, 8)],
        ])
        .await;
        let chat = format!("scen-retry-{}", std::process::id());
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/scenario-model",
            "base_url": format!("{main_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": dir.to_str().unwrap(),
            "mode": "build",
            "prompt": "research the area",
            "history": [],
            "chat_id": chat,
            "data_root": dir.to_str().unwrap(),
            "headless": true,
            "subagent_models": {"explore": "slot-prov/slot-mock/x"},
            "providers": {"slot-prov": {"kind": "custom", "baseUrl": format!("{base}/v1"), "apiKeys": ["sk"]}},
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let events = scenario_events();
        let ev_c = events.clone();
        let mut emit = move |e: &AgentEvent| ev_c.lock().unwrap().push(e.to_json());
        let _ = run_turn(&req, &mut emit, &cancel).await;
        let ev = events.lock().unwrap();
        let retries = count_kind(&ev, "retry");
        assert!(retries >= 2, "the ladder must retry a dead slot: {retries}");
        assert!(
            ev.iter().any(|e| e["kind"] == "retry_giveup"),
            "an always-failing slot must end in a giveup"
        );
        // The trace file carries the retry rows (kind:"retry"), giveup flagged.
        let path = data.join("traces").join(format!("{chat}.jsonl"));
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let rows: Vec<Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let retry_rows: Vec<&Value> = rows.iter().filter(|r| r["kind"] == "retry").collect();
        assert!(
            retry_rows.len() >= 2,
            "retry rows must be in the trace: {} rows total",
            rows.len()
        );
        assert!(
            retry_rows.iter().any(|r| r["detail"]["giveup"] == true),
            "the giveup must be flagged"
        );
        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", &v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_explore_budget_nudge_fires_and_the_report_is_delivered() {
        // Scenario 7 — completion contract for the sub-agent: after the fixed
        // step budget the loop asks for the report INSTEAD of more calls, and
        // the run ends with the report as the explore result (never a silent
        // budget death).
        let dir = std::env::temp_dir().join(format!("codifa-scen-budget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..6 {
            std::fs::write(dir.join(format!("f{i}.txt")), format!("content {i}")).unwrap();
        }
        let round = |i: usize| {
            vec![
                tool_call_frame("c", "read", &format!(r#"{{"filePath":"f{i}.txt"}}"#)),
                finish_frame("tool_calls", 100, 5),
            ]
        };
        // Round 1 of the MAIN turn delegates; the SUB turn (same mock) burns
        // its step budget on reads; the report is the sub's final text.
        let mut script = vec![vec![
            tool_call_frame(
                "c1",
                "explore",
                r#"{"description":"look","prompt":"read the fixture files"}"#,
            ),
            finish_frame("tool_calls", 100, 5),
        ]];
        script.extend([round(0), round(1), round(2), round(3)]);
        script.push(vec![
            text_frame("REPORT: all six files read"),
            finish_frame("stop", 300, 20),
        ]);
        let (base, _rx) = spawn_scripted_mock_upstream(script).await;
        let chat = format!("scen-budget-{}", std::process::id());
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/scenario-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": dir.to_str().unwrap(),
            "mode": "build",
            "prompt": "read the files",
            "history": [],
            "chat_id": chat,
            "data_root": dir.to_str().unwrap(),
            "subagent_models": {"explore": "main/scenario-model"},
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let events = scenario_events();
        let ev_c = events.clone();
        let mut emit = move |e: &AgentEvent| ev_c.lock().unwrap().push(e.to_json());
        let res = run_turn(&req, &mut emit, &cancel).await;
        assert!(res.is_ok(), "{res:?}");
        let ev = events.lock().unwrap();
        // The report reaches the parent as the explore tool's result.
        let reported = ev.iter().any(|e| {
            e["kind"] == "tool_result"
                && e["name"] == "explore"
                && e["result"].as_str().is_some_and(|r| r.contains("REPORT:"))
        });
        assert!(
            reported,
            "the report must be delivered as the explore result"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[tokio::test]
    async fn a_batch_round_carries_a_whole_step_in_one_llm_call() {
        // THE round-elimination scenario: the model plans a whole step —
        // lookups + a write + the verify command — as ONE `batch` call. Four
        // tool calls, ONE llm round; the answer round makes two. Nothing is
        // skipped: every sub-result is the full output of its tool.
        let dir = std::env::temp_dir().join(format!("codifa-scen-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello batch").unwrap();
        let batch_args = json!({
            "ops": [
                {"tool": "read", "args": {"filePath": "a.txt"}},
                {"tool": "grep", "args": {"pattern": "batch", "path": ".", "include": "*.txt"}},
                {"tool": "write_file", "args": {"path": "out.txt", "content": "step output"}},
                {"tool": "run_terminal", "args": {"command": "echo verify-ok"}},
            ]
        });
        let (base, _rx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame("c1", "batch", &batch_args.to_string()),
                finish_frame("tool_calls", 150, 10),
            ],
            vec![text_frame("step complete"), finish_frame("stop", 200, 8)],
        ])
        .await;
        let events = scenario_events();
        let res = scenario_turn(&base, "scen-batch", dir.to_str().unwrap(), events.clone()).await;
        assert!(res.is_ok(), "{res:?}");
        let ev = events.lock().unwrap();
        // ONE tool round + ONE answer round = TWO llm calls for FOUR tool calls.
        assert_eq!(count_kind(&ev, "usage"), 2, "4 tool calls must cost 1 tool round");
        let result = ev
            .iter()
            .find(|e| e["kind"] == "tool_result" && e["name"] == "batch")
            .and_then(|e| e["result"].as_str())
            .unwrap_or_default()
            .to_string();
        for label in ["[1/4] read", "[2/4] grep", "[3/4] write_file", "[4/4] run_terminal"] {
            assert!(result.contains(label), "missing {label}: {result}");
        }
        assert!(result.contains("hello batch") && result.contains("verify-ok"), "{result}");
        // The write inside the batch really landed on disk.
        assert_eq!(
            std::fs::read_to_string(dir.join("out.txt")).unwrap(),
            "step output"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_read_only_turn_refuses_batch_writes_inline_and_keeps_the_rest() {
        // The caps gate is PER-OP: in Ask mode the lookups of a batch run and
        // its write op comes back as an inline refusal — the whole batch is
        // NOT burned, and nothing forbidden executes.
        let dir =
            std::env::temp_dir().join(format!("codifa-scen-batchcaps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "readable").unwrap();
        let batch_args = json!({
            "ops": [
                {"tool": "read", "args": {"filePath": "a.txt"}},
                {"tool": "write_file", "args": {"path": "nope.txt", "content": "must not land"}},
            ]
        });
        let (base, _rx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame("c1", "batch", &batch_args.to_string()),
                finish_frame("tool_calls", 120, 6),
            ],
            vec![text_frame("answered around it"), finish_frame("stop", 140, 8)],
        ])
        .await;
        let chat = format!("scen-batchcaps-{}", std::process::id());
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/scenario-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": dir.to_str().unwrap(),
            "mode": "ask",
            "prompt": "run the scenario",
            "history": [],
            "chat_id": chat,
            "data_root": dir.to_str().unwrap(),
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let events = scenario_events();
        let ev_c = events.clone();
        let mut emit = move |e: &AgentEvent| ev_c.lock().unwrap().push(e.to_json());
        let res = run_turn(&req, &mut emit, &cancel).await;
        assert!(res.is_ok(), "{res:?}");
        let ev = events.lock().unwrap();
        let result = ev
            .iter()
            .find(|e| e["kind"] == "tool_result" && e["name"] == "batch")
            .and_then(|e| e["result"].as_str())
            .unwrap_or_default()
            .to_string();
        assert!(result.contains("[1/2] read") && result.contains("readable"), "{result}");
        assert!(
            result.contains("[2/2] write_file → REFUSED") && result.contains("read-only"),
            "the write op is refused inline: {result}"
        );
        assert!(
            !dir.join("nope.txt").exists(),
            "a refused op must not touch the disk"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_plan_execute_protocol_rides_the_first_request() {
        // The model-INDEPENDENT round lever: the first request carries the
        // protocol head, and when the model obeys it (one batch, whole step),
        // 3 tool calls complete in ONE tool round + the answer.
        let dir = std::env::temp_dir().join(format!("codifa-scen-protocol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello protocol").unwrap();
        let batch_args = json!({"ops": [
            {"tool": "read", "args": {"filePath": "a.txt"}},
            {"tool": "grep", "args": {"pattern": "hello", "path": ".", "include": "*.txt"}},
            {"tool": "run_terminal", "args": {"command": "echo protocol-ok"}},
        ]});
        let (base, mut rx) = spawn_scripted_mock_upstream(vec![
            vec![
                tool_call_frame("c1", "batch", &batch_args.to_string()),
                finish_frame("tool_calls", 150, 10),
            ],
            vec![text_frame("step done"), finish_frame("stop", 200, 8)],
        ])
        .await;
        let events = scenario_events();
        let res = scenario_turn(&base, "scen-protocol", dir.to_str().unwrap(), events.clone()).await;
        assert!(res.is_ok(), "{res:?}");
        // The FIRST request on the wire carries the protocol head.
        let first = rx.recv().await.expect("first request body");
        let body = first.to_string();
        assert!(
            body.contains("PROTOCOL: your first tool reply is ONE batch"),
            "the protocol must ride the first request: {}",
            &body[..body.len().min(300)]
        );
        // ONE tool round for the 3 calls, then the answer round.
        let ev = events.lock().unwrap();
        assert_eq!(count_kind(&ev, "usage"), 2, "3 tool calls in 1 round + answer");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn headless_turn_surfaces_a_provider_error_as_err() {
        // THE SCHEDULE CONTRACT. A headless run_turn (the scheduler) must hand a
        // mid-turn provider error back as Err — the old interactive swallow-as-Ok
        // made the scheduler record a half-finished turn as a successful run
        // whose "final answer" was the first narration message.
        let base = spawn_failing_mock_upstream(500, "upstream exploded").await;
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/schedule-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-headless-error",
            "mode": "build",
            "prompt": "run the pipeline",
            "history": [],
            "chat_id": "schedule-sch-test",
            "headless": true,
            "data_root": "/tmp/codifa-headless-error-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let res = run_turn(&req, &mut |_e: &AgentEvent| {}, &cancel).await;
        let err = res.expect_err("a headless turn must return the provider error as Err");
        assert!(
            err.contains("upstream HTTP 500") && err.contains("upstream exploded"),
            "the error must name the status and the body: {err}"
        );
    }

    #[tokio::test]
    async fn interactive_turn_still_reports_a_provider_error_as_events() {
        // The interactive protocol is unchanged: Error event + terminal done,
        // then Ok(()) — the SSE client renders the banner, not a dropped stream.
        let base = spawn_failing_mock_upstream(500, "upstream exploded").await;
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/interactive-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-interactive-error",
            "mode": "build",
            "prompt": "run the pipeline",
            "history": [],
            "chat_id": "chat-interactive-test",
            "data_root": "/tmp/codifa-interactive-error-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let mut emit = move |e: &AgentEvent| ev.lock().unwrap().push(e.to_json());
        let res = run_turn(&req, &mut emit, &cancel).await;
        res.expect("the interactive protocol still ends Ok after an error event");
        let evs = events.lock().unwrap().clone();
        assert!(
            evs.iter().any(|e| {
                e["kind"] == "error"
                    && e["content"].as_str().is_some_and(|c| {
                        c.contains("upstream HTTP 500") && c.contains("upstream exploded")
                    })
            }),
            "an Error event with the real provider error must be emitted: {evs:?}"
        );
        assert!(
            evs.iter().any(|e| e["kind"] == "done"),
            "a terminal done must follow the error: {evs:?}"
        );
    }

    /// A mock upstream that answers BOTH shapes a turn needs: streaming SSE for
    /// the agent loop (the FIRST stream returns one UNKNOWN-tool call so the
    /// turn makes a second round-trip and `fold_prefix_len` becomes > 0; every
    /// later stream returns plain text "done") and a non-streaming JSON
    /// completion for the compaction summarizer. Every request body is forwarded
    /// so a test can also assert that the summarizer was really called.
    async fn spawn_compact_mock_upstream(
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        // Counts STREAM calls only (the summarizer call is non-streaming), so
        // the first stream is the tool-call round and every later one is text.
        let streams = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let streams = std::sync::Arc::clone(&streams);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body.clone());
                    let resp: String = if body["stream"].as_bool() == Some(true) {
                        let idx = streams.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let mut sse = String::new();
                        if idx == 0 {
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"noop_tool","arguments":"{}"}}]}}]}).to_string()
                            ));
                            // The reported prompt is the REAL prompt size: the
                            // trigger now anchors on this number instead of a
                            // local estimate, so a toy value (50) would never
                            // cross the test's 200-token threshold even though
                            // the real system prompt + tool schemas are far
                            // larger.
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":250,"completion_tokens":2}}).to_string()
                            ));
                        } else {
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{"content":"done"}}]}).to_string()
                            ));
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":300,"completion_tokens":1}}).to_string()
                            ));
                        }
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    } else {
                        let payload = json!({
                            "choices": [{ "message": { "content": "SUMMARY TEXT" } }]
                        })
                        .to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            payload.len(),
                            payload
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// A main-agent request pointed at the mock with an explicit window and
    /// threshold — the two inputs the mid-turn compaction trigger reads.
    fn compact_req(base: &str, ctx: u64, percent: u64) -> AgentRequest {
        let v = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/compact-test-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-compact",
            "mode": "build",
            "prompt": "do the thing",
            "history": [],
            "context_window": ctx,
            "compact_at_percent": percent,
            "data_root": "/tmp/codifa-live-compact-data"
        });
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn usage_tuple_maps_google_camel_case_keys() {
        // Gemini reports camelCase usageMetadata; without these keys a Google
        // turn sent (0, 0), so the meter AND the provider-reported compaction
        // trigger both fell back to the local estimate for that provider.
        let mut acc = StreamAcc::default();
        acc.usage = Some(json!({"promptTokenCount": 321, "candidatesTokenCount": 12}));
        assert_eq!(usage_tuple(&acc), (321, 12));
    }

    #[test]
    fn prompt_estimate_counts_system_and_tool_schemas() {
        // The history-only estimate misses the fixed per-request overhead
        // (system prompt + tool schemas) — that gap is exactly why a low
        // threshold could never be reached. The prompt estimate must be
        // strictly larger.
        let msgs = vec![
            json!({"role": "system", "content": "s".repeat(400)}),
            json!({"role": "user", "content": "u".repeat(400)}),
        ];
        let history_only = estimate_wire_tokens(&msgs[1..]);
        let full = estimate_prompt_tokens(&msgs, 4_000);
        assert!(
            full > history_only,
            "full={full} must exceed history-only={history_only}"
        );
    }

    #[test]
    fn inline_images_are_not_billed_as_text() {
        // A single attached screenshot is megabytes of base64. Charging it at
        // 4 chars/token reported millions of "tokens" and auto-compacted a chat
        // that was nowhere near the threshold.
        let base64 = "A".repeat(3_000_000);
        let with_image = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "what is in this screenshot?" },
                { "type": "image", "data_url": format!("data:image/png;base64,{base64}") },
            ],
        })];
        let as_text = {
            let wire: usize = serde_json::to_string(&with_image)
                .map(|s| s.chars().count())
                .unwrap();
            wire.div_ceil(4)
        };
        let measured = estimate_prompt_tokens(&with_image, 0);
        assert!(
            measured < as_text / 50,
            "the image must not be billed as text: measured={measured} vs text={as_text}"
        );
        // Concrete numbers, not just "much smaller": a 3 MB base64 screenshot is
        // ~2k real tokens (2001 by the IMAGE_CHARS_PER_TOKEN budget). The old
        // unit bug subtracted TOKENS from a CHARACTER count, so this same input
        // measured 562_518 — a single screenshot folded a whole chat.
        assert!(
            (1_500..4_000).contains(&measured),
            "a 3 MB image must cost ~2k tokens, got {measured}"
        );
        // The text part is still counted (no over-subtraction).
        assert!(measured >= 5, "the prose must survive: {measured}");
        // No images => unchanged behaviour.
        let plain = vec![json!({"role": "user", "content": "x".repeat(400)})];
        assert_eq!(estimate_prompt_tokens(&plain, 0), {
            let wire: usize = serde_json::to_string(&plain)
                .map(|s| s.chars().count())
                .unwrap();
            wire.div_ceil(4)
        });
    }

    #[test]
    fn measured_prompt_anchors_on_the_provider_not_the_inflated_estimate() {
        // The provider said the prompt was 1_000 tokens. The turn then appended
        // one small tool result. The measurement must be ~1_000 + that result —
        // NOT the local serde-JSON estimate of the whole history (which is what
        // made compaction fire below the user's threshold).
        let msgs = vec![
            json!({"role": "system", "content": "s".repeat(40_000)}),
            json!({"role": "user", "content": "u".repeat(40_000)}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "r".repeat(400)}),
        ];
        let full_estimate = estimate_prompt_tokens(&msgs, 0);
        assert!(full_estimate > 20_000, "sanity: {full_estimate}");
        let measured = measured_prompt_tokens(&msgs, 0, 2, 1_000);
        // 1_000 provider + ~100 for the 400-char tool result.
        assert!(
            (1_050..1_200).contains(&measured),
            "measured={measured} must anchor on the provider number"
        );
        // Before any usage arrives there is nothing to anchor to: the full
        // estimate stands alone.
        assert_eq!(measured_prompt_tokens(&msgs, 0, 0, 0), full_estimate);
        // A stale anchor (more entries than the vec has, e.g. after a fold)
        // falls back instead of panicking.
        assert_eq!(
            measured_prompt_tokens(&msgs, 0, 99, 1_000),
            full_estimate
        );
    }

    #[test]
    fn an_inclusive_prompt_basis_fires_the_compaction_trigger_on_time() {
        // The plan's fixture (plan §3): a raw Anthropic usage of input=2_000,
        // read=18_000, write=1_000. The prompt the provider actually billed is
        // 21_000 tokens — the basis `last_prompt_tokens` now carries for EVERY
        // provider (`llm::NormalizedUsage::input_total`), not just
        // provider=="anthropic", and never without the write half.
        let basis = crate::llm::NormalizedUsage::from_payload(&json!({
            "input_tokens": 2_000u64,
            "cache_read_input_tokens": 18_000u64,
            "cache_creation_input_tokens": 1_000u64,
        }))
        .unwrap()
        .input_total;
        assert_eq!(basis, 21_000);
        // The trigger's comparison: measured >= threshold. With a 128K window
        // at a 16% threshold the line sits at 20_480 — the inclusive basis
        // crosses it; the OLD basis (the exclusive input alone, what a
        // provider-name check or a custom gateway produced) stays far under
        // and the compaction fires rounds too late.
        let threshold = 128_000u64 * 16 / 100;
        assert!(basis >= threshold, "inclusive basis must cross the line");
        assert!(2_000 < threshold, "the exclusive input alone must not");
        // The wiring end to end: `measured_prompt_tokens` anchored on that
        // basis (+ the turn's appended delta) is what the trigger compares.
        let msgs = vec![
            json!({"role": "system", "content": "s"}),
            json!({"role": "user", "content": "u"}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "r".repeat(400)}),
        ];
        let measured = measured_prompt_tokens(&msgs, 0, 2, basis as usize);
        assert!(measured as u64 >= threshold, "trigger fires at this call: {measured}");
        // An OpenAI-style SUBSET payload must not double-count: prompt_tokens
        // 21_000 with 18_000 already inside it stays 21_000.
        let subset = crate::llm::NormalizedUsage::from_payload(&json!({
            "prompt_tokens": 21_000u64,
            "prompt_tokens_details": { "cached_tokens": 18_000u64 },
        }))
        .unwrap()
        .input_total;
        assert_eq!(subset, 21_000);
    }

    #[test]
    fn effective_context_window_prefers_the_models_real_window() {
        // Reported bug: a model whose real window is 1M was measured against the
        // hardcoded 128k fallback (the renderer had not resolved the window and
        // sent 0), so 80% compaction fired at ~10% of the real window.
        let mut req: AgentRequest = serde_json::from_value(json!({
            "provider": "custom",
            "provider_id": "p1",
            "model": "big-model",
            "base_url": "http://127.0.0.1:1/v1",
            "root": "/tmp/x",
            "prompt": "hi",
            "context_window": 0,
            "providers": {
                "p1": { "contextMap": { "big-model": 1_000_000 } }
            }
        }))
        .unwrap();
        assert_eq!(effective_context_window(&req), 1_000_000);

        // The renderer's own number always wins when it knows it.
        req.context_window = 200_000;
        assert_eq!(effective_context_window(&req), 200_000);
        req.context_window = 0;

        // Provider-prefixed key, as NVIDIA's /models returns it.
        req.providers.insert(
            "p1".into(),
            json!({"contextMap": {"p1/big-model": 400_000}}),
        );
        assert_eq!(effective_context_window(&req), 400_000);

        // A malformed/zero entry must not become the window (that would compact
        // on every single message).
        req.providers
            .insert("p1".into(), json!({"contextMap": {"big-model": 0}}));
        assert_eq!(effective_context_window(&req), DEFAULT_CONTEXT_WINDOW);

        // No providers map at all: the documented fallback.
        req.providers.clear();
        assert_eq!(effective_context_window(&req), DEFAULT_CONTEXT_WINDOW);
    }

    #[tokio::test]
    async fn mid_turn_compaction_fires_when_the_prompt_crosses_the_threshold() {
        // Reported bug: with a LOW threshold (20%) mid-turn compaction never
        // fired. The trigger measured only the history `content` (char/4), which
        // misses the system prompt + tool schemas and is additionally capped by
        // the in-turn elision — so it plateaued below the real prompt size. The
        // fix feeds the FULL prompt estimate (and the provider's own token
        // count) into the trigger. A deliberately tiny window makes the 20%
        // threshold trivially reachable, so the fold MUST happen.
        let (mock_base, rx) = spawn_compact_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let req = compact_req(&mock_base, 1_000, 20);
        assert_eq!(req.compact_at_percent, 20);

        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let mut emit = move |e: &AgentEvent| ev.lock().unwrap().push(e.to_json());
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let res = run_turn(&req, &mut emit, &cancel).await;
        assert!(res.is_ok(), "turn errored: {res:?}");

        let evs = events.lock().unwrap().clone();
        assert!(
            evs.iter().any(|e| e["kind"] == "compact_start"),
            "mid-turn compaction must start at 20%: {evs:?}"
        );
        let compact = evs
            .iter()
            .find(|e| e["kind"] == "compact")
            .unwrap_or_else(|| panic!("a compact event must fire at 20%: {evs:?}"));
        // The backend prefixes the fold with its "[Compacted earlier context]"
        // marker (compact.rs reads it back to merge prior summaries).
        let content = compact["content"].as_str().unwrap_or_default();
        assert!(
            content.contains("SUMMARY TEXT"),
            "the summary text must be stored: {content:?}"
        );
        // The summarizer request really went out: the mock's non-stream answer
        // is what becomes the summary.
        let sent = bodies.lock().unwrap().clone();
        assert!(
            sent.iter().any(|b| b["stream"].as_bool() == Some(false)),
            "the compaction summarizer must be called: {sent:?}"
        );
    }

    #[tokio::test]
    async fn mid_turn_compaction_stays_off_below_the_threshold() {
        // Control: a huge window at the SAME 20% must NOT fold — the trigger has
        // to track the threshold, not fire unconditionally.
        let (mock_base, rx) = spawn_compact_mock_upstream().await;
        let _bodies = drain_bodies(rx);
        let req = compact_req(&mock_base, 1_000_000, 20);
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let mut emit = move |e: &AgentEvent| ev.lock().unwrap().push(e.to_json());
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _ = run_turn(&req, &mut emit, &cancel).await;
        let evs = events.lock().unwrap().clone();
        assert!(
            !evs.iter().any(|e| e["kind"] == "compact"),
            "nothing may be folded far below the threshold: {evs:?}"
        );
    }

    #[tokio::test]
    async fn images_reach_the_main_model_as_content_blocks() {
        // With no Vision slot configured the image must ride WITH the user
        // message as neutral blocks, which llm.rs translates per provider.
        let (mock_base, rx) = spawn_explore_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-images",
            "mode": "build",
            "prompt": "what is wrong with this screenshot?",
            "history": [],
            // Both renderer shapes must be accepted: a bare data URL, the
            // picker's {path,dataUrl} object (which wins over its path), and a
            // path that cannot be read (dropped, never fatal).
            "images": [
                PNG_URL,
                { "path": "/definitely/missing.png", "dataUrl": JPG_URL },
                "/definitely/missing-too.png"
            ],
            "data_root": "/tmp/codifa-live-images-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        assert_eq!(req.images.len(), 2, "the unreadable path must be dropped");
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        let sent = bodies.lock().unwrap().clone();
        let first = sent.first().cloned().expect("the main turn must send a request");
        let content = first["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["content"].is_array())
            .map(|m| m["content"].clone())
            .unwrap_or_else(|| panic!("the user message must carry content blocks: {first}"));
        let blocks = content.as_array().unwrap();
        // Text + exactly the two readable images.
        assert_eq!(blocks.len(), 3, "one text block + two images: {content}");
        let urls: Vec<&str> = blocks
            .iter()
            .filter_map(|b| b["image_url"]["url"].as_str())
            .collect();
        assert!(urls.contains(&PNG_URL), "the bare data URL must be sent: {content}");
        assert!(
            urls.contains(&JPG_URL),
            "the {{path,dataUrl}} entry must be sent as its dataUrl: {content}"
        );
    }

    #[tokio::test]
    async fn main_model_receives_the_images_even_when_a_vision_slot_is_configured() {
        // MAIN MODEL FIRST. A configured Vision slot must NOT preempt the main
        // model: the images travel to the main model as blocks (llm.rs translates
        // them per provider), because most flagship models read images natively
        // and the user picked that model for a reason. The Vision slot is only a
        // FALLBACK — for a model the capability maps know is text-only, or one
        // that rejects the images mid-turn.
        let (vision_base, vision_rx) =
            spawn_json_mock_upstream("a red button on a white page, error text below").await;
        let vision_bodies = drain_bodies(vision_rx);
        let (main_base, main_rx) = spawn_explore_mock_upstream().await;
        let main_bodies = drain_bodies(main_rx);

        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{main_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-vision",
            "mode": "build",
            "prompt": "what is wrong with this screenshot?",
            "history": [],
            "images": [PNG_URL],
            "subagent_models": { "vision": "vision-prov/vision-model" },
            "providers": {
                "vision-prov": {
                    "kind": "custom",
                    "baseUrl": format!("{vision_base}/v1"),
                    "apiKeys": ["sk-vision"]
                }
            },
            "data_root": "/tmp/codifa-live-vision-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        // The main model got the raw image blocks — the slot model was NOT used.
        let mbody = main_bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the main turn must run"));
        let blocks = mbody["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["content"].is_array())
            .map(|m| m["content"].clone())
            .unwrap_or_else(|| panic!("the main model must receive image blocks: {mbody}"));
        assert!(
            blocks.as_array().unwrap().iter().any(|b| b["type"] == "image_url"
                && b["image_url"]["url"] == PNG_URL),
            "the image bytes must go to the main model: {mbody}"
        );
        assert!(
            vision_bodies.lock().unwrap().is_empty(),
            "the Vision slot must not preempt a main model whose capability is unknown"
        );
    }

    #[tokio::test]
    async fn vision_slot_takes_over_when_the_main_model_is_text_only() {
        // The capability map says the main model cannot read images, so the
        // Vision slot describes them once and the main model receives the
        // DESCRIPTION as text — a text-only main model would otherwise never
        // "see" the screenshot at all.
        let (vision_base, vision_rx) =
            spawn_json_mock_upstream("a red button on a white page, error text below").await;
        let vision_bodies = drain_bodies(vision_rx);
        let (main_base, main_rx) = spawn_explore_mock_upstream().await;
        let main_bodies = drain_bodies(main_rx);

        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{main_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-vision",
            "mode": "build",
            "prompt": "what is wrong with this screenshot?",
            "history": [],
            "images": [PNG_URL],
            "subagent_models": { "vision": "vision-prov/vision-model" },
            "providers": {
                "chat-provider": {
                    "kind": "custom",
                    "manualVisionMap": { "main/parent-model": false }
                },
                "vision-prov": {
                    "kind": "custom",
                    "baseUrl": format!("{vision_base}/v1"),
                    "apiKeys": ["sk-vision"]
                }
            },
            "data_root": "/tmp/codifa-live-vision-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        // 1) The vision model ran, with the slot's model id and the raw image.
        let vbody = vision_bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the vision model must be called"));
        assert_eq!(vbody["model"], "vision-model");
        assert_eq!(vbody["stream"], false, "the vision pass is one-shot: {vbody}");
        let vcontent = &vbody["messages"][1]["content"];
        assert!(
            vcontent.is_array(),
            "the vision call must send content blocks, got {vbody}"
        );
        assert!(
            vcontent.as_array().unwrap().iter().any(|b| b["type"] == "image_url"
                && b["image_url"]["url"] == PNG_URL),
            "the image bytes must be on the vision request: {vbody}"
        );

        // 2) The main model got the DESCRIPTION as text — not the image blocks,
        //    which a text-only main model could not accept.
        let mbody = main_bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the main turn must run"));
        let mtext = mbody["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            mtext.contains("IMAGE ANALYSIS") && mtext.contains("a red button"),
            "the vision description must be forwarded to the main model: {mbody}"
        );
        assert!(
            mbody["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| !m["content"].is_array()),
            "the main model must not receive raw image blocks: {mbody}"
        );
    }

    #[tokio::test]
    async fn a_repeated_screenshot_is_described_once_and_reused() {
        // A chat re-sends the screenshots still in its history on EVERY turn.
        // The second turn must answer from the description cache instead of
        // paying for the same model+image round-trip again — while the KEY
        // covers the model, the text and the image bytes, so a different image
        // or question can never be served a stale description.
        let (vision_base, vision_rx) =
            spawn_json_mock_upstream("a red button on a white page").await;
        let vision_bodies = drain_bodies(vision_rx);
        let (main_base, main_rx) = spawn_explore_mock_upstream().await;
        let main_bodies = drain_bodies(main_rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Unique prompt text keeps this test's cache key isolated from any other
        // test that happens to send an image through the Vision slot.
        let prompt = "what is wrong with this screenshot? (cache-key isolation probe)";
        let build = |base: &str| {
            let raw = json!({
                "provider": "custom",
                "provider_id": "chat-provider",
                "model": "main/parent-model",
                "base_url": format!("{base}/v1"),
                "api_key": "sk",
                "api_keys": ["sk"],
                "root": "/tmp/codifa-live-vision-cache",
                "mode": "build",
                "prompt": prompt,
                "history": [],
                "images": [PNG_URL],
                "subagent_models": { "vision": "vision-prov/vision-model" },
                "providers": {
                    "chat-provider": {
                        "kind": "custom",
                        "manualVisionMap": { "main/parent-model": false }
                    },
                    "vision-prov": {
                        "kind": "custom",
                        "baseUrl": format!("{vision_base}/v1"),
                        "apiKeys": ["sk-vision"]
                    }
                },
                "data_root": "/tmp/codifa-live-vision-cache-data"
            });
            let req: AgentRequest = serde_json::from_value(raw).unwrap();
            (req, format!("{base}/v1"))
        };
        let (req1, _) = build(&main_base);
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req1, &mut emit, &cancel).await;
        let calls_after_first = vision_bodies.lock().unwrap().len();
        assert_eq!(
            calls_after_first, 1,
            "the first turn must describe the image once"
        );

        // The SAME question about the SAME bytes: no second vision call.
        let (req2, _) = build(&main_base);
        let _ = run_turn(&req2, &mut emit, &cancel).await;
        assert_eq!(
            vision_bodies.lock().unwrap().len(),
            1,
            "a repeated image+question must come from the cache, not a new paid call"
        );
        // The vision description is one of the MAIN turn's requests. The mock
        // upstream here is also the explore sub-agent's endpoint, so filter to
        // the bodies that actually carry the description.
        let main_calls = main_bodies.lock().unwrap();
        let with_desc: Vec<&Value> = main_calls
            .iter()
            .filter(|b| {
                b["messages"].as_array().is_some_and(|ms| {
                    ms.iter().any(|m| match &m["content"] {
                        Value::String(s) => s.contains("a red button on a white page"),
                        Value::Array(blocks) => blocks
                            .iter()
                            .any(|x| x["text"].as_str().is_some_and(|t| {
                                t.contains("a red button on a white page")
                            })),
                        _ => false,
                    })
                })
            })
            .collect();
        assert!(
            with_desc.len() >= 2,
            "both turns must forward the description to the main model, got {} of {}",
            with_desc.len(),
            main_calls.len()
        );
    }

    #[test]
    fn the_vision_cache_key_depends_on_model_text_and_bytes() {
        let imgs = vec![PNG_URL.to_string(), JPG_URL.to_string()];
        let base = vision_cache_key("vision-model", "describe this", &imgs);
        assert_eq!(
            base,
            vision_cache_key("vision-model", "describe this", &imgs),
            "the same inputs must hit the same key"
        );
        assert_ne!(
            base,
            vision_cache_key("other-model", "describe this", &imgs),
            "a different model must not reuse a description"
        );
        assert_ne!(
            base,
            vision_cache_key("vision-model", "different question", &imgs),
            "a different question must not reuse a description"
        );
        assert_ne!(
            base,
            vision_cache_key("vision-model", "describe this", &[JPG_URL.to_string()]),
            "one fewer image must not reuse a description"
        );
        // Concatenation ambiguity: ["ab","c"] must not collide with ["a","bc"].
        let split_a = vec!["ab".to_string(), "c".to_string()];
        let split_b = vec!["a".to_string(), "bc".to_string()];
        assert_ne!(
            vision_cache_key("m", "t", &split_a),
            vision_cache_key("m", "t", &split_b),
            "the image count/lengths must be part of the key"
        );
    }

    /// Temp data root shared by the plan_section tests (same pattern as the
    /// plan round-trip test).
    fn plan_test_root(tag: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("codifa-ps-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        (dir, root)
    }

    #[test]
    fn plan_section_carries_the_plan_and_the_checklist() {
        let (dir, root) = plan_test_root("carry");
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-plan");
        crate::plans::save_plan(&root, &ws, "Plan", "## Plan\nstep one", "chat-1").unwrap();
        crate::plans::save_checklist(
            &root,
            &ws,
            "chat-1",
            &json!([
                {"content": "first", "status": "completed"},
                {"content": "second", "status": "in_progress"},
            ]),
        );

        let got = plan_section(&root, &ws, "chat-1");
        assert!(got.contains("=== SAVED PLAN"), "{got}");
        assert!(got.contains("step one"), "{got}");
        assert!(got.contains("=== CHECKLIST"), "{got}");
        // Status marks: x completed, ~ in progress.
        assert!(got.contains("- [x] first"), "{got}");
        assert!(got.contains("- [~] second"), "{got}");

        // No chat id → no section (nothing to key the files by).
        assert_eq!(plan_section(&root, &ws, ""), "");
        assert_eq!(plan_section(&root, &ws, "   "), "");
        // Unknown chat → empty, not a panic.
        assert_eq!(plan_section(&root, &ws, "chat-none"), "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_section_is_capped_but_keeps_the_head_and_the_tail() {
        // A plan is re-sent on every round-trip of every turn: an uncapped body
        // is a running cost. The cut must preserve the goal (head) and the most
        // recent items (tail).
        let (dir, root) = plan_test_root("cap");
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-plan-cap");
        let big = format!("HEAD-MARKER\n{}\nTAIL-MARKER", "x".repeat(40_000));
        crate::plans::save_plan(&root, &ws, "Big", &big, "chat-1").unwrap();

        let got = plan_section(&root, &ws, "chat-1");
        assert!(got.contains("HEAD-MARKER"), "the head must survive");
        assert!(got.contains("TAIL-MARKER"), "the tail must survive");
        assert!(got.contains("chars omitted from the middle"), "{got}");
        // The section stays near the cap instead of carrying all 40 KB.
        assert!(
            got.len() < PLAN_SECTION_CAP + 1_000,
            "section not capped: {} chars",
            got.len()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_section_survives_multibyte_text_at_the_cut() {
        // Persian plan bodies are common; a byte slice at the cut would panic
        // (and with panic=abort kill the app).
        let (dir, root) = plan_test_root("utf8");
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-plan-utf8");
        let body = format!("{}\nپایان", "فارسی‌ ".repeat(4_000));
        crate::plans::save_plan(&root, &ws, "Persian", &body, "chat-1").unwrap();
        let got = plan_section(&root, &ws, "chat-1");
        assert!(!got.is_empty());
        assert!(got.contains("chars omitted from the middle"), "not capped");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_section_is_wrapped_as_a_trailing_context_message() {
        // The section must never enter the system prompt: it is injected as a
        // trailing message instead. Measured: it used to make `messages[0]`
        // 7_734 -> 9_439 -> 7_734 -> 13_642 bytes across five turns and dropped
        // the main-agent prefix cache to 23.7%.
        assert!(plan_context_message("").is_none());
        assert!(plan_context_message("   \n ").is_none());

        let m = plan_context_message("\n\n=== SAVED PLAN (from disk) ===\nstep one\n")
            .expect("non-empty section must produce a message");
        assert_eq!(m["role"], "user");
        let text = m["content"].as_str().unwrap();
        assert!(text.contains("step one"), "{text}");
        // The label is load-bearing: without it the model can read a stale
        // checklist as the user's newest instruction.
        assert!(text.contains("NOT a new request"), "{text}");
        assert!(text.contains("end of context"), "{text}");
        // The recogniser used by the `Compact` emit must match what is built.
        assert!(text.starts_with(PLAN_CONTEXT_HEAD), "{text}");
    }

    #[test]
    fn skills_reminder_rides_the_tail_and_is_excluded_from_the_fold() {
        // The reminder exists to make the model CALL the tool, so it must name
        // the tool and the catalog it refers to — and it must stay out of the
        // renderer's fold count, exactly like the plan context message.
        let m = skills_context_message();
        assert_eq!(m["role"], "user");
        let text = m["content"].as_str().unwrap();
        assert!(text.starts_with(SKILLS_CONTEXT_HEAD), "{text}");
        assert!(text.contains("load_skill"), "{text}");
        assert!(text.contains("AVAILABLE SKILLS"), "{text}");
        // A capped catalog cannot list a large store, so the reminder must name
        // the way to reach what it left out — otherwise "no entry" reads as
        // "no such skill" and the model answers from memory.
        assert!(text.contains("query"), "{text}");
        // It must NOT pick a skill for the model: no skill name is embedded.
        assert!(!text.contains("name="), "{text}");
        assert!(!text.contains("query="), "{text}");

        let tail = vec![
            json!({"role": "assistant", "content": "a"}),
            plan_context_message("\n\n=== SAVED PLAN (from disk) ===\nstep one\n").unwrap(),
            skills_context_message(),
        ];
        assert_eq!(tail.len(), 3);
        // Only the stored assistant message counts toward the fold.
        assert_eq!(plan_context_keep(&tail), 1);
        // A plain message is still counted.
        assert!(!is_wire_only_context("just a question"));
    }

    #[test]
    fn plan_context_keep_excludes_the_wire_only_plan_message() {
        // The renderer stores every message of the tail EXCEPT the plan context,
        // which exists only on the wire. Counting it would tell the renderer to
        // keep one extra stored message verbatim.
        let tail = vec![
            json!({"role": "assistant", "content": "a"}),
            json!({"role": "tool", "content": "t"}),
            json!({"role": "user", "content": "question"}),
            plan_context_message("\n\n=== SAVED PLAN ===\nx\n").unwrap(),
        ];
        assert_eq!(tail.len(), 4);
        assert_eq!(plan_context_keep(&tail), 3);
        // No plan message → the count is just the length.
        let plain = vec![json!({"role": "user", "content": "q"})];
        assert_eq!(plan_context_keep(&plain), 1);
        assert_eq!(plan_context_keep(&[]), 0);
    }

    #[test]
    fn the_system_prompt_prefix_is_byte_stable_across_a_mode_switch() {
        // `messages[0]` is the first byte an automatic prefix cache can reuse,
        // so any volatile value in its OPENING lines re-bills the whole request
        // on every change. `mode` and `root` therefore live in the tail.
        //
        // Measured before the fix: `Mode: build` -> `Mode: ask` changed a byte
        // at offset 120 and collapsed the shared prefix to 1.6%, re-billing
        // 58_432 input tokens at a 0.0% cache hit — while the next ask->ask
        // turn of the same size hit 94.6%. See `default_system_prompt`.
        let root = "/Users/someone/projects/a-really-long-workspace-name";
        let build = default_system_prompt("build", root);
        let ask = default_system_prompt("ask", root);
        let plan = default_system_prompt("plan", root);

        // The two prompts differ ONLY after the constant instructional body.
        let shared = build
            .chars()
            .zip(ask.chars())
            .take_while(|(a, b)| a == b)
            .count();
        // Every byte up to the volatile tail marker must be shared: a mode
        // switch may rewrite the tail (`Mode: {mode}` plus that mode's rule)
        // and NOTHING else. Counting in chars, since the body has em-dashes.
        let tail_at = build
            .find("Workspace root:")
            .expect("the volatile tail marker must exist");
        let body_len = build[..tail_at].chars().count();
        assert!(
            shared >= body_len,
            "the prompts diverge after {shared} chars, inside the constant body \
             (which ends at {body_len}) — a volatile value moved into the cacheable prefix"
        );
        // No mode value may appear in the cacheable head at all.
        let head = &build[..shared];
        for m in ["build", "ask", "plan"] {
            assert!(
                !head.contains(&format!("Mode: {m}")),
                "the `Mode: {m}` marker is inside the cacheable prefix"
            );
        }
        // The volatile values must still reach the model (nothing was dropped).
        assert!(build.contains("Mode: build"));
        assert!(ask.contains("Mode: ask"));
        assert!(plan.contains("Mode: plan"));
        assert!(build.contains(root));
        // The trace ruler keys the main prompt off its first words.
        assert!(build.starts_with("You are Codifa"));
    }

    #[test]
    fn ask_prompt_forces_a_short_answer_and_opt_in_detail() {
        // Ask mode used to receive the same "delegate to `explore` and work from
        // its full report" body as Build, so a one-line question came back as a
        // long structured dump: the brevity rule lived in the appstate text,
        // which the backend never sends. The rule must ride the prompt the model
        // actually gets, and it must be ASK-only.
        let ask = default_system_prompt("ask", "/tmp/x");
        let build = default_system_prompt("build", "/tmp/x");
        let plan = default_system_prompt("plan", "/tmp/x");

        assert!(ask.contains("ASK mode"), "ask must carry its own rule");
        // Brevity is the default, depth is opt-in.
        assert!(ask.contains("Expand ONLY when the user asks for more"));
        assert!(ask.contains("2-4 short lines"));
        assert!(ask.contains("no headings, no numbered steps"));
        // Build/Plan must not inherit the answer-length rule.
        assert!(!build.contains("2-4 short lines"));
        assert!(!plan.contains("2-4 short lines"));
        // The write instruction is mode-neutral in the shared body: a read-only
        // turn must not be told to edit files (the schema carries no such tool).
        assert!(!ask.contains("Use write_file/edit_file/run_terminal"));
        assert!(!plan.contains("Use write_file/edit_file/run_terminal"));
        assert!(build.contains("Use the tools this mode binds to make changes"));
    }

    #[test]
    fn every_mode_states_the_shape_of_its_reply() {
        // Length/style rules used to exist ONLY in `appstate::system_prompts`,
        // which is display-only (`GET /system-prompts`): the model never saw it.
        // Ask got its rule back; build and plan have the same failure mode —
        // build pasted whole files into the reply, plan sprawled because its
        // only deliverable is prose. Pin all three here so a rule cannot be
        // written in the dead table again.
        let root = "/tmp/ws";
        let ask = default_system_prompt("ask", root);
        let build = default_system_prompt("build", root);
        let plan = default_system_prompt("plan", root);

        // Build: the edit is the artifact, the reply is a short report of it.
        assert!(build.contains("IS the artifact"));
        assert!(build.contains("never paste whole files"));
        // Plan: the plan itself is capped, step-shaped, and written for the
        // user — each step says WHAT changes and a summary section closes it.
        assert!(plan.contains("the USER can understand"));
        assert!(plan.contains("under ~25 lines"));
        assert!(plan.contains("one line per step"));
        assert!(plan.contains("summary section"));
        // Ask: short by default, detail is opt-in.
        assert!(ask.contains("2-4 short lines"));

        // The rules must not leak across modes: an ask-shaped reply rule in
        // build would fight the "the edit IS the artifact" rule, and a plan
        // budget in build/ask would be meaningless.
        assert!(!build.contains("2-4 short lines"));
        assert!(!plan.contains("2-4 short lines"));
        assert!(!ask.contains("under ~25 lines"));
        assert!(!build.contains("under ~25 lines"));

        // The read-only rule still reaches the modes that need it (the caps gate
        // is the hard enforcement; this is the instruction the model reads).
        // Ask spells it lowercase inside its own rule, plan in its opening words.
        assert!(plan.contains("READ-ONLY"));
        assert!(ask.contains("read-only AND short"));
        assert!(build.contains("You may write and edit files here"));
        assert!(!build.contains("READ-ONLY"));
    }

    #[test]
    fn only_the_writable_intent_modes_inline_the_coding_rules() {
        // The generic coding rules are a prompt ASSET (`src-tauri/prompts/
        // coding-rules.md`), not a skill: a skill only applied when the model
        // chose to spend a `load_skill` call, and a rule that is never read is
        // not a rule.
        //
        // They belong to the modes that can ACT on them — `build` writes
        // directly, `plan` writes the change it describes — and not to
        // `ask`/`chat`, where the reply is an answer and the rules were billed
        // in full for a turn that could not act on a single line. Measured on
        // the rule asset: ~1.6K chars of prompt per read-only ask turn, all of
        // it dead weight.
        //
        // Match the rule BLOCK's own header, not the bare phrase "CODING
        // RULES": the display-only showcase in `appstate` mentions the phrase
        // in every mode, so a bare-phrase check would pass on the label alone.
        const HEADER: &str = "CODING RULES — apply to every write, edit and review:";
        let root = "/tmp/x";
        let build = default_system_prompt("build", root);
        for mode in ["build", "plan"] {
            let p = default_system_prompt(mode, root);
            assert!(
                p.contains(HEADER),
                "{mode} acts on the change — it must carry the coding rules"
            );
            assert!(
                p.contains("Smallest correct change") && p.contains("Never hard-code"),
                "{mode} must inline the real rule body, not a bare header"
            );
        }
        // Only the modes this function actually serves. `chat`/`reader` are a
        // different prompt entirely (`req.system_prompt` is non-empty for
        // them), so asserting on them here would test code that never runs.
        for mode in ["ask"] {
            let p = default_system_prompt(mode, root);
            assert!(
                !p.contains(HEADER),
                "{mode} is read-only — it must not be billed the coding rules"
            );
            // …and not the rule BODY either: the header alone could be dropped
            // while the ~1.6K chars of rules still rode along.
            assert!(
                !p.contains("Smallest correct change"),
                "{mode} is read-only — it must not be billed the rule body"
            );
        }
        // The rules live in the volatile TAIL (`mode_rule`), so the cached BODY
        // must stay byte-identical between a writable and a read-only turn.
        // Otherwise every Build<->Ask switch would re-bill the whole prefix.
        let body = |p: &str| p.split("Workspace root:").next().unwrap_or_default().to_string();
        assert_eq!(
            body(&build),
            body(&default_system_prompt("ask", root)),
            "the rules must ride in the per-mode tail, not the cached body — \
             otherwise it costs a cache re-bill per switch"
        );
        // Same guarantee between the two modes that DO carry the rules: they
        // must share one byte-identical body, or `build` -> `plan` re-bills it.
        assert_eq!(
            body(&build),
            body(&default_system_prompt("plan", root)),
            "build and plan must share the cached body — the rules ride the tail"
        );
    }

    /// The concrete refused-shape list must reach EVERY mode, from the shared
    /// body — not from a per-mode tail.
    ///
    /// The abstract rule ("locating files is not terminal work") was already in
    /// the prompt and the model still spent the round: measured on a real heavy
    /// turn, three `cd x && find …` / `cat <workspace file>` calls were refused
    /// only AFTER a whole round had been billed (~30K input tokens each).
    /// Naming the exact command shapes is what makes the rule actionable, and it
    /// governs `ask` (whose shell is read-only, not search-free) as much as
    /// `build`, so it belongs to the byte-identical body all four modes share.
    #[test]
    fn the_refused_terminal_shapes_are_named_in_every_mode() {
        let root = "/tmp/x";
        for mode in ["build", "plan", "ask"] {
            let p = default_system_prompt(mode, root);
            assert!(
                p.contains("`find`/`fd`/`tree`/`rg`/`grep -r`"),
                "{mode} may not search through the shell — it must see the exact refused shapes"
            );
            // The carve-out matters as much as the rule: without it the model
            // avoids a piped grep that is perfectly allowed and loses a round
            // the other way.
            assert!(
                p.contains("PIPES another command's output"),
                "{mode} must also learn which shapes are NOT refused"
            );
        }
    }

    #[test]
    fn the_coding_rules_asset_is_complete() {
        // The rules are read from the markdown asset by `include_str!`, so a
        // truncated file would silently ship a stub where the whole rule book
        // used to be.
        assert!(
            CODING_RULES.contains("## 7. Debugging protocol"),
            "the asset must carry every section — the debugging protocol last"
        );
        assert!(
            !CODING_RULES.contains("---"),
            "a prompt asset keeps no frontmatter — that block was the skill's"
        );
    }

    #[test]
    fn the_system_prompt_is_free_of_volatile_plan_text() {
        // Byte-stability guard: `system` must not carry the plan/checklist, or a
        // single checklist tick invalidates the cached prefix of every turn.
        let src = include_str!("prompt.rs").to_string() + include_str!("turn.rs");
        // Built from parts: this test's own source is inside `src`, and a
        // literal needle would match itself.
        let needle = ["system.push_str(&plan", "_section("].concat();
        assert!(
            !src.contains(&needle),
            "the plan section must not be pushed onto the system prompt"
        );
        // The gate still exists: the sub-agent gets no plan at all.
        assert!(
            src.contains("if req.mode == \"subagent\" {\n        String::new()"),
            "the plan/checklist block must be gated on the main agent"
        );

        // And the explore prompt itself must not promise plan tools it lacks.
        let prompt = explore_system_prompt("/tmp/workspace-none");
        assert!(!prompt.contains("update_plan"), "explore prompt mentions update_plan");
        assert!(!prompt.contains("SAVED PLAN"), "explore prompt mentions the plan");
        assert!(!prompt.contains("CHECKLIST"), "explore prompt mentions the checklist");
    }

    #[test]
    fn subagent_fold_uses_its_own_budget_and_keeps_fresh_rounds() {
        // An explore run re-sends its whole accumulated history on EVERY one of
        // its rounds, and nothing folded it mid-loop before
        // (compact_subagent_messages runs once, before the loop).
        let big = "x".repeat(6_000);
        let mut messages: Vec<Value> = Vec::new();
        for i in 1..=4 {
            messages.extend(fold_round(&format!("s{i}"), "read", &big));
        }
        let mut seen = std::collections::HashSet::new();
        fold_subagent_tool_results(&mut messages, &mut seen);

        // The two NEWEST rounds stay verbatim: the model is reasoning over them.
        for i in [5usize, 7usize] {
            assert_eq!(
                messages[i]["content"].as_str().unwrap().chars().count(),
                6_000,
                "a fresh round was folded (message {i})"
            );
        }
        // Older rounds are cut to the SUB budget, not the main one.
        for i in [1usize, 3usize] {
            let c = messages[i]["content"].as_str().unwrap();
            assert!(
                c.chars().count() < SUB_FOLD_RESULT_CHARS + 200,
                "stale round not folded: {} chars",
                c.chars().count()
            );
            assert!(c.starts_with(&"x".repeat(SUB_FOLD_RESULT_CHARS)));
            assert!(c.contains(MAIN_FOLD_MARKER), "stub lost its pointer marker");
        }
        // The fold must fire before compact_subagent_messages would (60% of a
        // 128K window), otherwise the run pays compaction plus a cache reset.
        assert!(
            SUB_FOLD_MIN_TOKENS < 128_000 * 60 / 100,
            "sub fold threshold must sit below the compaction budget"
        );
        // Folding rewrites old results, so it invalidates the cached prefix from
        // that point on. The threshold is therefore not free to go low.
        assert_eq!(SUB_FOLD_MIN_TOKENS, MAIN_FOLD_MIN_TOKENS);
        // Both fold sites must carry the removal floor: the sub-agent path once
        // fired with no floor at all, so a tiny rewrite reset the cached prefix
        // and the next round fell to a 30-45% hit rate (traced r5/r7).
        let src = include_str!("turn.rs");
        let sub_site = src
            .split("if SUB_FOLD_ENABLED")
            .nth(1)
            .expect("the sub-agent fold site must exist");
        let sub_site = sub_site.split("// --- Mid-turn").next().unwrap();
        assert!(
            sub_site.contains("MAIN_FOLD_MIN_REMOVAL"),
            "the sub-agent fold must honour a removal floor, like the main path"
        );
    }

    #[test]
    fn fold_with_takes_keep_rounds_and_budgets_as_parameters() {
        // The shared core must honour whatever the caller passes, so the main
        // and sub-agent paths differ in numbers without forking the logic.
        let big = "y".repeat(5_000);
        let mut messages: Vec<Value> = Vec::new();
        for i in 1..=3 {
            messages.extend(fold_round(&format!("p{i}"), "grep", &big));
        }
        let mut seen = std::collections::HashSet::new();
        // Keep only the newest round, cut everything older to 100 chars.
        fold_with(&mut messages, &mut seen, 1, 100, 100, 100);

        let stale = messages[1]["content"].as_str().unwrap();
        assert!(
            stale.starts_with(&"y".repeat(100)),
            "custom result budget ignored"
        );
        assert!(stale.contains(MAIN_FOLD_MARKER));
        assert!(
            stale.chars().count() < 300,
            "custom budget produced {} chars",
            stale.chars().count()
        );
        // The single kept round is untouched at full size.
        assert_eq!(
            messages[5]["content"].as_str().unwrap().chars().count(),
            5_000
        );

        // Folding is idempotent: a second pass changes nothing.
        let before = stale.to_string();
        fold_with(&mut messages, &mut seen, 1, 100, 100, 100);
        assert_eq!(messages[1]["content"].as_str().unwrap(), before);
    }

    /// The in-turn fold is OFF for the explore sub-agent, and this assertion is
    /// the decision written into the build.
    ///
    /// Measured on the reference trace (236 explore calls, 1,375,702 uncached
    /// input tokens): cold first calls 9%, appended content 33%, and **57%
    /// prefix-break re-bill** — the fold's doing. With a ~91% cache hit rate the
    /// tokens a fold "saves" are nearly free already, while the re-bill it
    /// causes is paid in full: 253,824 already-cached tokens were thrown away
    /// and every measured fold was net negative (17-26K tokens lost in the
    /// worst runs).
    ///
    /// Flipping this back to `true` is one line — but it must come with a fresh
    /// measurement, because the answer depends entirely on the gateway caching
    /// the prefix. A provider without prefix caching would flip it.
    #[test]
    fn subagent_fold_stays_off_without_a_fresh_measurement() {
        assert!(
            !SUB_FOLD_ENABLED,
            "The explore fold is disabled by measurement: 57% of uncached explore \
             input was the prefix-break re-bill its own rewrites caused. Re-enable \
             it only together with a fresh trace measurement."
        );
    }

    /// `fold_with` must REPORT what it removed.
    ///
    /// Before it returned a number, every attempt to price the fold had to infer
    /// "a fold happened here" from the prompt shrinking between two calls — an
    /// inference that cannot tell a fold from mid-turn compaction, and that
    /// measures the shrink AFTER the fact (biased). The numbers it returns now
    /// are what the trace records.
    #[test]
    fn the_oversized_pass_elides_only_stale_giants_and_keeps_small_results() {
        // Traced 6 Nov: `read` carried 56-75% of all tool-result chars (p90
        // ≈16K) and rode EVERY following round on turns the 20K whole-prompt
        // gate never reached. The oversized pass must elide exactly the stale
        // giants — never small results, never the kept rounds, never reports.
        let giant = "x".repeat(16_000);
        let small = "s".repeat(3_000);
        let mut messages: Vec<Value> = Vec::new();
        // Stale: one giant read, one small read, one giant report (explore).
        messages.extend(fold_round("c1", "read", &giant));
        messages.extend(fold_round("c2", "read", &small));
        messages.extend(fold_round("c3", "explore", &"r".repeat(16_000)));
        // Two fresh rounds that stay untouched (the keep window).
        messages.extend(fold_round("c4", "read", &giant));
        messages.extend(fold_round("c5", "read", &giant));
        let mut seen = std::collections::HashSet::new();
        let (removed, folded) =
            fold_oversized_search_results(&mut messages, &mut seen, MAIN_FOLD_KEEP_ROUNDS);
        assert_eq!(folded, 1, "only the stale giant read folds; {removed} chars out");
        assert!(removed >= 12_000, "{removed}");
        let content = |id: &str| {
            messages
                .iter()
                .find(|m| m["tool_call_id"] == id)
                .and_then(|m| m["content"].as_str())
                .unwrap_or_default()
                .to_string()
        };
        let c1 = content("c1");
        assert!(c1.contains(MAIN_FOLD_MARKER), "giant read folded: {c1}");
        assert!(c1.len() < 3_000, "the stub keeps only the short head: {}", c1.len());
        assert_eq!(content("c2").len(), 3_000, "a small result is never elided");
        assert_eq!(content("c3").len(), 16_000, "an explore report is out of this pass");
        assert_eq!(content("c4").len(), 16_000, "kept rounds untouched");
        assert_eq!(content("c5").len(), 16_000, "kept rounds untouched");
        // Idempotent: a second pass is a no-op.
        let (removed2, folded2) =
            fold_oversized_search_results(&mut messages, &mut seen, MAIN_FOLD_KEEP_ROUNDS);
        assert_eq!(folded2, 0, "second pass must be a no-op");
        assert_eq!(removed2, 0, "{removed2}");
    }

    #[test]
    fn fold_with_reports_removed_chars_and_message_count() {
        let big = "y".repeat(10_000);
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "read", &big));
        messages.extend(fold_round("c2", "read", &big));
        // Two fresh rounds that must stay untouched, so c1/c2 are stale.
        messages.extend(fold_round("c3", "read", &big));
        messages.extend(fold_round("c4", "read", &big));
        let before: usize = messages
            .iter()
            .map(|m| m["content"].as_str().map(|c| c.chars().count()).unwrap_or(0))
            .sum();

        let (removed, folded) = fold_stale_tool_results(&mut messages, &mut seen_set());

        assert_eq!(folded, 2, "exactly the two stale rounds are folded");
        assert!(removed > 0, "the removal is reported, not silently swallowed");
        let after: usize = messages
            .iter()
            .map(|m| m["content"].as_str().map(|c| c.chars().count()).unwrap_or(0))
            .sum();
        assert!(
            removed >= before - after,
            "reported {removed} chars must cover the real shrink {}",
            before - after
        );

        // A second pass is a no-op and reports nothing: the report must not
        // double-count the same fold on every later round.
        assert_eq!(fold_stale_tool_results(&mut messages, &mut seen_set()), (0, 0));
    }

    #[test]
    fn fold_pays_off_skips_the_last_calls_of_a_run() {        // A fold rewrites OLD tool results, so the request right after it is
        // re-billed from the first changed byte: a fixed cost that only pays
        // back if enough round-trips remain to reuse the shorter prompt.
        // Measured over 85 real folds: the 31 that happened with 3 or fewer
        // calls left were ALL net losses (-172_630 tokens), while every bucket
        // from 4 calls left on was net-positive. Hence the threshold.
        assert!(!fold_pays_off(0));
        assert!(!fold_pays_off(1)); // the run's LAST model call
        assert!(!fold_pays_off(2));
        assert!(fold_pays_off(3)); // the threshold
        assert!(fold_pays_off(SUBAGENT_MAX_STEPS)); // a full sub-agent budget

        // The guard must not shadow the elision it protects: it sits far below
        // the run length, so an explore run that folds at all still folds.
        assert!(SUBAGENT_MAX_STEPS > FOLD_MIN_REMAINING_CALLS);
    }

    #[test]
    fn main_wrapup_nudge_never_fires_without_a_cap() {
        // The main agent has NO round cap (`max_steps == usize::MAX`), so it can
        // always finish the job it started. A nudge saying "the budget is nearly
        // exhausted" would be false there — and it would push the model to stop
        // mid-work, the exact failure the cap removal fixes.
        for step in [0, 1, 5, 55, 500, 100_000] {
            assert!(
                main_wrapup_message(step, usize::MAX, false, "main").is_none(),
                "a turn with no cap must never be told its budget is nearly spent"
            );
        }
        // A sub-agent keeps its own budget nudges and never sees this one.
        assert!(main_wrapup_message(0, SUBAGENT_MAX_STEPS, false, "subagent").is_none());
        // A bounded budget can still exist (tests, future callers): the nudge
        // lands MAIN_WRAPUP_STEPS_LEFT rounds before it, exactly once.
        let capped = 60;
        let at = capped - MAIN_WRAPUP_STEPS_LEFT;
        assert!(main_wrapup_message(at - 1, capped, false, "main").is_none());
        assert!(main_wrapup_message(at, capped, false, "main").is_some());
        // After delivery it stays silent: a repeated nudge would be re-billed on
        // every remaining round for no new information.
        assert!(main_wrapup_message(at + 1, capped, true, "main").is_none());
        // The margin leaves room to actually wrap up: at least one round to
        // read the nudge, one to answer. A margin of 1 would nudge on the very
        // last round, where nothing can come of it.
        assert!(MAIN_WRAPUP_STEPS_LEFT >= 2);
    }

    #[test]
    fn a_peanut_fold_would_cost_more_than_it_saves() {
        // The 12:44 run folded 226 tokens out of an early result and re-billed
        // the WHOLE ~40K cached prefix at miss price one model call later — a
        // net loss ~180× the gain. The main fold must therefore clear a floor
        // before mutating history; sub-agent folds keep their own (much larger)
        // budgets and their own payoff rule.
        assert!(MAIN_FOLD_MIN_REMOVAL > 0);
        // The floor is comfortably above the measured peanut (226 tok) but far
        // below a real stale explore report (10-40K), so useful folds survive.
        assert!(MAIN_FOLD_MIN_REMOVAL > 1_000);
        assert!(MAIN_FOLD_MIN_REMOVAL < MAIN_FOLD_MIN_TOKENS);
    }

    #[test]
    fn the_fold_floor_is_compared_in_tokens_not_characters() {
        // `fold_with` returns CHARACTERS removed; `MAIN_FOLD_MIN_REMOVAL` is a
        // TOKEN floor (`record_fold` writes `removed_chars / 4` as
        // `removed_tokens_est`). Comparing the raw char count against the token
        // floor is a 4x unit error that ADMITS folds the floor means to refuse:
        // traced on the 01:00 build, a `removed_tokens_est = 1947` fold was
        // recorded while the floor was 4_000.
        //
        // A removal that is UNDER the floor in tokens but would pass it in
        // characters is exactly the case the conversion must reject.
        let peanut_tokens = MAIN_FOLD_MIN_REMOVAL / 4 + 100; // ~1_100 tok
        let peanut_chars = peanut_tokens * 4; // char count PASSES the raw floor
        assert!(
            peanut_chars >= MAIN_FOLD_MIN_REMOVAL,
            "the raw char count is what used to slip through"
        );
        assert!(
            peanut_chars.div_ceil(4) < MAIN_FOLD_MIN_REMOVAL,
            "converted to tokens it must be refused"
        );

        // And a fold that genuinely clears the floor in tokens is still allowed.
        let real_chars = MAIN_FOLD_MIN_REMOVAL * 4;
        assert!(real_chars.div_ceil(4) >= MAIN_FOLD_MIN_REMOVAL);
    }
