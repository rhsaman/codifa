"""Local ONNX embedding for the vector store.

Loads an e5-style ONNX model and runs it fully offline via tokenizers +
onnxruntime. Standard e5 mean-pooling: tokenize -> model -> mean of the last
hidden state over the attention mask -> L2 normalize.

The model lives under ``backend/models--<org>--<name>/`` (HF-cache layout or
the flat ``local_dir`` download layout) and is downloaded by the user from
Settings → Models — this module NEVER downloads on its own. It picks the first
ready ``models--*`` folder (the default e5 first), so a different model can be
dropped in / removed freely. The model is loaded lazily and cached; the first
call pays the load cost and every later one is instant.
"""

from __future__ import annotations

import contextlib
import os
import threading
from collections.abc import Sequence

import numpy as np

FAILED = "intfloat/multilingual-e5-base"


def _preferred_model() -> str:
    """The embedding model the user selected in Settings (fallback to default)."""
    try:
        from state_db import get_settings

        settings = get_settings()
        if isinstance(settings, dict):
            model = str(settings.get("embeddingModel") or "").strip()
            if model:
                return model
    except Exception:  # noqa: BLE001, S110 — standalone fallback
        pass
    return FAILED


def _preferred_root() -> str:
    import re

    model = _preferred_model()
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(model).replace("/", "--")).strip("-")
    return f"models--{slug}" if slug else "models--intfloat--multilingual-e5-base"


# e5 models expect a "query: " / "passage: " prefix before embedding, and
# retrieval accuracy depends on it, so every embedding is prefixed.
_QUERY_PREFIX = "query: "
_PASSAGE_PREFIX = "passage: "

_BATCH = 32

# e5-style position embeddings top out at 512; longer inputs make ONNX raise
# "indices element out of data bounds" on the position-embeddings Gather, so
# everything is truncated here to fit the real model capacity.
_MAX_LEN = 512

_CACHE: dict = {}
_LOCK = threading.Lock()

# Passage vector cache: exact description text -> L2-normalized vector.
# The codemap rerank re-embeds the same file descriptions on every turn while
# only the query changes. Caching per-text vectors turns repeat turns into a
# single query embed + cosine, with bit-identical results (same model, same
# prefix, same text). Bounded LRU so vector-store callers with many distinct
# texts cannot grow memory without limit. Queries are NOT cached (each prompt
# is effectively unique).
_PASSAGE_VEC_CACHE: dict[str, object] = {}
_PASSAGE_VEC_ORDER: list[str] = []
_PASSAGE_VEC_LOCK = threading.Lock()
_PASSAGE_VEC_MAX = 5000


class EmbedderUnavailableError(RuntimeError):
    """Raised when the local e5 ONNX model cannot be loaded."""


def model_dir() -> str:
    """Absolute path to a usable e5 snapshot dir; '' when none is downloaded.

    Scans every ``backend/models--*`` folder (each downloaded repo keeps its
    own folder), preferring the default ``intfloat/multilingual-e5-base`` so
    the shipped/packaged model wins when several coexist. Returns the concrete
    directory holding ``tokenizer.json`` + ``onnx/model.onnx`` (a ``snapshots/
    <rev>`` subdir or the flat repo root).
    """
    try:
        from model_download import _models_dir

        base = _models_dir()
    except Exception:  # noqa: BLE001 — standalone fallback
        base = os.path.dirname(os.path.abspath(__file__))
    preferred: list[str] = []
    rest: list[str] = []
    if not os.path.isdir(base):
        return ""
    for name in sorted(os.listdir(base)):
        if not name.startswith("models--"):
            continue
        root = os.path.join(base, name)
        if not os.path.isdir(root):
            continue
        found: list[str] = []
        snapshots = os.path.join(root, "snapshots")
        if os.path.isdir(snapshots):
            for d in sorted(os.listdir(snapshots)):
                cand = os.path.join(snapshots, d)
                if os.path.isdir(cand) and os.path.isfile(
                    os.path.join(cand, "onnx", "model.onnx")
                ):
                    found.append(cand)
        if not found and os.path.isfile(os.path.join(root, "tokenizer.json")) and os.path.isfile(
            os.path.join(root, "onnx", "model.onnx")
        ):
            found.append(root)
        if not found:
            continue
        (preferred if name == _preferred_root() else rest).extend(found)
    if preferred:
        return preferred[0]
    if rest:
        return rest[0]
    return ""


def is_available() -> bool:
    """True when a ready ONNX model can be loaded."""
    try:
        _load()
        return True
    except Exception:  # noqa: BLE001
        return False


# Backwards-compatible alias used by server.py's /index/status endpoint.
embedder_available = is_available


def status() -> dict:
    """Diagnostic status for the RAG embedder (Settings → Models)."""
    m = _preferred_model()
    try:
        _load()
        return {
            "available": True,
            "model": m,
            "dir": model_dir(),
            "dimension": int(_CACHE.get("dim") or 768),
            "error": "",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "model": m,
            "dir": "",
            "dimension": 0,
            "error": str(exc),
        }


def _load() -> None:
    """Load (once) the tokenizer + ONNX session into the module cache."""
    if _CACHE:
        return
    with _LOCK:
        if _CACHE:
            return
        import onnxruntime
        from tokenizers import Tokenizer

        snap = model_dir()
        m = _preferred_model()
        if not snap:
            raise EmbedderUnavailableError(
                f"{m} not downloaded — open Settings → Models and "
                "download an embedding model to enable RAG memory."
            )
        tok_path = os.path.join(snap, "tokenizer.json")
        onnx_path = os.path.join(snap, "onnx", "model.onnx")
        if not os.path.isfile(tok_path) or not os.path.isfile(onnx_path):
            raise EmbedderUnavailableError(
                "embedding model incomplete (need tokenizer.json + onnx/model.onnx)"
            )
        try:
            _CACHE["tokenizer"] = Tokenizer.from_file(tok_path)
            # Tight arena: the default strategy over-reserves past the 1.1 GB
            # weights during big batches (hundreds of MB held). kSameAsRequested
            # only reserves what each run asks for. Numerics (and ranking
            # quality) are unaffected — allocator choice only, not math.
            _sess_opts = onnxruntime.SessionOptions()
            with contextlib.suppress(Exception):
                _sess_opts.add_session_config_entry(
                    "arena_extend_strategy", "kSameAsRequested"
                )
            _CACHE["session"] = onnxruntime.InferenceSession(
                onnx_path,
                sess_options=_sess_opts,
                providers=["CPUExecutionProvider"],
            )
            # Detect the real vector width from the model itself.
            dim: np.ndarray = _embed(["fallback"], _PASSAGE_PREFIX)
            _CACHE["dim"] = int(dim.shape[1])
        except Exception:
            # Leave the cache empty so a later call retries cleanly instead of
            # short-circuiting on a half-initialized (tokenizer/session set, no
            # dim) model that would crash on every subsequent embed call.
            _CACHE.clear()
            raise


def _embed(texts: Sequence[str], prefix: str) -> np.ndarray:
    """Mean-pool + L2-normalize a batch with the real ONNX model."""
    _load()
    tokenizer = _CACHE["tokenizer"]
    session = _CACHE["session"]
    enc = tokenizer.encode_batch([f"{prefix}{t}" for t in texts])
    max_len = max((len(e.ids) for e in enc), default=0)
    max_len = min(max_len, _MAX_LEN)
    input_ids = np.zeros((len(enc), max_len), dtype=np.int64)
    mask = np.zeros((len(enc), max_len), dtype=np.int64)
    for row, e in enumerate(enc):
        ids = e.ids[:_MAX_LEN]
        input_ids[row, : len(ids)] = ids
        mask[row, : len(ids)] = 1
    (last_hidden,) = session.run(
        ["last_hidden_state"],
        {"input_ids": input_ids, "attention_mask": mask},
    )
    mask_f = mask.astype(np.float32)[:, :, None]
    summed = (last_hidden * mask_f).sum(axis=1)
    counts = np.clip(mask_f.sum(axis=1), 1e-9, None)
    pooled = summed / counts
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    return pooled / np.clip(norms, 1e-9, None)


def _embed_batch(texts: Sequence[str], prefix: str) -> np.ndarray:
    """Batch the real model to bound peak memory on long lists.

    Texts are sorted by length before chunking so each ONNX batch pads to a
    similar row length instead of the single longest row. Per-row results are
    independent (padding is masked), so restoring the original order yields
    the same vectors as naive chunking — only with less wasted matmul.
    """
    lst = list(texts)
    n = len(lst)
    if n <= 1:
        return _embed(lst, prefix)
    order = sorted(range(n), key=lambda i: len(lst[i]))
    sorted_texts = [lst[i] for i in order]
    rows: list[np.ndarray] = []
    for i in range(0, n, _BATCH):
        rows.append(_embed(sorted_texts[i : i + _BATCH], prefix))
    concat = np.concatenate(rows, axis=0)
    result = np.empty_like(concat)
    for sorted_pos, orig_idx in enumerate(order):
        result[orig_idx] = concat[sorted_pos]
    return result


def _embed_passages_cached(texts: Sequence[str]) -> np.ndarray:
    """Embed passages with a per-text vector cache (order-preserving).

    Cache key is the exact prefixed string, so hits are identical vectors by
    construction. Misses are embedded with the length-sorted batcher above.
    """
    lst = list(texts)
    if not lst:
        return np.zeros((0, 0), dtype=np.float32)
    keys = [f"{_PASSAGE_PREFIX}{t}" for t in lst]
    with _PASSAGE_VEC_LOCK:
        cached = [_PASSAGE_VEC_CACHE.get(k) for k in keys]
    missing_idx = [i for i, v in enumerate(cached) if v is None]
    if missing_idx:
        missing_texts = [lst[i] for i in missing_idx]
        order = sorted(range(len(missing_texts)), key=lambda j: len(missing_texts[j]))
        sorted_miss = [missing_texts[j] for j in order]
        rows: list[np.ndarray] = []
        for i in range(0, len(sorted_miss), _BATCH):
            rows.append(_embed(sorted_miss[i : i + _BATCH], _PASSAGE_PREFIX))
        concat = np.concatenate(rows, axis=0)
        miss_vecs = [None] * len(missing_texts)
        for sorted_pos, j in enumerate(order):
            miss_vecs[j] = concat[sorted_pos]
        with _PASSAGE_VEC_LOCK:
            for j, i in enumerate(missing_idx):
                vec = np.array(miss_vecs[j], dtype=np.float32, copy=True)
                if keys[i] not in _PASSAGE_VEC_CACHE:
                    _PASSAGE_VEC_CACHE[keys[i]] = vec
                    _PASSAGE_VEC_ORDER.append(keys[i])
                    while len(_PASSAGE_VEC_ORDER) > _PASSAGE_VEC_MAX:
                        _PASSAGE_VEC_CACHE.pop(_PASSAGE_VEC_ORDER.pop(0), None)
                cached[i] = _PASSAGE_VEC_CACHE[keys[i]]
    mat = np.stack([np.asarray(v, dtype=np.float32) for v in cached], axis=0)
    return mat


def embed_dim() -> int:
    """Vector width of the loaded model, runtime-detected.

    Returns the real output width once the model is loaded, else the current
    module fallback (768 for the default multilingual-e5-base). Never raises.
    """
    try:
        _load()
        return int(_CACHE.get("dim") or 768)
    except Exception:  # noqa: BLE001 — caller handles embedder-unavailable
        return 768


def embed_passages(texts: Sequence[str]) -> list[list[float]]:
    """Embed documents/text for storage (``passage: ...`` prefix)."""
    lst = [t for t in texts]
    if not lst:
        return []
    return _embed_passages_cached(lst).tolist()


def embed_queries(texts: Sequence[str]) -> list[list[float]]:
    """Embed search queries for retrieval (``query: ...`` prefix)."""
    lst = list(texts)
    if not lst:
        return []
    return _embed_batch(lst, _QUERY_PREFIX).tolist()


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Convenience alias of ``embed_passages`` (used by the vector store)."""
    return embed_passages(texts)