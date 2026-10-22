//! Codifa — Tauri v2 shell.
//!
//! Replaces the Electron main process: owns PTY terminal sessions, the native
//! HTTP router (backend_light), and the window.coder command surface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod artifacts;
mod browser;
mod browser_driver;
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
mod docs;
mod websearch;
mod git;
mod llm;
mod media;
mod models;
mod oauth;
mod plans;
mod plugins;
mod providers;
mod repo;
mod appstate;
mod pty;
mod secrets;
mod shell_env;
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
        .manage(pty::TerminalState::new())
        .manage(pty::TerminalMasters::new())
        .manage(Quitting(std::sync::atomic::AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            // store
            store::store_get,
            store::store_set,
            store::chat_get,
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
            commands::fs_copy,
            commands::fs_rename,
            commands::search_content,
            commands::read_image,
            commands::read_pdf_base64,
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
            // local backend endpoint (native router port)
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
            // One-shot storage migration (idempotent, guarded by schemaVersion):
            // move every chat body out of settings.json into its own file and
            // leave only an index row behind. Must run BEFORE any route or
            // command serves the store, and before the window loads, so the
            // renderer only ever sees the split layout.
            store::migrate_to_index(app.handle());
            // Language servers hold their project's whole index in memory, so
            // release the ones that go unused on a timer (not only on a
            // workspace switch). Never blocks boot: it sweeps in the background.
            lsp::start_idle_reaper();
            // Retention janitor: delete stale traces/checkpoints/uploads (TTL)
            // and trim oversized trace logs, once now and then every few hours.
            // A desktop app is often left open for days, so a startup-only
            // sweep never fires for that user — which is how the trace dir grows
            // until the disk fills. Owns its thread, so boot is never blocked.
            {
                let root = state::get_data_root(app.handle());
                // Prime the at-rest key while a handle still exists: the
                // scheduler and the router run on handle-free threads and must
                // still be able to decrypt provider keys from settings.json.
                secrets::prime_key(app.handle());
                // Native schedule due-check loop (migrated from the Python
                // sidecar's _start_schedule_loop): polls every 30s, runs due
                // tasks headless through the native agent, records runs.
                scheduler::start_loop(root.clone());
                // Install the built-in MCP connector (docker) that is missing
                // — migrated from the Python sidecar's seed_builtin_mcp, which
                // ran on every start — then drop the retired browser connector
                // from installs that were seeded before the native driver
                // replaced it.
                let seeded = skills::seed_builtin_mcp(&root);
                if !seeded.is_empty() {
                    println!("[mcp] seeded builtin connectors: {}", seeded.join(", "));
                }
                let retired = skills::retire_builtin_mcp(&root);
                if !retired.is_empty() {
                    println!("[mcp] retired builtin connectors: {}", retired.join(", "));
                }
                // Seed/re-sync the shipped built-in skills (migrated from the
                // Python sidecar's sync_builtin_skills). The shipped markdown
                // lives with the Rust app now (src-tauri/skills, bundled as the
                // `skills/` resource) — it is NOT part of the Python backend.
                if let Some(shipped) = skills::shipped_skills_dir(app.handle()) {
                    let seeded = skills::seed_builtin_skills(&root, &shipped);
                    if !seeded.is_empty() {
                        println!("[skills] seeded builtin skills: {}", seeded.join(", "));
                    }
                }
                // Runs a sweep immediately and keeps re-running it while the
                // app is open (see `start_janitor`), so the TTLs hold for a
                // session that is never restarted.
                retention::start_janitor(root);
            }
            // Kill any headless browser a PREVIOUS run left behind (a crash or
            // a forced quit skips the shutdown hook), then keep reaping the
            // idle one on a timer: without it a Chromium outlived its last tab
            // and its window, which is what made the machine run out of memory.
            browser::start_idle_reaper();
            // Native HTTP router on the public port — the app's only backend
            // now (the Python sidecar is gone). Light endpoints (git, skills,
            // mcp, docs, oauth, system-prompts) and the agent loop are served
            // here; the renderer's sidecar_url returns THIS port.
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
                    // Stop terminals, then close for real. The flag lets the
                    // re-entrant CloseRequested through, and the native close
                    // path saves the window state.
                    pty::kill_all_terminal_sessions(&app);
                    // Chromium sessions are per-chat and outlive the panel, so
                    // they must be reaped here or every visited chat leaves a
                    // browser process behind.
                    browser::kill_all_sessions();
                    // Language servers are the largest off-process memory the app
                    // holds (a warm tsserver/rrust-analyzer keeps a whole project
                    // index resident). Nothing released them on exit, so they
                    // survived the window as orphans.
                    lsp::shutdown_all();
                    app.state::<Quitting>()
                        .0
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    let _ = window.close();
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // RunEvent fires on EVERY shutdown path — Cmd-Q, `app.exit()` and an
            // OS terminate. Those bypass WindowEvent::CloseRequested entirely, so
            // the quit-flush handshake never ran and the last coalesced store
            // write (the chat the user had just sent) was lost: "the app closed
            // suddenly and my new chats were gone". Flushing here closes that gap
            // for every exit route, not just the titlebar close button.
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    store::flush_pending(app);
                    // Cmd-Q and `app.exit()` also bypass CloseRequested, so the
                    // Chromium must be reaped here too — otherwise those exits
                    // left a headless browser running with no window to close.
                    browser::kill_all_sessions();
                    // Same for language servers: a Cmd-Q that skipped the
                    // CloseRequested path left them (and their project indexes)
                    // running with no window to own them.
                    lsp::shutdown_all();
                }
                _ => {}
            }
        });
}
