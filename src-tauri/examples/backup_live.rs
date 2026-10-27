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
}
