//! LIVE batching bench — a measurement harness, not a CI gate.
//!
//! Runs ONE real agent turn against a REAL provider (taken from the user's
//! own `~/.codifa/settings.json`) on a task with several INDEPENDENT lookups,
//! then reports the per-step tool-call grouping. Its purpose is to measure the
//! round-trip levers (the system-prompt BATCH rule, the lone-call hint
//! whitelist) against the traced baseline: on the Oct 29/30 corpus 51% of
//! tool rounds carried exactly ONE call (192 of 376), with lone `grep` the
//! 3rd-largest group.
//!
//! No-op unless `CODIFA_LIVE_BENCH=1`, so plain `cargo test` never spends
//! tokens. Configuration:
//!   CODIFA_LIVE_BENCH=1            run the live turn
//!   CODIFA_LIVE_PROVIDER=<id>      settings.json provider id (default: the
//!                                  first provider that has a key + base URL)
//!   CODIFA_LIVE_MODEL=<id>         model id override (default: the provider
//!                                  row's model)
//!
//! The turn runs in ASK mode (write tools unbound, terminal writers refused)
//! on a throwaway data root, so it cannot touch the workspace or the user's
//! real store. API keys are read from settings.json and never printed.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use codifa::agent::{run_turn, AgentEvent, AgentRequest};
use serde_json::{json, Value};

fn data_root() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("codifa-live-bench-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn load_provider() -> Option<Value> {
    let settings_path = std::env::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".codifa/settings.json");
    let raw = std::fs::read_to_string(&settings_path).ok()?;
    let settings: Value = serde_json::from_str(&raw).ok()?;
    let providers = settings.get("providers")?.as_array()?.clone();
    let named = |p: &Value, id: &str| p.get("id").and_then(Value::as_str) == Some(id);
    let usable = |p: &Value| {
        p.get("baseUrl").and_then(Value::as_str).is_some_and(|b| !b.is_empty())
            && p.get("model").and_then(Value::as_str).is_some_and(|m| !m.is_empty())
            && !keys_of(p).is_empty()
    };
    match std::env::var("CODIFA_LIVE_PROVIDER").ok() {
        Some(id) => providers.into_iter().find(|p| named(p, &id)),
        None => providers.into_iter().find(usable),
    }
}

fn keys_of(p: &Value) -> Vec<String> {
    let one = p.get("apiKey").and_then(Value::as_str).unwrap_or("");
    let mut keys: Vec<String> = p
        .get("apiKeys")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if !one.is_empty() && !keys.iter().any(|k| k == one) {
        keys.insert(0, one.to_string());
    }
    keys.into_iter().filter(|k| !k.is_empty()).collect()
}

#[tokio::test]
async fn live_batching_bench() {
    if std::env::var("CODIFA_LIVE_BENCH").map(|v| v != "1").unwrap_or(true) {
        return; // not a live run — nothing to do in CI
    }
    let provider = load_provider().expect("no usable provider in ~/.codifa/settings.json");
    let pid = provider.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
    let kind = provider.get("kind").and_then(Value::as_str).unwrap_or("custom").to_string();
    let base = provider.get("baseUrl").and_then(Value::as_str).unwrap_or("").to_string();
    let model = std::env::var("CODIFA_LIVE_MODEL").unwrap_or_else(|_| {
        provider.get("model").and_then(Value::as_str).unwrap_or_default().to_string()
    });
    let keys = keys_of(&provider);
    assert!(!keys.is_empty(), "provider {pid} has no API key");
    assert!(!base.is_empty(), "provider {pid} has no base URL");
    assert!(!model.is_empty(), "no model resolved for provider {pid}");
    println!("bench: provider={pid} kind={kind} model={model}");

    // The task: five INDEPENDENT lookups in this repo. A batching agent
    // answers in ~2 model calls (one fan-out step + the final answer); a
    // one-call-per-step agent needs 6+. The minimum for comparison: 2.
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let prompt = "In this workspace, gather FIVE independent facts, then answer in five \
short lines: (1) the value and file:line of the constant that caps a main-agent \
turn's tool-loop iterations; (2) the name and value of the constant that caps a \
tool result forwarded to the model; (3) the file:line of the function that \
records an in-turn fold in the trace; (4) the name of the constant that sets how \
many history images get vision descriptions per turn; (5) one line saying what \
src-tauri/src/compact.rs owns and one line saying what src-tauri/src/trace.rs \
owns. Lookups are independent — do not do them one per step. No writes.";

    let req: AgentRequest = serde_json::from_value(json!({
        "provider": kind,
        "provider_id": pid,
        "model": model,
        "base_url": base,
        "api_key": keys[0],
        "api_keys": keys,
        "root": repo_root.to_str().unwrap(),
        "mode": "ask",
        "prompt": prompt,
        "history": [],
        "data_root": data_root().to_str().unwrap(),
        "timeout_secs": 180,
    }))
    .expect("build AgentRequest");

    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let mut emit = move |e: &AgentEvent| ev.lock().unwrap().push(e.to_json());
    let cancel: Arc<std::sync::atomic::AtomicBool> = Arc::new(Default::default());
    let started = Instant::now();
    let res = run_turn(&req, &mut emit, &cancel).await;
    let elapsed = started.elapsed();

    let evs = events.lock().unwrap().clone();
    // Group tool calls per model call: a step is everything between two Usage
    // events (sub=false = the main agent; sub=true is an explore side-call).
    let mut steps: Vec<Vec<String>> = vec![Vec::new()];
    let mut sub_calls = 0usize;
    let mut tokens = (0u64, 0u64, 0u64); // input, cached, output
    for e in &evs {
        match e["kind"].as_str() {
            Some("tool") => {
                steps
                    .last_mut()
                    .unwrap()
                    .push(e["name"].as_str().unwrap_or("?").to_string());
            }
            Some("usage") => {
                if e["sub"].as_bool() != Some(true) {
                    steps.push(Vec::new());
                    tokens.0 += e["input_tokens"].as_u64().unwrap_or(0);
                    tokens.1 += e["cache_read_tokens"].as_u64().unwrap_or(0);
                    tokens.2 += e["output_tokens"].as_u64().unwrap_or(0);
                } else {
                    sub_calls += 1;
                }
            }
            Some("error") => println!("bench: ERROR event: {}", e["content"]),
            _ => {}
        }
    }
    // ToolStart events arrive AFTER their call's Usage (the stream finalizes
    // before dispatch), so bucket N holds call N+1's tools: drop the leading
    // empty bucket the first Usage creates, and trailing empty buckets (the
    // final answer's usage).
    while steps.first().is_some_and(|s| s.is_empty()) {
        steps.remove(0);
    }
    while steps.last().is_some_and(|s| s.is_empty()) {
        steps.pop();
    }
    let tool_steps: Vec<&Vec<String>> = steps.iter().filter(|s| !s.is_empty()).collect();
    let lone = tool_steps.iter().filter(|s| s.len() == 1).count();
    let calls: usize = tool_steps.iter().map(|s| s.len()).sum();
    let ok = res.is_ok();
    let wall = elapsed.as_secs_f32();
    let n_steps = steps.len();
    let lone_ratio = 100.0 * lone as f32 / tool_steps.len().max(1) as f32;
    println!(
        "bench: turn ok={ok} wall={wall:.1}s steps={n_steps} tool_calls={calls} \
         lone_steps={lone}/{} lone_ratio={lone_ratio:.0}%",
        tool_steps.len()
    );
    for (i, s) in steps.iter().enumerate() {
        println!("bench:   step {} -> {:?}", i + 1, s);
    }
    println!(
        "bench: tokens in={} cached={} out={} explore_sub_calls={sub_calls}",
        tokens.0, tokens.1, tokens.2
    );
    let _ = std::fs::remove_dir_all(data_root());
}
