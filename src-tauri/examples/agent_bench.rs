//! Agent benchmark — ONE task, measured identically on codifa and opencode.
//!
//! Usage:
//!     cargo run --release --example agent_bench                 # both agents
//!     cargo run --release --example agent_bench -- codifa       # one agent
//!     cargo run --release --example agent_bench -- opencode
//!     cargo run --release --example agent_bench -- --task <id>  # a different builtin task
//!
//! Why an example and not a shell script: codifa's agent entry point is
//! `agent::run_turn`, which is a library function — the shipped binary is the
//! GUI. Measuring codifa therefore means calling it in-process, and doing that
//! from the same harness that shells out to `opencode` is the only way both
//! sides run under identical conditions: same task text, same seed workspace,
//! same model, same wall-clock accounting.
//!
//! Fairness rules the harness enforces:
//!   * ONE task, copied fresh into a scratch workspace per run, so neither
//!     agent sees the other's edits and neither sees leftovers from a retry.
//!   * The SAME model string. codifa and opencode both reach
//!     `nvidia/deepseek-ai/deepseek-v4.1-flash`; a mismatch would make the
//!     comparison meaningless, so the harness refuses mismatched models
//!     unless `--allow-model-mismatch` is passed.
//!   * Token accounting is read from the SOURCE OF TRUTH on each side:
//!     codifa's own trace rows (`kind=llm` → `tokens`), opencode's own
//!     `step_finish` events (`tokens.input/output`). Neither number is
//!     estimated here.
//!   * "Steps" = model calls; "rounds" = model calls that requested tools.
//!     Both sides are counted by the same rule from their own event stream.
//!
//! Every metric the goal names is reported per agent and then compared.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// The shared model. Both agents must resolve this same string (or the same
/// upstream model behind it) for the comparison to mean anything.
///
/// Set `BENCH_MODEL` to override. Default: the river.ai model codifa's own
/// traces ran on, which is also the one the user asked for.
fn shared_model() -> String {
    std::env::var("BENCH_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string())
}

const DEFAULT_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash";

/// The provider opencode reads the shared model through. opencode has no river
/// provider of its own, so the harness registers it in opencode's config the
/// first time a run needs it (see [`ensure_opencode_river`]).
const OPENCODE_PROVIDER: &str = "river";

/// One benchmark task: the prompt plus the seed files that make it concrete.
struct Task {
    id: &'static str,
    /// The prompt handed VERBATIM to both agents.
    prompt: &'static str,
    /// Files written into the scratch workspace before the run starts.
    seed: &'static [(&'static str, &'static str)],
    /// Command whose exit status decides whether the run SOLVED the task.
    ///
    /// Without this gate the comparison is a lie: measured, opencode "finished"
    /// in 2 steps on 594 tokens while leaving `stats.py` wrong (its own test
    /// suite failed with `5.0 != 4`), so the cheap number was the price of NOT
    /// doing the work. A run that fails this check is reported as failed and
    /// never counted as a win, whatever its token count.
    verify: &'static str,
}

/// The built-in tasks. The default one is a small, self-contained build-mode
/// job: it forces reading (to find the bug), an edit (the fix), and a shell
/// check (the verification) — the three things whose round-trips this
/// benchmark exists to compare.
const TASKS: &[Task] = &[
    Task {
        id: "fix-add-and-test",
        prompt: "In this workspace, `stats.py` has a bug: `average` divides by the \
                 wrong count and crashes on an empty list. Fix both problems, then \
                 run the test file to confirm it passes. Report the final test output.",
        seed: &[
            (
                "stats.py",
                "def average(values):\n    total = sum(values)\n    return total / len(values) + 1\n\n\ndef maximum(values):\n    return max(values)\n",
            ),
            (
                "test_stats.py",
                "import unittest\n\nfrom stats import average, maximum\n\n\nclass TestStats(unittest.TestCase):\n    def test_average(self):\n        self.assertEqual(average([2, 4, 6]), 4)\n\n    def test_average_empty(self):\n        self.assertEqual(average([]), 0)\n\n    def test_maximum(self):\n        self.assertEqual(maximum([3, 9, 1]), 9)\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n",
            ),
        ],
        verify: "python3 -m unittest -q",
    },
    Task {
        id: "add-divide-and-test",
        prompt: "In this workspace, add a `divide(a, b)` function to `calc.py` that \
                 raises ValueError on division by zero, add a test for it in \
                 `test_calc.py`, then run the tests to confirm they pass.",
        seed: &[
            ("calc.py", "def add(a, b):\n    return a + b\n"),
            (
                "test_calc.py",
                "import unittest\n\nfrom calc import add\n\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n",
            ),
        ],
        verify: "python3 -m unittest -q",
    },
];

/// What one agent run produced. Every field is measured, not estimated.
#[derive(Debug, Default, Clone)]
struct RunMetrics {
    /// Model calls (codifa: `kind=llm` rows; opencode: `step_finish` events).
    steps: u64,
    /// Model calls that requested at least one tool.
    rounds: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    tool_calls: u64,
    wall: Duration,
    /// `Some(true)` when the task's own test suite passed on the produced
    /// workspace, `Some(false)` when it failed, `None` when it could not run.
    /// The comparison is only meaningful when both sides are `Some(true)`.
    solved: Option<bool>,
    /// Non-empty when the run failed; the metrics above are then partial.
    error: Option<String>,
}

impl RunMetrics {
    fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    /// Uncached input, i.e. what the provider actually had to prefill. This is
    /// the number a round-trip optimisation is supposed to move.
    fn uncached(&self) -> u64 {
        self.input_tokens.saturating_sub(self.cache_read_tokens)
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("agent_bench: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    if std::env::args().any(|a| a == "--probe") {
        return probe();
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut only: Option<String> = None;
    let mut task_id = TASKS[0].id.to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--task" => {
                i += 1;
                task_id = args
                    .get(i)
                    .ok_or_else(|| "--task needs an id".to_string())?
                    .clone();
            }
            other if other.starts_with("--") => {
                return Err(format!("unknown flag {other}"));
            }
            other => only = Some(other.to_string()),
        }
        i += 1;
    }

    let task = TASKS
        .iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("no task `{task_id}` (have: {:?})", task_ids()))?;

    let model = shared_model();
    println!("== agent_bench ==");
    println!("task   : {}", task.id);
    println!("model  : {model}");
    println!("prompt : {}", task.prompt);
    println!();

    let mut results: Vec<(&str, RunMetrics)> = Vec::new();
    let want_codifa = only.as_deref().map(|a| a == "codifa").unwrap_or(true);
    let want_opencode = only.as_deref().map(|a| a == "opencode").unwrap_or(true);

    if want_codifa {
        let m = bench_codifa(task, &model)?;
        report("codifa", &m);
        results.push(("codifa", m));
    }
    if want_opencode {
        let m = bench_opencode(task, &model)?;
        report("opencode", &m);
        results.push(("opencode", m));
    }

    if results.len() > 1 {
        compare(&results);
    }
    Ok(())
}

fn task_ids() -> Vec<&'static str> {
    TASKS.iter().map(|t| t.id).collect()
}

/// Report which endpoint each agent will call and whether it answers.
///
/// A benchmark that silently measures a failed request is worse than no
/// benchmark: both agents once reported `0 tokens / 0 steps` because the model
/// endpoint returned `402 insufficient_funds`, which is invisible in the summary
/// table. This checks the credential BEFORE a run so the failure is named.
fn probe() -> Result<(), String> {
    let model = shared_model();
    println!("== agent_bench --probe ==");
    println!("model: {model}");

    match codifa_provider(&model) {
        Ok((id, kind, base, key)) => {
            println!("\ncodifa   provider={id} kind={kind} base={base}");
            println!("         key   ={}... ({} chars)", &key[..key.len().min(8)], key.len());
            match probe_endpoint(&base, &key, &model) {
                Ok(msg) => println!("         result= {msg}"),
                Err(e) => println!("         result= FAILED: {e}"),
            }
        }
        Err(e) => println!("\ncodifa   provider= FAILED: {e}"),
    }

    let key = std::env::var("RIVER_API_KEY").unwrap_or_default();
    let base = std::env::var("RIVER_BASE_URL")
        .unwrap_or_else(|_| "https://api.river.ai/v1".to_string());
    println!("\nopencode provider=river base={base}");
    if key.is_empty() {
        println!("         result= FAILED: $RIVER_API_KEY is not set");
    } else {
        println!("         key   ={}... ({} chars)", &key[..key.len().min(8)], key.len());
        match probe_endpoint(&base, &key, &model) {
            Ok(msg) => println!("         result= {msg}"),
            Err(e) => println!("         result= FAILED: {e}"),
        }
    }
    Ok(())
}

/// One minimal chat completion, reporting the upstream status.
fn probe_endpoint(base: &str, key: &str, model: &str) -> Result<String, String> {
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    });
    let out = std::process::Command::new("curl")
        .args([
            "-s",
            "-w",
            "\n%{http_code}",
            "-H",
            &format!("Authorization: Bearer {key}"),
            "-H",
            "Content-Type: application/json",
            "-d",
            &body.to_string(),
            &url,
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text
        .rsplit_once('\n')
        .map(|(b, c)| (b.to_string(), c.trim().to_string()))
        .unwrap_or((text.to_string(), "?".to_string()));
    if code == "200" {
        Ok(format!("HTTP 200 — the endpoint serves the model"))
    } else {
        Err(format!("HTTP {code} — {}", body.trim().chars().take(300).collect::<String>()))
    }
}

/// Create a fresh scratch workspace with the task's seed files and return it.
///
/// A NEW directory per run is the point: a retry must not inherit the previous
/// attempt's edits, and the two agents must never share a tree.
fn make_workspace(task: &Task, agent: &str) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "codifa-bench-{}-{}-{stamp}",
        task.id, agent
    ));
    // `temp_dir()` ends in a separator, so `join` can leave a DOUBLE slash
    // (`.../T//codifa-bench-…`). That is not cosmetic: measured, opencode
    // resolved the doubled path to a different tree, reported every tool as
    // `completed`, and the file the harness verified was never touched — the
    // run was scored as a FAILURE while the identical command in the canonical
    // path passed its tests. Normalising the path once is what makes the two
    // sides measure the same directory.
    let dir = PathBuf::from(
        std::fs::canonicalize(dir.parent().unwrap_or(&dir))
            .unwrap_or_else(|_| dir.parent().unwrap_or(&dir).to_path_buf())
            .join(dir.file_name().unwrap_or_default()),
    );
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("clear {}: {e}", dir.display()))?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    for (name, body) in task.seed {
        let path = dir.join(name);
        std::fs::write(&path, body).map_err(|e| format!("seed {}: {e}", path.display()))?;
    }
    Ok(dir)
}

/// Run the task's own test suite in the produced workspace.
///
/// This is the benchmark's correctness gate: it is the difference between "the
/// agent was cheap" and "the agent was cheap AND right". A run whose workspace
/// fails its tests is marked failed and excluded from the win/lose verdict.
fn verify_workspace(task: &Task, dir: &Path) -> Option<bool> {
    let mut parts = task.verify.split_whitespace();
    let bin = parts.next()?;
    let args: Vec<&str> = parts.collect();
    let out = std::process::Command::new(bin)
        .args(&args)
        .current_dir(dir)
        .env("PATH", augmented_path())
        .output()
        .ok()?;
    Some(out.status.success())
}

fn solved_word(s: Option<bool>) -> &'static str {
    match s {
        Some(true) => "YES",
        Some(false) => "NO",
        None => "?",
    }
}

fn report(name: &str, m: &RunMetrics) {
    println!("---- {name} ----");
    match m.solved {
        Some(true) => println!("  solved     : YES — the task's own test suite passes"),
        Some(false) => println!("  solved     : NO — the produced workspace FAILS the task's tests"),
        None => println!("  solved     : UNKNOWN — the verifier could not run"),
    }
    if let Some(e) = &m.error {
        println!("  ERROR      : {e}");
    }
    println!("  steps      : {}", m.steps);
    println!("  rounds     : {}  (model calls that used a tool)", m.rounds);
    println!("  tool calls : {}", m.tool_calls);
    println!(
        "  tokens     : input={} output={} total={} (uncached={})",
        m.input_tokens,
        m.output_tokens,
        m.total_tokens(),
        m.uncached()
    );
    println!(
        "  cache read : {} ({:.0}% of input)",
        m.cache_read_tokens,
        if m.input_tokens == 0 {
            0.0
        } else {
            m.cache_read_tokens as f64 * 100.0 / m.input_tokens as f64
        }
    );
    println!("  wall time  : {:.1}s", m.wall.as_secs_f64());
    println!();
}

fn compare(results: &[(&str, RunMetrics)]) {
    let (base_name, base) = &results[0];
    println!("== comparison (baseline = {base_name}) ==");
    println!(
        "  solved     : {}={} {}",
        base_name,
        solved_word(base.solved),
        results[1..]
            .iter()
            .map(|(n, m)| format!("{n}={}", solved_word(m.solved)))
            .collect::<Vec<_>>()
            .join(" ")
    );
    // A verdict over a run that did not solve the task is meaningless: the only
    // legitimate reading of "fewer tokens" is "same working result, less cost".
    if base.solved != Some(true) || results[1..].iter().any(|(_, m)| m.solved != Some(true)) {
        println!();
        println!(
            "  VERDICT    : NOT COMPARABLE — at least one side did not pass the \
             task's own tests. A cheaper run that leaves the code broken is a \
             failure, not a win."
        );
        return;
    }
    println!("  (both sides solved the task, so the cost deltas below are comparable)");
    for (name, m) in &results[1..] {
        println!("  {name} vs {base_name}:");
        pct_line("steps", m.steps, base.steps);
        pct_line("rounds", m.rounds, base.rounds);
        pct_line("tool calls", m.tool_calls, base.tool_calls);
        pct_line("total tokens", m.total_tokens(), base.total_tokens());
        pct_line("uncached tokens", m.uncached(), base.uncached());
        println!(
            "    wall time    : {:.1}s vs {:.1}s ({:+.0}%)",
            m.wall.as_secs_f64(),
            base.wall.as_secs_f64(),
            pct_delta(m.wall.as_secs_f64(), base.wall.as_secs_f64())
        );
    }
    println!();
}

fn pct_line(label: &str, v: u64, base: u64) {
    println!(
        "    {label:<13}: {v} vs {base} ({:+.0}%)",
        pct_delta(v as f64, base as f64)
    );
}

/// `(v - base) / base * 100`, with a zero base reported as no change so a
/// zero-cost run does not print `inf`.
fn pct_delta(v: f64, base: f64) -> f64 {
    if base == 0.0 {
        0.0
    } else {
        (v - base) / base * 100.0
    }
}

// ---------------------------------------------------------------- codifa

/// Run codifa headless through its own agent entry point.
///
/// Tokens come from codifa's trace file, which `run_turn` writes as it goes —
/// the same rows `trace_ruler` reads. Deriving them from the trace instead of
/// re-summing events keeps ONE source of truth for the project's own numbers.
fn bench_codifa(task: &Task, model: &str) -> Result<RunMetrics, String> {
    let root = make_workspace(task, "codifa")?;
    let data_root = root.join(".codifa-data");
    std::fs::create_dir_all(&data_root).map_err(|e| format!("data root: {e}"))?;

    // Provider credentials come from the user's own settings, so the harness
    // never carries a secret of its own. `activeProviderId` is the provider the
    // app itself would use.
    let (provider_id, provider_kind, base_url, api_key) = codifa_provider(model)?;
    let chat_id = format!("bench-{}", std::process::id());
    let req = codifa::agent::AgentRequest {
        provider: provider_kind,
        provider_id,
        model: model.to_string(),
        base_url,
        api_key,
        api_keys: vec![],
        root: root.to_string_lossy().to_string(),
        mode: "build".to_string(),
        prompt: task.prompt.to_string(),
        // The bench IS a headless caller (no SSE client) — same shape as the
        // scheduler's requests.
        headless: true,
        history: vec![],
        system_prompt: String::new(),
        system_suffix: String::new(),
        skills: vec![],
        context_window: 0,
        chat_id: chat_id.clone(),
        mcp_servers: Value::Null,
        mcp_active: Default::default(),
        subagent_models: Default::default(),
        providers: Default::default(),
        data_root: data_root.to_string_lossy().to_string(),
        allow_computer: false,
        allow_create: false,
        allow_browser: false,
        allow_outside: false,
        allow_outside_folders: vec![],
        search_plugins: vec![],
        compact_at_percent: 0,
        fallback_provider: String::new(),
        fallback_model: String::new(),
        fallback_base_url: String::new(),
        fallback_api_key: String::new(),
        fallback_api_keys: vec![],
        thinking_level: String::new(),
        model_reasoning: false,
        subagent_thinking: Default::default(),
        tool_fallbacks: Default::default(),
        images: vec![],
        web_search_auto_fetch: 0,
        cap: None,
    };

    let started = Instant::now();
    let mut tool_calls = 0u64;
    // `AgentEvent` is the app's own event type; it is `Debug`, not serde, so the
    // count comes from matching the variant rather than re-serialising it.
    let mut emit = |ev: &codifa::agent::AgentEvent| {
        if matches!(ev, codifa::agent::AgentEvent::Tool { .. }) {
            tool_calls += 1;
        }
    };
    let cancel: std::sync::Arc<std::sync::atomic::AtomicBool> =
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio: {e}"))?;
    let outcome = rt.block_on(async {
        codifa::agent::run_turn(&req, &mut emit, &cancel).await
    });
    let wall = started.elapsed();

    // The trace is the source of truth for tokens, even on a failed run: a
    // turn that errored partway still spent what its rows say it spent.
    // The trace store resolves its directory from the app's REAL data root
    // (`~/.codifa/traces`), not from `req.data_root` — measured: a run with an
    // injected `data_root` still wrote `~/.codifa/traces/<chat_id>.jsonl`. The
    // harness therefore reads where the rows actually land.
    let trace_path = dirs_home()?
        .join(".codifa")
        .join("traces")
        .join(format!("{chat_id}.jsonl"));
    let (steps, rounds, input, output, cache_read, from_trace) = read_codifa_trace(&trace_path)?;
    let tool_calls = tool_calls.max(from_trace);

    Ok(RunMetrics {
        steps,
        rounds,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        tool_calls,
        wall,
        solved: verify_workspace(task, &root),
        error: outcome.err(),
    })
}

/// Resolve the provider that serves the shared model.
///
/// The app's `activeProviderId` is NOT usable here: measured, it was
/// `openrouter` with ZERO keys, so a run with it returned in 0.6s having spent
/// nothing. The harness therefore picks the provider whose `models` list names
/// the shared model (river.ai does) among those carrying a key.
///
/// The key in `settings.json` is stored ENCRYPTED (`enc:v1:…`) and only the app
/// can decrypt it, so what this returns is that stored blob — `run_turn`
/// receives it the same way the GUI sends it, and the app's own secret layer
/// resolves it. The harness never handles plaintext credentials.
fn codifa_provider(model: &str) -> Result<(String, String, String, String), String> {
    let settings_path = dirs_home()?.join(".codifa").join("settings.json");
    let raw = std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("read {}: {e}", settings_path.display()))?;
    let s: Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse settings.json: {e}"))?;

    // `providers` has shipped as both an object and an array of {id, ...}.
    let entries: Vec<(String, Value)> = match s.get("providers") {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        Some(Value::Array(rows)) => rows
            .iter()
            .filter_map(|r| {
                let id = r.get("id").and_then(Value::as_str)?.to_string();
                Some((id, r.clone()))
            })
            .collect(),
        _ => Vec::new(),
    };
    if entries.is_empty() {
        return Err("settings.json has no providers".into());
    }

    let shared_tail = model.rsplit('/').next().unwrap_or(model);
    let name_matches = |id: &str, v: &Value| {
        id.contains(shared_tail)
            || v.get("models")
                .and_then(Value::as_array)
                .map(|ms| {
                    ms.iter().any(|m| {
                        m.as_str()
                            .or_else(|| m.get("id").and_then(Value::as_str))
                            .map(|s| s.contains(shared_tail) || s == model)
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
    };

    let first_key = |v: &Value| -> Option<String> {
        v.get("apiKeys")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .filter(|k| !k.trim().is_empty())
            .or_else(|| {
                v.get("apiKey")
                    .and_then(Value::as_str)
                    .filter(|k| !k.trim().is_empty())
            })
            .map(str::to_string)
    };

    // An explicit `BENCH_PROVIDER` wins over name matching: when several
    // providers serve the same model (river and nvidia both carry
    // `deepseek-v4.1-flash`) the first match may be an unfunded account, and a
    // 402 from it looks exactly like a broken harness. Pinning the provider is
    // how the caller says WHICH funded endpoint the run should use.
    let pinned = std::env::var("BENCH_PROVIDER").ok().filter(|p| !p.is_empty());
    let pick = pinned
        .as_ref()
        .and_then(|want| {
            entries
                .iter()
                .find(|(id, v)| (id == want || id.contains(want.as_str())) && first_key(v).is_some())
        })
        .or_else(|| {
            entries
                .iter()
                .find(|(id, v)| first_key(v).is_some() && name_matches(id, v))
        })
        .or_else(|| entries.iter().find(|(_, v)| first_key(v).is_some()))
        .ok_or_else(|| "no provider in settings.json carries an API key".to_string())?;

    let (id, entry) = pick;
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai")
        .to_string();
    let base_url = entry
        .get("baseUrl")
        .or_else(|| entry.get("base_url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if base_url.is_empty() {
        return Err(format!("provider `{id}` has no baseUrl"));
    }
    // `RIVER_API_KEY` overrides the STORED key on the codifa side too, so both
    // agents call the identical endpoint with the identical credential. Without
    // it the run silently uses whatever key settings.json happens to hold —
    // measured: a stored river key that answers 402, while the env key succeeds,
    // which reads as "codifa is broken" instead of "wrong account".
    let env_key = std::env::var("RIVER_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let key = match env_key {
        Some(k) => k,
        None => {
            let stored = first_key(entry)
                .ok_or_else(|| format!("provider `{id}` has no API key"))?;
            // A headless run reads settings.json directly, where keys are
            // `enc:v1:` ciphertext — exactly the trap
            // `secrets::decrypt_provider_secrets` documents for the scheduler.
            // Sending the ciphertext upstream is an opaque 401, so decrypt here
            // the same way the scheduler does.
            if stored.starts_with("enc:v1:") {
                decrypt_at_rest(&stored)?
            } else {
                stored
            }
        }
    };
    Ok((id.clone(), kind, base_url, key))
}

/// Decrypt one `enc:v1:` provider key with the install key.
///
/// Mirrors `secrets::decrypt_at_rest`, which needs a primed process-global key
/// that only the GUI's setup hook installs. The install key itself lives in a
/// `raw:<b64>` file (0600) under the app data dir, so a headless caller can read
/// it directly — no keychain access, no `AppHandle`.
///
/// Layout of an encrypted value: `enc:v1:<b64 iv>.<b64 ciphertext+tag>`,
/// AES-256-GCM with a 12-byte nonce.
fn decrypt_at_rest(value: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine as _;

    let b64 = base64::engine::general_purpose::STANDARD;
    let key_b64 = read_install_key()?;
    let body = value
        .strip_prefix("enc:v1:")
        .ok_or_else(|| "not an enc:v1: value".to_string())?;
    let (iv_b64, ct_b64) = body
        .split_once('.')
        .ok_or_else(|| "enc value has no iv.ciphertext separator".to_string())?;

    let key = b64.decode(&key_b64).map_err(|e| format!("bad install key: {e}"))?;
    let iv = b64.decode(iv_b64).map_err(|e| format!("bad iv: {e}"))?;
    let ct = b64
        .decode(ct_b64)
        .map_err(|e| format!("bad ciphertext: {e}"))?;
    if iv.len() != 12 {
        return Err(format!("iv is {} bytes, expected 12", iv.len()));
    }

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("key: {e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_ref())
        .map_err(|_| "decrypt failed (wrong install key or corrupt value)".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("decrypted key is not UTF-8: {e}"))
}

/// Read the `raw:<b64>` install key from the app data dir.
///
/// Tauri's app data dir is `<user-data>/com.codifa.app`; the legacy Electron
/// install kept its key under `<user-data>/codifa`. Both are checked, matching
/// `secrets::get_secrets_key`'s fallback order.
fn read_install_key() -> Result<String, String> {
    let home = dirs_home()?;
    let candidates = [
        home.join("Library/Application Support/com.codifa.app/secrets.key"),
        home.join("Library/Application Support/codifa/secrets.key"),
    ];
    for path in candidates {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(b64) = raw.trim().strip_prefix("raw:") {
                return Ok(b64.to_string());
            }
        }
    }
    Err("no install key found (looked for secrets.key under app data dirs)".into())
}

fn dirs_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set".to_string())
}

/// Sum codifa's own trace rows.
///
/// Returns `(steps, rounds, input, output, cache_read, tool_calls)`. Done rows
/// are `kind=llm`; a row that requested tools is one of the ROUNDS the goal
/// counts. The trace is JSONL with one object per line, written incrementally.
fn read_codifa_trace(path: &Path) -> Result<(u64, u64, u64, u64, u64, u64), String> {
    if !path.exists() {
        return Err(format!("no trace written at {}", path.display()));
    }
    let body = std::fs::read_to_string(path).map_err(|e| format!("read trace: {e}"))?;
    let (mut steps, mut rounds) = (0u64, 0u64);
    let (mut input, mut output, mut cache) = (0u64, 0u64, 0u64);
    let mut tool_calls = 0u64;

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match row.get("kind").and_then(Value::as_str) {
            Some("llm") => {
                steps += 1;
                if row
                    .get("detail")
                    .and_then(|d| d.get("tool_calls"))
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
                {
                    rounds += 1;
                }
                if let Some(t) = row.get("tokens") {
                    input += t.get("input").and_then(Value::as_u64).unwrap_or(0);
                    output += t.get("output").and_then(Value::as_u64).unwrap_or(0);
                    cache += t.get("cache_read").and_then(Value::as_u64).unwrap_or(0);
                }
            }
            Some("tool") => tool_calls += 1,
            _ => {}
        }
    }
    Ok((steps, rounds, input, output, cache, tool_calls))
}

// -------------------------------------------------------------- opencode

/// Run opencode headless and parse its own JSON event stream.
///
/// `opencode run --format json` emits one JSON object per line; `step_finish`
/// carries the provider's token counts, which is the only honest source for
/// this side (codifa reads its trace the same way).
fn bench_opencode(task: &Task, model: &str) -> Result<RunMetrics, String> {
    let root = make_workspace(task, "opencode")?;
    ensure_opencode_river()?;
    let provider = opencode_provider();
    let started = Instant::now();
    let out: Vec<String> = vec![
        "run".into(),
        // `--standalone` runs the agent against a PRIVATE server instead of the
        // always-on background service. Both modes were measured, and the
        // difference decided the score:
        //
        //   background service -> the daemon inherits the child's stdout and
        //     keeps it open after the direct child exits, so a reader thread
        //     racing `wait()` sees a PARTIAL stream. Measured: 2 `step_finish`
        //     here where the identical command redirected to a shell file
        //     produced 5. The truncated stream made the correctness gate inspect
        //     a workspace the agent had not finished editing, and opencode was
        //     scored as FAILING a task it actually solves.
        //   `--standalone` -> no daemon, the stream ends with the child, and the
        //     full run is visible (measured: 6 tool calls, 5 `step_finish`).
        //
        // The earlier `HTTP 401 — Header of type authorization was missing` was
        // NOT caused by `--standalone` itself but by the credential being absent:
        // the private server reads the key from the environment, which is why
        // `bench_opencode` now forwards it (see the env pass-through below).
        "--standalone".into(),
        "--format".into(),
        "json".into(),
        "--model".into(),
        format!("{provider}/{model}"),
        // `--agent build` is REQUIRED for a fair comparison: opencode's config
        // sets `default_agent: plan`, and in plan mode it says so out loud —
        // "I'm in Plan mode, so I can't modify `stats.py` or run the test file" —
        // then stops after one glob. Measured, it "finished" on 101 tokens with
        // the bug untouched: a plan-mode run can never be scored against a
        // build-mode agent, so the mode is pinned here.
        "--agent".into(),
        "build".into(),
        // Build mode asks before each write/command; `--auto` approves the ones
        // the config does not explicitly deny. codifa runs its own approval
        // path unattended in this harness, so this is what makes the two sides
        // run under the same conditions (both doing the work without a human).
        "--auto".into(),
        task.prompt.into(),
    ];

    // `Command::output()` reads the pipes itself, but it is called on a CHILD
    // that keeps writing while opencode's background service streams its
    // events: measured, the harness saw 2 `step_finish` where the same command
    // redirecting to a shell file produced 4, and a partial stream is not a
    // parsing detail — it made the correctness gate run against a workspace the
    // agent had not finished, so opencode was reported as FAILING while the same
    // run typed by hand passed every test. The stream is therefore drained
    // explicitly, line by line, until EOF.
    let mut cmd = std::process::Command::new("opencode");
    cmd.args(&out)
        .current_dir(&root)
        .env("PATH", augmented_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The `--standalone` server reads the provider credential from the same
    // environment variable `ensure_opencode_river` used to register it, so the
    // key is forwarded explicitly. Without it the call comes back
    // `HTTP 401 — Header of type authorization was missing`.
    for name in ["BENCH_OC_KEY", "RIVER_API_KEY"] {
        if let Ok(key) = std::env::var(name) {
            cmd.env(name, key);
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn opencode: {e}"))?;

    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    // Both pipes are drained on their own threads so a full stderr buffer can
    // never block the child mid-stream (the deadlock `output()` avoids only by
    // racing both to EOF, which is what truncated this one).
    let out_thread = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        let mut r = std::io::BufReader::new(stdout_pipe);
        let _ = r.read_to_string(&mut s);
        s
    });
    let err_thread = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        let mut r = std::io::BufReader::new(stderr_pipe);
        let _ = r.read_to_string(&mut s);
        s
    });
    let status = child.wait().map_err(|e| format!("wait opencode: {e}"))?;
    let wall = started.elapsed();
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();

    let mut m = parse_opencode_events(&stdout);
    m.wall = wall;
    if !status.success() {
        m.error = Some(format!(
            "opencode exited {:?}: {}",
            status.code(),
            stderr.lines().last().unwrap_or("").trim()
        ));
    }
    // The gate runs on the workspace opencode produced, so "cheap because it
    // stopped early" can never be scored as a win.
    m.solved = verify_workspace(task, &root);
    if std::env::var("BENCH_VERBOSE").is_ok() {
        eprintln!("[bench] opencode workspace: {}", root.display());
        eprintln!("[bench] verify: `{}` -> {:?}", task.verify, m.solved);
        for (name, _) in task.seed {
            let p = root.join(name);
            let body = std::fs::read_to_string(&p).unwrap_or_default();
            eprintln!("[bench] {name}: {} bytes, first-line={:?}", body.len(), body.lines().next());
        }
    }
    Ok(m)
}

/// Fold opencode's event stream into the shared metric shape.
///
/// `step_start` opens a model call, `step_finish` closes it and reports the
/// tokens. Counting rounds needs the tool events that fall INSIDE a step, so
/// they are buffered per step and folded at `step_finish`.
fn parse_opencode_events(stdout: &str) -> RunMetrics {
    let mut m = RunMetrics::default();
    let mut step_had_tool = false;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match ev.get("type").and_then(Value::as_str) {
            Some("step_start") => step_had_tool = false,
            Some("tool_use") => {
                step_had_tool = true;
                m.tool_calls += 1;
            }
            Some("step_finish") => {
                m.steps += 1;
                if step_had_tool {
                    m.rounds += 1;
                }
                if let Some(t) = ev.get("part").and_then(|p| p.get("tokens")) {
                    m.input_tokens += t.get("input").and_then(Value::as_u64).unwrap_or(0);
                    m.output_tokens += t.get("output").and_then(Value::as_u64).unwrap_or(0);
                    m.cache_read_tokens += t
                        .get("cache")
                        .and_then(|c| c.get("read"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                }
            }
            _ => {}
        }
    }
    m
}

/// Register the shared endpoint in opencode's config.
///
/// opencode ships neither river.ai nor nvidia as a provider, so the shared model
/// is unreachable from it without this. The credential is read from the
/// environment — NEVER written into the repo — and written to opencode's own
/// `opencode.json`, which is the user's private config. Idempotent: an existing
/// entry is kept in step rather than duplicated.
///
/// The endpoint is described by THREE env vars so the same function serves
/// whichever account is funded:
///   * `BENCH_OC_KEY`  — the credential (required)
///   * `BENCH_OC_BASE` — default `https://api.river.ai/v1`
///   * `BENCH_OC_NAME` — provider id, default `river`
fn ensure_opencode_river() -> Result<(), String> {
    let config_path = dirs_home()?
        .join(".config")
        .join("opencode")
        .join("opencode.json");
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("read {}: {e}", config_path.display()))?;
    let mut cfg: Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse opencode.json: {e}"))?;

    let base = std::env::var("BENCH_OC_BASE")
        .unwrap_or_else(|_| "https://api.river.ai/v1".to_string());
    let provider_name = std::env::var("BENCH_OC_NAME").unwrap_or_else(|_| OPENCODE_PROVIDER.to_string());
    // Either var works: `RIVER_API_KEY` stays supported because that is the name
    // the river.ai docs use.
    let key = std::env::var("BENCH_OC_KEY")
        .or_else(|_| std::env::var("RIVER_API_KEY"))
        .map_err(|_| {
            "no opencode credential — set BENCH_OC_KEY (or RIVER_API_KEY)".to_string()
        })?;
    if key.trim().is_empty() {
        return Err("opencode credential is empty".into());
    }

    let providers = cfg
        .as_object_mut()
        .ok_or_else(|| "opencode.json is not an object".to_string())?
        .entry("provider")
        .or_insert_with(|| json!({}));
    let providers = providers
        .as_object_mut()
        .ok_or_else(|| "`provider` in opencode.json is not an object".to_string())?;

    let m = shared_model();
    let entry = providers.entry(provider_name.clone()).or_insert_with(|| {
        json!({ "npm": "@ai-sdk/openai-compatible", "name": provider_name })
    });
    // Keep a stale URL/key/model in step with what THIS run needs.
    if let Some(opts) = entry.get_mut("options").and_then(Value::as_object_mut) {
        opts.insert("baseURL".into(), json!(base));
        opts.insert("apiKey".into(), json!(key));
    } else if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "options".into(),
            json!({ "baseURL": base, "apiKey": key }),
        );
    }
    if let Some(models) = entry.get_mut("models").and_then(Value::as_object_mut) {
        models.insert(m.clone(), json!({"name": m}));
    } else if let Some(obj) = entry.as_object_mut() {
        obj.insert("models".into(), json!({ m.clone(): {"name": m} }));
    }

    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write {}: {e}", config_path.display()))?;
    // Confirm WHERE it went, never echo the value.
    println!("  (opencode: provider `{provider_name}` at {base} registered from the environment)");
    Ok(())
}

/// The provider id opencode reads the shared model through.
///
/// opencode ships neither river.ai nor nvidia, so the harness registers the
/// endpoint in opencode's config (see [`ensure_opencode_river`]). `BENCH_OC_NAME`
/// picks which id to use, so a funded account can be swapped in without a code
/// change.
fn opencode_provider() -> String {
    std::env::var("BENCH_OC_NAME").unwrap_or_else(|_| OPENCODE_PROVIDER.to_string())
}

/// The PATH an agent expects: the toolchains live outside the harness's own
/// inherited PATH when the app is launched from Finder.
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts = vec![
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}

/// Keep `json!` in use: the module documents the event shape it parses, and a
/// stray import would be a warning otherwise.
#[allow(dead_code)]
fn event_shape_example() -> Value {
    json!({"type": "step_finish", "part": {"tokens": {"input": 0, "output": 0}}})
}
