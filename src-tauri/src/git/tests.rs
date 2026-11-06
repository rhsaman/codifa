    use super::*;

    #[test]
    fn branch_validation_rejects_shell_metachars() {
        assert!(valid_branch("feature/x-1.2").is_ok());
        assert!(valid_branch("-evil").is_err());
        assert!(valid_branch("..").is_err());
        assert!(valid_branch("a b").is_err());
        assert!(valid_branch("a;b").is_err());
    }

    /// A diff whose byte cap lands inside a multi-byte character (an em dash,
    /// Persian text) used to panic with "not a char boundary".
    #[test]
    fn truncate_cuts_on_a_char_boundary() {
        // '—' is 3 bytes: put it so MAX_DIFF falls in the middle of it.
        let mut diff = "a".repeat(MAX_DIFF - 2);
        diff.push('—');
        diff.push_str("tail");
        let out = truncate(diff);
        assert_eq!(out["truncated"], true);
        let kept = out["diff"].as_str().unwrap();
        assert_eq!(kept.len(), MAX_DIFF - 2);
        assert!(kept.chars().all(|c| c == 'a'));
        // Under the cap: untouched.
        let small = truncate("short — diff".to_string());
        assert_eq!(small["truncated"], false);
    }

    #[test]
    fn remote_validation_rejects_urls() {
        // A URL must fail remote validation before git is ever touched.
        // Use an existing dir (the workspace) so we hit the remote check,
        // not the root check.
        let root = env!("CARGO_MANIFEST_DIR");
        let e = push(root, "https://evil", "main", false).unwrap_err();
        assert!(e.0.contains("invalid remote"), "got: {}", e.0);
    }
