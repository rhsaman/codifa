    use super::*;

    #[test]
    fn unified_diff_marks_changed_middle() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
        let new = "a\nb\nc\nD\ne\nf\ng\nh\ni\nj\nk\nl\n";
        let d = unified_diff("f.txt", old, new);
        assert!(d.starts_with("--- a/f.txt\n+++ b/f.txt\n"));
        assert!(d.contains("-d\n+D\n"));
        assert!(d.contains("@@ -"));
    }

    #[test]
    fn unified_diff_new_file_is_all_additions() {
        let d = unified_diff("n.txt", "", "hello\n");
        assert!(d.contains("+hello\n"));
        assert!(!d.contains("\n-"));
    }

    #[test]
    fn unified_diff_identical_is_empty() {
        assert_eq!(unified_diff("x.txt", "same\n", "same\n"), "");
    }

    fn count_changes(d: &str) -> (usize, usize) {
        let adds = d.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
        let dels = d.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
        (adds, dels)
    }

    /// The reported bug: two small edits far apart used to be diffed as one
    /// block spanning everything between them (+122/-110 for a ~5 line change).
    #[test]
    fn unified_diff_counts_only_the_lines_that_really_changed() {
        let old: Vec<String> = (1..=130).map(|n| format!("line {n}")).collect();
        let mut new = old.clone();
        new[8] = "line 9 changed".to_string();
        new[120] = "line 121 changed".to_string();
        new.insert(60, "brand new line".to_string());
        let old_s = old.join("\n") + "\n";
        let new_s = new.join("\n") + "\n";
        let d = unified_diff("big.txt", &old_s, &new_s);
        assert_eq!(count_changes(&d), (3, 2), "diff was:\n{d}");
        // Three distant edits => three separate hunks, not one giant one.
        assert_eq!(d.matches("\n@@ -").count(), 3, "diff was:\n{d}");
    }

    #[test]
    fn unified_diff_close_edits_share_one_hunk() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nB\nc\nd\ne\nf\nG\nh\n";
        let d = unified_diff("f.txt", old, new);
        assert_eq!(count_changes(&d), (2, 2));
        assert_eq!(d.matches("\n@@ -").count(), 1, "diff was:\n{d}");
    }

    #[test]
    fn unified_diff_pure_insert_and_delete_in_the_middle() {
        let d = unified_diff("f.txt", "a\nb\nc\n", "a\nb\nX\nY\nc\n");
        assert_eq!(count_changes(&d), (2, 0));
        let d = unified_diff("f.txt", "a\nb\nX\nY\nc\n", "a\nb\nc\n");
        assert_eq!(count_changes(&d), (0, 2));
    }

    /// Applying the diff's own +/- lines to the old text must give the new text:
    /// the hunks are not just well counted, they are exact.
    #[test]
    fn unified_diff_hunks_reconstruct_the_new_text() {
        // Short enough that both edits land in ONE hunk (a hunk only carries
        // context around its changes, so a multi-hunk diff is not the full text).
        let old = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
        let new = "one\n2\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
        let d = unified_diff("f.txt", old, new);
        let rebuilt: Vec<&str> = d
            .lines()
            .skip(2)
            .filter(|l| !l.starts_with("@@") && !l.starts_with('-'))
            .map(|l| &l[1..])
            .collect();
        assert_eq!(rebuilt, new.lines().collect::<Vec<_>>());
    }

    #[test]
    fn a_non_utf8_file_names_the_real_cause_and_reads_as_lossy() {
        // MEASURED (trace `mvxsy14e`): every edit failure came back as the same
        // 26-char "binary file (edit skipped)" — 8 times in one turn — because the
        // read collapsed EACCES/EISDIR/encoding into one string. The model could
        // not tell a real encoding problem from a transient one, so it re-read and
        // re-sent the same batch for 1-2 rounds (65-138K re-sent tokens each).
        let tmp = std::env::temp_dir().join(format!("codifa-nonutf8-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("latin1.txt");
        // 0xFF is never valid UTF-8; the text around it must survive the view.
        fs::write(&file, b"alpha\n\xff\xfe beta\n").unwrap();
        let root = tmp.to_str().unwrap();

        let edit = edit_file(root, "latin1.txt", "alpha", "ALPHA", false, None).unwrap_err();
        assert!(!edit.contains("binary file"), "must not collapse the cause: {edit}");
        assert!(edit.contains("not valid UTF-8"), "names the real cause: {edit}");
        assert!(edit.contains("offset 6"), "points at the bad byte: {edit}");
        // A refused edit never rewrites bytes.
        assert_eq!(fs::read(&file).unwrap(), b"alpha\n\xff\xfe beta\n");

        // A READ still shows the content, marked as lossy — refusing it threw
        // away text the model could use.
        let view = read_window(&file, 1, 10).unwrap();
        assert!(view.contains("not valid UTF-8"), "marks the lossy view: {view}");
        assert!(view.contains("alpha") && view.contains("beta"), "keeps the text: {view}");
        fs::remove_dir_all(&tmp).ok();
    }
