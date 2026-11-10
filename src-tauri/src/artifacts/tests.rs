    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-artifact-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    #[test]
    fn attached_files_travel_with_the_version() {
        let root = temp_root("assets");
        let saved = save(
            &root,
            "chat-1",
            &json!({
                "title": "Live panel",
                "kind": "html",
                "content": "<b>ui</b>",
                "files": [
                    {"path": "backend.rs", "content": "fn main() {}"},
                    {"path": "data/rows.json", "content": "[]"},
                ],
            }),
            true,
        )
        .unwrap();
        assert_eq!(saved["assets"].as_array().unwrap().len(), 2);

        let read_back = read_assets(&root, "chat-1", "live-panel").unwrap();
        let files = read_back["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        // Sorted by path, so the panel lists them in a stable order.
        assert_eq!(files[0]["path"], "backend.rs");
        assert_eq!(files[1]["path"], "data/rows.json");
        assert_eq!(files[1]["content"], "[]");

        // An update that attaches nothing keeps the files already stored: a
        // content-only edit must not silently drop the backend.
        save(
            &root,
            "chat-1",
            &json!({"id": "live-panel", "content": "<b>ui 2</b>"}),
            false,
        )
        .unwrap();
        let kept = read_assets(&root, "chat-1", "live-panel").unwrap();
        assert_eq!(kept["files"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn attached_file_names_cannot_escape_the_artifact_folder() {
        let root = temp_root("assets-traversal");
        save(
            &root,
            "chat-1",
            &json!({
                "title": "Sneaky",
                "content": "x",
                "files": [{"path": "../../escaped.rs", "content": "evil"}],
            }),
            true,
        )
        .unwrap();
        // The name is flattened into the assets folder instead of walking out.
        assert!(!root.join("escaped.rs").exists());
        assert!(root
            .join("artifacts/chat-1/sneaky/assets/escaped.rs")
            .is_file());
    }

    #[test]
    fn create_then_update_bumps_the_version() {
        let root = temp_root("version");
        let first = save(
            &root,
            "chat-1",
            &json!({"title": "Sales chart", "kind": "html", "content": "<b>1</b>"}),
            true,
        )
        .unwrap();
        assert_eq!(first["id"], "sales-chart");
        assert_eq!(first["version"], 1);

        // A second create on the same id must fail: use update for a new version.
        assert!(save(
            &root,
            "chat-1",
            &json!({"title": "Sales chart", "content": "<b>2</b>"}),
            true
        )
        .is_err());

        let second = save(
            &root,
            "chat-1",
            &json!({"id": "sales-chart", "content": "<b>2</b>"}),
            false,
        )
        .unwrap();
        assert_eq!(second["version"], 2);
        // The title/kind survive an update that only sends content.
        assert_eq!(second["title"], "Sales chart");
        assert_eq!(second["kind"], "html");

        let latest = read(&root, "chat-1", "sales-chart").unwrap();
        assert_eq!(latest["content"], "<b>2</b>");
        assert_eq!(latest["version"], 2);

        // Updating an unknown artifact is an explicit error, not a silent create.
        assert!(save(&root, "chat-1", &json!({"id": "ghost", "content": "x"}), false).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_reports_every_chat_newest_first() {
        let root = temp_root("list");
        // Nothing built yet: an empty list, never an error.
        assert_eq!(list(&root, "").unwrap()["artifacts"].as_array().unwrap().len(), 0);

        save(
            &root,
            "chat-a",
            &json!({"title": "Alpha", "kind": "md", "content": "# a"}),
            true,
        )
        .unwrap();
        save(
            &root,
            "chat-b",
            &json!({"title": "Beta", "content": "<b>b</b>"}),
            true,
        )
        .unwrap();
        // A second version of Alpha must NOT add a second row.
        save(&root, "chat-a", &json!({"id": "alpha", "content": "# a2"}), false).unwrap();

        let all = list(&root, "").unwrap();
        let items = all["artifacts"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{all}");
        let alpha = items.iter().find(|i| i["id"] == "alpha").unwrap();
        assert_eq!(alpha["title"], "Alpha");
        assert_eq!(alpha["kind"], "md");
        assert_eq!(alpha["version"], 2);
        assert_eq!(alpha["chat_id"], "chat-a");
        let beta = items.iter().find(|i| i["id"] == "beta").unwrap();
        assert_eq!(beta["chat_id"], "chat-b");
        // Newest first: Alpha was updated last.
        assert_eq!(items[0]["id"], "alpha");

        // One chat's own list, and an unknown chat is empty rather than an error.
        assert_eq!(
            list(&root, "chat-b").unwrap()["artifacts"].as_array().unwrap().len(),
            1
        );
        assert_eq!(list(&root, "ghost").unwrap()["artifacts"].as_array().unwrap().len(), 0);

        // A folder that never got a version is skipped (no openable document).
        let stray = chat_dir(&root, "chat-a").join("empty");
        fs::create_dir_all(&stray).unwrap();
        assert_eq!(list(&root, "chat-a").unwrap()["artifacts"].as_array().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_the_whole_folder() {
        let root = temp_root("delete");
        save(&root, "chat-a", &json!({"title": "Doomed", "content": "<b>1</b>"}), true).unwrap();
        save(&root, "chat-a", &json!({"id": "doomed", "content": "<b>2</b>"}), false).unwrap();
        assert_eq!(list(&root, "chat-a").unwrap()["artifacts"].as_array().unwrap().len(), 1);

        let out = delete(&root, "chat-a", "doomed").unwrap();
        assert_eq!(out["ok"], true);
        // Every version goes with it, and the chat folder stays for the rest.
        assert_eq!(list(&root, "chat-a").unwrap()["artifacts"].as_array().unwrap().len(), 0);
        assert!(!chat_dir(&root, "chat-a").join("doomed").exists());
        assert!(!read(&root, "chat-a", "doomed").is_ok());
        // Deleting it twice is an explicit error, not a silent success.
        assert!(delete(&root, "chat-a", "doomed").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn markdown_kind_is_recognised() {
        assert_eq!(kind_of(&json!({"kind": "markdown"})), "md");
        assert_eq!(kind_of(&json!({"kind": "MD"})), "md");
        assert_eq!(kind_of(&json!({})), "html");
        assert_eq!(kind_of(&json!({"kind": "svg"})), "html");
    }

    #[test]
    fn plan_documents_are_tagged_and_kept_off_the_list() {
        let root = temp_root("plan");
        let saved = save(
            &root,
            "chat-a",
            &json!({
                "title": "Plan — sub-agent tab",
                "kind": "md",
                "content": "# Plan — sub-agent tab\n\n1. rename the row\n2. add the tab",
            }),
            true,
        )
        .unwrap();
        let id = saved["id"].as_str().unwrap();
        mark_plan(&root, "chat-a", id).unwrap();

        // A supporting document from the same turn stays on the page.
        save(
            &root,
            "chat-a",
            &json!({"title": "Design notes", "kind": "md", "content": "# Design notes\ncolors"}),
            true,
        )
        .unwrap();

        let items = list(&root, "chat-a").unwrap();
        let items = items["artifacts"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0]["id"], "design-notes");

        // Hidden from the page, still readable from the transcript card/preview.
        assert_eq!(
            read(&root, "chat-a", id).unwrap()["title"],
            "Plan — sub-agent tab"
        );

        // The tag survives an update, so a later edit cannot put the plan back.
        save(
            &root,
            "chat-a",
            &json!({"id": id, "content": "# Plan\n\n1. rename the row"}),
            false,
        )
        .unwrap();
        let items = list(&root, "chat-a").unwrap();
        assert_eq!(items["artifacts"].as_array().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_plan_artifacts_stay_off_the_list_without_a_tag() {
        let root = temp_root("plan-legacy");
        // Saved before `mark_plan` existed: the title names a plan.
        save(
            &root,
            "chat-a",
            &json!({
                "title": "Implementation plan",
                "kind": "md",
                "content": "# Implementation Plan\n1. do it",
            }),
            true,
        )
        .unwrap();
        // ... or only its first heading does.
        save(
            &root,
            "chat-a",
            &json!({"title": "Rollout", "kind": "md", "content": "# طرح\n1. ship it"}),
            true,
        )
        .unwrap();
        // A normal markdown artifact, and an html one that merely says "plan",
        // are not plan documents and stay on the page.
        save(
            &root,
            "chat-a",
            &json!({"title": "Report", "kind": "md", "content": "# Report\nnumbers"}),
            true,
        )
        .unwrap();
        save(
            &root,
            "chat-a",
            &json!({"title": "Plan chart", "kind": "html", "content": "<b>chart</b>"}),
            true,
        )
        .unwrap();

        let items = list(&root, "chat-a").unwrap();
        let ids: Vec<&str> = items["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["id"].as_str())
            .collect();
        assert_eq!(ids.len(), 2, "{ids:?}");
        assert!(ids.contains(&"report"), "{ids:?}");
        assert!(ids.contains(&"plan-chart"), "{ids:?}");

        let _ = fs::remove_dir_all(&root);
    }
