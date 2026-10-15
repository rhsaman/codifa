"""Embedding prefilter for skill routing at scale.

The decision router only sees a few dozen skills per call: the external-model
path caps its catalog at ``_SKILL_ROUTE_CATALOG_MAX_CHARS`` and local Laya
answers a single choice question over at most 30 options. With hundreds or
thousands of stored skills, handing the router the raw store order would
blindly cut off almost everything past the head of the list.

This module ranks every skill against the request with the local e5 embedding
model (``embeddings.py``, downloaded via Settings → Models) and returns the
top ``PREFILTER_LIMIT`` candidates, so the router always sees the most
relevant slice no matter how large the store grows.

Fail-open by design: when no embedding model is downloaded — or on any error
— the store order is returned unchanged and the router's own caps apply, so
routing degrades to the unfiltered behavior instead of breaking the turn.
"""

from __future__ import annotations

import hashlib
import logging
import threading

logger = logging.getLogger(__name__)

#: Candidates handed to the decision router per turn. Large enough for the
#: router to choose well (Laya takes 30, the external catalog fits ~60-100
#: short lines), small enough to keep its prompt tiny.
PREFILTER_LIMIT = 50

#: Max chars of skill text embedded (name + description + keywords never reach
#: this in practice; guards against a pathological long description).
_SKILL_TEXT_MAX_CHARS = 1000


def skill_text(skill: dict) -> str:
    """Embeddable text for one skill: name + description + fa_keywords."""
    parts = [
        str(skill.get("name") or "").strip(),
        str(skill.get("description") or "").strip(),
    ]
    keywords = [
        str(k or "").strip()
        for k in (skill.get("fa_keywords") or [])
        if str(k or "").strip()
    ]
    if keywords:
        parts.append(" ".join(keywords))
    slug = str(skill.get("slug") or "").strip().replace("-", " ")
    if slug and parts[0] and slug.casefold() != parts[0].casefold():
        parts.append(slug)
    return " ".join(p for p in parts if p).strip()[:_SKILL_TEXT_MAX_CHARS]


# Cache of skill passage vectors keyed by the store's content hash. Skill
# texts are static between edits, so re-embedding the whole store on every
# turn (which wakes the ~1.1 GB ONNX session each time) is pure waste: only
# the query is embedded per turn; the store matrix is rebuilt only when the
# skill set actually changes.
_VECTOR_CACHE: dict[str, list[list[float]]] = {}
_VECTOR_CACHE_LOCK = threading.Lock()
_VECTOR_CACHE_MAX = 4


def _store_hash(rows: list[dict]) -> str:
    """Stable hash of the skill texts the matrix is built from."""
    h = hashlib.sha256()
    for s in rows:
        h.update(skill_text(s).encode("utf-8", "ignore"))
        h.update(b"\x00")
    return h.hexdigest()


def _cached_vectors(rows: list[dict]) -> list[list[float]] | None:
    """Embedding matrix for the skill store, cached by content hash."""
    from embeddings import embed_passages

    key = _store_hash(rows)
    with _VECTOR_CACHE_LOCK:
        hit = _VECTOR_CACHE.get(key)
        if hit is not None:
            return hit
    vectors = embed_passages([skill_text(s) for s in rows])
    with _VECTOR_CACHE_LOCK:
        # Tiny LRU: keep only the most recent stores (multi-workspace safe).
        _VECTOR_CACHE[key] = vectors
        while len(_VECTOR_CACHE) > _VECTOR_CACHE_MAX:
            _VECTOR_CACHE.pop(next(iter(_VECTOR_CACHE)))
    return vectors


def _top_indices(
    query: list[float], matrix: list[list[float]], limit: int
) -> list[int]:
    """Indices of the ``limit`` rows with the highest cosine similarity.

    Vectors from ``embeddings`` are L2-normalized, so cosine is a dot product.
    Stable: ties keep store order.
    """
    scored: list[tuple[float, int]] = []
    width = len(query)
    for i, row in enumerate(matrix):
        n = min(width, len(row))
        if n <= 0:
            continue
        dot = 0.0
        for j in range(n):
            dot += query[j] * row[j]
        scored.append((dot, i))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [i for _, i in scored[:limit]]


def prefilter_skills(
    prompt: str, skills: list[dict], limit: int = PREFILTER_LIMIT
) -> list[dict]:
    """Top-``limit`` skills for ``prompt``, embedding-ranked; never raises.

    Ranks even when the store already fits (``len <= limit``): store order is
    alphabetical, not relevance, so the router's small candidate slice must
    still be the most relevant one. Returns the store order unchanged only
    when the prompt is empty, when no embedding model is downloaded, or on
    any embedding error.
    """
    rows = [s for s in skills or [] if str(s.get("name") or "").strip()]
    text = (prompt or "").strip()
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = PREFILTER_LIMIT
    if not rows or not text or limit <= 0:
        return list(rows)
    try:
        from embeddings import embed_queries, is_available

        if not is_available():
            return list(rows)
        queries = embed_queries([text[:1500]])
        if not queries:
            return list(rows)
        vectors = _cached_vectors(rows)
        if len(vectors) != len(rows):
            return list(rows)
        picks = _top_indices(queries[0], vectors, limit)
        if not picks:
            return list(rows)
        return [rows[i] for i in picks]
    except Exception as exc:  # noqa: BLE001 — prefilter never breaks routing
        logger.warning("[skills] prefilter failed, using store order: %s", exc)
        return list(rows)
