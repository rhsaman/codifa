//! Codifa — Tauri v2 shell.
//!
//! Replaces the Electron main process: spawns the Python sidecar, owns PTY
//! terminal sessions, and exposes the window.coder command surface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod trace;
mod retention;
mod lsp;
mod memory;
mod backend_light;
mod commands;
mod compact;
mod git;
mod llm;
mod pty;
mod secrets;
mod sidecar;
mod skills;
mod state;
mod store;
mod tools;

use std::time::Duration;

use tauri::{Emitter, Listener, Manager};

/// Set right before the final close so the re-entrant CloseRequested is
/// allowed through (the native close then persists the window state).
struct Quitting(std::sync::atomic::AtomicBool);

fn main() {
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
