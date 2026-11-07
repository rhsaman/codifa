    use super::*;

    #[test]
    fn branch_validation_rejects_shell_metachars() {
        assert!(valid_branch("feature/x-1.2").is_ok());
        assert!(valid_branch("-evil").is_err());
        assert!(valid_branch("..").is_err());
        assert!(valid_branch("a b").is_err());
        assert!(valid_branch("a;b").is_err());
    }

    /// A diff whose byte cap lands inside a multi-byte character (an em dash,
    /// Persian text) used to panic with "not a char boundary".
    #[test]
    fn truncate_cuts_on_a_char_boundary() {
        // '—' is 3 bytes: put it so MAX_DIFF falls in the middle of it.
        let mut diff = "a".repeat(MAX_DIFF - 2);
        diff.push('—');
        diff.push_str("tail");
        let out = truncate(diff);
        assert_eq!(out["truncated"], true);
        let kept = out["diff"].as_str().unwrap();
        assert_eq!(kept.len(), MAX_DIFF - 2);
        assert!(kept.chars().all(|c| c == 'a'));
        // Under the cap: untouched.
        let small = truncate("short — diff".to_string());
        assert_eq!(small["truncated"], false);
    }

    /// A working tree whose aggregate diff exceeds the byte cap: the capped
    /// fetch truncates (agent context parity), but the panel's `full` fetch
    /// must return everything — a capped aggregate strands the tail files as
    /// +0 -0 ghosts with "no diff available yet".
    #[test]
    fn diff_full_and_show_full_skip_the_size_cap() {
        let root = temp_repo("codifa-git-diff-cap-test");
        let run = |args: &[&str]| {
            assert!(Command::new("git").args(args).current_dir(&root).status().unwrap().success());
        };
        let big = format!("line — {}\n", "x".repeat(70_000));
        for i in 0..5 {
            std::fs::write(root.join(format!("big{i}.txt")), &big).unwrap();
        }
        let root_str = root.to_str().unwrap();
        run(&["add", "-A"]);

        let capped = ok(diff(root_str, "", true));
        assert_eq!(capped["truncated"], true);
        assert!(capped["diff"].as_str().unwrap().len() <= MAX_DIFF);

        let full = ok(diff_full(root_str, "", true));
        assert_eq!(full["truncated"], false);
        let full_diff = full["diff"].as_str().unwrap();
        assert!(full_diff.len() > MAX_DIFF);
        // Every file's diff survived the trip.
        for i in 0..5 {
            assert!(full_diff.contains(&format!("big{i}.txt")));
        }

        // Same guarantee for the committed view.
        run(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "big"]);
        let show_capped = ok(show(root_str, "HEAD", ""));
        assert_eq!(show_capped["truncated"], true);
        let show_full = ok(show_full(root_str, "HEAD", ""));
        assert_eq!(show_full["truncated"], false);
        assert!(show_full["diff"].as_str().unwrap().len() > MAX_DIFF);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_validation_rejects_urls() {
        // A URL must fail remote validation before git is ever touched.
        // Use an existing dir (the workspace) so we hit the remote check,
        // not the root check.
        let root = env!("CARGO_MANIFEST_DIR");
        let e = push(root, "https://evil", "main", false).unwrap_err();
        assert!(e.0.contains("invalid remote"), "got: {}", e.0);
    }

    /// Unwraps a GitResult without needing `Debug` on GitError.
    fn ok(r: GitResult) -> Value {
        match r {
            Ok(v) => v,
            Err(GitError(m)) => panic!("git error: {m}"),
        }
    }

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| {
            assert!(
                Command::new("git").args(args).current_dir(&root).status().unwrap().success(),
                "git {:?} failed",
                args
            );
        };
        run(&["init", "-q"]);
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
        root
    }

    /// Untracked files used to reach the Review panel as +0 -0 ghosts: `git
    /// diff` only covers tracked paths and status paths were appended with
    /// empty stats. The unstaged diff now carries them as new-file diffs; the
    /// staged view keeps excluding them.
    #[test]
    fn unstaged_diff_includes_untracked_files() {
        let root = temp_repo("codifa-git-diff-test");
        std::fs::write(root.join("new.ts"), "line1\nline2\n").unwrap();
        std::fs::write(root.join("tracked.txt"), "base\nedit\n").unwrap();

        let root_str = root.to_str().unwrap();
        let unstaged = ok(diff(root_str, "", false))["diff"].as_str().unwrap().to_string();
        assert!(unstaged.contains("diff --git a/tracked.txt b/tracked.txt"));
        assert!(unstaged.contains("diff --git a/new.ts b/new.ts"));
        assert!(unstaged.contains("+line2"));

        let staged = ok(diff(root_str, "", true))["diff"].as_str().unwrap().to_string();
        assert!(!staged.contains("new.ts"));

        // A path-scoped unstaged query still surfaces the untracked file.
        let single = ok(diff(root_str, "new.ts", false))["diff"].as_str().unwrap().to_string();
        assert!(single.contains("diff --git a/new.ts b/new.ts"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Status reports renames as "XY old -> new"; the panel keys files by this
    /// path, so only the new side must survive — otherwise a ghost
    /// "old -> new" row with +0 -0 sits next to the real file.
    #[test]
    fn status_rename_reports_the_new_path() {
        let root = temp_repo("codifa-git-rename-test");
        let run = |args: &[&str]| {
            assert!(Command::new("git").args(args).current_dir(&root).status().unwrap().success());
        };
        run(&["mv", "tracked.txt", "renamed.txt"]);

        let st = ok(status(root.to_str().unwrap()));
        let paths: Vec<String> = st["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(paths, vec!["renamed.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A fully-new directory must list its files individually (like the
    /// /ws/events fingerprint), not collapse into one `?? dir/` row.
    #[test]
    fn status_lists_untracked_files_inside_new_dirs() {
        let root = temp_repo("codifa-git-untracked-dir-test");
        std::fs::create_dir_all(root.join("src/types")).unwrap();
        std::fs::write(root.join("src/types/a.ts"), "a\n").unwrap();
        std::fs::write(root.join("src/types/b.ts"), "b\n").unwrap();

        let st = ok(status(root.to_str().unwrap()));
        let paths: Vec<String> = st["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(paths, vec!["src/types/a.ts", "src/types/b.ts"]);
        let _ = std::fs::remove_dir_all(&root);
    }
