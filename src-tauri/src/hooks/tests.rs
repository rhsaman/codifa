    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-hooks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(HOOKS)).unwrap();
        dir
    }

    #[test]
    fn a_group_declaration_is_read_into_one_row_per_command() {
        let doc = json!({
            "hooks": {
                "PreToolUse": [
                    {"matcher": "write", "hooks": [{"type": "command", "command": "./guard.sh"}]}
                ]
            }
        });
        let hooks = hooks_of(&doc);
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, "PreToolUse");
        assert_eq!(hooks[0].matcher, "write");
    }

    #[test]
    fn a_command_reaching_outside_the_bundle_is_dropped() {
        let dir = fixture("outside");
        let doc = json!({
            "hooks": {"Stop": [
                {"hooks": [{"command": "../elsewhere/evil.sh"}]},
                {"command": "/etc/passwd"},
                {"command": "./ok.sh"}
            ]}
        });
        let hooks = hooks_of_in(&doc, &dir);
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].command, "./ok.sh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exit_two_blocks_with_its_message() {
        let dir = fixture("block");
        std::fs::write(hooks_dir(&dir).join("hooks.json"), "{}").unwrap();
        let hooks = vec![Hook {
            event: "PreToolUse".into(),
            matcher: "write".into(),
            command: "echo 'no writes here'; exit 2".into(),
        }];
        let outcome = run_event(&dir, &hooks, "PreToolUse", "write");
        assert!(outcome.blocked);
        assert!(outcome.reason.contains("no writes here"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_json_block_decision_is_not_mistaken_for_a_handler_file() {
        // A veto prints JSON; a bundle's handler file is a path. Only the latter
        // is something an install has to carry, so the two must not be confused.
        assert_eq!(
            handler_path("${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh"),
            Some("hooks-handlers/session-start.sh".into())
        );
        assert_eq!(handler_path("./guard.sh"), Some("guard.sh".into()));
        // Inline shell, a PATH program, and an absolute path carry no file.
        assert_eq!(handler_path("exit 2"), None);
        assert_eq!(handler_path("jq -r '.x' <<< $_"), None);
        assert_eq!(handler_path("/usr/local/bin/guard"), None);
        // A relative escape is refused outright (see `command_is_contained`).
        assert_eq!(handler_path("./../../etc/passwd"), None);
    }

    #[test]
    fn the_plugin_root_variable_reaches_a_handler() {
        // A real bundle spells its command `${CLAUDE_PLUGIN_ROOT}/…`. Without the
        // var the shell expands it to nothing and the handler dies as
        // `/hooks-handlers/…`, so the run itself must provide it.
        let dir = fixture("plugin-root");
        std::fs::create_dir_all(dir.join("hooks-handlers")).unwrap();
        std::fs::write(
            dir.join("hooks-handlers/ping.sh"),
            "#!/bin/sh\necho from-$CLAUDE_PLUGIN_ROOT\n",
        )
        .unwrap();
        let hooks = vec![Hook {
            event: "SessionStart".into(),
            matcher: "".into(),
            command: "sh ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/ping.sh".into(),
        }];
        let outcome = run_event(&dir, &hooks, "SessionStart", "");
        assert_eq!(outcome.ran, 1);
        assert!(
            outcome.output.contains("from-") && outcome.output.contains("plugin-root"),
            "the handler must see the bundle folder, got {:?}",
            outcome.output
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_matcher_that_does_not_match_is_not_run() {
        let dir = fixture("nomatch");
        let hooks = vec![Hook {
            event: "PreToolUse".into(),
            matcher: "terminal".into(),
            command: "exit 2".into(),
        }];
        let outcome = run_event(&dir, &hooks, "PreToolUse", "read");
        assert!(!outcome.blocked);
        assert_eq!(outcome.ran, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_block_decision_vetoes_without_an_exit_code() {
        // The documented alternative to exit 2: a bundle that prints its verdict
        // must be understood the same way.
        let dir = fixture("jsonblock");
        let hooks = vec![Hook {
            event: "PreToolUse".into(),
            matcher: "".into(),
            command: r#"echo '{"decision":"block","reason":"no rm here"}'"#.into(),
        }];
        let outcome = run_event(&dir, &hooks, "PreToolUse", "run_terminal");
        assert!(outcome.blocked);
        assert!(outcome.reason.contains("no rm here"), "{}", outcome.reason);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn post_tool_output_is_kept_as_information() {
        // A call that already happened cannot be stopped; what the handler
        // prints is what the model gets told about it.
        let dir = fixture("post");
        let hooks = vec![Hook {
            event: "PostToolUse".into(),
            matcher: "edit".into(),
            command: "echo 'formatted 2 files'".into(),
        }];
        let outcome = run_event(&dir, &hooks, "PostToolUse", "edit_file");
        assert!(!outcome.blocked);
        assert_eq!(outcome.output, "formatted 2 files");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bundle_the_user_did_not_approve_contributes_no_handler() {
        // The security gate: writing hooks.json is never approval to RUN it.
        let dir = fixture("untrusted");
        std::fs::write(
            hooks_file(&dir),
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"touch ran"}]}]}}"#,
        )
        .unwrap();
        // `false` = the manifest carries no `hooks_enabled`.
        let active = active_in(&[(dir.clone(), false)]);
        assert!(active.is_empty(), "{active:?}");
        let outcome = run_active(&active, "Stop", "");
        assert_eq!(outcome.ran, 0);
        assert!(!dir.join("ran").exists());
        // ...and the same declaration DOES land once the user approves it.
        let active = active_in(&[(dir.clone(), true)]);
        assert_eq!(active.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_veto_stops_the_event() {
        // A guard that already refused must not be argued with by the next
        // bundle's handler.
        let a = fixture("veto-a");
        let b = fixture("veto-b");
        let active = active_in(&[(a.clone(), true), (b.clone(), true)]);
        assert!(active.is_empty(), "no declaration on disk yet");
        std::fs::write(
            hooks_file(&a),
            r#"{"hooks":{"PreToolUse":[{"matcher":"write","hooks":[{"command":"echo stop; exit 2"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(
            hooks_file(&b),
            r#"{"hooks":{"PreToolUse":[{"matcher":"write","hooks":[{"command":"touch second-ran"}]}]}}"#,
        )
        .unwrap();
        let active = active_in(&[(a.clone(), true), (b.clone(), true)]);
        let outcome = run_active(&active, "PreToolUse", "write_file");
        assert!(outcome.blocked);
        assert_eq!(outcome.ran, 1, "the second bundle must not run");
        assert!(!b.join("second-ran").exists());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
