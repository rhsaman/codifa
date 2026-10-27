//! Native schedule execution loop (migrated from backend/scheduler.py +
//! server.py's _start_schedule_loop / _run_due_schedules / _execute_schedule).
//!
//! Cron format: 5 fields (minute hour dom month dow), evaluated in the HOST's
//! LOCAL time — "0 9 * * *" fires at 09:00 on the user's wall clock, whatever
//! the UTC offset is. Presets ("once"/"hourly"/"daily"/"weekly"/"every N
//! minutes|hours") are normalized to cron by the frontend before save, so the
//! loop only sees real cron. Stored timestamps stay epoch seconds (UTC),
//! matching state_db's layout; only the cron FIELD match converts to local.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Poll interval of the due-check loop (seconds).
const POLL_SECS: u64 = 30;
/// A stored next_run at most this far in the past still counts as due.
const DUE_GRACE_SECS: f64 = 90.0;
/// A "running" run younger than this blocks a second concurrent run.
const RUNNING_WINDOW_SECS: f64 = 15.0 * 60.0;
/// Running runs older than this are orphans from a dead process → error.
const ORPHAN_AFTER_SECS: f64 = 60.0 * 60.0;
/// Headless run output cap (chars), mirroring the sidecar's 8000.
const RUN_OUTPUT_CAP: usize = 8000;

// --- cron parsing (mirror scheduler.py) --------------------------------------

fn parse_field(field: &str, lo: u32, hi: u32) -> Result<Vec<u32>, String> {
    let field = field.trim();
    if field == "*" {
        return Ok((lo..=hi).collect());
    }
    let mut out = std::collections::BTreeSet::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (range_part, step) = match part.split_once('/') {
            Some((r, s)) => (
                r,
                s.parse::<u32>()
                    .map_err(|_| format!("bad cron step: {part:?}"))?
                    .max(1),
            ),
            None => (part, 1),
        };
        let (start, end) = if range_part == "*" || range_part.is_empty() {
            (lo, hi)
        } else if let Some((s, e)) = range_part.split_once('-') {
            let s: u32 = s
                .trim()
                .parse()
                .map_err(|_| format!("bad cron field: {field:?}"))?;
            let e: u32 = e
                .trim()
                .parse()
                .map_err(|_| format!("bad cron field: {field:?}"))?;
            (s, e)
        } else {
            let v: u32 = range_part
                .trim()
                .parse()
                .map_err(|_| format!("bad cron field: {field:?}"))?;
            (v, v)
        };
        if start < lo || end > hi || start > end {
            return Err(format!("cron field out of range: {field:?}"));
        }
        let mut v = start;
        while v <= end {
            out.insert(v);
            v += step;
        }
    }
    if out.is_empty() {
        return Err(format!("empty cron field: {field:?}"));
    }
    Ok(out.into_iter().collect())
}

/// Validate a 5-field cron expression.
#[allow(dead_code)]
pub fn is_valid_cron(spec: &str) -> bool {
    next_run_after(spec, 0.0, local_utc_offset_secs()).is_some() || spec.split_whitespace().count() == 5 && {
        let parts: Vec<&str> = spec.split_whitespace().collect();
        let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
        parts
            .iter()
            .zip(bounds)
            .all(|(p, (lo, hi))| parse_field(p, lo, hi).is_ok())
    }
}

/// Next fire time (epoch secs) strictly after `after_ts`, matching the cron
/// fields against the wall-clock time `utc_offset_secs` seconds ahead of UTC
/// (the host's local time); None for ""/once.
pub fn next_run_after(cron: &str, after_ts: f64, utc_offset_secs: i32) -> Option<f64> {
    let cron = cron.trim();
    if cron.is_empty() {
        return None;
    }
    let parts: Vec<&str> = cron.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }
    let bounds = [(0u32, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
    let mut fields: Vec<Vec<u32>> = Vec::with_capacity(5);
    for (p, (lo, hi)) in parts.iter().zip(bounds) {
        fields.push(parse_field(p, lo, hi).ok()?);
    }
    // Search minute-by-minute from the next whole minute after after_ts,
    // capped at ~2 years (any valid cron fires within that).
    let mut cursor = ((after_ts as i64) / 60) * 60 + 60;
    // The cron fields are matched against the LOCAL wall clock: the epoch
    // minute is shifted by the zone offset before its civil date/time is read,
    // so "0 9 * * *" means 09:00 by the user's clock, not UTC's.
    let shift = utc_offset_secs as i64;
    for _ in 0..(366 * 2 * 24 * 60) {
        let dt = chrono::DateTime::from_timestamp(cursor + shift, 0)?;
        use chrono::{Datelike, Timelike};
        // Cron dow: 0 and 7 are both Sunday; chrono Sunday = 0.
        let cron_dow = dt.weekday().num_days_from_sunday();
        if fields[0].contains(&dt.minute())
            && fields[1].contains(&dt.hour())
            && fields[2].contains(&dt.day())
            && fields[3].contains(&dt.month())
            && fields[4].contains(&cron_dow)
        {
            return Some(cursor as f64);
        }
        cursor += 60;
    }
    None
}

/// next_run for a task from its cron + last_run (mirror compute_next_run):
/// disabled → None; once → now if never ran else None; recurring → next after
/// max(now, last_run) so missed runs from pauses never burst.
pub fn compute_next_run(task: &Value, now: f64) -> Option<f64> {
    if !task.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
        return None;
    }
    let cron = task
        .get("cron")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let last = task.get("last_run").and_then(Value::as_f64).unwrap_or(0.0);
    if cron.is_empty() {
        return if last == 0.0 { Some(now) } else { None };
    }
    next_run_after(&cron, now.max(last), local_utc_offset_secs())
}

/// True when the task is enabled and its stored next_run has come due
/// (mirror is_due: once fires immediately if never ran; recurring needs a
/// stored next_run within the grace window — stale ones are healed, not run).
pub fn is_due(task: &Value, now: f64) -> bool {
    if !task.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
        return false;
    }
    let cron = task
        .get("cron")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let last = task.get("last_run").and_then(Value::as_f64).unwrap_or(0.0);
    let nxt = task.get("next_run").and_then(Value::as_f64);
    if cron.is_empty() {
        if last != 0.0 {
            return false;
        }
        return !nxt.map(|n| n > now).unwrap_or(false);
    }
    match nxt {
        None => false,
        Some(n) if n > now => false,
        Some(n) => (now - n) <= DUE_GRACE_SECS,
    }
}

// --- storage (reuses appstate's schedule files) ------------------------------

fn schedules_dir(data_root: &Path) -> PathBuf {
    data_root.join("schedules")
}

fn schedule_runs_dir(data_root: &Path) -> PathBuf {
    schedules_dir(data_root).join("runs")
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Read a `{ key: "string" }` map out of the settings document.
///
/// The renderer always writes strings, but a hand-edited settings.json must
/// never make a scheduled run panic, so non-string values are skipped.
fn string_map(settings: &Value, key: &str) -> std::collections::HashMap<String, String> {
    settings
        .get(key)
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Read a `{ key: ["a", "b"] }` map of ORDERED string lists out of the settings
/// document (the per-tool fallback lists from Settings → Tools).
///
/// The order is the try order, so it is preserved exactly; non-string rows and
/// empty lists are dropped, and a hand-edited settings.json must never make a
/// scheduled run panic.
fn string_list_map(settings: &Value, key: &str) -> std::collections::HashMap<String, Vec<String>> {
    settings
        .get(key)
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let list: Vec<String> = v
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect();
                    if list.is_empty() {
                        None
                    } else {
                        Some((k.clone(), list))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read a `["a", "b"]` list of names out of a task document (missing/non-array
/// fields become an empty list, so an older task still runs).
fn string_list(task: &Value, key: &str) -> Vec<String> {
    task.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn atomic_write_json(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Unique per write: a fixed `<pid>`-only name let two writers truncate the
    // same temp file and rename torn JSON into place.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("tmp{}.{}", std::process::id(), unique));
    std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// The host timezone's offset from UTC in seconds (e.g. Tehran +12_600).
///
/// This is the human time base for crons: the loop still stores epoch seconds,
/// but a field match asks "is it 09:00 BY THE USER'S CLOCK". An offset that
/// cannot be read falls back to 0 (UTC) rather than failing the loop.
pub fn local_utc_offset_secs() -> i32 {
    chrono::Local::now().offset().local_minus_utc()
}

/// The prompt's PLUGIN TOOLS block: the WHOLE bundle each named plugin carries
/// — skills, runnable scripts and MCP connectors — as run-readable notes.
///
/// A task stores plugin SLUGS (the `schedule` tool), and until now only the
/// connector half was expanded (`mcp_of`): the run never learned WHICH plugins
/// it owned, so its scripts were unreachable — the model did not know they
/// existed — and its skills had to be found by luck in the global catalog.
/// Disabled or missing plugins are skipped: a switched-off bundle stays off,
/// exactly like a normal turn.
fn plugin_context_block(data_root: &Path, slugs: &[String]) -> String {
    if slugs.is_empty() {
        return String::new();
    }
    let enabled: std::collections::HashSet<String> = crate::plugins::enabled_plugins(data_root)
        .into_iter()
        .map(|(slug, _)| slug)
        .collect();
    let mut lines: Vec<String> = Vec::new();
    for slug in slugs {
        if !enabled.contains(slug.as_str()) {
            continue;
        }
        let manifest = crate::plugins::manifest_of(data_root, slug);
        let label = manifest
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(slug);
        let mut block = format!(
            "- plugin {slug} ({label}): its MCP connectors are loaded and its skills \
             are attached to this run — load_skill only to re-read one."
        );
        let scripts = crate::plugins::list_scripts(data_root, slug);
        if !scripts.is_empty() {
            block.push_str(" Its runnable scripts (plugin tool, action=run):");
            for s in &scripts {
                let name = s["name"].as_str().unwrap_or_default().trim();
                if name.is_empty() {
                    continue;
                }
                let lang = s["language"].as_str().unwrap_or("rust");
                let description = s["description"].as_str().unwrap_or_default().trim();
                block.push_str(&format!(
                    "\n    · {name} [{lang}]{}",
                    if description.is_empty() {
                        String::new()
                    } else {
                        format!(" — {description}")
                    }
                ));
            }
        }
        lines.push(block);
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\n=== PLUGIN TOOLS ===\n\
         The user attached these plugins to this scheduled task — you may use \
         everything inside them (run a script with the plugin tool, action=run):\n{}",
        lines.join("\n")
    )
}

/// All schedule tasks (mirror appstate::list_schedules, sorted by created_at).
fn list_schedules(data_root: &Path) -> Vec<Value> {
    let mut out: Vec<(f64, Value)> = vec![];
    if let Ok(rd) = std::fs::read_dir(schedules_dir(data_root)) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "json").unwrap_or(false) {
                if let Some(obj) = read_json(&p).filter(|v| v.get("id").is_some()) {
                    let created = obj.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
                    out.push((created, obj));
                }
            }
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, v)| v).collect()
}

fn save_schedule(data_root: &Path, task: Value) {
    if let Some(id) = task.get("id").and_then(Value::as_str) {
        let _ = atomic_write_json(&schedule_path(data_root, id), &task);
    }
}

/// Path of one schedule document (shared by save/load so the two agree).
fn schedule_path(data_root: &Path, id: &str) -> PathBuf {
    let re = regex::Regex::new(r"[^A-Za-z0-9._-]+").expect("static regex");
    let safe = re.replace_all(id.trim(), "-");
    let name = if safe.trim_matches(['.', '-']).is_empty() {
        "schedule".to_string()
    } else {
        safe.trim_matches(['.', '-']).to_string()
    };
    schedules_dir(data_root).join(format!("{name}.json"))
}

/// Read ONE schedule back from disk — the inverse of `save_schedule`.
fn load_schedule(data_root: &Path, id: &str) -> Option<Value> {
    read_json(&schedule_path(data_root, id))
}

/// Sort key for a run file: `(has_timestamp, timestamp, name)`.
fn run_name_key(path: &Path) -> (u8, u64, String) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stamp = name
        .strip_prefix("run-")
        .and_then(|rest| rest.split('-').next())
        .and_then(|seg| seg.parse::<u64>().ok());
    match stamp {
        Some(ts) => (1, ts, name),
        None => (0, 0, name),
    }
}

fn save_run(data_root: &Path, run: &Value) {
    if let Some(id) = run.get("id").and_then(Value::as_str) {
        let re = regex::Regex::new(r"[^A-Za-z0-9._-]+").expect("static regex");
        let safe = re.replace_all(id.trim(), "-");
        let name = if safe.trim_matches(['.', '-']).is_empty() {
            "run".to_string()
        } else {
            safe.trim_matches(['.', '-']).to_string()
        };
        let _ = atomic_write_json(
            &schedule_runs_dir(data_root).join(format!("{name}.json")),
            run,
        );
    }
}

/// Newest-first runs, optionally filtered by schedule id ("" = all).
fn list_runs(data_root: &Path, schedule_id: &str, limit: usize) -> Vec<Value> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(schedule_runs_dir(data_root))
        .map(|rd| {
            let mut v: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect();
            // Newest first by the timestamp embedded in the run file name
            // (`run-<unix-secs>-<uuid>.json`). The old plain name sort was
            // unrelated to recency — run ids were random UUIDs — so listings
            // returned arbitrary old runs and the truncation below could hide
            // the newest "running" record. Legacy `run-<uuid>` names carry no
            // timestamp and sort last, so they never displace recent runs.
            v.sort_by(|a, b| run_name_key(b).cmp(&run_name_key(a)));
            v
        })
        .unwrap_or_default();
    files.truncate(limit.max(1) * 4);
    let mut out: Vec<(f64, Value)> = vec![];
    for p in files {
        let Some(obj) = read_json(&p).filter(|v| v.get("id").is_some()) else {
            continue;
        };
        if !schedule_id.is_empty()
            && obj.get("schedule_id").and_then(Value::as_str).unwrap_or_default() != schedule_id
        {
            continue;
        }
        let started = obj.get("started_at").and_then(Value::as_f64).unwrap_or(0.0);
        out.push((started, obj));
        if out.len() >= limit.max(1) {
            break;
        }
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, v)| v).collect()
}

/// True when a fresh "running" run for this task exists on disk.
fn has_recent_running(data_root: &Path, schedule_id: &str, now: f64) -> bool {
    // 200 (not 5): `list_runs` truncates its file window BEFORE filtering by
    // schedule, so a small number let the in-flight "running" record fall
    // outside the window whenever other tasks had newer runs — and a second
    // copy of the same task then started in parallel.
    list_runs(data_root, schedule_id, 200).iter().any(|r| {
        r.get("status").and_then(Value::as_str) == Some("running")
            && {
                let started = r.get("started_at").and_then(Value::as_f64).unwrap_or(0.0);
                started != 0.0 && (now - started) < RUNNING_WINDOW_SECS
            }
    })
}

/// Close running runs orphaned by a dead process or a hung agent loop
/// (status → error).
///
/// `min_age_secs` gates by the run's age: the STARTUP sweep passes 0 — no run
/// of this process exists yet, so every stored "running" row is a leftover of
/// a dead one — while the periodic loop passes ORPHAN_AFTER_SECS so a genuine
/// long job is never touched.
fn mark_orphaned_running(data_root: &Path, min_age_secs: f64) -> usize {
    let now = now_secs();
    let mut fixed = 0usize;
    for r in list_runs(data_root, "", 10_000) {
        if r.get("status").and_then(Value::as_str) != Some("running") {
            continue;
        }
        let started = r.get("started_at").and_then(Value::as_f64).unwrap_or(0.0);
        if started != 0.0 && (now - started) < min_age_secs {
            continue;
        }
        let mut fixed_run = r.clone();
        if let Some(obj) = fixed_run.as_object_mut() {
            obj.insert("status".into(), json!("error"));
            obj.insert("error".into(), json!("interrupted (app restarted)"));
            obj.insert("finished_at".into(), json!(now));
        }
        save_run(data_root, &fixed_run);
        fixed += 1;
    }
    fixed
}

// --- headless execution -------------------------------------------------------

/// Resolve the provider config for a task: task.providerId → settings
/// providers match → first provider (mirror of _execute_schedule).
fn resolve_provider(data_root: &Path, task: &Value) -> Option<Value> {
    let mut settings = read_json(&data_root.join("settings.json")).unwrap_or(json!({}));
    // settings.json stores provider keys as `enc:v1:` ciphertext (the renderer
    // encrypts on write). A headless run reads the file directly, so without
    // this the "key" sent upstream was the ciphertext itself — an opaque 401
    // on every scheduled run, including every fallback rung.
    crate::secrets::decrypt_provider_secrets(&mut settings);
    let providers = settings.get("providers").and_then(Value::as_array)?.clone();
    let want_id = task
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !want_id.is_empty() {
        for p in &providers {
            if p.get("id").and_then(Value::as_str) == Some(want_id) {
                return Some(p.clone());
            }
        }
    }
    providers.first().cloned()
}

/// One headless run: build an AgentRequest from the task + settings, run the
/// native agent loop, record the run (output capped, usage accrued).
pub async fn execute_schedule(data_root: &Path, task: Value) {
    let sid = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let prompt = task
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    // The task's plugins expand into the PROMPT (the model must know what the
    // task owns — scripts are otherwise invisible), not only into the
    // connector map below.
    let task_plugins = string_list(&task, "plugins");
    let prompt = {
        let block = plugin_context_block(data_root, &task_plugins);
        if block.is_empty() {
            prompt
        } else {
            format!("{prompt}{block}")
        }
    };
    let root = task
        .get("root")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if sid.is_empty() || prompt.is_empty() {
        return;
    }
    let started_at = now_secs();
    // The run id becomes the run's FILE NAME, and listings sort/truncate by
    // file name — so the timestamp goes first. With the old random-uuid name
    // the order was unrelated to recency: finished runs looked missing and
    // `has_recent_running` could miss the in-flight one and start it twice.
    let run_id = format!(
        "run-{}-{}",
        started_at as u64,
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    save_run(
        data_root,
        &json!({
            "id": run_id, "schedule_id": sid, "status": "running",
            "output": "", "started_at": started_at,
        }),
    );

    let Some(provider) = resolve_provider(data_root, &task) else {
        save_run(
            data_root,
            &json!({
                "id": run_id, "schedule_id": sid, "status": "error",
                "error": "no provider configured", "output": "",
                "started_at": started_at, "finished_at": now_secs(),
            }),
        );
        return;
    };
    let base_model = task
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .or_else(|| provider.get("model").and_then(Value::as_str).map(String::from))
        .unwrap_or_default();
    let base_url = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let base_kind = provider
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("custom")
        .to_string();
    let base_provider_id = provider
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // The per-slot model/reasoning choices live in settings.json, not in the
    // schedule file. A scheduled run is a headless `run_turn`, so without this
    // the Settings → Tools "Schedule" row was written by the UI and read by
    // nobody: every run silently took the task's provider defaults instead.
    let mut settings = read_json(&data_root.join("settings.json")).unwrap_or(json!({}));
    // The renderer encrypts provider keys at rest; decrypt before any of them
    // can be used as a bearer token (a headless run reads this file directly).
    crate::secrets::decrypt_provider_secrets(&mut settings);
    let subagent_models = string_map(&settings, "subagentModels");
    let subagent_thinking = string_map(&settings, "subagentThinking");
    let tool_fallbacks = string_list_map(&settings, "toolFallbacks");
    let providers_map = settings
        .get("providers")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    p.get("id")
                        .and_then(Value::as_str)
                        .map(|id| (id.to_string(), p.clone()))
                })
                .collect::<std::collections::HashMap<String, Value>>()
        })
        .unwrap_or_default();
    // The "Schedule" row routes EVERY scheduled run (cross-provider aware, the
    // same slot resolution the other tools use). An empty row keeps the model
    // saved on the task, or the provider's own default.
    let slot_entry = subagent_models
        .get("schedule")
        .map(String::as_str)
        .unwrap_or("");
    let (model, base_url, api_keys, provider_id, provider_kind) =
        if slot_entry.trim().is_empty() {
            (
                base_model,
                base_url,
                vec![api_key.clone()],
                base_provider_id,
                base_kind,
            )
        } else {
            let (m, b, keys, pid) = crate::backend_light::resolve_slot_target(
                slot_entry,
                &base_model,
                &base_url,
                &[api_key.clone()],
                &base_provider_id,
                &providers_map,
            );
            let kind =
                crate::backend_light::resolve_slot_kind(slot_entry, &base_kind, &providers_map);
            (m, b, keys, pid, kind)
        };
    // A slot with no explicit level sends no reasoning parameter (the provider
    // default); the capability flag gates it exactly like every other call.
    let thinking_level = subagent_thinking
        .get("schedule")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let model_reasoning =
        crate::agent::provider_model_reasoning(&providers_map, &provider_id, &model);
    // A scheduled run must see the SAME context a normal turn would: the skills
    // and MCP connectors the task names, plus everything carried by the plugins
    // it names (a plugin is one unit — its connectors COME ALONG and its skills
    // are ATTACHED outright, mirroring the input path's resolvePluginTurn).
    let plugin_slugs = task_plugins;
    let mut task_skills: Vec<String> = string_list(&task, "skills");
    for name in crate::plugins::bundle_skill_names(data_root, &plugin_slugs) {
        // The task row wins on conflict: a skill named explicitly on the task
        // is never displaced by a bundle's copy of it.
        if !task_skills.iter().any(|s| s == &name) {
            task_skills.push(name);
        }
    }
    let mut task_mcp = crate::plugins::mcp_of(data_root, &plugin_slugs);
    // A named connector now lives in a bundle, so the lookup is by name across
    // every ENABLED bundle — the `plugins` list already carries what the task
    // needs, and a disabled bundle contributes nothing (it is the off switch).
    let stored_mcp = crate::plugins::enabled_connectors(data_root);
    for name in string_list(&task, "mcp_servers") {
        // A connector that disappeared from the store is skipped instead of
        // failing the whole run: the task keeps working with what still exists.
        if let Some(cfg) = stored_mcp.get(&name) {
            task_mcp.insert(name, cfg.clone());
        }
    }
    // Every model a scheduled run may use, in try order: the Schedule row's own
    // model first, then that row's fallback list (Settings → Tools), rebuilt per
    // RUN so nothing is remembered between runs. The task/provider default is
    // rung 0 when the row is empty, so a run always has something to call.
    let chain: Vec<(String, String, String, Vec<String>, String)> =
        crate::backend_light::resolve_slot_chain(
            slot_entry,
            tool_fallbacks.get("schedule").map(Vec::as_slice).unwrap_or(&[]),
            &model,
            &base_url,
            &api_keys,
            &provider_id,
            &provider_kind,
            &providers_map,
        )
        .into_iter()
        // `resolve_slot_chain` returns (model, base, keys, provider_id, kind).
        .map(|(m, b, keys, pid, kind)| (kind, m, b, keys, pid))
        .collect();

    let req = crate::agent::AgentRequest {
        provider: provider_kind,
        provider_id,
        model,
        base_url,
        // `api_keys` carries the full chain; `run_turn` only prepends `api_key`
        // when it is non-empty, so an empty one here avoids sending the same
        // key twice.
        api_key: String::new(),
        api_keys,
        root,
        mode: task
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("build")
            .to_string(),
        prompt,
        history: vec![],
        system_prompt: String::new(),
        // A scheduled run has no listener, so it is never spoken.
        system_suffix: String::new(),
        skills: task_skills,
        context_window: 0,
        chat_id: format!("schedule-{sid}"),
        mcp_servers: if task_mcp.is_empty() {
            Value::Null
        } else {
            Value::Object(task_mcp)
        },
        // A schedule is a single headless turn: nothing carries an activation
        // back to it, so a scheduled run starts with every connector on the
        // index and loads one only if that run actually calls `use_mcp`.
        mcp_active: Vec::new(),
        subagent_models,
        providers: providers_map,
        data_root: data_root.to_string_lossy().to_string(),
        // Headless scheduled runs never touch the desktop.
        allow_computer: false,
        // Nor the browser: nobody is watching a window a schedule opens.
        allow_browser: false,
        // Nor do they author skills/connectors: a schedule has no user turn
        // asking for it, so the authoring tools stay unbound.
        allow_create: false,
        // Headless: there is nobody to ask, so no out-of-workspace grant can be
        // given. The workspace, the OS temp roots and `~/.codifa` stay open.
        allow_outside: false,
        allow_outside_folders: Vec::new(),
        // The engine chain is the user's own Settings → Plugins order (tavily
        // default, duckduckgo fallback…): the SAME list the chat sends —
        // `search_with_engine` reads `order`/`enabled`/`apiKey`. The settings
        // doc was already secret-decrypted above (searchPlugins keys too).
        search_plugins: settings
            .get("searchPlugins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        // Headless runs have no UI to compact against, so they keep the
        // default threshold and no summarizer override; mid-turn compaction
        // still protects them from a "context length exceeded" hard failure.
        compact_at_percent: 80,
        fallback_provider: String::new(),
        fallback_model: String::new(),
        fallback_base_url: String::new(),
        fallback_api_key: String::new(),
        fallback_api_keys: Vec::new(),
        // The reasoning level comes from the Tools "Schedule" row (empty = no
        // explicit effort, i.e. the provider's own default).
        thinking_level,
        model_reasoning,
        subagent_thinking,
        // The per-tool fallback lists (Settings → Tools) apply to a scheduled
        // run exactly like an interactive one: a tool whose own model fails is
        // retried down that tool's list, for that call only.
        tool_fallbacks,
        images: Vec::new(),
        // A headless run has no UI, so it reads no Storage setting: it uses the
        // same default auto-fetch count the UI starts at.
        web_search_auto_fetch: crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT,
        // No renderer to send a table: `run_turn` derives it from the task's
        // mode, so a scheduled Ask run is read-only like an interactive one.
        cap: None,
        // Headless: a mid-turn provider error must come back as `Err` so it
        // reaches this run record and the fallback chain below. With the
        // interactive protocol's swallow-as-Ok a run that died at step 5 was
        // saved as "done" with the first narration message as its final answer.
        headless: true,
    };

    // Run once to know whether the chain was empty: an empty chain is the one
    // failure mode that never reaches the loop, so nothing records an error.
    let chain_rungs = chain.len();
    let mut final_text = String::new();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Walk the chain one rung per failure. A rejected key or an unknown model on
    // one rung must not end the run while the user's own fallback list still has
    // models in it — the same rule the interactive tools follow.
    let mut tried: Vec<String> = Vec::new();
    // The most text any rung produced before failing: a mid-turn provider error
    // must still leave the work so far in the run record (the inbox shows it
    // under the error line) instead of dropping the whole turn.
    let mut partial_text = String::new();
    // The last failure the chain saw, verbatim — the run record's `error` when
    // no rung succeeded. A headless `run_turn` hands back the REAL provider
    // error now, so the inbox no longer has to guess "model returned no text".
    let mut last_error = String::new();
    eprintln!(
        "[schedule] run {run_id} for '{sid}' starting: {chain_rungs} rung(s), first '{}'",
        chain.first().map(|(_, m, ..)| m.as_str()).unwrap_or("-")
    );
    for (kind, rung_model, rung_base, rung_keys, rung_provider_id) in chain {
        let mut rung = req.clone();
        rung.provider = kind;
        rung.model = rung_model.clone();
        rung.base_url = rung_base;
        rung.api_keys = rung_keys;
        rung.provider_id = rung_provider_id;
        // The capability flag follows the model actually being called, so a
        // fallback that cannot reason is not sent a reasoning parameter.
        rung.model_reasoning = crate::agent::provider_model_reasoning(
            &rung.providers,
            &rung.provider_id,
            &rung.model,
        );
        // The final text is accumulated from the turn's own `text` events: the
        // trace file has no `text` row at all (it records prompt/tool/llm/fold),
        // so reading it back always produced an empty output.
        let mut text = String::new();
        let mut turn_errors: Vec<String> = Vec::new();
        let res = {
            let mut emit = |ev: &crate::agent::AgentEvent| match ev {
                crate::agent::AgentEvent::Text { content } => text.push_str(content),
                // Backstop: with `headless` set the stream-error path returns
                // Err instead of emitting Error, but any other emitter must
                // still fail the run — an error event is never a success.
                crate::agent::AgentEvent::Error { content } => {
                    turn_errors.push(content.clone());
                }
                _ => {}
            };
            crate::agent::run_turn(&rung, &mut emit, &cancel).await
        };
        match res {
            Ok(()) if turn_errors.is_empty() => {
                final_text = text;
                break;
            }
            Ok(()) => {
                let e = turn_errors.join("; ");
                eprintln!("[schedule] run {run_id} rung '{rung_model}' reported error: {e}");
                last_error = e.clone();
                tried.push(format!("{rung_model}: {e}"));
                if text.chars().count() > partial_text.chars().count() {
                    partial_text = text;
                }
                if !crate::llm::should_fall_back(&e) {
                    break;
                }
            }
            Err(e) => {
                eprintln!("[schedule] run {run_id} rung '{rung_model}' failed: {e}");
                // Only a model-side rejection moves to the next model. A dropped
                // connection or a timeout ends the run with its own reason
                // instead of billing every fallback for a network problem.
                let next = crate::llm::should_fall_back(&e);
                last_error = e.clone();
                tried.push(format!("{rung_model}: {e}"));
                if text.chars().count() > partial_text.chars().count() {
                    partial_text = text;
                }
                if !next {
                    break;
                }
            }
        }
    }

    let finished = now_secs();
    if final_text.trim().is_empty() {
        // An empty body is NEVER a success: record WHY it is empty instead of
        // "done" with no output — that read like the schedule had simply
        // produced nothing and left the inbox at a bare "No output".
        let reason = if tried.len() > 1 {
            // Several rungs failed: record all the reasons.
            format!("every model failed — {}", tried.join("; "))
        } else if !last_error.is_empty() {
            // One rung named the real failure (provider error, rejected key,
            // mid-turn stream death): record IT, not a generic guess.
            last_error.clone()
        } else if chain_rungs == 0 {
            // The model chain was empty: no endpoint was ever called.
            "no model configured for the Schedule slot (Settings → Tools)".to_string()
        } else {
            // A rung succeeded but returned no text (refused/filtered reply).
            format!("model returned no text after {chain_rungs} attempt(s)")
        };
        let mut out_text = partial_text;
        if out_text.chars().count() > RUN_OUTPUT_CAP {
            out_text = out_text.chars().take(RUN_OUTPUT_CAP).collect();
        }
        eprintln!("[schedule] run {run_id} for '{sid}' finished: error — {reason}");
        save_run(
            data_root,
            &json!({
                "id": run_id, "schedule_id": sid, "status": "error",
                "error": reason,
                // Whatever the turn produced before the failure stays visible in
                // the inbox, under the error line — a half-finished turn is not
                // "no output".
                "output": out_text, "started_at": started_at, "finished_at": finished,
            }),
        );
    } else {
        let mut out_text = final_text;
        if out_text.chars().count() > RUN_OUTPUT_CAP {
            out_text = out_text.chars().take(RUN_OUTPUT_CAP).collect();
        }
        eprintln!(
            "[schedule] run {run_id} for '{sid}' finished: done, {} chars",
            out_text.chars().count()
        );
        save_run(
            data_root,
            &json!({
                "id": run_id, "schedule_id": sid, "status": "done",
                "output": out_text, "started_at": started_at,
                "finished_at": finished,
            }),
        );
    }
    // Update the task's last_run / run_count / next_run. Re-read the task from
    // disk first: writing back the pre-run snapshot silently reverted any edit
    // (prompt/name/enabled/cron/model) the user made while the run was still
    // in flight.
    let mut fresh = load_schedule(data_root, &sid).unwrap_or_else(|| task.clone());
    let next = compute_next_run(&fresh, finished);
    if let Some(obj) = fresh.as_object_mut() {
        obj.insert("last_run".into(), json!(finished));
        let count = obj.get("run_count").and_then(Value::as_u64).unwrap_or(0);
        obj.insert("run_count".into(), json!(count + 1));
        obj.insert(
            "next_run".into(),
            match next {
                Some(n) => json!(n),
                None => Value::Null,
            },
        );
    }
    save_schedule(data_root, fresh);
}

// --- loop ---------------------------------------------------------------------

/// One due-check tick: heal stale next_run values, start due tasks. Returns
/// the number of runs started.
pub async fn run_due_schedules(data_root: &Path) -> usize {
    let now = now_secs();
    let mut started = 0usize;
    for task in list_schedules(data_root) {
        let sid = task
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if sid.is_empty() || !task.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
            continue;
        }
        if has_recent_running(data_root, &sid, now) {
            continue;
        }
        if !is_due(&task, now) {
            // Heal a missing/stale next_run so the task never sticks.
            let nxt = task.get("next_run").and_then(Value::as_f64);
            let stale = nxt.is_none()
                || nxt.map(|n| n <= now && (now - n) > DUE_GRACE_SECS).unwrap_or(false);
            if stale {
                let mut fresh = task.clone();
                let next = compute_next_run(&fresh, now);
                if let Some(obj) = fresh.as_object_mut() {
                    obj.insert(
                        "next_run".into(),
                        match next {
                            Some(n) => json!(n),
                            None => Value::Null,
                        },
                    );
                }
                save_schedule(data_root, fresh);
                    }
                    continue;
                }
        // Advance next_run BEFORE spawning so the next tick (30s later) does
        // not see the same task as due again while the run is still going.
        let mut fresh = task.clone();
        let next = compute_next_run(&fresh, now);
        if let Some(obj) = fresh.as_object_mut() {
            obj.insert(
                "next_run".into(),
                match next {
                    Some(n) => json!(n),
                    None => Value::Null,
                },
            );
        }
        save_schedule(data_root, fresh);
        let data_root = data_root.to_path_buf();
        tokio::spawn(async move {
            execute_schedule(&data_root, task).await;
        });
        started += 1;
    }
    started
}

/// Spawn the background due-check loop (called once at app startup).
/// Runs on its own thread with a dedicated tokio runtime — the Tauri setup
/// hook runs on the main thread where no reactor exists (tokio::spawn there
/// panics with "there is no reactor running").
pub fn start_loop(data_root: std::path::PathBuf) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("scheduler runtime");
        rt.block_on(async move {
            // Small initial delay so startup can finish.
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            // (Re)start: no run of THIS process exists yet, so EVERY stored
            // "running" row is a leftover of a dead one. Close all of them —
            // the old check only caught runs older than an hour, so rows left
            // by a crash minutes ago spun the schedule page AND the inbox for
            // the rest of that hour.
            let orphans = mark_orphaned_running(&data_root, 0.0);
            if orphans > 0 {
                println!("[scheduler] closed {orphans} orphaned running runs");
            }
            loop {
                let _ = run_due_schedules(&data_root).await;
                // A run outliving ORPHAN_AFTER_SECS is a hung agent loop, not
                // a long job — settle its row too, or its spinner never stops.
                let hung = mark_orphaned_running(&data_root, ORPHAN_AFTER_SECS);
                if hung > 0 {
                    println!("[scheduler] closed {hung} hung running runs");
                }
                tokio::time::sleep(std::time::Duration::from_secs(POLL_SECS)).await;
            }
        });
    });
}

// --- tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphan_sweep_min_age_zero_closes_fresh_running_rows() {
        let tmp = std::env::temp_dir().join(format!("sched-orphan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        save_run(
            &tmp,
            &json!({"id": "run-orph-1", "schedule_id": "sch-x", "status": "running",
                    "output": "", "started_at": now_secs()}),
        );
        save_run(
            &tmp,
            &json!({"id": "run-orph-2", "schedule_id": "sch-x", "status": "done",
                    "output": "", "started_at": now_secs()}),
        );
        // A live long job is never touched by the periodic sweep.
        assert_eq!(mark_orphaned_running(&tmp, ORPHAN_AFTER_SECS), 0);
        // Startup sweep: the fresh "running" row is leftovers of a dead
        // process — closed even though it is seconds old.
        assert_eq!(mark_orphaned_running(&tmp, 0.0), 1);
        let rows = list_runs(&tmp, "", 10);
        let run = rows.iter().find(|r| r["id"] == "run-orph-1").unwrap();
        assert_eq!(run["status"], "error");
        assert_eq!(run["error"], "interrupted (app restarted)");
        // Settled rows are never re-touched.
        assert_eq!(mark_orphaned_running(&tmp, 0.0), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cron_next_run_matches_python_semantics() {
        let off = local_utc_offset_secs();
        // Every minute: next after 00:00:30 is 00:01:00.
        let n = next_run_after("* * * * *", 0.0, off).unwrap();
        assert_eq!(n, 60.0);
        // Daily at 09:00 BY THE WALL CLOCK: from 00:00:30 the next fire is
        // today 09:00 local, whichever zone the host runs in.
        let n = next_run_after("0 9 * * *", 30.0, off).unwrap();
        use chrono::Timelike;
        let local = chrono::DateTime::from_timestamp(n as i64 + off as i64, 0).unwrap();
        assert_eq!(local.hour(), 9);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.second(), 0);
        assert!(n > 30.0);
        // Once (empty cron) → None.
        assert_eq!(next_run_after("", 0.0, off), None);
        // Invalid field count → None.
        assert_eq!(next_run_after("0 9 * *", 0.0, off), None);
    }

    #[test]
    fn plugin_context_lists_scripts_but_skips_disabled() {
        let tmp = std::env::temp_dir().join(format!("sched-plug-test-{}", std::process::id()));
        let plug = tmp.join("plugins/demo");
        let off_plug = tmp.join("plugins/off-demo");
        for dir in [
            plug.join("scripts/cleanup"),
            off_plug.join("scripts/ghost"),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
        }
        std::fs::write(plug.join("plugin.json"), r#"{"name":"Demo","enabled":true}"#).unwrap();
        std::fs::write(
            plug.join("scripts/cleanup/script.json"),
            r#"{"name":"cleanup","language":"rust","description":"wipe temp files"}"#,
        )
        .unwrap();
        std::fs::write(
            off_plug.join("plugin.json"),
            r#"{"name":"Off","enabled":false}"#,
        )
        .unwrap();
        let all = vec!["demo".to_string(), "off-demo".to_string()];
        // The enabled bundle shows up with every script it carries.
        let on = plugin_context_block(&tmp, &all[..1]);
        assert!(on.contains("PLUGIN TOOLS"), "{on}");
        assert!(on.contains("demo") && on.contains("[rust]") && on.contains("cleanup"), "{on}");
        // A switched-off bundle contributes nothing — the toggle is the truth.
        let disabled = plugin_context_block(&tmp, &all[1..]);
        assert!(disabled.is_empty(), "{disabled}");
        // No plugins at all → no block.
        let none: Vec<String> = Vec::new();
        assert!(plugin_context_block(&tmp, &none).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn is_due_semantics() {
        let now = 1_000_000.0;
        // Recurring, next_run inside grace → due.
        let t = json!({"enabled": true, "cron": "* * * * *", "next_run": now - 30.0});
        assert!(is_due(&t, now));
        // Stale next_run (older than grace) → not due (healed by the loop).
        let t = json!({"enabled": true, "cron": "* * * * *", "next_run": now - 3600.0});
        assert!(!is_due(&t, now));
        // Future next_run → not due.
        let t = json!({"enabled": true, "cron": "* * * * *", "next_run": now + 60.0});
        assert!(!is_due(&t, now));
        // Once, never ran → due.
        let t = json!({"enabled": true, "cron": ""});
        assert!(is_due(&t, now));
        // Once, already ran → never due.
        let t = json!({"enabled": true, "cron": "", "last_run": now - 10.0});
        assert!(!is_due(&t, now));
        // Disabled → never due.
        let t = json!({"enabled": false, "cron": "* * * * *", "next_run": now - 30.0});
        assert!(!is_due(&t, now));
    }

    #[test]
    fn compute_next_run_no_catchup() {
        // last_run far in the past (paused period): next is computed from NOW,
        // not from last_run — no burst of missed runs.
        let now = 1_000_000.0;
        let t = json!({"enabled": true, "cron": "* * * * *", "last_run": 100.0});
        let n = compute_next_run(&t, now).unwrap();
        let expected = ((now as i64) / 60 + 1) * 60;
        assert_eq!(n, expected as f64);
    }
}
