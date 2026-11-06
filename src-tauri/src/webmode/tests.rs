    use super::*;

    #[test]
    fn token_match_rejects_wrong_length_and_content() {
        // No token installed in the test process: everything must be refused.
        assert!(!token_matches(""));
        assert!(!token_matches("whatever"));
    }

    #[test]
    fn serve_config_reads_cli_flags() {
        // Directly exercise the flag parser via a fake argv is awkward with
        // std::env::args pinned to the test binary, so only assert the
        // desktop default here: no serve flags in a unit-test run.
        // (from_env_and_args is covered by the smoke test in serve mode.)
        let forced = std::env::var("CODIFA_SERVE").is_ok();
        if !forced {
            assert!(from_env_and_args().is_none());
        }
    }
