    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-backup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(root: &Path) {
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        std::fs::write(root.join("settings.json"), "{\"providers\":[]}").unwrap();
        std::fs::write(root.join("plugins").join("p.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("chats")).unwrap();
        std::fs::write(root.join("chats").join("c1.json"), "hello").unwrap();
        // Excluded: the two user-asked dirs, caches, logs and sidecars.
        for name in ["traces", "checkpoints", "memory", "cache", "browser-profile", "vector-db"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("x.bin"), "no").unwrap();
        }
        std::fs::write(root.join("rust.log"), "log").unwrap();
        std::fs::write(root.join(".DS_Store"), "junk").unwrap();
        std::fs::write(root.join("settings.json.bak"), "old").unwrap();
        // A previous backup must never be re-packed into the new archive.
        std::fs::write(root.join("codifa-backup-20260101-000000.zip"), "old zip").unwrap();
    }

    /// Collect on the seeded root, then verify ONLY the packable files came
    /// through (this is the exclusion contract the zip is built from).
    #[test]
    fn collect_packs_data_and_skips_excluded() {
        let root = temp_root("collect");
        seed(&root);
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        collect(&root, &root, "", &mut files, &mut dirs, 0).unwrap();
        let mut rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        rels.sort();
        assert_eq!(
            rels,
            vec!["chats/c1.json", "plugins/p.json", "settings.json"],
            "excluded dirs, logs and sidecars must not be collected: {rels:?}"
        );
        assert!(dirs.contains(&"chats".to_string()));
        assert!(!dirs.iter().any(|d| d == "traces"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A file added under an excluded folder is skipped even when the folder
    /// itself was created after the constant list was written — exclusion is
    /// by NAME at every depth, not by top-level position.
    #[test]
    fn exclusion_applies_at_every_depth() {
        let root = temp_root("depth");
        std::fs::create_dir_all(root.join("chats").join("traces")).unwrap();
        std::fs::write(root.join("chats").join("traces").join("t.json"), "x").unwrap();
        std::fs::write(root.join("chats").join("keep.json"), "y").unwrap();
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        collect(&root, &root, "", &mut files, &mut dirs, 0).unwrap();
        let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["chats/keep.json"], "a nested excluded NAME is still excluded");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn expand_home_resolves_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/sub"), home.join("sub"));
        assert_eq!(expand_home("/tmp/x"), PathBuf::from("/tmp/x"));
        assert_eq!(expand_home(""), PathBuf::from(""));
    }

    /// End-to-end: build the archive on a seeded root, then read it back with
    /// ZipArchive and assert the layout IS the data root — data in, excluded
    /// data out, the manifest present, progress ending at 100%.
    #[test]
    fn build_backup_zips_the_data_root_and_respects_exclusions() {
        let root = temp_root("zip");
        seed(&root);
        let dest = temp_root("zip-dest");
        let mut events: Vec<(String, u32, u64, u64)> = Vec::new();
        let res = build_backup(&root, &dest, None, || false, |l, p, d, t| {
            events.push((l.to_string(), p, d, t))
        })
        .unwrap();

        assert_eq!(res.files, 3, "settings.json + chats/c1.json + plugins/p.json");
        assert_eq!(res.bytes, 16 + 2 + 5, "the packed byte count is the SOURCE size");
        assert!(std::path::Path::new(&res.path).is_file(), "the archive exists: {}", res.path);

        let file = std::fs::File::open(&res.path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().unwrap().to_string())
            .collect();
        for wanted in ["backup.json", "settings.json", "chats/c1.json", "plugins/p.json"] {
            assert!(names.iter().any(|n| n == wanted), "{wanted} missing from {names:?}");
        }
        for banned in ["traces/", "checkpoints/", "memory/", "cache/", "browser-profile/", "vector-db/", "rust.log", ".DS_Store", "settings.json.bak", "codifa-backup-"] {
            assert!(
                !names.iter().any(|n| n.contains(banned)),
                "excluded data leaked into the archive: {banned} in {names:?}"
            );
        }
        // The manifest counts what was packed.
        let mut manifest = zip.by_name("backup.json").unwrap();
        let text = {
            use std::io::Read;
            let mut buf = String::new();
            manifest.read_to_string(&mut buf).unwrap();
            buf
        };
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["files"], serde_json::json!(3));
        assert_eq!(doc["app"], serde_json::json!("codifa"));
        // Progress ends at 100 with the full file count.
        let last = events.last().unwrap();
        assert_eq!(last.1, 100);
        assert_eq!(last.2, 3);
        assert_eq!(last.3, 3);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// Cancelling before the first file means no archive at all: the partial
    /// zip must be removed, not left on disk as a corrupt "backup".
    #[test]
    fn a_cancelled_backup_leaves_no_partial_archive() {
        let root = temp_root("cancel");
        seed(&root);
        let dest = temp_root("cancel-dest");
        let err = build_backup(&root, &dest, None, || true, |_, _, _, _| {}).unwrap_err();
        assert_eq!(err, "Backup cancelled.");
        let leftovers: Vec<_> = std::fs::read_dir(&dest).unwrap().flatten().collect();
        assert!(leftovers.is_empty(), "partial archive left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// The archive name carries a timestamp so repeated backups never overwrite
    /// each other; two runs within the same second must both succeed.
    #[test]
    fn two_backups_in_the_same_second_do_not_collide() {
        let root = temp_root("collide");
        seed(&root);
        let dest = temp_root("collide-dest");
        let first = build_backup(&root, &dest, None, || false, |_, _, _, _| {}).unwrap();
        let second = build_backup(&root, &dest, None, || false, |_, _, _, _| {}).unwrap();
        assert_ne!(first.path, second.path, "each run gets its own archive file");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// The full backup → restore round trip: the archive built from one root
    /// applied onto an EMPTY root must reproduce every data file byte-for-byte,
    /// leave no manifest or staging folder behind, and read back cleanly.
    #[test]
    fn a_backup_restored_onto_a_fresh_root_reproduces_the_data() {
        let root = temp_root("rt-src");
        seed(&root);
        let dest = temp_root("rt-zip");
        let archive = build_backup(&root, &dest, None, || false, |_, _, _, _| {}).unwrap();

        let target = temp_root("rt-dst");
        let mut events: Vec<(String, u32, u64, u64)> = Vec::new();
        let outcome = restore_archive(
            std::path::Path::new(&archive.path),
            &target,
            None,
            || false,
            |l, p, d, t| events.push((l.to_string(), p, d, t)),
        )
        .unwrap();
        assert_eq!(outcome.files, 3, "settings.json + chats/c1.json + plugins/p.json");

        assert_eq!(
            std::fs::read_to_string(target.join("settings.json")).unwrap(),
            "{\"providers\":[]}"
        );
        assert_eq!(std::fs::read_to_string(target.join("chats").join("c1.json")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(target.join("plugins").join("p.json")).unwrap(), "{}");
        // Metadata and scaffolding must NOT leak into the data root.
        assert!(!target.join("backup.json").exists(), "the manifest is not data");
        let top: Vec<String> = std::fs::read_dir(&target)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            top.len(),
            3,
            "exactly settings.json + chats/ + plugins/ exist — got {top:?}"
        );
        assert!(
            !target.join("traces").exists() && !target.join("rust.log").exists(),
            "excluded data is not resurrected by a restore"
        );
        // Progress ends at 100.
        assert_eq!(events.last().unwrap().1, 100);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&target);
    }

    /// Restore over EXISTING data: archive files overwrite their live paths
    /// (that is the point of a restore) while files absent from the archive
    /// survive — merge semantics, not a wipe.
    #[test]
    fn restoring_overwrites_matching_files_and_keeps_the_rest() {
        let root = temp_root("ov-src");
        seed(&root);
        let dest = temp_root("ov-zip");
        let archive = build_backup(&root, &dest, None, || false, |_, _, _, _| {}).unwrap();

        let target = temp_root("ov-dst");
        std::fs::create_dir_all(target.join("chats")).unwrap();
        std::fs::write(target.join("settings.json"), "{\"providers\":[\"OLD\"]}").unwrap();
        std::fs::write(target.join("chats").join("c1.json"), "OLD BODY").unwrap();
        std::fs::write(target.join("chats").join("only-here.json"), "KEEP ME").unwrap();

        restore_archive(std::path::Path::new(&archive.path), &target, None, || false, |_, _, _, _| {})
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("settings.json")).unwrap(),
            "{\"providers\":[]}",
            "the archive version wins"
        );
        assert_eq!(std::fs::read_to_string(target.join("chats").join("c1.json")).unwrap(), "hello");
        assert_eq!(
            std::fs::read_to_string(target.join("chats").join("only-here.json")).unwrap(),
            "KEEP ME",
            "a live file absent from the archive is untouched"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&target);
    }

    /// Cancelling during extraction must leave the target root EXACTLY as it
    /// was — that is what the staging pass buys.
    #[test]
    fn a_cancelled_restore_leaves_the_data_untouched() {
        let root = temp_root("cx-src");
        seed(&root);
        let dest = temp_root("cx-zip");
        let archive = build_backup(&root, &dest, None, || false, |_, _, _, _| {}).unwrap();

        let target = temp_root("cx-dst");
        std::fs::write(target.join("settings.json"), "{\"original\":true}").unwrap();
        let err = restore_archive(
            std::path::Path::new(&archive.path),
            &target,
            None,
            || true,
            |_, _, _, _| {},
        )
        .unwrap_err();
        assert_eq!(err, "Restore cancelled.");
        assert_eq!(
            std::fs::read_to_string(target.join("settings.json")).unwrap(),
            "{\"original\":true}",
            "a cancelled restore changed nothing"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&target).unwrap().flatten().collect();
        assert!(
            !leftovers.iter().any(|e| e.file_name().to_string_lossy().starts_with(".restore-staging")),
            "staging must be cleaned up: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&target);
    }

    /// A zip without the codifa manifest is refused before anything is written
    /// — restoring some arbitrary archive must be impossible.
    #[test]
    fn a_foreign_zip_is_refused() {
        let target = temp_root("foreign");
        let zip_path = target.join("random.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("evil.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, b"not a codifa backup").unwrap();
        writer.finish().unwrap();

        let err = read_manifest(&zip_path).unwrap_err();
        assert!(err.contains("not a codifa backup"), "got: {err}");
        let err = restore_archive(&zip_path, &target, None, || false, |_, _, _, _| {}).unwrap_err();
        assert!(err.contains("not a codifa backup"), "got: {err}");
        assert!(
            !target.join("evil.txt").exists(),
            "a foreign zip must not extract"
        );
        let _ = std::fs::remove_dir_all(&target);
    }

    /// The install key travels with the archive and lands back in the
    /// app-data dir on restore — the whole reason a backup restores provider
    /// API keys on a DIFFERENT machine or OS. The key entry itself must never
    /// leak into the data root, and the manifest must advertise it.
    #[test]
    fn install_key_travels_with_the_archive_and_lands_outside_the_root() {
        let root = temp_root("key-src");
        seed(&root);
        let dest = temp_root("key-zip");
        let key_bytes = b"raw:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        let archive =
            build_backup(&root, &dest, Some(key_bytes), || false, |_, _, _, _| {}).unwrap();

        // The manifest advertises the key so the UI can too.
        let info = read_manifest(std::path::Path::new(&archive.path)).unwrap();
        assert!(info.secrets_key, "manifest marks the install key");

        let target = temp_root("key-dst");
        let key_target = temp_root("key-appdata").join("com.codifa.app").join("secrets.key");
        let outcome = restore_archive(
            std::path::Path::new(&archive.path),
            &target,
            Some(&key_target),
            || false,
            |_, _, _, _| {},
        )
        .unwrap();
        assert!(outcome.secrets_restored, "the key was installed");
        assert_eq!(
            std::fs::read(&key_target).unwrap(),
            key_bytes,
            "the key arrives byte-identical"
        );
        // The key entry is metadata: never staged into the data root.
        assert!(
            !target.join("secrets.key").exists(),
            "the install key must not leak into the data root"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(key_target.parent().unwrap());
    }

    /// A keyless archive (older backup, or `None` at pack time) restores
    /// without touching this machine's existing key.
    #[test]
    fn a_keyless_archive_keeps_the_current_install_key() {
        let root = temp_root("nokey-src");
        seed(&root);
        let dest = temp_root("nokey-zip");
        let archive = build_backup(&root, &dest, None, || false, |_, _, _, _| {}).unwrap();
        assert!(
            !read_manifest(std::path::Path::new(&archive.path))
                .unwrap()
                .secrets_key
        );

        let target = temp_root("nokey-dst");
        let key_target = temp_root("nokey-appdata").join("secrets.key");
        std::fs::write(&key_target, b"raw:CURRENT=").unwrap();
        let outcome = restore_archive(
            std::path::Path::new(&archive.path),
            &target,
            Some(&key_target),
            || false,
            |_, _, _, _| {},
        )
        .unwrap();
        assert!(!outcome.secrets_restored);
        assert_eq!(
            std::fs::read(&key_target).unwrap(),
            b"raw:CURRENT=",
            "the existing key is untouched"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(key_target.parent().unwrap());
    }

    /// A data-root file named `secrets.key` would collide with the reserved
    /// archive entry — it is skipped at pack time instead of producing an
    /// ambiguous zip.
    #[test]
    fn a_data_root_secrets_key_file_does_not_collide() {
        let root = temp_root("collide-key");
        seed(&root);
        std::fs::write(root.join("secrets.key"), "user data with the same name").unwrap();
        let dest = temp_root("collide-key-zip");
        let key_bytes = b"raw:INSTALLKEY=";
        let archive =
            build_backup(&root, &dest, Some(key_bytes), || false, |_, _, _, _| {}).unwrap();

        let file = std::fs::File::open(&archive.path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut found = 0;
        for i in 0..zip.len() {
            if zip.by_index(i).unwrap().name().is_ok_and(|n| n == "secrets.key") {
                found += 1;
            }
        }
        assert_eq!(found, 1, "exactly the install key entry, not a duplicate");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dest);
    }
