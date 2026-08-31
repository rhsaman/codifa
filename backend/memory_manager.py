"""Durable, TTL-aware memory system (memory_manager.py).

Memory notes are the agent's long-term knowledge about a project. The source
of truth is a plain JSONL file under ``{data_root}/memory/memories.jsonl``,
mirrored into a small FTS5 sqlite index (``memory.sqlite``) for fast lexical
recall and written through to the per-workspace vector store (kind=memory)
for semantic recall — so every future session auto-injects the relevant notes.

Memory types (TTLs configurable from Settings → Memory & Retrieval):

    permanent  — never expires (user pinned / "always remember")
    long_term  — default lifetime (e.g. 1 year)  [durable project facts]
    task       — short lifetime (e.g. 6 h)       [in-flight work notes]
    short_term — very short lifetime (e.g. 24 h) [transient context]

Sliding TTL: reading/using a note refreshes its expiry (``touch``), so notes
that are actively used don't vanish mid-task, while unused transient notes
are eventually purged by ``purge_expired`` (also called from cleanup).

The class is safe to use from the sidecar's event loop: all file mutations
happen under an RLock and writes are atomic (tmp + os.replace).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

import state_db

# -- memory types -------------------------------------------------------- #

MEM_PERMANENT = "permanent"
MEM_LONG_TERM = "long_term"
MEM_TASK = "task"
MEM_SHORT_TERM = "short_term"

MEMORY_TYPES = (MEM_PERMANENT, MEM_LONG_TERM, MEM_TASK, MEM_SHORT_TERM)

# Default TTL per memory type, in seconds. None = never expires.
DEFAULT_TTL_SECONDS: dict[str, float | None] = {
    MEM_PERMANENT: None,
    MEM_LONG_TERM: 365 * 24 * 3600,   # 1 year
    MEM_TASK: 6 * 3600,               # 6 hours
    MEM_SHORT_TERM: 24 * 3600,        # 24 hours
}

MEMORY_DIR = "memory"
MEMORIES_FILE = "memories.jsonl"
FTS_FILE = "memory.sqlite"

# FTS5 query tokens: word chars (incl. Persian/Arabic) become AND-ed terms,
# the last one gets a prefix wildcard — same scheme as vector_store.
_WORD_RE = re.compile(r"[\w\u0600-\u06FF]+", re.UNICODE)

_LOCK = threading.RLock()

# Meta keys carried onto the vector-store doc when writing through.
_VECTOR_META_KEYS = (
    "file_path", "source_url", "symbol_name", "symbol_type",
    "start_line", "end_line", "language",
)


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def _fts_query(query: str) -> str:
    """Build a safe FTS5 MATCH expression from free text."""
    words = _WORD_RE.findall(query or "")
    if not words:
        return ""
    if len(words) == 1:
        return f'"{words[0]}"*'
    parts = [f'"{w}"' for w in words[:-1]]
    parts.append(f'"{words[-1]}"*')
    return " AND ".join(parts)


@dataclass
class MemoryConfig:
    """Runtime bounds for the memory system (from Settings)."""

    max_notes: int = 500
    ttl_seconds: dict[str, float | None] = field(
        default_factory=lambda: dict(DEFAULT_TTL_SECONDS)
    )
    sliding_ttl: bool = True

    @classmethod
    def from_settings(cls, settings: dict | None) -> MemoryConfig:
        """Build a config from the app settings (memory section, if present)."""
        mem = (settings or {}).get("memory") or {}
        ttl = dict(DEFAULT_TTL_SECONDS)
        try:
            ttl[MEM_PERMANENT] = None
            ttl[MEM_LONG_TERM] = max(3600, float(mem.get("longTermTtlHours", 24 * 365))) * 3600
            ttl[MEM_TASK] = max(60, float(mem.get("taskTtlMinutes", 6 * 60))) * 60
            ttl[MEM_SHORT_TERM] = max(60, float(mem.get("shortTermTtlMinutes", 24 * 60))) * 60
        except (TypeError, ValueError):
            ttl = dict(DEFAULT_TTL_SECONDS)
        try:
            max_notes = max(20, int(mem.get("maxNotes", 500)))
        except (TypeError, ValueError):
            max_notes = 500
        sliding = bool(mem.get("slidingTtl", True))
        return cls(max_notes=max_notes, ttl_seconds=ttl, sliding_ttl=sliding)


class MemoryManager:
    """File-based memory store with TTLs, FTS5 index and vector write-through.

    ``project_id`` is the workspace slug; notes are scoped per project but
    stored in one shared JSONL (so a future "all projects" view is trivial).
    """

    def __init__(
        self,
        data_root: str = "",
        config: MemoryConfig | None = None,
    ) -> None:
        self._root = data_root or state_db.data_root()
        self._dir = os.path.join(self._root, MEMORY_DIR)
        os.makedirs(self._dir, exist_ok=True)
        self._path = os.path.join(self._dir, MEMORIES_FILE)
        self._fts_path = os.path.join(self._dir, FTS_FILE)
        self._config = config or MemoryConfig()
        self._store: object | None = None
        self._init_fts()

    # -- internals ------------------------------------------------------- #

    def _init_fts(self) -> None:
        try:
            with sqlite3.connect(self._fts_path) as conn:
                conn.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                        id UNINDEXED,
                        project_id UNINDEXED,
                        memory_type UNINDEXED,
                        content
                    )
                    """
                )
                conn.commit()
        except sqlite3.Error:
            pass  # degraded: lexical search falls back to a full scan

    def _fts_upsert(self, rec: dict) -> None:
        try:
            with sqlite3.connect(self._fts_path) as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO memories_fts(id, project_id, memory_type, content) "
                    "VALUES (?, ?, ?, ?)",
                    (
                        rec.get("id", ""),
                        rec.get("project_id", ""),
                        rec.get("memory_type", ""),
                        rec.get("content", ""),
                    ),
                )
                conn.commit()
        except sqlite3.Error:
            pass

    def _fts_delete(self, mid: str) -> None:
        try:
            with sqlite3.connect(self._fts_path) as conn:
                conn.execute("DELETE FROM memories_fts WHERE id = ?", (mid,))
                conn.commit()
        except sqlite3.Error:
            pass

    # -- vector write-through ------------------------------------------- //
    # Mirrors every FTS mutation into the workspace vector store (kind=memory,
    # key "memory:<id>") when a store is attached via ``bind_store``, so the
    # unified retrieval cascade (build_context / tools) sees notes too. These
    # are best-effort: a missing embedder or a closed store is a silent no-op
    # (upsert_many returns 0 chunks without raising), and a broken store never
    # breaks a memory write.

    def _vector_upsert(self, rec: dict) -> None:
        store = getattr(self, "_store", None)
        if store is None:
            return
        try:
            from vector_store import KIND_MEMORY

            store.upsert_doc(
                f"memory:{rec.get('id', '')}",
                KIND_MEMORY,
                (rec.get("content", "") or "")[:120],
                [rec.get("content", "")],
                {
                    "source": rec.get("source", "agent"),
                    "source_id": rec.get("source_id", ""),
                    "project_id": rec.get("project_id", ""),
                    "memory_type": rec.get("memory_type", "long_term"),
                },
            )
        except Exception:  # noqa: BLE001, S110 — write-through is best-effort
            pass

    def _vector_delete(self, mid: str) -> None:
        store = getattr(self, "_store", None)
        if store is None:
            return
        try:
            store.remove(f"memory:{mid}")
        except Exception:  # noqa: BLE001, S110 — write-through is best-effort
            pass

    def _fts_search(self, query: str, project_id: str, limit: int) -> list[str]:
        match = _fts_query(query)
        if not match:
            return []
        try:
            with sqlite3.connect(self._fts_path) as conn:
                rows = conn.execute(
                    """
                    SELECT id FROM memories_fts
                    WHERE memories_fts MATCH ? AND project_id = ?
                    ORDER BY rank LIMIT ?
                    """,
                    (match, project_id, limit),
                ).fetchall()
            return [str(r[0]) for r in rows]
        except sqlite3.Error:
            return []

    def _load_all(self) -> list[dict]:
        if not os.path.exists(self._path):
            return []
        out: list[dict] = []
        try:
            with open(self._path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(rec, dict) and rec.get("id"):
                        out.append(rec)
        except OSError:
            return []
        return out

    def _write_all(self, mems: list[dict]) -> None:
        tmp = self._path + f".tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(json.dumps(rec, ensure_ascii=False) + "\n" for rec in mems)
        os.replace(tmp, self._path)

    def _ttl_for(self, memory_type: str) -> float | None:
        ttl = self._config.ttl_seconds.get(memory_type)
        if ttl is None:
            return None
        return max(1.0, float(ttl))

    def _expired(self, rec: dict, now: float) -> bool:
        exp = rec.get("expires_at")
        if not exp:
            return False
        return float(exp) < now

    # -- public API ------------------------------------------------------ #

    def add(
        self,
        content: str,
        memory_type: str = MEM_LONG_TERM,
        project_id: str = "",
        source: str = "agent",
        source_id: str = "",
        confidence: float = 1.0,
        meta: dict | None = None,
    ) -> dict:
        """Store a memory note. Dedupes exact/near duplicates per project.

        Returns ``{"memory": id, "ok": True}`` or ``{"skipped": "duplicate",
        "matched": id}`` (and never raises).
        """
        content = (content or "").strip()
        if not content:
            return {"error": "empty note"}
        if memory_type not in MEMORY_TYPES:
            memory_type = MEM_LONG_TERM
        if len(content) > 4000:
            content = content[:4000] + "…"
        meta = meta or {}
        now = _now()
        ttl = self._ttl_for(memory_type)
        mid = str(uuid.uuid4())[:12]
        rec = {
            "id": mid,
            "memory_type": memory_type,
            "content": content,
            "project_id": project_id or "",
            "source": source or "agent",
            "source_id": source_id or "",
            "confidence": float(confidence),
            "created_at": now,
            "updated_at": now,
            "last_accessed_at": now,
            "expires_at": (now + ttl) if ttl else None,
        }
        for k in _VECTOR_META_KEYS:
            if meta.get(k):
                rec[k] = str(meta[k])

        with _LOCK:
            mems = self._load_all()
            norm = _normalize(content)
            # Dedup against the same project (exact substring).
            for m in mems:
                if (
                    m.get("project_id") == rec["project_id"]
                    and norm
                    and norm in _normalize(m.get("content", ""))
                ):
                    return {"memory": m["id"], "ok": True, "skipped": "duplicate", "matched": m["id"]}
            # Enforce cap: drop the oldest non-permanent notes (by last access).
            if len(mems) >= self._config.max_notes:
                dropable = [m for m in mems if m.get("memory_type") != MEM_PERMANENT]
                dropable.sort(key=lambda m: float(m.get("last_accessed_at", 0)))
                for m in dropable[: len(mems) - self._config.max_notes + 1]:
                    mems.remove(m)
                    self._fts_delete(m["id"])
                    self._vector_delete(m["id"])
            mems.append(rec)
            self._write_all(mems)
            self._fts_upsert(rec)
            self._vector_upsert(rec)
        return {"memory": mid, "ok": True}

    def get(self, mid: str) -> dict | None:
        with _LOCK:
            for rec in self._load_all():
                if rec.get("id") == mid:
                    return dict(rec)
        return None

    def list(self, project_id: str = "", include_expired: bool = False) -> list[dict]:
        now = _now()
        with _LOCK:
            mems = [
                dict(m)
                for m in self._load_all()
                if (not project_id or m.get("project_id") == project_id)
                and (include_expired or not self._expired(m, now))
            ]
        mems.sort(key=lambda m: float(m.get("updated_at", 0)), reverse=True)
        return mems

    def touch(self, mid: str) -> None:
        """Refresh a note's expiry (sliding TTL) + last_accessed_at."""
        if not self._config.sliding_ttl:
            return
        with _LOCK:
            mems = self._load_all()
            changed = False
            now = _now()
            for rec in mems:
                if rec.get("id") == mid:
                    ttl = self._ttl_for(rec.get("memory_type", MEM_LONG_TERM))
                    rec["last_accessed_at"] = now
                    if ttl:
                        rec["expires_at"] = now + ttl
                    changed = True
                    break
            if changed:
                self._write_all(mems)

    def replace(
        self,
        subject: str,
        new_text: str,
        project_id: str = "",
        memory_type: str = "",
    ) -> dict:
        """Update the note containing ``subject`` to read ``new_text``.
        If nothing matches, falls back to ``add`` (safe to always call)."""
        subject = (subject or "").strip()
        new_text = (new_text or "").strip()
        if not subject:
            return {"error": "empty subject"}
        if not new_text:
            return {"error": "empty replacement text"}
        if len(new_text) > 4000:
            new_text = new_text[:4000] + "…"
        subj_norm = _normalize(subject)
        with _LOCK:
            mems = self._load_all()
            for rec in mems:
                if (
                    rec.get("project_id") == project_id
                    and subj_norm
                    and subj_norm in _normalize(rec.get("content", ""))
                ):
                        rec["content"] = new_text
                        rec["updated_at"] = _now()
                        self._write_all(mems)
                        self._fts_upsert(rec)
                        self._vector_upsert(rec)
                        return {"memory": rec["id"], "ok": True, "replaced": True}
        # No match → append as a new note (Hermes-style replace semantics).
        return self.add(new_text, memory_type or MEM_LONG_TERM, project_id=project_id)

    def remove(self, subject: str, project_id: str = "") -> dict:
        """Delete the note containing ``subject``. Returns ok even when
        nothing matched (idempotent)."""
        subject = (subject or "").strip()
        subj_norm = _normalize(subject)
        with _LOCK:
            mems = self._load_all()
            remaining: list[dict] = []
            removed = False
            for rec in mems:
                if (
                    subj_norm
                    and rec.get("project_id") == project_id
                    and subj_norm in _normalize(rec.get("content", ""))
                ):
                    self._fts_delete(rec["id"])
                    self._vector_delete(rec["id"])
                    removed = True
                    continue
                remaining.append(rec)
            if removed:
                self._write_all(remaining)
        return {"ok": True, "removed": removed}

    def remove_by_id(self, mid: str) -> dict:
        with _LOCK:
            mems = self._load_all()
            remaining = [m for m in mems if m.get("id") != mid]
            if len(remaining) != len(mems):
                self._fts_delete(mid)
                self._vector_delete(mid)
                self._write_all(remaining)
                return {"ok": True, "removed": True}
        return {"ok": True, "removed": False}

    def search(
        self,
        query: str,
        project_id: str = "",
        top_k: int = 8,
        min_score: float = 0.2,
        include_web: bool = False,
    ) -> list[dict]:
        """Retrieve notes relevant to ``query``.

        Cascade: FTS5 lexical first (fast, exact words), then — when the
        embedder is available and a ``store`` is attached via ``bind_store``
        — semantic vector recall. Results are deduped, expired notes skipped,
        and matched notes are ``touch``ed (sliding TTL).
        """
        query = (query or "").strip()
        project_id = project_id or ""
        now = _now()
        with _LOCK:
            mems = {
                m["id"]: dict(m)
                for m in self._load_all()
                if (not project_id or m.get("project_id") == project_id)
                and not self._expired(m, now)
            }
        if not query:
            ranked = sorted(mems.values(), key=lambda m: float(m.get("updated_at", 0)), reverse=True)
            return ranked[:top_k]

        results: dict[str, float] = {}
        # 1) Lexical (FTS5, fallback to substring scan).
        fts_ids = self._fts_search(query, project_id, top_k * 4)
        if fts_ids:
            for mid in fts_ids:
                if mid in mems:
                    results[mid] = max(results.get(mid, 0.0), 0.55)
        else:
            q_norm = _normalize(query)
            for mid, rec in mems.items():
                if q_norm and q_norm in _normalize(rec.get("content", "")):
                    results[mid] = max(results.get(mid, 0.0), 0.9)
        # 2) Semantic (vector store, if bound).
        sem = self._semantic_search(query, project_id, top_k * 4)
        for mid, score in sem.items():
            if mid in mems:
                results[mid] = max(results.get(mid, 0.0), float(score))
        ranked = sorted(results.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        out = [dict(mems[mid]) | {"score": round(score, 4)} for mid, score in ranked]
        for rec in out:
            self.touch(rec["id"])
        return out

    def _semantic_search(self, query: str, project_id: str, limit: int) -> dict[str, float]:
        store = getattr(self, "_store", None)
        if store is None:
            return {}
        try:
            from vector_store import KIND_MEMORY

            rows = store.search(query, KIND_MEMORY, top_k=limit, min_score=0.15)
        except Exception:  # noqa: BLE001 — embedder unavailable → lexical only
            return {}
        out: dict[str, float] = {}
        for r in rows:
            key = str(r.get("key", ""))
            # New-style key "memory:<id>" → recover the JSONL id.
            if key.startswith("memory:"):
                out[key[len("memory:"):]] = float(r.get("score", 0.0))
        return out

    def bind_store(self, store) -> MemoryManager:
        """Attach the workspace vector store for semantic recall."""
        self._store = store
        return self

    def purge_expired(self) -> int:
        """Delete expired TASK/SHORT_TERM notes. Returns how many were removed."""
        now = _now()
        with _LOCK:
            mems = self._load_all()
            remaining: list[dict] = []
            removed = 0
            for rec in mems:
                if self._expired(rec, now):
                    self._fts_delete(rec["id"])
                    self._vector_delete(rec["id"])
                    removed += 1
                else:
                    remaining.append(rec)
            if removed:
                self._write_all(remaining)
        return removed

    def stats(self) -> dict:
        now = _now()
        with _LOCK:
            mems = self._load_all()
        total = len(mems)
        by_type: dict[str, int] = {}
        expired = 0
        for rec in mems:
            t = rec.get("memory_type", MEM_LONG_TERM)
            by_type[t] = by_type.get(t, 0) + 1
            if self._expired(rec, now):
                expired += 1
        return {
            "total": total,
            "by_type": by_type,
            "expired": expired,
            "max_notes": self._config.max_notes,
            "path": self._path,
        }


def open_memory(
    data_root: str = "",
    settings: dict | None = None,
    store=None,
) -> MemoryManager:
    """Convenience factory: memory manager bound to the data root + a vector
    store (optional). Never raises."""
    try:
        mm = MemoryManager(data_root, MemoryConfig.from_settings(settings))
        if store is not None:
            mm.bind_store(store)
        return mm
    except Exception:  # noqa: BLE001
        return MemoryManager(data_root or state_db.data_root(), MemoryConfig())
