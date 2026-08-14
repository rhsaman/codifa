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
        _CACHE["tokenizer"] = Tokenizer.from_file(tok_path)
        _CACHE["session"] = onnxruntime.InferenceSession(
            onnx_path, providers=["CPUExecutionProvider"]
        )
        # Detect the real vector width from the model itself.
        dim: np.ndarray = _embed(["fallback"], _PASSAGE_PREFIX)
        _CACHE["dim"] = int(dim.shape[1])


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
    """Batch the real model to bound peak memory on long lists."""
    rows: list[np.ndarray] = []
    for i in range(0, len(texts), _BATCH):
        rows.append(_embed(texts[i : i + _BATCH], prefix))
    return np.concatenate(rows, axis=0)


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
    return _embed_batch(lst, _PASSAGE_PREFIX).tolist()


def embed_queries(texts: Sequence[str]) -> list[list[float]]:
    """Embed search queries for retrieval (``query: ...`` prefix)."""
    lst = list(texts)
    if not lst:
        return []
    return _embed_batch(lst, _QUERY_PREFIX).tolist()


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Convenience alias of ``embed_passages`` (used by the vector store)."""
    return embed_passages(texts)