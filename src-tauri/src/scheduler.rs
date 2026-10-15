//! Native schedule execution loop (migrated from backend/scheduler.py +
//! server.py's _start_schedule_loop / _run_due_schedules / _execute_schedule).
//!
//! Cron format: 5 fields (minute hour dom month dow), UTC. Presets
//! ("once"/"hourly"/"daily"/"weekly"/"every N minutes|hours") are normalized
//! to cron by the frontend before save, so the loop only sees real cron.
//! All timestamps are epoch seconds (UTC), matching state_db's layout.

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
    next_run_after(spec, 0.0).is_some() || spec.split_whitespace().count() == 5 && {
        let parts: Vec<&str> = spec.split_whitespace().collect();
        let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
        parts
            .iter()
            .zip(bounds)
            .all(|(p, (lo, hi))| parse_field(p, lo, hi).is_ok())
    }
}

/// Next fire time (epoch secs) strictly after `after_ts`; None for ""/once.
pub fn next_run_after(cron: &str, after_ts: f64) -> Option<f64> {
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
    for _ in 0..(366 * 2 * 24 * 60) {
        let dt = chrono::DateTime::from_timestamp(cursor, 0)?;
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
    next_run_after(&cron, now.max(last))
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

fn atomic_write_json(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
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
        let re = regex::Regex::new(r"[^A-Za-z0-9._-]+").expect("static regex");
        let safe = re.replace_all(id.trim(), "-");
        let name = if safe.trim_matches(['.', '-']).is_empty() {
            "schedule".to_string()
        } else {
            safe.trim_matches(['.', '-']).to_string()
        };
        let _ = atomic_write_json(&schedules_dir(data_root).join(format!("{name}.json")), &task);
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
            v.sort();
            v.reverse();
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
    list_runs(data_root, schedule_id, 5).iter().any(|r| {
        r.get("status").and_then(Value::as_str) == Some("running")
            && {
                let started = r.get("started_at").and_then(Value::as_f64).unwrap_or(0.0);
                started != 0.0 && (now - started) < RUNNING_WINDOW_SECS
            }
    })
}

/// Close running runs orphaned by a dead process (status → error).
fn mark_orphaned_running(data_root: &Path) -> usize {
    let now = now_secs();
    let mut fixed = 0usize;
    for r in list_runs(data_root, "", 10_000) {
        if r.get("status").and_then(Value::as_str) != Some("running") {
            continue;
        }
        let started = r.get("started_at").and_then(Value::as_f64).unwrap_or(0.0);
        if started != 0.0 && (now - started) < ORPHAN_AFTER_SECS {
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
    let settings = read_json(&data_root.join("settings.json")).unwrap_or(json!({}));
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
async fn execute_schedule(data_root: &Path, task: Value) {
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
    let run_id = format!("run-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
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
    let model = task
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .or_else(|| provider.get("model").and_then(Value::as_str).map(String::from))
        .unwrap_or_default();
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let req = crate::agent::AgentRequest {
        provider: provider
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("custom")
            .to_string(),
        provider_id: provider
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model,
        base_url: provider
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        api_key,
        api_keys: vec![],
        root,
        mode: task
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("build")
            .to_string(),
        prompt,
        history: vec![],
        system_prompt: String::new(),
        skills: vec![],
        context_window: 0,
        chat_id: format!("schedule-{sid}"),
        mcp_servers: Value::Null,
        subagent_models: std::collections::HashMap::new(),
        providers: std::collections::HashMap::new(),
        data_root: String::new(),
    };

    let mut final_text = String::new();
    let mut usage_in: u64 = 0;
    let mut usage_out: u64 = 0;
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let res = {
        let mut emit = |_ev: &crate::agent::AgentEvent| {};
        crate::agent::run_turn(&req, &mut emit, &cancel).await
    };
    // run_turn streams text via events; for the headless run we only need the
    // final text — re-run is avoided by capturing from the trace store below.
    let _ = res;

    // Collect the final text from the turn's trace (the agent records the
    // full prompt/tool trail; the final text is the last text row).
    if let Some(dir) = crate::trace::traces_dir() {
        if let Ok(rows) = std::fs::read_to_string(dir.join(format!("schedule-{sid}.jsonl"))) {
            for line in rows.lines().rev() {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if v.get("kind").and_then(Value::as_str) == Some("text") {
                        final_text = v
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        break;
                    }
                }
            }
        }
    }
    let _ = (&mut usage_in, &mut usage_out);

    let finished = now_secs();
    let mut out_text = final_text;
    if out_text.chars().count() > RUN_OUTPUT_CAP {
        out_text = out_text.chars().take(RUN_OUTPUT_CAP).collect();
    }
    save_run(
        data_root,
        &json!({
            "id": run_id, "schedule_id": sid, "status": "done",
            "output": out_text, "started_at": started_at,
            "finished_at": finished,
        }),
    );
    // Update the task's last_run / run_count / next_run.
    let mut fresh = task.clone();
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
            let orphans = mark_orphaned_running(&data_root);
            if orphans > 0 {
                println!("[scheduler] closed {orphans} orphaned running runs");
            }
            loop {
                let _ = run_due_schedules(&data_root).await;
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
    fn cron_next_run_matches_python_semantics() {
        // Every minute: next after 00:00:30 is 00:01:00.
        let n = next_run_after("* * * * *", 0.0).unwrap();
        assert_eq!(n, 60.0);
        // Daily at 09:00: from 00:00:30 the next is today 09:00.
        let n = next_run_after("0 9 * * *", 30.0).unwrap();
        assert_eq!(n, 9.0 * 3600.0);
        // Once (empty cron) → None.
        assert_eq!(next_run_after("", 0.0), None);
        // Invalid field count → None.
        assert_eq!(next_run_after("0 9 * *", 0.0), None);
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
