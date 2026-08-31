"""SQLite vector store: sqlite-vec ANN + FTS5 lexical search (no hashing).

Stores embedded text chunks (memory notes, fetched web pages, skills, indexed
project files) in one sqlite file per workspace, at
``{vectorDbPath}/{workspace-slug}.sqlite``.

Two indexes serve retrieval, in one DB file:

* ``vec_chunks`` — a sqlite-vec ``vec0`` virtual table for fast approximate
  nearest-neighbour search over float32 embeddings (rowid == chunks.id).
* ``fts_chunks`` — an FTS5 virtual table for lexical / keyword search
  (rowid == chunks.id), exact-word + prefix.

There is NO content hash anywhere: change detection for incremental indexing is
done with file mtime + size only (see ``indexer.py``), and documents carry rich
metadata (source type, file path, symbol name/type, lines, embedding model /
dimension / version) so incompatible vectors are never mixed.

If the embedding model changes width between runs, the vec0 table is dropped and
recreated at the new width; chunks keep their text (FTS + exact still work) and
are re-embedded on their next upsert.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import sqlite3
import threading
from collections.abc import Sequence

logger = logging.getLogger(__name__)
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import sqlite_vec

from embeddings import embed_dim, embed_passages, embed_queries

KIND_MEMORY = "memory"
KIND_WEB = "web"
KIND_FILE = "file"

# Bump when the embedding pipeline itself changes (prompt format, pooling, ...)
# so stale vectors are rebuilt rather than silently mixed.
EMBEDDING_VERSION = 1

_DB_LOCK = threading.RLock()

_DEFAULTS = {
    "max_docs": 500,
    "max_chunks": 4_000,
    "ttl_days": 180,
}

# FTS5 search terms: word chars (incl. Persian/Arabic) become AND-ed tokens,
# the last one gets a prefix wildcard.
_WORD_RE = re.compile(r"[\w\u0600-\u06FF]+", re.UNICODE)


@dataclass
class StoreConfig:
    """Runtime size / TTL bounds for one vector store (from Settings)."""

    max_docs: int = _DEFAULTS["max_docs"]
    max_chunks: int = _DEFAULTS["max_chunks"]
    ttl_days: int = _DEFAULTS["ttl_days"]

    @classmethod
    def from_dict(cls, d: dict | None) -> StoreConfig:
        d = d or {}
        try:
            max_docs = max(10, int(d.get("max_docs", _DEFAULTS["max_docs"])))
        except (TypeError, ValueError):
            max_docs = _DEFAULTS["max_docs"]
        try:
            max_chunks = max(50, int(d.get("max_chunks", _DEFAULTS["max_chunks"])))
        except (TypeError, ValueError):
            max_chunks = _DEFAULTS["max_chunks"]
        try:
            ttl_days = max(1, int(d.get("ttl_days", _DEFAULTS["ttl_days"])))
        except (TypeError, ValueError):
            ttl_days = _DEFAULTS["ttl_days"]
        return cls(max_docs=max_docs, max_chunks=max_chunks, ttl_days=ttl_days)


# File extension mapping. Old layout used ``{slug}.sqlite``; the new one uses
# ``{slug}.vectors.sqlite`` (and matching ``-wal`` / ``-shm`` sidecars). The
# old name is auto-renamed on first open (see ``_migrate_legacy_file``).
_VEC_SUFFIX = ".vectors.sqlite"
_VEC_SUFFIXES = (".vectors.sqlite", ".vectors.sqlite-wal", ".vectors.sqlite-shm")
_LEGACY_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm")


def db_path_for(base_dir: str, workspace_slug: str) -> str:
    """Full path of the per-workspace sqlite file under ``base_dir``."""
    base_dir = os.path.expanduser(base_dir or "")
    if not base_dir:
        raise ValueError("vectorDbPath is not configured")
    slug = (workspace_slug or "workspace").strip().strip("/")
    if not slug or slug in (".", ".."):
        slug = "workspace"
    return os.path.join(base_dir, f"{slug}{_VEC_SUFFIX}")


def migrate_legacy_dbs(base_dir: str) -> None:
    """Rename any old ``{slug}.sqlite`` / ``skills.sqlite`` files under
    ``base_dir`` to the new ``{slug}.vectors.sqlite`` layout.

    SQLite WAL/SHM sidecars are renamed alongside the main file so an
    in-progress connection is never left pointing at a stale sidecar. No-op
    when the directory or old files don't exist; never raises.
    """
    base_dir = os.path.expanduser(base_dir or "")
    if not base_dir or not os.path.isdir(base_dir):
        return
    try:
        for name in sorted(os.listdir(base_dir)):
            if not name.endswith(".sqlite"):
                continue
            if ".vectors.sqlite" in name:
                continue
            stem = name[: -len(".sqlite")]
            if not stem:
                continue
            old = os.path.join(base_dir, name)
            new = os.path.join(base_dir, f"{stem}.vectors.sqlite")
            if os.path.exists(new):
                continue
            try:
                os.replace(old, new)
                for suffix in (".sqlite-wal", ".sqlite-shm"):
                    side = os.path.join(base_dir, f"{stem}{suffix}")
                    if os.path.exists(side):
                        os.replace(side, os.path.join(base_dir, f"{stem}.vectors{suffix}"))
            except OSError:
                pass
    except OSError:
        pass


def _fts_query(query: str) -> str:
    """Build an FTS5 MATCH expression from free text (AND of words, prefix last)."""
    tokens = _WORD_RE.findall(query or "")
    if not tokens:
        return ""
    tokens = [t for t in tokens if len(t) > 1 or t.isalnum()]
    if not tokens:
        return ""
    terms = ['"' + t.replace('"', '""') + '"' for t in tokens[:-1]]
    last = tokens[-1].replace('"', '""')
    terms.append(f'"{last}"*')
    return " AND ".join(terms)


class VectorStore:
    """One workspace's sqlite vector store (sqlite-vec ANN + FTS5 lexical)."""

    def __init__(self, db_path: str, config: StoreConfig | None = None) -> None:
        # Service the legacy {slug}.sqlite rename before touching the file.
        try:
            migrate_legacy_dbs(os.path.dirname(os.path.abspath(db_path)))
        except Exception:  # noqa: BLE001, S110 — migration is best-effort
            pass
        self.db_path = db_path
        self.config = config or StoreConfig()
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        try:
            self._conn.enable_load_extension(True)
            sqlite_vec.load(self._conn)
        except Exception as exc:  # noqa: BLE001 — sqlite-vec missing → degraded (FTS only)
            logger.debug("vector_store: sqlite-vec unavailable, FTS-only mode: %s", exc)
        self._dim = int(embed_dim() or 768)
        self._init_schema()

    # -- schema ---------------------------------------------------------- #

    # Single source of truth for the docs table columns. Used both by the
    # CREATE TABLE statement and by the ALTER TABLE migration below, so a DB
    # created by an older build (missing newer columns) is upgraded in place
    # instead of failing with "no such column: ...".
    _DOC_COLUMNS: tuple[tuple[str, str], ...] = (
        ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
        ("key", "TEXT NOT NULL UNIQUE"),
        ("kind", "TEXT NOT NULL"),
        ("title", "TEXT NOT NULL DEFAULT ''"),
        ("source_type", "TEXT NOT NULL DEFAULT ''"),
        ("source_id", "TEXT NOT NULL DEFAULT ''"),
        ("file_path", "TEXT NOT NULL DEFAULT ''"),
        ("source_url", "TEXT NOT NULL DEFAULT ''"),
        ("symbol_name", "TEXT NOT NULL DEFAULT ''"),
        ("symbol_type", "TEXT NOT NULL DEFAULT ''"),
        ("start_line", "INTEGER NOT NULL DEFAULT 0"),
        ("end_line", "INTEGER NOT NULL DEFAULT 0"),
        ("language", "TEXT NOT NULL DEFAULT ''"),
        ("mtime", "REAL NOT NULL DEFAULT 0"),
        ("file_size", "INTEGER NOT NULL DEFAULT 0"),
        ("fetched_at", "REAL NOT NULL"),
        ("chunk_count", "INTEGER NOT NULL DEFAULT 0"),
        ("embedding_model", "TEXT NOT NULL DEFAULT ''"),
        ("embedding_dimension", "INTEGER NOT NULL DEFAULT 0"),
        ("embedding_version", "INTEGER NOT NULL DEFAULT 0"),
        ("content_hash", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "REAL NOT NULL"),
        ("updated_at", "REAL NOT NULL"),
    )

    def _init_schema(self) -> None:
        with _DB_LOCK, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS docs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    source_type TEXT NOT NULL DEFAULT '',
                    source_id TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL DEFAULT '',
                    source_url TEXT NOT NULL DEFAULT '',
                    symbol_name TEXT NOT NULL DEFAULT '',
                    symbol_type TEXT NOT NULL DEFAULT '',
                    start_line INTEGER NOT NULL DEFAULT 0,
                    end_line INTEGER NOT NULL DEFAULT 0,
                    language TEXT NOT NULL DEFAULT '',
                    mtime REAL NOT NULL DEFAULT 0,
                    file_size INTEGER NOT NULL DEFAULT 0,
                    fetched_at REAL NOT NULL,
                    chunk_count INTEGER NOT NULL DEFAULT 0,
                    embedding_model TEXT NOT NULL DEFAULT '',
                    embedding_dimension INTEGER NOT NULL DEFAULT 0,
                    embedding_version INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
            )
            # Migration: an existing DB from an older build may be missing
            # columns added later. Add each missing column in place so the
            # store opens and all queries/indexes work again.
            try:
                existing = {
                    row["name"] for row in self._conn.execute("PRAGMA table_info(docs)")
                }
                for col, decl in self._DOC_COLUMNS:
                    if col not in existing:
                        self._conn.execute(f"ALTER TABLE docs ADD COLUMN {col} {decl}")
                self._conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_key ON docs(key)")
                self._conn.execute("CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(kind)")
                self._conn.execute("CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(file_path)")
            except Exception as exc:  # noqa: BLE001 — migration is best-effort
                logger.debug("vector_store: schema migration skipped: %s", exc)
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                    txt TEXT NOT NULL,
                    vec BLOB NOT NULL,
                    content_hash TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
                CREATE TABLE IF NOT EXISTS meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL
                );
                """
            )
            stored_dim = self._meta_get("vec_dim")
            if stored_dim and int(stored_dim) != self._dim:
                # embedding model changed width → rebuild the ANN index at the
                # new width; text (FTS/exact) survives, vectors re-embed on upsert.
                self._drop_vec_table()
                stored_dim = None
            if not stored_dim:
                self._ensure_vec_table()
            self._ensure_fts_table()

    def _meta_get(self, key: str) -> str | None:
        row = self._conn.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return str(row[0]) if row else None

    def _meta_set(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO meta(k, v) VALUES (?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (key, value),
        )

    def _ensure_vec_table(self) -> None:
        self._drop_vec_table()
        try:
            self._conn.execute(
                f"CREATE VIRTUAL TABLE vec_chunks USING vec0("
                f"vec float[{self._dim}], kind text, doc_id integer)"
            )
            self._meta_set("vec_dim", str(self._dim))
        except sqlite3.Error:
            self._meta_set("vec_dim", "")  # marker: vec0 unavailable → FTS-only
        self._meta_set("embedding_version", str(EMBEDDING_VERSION))

    def _drop_vec_table(self) -> None:
        try:
            self._conn.execute("DROP TABLE IF EXISTS vec_chunks")
        except sqlite3.Error:
            pass

    def _ensure_fts_table(self) -> None:
        self._conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5("
            "txt, kind UNINDEXED, doc_id UNINDEXED, tokenize='unicode61')"
        )

    def close(self) -> None:
        with _DB_LOCK:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass

    def vacuum(self) -> bool:
        """Reclaim disk space after a big purge.

        VACUUM requires no active transaction; we hold the shared lock so
        concurrent readers are flushed first. Returns True when the call
        succeeded, False otherwise (best-effort: a locked DB just yields False).
        """
        try:
            with _DB_LOCK:
                self._conn.execute("VACUUM")
            return True
        except sqlite3.Error:
            return False

    # -- helpers ---------------------------------------------------------- #

    def _vec_to_blob(self, vec: Sequence[float]) -> bytes:
        return np.asarray(vec, dtype=np.float32).tobytes()

    def _blob_to_vec(self, blob: bytes) -> np.ndarray:
        return np.frombuffer(blob, dtype=np.float32)

    def _now(self) -> float:
        return datetime.now(timezone.utc).timestamp()

    @staticmethod
    def _content_hash(text: str) -> str:
        """SHA-256 of a whitespace-normalised text (deterministic across runs)."""
        norm = re.sub(r"\s+", " ", (text or "").strip())
        return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:24]

    def _purge_doc_chunks(self, doc_id: int) -> None:
        """Delete a doc's chunks from chunks + vec_chunks + fts_chunks."""
        ids = [
            r[0]
            for r in self._conn.execute(
                "SELECT id FROM chunks WHERE doc_id = ?", (doc_id,)
            ).fetchall()
        ]
        for cid in ids:
            try:
                self._conn.execute("DELETE FROM vec_chunks WHERE rowid = ?", (cid,))
            except sqlite3.Error:
                pass
            self._conn.execute("DELETE FROM fts_chunks WHERE rowid = ?", (cid,))
        self._conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))

    # -- writes ---------------------------------------------------------- #

    def upsert_doc(
        self,
        key: str,
        kind: str,
        title: str,
        texts: Sequence[str],
        meta: dict | None = None,
    ) -> int:
        """Store (or replace) a document's chunks under ``key``.

        ``meta`` may carry: source_type, source_id, file_path, source_url,
        symbol_name, symbol_type, start_line, end_line, language, mtime,
        file_size. Returns the number of chunks saved.
        """
        return self.upsert_many([(key, kind, title, texts, meta)])

    def upsert_many(
        self,
        entries: Sequence[tuple],
    ) -> int:
        """Store (or replace) many documents in one pass.

        ``entries`` is ``(key, kind, title, texts)`` or
        ``(key, kind, title, texts, meta)``. All passages are embedded in a
        single (internally batched) call; SQL writes happen in one transaction.
        Returns the total number of chunks saved.
        """
        flat_keys: list[tuple[str, str, str]] = []
        spans: list[tuple[int, int]] = []
        flat_texts: list[str] = []
        metas: list[dict | None] = []
        for entry in entries:
            key, kind, title, texts = entry[0], entry[1], entry[2], entry[3]
            meta = entry[4] if len(entry) > 4 else None
            texts = [t for t in texts if t and t.strip()]
            if not texts:
                continue
            flat_keys.append((key, kind, title[:500]))
            spans.append((len(flat_texts), len(flat_texts) + len(texts)))
            flat_texts.extend(texts)
            metas.append(meta or {})
        if not flat_texts:
            return 0
        vecs = embed_passages(flat_texts)
        if not vecs or len(vecs) != len(flat_texts):
            return 0
        now = self._now()
        with _DB_LOCK, self._conn:
            total = 0
            for (key, kind, title), (a, b), meta in zip(flat_keys, spans, metas):
                row = self._conn.execute(
                    "SELECT id FROM docs WHERE key = ?", (key,)
                ).fetchone()
                if row:
                    doc_id = int(row[0])
                    self._purge_doc_chunks(doc_id)
                    self._conn.execute(
                        """
                        UPDATE docs SET kind=?, title=?, source_type=?,
                          source_id=?, file_path=?, source_url=?, symbol_name=?,
                          symbol_type=?, start_line=?, end_line=?, language=?,
                          mtime=?, file_size=?, updated_at=?, chunk_count=0,
                          embedding_model=?, embedding_dimension=?,
                          embedding_version=?, content_hash=?
                        WHERE id=?
                        """,
                        (
                            kind,
                            title,
                            str(meta.get("source_type", "")),
                            str(meta.get("source_id", "")),
                            str(meta.get("file_path", "")),
                            str(meta.get("source_url", "")),
                            str(meta.get("symbol_name", "")),
                            str(meta.get("symbol_type", "")),
                            int(meta.get("start_line", 0) or 0),
                            int(meta.get("end_line", 0) or 0),
                            str(meta.get("language", "")),
                            float(meta.get("mtime", 0) or 0),
                            int(meta.get("file_size", 0) or 0),
                            now,
                            str(meta.get("embedding_model", "")),
                            int(meta.get("embedding_dimension", 0) or 0),
                            int(meta.get("embedding_version", 0) or 0),
                            str(meta.get("content_hash", "")),
                            doc_id,
                        ),
                    )
                else:
                    cur = self._conn.execute(
                        """
                        INSERT INTO docs (key, kind, title, source_type, source_id,
                          file_path, source_url, symbol_name, symbol_type,
                          start_line, end_line, language, mtime, file_size,
                          fetched_at, chunk_count, embedding_model,
                          embedding_dimension, embedding_version, content_hash, created_at,
                          updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)
                        """,
                        (
                            key,
                            kind,
                            title,
                            str(meta.get("source_type", "")),
                            str(meta.get("source_id", "")),
                            str(meta.get("file_path", "")),
                            str(meta.get("source_url", "")),
                            str(meta.get("symbol_name", "")),
                            str(meta.get("symbol_type", "")),
                            int(meta.get("start_line", 0) or 0),
                            int(meta.get("end_line", 0) or 0),
                            str(meta.get("language", "")),
                            float(meta.get("mtime", 0) or 0),
                            int(meta.get("file_size", 0) or 0),
                            now,
                            str(meta.get("embedding_model", "")),
                            int(meta.get("embedding_dimension", 0) or 0),
                            int(meta.get("embedding_version", 0) or 0),
                            str(meta.get("content_hash", "")),
                            now,
                            now,
                        ),
                    )
                    doc_id = int(cur.lastrowid)
                texts_span = flat_texts[a:b]
                vecs_span = vecs[a:b]
                for txt, vec in zip(texts_span, vecs_span):
                    h = self._content_hash(txt)
                    cur = self._conn.execute(
                        "INSERT INTO chunks (doc_id, txt, vec, content_hash, created_at, updated_at) "
                        "VALUES (?,?,?,?,?,?)",
                        (doc_id, txt, self._vec_to_blob(vec), h, now, now),
                    )
                    cid = int(cur.lastrowid)
                    self._insert_index_rows(cid, doc_id, kind, txt, vec)
                self._conn.execute(
                    "UPDATE docs SET chunk_count = chunk_count + ? WHERE id = ?",
                    (len(texts_span), doc_id),
                )
                total += len(texts_span)
            return total

    def _insert_index_rows(
        self, cid: int, doc_id: int, kind: str, txt: str, vec: Sequence[float]
    ) -> None:
        try:
            self._conn.execute(
                "INSERT INTO vec_chunks(rowid, vec, kind, doc_id) VALUES (?,?,?,?)",
                (cid, self._vec_to_blob(vec), kind, doc_id),
            )
        except sqlite3.Error as exc:
            logger.debug("vector_store: vec_chunks insert failed for chunk %s: %s", cid, exc)
        self._conn.execute(
            "INSERT INTO fts_chunks(rowid, txt, kind, doc_id) VALUES (?,?,?,?)",
            (cid, txt, kind, doc_id),
        )

    def remove(self, key: str) -> bool:
        """Remove a document (and its chunks + index rows). True when removed."""
        with _DB_LOCK, self._conn:
            row = self._conn.execute(
                "SELECT id FROM docs WHERE key = ?", (key,)
            ).fetchone()
            if not row:
                return False
            self._purge_doc_chunks(int(row[0]))
            self._conn.execute("DELETE FROM docs WHERE id = ?", (row[0],))
            return True

    # -- introspection ---------------------------------------------------- #

    def count_docs(self, kind: str | None = None) -> int:
        with _DB_LOCK:
            if kind:
                row = self._conn.execute(
                    "SELECT COUNT(*) FROM docs WHERE kind = ?", (kind,)
                ).fetchone()
            else:
                row = self._conn.execute("SELECT COUNT(*) FROM docs").fetchone()
        return int(row[0] or 0)

    def has_kind(self, kind: str) -> bool:
        row = self._conn.execute(
            "SELECT COUNT(*) FROM docs WHERE kind = ?", (kind,)
        ).fetchone()
        return int(row[0] or 0) > 0

    def doc_texts(self, kind: str) -> list[dict]:
        """All docs of ``kind`` with their (key, title, full text)."""
        rows = self._conn.execute(
            """
            SELECT d.key, d.title, c.txt
            FROM chunks c JOIN docs d ON d.id = c.doc_id
            WHERE d.kind = ?
            ORDER BY d.fetched_at
            """,
            (kind,),
        ).fetchall()
        docs: dict[str, dict] = {}
        for key, title, txt in rows:
            entry = docs.setdefault(key, {"key": key, "title": title, "text": ""})
            entry["text"] += ("" if not entry["text"] else "\n") + txt
        return list(docs.values())

    def doc_meta(self, key: str) -> dict | None:
        """Return a doc's metadata row (or None)."""
        row = self._conn.execute(
            "SELECT * FROM docs WHERE key = ?", (key,)
        ).fetchone()
        return dict(row) if row else None

    def all_doc_meta(self, kind: str | None = None) -> dict[str, dict]:
        """Return every doc's metadata row keyed by ``key``.

        Used by the incremental indexer for cheap mtime/size change detection
        (one query instead of one per file).
        """
        with _DB_LOCK:
            if kind:
                rows = self._conn.execute(
                    "SELECT * FROM docs WHERE kind = ?", (kind,)
                ).fetchall()
            else:
                rows = self._conn.execute("SELECT * FROM docs").fetchall()
        return {str(r["key"]): dict(r) for r in rows}

    # -- retrieval ------------------------------------------------------- #

    def search(
        self,
        query: str,
        kind: str | None = None,
        top_k: int = 8,
        min_score: float = 0.25,
    ) -> list[dict]:
        """Semantic search: ANN cosine over chunks (sqlite-vec, with a numpy
        fallback scan when the ANN table is missing / width-mismatched)."""
        query = (query or "").strip()
        if not query:
            return []
        qvecs = embed_queries([query])
        if not qvecs:
            return []
        q = np.asarray(qvecs[0], dtype=np.float32)
        if q.shape[0] != self._dim:
            return []
        with _DB_LOCK:
            try:
                # sqlite-vec's vec0 requires the LIMIT to apply directly on the
                # knn scan — a JOIN merged before the LIMIT confuses its planner
                # ("A LIMIT or 'k = ?' constraint is required"), so limit the
                # vec0 scan in a plain subquery FIRST, then join meta. The limit
                # must stay a constant (a bound `?` also breaks the planner).
                limit_n = int(top_k) * 4
                if kind:
                    rows = self._conn.execute(
                        f"""
                        SELECT v.rowid AS cid, d.key, d.kind, d.title,
                               d.fetched_at, c.txt, v.dist AS distance
                        FROM (SELECT rowid, distance AS dist, kind, doc_id
                              FROM vec_chunks
                              WHERE kind = ? AND vec MATCH ?
                              ORDER BY distance LIMIT {limit_n}) v
                        JOIN chunks c ON c.id = v.rowid
                        JOIN docs d ON d.id = c.doc_id
                        """,
                        (kind, self._vec_to_blob(q)),
                    ).fetchall()
                else:
                    rows = self._conn.execute(
                        f"""
                        SELECT v.rowid AS cid, d.key, d.kind, d.title,
                               d.fetched_at, c.txt, v.dist AS distance
                        FROM (SELECT rowid, distance AS dist, kind, doc_id
                              FROM vec_chunks
                              WHERE vec MATCH ?
                              ORDER BY distance LIMIT {limit_n}) v
                        JOIN chunks c ON c.id = v.rowid
                        JOIN docs d ON d.id = c.doc_id
                        """,
                        (self._vec_to_blob(q),),
                    ).fetchall()
            except sqlite3.Error as _ann_err:
                logger.warning("vector_store: ANN search failed (%s), falling back to numpy scan", _ann_err)
                rows = self._scan_semantic(q, kind, top_k)
            if not rows:
                try:
                    if kind:
                        chunk_count = self._conn.execute(
                            "SELECT COUNT(*) FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.kind = ?",
                            (kind,),
                        ).fetchone()[0]
                    else:
                        chunk_count = self._conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
                    if chunk_count > 0:
                        rows = self._scan_semantic(q, kind, top_k)
                except sqlite3.Error:
                    pass
        out: list[dict] = []
        for row in rows:
            # cosine = 1 - ||a-b||^2 / 2 for unit vectors (vec0 L2 distance)
            dist = float(row["distance"]) if "distance" in (row.keys() if hasattr(row, "keys") else []) else 0.0
            score = 1.0 - (dist * dist) / 2.0
            if score < min_score:
                continue
            out.append(
                {
                    "key": row["key"],
                    "kind": row["kind"],
                    "title": row["title"],
                    "fetched_at": float(row["fetched_at"]),
                    "text": row["txt"],
                    "score": score,
                    "_chunk_id": int(row["cid"]),
                }
            )
            if len(out) >= top_k:
                break
        return out

    def _scan_semantic(
        self, q: np.ndarray, kind: str | None, top_k: int
    ) -> list[dict]:
        """Numpy cosine fallback (used when the vec0 table is unavailable)."""
        rows = self._conn.execute(
            """
            SELECT c.id AS cid, d.key, d.kind, d.title, d.fetched_at, c.txt, c.vec
            FROM chunks c JOIN docs d ON d.id = c.doc_id
            """
            + (" WHERE d.kind = ?" if kind else ""),
            (kind,) if kind else (),
        ).fetchall()
        scored: list[tuple[float, dict]] = []
        for cid, key, doc_kind, title, fetched_at, txt, blob in rows:
            try:
                vec = self._blob_to_vec(blob)
            except Exception as exc:  # noqa: BLE001 — malformed blob: skip the chunk
                logger.debug("vector_store: skipping malformed chunk %s: %s", cid, exc)
                continue
            if vec is None or vec.shape[0] != q.shape[0]:
                continue
            score = float(np.dot(q, vec))
            scored.append(
                (
                    score,
                    {
                        "cid": int(cid),
                        "key": key,
                        "kind": doc_kind,
                        "title": title,
                        "fetched_at": float(fetched_at),
                        "txt": txt,
                        "text": txt,
                        "score": score,
                    },
                )
            )
        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored[:top_k]]

    def fts_search(
        self,
        query: str,
        kind: str | None = None,
        top_k: int = 8,
        min_rank: float | None = None,
    ) -> list[dict]:
        """Lexical search over FTS5 (exact-word + prefix on the last word).

        Results carry their FTS5 ``bm25`` rank as ``_bm25_rank`` (negative;
        more negative = more relevant). ``min_rank`` filters to hits whose
        rank is at most that value, i.e. ``_bm25_rank <= min_rank``.
        """
        match = _fts_query(query)
        if not match:
            return []
        with _DB_LOCK:
            try:
                if kind:
                    rows = self._conn.execute(
                        """
                        SELECT f.rowid AS cid, d.key, d.kind, d.title,
                               d.fetched_at, f.txt, bm25(fts_chunks) AS rank
                        FROM fts_chunks f
                        JOIN chunks c ON c.id = f.rowid
                        JOIN docs d ON d.id = c.doc_id
                        WHERE f.fts_chunks MATCH ? AND f.kind = ?
                        ORDER BY rank LIMIT ?
                        """,
                        (match, kind, top_k),
                    ).fetchall()
                else:
                    rows = self._conn.execute(
                        """
                        SELECT f.rowid AS cid, d.key, d.kind, d.title,
                               d.fetched_at, f.txt, bm25(fts_chunks) AS rank
                        FROM fts_chunks f
                        JOIN chunks c ON c.id = f.rowid
                        JOIN docs d ON d.id = c.doc_id
                        WHERE f.fts_chunks MATCH ?
                        ORDER BY rank LIMIT ?
                        """,
                        (match, top_k),
                    ).fetchall()
            except sqlite3.Error:
                return []
        out: list[dict] = []
        for row in rows:
            rank = float(row["rank"])
            if min_rank is not None and rank > min_rank:
                continue
            out.append(
                {
                    "key": row["key"],
                    "kind": row["kind"],
                    "title": row["title"],
                    "fetched_at": float(row["fetched_at"]),
                    "text": row["txt"],
                    "score": 0.0,
                    "_bm25_rank": rank,
                    "_chunk_id": int(row["cid"]),
                }
            )
        return out

    def exact_lookup(self, query: str, kind: str | None = None) -> list[dict]:
        """Exact match on file path, symbol name, source url or doc key."""
        query = (query or "").strip()
        if not query:
            return []
        like = f"%{query}%"
        with _DB_LOCK:
            sql = (
                "SELECT * FROM docs WHERE (file_path LIKE ? OR symbol_name LIKE ? "
                "OR source_url LIKE ? OR key LIKE ?)"
            )
            params: list = [like, like, like, like]
            if kind:
                sql += " AND kind = ?"
                params.append(kind)
            rows = self._conn.execute(sql + " LIMIT 25", params).fetchall()
        out = []
        for row in rows:
            d = dict(row)
            d["score"] = 1.0
            d["text"] = ""
            out.append(d)
        return out

    def stats(self) -> dict:
        with _DB_LOCK:
            docs = int(self._conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0])
            chunks = int(self._conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
            by_kind = {
                r[0]: r[1]
                for r in self._conn.execute(
                    "SELECT kind, COUNT(*) FROM docs GROUP BY kind"
                ).fetchall()
            }
        return {"docs": docs, "chunks": chunks, "by_kind": by_kind}

    def evict(self) -> int:
        """Apply caps + TTL: evict least-recently-fetched docs beyond limits and
        expired web/memory docs. Returns how many docs were removed.

        TTL برای همهٔ kindها از config.ttl_days میاد (همون مقداری که
        کاربر تو Settings → ragWebTtlDays تنظیم کرده). پیش‌فرض ۱۸۰ روز.
        """
        removed = 0
        with _DB_LOCK, self._conn:
            # KIND_WEB: TTL از تنظیمات کاربر (ragWebTtlDays)
            web_cutoff = self._now() - self.config.ttl_days * 86400
            rows = self._conn.execute(
                "SELECT id, key FROM docs WHERE kind = ? AND fetched_at < ?",
                (KIND_WEB, web_cutoff),
            ).fetchall()
            for r in rows:
                self._purge_doc_chunks(int(r[0]))
                self._conn.execute("DELETE FROM docs WHERE id = ?", (r[0],))
                removed += 1
            # KIND_MEMORY: TTL از تنظیمات (پیش‌فرض ۱۸۰ روز)
            mem_cutoff = self._now() - self.config.ttl_days * 86400
            rows = self._conn.execute(
                "SELECT id, key FROM docs WHERE kind = ? AND fetched_at < ?",
                (KIND_MEMORY, mem_cutoff),
            ).fetchall()
            for r in rows:
                self._purge_doc_chunks(int(r[0]))
                self._conn.execute("DELETE FROM docs WHERE id = ?", (r[0],))
                removed += 1
            # سقف تعداد برای هر دو نوع
            for kind in (KIND_WEB, KIND_MEMORY):
                over = self._conn.execute(
                    "SELECT id FROM docs WHERE kind = ? ORDER BY fetched_at "
                    "LIMIT -1 OFFSET ?",
                    (kind, self.config.max_docs),
                ).fetchall()
                for r in over:
                    self._purge_doc_chunks(int(r[0]))
                    self._conn.execute("DELETE FROM docs WHERE id = ?", (r[0],))
                    removed += 1
        return removed

    def clear(self) -> None:
        with _DB_LOCK, self._conn:
            self._conn.execute("DELETE FROM fts_chunks")
            try:
                self._conn.execute("DELETE FROM vec_chunks")
            except sqlite3.Error:
                pass
            self._conn.execute("DELETE FROM chunks")
            self._conn.execute("DELETE FROM docs")
