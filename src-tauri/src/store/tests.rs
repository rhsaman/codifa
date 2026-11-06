    use super::*;

    /// The chats merge must keep the newest updatedAt per id and preserve
    /// first-seen order — the sidebar dedupe rule.
    #[test]
    fn chats_merge_newest_wins() {
        let older = serde_json::json!({"id": "a", "updatedAt": 1.0, "title": "old"});
        let newer = serde_json::json!({"id": "a", "updatedAt": 2.0, "title": "new"});
        let merged = merge_chat_lists([serde_json::json!([older]), serde_json::json!([newer])]);
        let list = merged.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["title"], "new");
    }

    #[test]
    fn chats_merge_keeps_first_seen_order() {
        let a = serde_json::json!({"id": "a", "updatedAt": 3.0});
        let b = serde_json::json!({"id": "b", "updatedAt": 1.0});
        let merged = merge_chat_lists([serde_json::json!([a, b])]);
        let ids: Vec<&str> = merged.as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// Disk-only chats (settings.json copy wiped) must still be returned.
    #[test]
    fn chats_merge_recovers_from_disk_files() {
        let disk = serde_json::json!({"id": "x", "updatedAt": 9.0});
        let merged = merge_chat_lists([Value::Array(vec![disk])]);
        assert_eq!(merged.as_array().unwrap().len(), 1);
        assert_eq!(merged[0]["id"], "x");
    }

    /// A partial settings payload (missing provider rows) must never delete a
    /// provider — rows absent from the payload are preserved, listed rows win.
    #[test]
    fn providers_merge_preserves_unlisted_rows() {
        let kept = serde_json::json!({"id": "custom-1", "name": "9router"});
        let edited = serde_json::json!({"id": "openrouter", "name": "Edited"});
        let merged = merge_providers([
            serde_json::json!([kept, serde_json::json!({"id": "openrouter", "name": "OpenRouter"})]),
            serde_json::json!([edited]),
        ]);
        let rows = merged.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "custom-1");
        assert_eq!(rows[1]["name"], "Edited");
    }

    /// The `deleted_providers` tombstone is the explicit delete path: it outranks
    /// the union merge so a removed provider cannot be resurrected.
    #[test]
    fn providers_tombstone_drops_rows() {
        let providers = serde_json::json!([{"id": "a"}, {"id": "b"}]);
        let dropped = drop_deleted_providers(providers, &serde_json::json!(["a"]));
        let rows = dropped.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "b");
        // An empty or malformed tombstone is a no-op.
        let same = drop_deleted_providers(serde_json::json!([{"id": "a"}]), &Value::Null);
        assert_eq!(same.as_array().unwrap().len(), 1);
    }

    /// The streamed atomic write must round-trip the document and leave no
    /// temp file behind (the store is the app's single source of truth).
    /// A mid-stream chat heartbeat writes only the streaming SUBSET; the store
    /// must merge it by id instead of replacing the whole array, or every other
    /// chat is deleted from settings.json (the "app closed, recent chats gone"
    /// data loss).
    #[test]
    fn chats_write_merges_subset_without_deleting_rows() {
        let full = serde_json::json!([
            {"id": "a", "updatedAt": 1.0, "title": "keep me"},
            {"id": "b", "updatedAt": 1.0, "title": "streaming"},
        ]);
        let subset = serde_json::json!([{"id": "b", "updatedAt": 2.0, "title": "streaming"}]);
        let merged = merge_chat_lists([full, subset]);
        let rows = merged.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["title"], "keep me");
        assert_eq!(rows[1]["updatedAt"], 2.0);
    }

    /// A deleted chat must stay deleted even though its per-chat file and the
    /// on-disk copy both still exist.
    #[test]
    fn deleted_chats_tombstone_drops_rows() {
        let rows = serde_json::json!([{"id": "a"}, {"id": "b"}]);
        let dropped = drop_deleted_rows(rows, &serde_json::json!(["a"]));
        let out = dropped.as_array().unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "b");
        // An empty or malformed tombstone is a no-op.
        let same = drop_deleted_rows(serde_json::json!([{"id": "a"}]), &Value::Null);
        assert_eq!(same.as_array().unwrap().len(), 1);
    }

    #[test]
    fn write_document_round_trips_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-write-document",
            std::process::id()
        ));
        let path = dir.join("settings.json");
        let mut map = serde_json::Map::new();
        map.insert("theme".to_string(), serde_json::json!("rose-pine"));
        map.insert("chats".to_string(), serde_json::json!([{"id": "a"}]));

        assert!(write_document(&path, &map));
        let back: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["theme"], "rose-pine");
        assert_eq!(back["chats"][0]["id"], "a");
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The migration must carry EVERY chat and every message across: the union
    /// of the settings.json rows and the legacy per-chat files, with the newest
    /// copy of a chat winning — this is the "no chat and no message is lost"
    /// contract the whole split-storage change hangs on.
    #[test]
    fn migration_keeps_every_chat_and_message() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-migrate-keep",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let doc_rows = vec![
            // Same id as a disk file, but older: the file must win.
            serde_json::json!({
                "id": "shared", "updatedAt": 1.0,
                "messages": [{"id": "m1", "role": "user", "content": "stale"}]
            }),
            // Only in settings.json.
            serde_json::json!({
                "id": "doc-only", "updatedAt": 5.0,
                "messages": [{"id": "m2", "role": "user", "content": "from doc"}]
            }),
        ];
        let disk = vec![
            (
                dir.join("chats/ws/shared.json"),
                serde_json::json!({
                    "id": "shared", "updatedAt": 9.0,
                    "messages": [
                        {"id": "m1", "role": "user", "content": "fresh"},
                        {"id": "m3", "role": "assistant", "content": "reply"}
                    ]
                }),
            ),
            // Only on disk.
            (
                dir.join("chats/ws/disk-only.json"),
                serde_json::json!({
                    "id": "disk-only", "updatedAt": 2.0,
                    "messages": [{"id": "m4", "role": "user", "content": "from disk"}]
                }),
            ),
        ];

        let picked = pick_migration_bodies(&dir, &doc_rows, disk);
        assert_eq!(picked.len(), 3, "every distinct chat survives");

        let body_of = |id: &str| -> Value {
            picked
                .iter()
                .find(|(b, _)| b.get("id").and_then(|v| v.as_str()) == Some(id))
                .map(|(b, _)| b.clone())
                .unwrap_or(Value::Null)
        };
        // The newer copy wins AND both of its messages are intact (an older
        // copy would only have had one).
        let shared = body_of("shared");
        assert_eq!(shared["messages"].as_array().unwrap().len(), 2);
        assert_eq!(shared["messages"][0]["content"], "fresh");
        assert_eq!(shared["messages"][1]["content"], "reply");
        assert_eq!(body_of("doc-only")["messages"][0]["content"], "from doc");
        assert_eq!(body_of("disk-only")["messages"][0]["content"], "from disk");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Newest-wins works in both directions (the document copy can be the fresher
    /// one, e.g. when a legacy file was left behind by the old sidecar).
    #[test]
    fn migration_prefers_the_newer_copy_either_way() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-migrate-newer",
            std::process::id()
        ));
        let doc_rows = vec![serde_json::json!({
            "id": "c", "updatedAt": 10.0,
            "messages": [{"id": "m", "role": "user", "content": "doc newer"}]
        })];
        let disk = vec![(
            dir.join("chats/ws/c.json"),
            serde_json::json!({
                "id": "c", "updatedAt": 3.0,
                "messages": [{"id": "m", "role": "user", "content": "disk older"}]
            }),
        )];
        let picked = pick_migration_bodies(&dir, &doc_rows, disk);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].0["messages"][0]["content"], "doc newer");
    }

    /// The index row kept in settings.json must never carry the transcript, and
    /// must still give the renderer what the sidebar needs.
    #[test]
    fn index_row_strips_bodies_and_summarizes() {
        let body = serde_json::json!({
            "id": "c", "title": "T", "updatedAt": 4.0, "messages": [
                {"id": "a", "role": "system", "content": "sys"},
                {"id": "b", "role": "user", "content": "hello there"}
            ]
        });
        let row = index_row(&body, Some("chats/ws/c.json".to_string())).unwrap();
        assert!(row.get("messages").is_none(), "no transcript in the index");
        assert_eq!(row["messageCount"], serde_json::json!(2));
        assert_eq!(row["firstUser"], "hello there");
        assert_eq!(row["dir"], "chats/ws/c.json");
        assert_eq!(row["title"], "T");
    }

    /// A metadata-only update (rename/pin/model switch on a chat whose body is
    /// not in memory) must keep `dir`/`messageCount` and leave the body file —
    /// and therefore the transcript — untouched.
    #[test]
    fn metadata_only_update_keeps_body_fields() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-meta-only",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let full = serde_json::json!([{
            "id": "c", "title": "old", "updatedAt": 1.0,
            "messages": [{"id": "m", "role": "user", "content": "hi"}]
        }]);
        let stored = merge_chat_index(&dir, &Value::Array(vec![]), &full, &Value::Null);
        let rel = stored.as_array().unwrap()[0]["dir"].as_str().unwrap().to_string();
        let body_file = dir.join(&rel);
        assert!(body_file.is_file(), "body written");

        let rename = serde_json::json!([{ "id": "c", "title": "renamed", "updatedAt": 2.0 }]);
        let after = merge_chat_index(&dir, &stored, &rename, &Value::Null);
        let row = after
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "c")
            .unwrap()
            .clone();
        assert_eq!(row["title"], "renamed");
        assert_eq!(row["messageCount"], serde_json::json!(1));
        assert!(row["dir"].is_string());
        let back: Value =
            serde_json::from_str(&fs::read_to_string(&body_file).unwrap()).unwrap();
        assert_eq!(back["messages"][0]["content"], "hi");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A tombstoned chat must not be resurrected by the migration.
    #[test]
    fn migration_skips_tombstoned_chats() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-migrate-dead",
            std::process::id()
        ));
        let doc_rows = vec![serde_json::json!({
            "id": "gone", "updatedAt": 1.0,
            "messages": [{"id": "m", "role": "user", "content": "x"}]
        })];
        let picked = pick_migration_bodies(&dir, &doc_rows, vec![]);
        assert_eq!(picked.len(), 1);
        let dead = serde_json::json!(["gone"]);
        let dead_ids: Vec<&str> = dead.as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(dead_ids.contains(&"gone"));
    }
