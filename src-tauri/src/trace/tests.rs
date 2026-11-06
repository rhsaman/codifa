    use super::*;

    #[test]
    fn sanitize_keeps_safe_chars() {
        assert_eq!(sanitize("abc-123_x"), "abc-123_x");
        assert_eq!(sanitize("a/b c"), "a_b_c");
    }

    #[test]
    fn trace_page_walks_backwards_from_the_newest() {
        let rows: Vec<String> = (0..5)
            .map(|i| format!(r#"{{"id":"t{i}","kind":"tool"}}"#))
            .collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        // The newest page is the LAST `limit` entries, in log order.
        let (page, counts) = trace_page(&lines, 2, 0, "", true);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["id"], "t3");
        assert_eq!(page[1]["id"], "t4");
        assert_eq!(counts[0], 5);
        // `before` = already loaded, so the next page is the two above it.
        let (older, _) = trace_page(&lines, 2, 2, "", true);
        assert_eq!(older.len(), 2);
        assert_eq!(older[0]["id"], "t1");
        assert_eq!(older[1]["id"], "t2");
        // Past the start: return what exists, never an error.
        let (rest, _) = trace_page(&lines, 2, 4, "", true);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["id"], "t0");
        let (none, _) = trace_page(&lines, 2, 9, "", true);
        assert!(none.is_empty());
    }

    #[test]
    fn trace_page_filters_by_kind_without_skipping_rows() {
        // 3 tools interleaved with llm/prompt rows.
        let lines = [
            r#"{"id":"a","kind":"tool"}"#,
            r#"{"id":"b","kind":"llm"}"#,
            r#"{"id":"c","kind":"tool"}"#,
            r#"{"id":"d","kind":"prompt"}"#,
            r#"{"id":"e","kind":"tool"}"#,
        ];
        // Newest tool page.
        let (page, counts) = trace_page(&lines, 2, 0, "tool", false);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["id"], "c");
        assert_eq!(page[1]["id"], "e");
        // Older tool page continues exactly where the first stopped.
        let (older, _) = trace_page(&lines, 2, 2, "tool", false);
        assert_eq!(older.len(), 1);
        assert_eq!(older[0]["id"], "a");
        // Counts stay whole-log regardless of the filter.
        assert_eq!(counts, [5, 1, 1, 3, 3, 0]);
    }

    /// The Tools tab mirrors the chat's cards: a sub-agent's own calls nest
    /// under its parent card, so they must not be paged into the top-level list
    /// (but a sub-agent trace view asks for them with `sub=true`).
    #[test]
    fn trace_page_excludes_sub_tools_unless_asked() {
        let lines = [
            r#"{"id":"top1","kind":"tool"}"#,
            r#"{"id":"deep","kind":"tool","detail":{"sub":true}}"#,
            r#"{"id":"top2","kind":"tool"}"#,
        ];
        let (page, counts) = trace_page(&lines, 10, 0, "tool", false);
        let ids: Vec<&str> = page.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["top1", "top2"]);
        assert_eq!(counts, [3, 0, 0, 3, 2, 0]);
        assert_eq!(matching_total(&counts, "tool", false), 2);
        assert_eq!(matching_total(&counts, "tool", true), 3);
        // A sub-agent's own trace shows everything.
        let (all, _) = trace_page(&lines, 10, 0, "tool", true);
        assert_eq!(all.len(), 3);
        // The All tab is never filtered by `sub`.
        let (everything, _) = trace_page(&lines, 10, 0, "", false);
        assert_eq!(everything.len(), 3);
    }

    #[test]
    fn trace_page_counts_kinds_across_the_whole_log() {
        let lines = [
            r#"{"kind":"llm"}"#,
            r#"{"kind":"prompt"}"#,
            r#"{"kind":"tool"}"#,
            r#"{"kind":"tool"}"#,
            "not json",
        ];
        let (page, counts) = trace_page(&lines, 10, 0, "", true);
        assert_eq!(counts, [4, 1, 1, 2, 2, 0]);
        assert_eq!(page.len(), 4);
        // A torn/unparsable line is skipped, not counted.
        assert_eq!(counts[0], 4);
    }

    /// A `fold` row is its own kind: it must be counted, paged on its own tab,
    /// and — crucially — `matching_total` must know it, or "load older" would
    /// stop after the first page of folds.
    #[test]
    fn trace_page_counts_and_pages_fold_rows() {
        let lines = [
            r#"{"kind":"llm"}"#,
            r#"{"kind":"fold"}"#,
            r#"{"kind":"tool"}"#,
            r#"{"kind":"fold"}"#,
        ];
        let (all, counts) = trace_page(&lines, 10, 0, "", true);
        assert_eq!(counts, [4, 1, 0, 1, 1, 2]);
        assert_eq!(all.len(), 4);
        assert_eq!(matching_total(&counts, "fold", false), 2);
        let (folds, _) = trace_page(&lines, 1, 0, "fold", false);
        assert_eq!(folds.len(), 1);
    }

    /// A runaway trace log is trimmed from the OLDEST end, keeping whole lines
    /// so the rewritten file is still valid JSONL.
    #[test]
    fn trim_oversized_keeps_the_newest_whole_lines() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-trace-trim-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.jsonl");
        // 10 rows of ~20 bytes each.
        let mut text = String::new();
        for i in 0..10 {
            text.push_str(&format!(r#"{{"id":"t{i}","kind":"tool"}}"#));
            text.push('\n');
        }
        std::fs::write(&path, &text).unwrap();

        // Cap 100 bytes, keep 60: the newest lines that fit survive.
        assert!(trim_oversized_with(&path, 100, 60));
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.len() <= 60);
        assert!(after.ends_with('\n'));
        for line in after.lines() {
            let v: Value = serde_json::from_str(line).expect("whole lines only");
            assert!(v["id"].is_string());
        }
        // The newest entry is always kept (the panel reads it first).
        assert!(after.contains(r#""t9""#), "newest entry survived: {after}");
        assert!(!after.contains(r#""t0""#), "oldest entry dropped: {after}");

        // Under the cap: untouched.
        assert!(!trim_oversized_with(&path, 1_000_000, 600_000));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_and_read_roundtrip() {
        // Use a unique chat id per run instead of touching the process-global
        // CODER_DATA_DIR (parallel tests read it — mutating it races).
        let chat = format!("trace-test-{}", std::process::id());
        // Serialize with the memory tests: CODER_DATA_DIR is process-global
        // (set_var races with parallel tests that also mutate it). Reuse the
        // memory tests' lock — two separate locks would deadlock (test A holds
        // its lock while waiting for the env, test B holds the env).
        let _env = crate::memory::tests::DATA_DIR_LOCK.lock();
        // The store resolves CODER_DATA_DIR lazily on every record/read, so
        // the env var must be set BEFORE the first record call. Other tests
        // (memory) also set it — always overwrite with our own temp dir and
        // restore afterwards to keep the parallel suite deterministic.
        let prev = std::env::var("CODER_DATA_DIR").ok();
        let tmp = std::env::temp_dir().join(format!("codifa-trace-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::env::set_var("CODER_DATA_DIR", &tmp);
        let store = TraceStore::new(chat.clone());
        store.record(TraceEntry {
            kind: "llm".into(),
            summary: "m · 10 tokens".into(),
            model: Some("m".into()),
            tokens: Some(Tokens {
                input: 7,
                output: 3,
                cache_read: 4,
                cache_write: 0,
                cache_read_reported: true,
                cache_write_reported: false,
                total: 10,
            }),
            ..Default::default()
        });
        store.record(TraceEntry {
            kind: "tool".into(),
            summary: "grep".into(),
            result: Some("3 matches".into()),
            ..Default::default()
        });
        let dir = traces_dir().expect("CODER_DATA_DIR set above");
        let path = dir.join(format!("{chat}.jsonl"));
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["kind"], "llm");
        assert_eq!(first["tokens"]["total"], 10);
        assert_eq!(first["tokens"]["cache_read"], 4);
        std::fs::remove_file(&path).ok();
        // Restore the previous env so parallel tests are unaffected.
        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
    }

    #[test]
    fn record_stamps_the_run_id_that_owns_the_row() {
        // Concurrent explore siblings share the parent's chat id, so they all
        // write into ONE trace file and their rows interleave. `run` is the only
        // field that keeps them apart, so it must survive into the JSONL.
        let chat = format!("trace-run-test-{}", std::process::id());
        let _env = crate::memory::tests::DATA_DIR_LOCK.lock();
        let prev = std::env::var("CODER_DATA_DIR").ok();
        let tmp = std::env::temp_dir().join(format!("codifa-trace-run-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::env::set_var("CODER_DATA_DIR", &tmp);

        let store = TraceStore::new(chat.clone()).with_run(42);
        assert_eq!(store.run_id(), 42);
        store.record(TraceEntry {
            kind: "llm".into(),
            summary: "m · 1 tokens".into(),
            ..Default::default()
        });
        // An unstamped store still writes a row, and says so with 0.
        TraceStore::new(chat.clone()).record(TraceEntry {
            kind: "llm".into(),
            summary: "m · 1 tokens".into(),
            ..Default::default()
        });

        let dir = traces_dir().expect("CODER_DATA_DIR set above");
        let path = dir.join(format!("{chat}.jsonl"));
        let content = std::fs::read_to_string(&path).unwrap();
        let rows: Vec<Value> = content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["run"], 42);
        assert_eq!(rows[1]["run"], 0);
        std::fs::remove_file(&path).ok();
        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
    }
