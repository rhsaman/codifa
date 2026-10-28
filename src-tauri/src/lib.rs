//! Codifa as a LIBRARY.
//!
//! The app ships as a binary (the Tauri GUI), and `main.rs` owns the modules.
//! This thin facade declares the SAME modules so a bench/example can call into
//! them — `agent::run_turn` is the entry point the harness drives headless.
//!
//! Keeping the list in sync with `main.rs` is the one maintenance duty here:
//! a module added there and used by a bench is added here too. The bin keeps
//! its own copy of the tree, so nothing about the shipped app changes.

pub mod agent;
pub mod agent_terminals;
pub mod artifacts;
pub mod backup;
pub mod browser;
pub mod browser_driver;
pub mod computer;
pub mod screen;
pub mod trace;
pub mod retention;
pub mod scheduler;
pub mod lsp;
pub mod mcp;
pub mod mcp_index;
pub mod migrate;
pub mod memory;
pub mod backend_light;
pub mod commands;
pub mod compact;
pub mod docs;
pub mod websearch;
pub mod git;
pub mod llm;
pub mod media;
pub mod models;
pub mod oauth;
pub mod plans;
pub mod plugins;
pub mod providers;
pub mod repo;
pub mod appstate;
pub mod pty;
pub mod prefs;
pub mod secrets;
pub mod shell_env;
pub mod skills;
pub mod skill_router;
pub mod state;
pub mod store;
pub mod tools;
