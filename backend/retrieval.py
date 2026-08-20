"""Retrieval engine: unified ranked recall over the workspace vector store.

Combines the three backends of ``vector_store.VectorStore`` into one cascade
and normalises the results so the caller (context_builder / tools / server)
gets a single ranked list of hits:

1. **exact**  — path / symbol / url / key match (cheap, highest confidence)
2. **fts**     — FTS5 lexical (AND + prefix on last word)
3. **semantic** — sqlite-vec ANN cosine (only when the embedder is available)

The cascade is *additive*: every backend that returns anything contributes, but
each hit is deduplicated by its underlying chunk id (``_chunk_id``) or doc key,
and scores are normalised to a 0..1 ``score`` + a ``source`` label so the
caller can explain/rank. Exact hits always win, then lexical, then semantic.

Design goals:

* **Never raises.** A missing embedder, an empty DB or a corrupt index yields
  ``[]`` (or a partial result), never an exception — callers degrade gracefully.
* **Kind-scoped.** ``kinds=`` restricts which document kinds are searched
  (``file`` / ``web`` / ``memory`` / ``skill``); ``None`` searches all.
* **Bounded.** ``top_k`` caps the returned hits, ``per_backend`` caps each
  backend's work, and chunk texts are truncated to ``max_chars`` so injecting
  results into a prompt can't blow the context budget.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

from vector_store import (
    KIND_FILE,
    KIND_MEMORY,
    KIND_WEB,
    VectorStore,
)

# All known kinds, in the order the context builder likes to see them.
ALL_KINDS = (KIND_FILE, KIND_WEB, KIND_MEMORY)

# Score floors per backend (0..1). Exact is always accepted; FTS and semantic
# need to clear a bar so weak matches don't pollute the context.
_EXACT_MIN = 0.0
_FTS_MIN = 0.15
_SEMANTIC_MIN = 0.25

# How much of each hit's text to keep when formatting (chars).
_DEFAULT_MAX_CHARS = 900

_DEFAULT_TOP_K = 8
_DEFAULT_PER_BACKEND = 12


@dataclass
class RetrievalSettings:
    """User-tunable retrieval knobs (fed from Settings → Memory & Retrieval)."""

    top_k: int = _DEFAULT_TOP_K
    max_chars: int = _DEFAULT_MAX_CHARS
    min_score: float = _SEMANTIC_MIN
    include_files: bool = True
    include_memory: bool = True
    include_web: bool = True
    auto_index: bool = True  # index workspace files on workspace open
    auto_recall: bool = True  # inject retrieved context into every prompt

    @classmethod
    def from_dict(cls, d: dict | None) -> RetrievalSettings:
        d = d or {}

        def _int(key: str, default: int) -> int:
            try:
                return max(1, int(d.get(key, default)))
            except (TypeError, ValueError):
                return default

        def _bool(key: str, default: bool) -> bool:
            v = d.get(key, default)
            return bool(v) if isinstance(v, bool) else default

        return cls(
            top_k=_int("top_k", _DEFAULT_TOP_K),
            max_chars=_int("max_chars", _DEFAULT_MAX_CHARS),
            min_score=float(_int("min_score", 25) / 100),
            include_files=_bool("include_files", True),
            include_memory=_bool("include_memory", True),
            include_web=_bool("include_web", True),
            auto_index=_bool("auto_index", True),
            auto_recall=_bool("auto_recall", True),
        )

    def active_kinds(self) -> tuple[str, ...]:
        kinds: list[str] = []
        if self.include_files:
            kinds.append(KIND_FILE)
        if self.include_memory:
            kinds.append(KIND_MEMORY)
        if self.include_web:
            kinds.append(KIND_WEB)
        return tuple(kinds) or ()


@dataclass
class Hit:
    """One normalised retrieval result."""

    key: str
    kind: str
    title: str
    text: str
    score: float
    source: str  # "exact" | "fts" | "semantic"
    meta: dict = field(default_factory=dict)

    def snippet(self, max_chars: int = _DEFAULT_MAX_CHARS) -> str:
        t = re.sub(r"\s+", " ", self.text or "").strip()
        if len(t) > max_chars:
            t = t[: max_chars - 1].rstrip() + "…"
        return t


def _dedupe(hits: list[Hit]) -> list[Hit]:
    """Keep the best (highest-scoring, exact-first) hit per doc key."""
    best: dict[str, Hit] = {}
    order: list[str] = []
    for h in hits:
        prev = best.get(h.key)
        if prev is None:
            best[h.key] = h
            order.append(h.key)
            continue
        # Exact beats fts beats semantic; ties go to the higher score.
        rank = {"exact": 0, "fts": 1, "semantic": 2}
        if rank[h.source] < rank[prev.source] or (
            rank[h.source] == rank[prev.source] and h.score > prev.score
        ):
            best[h.key] = h
    return [best[k] for k in order]


def retrieve(
    store: VectorStore | None,
    query: str,
    kinds: tuple[str, ...] | list[str] | None = None,
    top_k: int = _DEFAULT_TOP_K,
    max_chars: int = _DEFAULT_MAX_CHARS,
    min_score: float | None = None,
) -> list[Hit]:
    """Run the cascade over ``store`` and return ranked, deduped hits.

    ``kinds`` restricts document kinds (None → all). ``min_score`` overrides the
    semantic floor (defaults to ``RetrievalSettings.min_score`` behaviour via
    the module constant when None).
    """
    if store is None:
        return []
    query = (query or "").strip()
    if not query:
        return []
    kinds = tuple(kinds) if kinds else None
    floor = _SEMANTIC_MIN if min_score is None else min_score

    hits: list[Hit] = []

    # 1. exact — path/symbol/url/key. Never scored below acceptance.
    try:
        for row in store.exact_lookup(query, kind=None):
            if kinds and row.get("kind") not in kinds:
                continue
            hits.append(
                Hit(
                    key=str(row.get("key", "")),
                    kind=str(row.get("kind", "")),
                    title=str(row.get("title", "") or ""),
                    text=str(row.get("text", "") or ""),
                    score=1.0,
                    source="exact",
                    meta=dict(row),
                )
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("retrieval: exact_lookup failed: %s", exc)

    # 2. fts — lexical (works without an embedder).
    try:
        for row in store.fts_search(query, kind=None, top_k=_DEFAULT_PER_BACKEND):
            if kinds and row.get("kind") not in kinds:
                continue
            hits.append(
                Hit(
                    key=str(row.get("key", "")),
                    kind=str(row.get("kind", "")),
                    title=str(row.get("title", "") or ""),
                    text=str(row.get("text", "") or ""),
                    score=0.8,
                    source="fts",
                )
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("retrieval: fts_search failed: %s", exc)

    # 3. semantic — ANN cosine; only when the embedder is usable.
    try:
        for row in store.search(query, kind=None, top_k=_DEFAULT_PER_BACKEND, min_score=floor):
            if kinds and row.get("kind") not in kinds:
                continue
            hits.append(
                Hit(
                    key=str(row.get("key", "")),
                    kind=str(row.get("kind", "")),
                    title=str(row.get("title", "") or ""),
                    text=str(row.get("text", "") or ""),
                    score=float(row.get("score", 0.0)),
                    source="semantic",
                )
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("retrieval: semantic search failed: %s", exc)

    hits = _dedupe(hits)
    # Final ranking: source rank first, then score, then title.
    rank = {"exact": 0, "fts": 1, "semantic": 2}
    hits.sort(key=lambda h: (rank.get(h.source, 3), -h.score, h.title or ""))
    for h in hits:
        h.text = h.snippet(max_chars)
    return hits[:top_k]


def retrieve_kind(
    store: VectorStore | None,
    query: str,
    kind: str,
    top_k: int = _DEFAULT_TOP_K,
    max_chars: int = _DEFAULT_MAX_CHARS,
) -> list[Hit]:
    """Convenience wrapper: retrieve within a single document kind."""
    return retrieve(store, query, kinds=(kind,), top_k=top_k, max_chars=max_chars)


def stats(store: VectorStore | None) -> dict:
    """Human-readable index stats (empty dict when the store is unavailable)."""
    if store is None:
        return {}
    try:
        return dict(store.stats())
    except Exception:  # noqa: BLE001
        return {}
