    use super::*;
    use std::fs;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-appstate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn build_prompt_requires_parallel_explore_calls() {
        // The main agent's own lookups are TARGETED only (read/grep/find_symbol
        // /lsp_symbols — never glob), so the prompt must name the real tool
        // (`explore`) and demand several calls in ONE step — the old text
        // pointed at a non-existent `task(subagent_type=...)` tool.
        let prompts = system_prompts();
        let build = prompts["build"].as_str().unwrap();
        assert!(build.contains("`explore`"), "{build}");
        assert!(build.contains("SEVERAL `explore` calls"), "{build}");
        assert!(!build.contains("subagent_type"), "{build}");
        // Targeted locate-by-symbol must be the FIRST step named for the main
        // agent: it is what removes the line-hunting reads (measured 376 extra
        // same-file reads, 763K tokens) and the grep→read round pairs.
        assert!(build.contains("`find_symbol`"), "{build}");
        assert!(build.contains("`lsp_symbols`"), "{build}");
        // Legacy alias must carry the same research contract (old servers
        // answer with the alias keys only).
        let legacy = prompts["codewriter"].as_str().unwrap();
        assert!(legacy.contains("SEVERAL `explore` calls"), "{legacy}");
        assert!(!legacy.contains("subagent_type"), "{legacy}");
        // The dev / live-testing rule is a GENERIC cross-project rule, and the
        // build prompt and its legacy alias are two INDEPENDENT literals: a
        // drift between them would silently drop the rule for whoever resolves
        // the other key, so both must carry it.
        assert!(build.contains("DEV / LIVE TESTING"), "{build}");
        assert!(legacy.contains("DEV / LIVE TESTING"), "{legacy}");
        // The round-trip rule is the same kind of cross-cutting instruction, and
        // it exists for a measured reason: on a real trace 77% of main-agent
        // steps carried a SINGLE tool call (306 of 396) — 125 of them a lone
        // `run_terminal` — and every extra step re-sends the whole conversation
        // (~73K prompt tokens on those turns). One step can carry several
        // mutating calls (they run in order), so the waste is avoidable.
        assert!(build.contains("ROUND TRIPS"), "{build}");
        assert!(legacy.contains("ROUND TRIPS"), "{legacy}");
        // Every other prompt that can reach the model (the ask/plan/chat
        // aliases) must name the real tool too: `task(subagent_type=…)` does
        // not exist, so a prompt naming it made the model call a tool the
        // loop can only reject.
        for key in ["ask", "plan", "chat"] {
            let p = prompts[key].as_str().unwrap();
            assert!(!p.contains("subagent_type"), "{key} names subagent_type: {p}");
            assert!(!p.contains("task("), "{key} names task(: {p}");
        }
    }

    #[test]
    fn settings_roundtrip_and_skeleton_guard() {
        let root = tmp_root("settings");
        // A real settings write lands on disk.
        let real = json!({"theme": "latte", "providers": []});
        save_state(&root, StateSaveBody {
            settings: Some(real.clone()), chats: None, deleted_chats: None, deleted_workspaces: None,
        });
        assert_eq!(read_json(&root.join("settings.json")).unwrap(), real);
        // A later cold-start skeleton must NOT clobber it (archived instead).
        let skeleton = json!({"providers": [], "root": ""});
        save_state(&root, StateSaveBody {
            settings: Some(skeleton), chats: None, deleted_chats: None, deleted_workspaces: None,
        });
        assert_eq!(read_json(&root.join("settings.json")).unwrap(), real);
        assert!(root.join("settings.json.bak").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chats_save_dedupe_and_delete_cleanup() {
        let root = tmp_root("chats");
        let chat = json!({"id": "c1", "root": "/tmp/ws", "updatedAt": 100.0});
        save_state(&root, StateSaveBody {
            settings: None, chats: Some(vec![chat.clone()]), deleted_chats: None, deleted_workspaces: None,
        });
        let state = get_state(&root);
        assert_eq!(state["chats"].as_array().unwrap().len(), 1);
        assert_eq!(state["chats"][0]["id"], "c1");
        // Deleting the chat removes the file, its traces and its checkpoints.
        fs::create_dir_all(root.join("traces")).unwrap();
        fs::write(root.join("traces").join("c1.jsonl"), "{}").unwrap();
        save_state(&root, StateSaveBody {
            settings: None, chats: None, deleted_chats: Some(vec!["c1".into()]), deleted_workspaces: None,
        });
        assert_eq!(get_state(&root)["chats"].as_array().unwrap().len(), 0);
        assert!(!root.join("traces").join("c1.jsonl").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn checkpoint_restore_roundtrip() {
        let root = tmp_root("ckpt");
        let ws = root.join("ws");
        fs::create_dir_all(&ws).unwrap();
        // Build a checkpoint by hand in the sidecar's layout.
        let seq_dir = root.join("checkpoints").join("c1").join("000001");
        fs::create_dir_all(seq_dir.join("blobs")).unwrap();
        fs::write(seq_dir.join("blobs").join("abc"), "old content").unwrap();
        fs::write(
            seq_dir.join("manifest.json"),
            json!({"seq": 1, "created": 1.0, "files": [
                {"path": "a.txt", "existed": true, "sha256": "abc"},
                {"path": "gone.txt", "existed": false}
            ]}).to_string(),
        ).unwrap();
        // Current disk state differs from the snapshot.
        fs::write(ws.join("a.txt"), "changed on disk").unwrap();
        fs::write(ws.join("gone.txt"), "to be removed").unwrap();

        let listed = list_checkpoints(&root, "c1");
        assert_eq!(listed["checkpoints"][0]["seq"], 1);

        let out = restore_checkpoint(&root, "c1", 1, ws.to_str().unwrap()).unwrap();
        let restored = out["restored"].as_array().unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[0]["changed"], json!(true)); // disk differed from blob
        assert_eq!(fs::read_to_string(ws.join("a.txt")).unwrap(), "old content");
        assert!(!ws.join("gone.txt").exists()); // restore of a new file = delete
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn schedules_crud_and_runs() {
        let root = tmp_root("sched");
        let saved = save_schedule(&root, json!({"name": "nightly", "cron": "0 3 * * *"})).unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("sch-"));
        assert_eq!(list_schedules(&root).as_array().unwrap().len(), 1);
        // A run for a live schedule is listed; deleting the schedule orphans it.
        let run_file = schedule_run_file(&root, "run-1");
        atomic_write_json(&run_file, &json!({"id": "run-1", "schedule_id": id, "started_at": 1.0})).unwrap();
        assert_eq!(list_schedule_runs(&root, &id, 50, 0.0).as_array().unwrap().len(), 1);
        assert_eq!(delete_schedule(&root, &id)["ok"], json!(true));
        let out = delete_orphan_schedule_runs(&root);
        assert_eq!(out["removed"], json!(1));
        assert!(!run_file.exists());
        let _ = fs::remove_dir_all(&root);
    }
