//! Codifa — Tauri v2 shell.
//!
//! Replaces the Electron main process: spawns the Python sidecar, owns PTY
//! terminal sessions, and exposes the window.coder command surface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod browser;
mod computer;
mod trace;
mod retention;
mod scheduler;
mod lsp;
mod mcp;
mod memory;
mod backend_light;
mod commands;
mod compact;
mod websearch;
mod git;
mod llm;
mod plans;
mod appstate;
mod pty;
mod secrets;
mod sidecar;
mod skills;
mod skill_router;
mod state;
mod store;
mod tools;

use std::time::Duration;

use tauri::{Emitter, Listener, Manager};

/// Set right before the final close so the re-entrant CloseRequested is
/// allowed through (the native close then persists the window state).
struct Quitting(std::sync::atomic::AtomicBool);

/// A Finder-launched .app has no usable stdout/stderr, so every `println!` /
/// `eprintln!` (router, sidecar, mcp, …) was lost. Point both at
/// ~/.codifa/rust.log (rotated at 5 MB). Release builds only: `tauri dev`
/// keeps printing to the terminal.
#[cfg(unix)]
fn redirect_logs_to_file() {
    use std::os::unix::io::AsRawFd;
    if cfg!(debug_assertions) {
        return;
    }
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".codifa");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("rust.log");
    if std::fs::metadata(&path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("rust.log.1"));
    }
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        unsafe {
            libc::dup2(f.as_raw_fd(), 1);
            libc::dup2(f.as_raw_fd(), 2);
        }
    }
}

fn main() {
    #[cfg(unix)]
    redirect_logs_to_file();
    // The release profile uses panic=abort and is stripped, so a panic used to
    // kill the app with no message. Record file:line + message before the abort.
    std::panic::set_hook(Box::new(|info| {
        let line = format!("[panic] {info}\n");
        eprint!("{line}");
        if let Some(home) = dirs::home_dir() {
            let path = home.join(".codifa").join("panic.log");
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                use std::io::Write;
                let _ = f.write_all(line.as_bytes());
            }
        }
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Persist window size/position/fullscreen across restarts (parity with
        // the Electron build's saveWindowState).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(state::DataRoot::new())
        .manage(sidecar::SidecarState::new())
        .manage(pty::TerminalState::new())
        .manage(pty::TerminalMasters::new())
        .manage(Quitting(std::sync::atomic::AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            // store
            store::store_get,
            store::store_set,
            // dialogs
            commands::select_folder,
            commands::select_file,
            // overlay
            commands::overlay_selected,
            commands::overlay_cancel,
            // files
            commands::fs_list,
            commands::fs_walk,
            commands::fs_read,
            commands::fs_write,
            commands::fs_delete,
            commands::search_content,
            commands::read_image,
            commands::normalize_image,
            // data-root files
            commands::coder_list,
            commands::coder_read,
            commands::coder_write,
            commands::coder_delete,
            // capture
            commands::capture_screen,
            commands::capture_region,
            // import / clipboard / env
            commands::import_file,
            commands::copy_text,
            commands::get_env,
            // store / data path
            commands::get_data_path,
            commands::has_settings_file,
            commands::move_data_path,
            // sidecar
            commands::sidecar_url,
            commands::sidecar_probe,
            // secrets
            commands::secrets_get_key,
            // open external
            commands::open_external,
            commands::open_external_chrome,
            commands::open_file_external,
            commands::open_workspace_folder,
            commands::open_workspace_terminal,
            // oauth
            commands::google_sign_in,
            // quit flush
            commands::flush_persist_done,
            // updater
            commands::check_for_updates,
            commands::start_update,
            // window controls
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            // drag & drop parity
            commands::get_path_for_file,
            commands::window_under_cursor,
            // terminal
            pty::terminal_create,
            pty::terminal_list,
            pty::terminal_write,
            pty::terminal_resize,
            pty::terminal_kill,
        ])
        .setup(|app| {
            // Retention sweep: delete stale traces/checkpoints/uploads once
            // at startup (background thread — never blocks boot).
            {
                let root = state::get_data_root(app.handle());
                // Native schedule due-check loop (migrated from the Python
                // sidecar's _start_schedule_loop): polls every 30s, runs due
                // tasks headless through the native agent, records runs.
                scheduler::start_loop(root.clone());
                // Install the built-in MCP connectors (docker, playwright) that
                // are missing — migrated from the Python sidecar's
                // seed_builtin_mcp, which ran on every start.
                let seeded = skills::seed_builtin_mcp(&root);
                if !seeded.is_empty() {
                    println!("[mcp] seeded builtin connectors: {}", seeded.join(", "));
                }
                // Seed/re-sync the shipped built-in skills (migrated from the
                // Python sidecar's sync_builtin_skills). The shipped markdown
                // lives in the backend checkout / bundled resource dir.
                if let Some(backend) = sidecar::find_backend_dir(app.handle()) {
                    let seeded = skills::seed_builtin_skills(&root, &backend.join("skills"));
                    if !seeded.is_empty() {
                        println!("[skills] seeded builtin skills: {}", seeded.join(", "));
                    }
                }
                std::thread::spawn(move || {
                    let summary = retention::run_startup_sweep(&root);
                    println!("[{summary}]");
                });
            }
            // Start the Python sidecar in the background so the window paints
            // immediately; the renderer polls sidecar_url until it is ready.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = sidecar::start_sidecar(&handle) {
                    eprintln!("[sidecar] startup failed: {e}");
                    let _ = handle.emit("sidecar:dead", ());
                }
            });
            // Phase 2: native HTTP router on the public port. Light endpoints
            // (git, skills, mcp, system-prompts) are served in Rust; the rest
            // proxies to the Python sidecar. The renderer's sidecar_url now
            // returns THIS port.
            let router_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = backend_light::serve(router_handle) {
                    eprintln!("[router] failed to start: {e}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Second pass (flag set): let the native close proceed so the
                // window-state plugin persists size/position on real close.
                if window
                    .app_handle()
                    .state::<Quitting>()
                    .0
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    return;
                }
                // Quit-flush handshake: ask the renderer to persist state and
                // wait (bounded) for its ACK before allowing the close.
                let app = window.app_handle().clone();
                let window = window.clone();
                api.prevent_close();
                std::thread::spawn(move || {
                    let (tx, rx) = std::sync::mpsc::channel::<()>();
                    let listener_app = app.clone();
                    std::thread::spawn(move || {
                        let _ = listener_app.listen_any("flush-persist-done-ack", move |_| {
                            let _ = tx.send(());
                        });
                    });
                    let _ = window.emit("flush-persist", ());
                    let _ = rx.recv_timeout(Duration::from_secs(5));
                    // Persist any coalesced store write before teardown.
                    store::flush_pending(&app);
                    // Stop sidecar + terminals, then close for real. The flag
                    // lets the re-entrant CloseRequested through, and the
                    // native close path saves the window state.
                    sidecar::stop_sidecar(&app, 5000);
                    pty::kill_all_terminal_sessions(&app);
                    // Chromium sessions are per-chat and outlive the panel, so
                    // they must be reaped here or every visited chat leaves a
                    // browser process behind.
                    browser::kill_all_sessions();
                    app.state::<Quitting>()
                        .0
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    let _ = window.close();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
