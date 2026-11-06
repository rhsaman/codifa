    use super::*;

    fn isolated(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-mem-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("CODER_DATA_DIR", &dir);
        dir
    }

    /// Serialize tests that mutate CODER_DATA_DIR (set_var is process-global
    /// and parallel tests would otherwise race on the shared env). Public so
    /// the trace tests (which also mutate the env) share the same lock —
    /// two separate locks would deadlock.
    pub(crate) static DATA_DIR_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn add_dedupes_and_searches() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("dedup");
        assert_eq!(add("uses uv add for python packages", "long_term", "/w")["ok"], json!(true));
        // Near-duplicate: the new note's normalized text is a substring of an
        // existing note in the same project (same direction as Python).
        let dup = add("uses uv add for python", "long_term", "/w");
        assert_eq!(dup["skipped"], json!("duplicate"));
        // Different project is a separate note.
        assert_eq!(add("uses uv add for python packages", "long_term", "/other")["ok"], json!(true));

        let hits = search("python packages", "/w", 15);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["score"], json!(0.9));
        assert_eq!(hits[0]["project_id"], json!("/w"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_and_unknown_type_are_handled() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("types");
        assert!(add("   ", "long_term", "/w").get("error").is_some());
        // Unknown type falls back to long_term.
        let rec = add("note about rust", "bogus", "/w");
        assert_eq!(rec["ok"], json!(true));
        let hits = search("rust", "/w", 15);
        assert_eq!(hits[0]["memory_type"], json!("long_term"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_truncates_on_char_boundary() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("utf8");
        // Multi-byte Persian text longer than MAX_CONTENT must not panic.
        let long_fa = "مهاجرت به تائوری".repeat(400);
        let rec = add(&long_fa, "long_term", "/w");
        assert_eq!(rec["ok"], json!(true));
        let hits = search("مهاجرت", "/w", 15);
        assert_eq!(hits.len(), 1);
        let stored = hits[0]["content"].as_str().unwrap();
        assert!(stored.chars().count() <= MAX_CONTENT + 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_removes_only_target() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("delete");
        add("alpha note", "long_term", "/w");
        let rec = add("beta note", "long_term", "/w");
        let mid = rec["memory"].as_str().unwrap().to_string();
        assert!(delete(&mid));
        assert!(!delete(&mid));
        let hits = search("note", "/w", 15);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["content"], json!("alpha note"));
        let _ = fs::remove_dir_all(dir);
    }
