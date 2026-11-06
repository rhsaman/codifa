    use super::*;

    #[test]
    fn the_leftover_stores_are_removed_once_their_content_is_in_bundles() {
        // The reported bug: after migrating, `skills/` and `mcp/` stayed on disk
        // beside the bundles that already held the same content — and because the
        // marker stopped the migration from re-running, nothing ever cleaned them.
        let root = temp_root("prune");
        write_skill(&root, "movie-finder", "Movie Finder", "فیلم، سریال");
        write_connector(&root, "docker", "docker");
        standalone_stores_to_bundles(&root);

        assert_eq!(prune_migrated_stores(&root), 2);
        assert!(!root.join("skills").exists(), "the skills store is gone");
        assert!(!root.join("mcp").exists(), "the connector store is gone");
        // The copies that matter are still there, in their bundles.
        assert_eq!(crate::plugins::all_plugin_skills(&root).len(), 1);
        assert_eq!(crate::plugins::all_connector_names(&root).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_skill_written_after_the_migration_keeps_its_only_copy() {
        // The cleanup must not eat data: a folder dropped into the old store
        // AFTER the marker was written has no bundle behind it.
        let root = temp_root("prune-late");
        write_skill(&root, "movie-finder", "Movie Finder", "فیلم، سریال");
        standalone_stores_to_bundles(&root);
        write_skill(&root, "late-arrival", "Late Arrival", "دیر رسیده");

        assert_eq!(prune_migrated_stores(&root), 1);
        assert!(
            root.join("skills").join("late-arrival").join("skill.md").is_file(),
            "the only copy of a skill has to survive the cleanup"
        );
        assert!(!root.join("skills").join("movie-finder").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn builtin_bundles_are_renamed_with_their_content_and_schedules() {
        // An install seeded before the rename has the old folders, connector key
        // and schedule references. Moving the folder must carry a user-added
        // skill and the enabled switch along, and every reference must follow.
        let root = temp_root("rename-builtins");

        let builtin = root.join("plugins").join("builtin-skills");
        std::fs::create_dir_all(builtin.join("skills").join("my-note")).unwrap();
        std::fs::write(
            builtin.join("plugin.json"),
            json!({
                "name": "Built-in Skills",
                "slug": "builtin-skills",
                "enabled": false,
                "version": "1.0.0",
                "fa_keywords": ["فیلم"]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            builtin.join("skills").join("my-note").join("skill.md"),
            "---\nname: My Note\ndescription: keep me\n---\n\n# body\n",
        )
        .unwrap();

        let docker = root.join("plugins").join("docker");
        std::fs::create_dir_all(&docker).unwrap();
        std::fs::write(
            docker.join("plugin.json"),
            json!({
                "name": "docker",
                "slug": "docker",
                "enabled": true,
                "connector_meta": {"docker": {"description": "containers"}}
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            docker.join("mcp.json"),
            json!({"docker": {"command": "docker", "args": ["mcp", "gateway", "run"]}}).to_string(),
        )
        .unwrap();

        let schedules = root.join("schedules");
        std::fs::create_dir_all(&schedules).unwrap();
        std::fs::write(
            schedules.join("sch-1.json"),
            json!({
                "id": "sch-1",
                "name": "nightly",
                "plugins": ["builtin-skills", "docker"],
                "mcp_servers": ["docker"]
            })
            .to_string(),
        )
        .unwrap();

        std::fs::write(
            root.join("settings.json"),
            json!({
                "mcpServers": {"docker": {"command": "docker"}},
                "mcpEnabled": ["docker"]
            })
            .to_string(),
        )
        .unwrap();

        assert!(rename_builtin_bundles(&root) > 0);
        assert!(!root.join("plugins/builtin-skills").exists());
        assert!(!root.join("plugins/docker").exists());

        let builtin_new = root.join("plugins/builtin-plugin");
        let manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(builtin_new.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], json!("builtin plugin"));
        assert_eq!(manifest["slug"], json!("builtin-plugin"));
        assert_eq!(manifest["enabled"], json!(false), "the switch is preserved");
        assert_eq!(manifest["fa_keywords"], json!(["فیلم"]));
        assert!(builtin_new.join("skills/my-note/skill.md").is_file());

        let docker_new = root.join("plugins/docker-mcp");
        let dmanifest: Value =
            serde_json::from_str(&std::fs::read_to_string(docker_new.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(dmanifest["name"], json!("docker-mcp"));
        assert_eq!(dmanifest["slug"], json!("docker-mcp"));
        assert_eq!(dmanifest["enabled"], json!(true));
        assert_eq!(dmanifest["connector_meta"]["docker-mcp"]["description"], json!("containers"));
        let servers: Value =
            serde_json::from_str(&std::fs::read_to_string(docker_new.join("mcp.json")).unwrap())
                .unwrap();
        assert!(servers.get("docker-mcp").is_some(), "{servers}");
        assert!(servers.get("docker").is_none(), "{servers}");

        let task: Value =
            serde_json::from_str(&std::fs::read_to_string(schedules.join("sch-1.json")).unwrap())
                .unwrap();
        assert_eq!(task["plugins"], json!(["builtin-plugin", "docker-mcp"]));
        assert_eq!(task["mcp_servers"], json!(["docker-mcp"]));

        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("settings.json")).unwrap())
                .unwrap();
        assert!(settings["mcpServers"].get("docker-mcp").is_some(), "{settings}");
        assert!(settings["mcpServers"].get("docker").is_none(), "{settings}");
        assert_eq!(settings["mcpEnabled"], json!(["docker-mcp"]));

        // A second boot is a no-op: no folder to move and no reference left.
        assert_eq!(rename_builtin_bundles(&root), 0);

        // A bundle the user makes LATER under an old name is theirs. The marker
        // must stop the rename from touching it — otherwise every future boot
        // would keep hijacking a plugin called `docker`.
        let later = root.join("plugins").join("docker");
        std::fs::create_dir_all(&later).unwrap();
        std::fs::write(
            later.join("plugin.json"),
            json!({"name": "docker", "slug": "docker", "enabled": true}).to_string(),
        )
        .unwrap();
        assert_eq!(rename_builtin_bundles(&root), 0);
        assert!(later.join("plugin.json").is_file(), "the user's bundle must stay");

        let _ = std::fs::remove_dir_all(&root);
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-migrate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(root: &Path, slug: &str, name: &str, keywords: &str) {
        let dir = root.join("skills").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let mut md = format!("---\nname: {name}\ndescription: does {name}\n");
        if !keywords.is_empty() {
            md.push_str(&format!("fa_keywords: {keywords}\n"));
        }
        md.push_str("---\n\n# body\n\nthe steps\n");
        std::fs::write(dir.join("skill.md"), md).unwrap();
        std::fs::write(dir.join("notes.md"), "extra").unwrap();
    }

    fn write_connector(root: &Path, name: &str, command: &str) {
        let dir = root.join("mcp");
        std::fs::create_dir_all(&dir).unwrap();
        let record = json!({ "name": name, "config": { "command": command } });
        std::fs::write(dir.join(format!("{name}.json")), record.to_string()).unwrap();
    }

    /// Manual check on a COPY of a real data root (`CODIFA_PRUNE_ROOT`).
    ///
    /// The boot step cannot be exercised from a test any other way without
    /// touching the user's own folder, and the whole point is to prove that the
    /// two leftover stores of an ALREADY-migrated install get taken away.
    #[test]
    #[ignore]
    fn manual_prune_on_a_copy() {
        let root = std::path::PathBuf::from(std::env::var("CODIFA_PRUNE_ROOT").unwrap());
        // Exactly what a migrated install has on disk.
        let _ = std::fs::write(root.join(MIGRATED), "26\n");
        let count = |p: &Path| {
            std::fs::read_dir(p)
                .map(|d| {
                    d.flatten()
                        .filter(|e| e.file_name().to_string_lossy() != ".DS_Store")
                        .count()
                })
                .unwrap_or(0)
        };
        let skills = count(&root.join("skills"));
        let mcp = count(&root.join("mcp"));
        let removed = prune_migrated_stores(&root);
        println!("BEFORE skills={skills} mcp={mcp} -> removed={removed}");
        println!(
            "AFTER  skills_dir={} mcp_dir={} docker_kept={}",
            root.join("skills").exists(),
            root.join("mcp").exists(),
            crate::plugins::plugin_dir_of(&root, "docker")
                .join("plugin.json")
                .exists()
        );
        // `.DS_Store` is a macOS sidecar, not content: the prune ignores it, so
        // the assertion is about NAMED entries and about the folders themselves.
        let named = |p: &Path| {
            std::fs::read_dir(p)
                .map(|d| {
                    d.flatten()
                        .filter(|e| e.file_name().to_string_lossy() != ".DS_Store")
                        .count()
                })
                .unwrap_or(0)
        };
        assert_eq!(
            named(&root.join("skills")) + named(&root.join("mcp")),
            0,
            "no named entry may be left behind"
        );
        assert!(
            !root.join("skills").exists() && !root.join("mcp").exists(),
            "both store folders must be gone"
        );
        assert_eq!(removed, skills + mcp, "every named entry was pruned");
    }

    #[test]
    fn a_stored_skill_becomes_its_own_bundle() {
        let root = temp_root("skill");
        write_skill(&root, "movie-finder", "Movie Finder", "فیلم، سریال");
        assert_eq!(standalone_stores_to_bundles(&root), 1);

        let listed = crate::plugins::list_plugins(&root);
        let rows = listed["plugins"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "one bundle per skill: {listed}");
        let view = &rows[0];
        assert_eq!(view["name"], "Movie Finder");
        assert_eq!(view["skills"], json!(["Movie Finder"]));
        assert_eq!(view["fa_keywords"], json!(["فیلم", "سریال"]));
        // The body and the extra file survive, so nothing the user wrote is lost.
        let row = &crate::plugins::all_plugin_skills(&root)[0];
        assert!(row["content"].as_str().unwrap().contains("the steps"));
        assert_eq!(row["files"], json!(["notes.md"]));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_connector_absent_from_the_allowlist_lands_switched_off() {
        let root = temp_root("conn");
        write_connector(&root, "docker", "docker");
        write_connector(&root, "quiet", "quiet-mcp");
        std::fs::write(
            root.join("settings.json"),
            json!({ "mcpEnabled": ["docker"] }).to_string(),
        )
        .unwrap();
        assert_eq!(standalone_stores_to_bundles(&root), 2);

        let rows = crate::plugins::list_plugins(&root);
        let mut state: Vec<(String, bool)> = rows["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["name"].as_str().unwrap().to_string(),
                    p["enabled"].as_bool().unwrap_or(true),
                )
            })
            .collect();
        state.sort();
        // The reported requirement: nothing turns ON by itself. `docker` was in
        // the allowlist, `quiet` was not, so the migration reproduces exactly
        // that — and the enabled one feeds the agent's connector map.
        assert_eq!(
            state,
            vec![("docker".to_string(), true), ("quiet".to_string(), false)]
        );
        let live = crate::plugins::enabled_connectors(&root);
        assert!(live.contains_key("docker"));
        assert!(!live.contains_key("quiet"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_migration_runs_once_and_never_resurrects_a_deleted_bundle() {
        let root = temp_root("once");
        write_skill(&root, "keeper", "Keeper", "");
        assert_eq!(standalone_stores_to_bundles(&root), 1);
        // A second boot must not rewrite anything…
        assert_eq!(standalone_stores_to_bundles(&root), 0);

        // …and a bundle the user deletes stays deleted, even with the store
        // still on disk (an old backup restored, or a file the migration missed).
        let dir = crate::plugins::plugin_dir_of(&root, "keeper");
        assert!(dir.is_dir(), "bundle folder should exist");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(standalone_stores_to_bundles(&root), 0);
        assert_eq!(crate::plugins::list_plugins(&root)["plugins"], json!([]));
        let _ = std::fs::remove_dir_all(&root);
    }
