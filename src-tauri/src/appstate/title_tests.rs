    use super::clean_title;

    #[test]
    fn clean_title_strips_reasoning_and_decoration() {
        // A reasoning model's think block must never reach the sidebar.
        assert_eq!(clean_title(" thinkingweighing options</think>Fix the browser panel"), "Fix the browser panel");
        assert_eq!(clean_title("<thinking>x</thinking>Terminal scrollbar"), "Terminal scrollbar");
        // Bullets, quotes and trailing punctuation are decoration, not title.
        assert_eq!(clean_title("- \"Compact summary ledger\""), "Compact summary ledger");
        assert_eq!(clean_title("## Plan: migrate to Rust."), "Plan: migrate to Rust");
        // A think-only reply has no title at all — the caller must fall back.
        assert_eq!(clean_title(" thinkingonly thinking</think>"), "");
        assert_eq!(clean_title("   \n  "), "");
        // Long replies are cut to a sidebar-sized line.
        assert_eq!(clean_title(&"a".repeat(200)).chars().count(), 80);
        // A sentence from a chatty model is capped at WHOLE words: no partial
        // word, no "…" and never more than the four words the sidebar shows.
        assert_eq!(
            clean_title("Refactor the title generator endpoint to cap words"),
            "Refactor the title generator"
        );
        // The cut can leave punctuation on the last kept word.
        assert_eq!(
            clean_title("Fix the failing tests, please."),
            "Fix the failing tests"
        );
        assert_eq!(
            clean_title("خطاهای تست را رفع کن و بعد کامیت کن"),
            "خطاهای تست را رفع"
        );
    }
