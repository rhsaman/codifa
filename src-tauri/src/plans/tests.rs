    use super::*;
    use std::env;

    fn tmp_root(tag: &str) -> String {
        let d = env::temp_dir().join(format!("codifa-plans-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn save_get_delete_roundtrip() {
        let root = tmp_root("rt");
        save_plan(&root, "codifa-abc12345", "plan", "## Plan\nstep one", "chat-1").unwrap();
        let plan = get_plan(&root, "codifa-abc12345", "chat-1").expect("plan exists");
        assert_eq!(
            plan["content"].as_str().unwrap(),
            "## Plan\nstep one"
        );
        assert!(get_plan(&root, "codifa-abc12345", "").is_none());
        assert!(delete_plan(&root, "codifa-abc12345", "chat-1"));
        assert!(get_plan(&root, "codifa-abc12345", "chat-1").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sha1_hex_matches_the_reference_digest() {
        // The slug's `-<8 hex>` half MUST be a real SHA-1 (Python hashlib), or a
        // plan the Python sidecar wrote is invisible to the native reader. Pinned
        // on the canonical NIST/FIPS vectors, which are the same on every
        // machine — NOT on someone's home directory.
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn workspace_slug_matches_the_sidecar_layout() {
        // Same basename+digest shape as state_db.workspace_slug_for_root so plans
        // written by the Python sidecar are found by the native reader. The path
        // is a NEUTRAL fixture that exists on no machine: hard-coding one user's
        // home directory made this assertion about that person's disk layout
        // rather than about the slug function.
        let slug = workspace_slug_for_root("/nonexistent-codifa-fixture/codifa-plan-layout");
        assert_eq!(slug, "codifa-plan-layout-70917f10");
    }

    #[test]
    fn plan_text_keeps_only_the_plan_rounds() {
        // Real shape of a plan-mode turn: a read round, narrating rounds around
        // the plan, then the closing note "switch to Build".
        let narration = "دو نکته پیدا شد که پلن را عوض می‌کند: …";
        let plan = "## Plan\n1. `a.rs` — چیزی را عوض می‌کند\n\n## خلاصه\nپلن آماده است.";
        let note = "پلن نوشته شد و چک‌لیست روی دیسک ذخیره شد.";
        let out = plan_text(&["", narration, plan, note]);
        assert!(out.starts_with("## Plan"), "{out}");
        assert!(!out.contains("دو نکته پیدا شد"), "{out}");
        assert!(!out.contains("چک‌لیست روی دیسک"), "{out}");
    }

    #[test]
    fn plan_text_drops_leading_narration_inside_a_round() {
        // The plan round itself can open with a line of prose before the heading.
        let plan = "یک بررسی هم روی تست‌ها کردم.\n## Plan\n1. گام";
        assert_eq!(plan_text(&[plan]), "## Plan\n1. گام");
    }

    #[test]
    fn plan_text_falls_back_to_every_round_without_a_heading() {
        // A plan written as a bare list has no heading — keep it instead of
        // saving an empty document.
        let out = plan_text(&["1. first", "2. second"]);
        assert_eq!(out, "1. first\n\n2. second");
    }

    #[test]
    fn has_heading_separates_a_plan_from_a_chat_answer() {
        // The plan prompt makes a plan open with a heading; an answer to a plan-
        // mode QUESTION carries no heading even when it is bulleted, which is
        // what must not overwrite the saved plan.
        assert!(has_heading("## Plan\n1. گام"));
        assert!(has_heading("مقدمه\n### قدم‌ها\n- یک"));
        assert!(!has_heading("بله — مارکت‌پلیس در تنظیمات است:\n- تب تازه\n- فرم افزودن"));
        assert!(!has_heading(""));
    }

    #[test]
    fn checklist_roundtrip_and_cleanup() {
        let root = tmp_root("cl");
        save_checklist(
            &root,
            "ws-x",
            "chat-2",
            &json!([
                {"content": "step", "status": "completed"},
                {"content": "", "status": "pending"},
                {"content": "bad", "status": "weird"}
            ]),
        );
        let items = get_checklist(&root, "ws-x", "chat-2");
        let arr = items.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["status"], "completed");
        assert_eq!(arr[1]["status"], "pending");
        let _ = fs::remove_dir_all(&root);
    }
