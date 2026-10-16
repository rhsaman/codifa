//! Native Laya decision router: the on-device skill classifier, in-process.
//!
//! Laya (`convaiinnovations/laya`) is a ModernBERT encoder plus a from-scratch
//! decision head. It used to run in the Python sidecar, which kept `torch` and
//! `transformers` in the runtime dependency set and cost ~1.5 GB per load.
//! `scripts/export-laya-onnx.py` converts the checkpoint to ONNX once, offline;
//! this module runs that graph through `ort` — the same runtime the e5
//! embedding model already uses.
//!
//! Routing asks one binary "is this request exactly this skill's task?"
//! question per prefiltered candidate in a single forward pass, and picks a
//! candidate only when P(skill) beats P(none) by a margin. That mirrors
//! `backend/laya_router.py`, which this replaces.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ort::session::Session;
use ort::value::Tensor;
use serde_json::Value;
use tokenizers::Tokenizer;

use crate::embeddings::{data_root, ort_env};

/// Folder the downloader writes the decision model into (see `model_download.py`).
const LAYA_DIR: &str = "laya--convaiinnovations--laya";
/// Sub-build preferred for non-Latin requests (e.g. Persian).
const MULTILINGUAL: &str = "multilingual";
/// Max candidates offered to Laya per turn. The checkpoint is near-chance
/// zero-shot on high-cardinality choices, so routing asks one binary question
/// per candidate instead of one big choice; the prefilter narrows any store
/// size to these top candidates.
const MAX_OPTIONS: usize = 5;
/// Min margin (P(skill) - P(none)) for a candidate to be picked. Below this the
/// candidate is treated as not matching, so a missing skill loads nothing.
const MIN_MARGIN: f32 = 0.3;
/// Max skills auto-loaded per turn.
const MAX_PICKS: usize = 2;
/// Max chars of the request text fed to Laya (matches the caller's cap).
const PROMPT_MAX_CHARS: usize = 1500;
/// The "no skill fits" option key.
const NONE_OPTION: &str = "none";
/// Question-type index for a `choice` question (see `rl_common.QTYPES`).
const QTYPE_CHOICE: i64 = 0;
/// Per-option token budget for the option text itself (see `rl_common.build_sequence`).
const OPTION_TOKEN_CAP: usize = 48;

const BIN_INSTRUCTIONS: &str = "Is this request exactly the kind of task this skill is for? \
Pick the skill only when the request is that exact task; otherwise pick none.";

const NONE_DESC: &str = "no skill fits: the request is a plain bug fix, refactor, \
debugging task, or a different task entirely";

/// How long the session may sit unused before it is released. The int8 graph is
/// a few hundred MB, so an idle one is dropped rather than kept for the session.
const IDLE_EVICT_SECS: u64 = 60;
/// How often the evictor checks. Cheap: one atomic load per tick.
const EVICT_TICK_SECS: u64 = 30;

struct Laya {
    session: Session,
    tokenizer: Tokenizer,
    cls_id: u32,
    sep_id: u32,
    mask_id: u32,
    max_len: usize,
    head_max_len: usize,
    /// Softmax temperature for a 2-option choice question, fitted post-hoc in
    /// the checkpoint's own evaluation (see `rl_agent_config.json`).
    temperature: f32,
}

/// `None` = not loaded yet, `Some(Err)` = load failed (do not retry).
static LAYA: OnceLock<Mutex<Option<Result<Laya, String>>>> = OnceLock::new();
static LAST_USE: AtomicU64 = AtomicU64::new(0);
static EVICTOR: OnceLock<()> = OnceLock::new();

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn slot() -> &'static Mutex<Option<Result<Laya, String>>> {
    LAYA.get_or_init(|| Mutex::new(None))
}

/// Start the idle evictor once. It only ever drops an already-loaded session,
/// so it costs nothing while Laya is unused.
fn spawn_evictor() {
    EVICTOR.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(EVICT_TICK_SECS));
            let last = LAST_USE.load(Ordering::Relaxed);
            if last == 0 || now_secs().saturating_sub(last) < IDLE_EVICT_SECS {
                continue;
            }
            // Only evict when nothing is mid-inference: a held lock means busy.
            if let Ok(mut guard) = slot().try_lock() {
                if guard.is_some() {
                    *guard = None;
                    LAST_USE.store(0, Ordering::Relaxed);
                }
            }
        });
    });
}

/// True when the text has any non-ASCII character, which selects the
/// multilingual sub-build (mirrors `laya_router._has_non_latin`).
pub fn has_non_latin(text: &str) -> bool {
    text.chars().any(|c| c as u32 > 127)
}

/// The exported graph inside `dir`, preferring the quantized build.
fn graph_path(dir: &Path) -> Option<PathBuf> {
    let onnx = dir.join("onnx");
    for name in ["model.int8.onnx", "model.onnx"] {
        let p = onnx.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// A usable sub-build: graph + tokenizer + config all present.
fn ready_dir(dir: &Path) -> bool {
    graph_path(dir).is_some()
        && dir.join("tokenizer").join("tokenizer.json").is_file()
        && dir.join("rl_agent_config.json").is_file()
}

/// Concrete model dir for `prompt`; `None` when nothing usable is downloaded.
///
/// Prefers the multilingual checkpoint for non-Latin requests (e.g. Persian)
/// when that sub-build is present, mirroring the upstream router which picks
/// the checkpoint per request.
pub fn model_dir(prompt: &str) -> Option<PathBuf> {
    let base = data_root().join("models").join(LAYA_DIR);
    if !base.is_dir() {
        return None;
    }
    if has_non_latin(prompt) {
        let multi = base.join(MULTILINGUAL);
        if ready_dir(&multi) {
            return Some(multi);
        }
    }
    if ready_dir(&base) {
        Some(base)
    } else {
        None
    }
}

/// True when a usable Laya build is downloaded (no model load).
pub fn is_available() -> bool {
    model_dir("").is_some() || model_dir("فارسی").is_some()
}

/// Resolve a special token's id for one sub-build.
///
/// The two builds name their special tokens differently (the base ModernBERT
/// uses `[CLS]`/`[SEP]`/`[MASK]`, the multilingual mmBERT uses
/// `<s>`/`</s>`/`<mask>`), and `Tokenizer::token_to_id` only sees the base
/// vocabulary — the specials live in `added_tokens`. So the name comes from
/// `tokenizer_config.json` (which is authoritative per build) and the id is
/// looked up in the tokenizer, which does index added tokens by name.
fn special_id(dir: &Path, tokenizer: &Tokenizer, key: &str, fallback: &str) -> Result<u32, String> {
    let cfg_path = dir.join("tokenizer").join("tokenizer_config.json");
    let name = std::fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|cfg| cfg[key].as_str().map(str::to_string))
        .unwrap_or_else(|| fallback.to_string());
    tokenizer
        .token_to_id(&name)
        .or_else(|| tokenizer.token_to_id(fallback))
        .ok_or_else(|| format!("laya tokenizer has no {key} ({name})"))
}

fn load(prompt: &str) -> Result<Laya, String> {
    let dir = model_dir(prompt).ok_or_else(|| {
        format!(
            "laya model not downloaded (expected {LAYA_DIR} under {}/models)",
            data_root().display()
        )
    })?;
    let graph = graph_path(&dir).ok_or_else(|| "laya onnx graph missing".to_string())?;
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer").join("tokenizer.json"))
        .map_err(|e| format!("laya tokenizer load failed: {e}"))?;

    let cfg: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("rl_agent_config.json"))
            .map_err(|e| format!("laya config read failed: {e}"))?,
    )
    .map_err(|e| format!("laya config parse failed: {e}"))?;
    let max_len = cfg["max_len"].as_u64().unwrap_or(512) as usize;
    let head_max_len = cfg["head_max_len"].as_u64().unwrap_or(192) as usize;
    // A 2-option choice has its own fitted temperature; fall back to the
    // per-qtype value, then to 1.0 (no scaling) when neither is present.
    let temperature = cfg["temperature_by_options"]["choice:2"]
        .as_f64()
        .or_else(|| cfg["temperature"][QTYPE_CHOICE as usize].as_f64())
        .unwrap_or(1.0) as f32;

    let session = Session::builder(ort_env()?)
        .map_err(|e| format!("laya session builder failed: {e}"))?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|e| format!("laya optimization level failed: {e}"))?
        .with_intra_threads(2)
        .map_err(|e| format!("laya thread config failed: {e}"))?
        .commit_from_file(&graph)
        .map_err(|e| format!("laya model load failed: {e}"))?;

    let cls_id = special_id(&dir, &tokenizer, "cls_token", "[CLS]")?;
    let sep_id = special_id(&dir, &tokenizer, "sep_token", "[SEP]")?;
    let mask_id = special_id(&dir, &tokenizer, "mask_token", "[MASK]")?;

    Ok(Laya {
        session,
        tokenizer,
        cls_id,
        sep_id,
        mask_id,
        max_len,
        head_max_len,
        temperature,
    })
}

impl Laya {
    /// Tokenize without the tokenizer's own special tokens: the sequence is
    /// assembled by hand, so `[CLS]`/`[SEP]` must not be added twice.
    fn encode_raw(&self, text: &str) -> Vec<u32> {
        self.tokenizer
            .encode(text, false)
            .map(|e| e.get_ids().to_vec())
            .unwrap_or_default()
    }

    /// Build one question's sequence and the positions of its option markers.
    ///
    /// Layout (see `rl_common.build_sequence`):
    /// `[CLS] <type> question: <instructions> [SEP] [MASK] opt0 [MASK] opt1 [SEP] <state> [SEP]`
    fn build_sequence(&self, state: &str, options: &[String]) -> (Vec<i64>, Vec<i64>) {
        let ins = BIN_INSTRUCTIONS.replace("[MASK]", " ");
        let head_ids = self.encode_raw(&format!("choice question: {ins}"));

        let mut opt_ids: Vec<Vec<u32>> = Vec::with_capacity(options.len());
        for opt in options {
            let text = format!(" {}", opt.replace("[MASK]", " "));
            let mut ids = vec![self.mask_id];
            ids.extend(self.encode_raw(&text).into_iter().take(OPTION_TOKEN_CAP));
            opt_ids.push(ids);
        }

        let total_opts = |o: &[Vec<u32>]| o.iter().map(|v| v.len() as i64).sum::<i64>();
        let mut opt_budget = self.head_max_len as i64 - total_opts(&opt_ids);
        if opt_budget < 16 {
            // Too many / too long options: shrink every option text evenly.
            let per = std::cmp::max(4, (self.head_max_len as i64 - 16) / std::cmp::max(1, opt_ids.len() as i64));
            for o in opt_ids.iter_mut() {
                o.truncate(per as usize);
            }
            opt_budget = self.head_max_len as i64 - total_opts(&opt_ids);
        }
        let head_ids: Vec<u32> = head_ids
            .into_iter()
            .take(std::cmp::max(8, opt_budget) as usize)
            .collect();

        let mut ids: Vec<u32> = vec![self.cls_id];
        ids.extend(head_ids);
        ids.push(self.sep_id);
        let mut markers: Vec<usize> = Vec::with_capacity(opt_ids.len());
        for o in &opt_ids {
            markers.push(ids.len());
            ids.extend(o);
        }
        ids.push(self.sep_id);

        let room = self.max_len.saturating_sub(ids.len() + 1);
        let st: Vec<u32> = self
            .encode_raw(&state.replace("[MASK]", " "))
            .into_iter()
            .take(room)
            .collect();
        ids.extend(st);
        ids.push(self.sep_id);
        ids.truncate(self.max_len);

        let markers: Vec<i64> = markers
            .into_iter()
            .filter(|m| *m < self.max_len)
            .map(|m| m as i64)
            .collect();
        (ids.into_iter().map(|i| i as i64).collect(), markers)
    }

    /// One forward pass over every question; returns the per-option logits.
    fn logits(&mut self, sequences: &[(Vec<i64>, Vec<i64>)]) -> Result<Vec<Vec<f32>>, String> {
        let batch = sequences.len();
        if batch == 0 {
            return Ok(Vec::new());
        }
        let seq = sequences.iter().map(|(ids, _)| ids.len()).max().unwrap_or(1).max(1);
        let n_markers = sequences.iter().map(|(_, m)| m.len()).max().unwrap_or(0);
        if n_markers == 0 {
            return Ok(Vec::new());
        }

        let mut input_ids = vec![0i64; batch * seq];
        let mut attention = vec![0i64; batch * seq];
        let mut marker_pos = vec![0i64; batch * n_markers];
        let mut marker_mask = vec![false; batch * n_markers];
        for (row, (ids, markers)) in sequences.iter().enumerate() {
            for (col, id) in ids.iter().enumerate() {
                input_ids[row * seq + col] = *id;
                attention[row * seq + col] = 1;
            }
            for (k, m) in markers.iter().enumerate() {
                marker_pos[row * n_markers + k] = *m;
                marker_mask[row * n_markers + k] = true;
            }
        }

        let shape = vec![batch as i64, seq as i64];
        let mshape = vec![batch as i64, n_markers as i64];
        let qtype = vec![QTYPE_CHOICE; batch];
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array((shape.clone(), input_ids)).map_err(|e| format!("input_ids tensor failed: {e}"))?,
                "attention_mask" => Tensor::from_array((shape, attention)).map_err(|e| format!("attention_mask tensor failed: {e}"))?,
                "marker_pos" => Tensor::from_array((mshape.clone(), marker_pos)).map_err(|e| format!("marker_pos tensor failed: {e}"))?,
                "marker_mask" => Tensor::from_array((mshape, marker_mask)).map_err(|e| format!("marker_mask tensor failed: {e}"))?,
                "qtype" => Tensor::from_array((vec![batch as i64], qtype)).map_err(|e| format!("qtype tensor failed: {e}"))?,
            ])
            .map_err(|e| format!("laya inference failed: {e}"))?;

        let (out_shape, out) = outputs["logits"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("laya logits extract failed: {e}"))?;
        let cols = out_shape.last().copied().unwrap_or(n_markers as i64) as usize;
        let mut rows = Vec::with_capacity(batch);
        for row in 0..batch {
            let k = sequences[row].1.len().min(cols);
            rows.push(out[row * cols..row * cols + k].to_vec());
        }
        Ok(rows)
    }
}

/// Run `f` against the loaded router, loading it on first use.
fn with_laya<T>(prompt: &str, f: impl FnOnce(&mut Laya) -> Result<T, String>) -> Result<T, String> {
    let mut guard = slot().lock().map_err(|_| "laya lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(load(prompt));
        spawn_evictor();
    }
    let out = match guard.as_mut().expect("just filled") {
        Ok(laya) => f(laya),
        Err(err) => Err(err.clone()),
    };
    if out.is_ok() {
        LAST_USE.store(now_secs(), Ordering::Relaxed);
    }
    out
}

/// Softmax over the logits, scaled by the fitted temperature.
fn softmax_scaled(logits: &[f32], temperature: f32) -> Vec<f32> {
    if logits.is_empty() {
        return Vec::new();
    }
    let t = if temperature.abs() < 1e-6 { 1.0 } else { temperature };
    let max = logits.iter().cloned().fold(f32::MIN, f32::max) / t;
    let exps: Vec<f32> = logits.iter().map(|z| (z / t - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    if sum <= 0.0 {
        return vec![1.0 / logits.len() as f32; logits.len()];
    }
    exps.into_iter().map(|e| e / sum).collect()
}

/// Pick the skills whose margin over "none" clears the threshold, best first.
///
/// Pure so the ranking rule is testable without a model: `candidates` is
/// `(name, p_skill, p_none)` in prefilter order.
pub fn pick_by_margin(candidates: &[(String, f32, f32)]) -> Vec<String> {
    let mut margins: Vec<(f32, &str)> = candidates
        .iter()
        .filter_map(|(name, skill, none)| {
            let margin = skill - none;
            (margin >= MIN_MARGIN).then_some((margin, name.as_str()))
        })
        .collect();
    // Descending by margin; ties keep the prefilter order (stable sort).
    margins.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    margins
        .into_iter()
        .take(MAX_PICKS)
        .map(|(_, name)| name.to_string())
        .collect()
}

/// Route `prompt` to skill names with the local Laya classifier.
///
/// `rows` are the prefiltered top candidates (any store size narrows to these
/// before Laya sees them). Each candidate gets one binary skill-vs-none
/// question in a single forward pass; a pick needs a margin of at least
/// [`MIN_MARGIN`] over `none` so a missing skill loads nothing. Returns an empty
/// vec when no skill fits, and `Err` when routing is unavailable (not
/// downloaded / load failure) so the caller falls back to the in-code matcher.
pub fn predict(prompt: &str, rows: &[Value]) -> Result<Vec<String>, String> {
    let text = prompt.trim();
    if text.is_empty() {
        return Err("empty prompt".to_string());
    }
    // One question per candidate, deduplicated by name, capped at MAX_OPTIONS.
    let mut names: Vec<String> = Vec::new();
    let mut options: Vec<Vec<String>> = Vec::new();
    for row in rows {
        if names.len() >= MAX_OPTIONS {
            break;
        }
        let name = row["name"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || names.contains(&name) {
            continue;
        }
        let desc = row["description"].as_str().unwrap_or("").trim();
        let desc: String = desc.chars().take(140).collect();
        let skill_opt = if desc.is_empty() {
            name.clone()
        } else {
            format!("{name}: {desc}")
        };
        names.push(name);
        options.push(vec![skill_opt, format!("{NONE_OPTION}: {NONE_DESC}")]);
    }
    if names.is_empty() {
        return Ok(Vec::new());
    }

    let state: String = text.chars().take(PROMPT_MAX_CHARS).collect();
    with_laya(text, |laya| {
        let sequences: Vec<(Vec<i64>, Vec<i64>)> = options
            .iter()
            .map(|opts| laya.build_sequence(&state, opts))
            .collect();
        // A question whose options did not fit is unusable: the marker count
        // would not match the option count and the logits would be misaligned.
        if sequences.iter().any(|(_, m)| m.len() != 2) {
            return Err("laya: options did not fit in head_max_len".to_string());
        }
        let logits = laya.logits(&sequences)?;
        let temperature = laya.temperature;
        let candidates: Vec<(String, f32, f32)> = names
            .iter()
            .zip(logits.iter())
            .map(|(name, row)| {
                let probs = softmax_scaled(row, temperature);
                let p_skill = probs.first().copied().unwrap_or(0.0);
                let p_none = probs.get(1).copied().unwrap_or(0.0);
                (name.clone(), p_skill, p_none)
            })
            .collect();
        Ok(pick_by_margin(&candidates))
    })
}

/// Diagnostics for the settings UI: is the model present, and is it loaded?
///
/// Deliberately does NOT load the model — a status check must not pull a few
/// hundred MB into RAM on a machine where that is a large share of memory.
pub fn status() -> Value {
    let dir = model_dir("").or_else(|| model_dir("فارسی"));
    let loaded = slot()
        .lock()
        .ok()
        .and_then(|guard| match guard.as_ref() {
            Some(Ok(_)) => Some(true),
            _ => None,
        });
    let available = dir.is_some();
    serde_json::json!({
        "available": available,
        "loaded": loaded.unwrap_or(false),
        "dir": dir.map(|d| d.display().to_string()).unwrap_or_default(),
        "error": if available { "" } else { "laya model not downloaded" },
    })
}

/// Drop the loaded session so its memory is returned to the OS.
pub fn unload() -> bool {
    let had = slot()
        .lock()
        .map(|mut guard| {
            let had = guard.is_some();
            *guard = None;
            had
        })
        .unwrap_or(false);
    if had {
        LAST_USE.store(0, Ordering::Relaxed);
    }
    had
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_latin_detection_selects_the_multilingual_build() {
        assert!(has_non_latin("یک درخواست فارسی"));
        assert!(!has_non_latin("a plain english request"));
    }

    #[test]
    fn margin_picks_only_candidates_that_clear_the_threshold() {
        let candidates = vec![
            ("Strong".to_string(), 0.9, 0.05),
            ("Weak".to_string(), 0.4, 0.35),
            ("None".to_string(), 0.2, 0.7),
        ];
        // 0.85 clears, 0.05 does not, -0.5 does not.
        assert_eq!(pick_by_margin(&candidates), vec!["Strong".to_string()]);
    }

    #[test]
    fn margin_ranks_by_margin_and_caps_the_picks() {
        let candidates = vec![
            ("A".to_string(), 0.70, 0.10), // margin 0.60
            ("B".to_string(), 0.95, 0.05), // margin 0.90
            ("C".to_string(), 0.80, 0.10), // margin 0.70
        ];
        // Best two by margin, not by raw probability or input order.
        assert_eq!(pick_by_margin(&candidates), vec!["B".to_string(), "C".to_string()]);
    }

    #[test]
    fn margin_returns_nothing_when_no_skill_fits() {
        let candidates = vec![("X".to_string(), 0.3, 0.3), ("Y".to_string(), 0.1, 0.9)];
        assert!(pick_by_margin(&candidates).is_empty());
    }

    #[test]
    fn softmax_is_a_distribution_and_respects_temperature() {
        let p = softmax_scaled(&[2.0, 0.0], 1.0);
        assert!((p.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        assert!(p[0] > p[1]);
        // A higher temperature flattens the distribution.
        let flat = softmax_scaled(&[2.0, 0.0], 4.0);
        assert!(flat[0] < p[0], "higher temperature must flatten: {flat:?} vs {p:?}");
    }

    #[test]
    fn status_reports_unavailable_without_a_model() {
        let s = status();
        assert!(s.get("available").is_some());
        assert!(s.get("error").is_some());
    }

    /// End-to-end routing against the real exported graph.
    ///
    /// Ignored by default: loading the graph takes seconds and needs the model
    /// on disk. Run with `cargo test --bin codifa -- --ignored laya_real`.
    #[test]
    #[ignore = "needs the exported laya model; run with --ignored"]
    fn laya_real_model_routes_a_persian_request_to_the_right_skill() {
        if !is_available() {
            eprintln!("skipping: laya model not exported");
            return;
        }
        let rows = vec![
            serde_json::json!({
                "name": "UI UX Pro Max",
                "description": "design modern user interfaces, landing pages and visual layouts"
            }),
            serde_json::json!({
                "name": "Git Workflow",
                "description": "commit, branch, rebase and resolve merge conflicts in git"
            }),
        ];
        let picked = predict("یک صفحهٔ فرود مدرن و زیبا برای محصولم طراحی کن", &rows)
            .expect("laya routing must run");
        assert!(
            picked.iter().any(|n| n == "UI UX Pro Max"),
            "a design request must pick the design skill, got {picked:?}"
        );
    }
}
