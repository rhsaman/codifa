    use super::*;
    use std::fs;
    use std::time::UNIX_EPOCH;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("codifa-retention-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn backdate(path: &std::path::Path, days: u64) {
        let old = UNIX_EPOCH
            + Duration::from_secs(
                now().duration_since(UNIX_EPOCH).unwrap().as_secs().saturating_sub(days * 24 * 3600),
            );
        // std::fs::FileTimes (Rust 1.75+) — no extra dependency needed.
        let f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
    }

    #[test]
    fn sweep_removes_only_stale_files() {
        let dir = tmp_dir("files");
        let fresh = dir.join("fresh.jsonl");
        let stale = dir.join("stale.jsonl");
        fs::write(&fresh, "x").unwrap();
        fs::write(&stale, "x").unwrap();
        backdate(&stale, 20);

        let removed = sweep_files(&dir, Duration::from_secs(14 * 24 * 3600));
        assert_eq!(removed, 1);
        assert!(fresh.exists());
        assert!(!stale.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_checkpoint_chats_uses_newest_seq() {
        let dir = tmp_dir("ckpt");
        // Chat A: one old seq dir -> removed. Chat B: old + fresh seq -> kept.
        let a = dir.join("chat-a").join("000001");
        let b_old = dir.join("chat-b").join("000001");
        let b_new = dir.join("chat-b").join("000002");
        for p in [&a, &b_old, &b_new] {
            fs::create_dir_all(p).unwrap();
            fs::write(p.join("manifest.json"), "{}").unwrap();
        }
        backdate(&a.join("manifest.json"), 20);
        backdate(&b_old.join("manifest.json"), 20);

        let removed = sweep_checkpoint_chats(&dir, Duration::from_secs(14 * 24 * 3600));
        assert_eq!(removed, 1);
        assert!(!dir.join("chat-a").exists());
        assert!(dir.join("chat-b").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_missing_dirs_is_noop() {
        let root = tmp_dir("missing");
        let summary = run_sweep(&root);
        assert!(summary.contains("0 trace files"));
        fs::remove_dir_all(&root).ok();
    }

    /// The sweep must also shrink an oversized log, not just delete old files:
    /// a log written before the byte cap existed has to be repaired on disk.
    #[test]
    fn sweep_trims_an_oversized_trace_log() {
        let root = tmp_dir("trim");
        let traces = root.join("traces");
        fs::create_dir_all(&traces).unwrap();
        let log = traces.join("chat.jsonl");
        // Comfortably past the cap.
        let row = format!(r#"{{"id":"x","kind":"prompt","prompt":"{}"}}"#, "y".repeat(400));
        let mut text = String::new();
        for _ in 0..30_000 {
            text.push_str(&row);
            text.push('\n');
        }
        fs::write(&log, &text).unwrap();
        assert!(fs::metadata(&log).unwrap().len() > crate::trace::TRACE_MAX_BYTES);

        let summary = run_sweep(&root);
        assert!(summary.contains("0 trace files"), "fresh file is not expired: {summary}");
        assert!(
            fs::metadata(&log).unwrap().len() <= crate::trace::TRACE_KEEP_BYTES,
            "log trimmed under the keep budget"
        );
        fs::remove_dir_all(&root).ok();
    }

    /// A chat that is snapshotted but never restored must still be bounded.
    ///
    /// The TTL alone could not do it: staleness is measured from the NEWEST file
    /// under a chat dir, so one recently touched blob kept every older snapshot
    /// alive. Measured on a real data root, 223.8 MB across 2690 files survived
    /// 18 days of sweeps that way.
    #[test]
    fn checkpoint_cap_bounds_every_chat() {
        let dir = tmp_dir("ckptcap");
        // One chat with far more snapshots than the per-chat cap allows.
        let over = CHECKPOINT_SEQS_PER_CHAT + 7;
        for seq in 0..over {
            let seq_dir = dir.join("chat-a").join(format!("{seq:06}"));
            fs::create_dir_all(&seq_dir).unwrap();
            fs::write(seq_dir.join("manifest.json"), "{}").unwrap();
        }

        let (removed, _freed) = cap_checkpoints(&dir);
        assert_eq!(removed, 7, "only the excess snapshots are dropped");
        let left = fs::read_dir(dir.join("chat-a")).unwrap().count();
        assert_eq!(left, CHECKPOINT_SEQS_PER_CHAT);
        // The cap keeps the NEWEST snapshots: recent undo history is the point.
        assert!(dir.join("chat-a").join(format!("{:06}", over - 1)).is_dir());
        assert!(!dir.join("chat-a").join("000000").exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// A small tree is left completely alone (the byte ceiling must not be a
    /// tax on every sweep).
    #[test]
    fn checkpoint_cap_keeps_a_small_tree() {
        let dir = tmp_dir("ckptsmall");
        for seq in 0..3 {
            let seq_dir = dir.join("chat-a").join(format!("{seq:06}"));
            fs::create_dir_all(&seq_dir).unwrap();
            fs::write(seq_dir.join("manifest.json"), "{}").unwrap();
        }
        assert_eq!(cap_checkpoints(&dir), (0, 0));
        assert_eq!(fs::read_dir(dir.join("chat-a")).unwrap().count(), 3);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tmp_debris_pattern_matches_the_atomic_writers() {
        assert!(is_tmp_debris("chat.json.tmp13577.1792931075714508000"));
        assert!(is_tmp_debris("plan.md.tmp123-7"));
        assert!(!is_tmp_debris("report.tmp")); // a user file, no digit after .tmp
        assert!(!is_tmp_debris("template.json"));
        assert!(!is_tmp_debris("chat.json"));
    }

    #[test]
    fn sweep_tmp_files_removes_only_stale_debris() {
        let root = tmp_dir("tmpdebris");
        let chats = root.join("chats").join("ws-1");
        fs::create_dir_all(&chats).unwrap();
        let debris = chats.join("chat.json.tmp999.111");
        let fresh = chats.join("fresh.json.tmp999.222");
        let user = chats.join("report.tmp");
        for p in [&debris, &fresh, &user] {
            fs::write(p, "x").unwrap();
        }
        backdate(&debris, 2);
        // browser-profile is skipped outright: Chromium owns its contents.
        let profile = root.join("browser-profile").join("cache");
        fs::create_dir_all(&profile).unwrap();
        let profile_debris = profile.join("x.json.tmp1.1");
        fs::write(&profile_debris, "x").unwrap();
        backdate(&profile_debris, 2);

        let removed = sweep_stale_tmp_files(&root, Duration::from_secs(24 * 3600));
        assert_eq!(removed, 1);
        assert!(!debris.exists());
        assert!(fresh.exists());
        assert!(user.exists());
        assert!(profile_debris.exists());
        fs::remove_dir_all(&root).ok();
    }

    /// Fixture: settings.json naming two live chats and one dead workspace.
    fn live_index_fixture(root: &std::path::Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"chats":[
                {"id":"mv1-live","dir":"chats/ws-live/mv1-live.json"},
                {"id":"mv2-live","dir":"chats/ws-live/mv2-live.json"}
            ]}"#,
        )
        .unwrap();
    }

    #[test]
    fn orphan_bodies_removed_but_live_chats_and_fresh_files_kept() {
        let root = tmp_dir("orphanbodies");
        live_index_fixture(&root);
        let chats = root.join("chats");
        let live = chats.join("ws-live").join("mv1-live.json");
        // Same id, different dir than the row's `dir` — id match keeps it.
        let live_rel = chats.join("ws-other").join("mv2-live.json");
        let orphan = chats.join("ws-old").join("mv-dead.json");
        for p in [&live, &live_rel, &orphan] {
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "{}").unwrap();
        }
        backdate(&orphan, 2);

        let idx = read_live_index(&root).expect("index reads");
        let removed = sweep_orphan_chat_bodies(&root, &idx, Duration::from_secs(24 * 3600));
        assert_eq!(removed, 1);
        assert!(live.exists());
        assert!(live_rel.exists());
        assert!(!orphan.exists());
        // The emptied ws-old dir is reclaimed; the live dirs stay.
        assert!(!chats.join("ws-old").exists());
        assert!(chats.join("ws-live").exists());
        fs::remove_dir_all(&root).ok();
    }

    /// A body can be written a beat before its index row lands: a FRESH file
    /// whose id is not in the index yet must survive the grace window.
    #[test]
    fn orphan_sweep_grace_protects_a_fresh_unindexed_body() {
        let root = tmp_dir("orphangrace");
        live_index_fixture(&root);
        let chats = root.join("chats").join("ws-live").join("mv-inflight.json");
        fs::create_dir_all(chats.parent().unwrap()).unwrap();
        fs::write(&chats, "{}").unwrap();

        let idx = read_live_index(&root).expect("index reads");
        let removed = sweep_orphan_chat_bodies(&root, &idx, Duration::from_secs(24 * 3600));
        assert_eq!(removed, 0);
        assert!(chats.exists());
        fs::remove_dir_all(&root).ok();
    }

    /// No readable `chats` array: the orphan sweeps must be skipped entirely,
    /// never treat "unknown index" as "nothing is live".
    #[test]
    fn orphan_sweeps_skip_on_unreadable_index() {
        let root = tmp_dir("orphanskips");
        fs::create_dir_all(root.join("chats").join("ws")).unwrap();
        let body = root.join("chats").join("ws").join("mv1.json");
        fs::write(&body, "{}").unwrap();
        // Corrupt document.
        fs::write(root.join("settings.json"), "{ not json").unwrap();
        assert!(read_live_index(&root).is_none());
        // run_sweep on the same root must not delete the body either.
        let summary = run_sweep(&root);
        assert!(body.exists(), "corrupt index must not age out bodies: {summary}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn orphan_plans_and_chat_dirs_removed_after_grace() {
        let root = tmp_dir("orphandirs");
        live_index_fixture(&root);
        let live_plan = root.join("plan").join("ws-live").join("mv1-live");
        let dead_plan = root.join("plan").join("ws-old").join("mv-dead");
        let live_media = root.join("media").join("mv1-live");
        let dead_media = root.join("media").join("mv-dead");
        let dead_artifact = root.join("artifacts").join("mv-dead");
        for p in [&live_plan, &dead_plan, &live_media, &dead_media, &dead_artifact] {
            fs::create_dir_all(p).unwrap();
            fs::write(p.join("data.txt"), "x").unwrap();
        }
        backdate(&dead_plan.join("data.txt"), 2);
        backdate(&dead_media.join("data.txt"), 2);
        backdate(&dead_artifact.join("data.txt"), 2);

        let idx = read_live_index(&root).expect("index reads");
        let grace = Duration::from_secs(24 * 3600);
        let plans = sweep_orphan_plans(&root, &idx, grace);
        let dirs = sweep_orphan_chat_dirs(&root, "media", &idx, grace)
            + sweep_orphan_chat_dirs(&root, "artifacts", &idx, grace);
        assert_eq!(plans, 1);
        assert_eq!(dirs, 2);
        assert!(live_plan.exists());
        assert!(!dead_plan.exists());
        assert!(live_media.exists());
        assert!(!dead_media.exists());
        assert!(!dead_artifact.exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn old_browsers_sweep_keeps_the_newest_rank() {
        let root = tmp_dir("browsers");
        let browser = root.join("browser");
        let old = browser.join("chrome-for-testing-140.0.7339.82");
        let new = browser.join("chrome-for-testing-156.0.8078.80");
        let other = browser.join("unrelated");
        for p in [&old, &new, &other] {
            fs::create_dir_all(p).unwrap();
            fs::write(p.join("binary"), "x").unwrap();
        }
        backdate(&old.join("binary"), 2);
        backdate(&new.join("binary"), 2);
        backdate(&other.join("binary"), 2);

        let removed =
            sweep_old_browsers(&root, Duration::from_secs(24 * 3600));
        assert_eq!(removed, 1);
        assert!(new.exists(), "the build the app would launch survives");
        assert!(!old.exists());
        assert!(other.exists(), "non-chrome dirs are untouched");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dead_dirs_removed_only_when_empty() {
        let root = tmp_dir("dead");
        fs::create_dir_all(root.join("checkpoints")).unwrap();
        fs::create_dir_all(root.join("vector-db")).unwrap();
        assert_eq!(sweep_dead_dirs(&root), 2);
        assert!(!root.join("checkpoints").exists());
        assert!(!root.join("vector-db").exists());

        // Legacy checkpoints content still ages out first.
        let legacy = root.join("checkpoints").join("chat").join("000001");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("manifest.json"), "{}").unwrap();
        assert_eq!(sweep_dead_dirs(&root), 0);
        assert!(root.join("checkpoints").exists());
        fs::remove_dir_all(&root).ok();
    }

    /// TTL sweeps for the terminal logs / schedule runs / marketplace caches.
    #[test]
    fn ttl_sweeps_cover_the_new_trees() {
        let root = tmp_dir("ttls");
        let term = root.join("terminal-logs");
        let runs = root.join("schedules").join("runs");
        let cache = root.join("cache");
        for d in [&term, &runs, &cache] {
            fs::create_dir_all(d).unwrap();
        }
        let old_log = term.join("bg-old.log");
        let live_log = term.join("bg-live.log");
        let row = term.join("bg-old.json");
        let old_run = runs.join("run-1.json");
        let old_cache = cache.join("marketplace-abc.json");
        for p in [&old_log, &live_log, &row, &old_run, &old_cache] {
            fs::write(p, "x").unwrap();
        }
        backdate(&old_log, 8);
        backdate(&old_run, 31);
        backdate(&old_cache, 31);
        backdate(&row, 8);

        let term_ttl = Duration::from_secs(TERMINAL_LOG_TTL_DAYS * 24 * 3600);
        let run_ttl = Duration::from_secs(SCHEDULE_RUN_TTL_DAYS * 24 * 3600);
        let cache_ttl = Duration::from_secs(MARKETPLACE_TTL_DAYS * 24 * 3600);
        assert_eq!(sweep_files_ext(&term, term_ttl, "log"), 1);
        assert_eq!(sweep_files(&runs, run_ttl), 1);
        assert_eq!(sweep_files(&cache, cache_ttl), 1);
        assert!(!old_log.exists());
        assert!(live_log.exists(), "a live terminal's log is fresh");
        assert!(row.exists(), "row files belong to the terminal pruner, not this sweep");
        fs::remove_dir_all(&root).ok();
    }
