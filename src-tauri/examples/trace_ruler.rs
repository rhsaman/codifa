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

/// Length of the longest shared byte prefix of two strings (at a char boundary).
///
/// This — not "are the two strings equal" — is what a prefix cache measures: a
/// prompt that only appends keeps its whole previous prefix cached, while a
/// prompt that changes a byte in the MIDDLE throws away everything after it.
fn common_prefix_len(a: &str, b: &str) -> usize {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let max = ab.len().min(bb.len());
    let mut i = 0;
    while i < max && ab[i] == bb[i] {
        i += 1;
    }
    // Never report a prefix that ends mid-character: the caller divides by the
    // prompt length and a bogus byte would silently skew the rate.
    while i > 0 && !a.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// First words of the explore sub-agent's system prompt row.
const SUB_PROMPT_START: &str = "You are the explore sub-agent";
/// First words of the main agent's system prompt row.
const MAIN_PROMPT_START: &str = "You are Codifa";
/// Sub-agent tool names that may appear in the traces.
const SUBAGENT_TOOLS: [&str; 2] = ["explore", "task"];
/// Read-only tools the agent's repeat guard (`lookup_key` in agent.rs) knows
/// about. A second IDENTICAL call is answered with a pointer to the earlier
/// body, so a repeat inside ONE run is measurable waste: the payload plus the
/// round-trip that carried it.
const LOOKUP_TOOLS: [&str; 10] = [
    "read",
    "grep",
    "glob",
    "find_symbol",
    "lsp_symbols",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_diagnostics",
    "explore",
];

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
    /// Sum of `detail.model_chars` — the size the MODEL actually received.
    model_chars: usize,
    /// How many of `calls` carried the field (older rows do not).
    model_rows: usize,
}

fn string_of(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Input tokens of one `llm` row (`tokens.input`).
fn tokens_input(row: &Value) -> u64 {
    row.get("tokens")
        .and_then(|t| t.get("input"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// How many of those input tokens the provider served from its prefix cache.
fn tokens_cached(row: &Value) -> u64 {
    row.get("tokens")
        .and_then(|t| t.get("cache_read"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
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
    let mut run_is_sub: BTreeMap<u64, bool> = BTreeMap::new();
    let mut calls_per_run: BTreeMap<u64, usize> = BTreeMap::new();
    // Per run, every llm row in ORDER: the first call can never hit the cache
    // (nothing precedes it), so the only avoidable waste inside a run is a LATER
    // call whose prefix diverged. Keeping the rows lets us bill the two apart.
    let mut rows_per_run: BTreeMap<u64, Vec<Value>> = BTreeMap::new();
    let mut by_run = 0usize;
    let mut by_position = 0usize;
    let mut ambiguous = Usage::default();
    let mut saw_sub_prompt = false;
    let mut sub_runs = 0usize;
    let mut turn = 0usize;
    let mut explores_per_turn: BTreeMap<usize, usize> = BTreeMap::new();
    let mut seen_explores: BTreeMap<(usize, String), usize> = BTreeMap::new();
    // (run id, "tool|normalized args") -> (calls, total model chars). Needs a
    // run id to be meaningful: without one, two identical calls in one FILE may
    // belong to two different runs. Empty on stale traces, so the section below
    // simply does not print.
    let mut lookup_dups: BTreeMap<(u64, String), (usize, usize)> = BTreeMap::new();
    let mut unnamed_tools = 0usize;
    let mut errors = 0usize;
    // Deterministic levers that fired: counted from `detail.levers`, which the
    // backend writes from the result text itself. Before this flag the only
    // evidence was the round count, which cannot tell "the lever fired and the
    // model ignored it" from "the lever never ran" — the exact confusion that
    // made the textual single-call hint look effective for eight phases.
    let mut lever_fires: BTreeMap<String, (usize, usize)> = BTreeMap::new();

    for row in &rows {
        let kind = row.get("kind").and_then(Value::as_str).unwrap_or_default();
        // Exact attribution first: every row written by a stamped store names
        // the run that produced it. `None` means the row predates the field (or
        // came from an unstamped store) — only then fall back to position.
        let run = row.get("run").and_then(Value::as_u64).filter(|r| *r > 0);
        match kind {
            "prompt" => {
                let p = string_of(row, "prompt");
                if p.starts_with(SUB_PROMPT_START) {
                    // An explore run opens here. It is closed by the parent's
                    // explore/task tool row further down, but which sibling that
                    // card belongs to is unknowable — hence `run_is_sub`.
                    saw_sub_prompt = true;
                    sub_runs += 1;
                    if let Some(r) = run {
                        run_is_sub.insert(r, true);
                    }
                } else if p.starts_with(MAIN_PROMPT_START) {
                    turn += 1;
                    if let Some(r) = run {
                        run_is_sub.insert(r, false);
                    }
                }
            }
            "llm" => {
                *calls_per_run.entry(run.unwrap_or(0)).or_default() += 1;
                if let Some(r) = run {
                    rows_per_run.entry(r).or_default().push(row.clone());
                }
                match run.and_then(|r| run_is_sub.get(&r).copied()) {
                    Some(sub) => {
                        by_run += 1;
                        if sub {
                            sub_total.add(row);
                        } else {
                            main.add(row);
                        }
                    }
                    // No run id: the row predates the field. Position is only
                    // PROOF of main before the first sub-agent prompt exists —
                    // after that, a still-running sibling and a continuing main
                    // are indistinguishable in the file, so those rows are
                    // reported as ambiguous instead of being guessed into main.
                    None => {
                        by_position += 1;
                        if saw_sub_prompt {
                            ambiguous.add(row);
                        } else {
                            main.add(row);
                        }
                    }
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
                // `result` is the UI echo (capped at 4K/8K), NOT what the model
                // received. `model_chars` is the real model-side size; it is
                // absent on rows recorded before that field existed, so track the
                // coverage and never present a partial sum as the total.
                let model_chars = detail.get("model_chars").and_then(Value::as_u64);
                let stat = tools.entry(name.clone()).or_default();
                stat.calls += 1;
                stat.chars += chars;
                if let Some(mc) = model_chars {
                    stat.model_chars += mc as usize;
                    stat.model_rows += 1;
                }
                if sub {
                    stat.sub_calls += 1;
                }
                for lever in detail
                    .get("levers")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    let e = lever_fires.entry(lever.to_string()).or_default();
                    e.0 += 1;
                    e.1 += model_chars.unwrap_or(0) as usize;
                }
                // Duplicate lookups INSIDE one run: identical arguments to a
                // read-only tool that the agent's own guard should have answered
                // with a pointer. Tracked per run id — position cannot tell two
                // sibling explores apart.
                if let Some(r) = run {
                    let args = string_of(row, "prompt");
                    if LOOKUP_TOOLS.contains(&name.as_str()) && !args.is_empty() {
                        // Re-serialized so key order cannot split one key in two.
                        let norm = serde_json::from_str::<Value>(&args)
                            .ok()
                            .and_then(|v| serde_json::to_string(&v).ok())
                            .unwrap_or(args);
                        let e = lookup_dups
                            .entry((r, format!("{name}|{norm}")))
                            .or_insert((0, 0));
                        e.0 += 1;
                        e.1 += model_chars.unwrap_or(0) as usize;
                    }
                }
                // A parent-side explore/task row closes the run it paid for.
                if !sub && SUBAGENT_TOOLS.contains(&name.as_str()) {
                    // The card only proves the run is over; `run_is_sub` already
                    // knows the split, so no step accumulator is needed here.
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
    if ambiguous.calls > 0 {
        // These rows carry no `run` id (recorded before the field existed) and
        // sit after the first sub-agent prompt, where a concurrent sibling and a
        // continuing main look identical in the file. The old ruler counted them
        // as main, which inflated main by up to 34x in practice (one trace had
        // 34 "main" calls of which exactly 1 was main) and collapsed its
        // reported cache rate. They are printed, never billed.
        println!(
            "      unassigned   : {} calls  input={}  output={}  (no run id — not billed to main)",
            ambiguous.calls, ambiguous.input, ambiguous.output
        );
    }
    println!(
        "   C) explore runs  : {} runs, {} calls total  input={}  output={}",
        sub_runs,
        sub_total.calls,
        sub_total.input,
        sub_total.output
    );
    if sub_runs > 0 && sub_total.calls == 0 {
        // Every sub-agent prompt row opened a run, but no llm row could be
        // billed to one: the rows carry no `run` id. Saying "0 calls" alone
        // would read as "the explore runs were free".
        println!(
            "      ^ explore spend : unmeasurable in this trace (rows predate `run`; see unassigned)"
        );
    }
    // Attribution honesty: rows only become exactly attributable once the store
    // stamps `run`. Older traces fall back to position, which misbills a still
    // running sibling's calls to main the moment the first sibling's card closes.
    if by_run + by_position > 0 {
        println!(
            "      attribution  : {} call(s) by run id, {} by position{}",
            by_run,
            by_position,
            if by_run == 0 {
                "  [stale trace: only pre-sub rows are provably main]"
            } else {
                ""
            }
        );
    }
    if !run_is_sub.is_empty() {
        // Per-run step counts, now derived from the exact run id instead of a
        // single-slot accumulator that only closed a run when its parent card
        // appeared. That version disagreed with `C)` (28 calls over 4 runs
        // printed as min=7 median=21 max=21) because runs closed by the next
        // prompt row or still open at EOF were counted in `sub_runs` but never
        // pushed onto the vector.
        let mut sub_steps: Vec<usize> = run_is_sub
            .iter()
            .filter(|(_, is_sub)| **is_sub)
            .map(|(r, _)| calls_per_run.get(r).copied().unwrap_or(0))
            .collect();
        if !sub_steps.is_empty() {
            let min = sub_steps.iter().copied().min().unwrap_or(0);
            let max = sub_steps.iter().copied().max().unwrap_or(0);
            println!(
                "      steps/run    : min={} median={} max={}  ({} run(s) closed)",
                min,
                median(&mut sub_steps),
                max,
                sub_steps.len()
            );
        }
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
            "      {:<14} calls={:<5} chars={:<9} model={:<9} in-sub={}",
            if name.is_empty() { "(unknown)" } else { name.as_str() },
            s.calls,
            s.chars,
            // A partial sum is labelled, never presented as the total.
            if s.model_rows == s.calls {
                format!("{}", s.model_chars)
            } else {
                format!("{}({}/{})", s.model_chars, s.model_rows, s.calls)
            },
            s.sub_calls
        );
    }
    let mut by_chars: Vec<(&String, &ToolStat)> = tools.iter().collect();
    by_chars.sort_by(|a, b| b.1.chars.cmp(&a.1.chars));
    println!("   E) biggest output (UI echo):");
    for (name, s) in by_chars.iter().take(5) {
        println!(
            "      {:<14} chars={:<9} calls={}",
            if name.is_empty() { "(unknown)" } else { name.as_str() },
            s.chars,
            s.calls
        );
    }
    // Size the MODEL received. `result` is the UI echo (capped at 4K/8K), so
    // ranking by it measures the wrong thing — this ranking is the one that
    // says which tool actually floods the context.
    let mut by_model: Vec<(&String, &ToolStat)> = tools
        .iter()
        .filter(|(_, s)| s.model_rows > 0)
        .collect();
    by_model.sort_by(|a, b| b.1.model_chars.cmp(&a.1.model_chars));
    if !by_model.is_empty() {
        println!("   E2) biggest MODEL output (detail.model_chars):");
        for (name, s) in by_model.iter().take(5) {
            println!(
                "      {:<14} model={:<9} calls={:<5} avg={}",
                if name.is_empty() { "(unknown)" } else { name.as_str() },
                s.model_chars,
                s.calls,
                s.model_chars / s.model_rows.max(1)
            );
        }
    }
    println!(
        "   F) reads         : {}",
        tools.get("read").map(|s| s.calls).unwrap_or(0)
    );
    if !lever_fires.is_empty() {
        // One line per lever, with the model-side payload it carried: the lever
        // is only a WIN when the payload it appended replaces a later round.
        println!("   F2) levers fired (deterministic, backend-decided):");
        for (lever, (n, chars)) in &lever_fires {
            println!("      {lever:<26} fired={n:<5} model payload={chars}");
        }
    }
    // The lone-call lever is invisible in `levers` (it rides an existing result
    // instead of producing one), and `hints_delivered` folds it together with
    // the discovery-streak nudges — so a rise there cannot answer whether THIS
    // lever spoke. Pulled from its own counter: a high number means the model
    // kept spending one call per round despite being told, which is the shape
    // the lever exists to remove.
    let lone_hints: u64 = rows
        .iter()
        .filter_map(|r| r.get("detail"))
        .filter_map(|d| d.get("lone_call_hints"))
        .filter_map(|v| v.as_u64())
        .max()
        .unwrap_or(0);
    if lone_hints > 0 {
        println!("   F3) lone-call hints: {lone_hints} delivered this run");
    }
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
    // The same measure INSIDE one run, for the read-only tools the repeat guard
    // covers. An identical read/grep/lsp/glob in a single run is pure waste: the
    // payload is already in the context above, yet it is re-sent on every later
    // round-trip of that run.
    let mut dg: Vec<(&u64, &String, usize, usize)> = Vec::new();
    for ((r, k), v) in &lookup_dups {
        let (n, c) = (v.0, v.1);
        if n <= 1 {
            continue;
        }
        dg.push((r, k, n, c));
    }
    if !dg.is_empty() {
        dg.sort_by(|a, b| b.3.cmp(&a.3));
        let calls: usize = dg.iter().map(|(_, _, n, _)| n - 1).sum();
        // One copy is needed; the rest is waste. Sizes within a group differ, so
        // scale the group's total by the redundant fraction.
        let chars: usize = dg.iter().map(|(_, _, n, c)| c * (n - 1) / n).sum();
        println!(
            "      repeat lookups: {calls} redundant call(s), ~{chars} model chars inside one run ({} group(s))",
            dg.len()
        );
        for (r, k, n, c) in dg.iter().take(5) {
            let head: String = k.chars().take(72).collect();
            println!("        run {r} ×{n}: {head}…  ({c} chars total)");
        }
    }

    // --- Where the uncached input actually goes -------------------------------
    // The first call of a run can NEVER hit the prefix cache: nothing precedes
    // it. Every later call CAN, so its uncached tokens are the avoidable part.
    // Splitting the two per role tells the two possible fixes apart: "runs are
    // short, so each one pays a cold prefix" (structural) versus "the prefix
    // keeps breaking inside a run" (a bug).
    let mut cold = Usage::default();
    let mut warm = Usage::default();
    // (run, is_sub, calls, avoidable_uncached, prefix_breaks)
    let mut per_run_waste: Vec<(u64, bool, usize, usize, usize)> = Vec::new();
    // Break attribution, per role: a SHRINKING prompt (fold/compaction removed
    // context) must re-bill by construction, while a growing prompt that still
    // misses means bytes in the MIDDLE moved — a real prefix break we can fix.
    let (mut shrink_tok, mut shrink_n) = ([0u64; 2], [0usize; 2]);
    let (mut grow_tok, mut grow_n) = ([0u64; 2], [0usize; 2]);
    for (run, list) in &rows_per_run {
        if list.is_empty() {
            continue;
        }
        let sub = run_is_sub.get(run).copied().unwrap_or(false);
        let role = usize::from(sub);
        cold.add(&list[0]);
        let mut avoidable = 0u64;
        let mut breaks = 0usize;
        let mut prev_input = tokens_input(&list[0]);
        for row in &list[1..] {
            warm.add(row);
            let input = tokens_input(row);
            let cached = tokens_cached(row);
            let uncached = input.saturating_sub(cached);
            // A later call must pay for whatever was APPENDED since the previous
            // one (the new tool result); that part is not waste. Only the excess
            // above the growth means the prefix broke and everything behind it
            // was re-billed. A shrinking prompt (compaction/fold) legitimately
            // re-bills in full, so the growth floors at zero.
            let grew = input.saturating_sub(prev_input);
            let excess = uncached.saturating_sub(grew);
            avoidable += excess;
            if excess > input / 4 {
                breaks += 1;
                if input < prev_input {
                    shrink_tok[role] += excess;
                    shrink_n[role] += 1;
                } else {
                    grow_tok[role] += excess;
                    grow_n[role] += 1;
                }
            }
            prev_input = input;
        }
        per_run_waste.push((*run, sub, list.len(), avoidable as usize, breaks));
    }
    if cold.calls > 0 {
        let cold_pct = cold.cache_read * 100 / cold.input.max(1);
        let warm_pct = if warm.input > 0 {
            warm.cache_read * 100 / warm.input
        } else {
            0
        };
        println!(
            "      first call/run: {} input, {} cached ({}%)  [{} run(s) — unavoidable]",
            cold.input, cold.cache_read, cold_pct, cold.calls
        );
        println!(
            "      later calls   : {} input, {} cached ({}%)  [{} call(s)]",
            warm.input, warm.cache_read, warm_pct, warm.calls
        );
        // The number to drive to zero: uncached input on a call that had a
        // prefix available. Shown per role, since main and explore differ by an
        // order of magnitude.
        let mut waste_main = 0usize;
        let mut waste_sub = 0usize;
        let mut rebill_main = 0usize;
        let mut rebill_sub = 0usize;
        for (_, sub, _, waste, rebills) in &per_run_waste {
            if *sub {
                waste_sub += waste;
                rebill_sub += rebills;
            } else {
                waste_main += waste;
                rebill_main += rebills;
            }
        }
        println!(
            "      avoidable     : main {waste_main} ({rebill_main} prefix break(s)) · explore {waste_sub} ({rebill_sub} prefix break(s))"
        );
        per_run_waste.sort_by(|a, b| b.3.cmp(&a.3));
        for (run, sub, steps, waste, breaks) in per_run_waste.iter().filter(|r| r.3 > 0).take(5) {
            let role = if *sub { "explore" } else { "main" };
            println!(
                "        run {run} ({role}, {steps} call(s)): {waste} avoidable, {breaks} break(s)"
            );
        }
        println!(
            "      break cause  : main shrink {}/{} · grow {}/{}   explore shrink {}/{} · grow {}/{}",
            shrink_tok[0], shrink_n[0], grow_tok[0], grow_n[0],
            shrink_tok[1], shrink_n[1], grow_tok[1], grow_n[1]
        );
        // --- Does the in-run fold still PAY OFF? ------------------------------
        // MEASURED, not modelled. A `kind:"fold"` trace row now records every
        // fold (role, step, calls_left, before_tokens, removed chars). For each
        // fold we compare the ONE model call right before it with the ONE right
        // after it, in the same run:
        //
        //   cost  = uncached input of the call after the fold MINUS what the
        //           counterfactual (no fold) would have cost = the previous
        //           call's input, because with a stable cache that is all an
        //           appended round can bill. The excess is the re-bill the fold
        //           caused by moving bytes in the middle.
        //   gain  = the prompt shrinkage the fold bought on every remaining
        //           call. With a working prefix cache only the APPENDED part of
        //           a prompt is billed, so the saving is capped by the cache
        //           hit rate: gain = removed_tokens x calls_left x (1 - hit).
        //
        // If the previous fold-economy line is still printed anywhere it was a
        // pure counterfactual (no_fold = the run's LAST prompt size, measured
        // AFTER the fold had already shrunk it) — biased low, so it reported a
        // loss that could not be trusted. This replaces it with the real thing.
        {
            let folds: Vec<&Value> = rows
                .iter()
                .filter(|r| r.get("kind").and_then(Value::as_str) == Some("fold"))
                .collect();
            if !folds.is_empty() {
                // Per run, the ordered llm rows, so "the call after the fold"
                // can be found by call number. 1-based `call` in the fold row.
                let mut cost_total = 0i64;
                let mut gain_total = 0i64;
                let mut profitable = 0usize;
                let mut lossy = 0usize;
                for f in &folds {
                    let d = f.get("detail").cloned().unwrap_or(Value::Null);
                    let run = f.get("run").and_then(Value::as_u64).unwrap_or(0);
                    let call_no = d.get("call").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let calls_left = d.get("calls_left").and_then(Value::as_u64).unwrap_or(0) as i64;
                    let removed = d
                        .get("removed_tokens_est")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as i64;
                    let Some(list) = rows_per_run.get(&run) else { continue };
                    // `call` is 1-based; index of the call AFTER the fold.
                    let Some(after) = list.get(call_no) else { continue };
                    let before = list.get(call_no - 1);
                    let after_input = tokens_input(after) as i64;
                    let after_cache = tokens_cached(after) as i64;
                    let after_uncached = (after_input - after_cache).max(0);
                    let prev_input = before.map(|r| tokens_input(r) as i64).unwrap_or(0);
                    // The re-bill the fold caused: it may only charge the part
                    // the append alone would not have covered.
                    let cost = (after_uncached - prev_input).max(0);
                    let hit = if after_input > 0 {
                        after_cache as f64 / after_input as f64
                    } else {
                        0.0
                    };
                    let gain = ((removed as f64) * (calls_left.max(1) as f64) * (1.0 - hit)) as i64;
                    cost_total += cost;
                    gain_total += gain;
                    if gain >= cost {
                        profitable += 1;
                    } else {
                        lossy += 1;
                    }
                }
                let n = profitable + lossy;
                if n > 0 {
                    println!(
                        "      fold (real)  : {n} fold(s) · gain {gain_total} (shrink×calls left) · cost {cost_total} (re-bill) · net {}",
                        gain_total - cost_total
                    );
                    println!(
                        "                     profitable {profitable}/{n} · lossy {lossy}/{n}"
                    );
                } else {
                    // Folds were RECORDED but none could be matched to a pair of
                    // calls in its run (a run id missing from `rows_per_run`, or
                    // `call` past the end). Say so instead of printing nothing,
                    // which reads as "no folds happened".
                    println!(
                        "      fold (real)  : {} fold row(s) recorded, 0 could be paired with their run",
                        folds.len()
                    );
                }
            } else {
                // Silence here would be a LIE in the other direction: it reads as
                // "the fold never ran, so it never cost anything". Either the
                // build predates the `kind:"fold"` row (folds DID run, unmeasured)
                // or every fold is disabled. Both are worth seeing.
                println!(
                    "      fold (real)  : not measured — this trace has no fold row (build older than the fold trace, or folding is off)"
                );
            }
        }
    }

    // --- Prefix stability of messages[0] -------------------------------------
    // The prefix cache can only help from the first CHANGED byte onward. A
    // byte-stable system prompt (system+skills only, no plan/checklist) lets the
    // whole history behind it cache; a system prompt that changes every time
    // `update_plan` runs throws the prefix away on every turn. Measured before
    // the plan moved out of `messages[0]`: main 23.7% vs explore 85.9%.
    // Each role is compared only against the PREVIOUS prompt of the SAME role.
    // Comparing adjacent rows instead was wrong: a main turn is almost always
    // followed by an explore run, so `role == prev_role` almost never held and
    // the ruler printed "main 0/0" — no measurement at all.
    //
    // The role comes from `detail.mode` (what the agent actually recorded). The
    // old first-words guess is kept only as a fallback for traces written before
    // that field existed: the app supplies its own mode prompt via
    // `req.system_prompt`, whose text does NOT start with "You are Codifa", so
    // the guess dropped every app-driven main turn and a file with four distinct
    // main prefixes reported a single turn-prompt and no comparison at all.
    let mut prev_main: Option<String> = None;
    let mut prev_sub: Option<String> = None;
    let mut main_lens: Vec<usize> = Vec::new();
    // (common prefix with the previous main prompt, length of this prompt)
    let mut main_prefix: Vec<(usize, usize)> = Vec::new();
    let mut sub_prefix: Vec<(usize, usize)> = Vec::new();
    let mut plan_chars = 0usize;
    let mut role_from_mode = 0usize;
    let mut role_from_guess = 0usize;
    for row in &rows {
        if row.get("kind").and_then(Value::as_str) != Some("prompt") {
            continue;
        }
        let p = string_of(row, "prompt");
        if let Some(d) = row.get("detail") {
            plan_chars += d
                .get("plan_chars")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
        }
        let role_mode = row
            .get("detail")
            .and_then(|d| d.get("mode"))
            .and_then(Value::as_str);
        let is_sub = match role_mode {
            Some(m) => {
                role_from_mode += 1;
                m == "subagent"
            }
            None => {
                role_from_guess += 1;
                if p.starts_with(SUB_PROMPT_START) {
                    true
                } else if !p.starts_with(MAIN_PROMPT_START) {
                    // Pre-`mode` trace whose body matches neither anchor: it
                    // cannot be attributed, so it is counted as nothing rather
                    // than silently inflating `main`.
                    continue;
                } else {
                    false
                }
            }
        };
        if is_sub {
            if let Some(prev) = prev_sub.as_ref() {
                sub_prefix.push((common_prefix_len(prev, &p), p.len()));
            }
            prev_sub = Some(p);
        } else {
            if let Some(prev) = prev_main.as_ref() {
                main_prefix.push((common_prefix_len(prev, &p), p.len()));
            }
            main_lens.push(p.len());
            prev_main = Some(p);
        }
    }
    let main_stable = main_prefix.iter().filter(|(c, l)| c == l).count();
    let main_pairs = main_prefix.len();
    let sub_stable = sub_prefix.iter().filter(|(c, l)| c == l).count();
    let sub_pairs = sub_prefix.len();
    let unique_main: BTreeMap<usize, usize> =
        main_lens.iter().fold(BTreeMap::new(), |mut m, &l| {
            *m.entry(l).or_insert(0) += 1;
            m
        });
    println!(
        "   I) system prompt : main   {} chars over {} turn-prompt(s) — {} distinct size(s)",
        main_lens.last().copied().unwrap_or(0),
        main_lens.len(),
        unique_main.len()
    );
    if !unique_main.is_empty() {
        print!("      sizes       : ");
        for (len, n) in &unique_main {
            print!("{len}×{n}  ");
        }
        println!();
    }
    println!(
        "      byte-stable : main {}/{} consecutive turns, explore {}/{} rounds",
        main_stable, main_pairs, sub_stable, sub_pairs
    );
    println!(
        "      attribution : {} prompt row(s) by detail.mode, {} by first words (old trace)",
        role_from_mode, role_from_guess
    );
    if role_from_guess > 0 {
        println!(
            "                    [warning: rows attributed by first words — a main prompt sent by the app\n\
             \x20                    via req.system_prompt does not start with \"You are Codifa\" and would be lost]"
        );
    }
    // The percentage that actually governs the prefix cache: a prompt that only
    // APPENDS loses nothing (the shared head stays cached), a prompt that
    // changes a byte in the middle throws away everything after it.
    for (label, pairs) in [("main", &main_prefix), ("explore", &sub_prefix)] {
        if pairs.is_empty() {
            continue;
        }
        let sum: f64 = pairs
            .iter()
            .map(|(c, l)| if *l == 0 { 100.0 } else { 100.0 * *c as f64 / *l as f64 })
            .sum();
        let worst = pairs
            .iter()
            .map(|(c, l)| if *l == 0 { 100.0 } else { 100.0 * *c as f64 / *l as f64 })
            .fold(100.0f64, f64::min);
        println!(
            "      prefix kept : {label:<8} mean {:.1}%  worst {:.1}%  ({} comparison(s))",
            sum / pairs.len() as f64,
            worst,
            pairs.len()
        );
    }
    println!(
        "      plan chars  : {} total{} (the plan rides as a TRAILING message, so it does not break the prefix)",
        plan_chars,
        if plan_chars == 0 {
            " (old build: part of system_chars)"
        } else {
            ""
        }
    );
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
