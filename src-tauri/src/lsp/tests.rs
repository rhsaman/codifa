    use super::*;

    /// A heavy server must be recognised from its registry key, must not be
    /// pre-warmed, and must get a shorter idle TTL than a light one.
    ///
    /// `rust-analyzer` measured 1921 MB of physical footprint for one workspace
    /// — twice the whole app's budget — while the app shell was 233 MB. Two
    /// things made it permanent: `prewarm` spawned one for every project ever
    /// opened, and the shared ten-minute idle TTL never expired for it because
    /// each agent turn's `prewarm` refreshed `last_used` through the fast path.
    #[test]
    fn heavy_servers_are_never_prewarmed_and_expire_sooner() {
        // The languages whose index is measured in gigabytes.
        for lang in ["rust", "c", "cpp", "java", "scala", "haskell", "dart", "csharp"] {
            assert!(is_heavy_language(lang), "{lang} must be heavy");
        }
        // The cheap ones this app pre-warms on purpose.
        for lang in ["typescript", "python", "json", "yaml", "bash"] {
            assert!(!is_heavy_language(lang), "{lang} must not be heavy");
        }
        // The short TTL must actually be shorter, or the policy is cosmetic.
        assert!(LSP_HEAVY_IDLE_TTL < LSP_IDLE_TTL);

        // Pre-warm is a latency/memory TRADE, decided by measured cost: the
        // cheap server stays warm, everything that costs more than the app shell
        // waits for a real call. `pylsp` measured 158 MB for one workspace.
        assert!(should_prewarm("typescript"));
        assert!(!should_prewarm("python"));
        for lang in HEAVY_LANGUAGES {
            assert!(!should_prewarm(lang), "{lang} must not be pre-warmed");
        }
    }

    /// A FIRST `didOpen` needs more budget than a re-lint, and the code must
    /// actually use the wider one.
    ///
    /// MEASURED with a real client against `typescript-language-server` on a
    /// workspace file: the first `publishDiagnostics` after `didOpen` arrived in
    /// 1.99s, the re-lint after `didChange` in 0.40s. The automatic post-edit
    /// window was 1.5s for both, so every FIRST edit of a file silently dropped
    /// its answer — the trace showed the marker on 2 of 56 edits, and only for
    /// files another call had opened earlier.
    #[test]
    fn a_first_open_gets_more_diagnostics_time_than_a_relint() {
        assert!(
            POST_EDIT_DIAGNOSTICS_WINDOW_COLD > POST_EDIT_DIAGNOSTICS_WINDOW,
            "the first-open window must be wider than the warm one, or the \
             measured 1.99s first lint is dropped again"
        );
        // The widening is bounded: this window rides on an EDIT result, so it may
        // never approach the explicit `lsp_diagnostics` budget (3s) — it is
        // allowed to match it at most.
        assert!(POST_EDIT_DIAGNOSTICS_WINDOW_COLD <= DIAGNOSTICS_WINDOW);
        // And it must stay above the measured 0.40s re-lint, so a warm answer is
        // never dropped either.
        assert!(POST_EDIT_DIAGNOSTICS_WINDOW >= Duration::from_millis(400));
    }

    /// The client MUST declare `publishDiagnostics`, or the server never pushes.
    ///
    /// MEASURED with a 2x2 factor matrix (declared capabilities x the answers
    /// given to server->client requests) against `typescript-language-server`,
    /// same `didOpen` every time: `documentSymbol`-only (what this client used to
    /// send) produced NO `publishDiagnostics` in a 10s window, adding
    /// `textDocument.publishDiagnostics` produced it in 0.00s, and adding
    /// `synchronization` or `workspace.configuration` changed nothing.
    ///
    /// The blast radius was measured on real traces: the post-edit lever fired on
    /// 3 of 99 edits and an explicit `lsp_diagnostics` answered "no report
    /// arrived" — a silent, permanent quality hole that read as a slow server.
    #[test]
    fn the_client_declares_the_capability_the_push_requires() {
        let caps = initialize_capabilities();
        assert_eq!(
            caps.pointer("/textDocument/publishDiagnostics/relatedInformation"),
            Some(&Value::Bool(true)),
            "without textDocument.publishDiagnostics the server pushes nothing"
        );
        // The one capability that was already there and is load-bearing for
        // `symbols`: flat SymbolInformation is unusable as an outline.
        assert_eq!(
            caps.pointer("/textDocument/documentSymbol/hierarchicalDocumentSymbolSupport"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn language_detection_matches_python_registry() {
        assert_eq!(language_for_suffix(".py"), Some("python"));
        assert_eq!(language_for_suffix(".tsx"), Some("typescript"));
        assert_eq!(language_for_suffix(".hpp"), Some("cpp"));
        assert_eq!(language_for_suffix(".yaml"), Some("yaml"));
        assert_eq!(language_for_suffix(".unknown"), None);
    }

    /// One PROCESS key per binary: `.js` and `.ts` share
    /// `typescript-language-server`, so both must resolve to the same registry
    /// key. With two keys the pre-warm started TWO servers (each with its own
    /// `tsserver` children) for a single root — ~470 MB of node RSS for one
    /// project.
    #[test]
    fn js_and_ts_share_one_server_key() {
        assert_eq!(language_for_suffix(".js"), language_for_suffix(".ts"));
        assert_eq!(language_for_suffix(".mjs"), Some("typescript"));
        assert_eq!(language_for_suffix(".cjs"), Some("typescript"));
        assert_eq!(language_for_suffix(".jsx"), Some("typescript"));
    }

    /// The protocol languageId is NOT the process key: a plain `.js` file must
    /// still be announced as JavaScript.
    #[test]
    fn js_language_id_stays_javascript() {
        assert_eq!(language_id_for_suffix(".js"), "javascript");
        assert_eq!(language_id_for_suffix(".mjs"), "javascript");
        assert_eq!(language_id_for_suffix(".cjs"), "javascript");
        assert_eq!(language_id_for_suffix(".jsx"), "javascriptreact");
    }

    #[test]
    fn language_id_uses_vscode_identifiers() {
        assert_eq!(language_id_for_suffix(".tsx"), "typescriptreact");
        assert_eq!(language_id_for_suffix(".sh"), "shellscript");
        assert_eq!(language_id_for_suffix(".py"), "python");
    }

    /// The heap cap must never swallow a user's own `NODE_OPTIONS`: a missing
    /// separator turns `--max-old-space-size=1024--inspect=0` into an invalid
    /// string and node refuses to start at all.
    #[test]
    fn node_options_cap_is_always_separated() {
        std::env::remove_var("NODE_OPTIONS");
        assert_eq!(node_options_with_heap_cap(), "--max-old-space-size=1024");
        std::env::set_var("NODE_OPTIONS", "--inspect=0");
        assert_eq!(
            node_options_with_heap_cap(),
            "--max-old-space-size=1024 --inspect=0"
        );
        std::env::set_var("NODE_OPTIONS", "   ");
        assert_eq!(node_options_with_heap_cap(), "--max-old-space-size=1024");
        std::env::remove_var("NODE_OPTIONS");
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
    fn symbol_position_prefers_hint_line_then_code_over_comments() {
        let text = "// compact_history is great\nfn other() {}\npub async fn compact_history(a: u8) {}\nlet x = compact_history(1);\n";
        // No hint: skips the comment and lands on the declaration (line 3).
        assert_eq!(find_symbol_position(text, "compact_history", None), Some((3, 13)));
        // The hint line wins even when the model got the column wrong.
        assert_eq!(find_symbol_position(text, "compact_history", Some(4)), Some((4, 8)));
        // A hint line without the symbol falls back to the global search.
        assert_eq!(find_symbol_position(text, "compact_history", Some(2)), Some((3, 13)));
        // Whole-word only; comment-only occurrences still resolve as a fallback.
        assert_eq!(find_symbol_position("fn compact_history_x() {}", "compact_history", None), None);
        assert_eq!(find_symbol_position("// foo bar\n", "foo", None), Some((1, 3)));
    }

    #[test]
    fn symbol_position_is_utf16_after_persian_text() {
        // "سلام " is 5 UTF-16 units before the symbol; an emoji takes 2.
        assert_eq!(find_symbol_position("سلام foo()\n", "foo", None), Some((1, 5)));
        assert_eq!(find_symbol_position("😀 foo()\n", "foo", None), Some((1, 3)));
    }

    #[test]
    fn resolve_binary_passes_explicit_paths_and_falls_back_to_bare_name() {
        let p = augmented_path();
        assert_eq!(resolve_binary("/x/y", &p), PathBuf::from("/x/y"));
        assert_eq!(
            resolve_binary("definitely-not-installed-xyz", &p),
            PathBuf::from("definitely-not-installed-xyz")
        );
    }

    #[test]
    fn definition_rejects_paths_outside_root() {
        let tmp = std::env::temp_dir().join(format!("codifa-lsp-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let err = definition(tmp.to_str().unwrap(), "../../etc/passwd", 1, 0, None);
        assert!(err.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }
