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
import gc
import os
import threading
import time
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

def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name) or default)
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


_BATCH = _env_int("EMBED_BATCH", 4)

# Max texts embedded in one call window. Large index runs can queue tens of
# thousands of chunks; holding all batch outputs + concat + result (3x) plus
# the Python float list (7x vs float32) spikes RSS to many GB. Windowing
# keeps peak near one window plus the final array.

# e5-style position embeddings top out at 512; longer inputs make ONNX raise
# "indices element out of data bounds" on the position-embeddings Gather, so
# everything is truncated here to fit the real model capacity.
_MAX_LEN = 512

_CACHE: dict = {}
# RLock: _embed() re-enters _load() for the dim probe while _load already
# holds this lock during the initial model fill — a plain Lock would deadlock.
_LOCK = threading.RLock()

# Idle eviction: the ONNX session holds ~1.1 GB of weights plus arena buffers,
# so keeping it resident forever in a long-lived sidecar dominates the app's
# RAM. After this many seconds without an embed call the model is dropped;
# the next call simply reloads it lazily (a few seconds, same vectors).
try:
    _IDLE_EVICT_S = float(os.environ.get("EMBED_IDLE_EVICT_S") or 30)
except (TypeError, ValueError):
    _IDLE_EVICT_S = float(30)
_last_used = 0.0
_active_embeds = 0
_evict_timer: threading.Timer | None = None


def _touch() -> None:
    """Record activity and (re)arm the idle-eviction timer. Caller holds _LOCK."""
    global _last_used, _evict_timer
    _last_used = time.monotonic()
    if _evict_timer is not None:
        _evict_timer.cancel()
    _evict_timer = threading.Timer(_IDLE_EVICT_S, _evict_if_idle)
    _evict_timer.daemon = True
    _evict_timer.start()


def _evict_if_idle() -> None:
    """Drop the cached model when it has been idle for the whole window.

    Never evicts while an embed is in flight (the session would be freed
    mid-inference); a busy model re-arms the timer for another window. A model
    used within the window is left alone — a concurrent ``_touch`` already
    re-armed the timer, so touching here would wrongly restart the idle clock.
    Also drops the passage vector cache so peak RAM falls immediately.
    """
    with _LOCK:
        if not _CACHE:
            return
        if time.monotonic() - _last_used < _IDLE_EVICT_S:
            return
        if _active_embeds > 0:
            _touch()
            return
        _CACHE.clear()
    with _PASSAGE_VEC_LOCK:
        _PASSAGE_VEC_CACHE.clear()
        _PASSAGE_VEC_ORDER.clear()
    gc.collect()


def unload() -> bool:
    """Drop the cached embedding model immediately, freeing ~1.1 GB RAM.

    Returns True when a loaded model was dropped. Safe to call anytime;
    the next embed call reloads lazily. Used by the manual free-memory
    endpoint so idle RAM can be reclaimed without waiting for the timer.
    Also clears the passage vector cache.
    """
    global _evict_timer
    with _LOCK:
        had_model = bool(_CACHE)
        if _active_embeds > 0:
            return False
        _CACHE.clear()
        if _evict_timer is not None:
            try:
                _evict_timer.cancel()
            except Exception:  # noqa: BLE001, S110 -- timer cancel never fails
                pass
            _evict_timer = None
    with _PASSAGE_VEC_LOCK:
        had_cache = bool(_PASSAGE_VEC_CACHE)
        _PASSAGE_VEC_CACHE.clear()
        _PASSAGE_VEC_ORDER.clear()
    if had_model or had_cache:
        gc.collect()
    return had_model

# Passage vector cache: exact description text -> L2-normalized vector.
# The rerank step re-embeds the same file descriptions on every turn while
# only the query changes. Caching per-text vectors turns repeat turns into a
# single query embed + cosine, with bit-identical results (same model, same
# prefix, same text). Bounded LRU so vector-store callers with many distinct
# texts cannot grow memory without limit. Queries are NOT cached (each prompt
# is effectively unique).
_PASSAGE_VEC_CACHE: dict[str, object] = {}
_PASSAGE_VEC_ORDER: list[str] = []
_PASSAGE_VEC_LOCK = threading.Lock()
_PASSAGE_VEC_MAX = _env_int("EMBED_CACHE_MAX", 200)


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
    """True when a ready ONNX model file exists on disk.

    Lightweight: checks only for the model files, never loads the ~1.1 GB
    session and never touches the idle-eviction timer. Callers that only
    need to gate RAG (status polling, availability probes) must use this
    instead of loading the model.
    """
    try:
        return bool(model_dir())
    except Exception:  # noqa: BLE001
        return False


# Backwards-compatible alias used by server.py's /index/status endpoint.
embedder_available = is_available


def status() -> dict:
    """Diagnostic status for the RAG embedder (Settings → Models).

    Lightweight: reports file presence + cached dimension, never loads
    the model (polling this must not keep the session resident).
    """
    m = _preferred_model()
    try:
        d = model_dir()
    except Exception:  # noqa: BLE001
        d = ""
    if not d:
        return {
            "available": False,
            "model": m,
            "dir": "",
            "dimension": 0,
            "error": f"{m} not downloaded",
        }
    try:
        dim = int(_CACHE.get("dim") or 768)
    except Exception:  # noqa: BLE001
        dim = 768
    return {
        "available": True,
        "model": m,
        "dir": d,
        "dimension": dim,
        "error": "",
    }


def _load() -> None:
    """Load (once) the tokenizer + ONNX session into the module cache."""
    if _CACHE:
        with _LOCK:
            if _CACHE:
                _touch()
        return
    with _LOCK:
        if _CACHE:
            _touch()
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
            # Disable the CPU memory arena entirely: with kSameAsRequested the
            # arena still grows to the largest single batch and is never
            # returned to the OS. Disabling it makes every allocation go
            # through the system allocator, which actually frees — peak RSS
            # stays near the 1.1 GB weights instead of weights + arena.
            with contextlib.suppress(Exception):
                _sess_opts.enable_cpu_mem_arena = False
            with contextlib.suppress(Exception):
                _sess_opts.add_session_config_entry(
                    "arena_extend_strategy", "kSameAsRequested"
                )
            # Bound native thread arenas: default uses all cores and each
            # thread reserves its own arena, multiplying peak past weights.
            with contextlib.suppress(Exception):
                _sess_opts.intra_op_num_threads = min(2, os.cpu_count() or 1)
            with contextlib.suppress(Exception):
                _sess_opts.inter_op_num_threads = 1
            _CACHE["session"] = onnxruntime.InferenceSession(
                onnx_path,
                sess_options=_sess_opts,
                providers=["CPUExecutionProvider"],
            )
            # Detect the real vector width from the model itself.
            dim: np.ndarray = _embed(["fallback"], _PASSAGE_PREFIX)
            _CACHE["dim"] = int(dim.shape[1])
            _touch()
        except Exception:
            # Leave the cache empty so a later call retries cleanly instead of
            # short-circuiting on a half-initialized (tokenizer/session set, no
            # dim) model that would crash on every subsequent embed call.
            _CACHE.clear()
            raise


def _embed(texts: Sequence[str], prefix: str) -> np.ndarray:
    """Mean-pool + L2-normalize a batch with the real ONNX model."""
    global _active_embeds
    _load()
    with _LOCK:
        _active_embeds += 1
        _touch()
        tokenizer = _CACHE["tokenizer"]
        session = _CACHE["session"]
    try:
        return _embed_with(texts, prefix, tokenizer, session)
    finally:
        with _LOCK:
            _active_embeds -= 1


def _embed_with(texts: Sequence[str], prefix: str, tokenizer, session) -> np.ndarray:
    """Run one inference batch on an already-loaded tokenizer/session."""
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
    Large lists are processed window by window directly into the final array
    so peak stays near one window instead of 3x the whole list.
    """
    lst = list(texts)
    n = len(lst)
    if n <= 1:
        return _embed(lst, prefix)
    order = sorted(range(n), key=lambda i: len(lst[i]))
    sorted_texts = [lst[i] for i in order]
    window = _env_int("EMBED_WINDOW", 128)
    # First window determines the vector width for preallocation.
    first = sorted_texts[:window]
    first_rows: list[np.ndarray] = []
    for i in range(0, len(first), _BATCH):
        first_rows.append(_embed(first[i : i + _BATCH], prefix))
    first_concat = np.concatenate(first_rows, axis=0)
    dim = int(first_concat.shape[1])
    concat = np.empty((n, dim), dtype=first_concat.dtype)
    concat[: len(first)] = first_concat
    del first_rows, first_concat
    for start in range(window, n, window):
        chunk = sorted_texts[start : start + window]
        chunk_rows: list[np.ndarray] = []
        for i in range(0, len(chunk), _BATCH):
            chunk_rows.append(_embed(chunk[i : i + _BATCH], prefix))
        concat[start : start + len(chunk)] = np.concatenate(chunk_rows, axis=0)
        del chunk_rows
    result = np.empty_like(concat)
    for sorted_pos, orig_idx in enumerate(order):
        result[orig_idx] = concat[sorted_pos]
    del concat
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
        # Reuse the windowed batcher so a cold index of thousands of texts
        # never holds 3x the whole list plus the Python float list at once.
        miss_mat = _embed_batch(missing_texts, _PASSAGE_PREFIX)
        miss_vecs = [miss_mat[j] for j in range(len(missing_texts))]
        del miss_mat
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
    """Vector width of the model, without loading it.

    Returns the cached width once the model has been loaded, else the
    module fallback (768 for the default multilingual-e5-base). Never
    raises and never loads the model — opening a store or probing
    availability must not wake the ~1.1 GB session.
    """
    try:
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