//! Native RAG embeddings: the e5 ONNX model, in-process.
//!
//! Mirrors `backend/embeddings.py`: an e5-style sentence encoder loaded from
//! the model the app already downloaded (`{data_root}/models/...`), run through
//! ONNX Runtime with the model's own HuggingFace tokenizer. Standard e5
//! pooling: tokenize -> `last_hidden_state` -> masked mean over the attention
//! mask -> L2 normalize.
//!
//! Queries and passages get different prefixes (`query: ` / `passage: `) —
//! that asymmetry is what the model was trained on, so mixing them up costs
//! retrieval quality. The session is built once and reused; a failed load is
//! remembered so a missing model does not retry on every call.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::environment::Environment;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;

/// The model the app downloads for RAG (see `model_download.py`).
pub const EMBEDDING_REPO: &str = "intfloat/multilingual-e5-base";
const QUERY_PREFIX: &str = "query: ";
const PASSAGE_PREFIX: &str = "passage: ";
/// e5 truncates at 512 tokens; longer input is cut, not rejected.
const MAX_LEN: usize = 512;
/// Fallback dimension when the model has not been loaded yet (e5-base = 768).
const DEFAULT_DIM: usize = 768;

struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
    dim: usize,
}

/// `None` = not loaded yet, `Some(Err)` = load failed (do not retry).
static EMBEDDER: OnceLock<Mutex<Option<Result<Embedder, String>>>> = OnceLock::new();

/// ONNX Runtime environment, created once and shared by every session.
static ENV: OnceLock<Environment> = OnceLock::new();

fn ort_env() -> Result<&'static Environment, String> {
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init()
        .with_name("codifa-embeddings")
        .build()
        .map_err(|e| format!("onnx environment failed: {e}"))?;
    Ok(ENV.get_or_init(|| env))
}

fn slot() -> &'static Mutex<Option<Result<Embedder, String>>> {
    EMBEDDER.get_or_init(|| Mutex::new(None))
}

/// The user-level data root, mirroring the sidecar's `CODER_DATA_DIR` default.
fn data_root() -> PathBuf {
    std::env::var("CODER_DATA_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codifa")))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Directory holding `tokenizer.json` + `onnx/model.onnx`.
///
/// The downloader stores models under `{data_root}/models/<repo-dir>`; a
/// HuggingFace snapshot nests them under `snapshots/<rev>/`, so both layouts
/// are probed. Returns the first directory that actually has both files.
pub fn model_dir() -> Option<PathBuf> {
    let models = data_root().join("models");
    let mut candidates: Vec<PathBuf> = Vec::new();
    let entries = std::fs::read_dir(&models).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains("e5") {
            continue;
        }
        let base = entry.path();
        candidates.push(base.clone());
        if let Ok(snaps) = std::fs::read_dir(base.join("snapshots")) {
            for snap in snaps.flatten() {
                candidates.push(snap.path());
            }
        }
    }
    candidates.into_iter().find(|dir| {
        dir.join("tokenizer.json").is_file() && dir.join("onnx").join("model.onnx").is_file()
    })
}

fn load() -> Result<Embedder, String> {
    let dir = model_dir().ok_or_else(|| {
        format!(
            "embedding model not downloaded (expected {EMBEDDING_REPO} under {}/models)",
            data_root().display()
        )
    })?;
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|e| format!("tokenizer load failed: {e}"))?;
    let session = Session::builder(ort_env()?)
        .map_err(|e| format!("onnx session builder failed: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("onnx optimization level failed: {e}"))?
        .with_intra_threads(2)
        .map_err(|e| format!("onnx thread config failed: {e}"))?
        .commit_from_file(dir.join("onnx").join("model.onnx"))
        .map_err(|e| format!("onnx model load failed: {e}"))?;
    let mut emb = Embedder {
        session,
        tokenizer,
        dim: DEFAULT_DIM,
    };
    // Probe the real dimension instead of trusting the constant.
    let probe = emb.encode(&["fallback".to_string()], PASSAGE_PREFIX)?;
    emb.dim = probe.first().map(Vec::len).unwrap_or(DEFAULT_DIM);
    Ok(emb)
}

impl Embedder {
    /// Tokenize, run the model, mean-pool over the mask and L2-normalize.
    fn encode(&mut self, texts: &[String], prefix: &str) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let prefixed: Vec<String> = texts.iter().map(|t| format!("{prefix}{t}")).collect();
        let encodings = self
            .tokenizer
            .encode_batch(prefixed, true)
            .map_err(|e| format!("tokenize failed: {e}"))?;

        let batch = encodings.len();
        let seq = encodings
            .iter()
            .map(|e| e.get_ids().len().min(MAX_LEN))
            .max()
            .unwrap_or(0)
            .max(1);

        let mut ids = vec![0i64; batch * seq];
        let mut mask = vec![0i64; batch * seq];
        for (row, enc) in encodings.iter().enumerate() {
            let len = enc.get_ids().len().min(MAX_LEN);
            for col in 0..len {
                ids[row * seq + col] = enc.get_ids()[col] as i64;
                mask[row * seq + col] = 1;
            }
        }

        let shape = vec![batch as i64, seq as i64];
        let input_ids = Tensor::from_array((shape.clone(), ids))
            .map_err(|e| format!("input_ids tensor failed: {e}"))?;
        // The tensor takes ownership of its buffer, so the mask is cloned:
        // the pooling loop below still needs the original to weight the mean.
        let attention_mask = Tensor::from_array((shape, mask.clone()))
            .map_err(|e| format!("attention_mask tensor failed: {e}"))?;

        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => input_ids,
                "attention_mask" => attention_mask,
            ])
            .map_err(|e| format!("onnx inference failed: {e}"))?;

        let (hidden_shape, hidden) = outputs["last_hidden_state"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("last_hidden_state extract failed: {e}"))?;
        // [batch, seq, dim]
        let dim = *hidden_shape.last().unwrap_or(&(DEFAULT_DIM as i64)) as usize;
        let seq_len = if hidden_shape.len() >= 2 {
            hidden_shape[hidden_shape.len() - 2] as usize
        } else {
            seq
        };

        let mut out = Vec::with_capacity(batch);
        for row in 0..batch {
            let mut pooled = vec![0f32; dim];
            let mut count = 0f32;
            for col in 0..seq_len {
                if mask[row * seq + col] == 0 {
                    continue;
                }
                let base = (row * seq_len + col) * dim;
                for d in 0..dim {
                    pooled[d] += hidden[base + d];
                }
                count += 1.0;
            }
            let count = count.max(1e-9);
            for v in pooled.iter_mut() {
                *v /= count;
            }
            let norm = pooled.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-9);
            for v in pooled.iter_mut() {
                *v /= norm;
            }
            out.push(pooled);
        }
        Ok(out)
    }
}

/// Run `f` against the loaded embedder, loading it on first use.
fn with_embedder<T>(f: impl FnOnce(&mut Embedder) -> Result<T, String>) -> Result<T, String> {
    let mut guard = slot().lock().map_err(|_| "embedder lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(load());
    }
    match guard.as_mut().expect("just filled") {
        Ok(emb) => f(emb),
        Err(err) => Err(err.clone()),
    }
}

/// Embed passages (documents to be retrieved). Cached per text by the caller.
pub fn embed_passages(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    with_embedder(|emb| emb.encode(texts, PASSAGE_PREFIX))
}

/// Embed queries (the user's search text).
pub fn embed_queries(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    with_embedder(|emb| emb.encode(texts, QUERY_PREFIX))
}

/// Embedding dimension, or the e5-base default when the model is not loaded.
pub fn embed_dim() -> usize {
    let Ok(guard) = slot().lock() else {
        return DEFAULT_DIM;
    };
    match guard.as_ref() {
        Some(Ok(emb)) => emb.dim,
        _ => DEFAULT_DIM,
    }
}

/// Is the model present and loadable? Loads it on first call.
pub fn is_available() -> bool {
    with_embedder(|_| Ok(())).is_ok()
}

/// Diagnostics for `/models/embedding-status`.
pub fn status() -> serde_json::Value {
    let dir = model_dir();
    match with_embedder(|emb| Ok(emb.dim)) {
        Ok(dim) => serde_json::json!({
            "available": true,
            "model": EMBEDDING_REPO,
            "dir": dir.map(|d| d.display().to_string()).unwrap_or_default(),
            "dimension": dim,
            "error": "",
        }),
        Err(err) => serde_json::json!({
            "available": false,
            "model": EMBEDDING_REPO,
            "dir": dir.map(|d| d.display().to_string()).unwrap_or_default(),
            "dimension": 0,
            "error": err,
        }),
    }
}

/// Drop the loaded session so its memory is returned to the OS.
pub fn unload() {
    if let Ok(mut guard) = slot().lock() {
        *guard = None;
    }
}

/// Cosine similarity of two L2-normalized vectors (a plain dot product).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Path helper used by tests and the indexer.
pub fn model_dir_for(root: &Path) -> PathBuf {
    root.join("models")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_of_identical_vectors_is_one() {
        let v = vec![0.6f32, 0.8];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_orthogonal_vectors_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn status_reports_unavailable_without_a_model() {
        // No model is downloaded in the test environment, so the status must
        // degrade to available:false with a reason instead of panicking.
        let s = status();
        assert!(s.get("available").is_some());
        assert!(s.get("error").is_some());
    }

    #[test]
    fn embed_dim_falls_back_to_the_e5_base_default() {
        assert_eq!(embed_dim(), DEFAULT_DIM);
    }

    /// End-to-end embedding check against the real downloaded model.
    ///
    /// Ignored by default: loading the e5 ONNX model takes seconds and needs
    /// the model on disk, which would slow every test run. Run it explicitly
    /// with `cargo test --bin codifa -- --ignored embed_real_model`.
    #[test]
    #[ignore = "needs the downloaded e5 model; run with --ignored"]
    fn embed_real_model_produces_normalized_vectors_with_semantic_order() {
        if !is_available() {
            eprintln!("skipping: embedding model not downloaded");
            return;
        }
        let passages = vec![
            "def login(user, password): return check_password(user, password)".to_string(),
            "def charge(card, amount): return gateway.charge(card, amount)".to_string(),
        ];
        let vecs = embed_passages(&passages).expect("embed passages");
        assert_eq!(vecs.len(), 2);
        assert_eq!(vecs[0].len(), embed_dim(), "dimension must match the model");
        for v in &vecs {
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-3, "vectors must be L2-normalized: {norm}");
        }

        // A query about authentication must sit closer to the login passage
        // than to the billing one — that is the whole point of the index.
        let query = embed_queries(&["how does user authentication work".to_string()])
            .expect("embed query");
        let to_login = cosine(&query[0], &vecs[0]);
        let to_billing = cosine(&query[0], &vecs[1]);
        assert!(
            to_login > to_billing,
            "auth query should match the login passage: login={to_login} billing={to_billing}"
        );
    }
}
