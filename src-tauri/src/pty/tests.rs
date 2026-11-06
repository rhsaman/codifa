    use super::*;

    #[test]
    fn decrqm_probes_are_stripped() {
        // nvim 0.11's startup feature probes — the exact set that deadlocks
        // xterm.js 6 inside WKWebView. Each must vanish entirely.
        assert_eq!(strip_decrqm(b"\x1b[?69$p\x1b[?2026$p"), Vec::<u8>::new());
        let nvim = b"\x1b[?1049h\x1b[?69$p\x1b[?2026$p\x1b[?2048$p\x1b[c";
        assert_eq!(
            strip_decrqm(nvim),
            b"\x1b[?1049h\x1b[c".to_vec(),
            "surrounding sequences survive"
        );
        // A query split across chunks never reaches here (emit_safe_len holds
        // a trailing partial CSI back), but a COMPLETE non-DECRQM CSI with a
        // '$' elsewhere in the chunk must pass through untouched.
        assert_eq!(strip_decrqm(b"\x1b[4:3mok"), b"\x1b[4:3mok".to_vec());
        assert_eq!(strip_decrqm(b"a$b c"), b"a$b c".to_vec());
        // DECRPM-style requests without the '?' private marker are still
        // DECRQM (ANSI modes) and deadlock xterm the same way.
        assert_eq!(strip_decrqm(b"\x1b[4$p"), Vec::<u8>::new());
        // An unfinished candidate at the chunk end is left alone (it cannot be
        // complete — emit_safe_len would have held it — but never eat bytes).
        assert_eq!(strip_decrqm(b"\x1b[?2048$"), b"\x1b[?2048$".to_vec());
    }

    #[test]
    fn colon_truecolor_sgr_is_rewritten_to_semicolons() {
        // The exact bytes captured from nvim under TERM_PROGRAM=iTerm.app.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[38:2:224:222:244m"),
            b"\x1b[38;2;224;222;244m".to_vec()
        );
        assert_eq!(
            sanitize_colon_sgr(b"x\x1b[48:2:25:23:36m y"),
            b"x\x1b[48;2;25;23;36m y".to_vec()
        );
        // A leading plain parameter must survive the flattening.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[0;38:2:110:106:134m"),
            b"\x1b[0;38;2;110;106;134m".to_vec()
        );
    }

    #[test]
    fn other_sequences_pass_through_untouched() {
        // The colourspace-carrying form xterm.js parses correctly.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[38:2:0:224:222:244m"),
            b"\x1b[38:2:0:224:222:244m".to_vec()
        );
        // Underline colon SGR / a shorter colon parameter / a wrong colour id.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[58:2:1:2:3m"),
            b"\x1b[58:2:1:2:3m".to_vec()
        );
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[38;2;1:2m z"),
            b"\x1b[38;2;1:2m z".to_vec()
        );
        // Plain payload and non-SGR CSI.
        assert_eq!(
            sanitize_colon_sgr(b"hi\x1b[2K\x1b[1;5Hthere"),
            b"hi\x1b[2K\x1b[1;5Hthere".to_vec()
        );
    }

    #[test]
    fn an_unfinished_csi_at_the_tail_is_held_back() {
        assert_eq!(emit_safe_len(b"\x1b[38:2:110"), 0);
        assert_eq!(emit_safe_len(b"\x1b[38"), 0);
        assert_eq!(emit_safe_len(b"prep \x1b["), 5);
        assert_eq!(emit_safe_len(b"pre\x1b[38:2:"), 3);
        // A COMPLETE sequence — even colon-formed — is never held.
        let done = b"\x1b[38:2:110;1m rest";
        assert_eq!(emit_safe_len(done), done.len());
        // Text around escapes survives: only the ESC tail is held.
        assert_eq!(emit_safe_len(b"ab\x1b"), 2);
        // String sequences (OSC) stream through even when unterminated.
        let osc = b"a\x1b]0;title";
        assert_eq!(emit_safe_len(osc), osc.len());
        assert_eq!(emit_safe_len(b"\x1b[m"), 3);
    }

    #[test]
    fn only_a_path_separator_makes_a_program_a_path() {
        assert!(!has_separator("nvim"));
        assert!(has_separator("bin/nvim"));
        assert!(has_separator("/opt/homebrew/bin/nvim"));
    }

    #[test]
    fn an_absolute_program_must_exist() {
        assert!(resolve_program("/no/such/dir/nvim").is_none());
        #[cfg(unix)]
        assert_eq!(resolve_program("/bin/sh").as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn an_uninstalled_bare_name_stays_unresolved() {
        // Nothing is installed under that name, so the spawn must fail loudly
        // instead of quietly handing the user a shell tab.
        assert!(resolve_program("codifa-no-such-program").is_none());
    }

    #[test]
    fn a_program_runs_through_the_login_shell_with_its_own_argv() {
        // `-lc <script> <$0> <args…>` — the program's path is `$0`, the rest is
        // `$@`, so a path is never quoted into the script text.
        let argv = program_argv("/bin/sh", &["+42".into(), "/w/a.ts".into()]).unwrap();
        assert_eq!(argv[0], "-lc");
        assert_eq!(argv[1], "exec \"$0\" \"$@\"");
        assert_eq!(argv[2], "/bin/sh");
        assert_eq!(&argv[3..], &["+42", "/w/a.ts"]);
    }

    #[test]
    fn a_program_argv_never_injects_a_double_dash_separator() {
        // `nvim -- <file>` makes nvim read the file as a second filename: the
        // requested one opened as an EMPTY buffer. The separator must not exist.
        let argv = program_argv("/bin/sh", &["/w/a.ts".into()]).unwrap();
        assert!(!argv.iter().any(|a| a == "--"));
    }

    #[test]
    fn an_unresolvable_program_is_an_error_never_a_shell() {
        assert!(program_argv("codifa-no-such-program", &[]).is_err());
    }

    #[test]
    fn the_picked_shell_overrides_the_login_one() {
        // An absolute, existing shell wins over $SHELL.
        assert_eq!(
            pick_shell("/bin/sh", || "/bin/zsh".into(), "zsh"),
            "/bin/sh"
        );
    }

    #[test]
    fn an_unset_shell_preference_uses_the_documented_default() {
        // No setting must not mean "whatever sh --login gives": the app's default
        // is zsh (DEFAULT_TERMINAL_SHELL), resolved on the LOGIN path — so a
        // Homebrew zsh wins over /bin/zsh, which is exactly the point.
        let homebrew = pick_shell("", || "/bin/zsh".into(), "zsh");
        assert!(
            homebrew.ends_with("/zsh"),
            "the default must resolve to an actual zsh, got {homebrew}"
        );
        assert_eq!(pick_shell("   ", || "/bin/sh".into(), "zsh").ends_with("/zsh"), true);
        // A default the machine does not have still degrades to the OS shell.
        assert_eq!(
            pick_shell("", || "/bin/sh".into(), "codifa-no-such-shell"),
            "/bin/sh"
        );
    }

    #[test]
    fn an_unresolvable_shell_falls_back_instead_of_failing() {
        // A stale setting (a shell the user uninstalled) must still open a tab.
        assert_eq!(
            pick_shell("codifa-no-such-shell", || "/bin/zsh".into(), "zsh"),
            "/bin/zsh"
        );
    }
