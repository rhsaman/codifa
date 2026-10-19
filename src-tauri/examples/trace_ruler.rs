//! Trace ruler — read-only token and round-trip accounting over the agent traces.
//!
//! Usage:
//!     cargo run --example trace_ruler                  # newest trace file
//!     cargo run --example trace_ruler -- all           # every trace file
//!     cargo run --example trace_ruler -- <path.jsonl>  # one file
//!
//! Storage: `{CODER_DATA_DIR|~/.codifa}/traces/{chat_id}.jsonl`, one JSON object
//! per line, append-only (see `src/trace.rs`). Rows are attributed to the main
//! agent or to one explore run purely by ORDER: the `id` field (`t<N>`) comes
//! from a process-global counter and is not stable across restarts, so it is
//! never used as a key here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// First words of the explore sub-agent's system prompt row.
const SUB_PROMPT_START: &str = "You are the explore sub-agent";
/// First words of the main agent's system prompt row.
const MAIN_PROMPT_START: &str = "You are Codifa";
/// Sub-agent tool names that may appear in the traces.
const SUBAGENT_TOOLS: [&str; 2] = ["explore", "task"];

/// Mirrors `trace::traces_dir`: `CODER_DATA_DIR` wins, else `~/.codifa`. The
/// Settings data-root pointer is deliberately NOT consulted — neither is it in
/// the app process itself.
fn traces_dir() -> Option<PathBuf> {
    let root = match std::env::var("CODER_DATA_DIR") {
        Ok(r) if !r.is_empty() => PathBuf::from(r),
        _ => dirs::home_dir()?.join(".codifa"),
    };
    Some(root.join("traces"))
}

#[derive(Default, Clone, Copy)]
struct Usage {
    calls: usize,
    input: u64,
    output: u64,
    /// Input tokens the provider served from its prefix cache. Already counted
    /// inside `input` (so `input` stays the real billed number) — tracked here
    /// to report a hit RATE.
    cache_read: u64,
    /// Calls whose response carried a cache field at all. A gateway that never
    /// reports one would otherwise look like a 0% hit rate instead of "not
    /// measured".
    cache_reported: usize,
}

impl Usage {
    fn add(&mut self, row: &Value) {
        self.calls += 1;
        if let Some(t) = row.get("tokens") {
            self.input += t.get("input").and_then(Value::as_u64).unwrap_or(0);
            self.output += t.get("output").and_then(Value::as_u64).unwrap_or(0);
            match t.get("cache_read").and_then(Value::as_u64) {
                // Older traces predate the field: leave it out of the rate.
                Some(v) => {
                    self.cache_read += v;
                    self.cache_reported += 1;
                }
                None => {}
            }
        }
    }

    /// "1,234 of 5,678 (21%)" or a clear "not reported" — never a fake 0%.
    fn cache_line(&self) -> String {
        if self.cache_reported == 0 {
            return "not reported by this gateway".to_string();
        }
        let pct = if self.input > 0 {
            self.cache_read * 100 / self.input
        } else {
            0
        };
        format!(
            "{} of {} ({}%)  [reported on {}/{} calls]",
            self.cache_read, self.input, pct, self.cache_reported, self.calls
        )
    }
}

#[derive(Default)]
struct ToolStat {
    calls: usize,
    chars: usize,
    sub_calls: usize,
}

fn string_of(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn median(values: &mut [usize]) -> usize {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    values[values.len() / 2]
}

fn list_jsonl(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .collect()
}

fn report(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        println!("!! cannot read {}", path.display());
        return;
    };
    let rows: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();

    let mut main = Usage::default();
    let mut sub_total = Usage::default();
    let mut tools: BTreeMap<String, ToolStat> = BTreeMap::new();
    let mut sub_steps: Vec<usize> = Vec::new();
    let mut cur_sub = Usage::default();
    let mut sub_runs = 0usize;
    let mut in_sub = false;
    let mut turn = 0usize;
    let mut explores_per_turn: BTreeMap<usize, usize> = BTreeMap::new();
    let mut seen_explores: BTreeMap<(usize, String), usize> = BTreeMap::new();
    let mut unnamed_tools = 0usize;
    let mut errors = 0usize;

    for row in &rows {
        let kind = row.get("kind").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "prompt" => {
                let p = string_of(row, "prompt");
                if p.starts_with(SUB_PROMPT_START) {
                    // An explore run opens here and is closed by the parent's
                    // explore/task tool row further down.
                    in_sub = true;
                    sub_runs += 1;
                    cur_sub = Usage::default();
                } else if p.starts_with(MAIN_PROMPT_START) {
                    in_sub = false;
                    turn += 1;
                }
            }
            "llm" => {
                if in_sub {
                    cur_sub.add(row);
                    sub_total.add(row);
                } else {
                    main.add(row);
                }
            }
            "tool" => {
                let detail = row.get("detail").cloned().unwrap_or(Value::Null);
                let name = detail
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let sub = detail
                    .get("sub")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if name.is_empty() {
                    unnamed_tools += 1;
                }
                if row.get("error").map(|e| !e.is_null()).unwrap_or(false) {
                    errors += 1;
                }
                let chars = string_of(row, "result").chars().count();
                let stat = tools.entry(name.clone()).or_default();
                stat.calls += 1;
                stat.chars += chars;
                if sub {
                    stat.sub_calls += 1;
                }
                // A parent-side explore/task row closes the run it paid for.
                if !sub && SUBAGENT_TOOLS.contains(&name.as_str()) {
                    if in_sub {
                        sub_steps.push(cur_sub.calls);
                        in_sub = false;
                    }
                    *explores_per_turn.entry(turn).or_default() += 1;
                    let args: Value =
                        serde_json::from_str(&string_of(row, "prompt")).unwrap_or(Value::Null);
                    let key = args
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    *seen_explores.entry((turn, key)).or_default() += 1;
                }
            }
            _ => {}
        }
    }

    let total_input = main.input + sub_total.input;
    let total_output = main.output + sub_total.output;
    let total_usage = Usage {
        calls: main.calls + sub_total.calls,
        input: total_input,
        output: total_output,
        cache_read: main.cache_read + sub_total.cache_read,
        cache_reported: main.cache_reported + sub_total.cache_reported,
    };
    let dup_groups = seen_explores.values().filter(|v| **v > 1).count();
    let dup_rows: usize = seen_explores
        .values()
        .filter(|v| **v > 1)
        .map(|v| v - 1)
        .sum();

    println!("\n== {} ({} rows)", path.display(), rows.len());
    println!(
        "   A) model calls   : {}   input={}  output={}{}",
        main.calls + sub_total.calls,
        total_input,
        total_output,
        if total_output > 0 {
            format!("  (in:out = {}:1)", total_input / total_output)
        } else {
            String::new()
        }
    );
    println!(
        "   B) main agent    : {} calls  input={}  output={}",
        main.calls, main.input, main.output
    );
    println!(
        "   C) explore runs  : {} runs, {} calls total  input={}  output={}",
        sub_runs,
        sub_total.calls,
        sub_total.input,
        sub_total.output
    );
    if !sub_steps.is_empty() {
        let min = sub_steps.iter().copied().min().unwrap_or(0);
        let max = sub_steps.iter().copied().max().unwrap_or(0);
        println!(
            "      steps/run    : min={} median={} max={}",
            min,
            median(&mut sub_steps),
            max
        );
    }
    println!(
        "   D) tool calls    : {}  (unnamed/unknown: {}, rows with error: {})",
        tools.values().map(|s| s.calls).sum::<usize>(),
        unnamed_tools,
        errors
    );
    let mut by_calls: Vec<(&String, &ToolStat)> = tools.iter().collect();
    by_calls.sort_by(|a, b| b.1.calls.cmp(&a.1.calls));
    for (name, s) in by_calls.iter().take(8) {
        println!(
            "      {:<14} calls={:<5} chars={:<9} in-sub={}",
            if name.is_empty() { "(unknown)" } else { name.as_str() },
            s.calls,
            s.chars,
            s.sub_calls
        );
    }
    let mut by_chars: Vec<(&String, &ToolStat)> = tools.iter().collect();
    by_chars.sort_by(|a, b| b.1.chars.cmp(&a.1.chars));
    println!("   E) biggest output:");
    for (name, s) in by_chars.iter().take(5) {
        println!(
            "      {:<14} chars={:<9} calls={}",
            if name.is_empty() { "(unknown)" } else { name.as_str() },
            s.chars,
            s.calls
        );
    }
    println!(
        "   F) reads         : {}",
        tools.get("read").map(|s| s.calls).unwrap_or(0)
    );
    // The prefix-cache hit rate is the number that says whether the gateway is
    // re-billing the same system prompt + tool array on every round-trip.
    println!("   H) prefix cache  : all   {}", total_usage.cache_line());
    println!("      main          : {}", main.cache_line());
    if sub_total.calls > 0 {
        println!("      explore       : {}", sub_total.cache_line());
    }
    println!(
        "   G) explores/turn : {:?}",
        explores_per_turn
    );
    println!(
        "      duplicates   : {} wasted run(s) in {} group(s)",
        dup_rows, dup_groups
    );
    for ((t, key), n) in seen_explores.iter().filter(|(_, n)| **n > 1) {
        let head: String = key.chars().take(70).collect();
        println!("        turn {t} ×{n}: {head}…");
    }
}

fn main() {
    let arg = std::env::args().nth(1);
    let Some(dir) = traces_dir() else {
        eprintln!("trace_ruler: no trace directory (no CODER_DATA_DIR and no HOME)");
        return;
    };
    let files: Vec<PathBuf> = match arg.as_deref() {
        Some("all") => {
            let mut all = list_jsonl(&dir);
            all.sort();
            all
        }
        Some(one) => vec![PathBuf::from(one)],
        None => list_jsonl(&dir)
            .into_iter()
            .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())
            .into_iter()
            .collect(),
    };
    if files.is_empty() {
        println!("no trace files under {}", dir.display());
        return;
    }
    println!("trace dir: {}", dir.display());
    for file in &files {
        report(file);
    }
}
