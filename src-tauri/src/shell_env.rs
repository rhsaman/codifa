//! Login-shell PATH resolution.
//!
//! A GUI-launched app inherits a minimal PATH (no npx/node/uvx/rg), so child
//! processes — MCP stdio connectors, the Chromium binary lookup — could not
//! resolve them and silently failed. This merges the user's login-shell PATH
//! in, exactly as a terminal launch would.
//!
//! This used to live in `sidecar.rs`; it stayed behind when the Python sidecar
//! was removed because MCP and the browser still need it.

use std::path::PathBuf;

/// Merge the minimal GUI-launched PATH with the user's login-shell PATH so
/// child tools (docker, rg, MCP stdio servers, …) resolve like a terminal launch.
pub(crate) fn shell_path() -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(sep)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if !cfg!(windows) {
        for dir in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            let p = PathBuf::from(dir);
            if p.exists() && !parts.iter().any(|x| x == dir) {
                parts.push(dir.to_string());
            }
        }
        // Ask the login shell for the real user PATH (macOS GUI apps do not
        // load shell rc files). A slow/missing shell just keeps the defaults.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        });
        let probe = if cfg!(target_os = "macos") {
            format!("{shell} -l -c 'echo -n \"$PATH\"'")
        } else {
            format!("{shell} -c 'echo -n \"$PATH\"'")
        };
        if let Ok(out) = std::process::Command::new("sh")
            .arg("-c")
            .arg(&probe)
            .output()
        {
            let out = String::from_utf8_lossy(&out.stdout);
            for p in out.trim().split(sep) {
                if !p.is_empty() && !parts.iter().any(|x| x == p) {
                    parts.push(p.to_string());
                }
            }
        }
    }
    parts.join(&sep.to_string())
}
