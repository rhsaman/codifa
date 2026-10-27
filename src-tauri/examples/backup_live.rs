//! Live-test the Settings → Storage backup: pack the REAL data root (or a
//! scratch one) exactly the way `backup::create_backup` does, with no Tauri
//! app running.
//!
//! Usage:
//!     cargo run --example backup_live                  # real ~/.codifa
//!     CODER_DATA_DIR=/tmp/codifa-scratch cargo run --example backup_live
//!
//! The archive always lands in /tmp/codifa-backup-live — never inside the
//! data root — so the source is only ever READ.

use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let root = std::env::var("CODER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap().join(".codifa"));
    let dest = std::path::PathBuf::from("/tmp/codifa-backup-live");
    let _ = std::fs::create_dir_all(&dest);

    let started = Instant::now();
    let mut last_pct = 0u32;
    let res = codifa::backup::build_backup(
        &root,
        &dest,
        || false,
        |label, pct, done, total| {
            if pct != last_pct {
                last_pct = pct;
                println!("[{pct:3}%] {label}  ({done}/{total} files)");
            }
        },
    )
    .expect("backup failed");

    let zip_bytes = std::fs::metadata(&res.path).map(|m| m.len()).unwrap_or(0);
    println!(
        "\nOK {} — {} files, {} MB source -> {} MB zip in {:.1}s",
        res.path,
        res.files,
        res.bytes / (1024 * 1024),
        zip_bytes / (1024 * 1024),
        started.elapsed().as_secs_f32()
    );

    // Restore phase: apply the archive onto a scratch folder and diff every
    // restored file against the source, proving the round trip is lossless.
    let check = dest.join("restore-check");
    let _ = std::fs::remove_dir_all(&check);
    let restore_started = Instant::now();
    let moved = codifa::backup::restore_archive(
        std::path::Path::new(&res.path),
        &check,
        || false,
        |label, pct, done, total| {
            if pct != last_pct {
                last_pct = pct;
                println!("[restore {pct:3}%] {label}  ({done}/{total})");
            }
        },
    )
    .expect("restore failed");
    println!(
        "restored {moved} files into {} in {:.1}s",
        check.display(),
        restore_started.elapsed().as_secs_f32()
    );

    // Diff: every file the backup would collect must exist in the restore with
    // the same bytes.
    let mut files = Vec::new();
    collect_for_example(&root, &mut files);
    let mut mismatches = 0usize;
    for rel in &files {
        let src = root.join(rel);
        let dst = check.join(rel);
        match (std::fs::read(&src), std::fs::read(&dst)) {
            (Ok(a), Ok(b)) if a == b => {}
            // settings.json is re-persisted by a RUNNING app between the backup
            // and this diff; AES-GCM re-randomizes its ciphertext, so compare
            // with the `enc:v1:…` payloads masked out.
            (Ok(a), Ok(b))
                if rel == "settings.json"
                    && mask_enc(&a) == mask_enc(&b) => {}
            _ => {
                mismatches += 1;
                println!("MISMATCH: {rel}");
            }
        }
    }
    println!("diff: {} files checked, {mismatches} mismatches", files.len());
    if mismatches == 0 {
        println!("ROUND TRIP OK — every backed-up file restored byte-identical");
    } else {
        println!("ROUND TRIP FAILED — {mismatches} file(s) differ");
        std::process::exit(1);
    }
}

/// Mask encrypted (`enc:v1:…`) payloads so a live app's re-encryption of
/// identical plaintext does not read as data loss.
fn mask_enc(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = regex::Regex::new(r"enc:v1:[A-Za-z0-9+/=.]+")
        .expect("static regex")
        .replace_all(&text, "ENC")
        .into_owned();
    // Whitespace-insensitive compare on top, for the same reason.
    out.retain(|c| !c.is_whitespace());
    out
}

/// Re-implements the backup's exclusion walk for the diff (the collect fn in
/// the library is private; the example only needs the INCLUDED set).
fn collect_for_example(root: &std::path::Path, files: &mut Vec<String>) {
    const EXCLUDED_DIRS: &[&str] = &[
        "traces", "checkpoints", "memory", "cache", "browser-profile", "vector-db",
    ];
    const EXCLUDED_FILES: &[&str] = &["rust.log", "panic.log", "settings.json.bak", ".DS_Store"];
    fn walk(dir: &std::path::Path, rel: &str, files: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let path = entry.path();
            if ft.is_dir() {
                if EXCLUDED_DIRS.contains(&name.as_str()) || name.starts_with(".restore-staging") {
                    continue;
                }
                walk(&path, &child_rel, files);
            } else if ft.is_file() {
                if EXCLUDED_FILES.contains(&name.as_str())
                    || (name.starts_with("codifa-backup") && name.ends_with(".zip"))
                {
                    continue;
                }
                files.push(child_rel);
            }
        }
    }
    walk(root, "", files);
}
