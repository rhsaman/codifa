#!/usr/bin/env bash
# Print the rustc warnings for the Tauri crate (one per line, with context).
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
touch src-tauri/src/main.rs
cd src-tauri || exit 1
cargo check 2>&1 | grep -A3 -E "^warning" | head -60
