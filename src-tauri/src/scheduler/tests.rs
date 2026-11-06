    use super::*;

    #[test]
    fn scheduled_auto_fetch_reads_the_settings_number() {
        // A missing key (an older settings.json) falls back to the default
        // the UI starts at.
        assert_eq!(
            web_search_auto_fetch_of(&json!({})),
            crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
        );
        // The user's number is honoured verbatim…
        assert_eq!(web_search_auto_fetch_of(&json!({"webSearchAutoFetch": 8})), 8);
        // …and 0 is MEANINGFUL ("snippets only"), never replaced by the default.
        assert_eq!(web_search_auto_fetch_of(&json!({"webSearchAutoFetch": 0})), 0);
    }

    #[test]
    fn orphan_sweep_min_age_zero_closes_fresh_running_rows() {
        let tmp = std::env::temp_dir().join(format!("sched-orphan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        save_run(
            &tmp,
            &json!({"id": "run-orph-1", "schedule_id": "sch-x", "status": "running",
                    "output": "", "started_at": now_secs()}),
        );
        save_run(
            &tmp,
            &json!({"id": "run-orph-2", "schedule_id": "sch-x", "status": "done",
                    "output": "", "started_at": now_secs()}),
        );
        // A live long job is never touched by the periodic sweep.
        assert_eq!(mark_orphaned_running(&tmp, ORPHAN_AFTER_SECS), 0);
        // Startup sweep: the fresh "running" row is leftovers of a dead
        // process — closed even though it is seconds old.
        assert_eq!(mark_orphaned_running(&tmp, 0.0), 1);
        let rows = list_runs(&tmp, "", 10);
        let run = rows.iter().find(|r| r["id"] == "run-orph-1").unwrap();
        assert_eq!(run["status"], "error");
        assert_eq!(run["error"], "interrupted (app restarted)");
        // Settled rows are never re-touched.
        assert_eq!(mark_orphaned_running(&tmp, 0.0), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cron_next_run_matches_python_semantics() {
        let off = local_utc_offset_secs();
        // Every minute: next after 00:00:30 is 00:01:00.
        let n = next_run_after("* * * * *", 0.0, off).unwrap();
        assert_eq!(n, 60.0);
        // Daily at 09:00 BY THE WALL CLOCK: from 00:00:30 the next fire is
        // today 09:00 local, whichever zone the host runs in.
        let n = next_run_after("0 9 * * *", 30.0, off).unwrap();
        use chrono::Timelike;
        let local = chrono::DateTime::from_timestamp(n as i64 + off as i64, 0).unwrap();
        assert_eq!(local.hour(), 9);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.second(), 0);
        assert!(n > 30.0);
        // Once (empty cron) → None.
        assert_eq!(next_run_after("", 0.0, off), None);
        // Invalid field count → None.
        assert_eq!(next_run_after("0 9 * *", 0.0, off), None);
    }

    #[test]
    fn plugin_context_lists_scripts_but_skips_disabled() {
        let tmp = std::env::temp_dir().join(format!("sched-plug-test-{}", std::process::id()));
        let plug = tmp.join("plugins/demo");
        let off_plug = tmp.join("plugins/off-demo");
        for dir in [
            plug.join("scripts/cleanup"),
            off_plug.join("scripts/ghost"),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
        }
        std::fs::write(plug.join("plugin.json"), r#"{"name":"Demo","enabled":true}"#).unwrap();
        std::fs::write(
            plug.join("scripts/cleanup/script.json"),
            r#"{"name":"cleanup","language":"rust","description":"wipe temp files"}"#,
        )
        .unwrap();
        std::fs::write(
            off_plug.join("plugin.json"),
            r#"{"name":"Off","enabled":false}"#,
        )
        .unwrap();
        let all = vec!["demo".to_string(), "off-demo".to_string()];
        // The enabled bundle shows up with every script it carries.
        let on = plugin_context_block(&tmp, &all[..1]);
        assert!(on.contains("PLUGIN TOOLS"), "{on}");
        assert!(on.contains("demo") && on.contains("[rust]") && on.contains("cleanup"), "{on}");
        // A switched-off bundle contributes nothing — the toggle is the truth.
        let disabled = plugin_context_block(&tmp, &all[1..]);
        assert!(disabled.is_empty(), "{disabled}");
        // No plugins at all → no block.
        let none: Vec<String> = Vec::new();
        assert!(plugin_context_block(&tmp, &none).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stop_signals_live_runs_and_settles_stale_rows() {
        let tmp = std::env::temp_dir().join(format!("sched-stop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let _live = register_live_run("sch-stop", &flag);
            assert_eq!(stop_schedule(&tmp, "sch-stop"), 1);
            assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
        }
        // The guard is gone: no live run, so a stored "running" row is a
        // leftover and gets settled instead of spinning forever.
        save_run(
            &tmp,
            &json!({"id": "run-stop-1", "schedule_id": "sch-stop", "status": "running",
                    "output": "", "started_at": now_secs()}),
        );
        assert_eq!(stop_schedule(&tmp, "sch-stop"), 1);
        let rows = list_runs(&tmp, "sch-stop", 10);
        assert_eq!(rows[0]["status"], "error");
        assert_eq!(rows[0]["error"], "stopped by user");
        assert_eq!(stop_schedule(&tmp, "sch-stop"), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn is_due_semantics() {
        let now = 1_000_000.0;
        // Recurring, next_run inside grace → due.
        let t = json!({"enabled": true, "cron": "* * * * *", "next_run": now - 30.0});
        assert!(is_due(&t, now));
        // Stale next_run (older than grace) → not due (healed by the loop).
        let t = json!({"enabled": true, "cron": "* * * * *", "next_run": now - 3600.0});
        assert!(!is_due(&t, now));
        // Future next_run → not due.
        let t = json!({"enabled": true, "cron": "* * * * *", "next_run": now + 60.0});
        assert!(!is_due(&t, now));
        // Once, never ran → due.
        let t = json!({"enabled": true, "cron": ""});
        assert!(is_due(&t, now));
        // Once, already ran → never due.
        let t = json!({"enabled": true, "cron": "", "last_run": now - 10.0});
        assert!(!is_due(&t, now));
        // Disabled → never due.
        let t = json!({"enabled": false, "cron": "* * * * *", "next_run": now - 30.0});
        assert!(!is_due(&t, now));
    }

    #[test]
    fn compute_next_run_no_catchup() {
        // last_run far in the past (paused period): next is computed from NOW,
        // not from last_run — no burst of missed runs.
        let now = 1_000_000.0;
        let t = json!({"enabled": true, "cron": "* * * * *", "last_run": 100.0});
        let n = compute_next_run(&t, now).unwrap();
        let expected = ((now as i64) / 60 + 1) * 60;
        assert_eq!(n, expected as f64);
    }

    #[test]
    fn tool_fallback_map_accepts_both_persisted_shapes() {
        // The Tools row persists OBJECTS (`{providerId, model}`); the
        // interactive turn sends STRINGS. A headless run reads the file
        // directly, so the map must speak both — otherwise every object row
        // was silently dropped and the schedule's chain ran its own model
        // with NO fallbacks.
        let settings = json!({
            "toolFallbacks": {
                "schedule": [
                    {"providerId": "custom-mvchoxmp", "model": "oc/deepseek-v4.1-flash-free"},
                    {"providerId": "", "model": ""},
                    {"providerId": "", "model": "orphan-model"},
                    {"providerId": "google", "model": ""},
                    "",
                    "legacy/bare-model"
                ],
                "vision": [
                    {"providerId": "nvidia", "model": "minimaxai/minimax-m3.1-flash"}
                ]
            }
        });
        let map = string_list_map(&settings, "toolFallbacks");
        assert_eq!(
            map.get("schedule").map(Vec::as_slice),
            Some(
                &[
                    // A fully-named row → the wire string the resolver splits.
                    "custom-mvchoxmp/oc/deepseek-v4.1-flash-free".to_string(),
                    // A row naming nothing → the composer's own model, by NAME.
                    "main model".to_string(),
                    // A legacy string row passes through verbatim.
                    "legacy/bare-model".to_string(),
                ][..]
            )
        );
        // Half-filled rows (a provider without a model or the reverse) and
        // empty strings are unroutable → dropped, in the middle of the list.
        assert_eq!(
            map.get("vision").map(Vec::as_slice),
            Some(&["nvidia/minimaxai/minimax-m3.1-flash".to_string()][..])
        );
        // An absent key contributes nothing at all.
        assert!(!map.contains_key("explore"));
    }
