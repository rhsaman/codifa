"""Cache & cleanup for the RAG layer.

Keeps the per-workspace vector store and the memory store healthy without any
manual maintenance:

* **TTL / caps** — ``store.evict()`` drops expired web/memory docs and applies
  the ``max_docs`` / ``max_chunks`` caps (least-recently-fetched first).
* **Stale file index** — removes ``kind=file`` docs whose underlying file no
  longer exists (deleted / moved out of the workspace). The incremental
  indexer also does this on every run; this is the standalone entry point.
* **Expired memory notes** — ``MemoryManager.purge_expired()`` removes notes
  past their TTL from both the JSON store and its FTS index.
* **Vacuum** — after a big purge, ``VACUUM`` reclaims space so long-lived
  workspaces don't grow without bound.

Everything is best-effort and never raises: a locked DB or a missing store
just yields a report of what *couldn't* be cleaned rather than crashing the
caller (server endpoint, startup hook, …).
"""

from __future__ import annotations

import os

from vector_store import KIND_FILE, VectorStore


def _prune_missing_files(store: VectorStore, root: str) -> int:
    """Remove ``file`` docs whose file is gone from the workspace. Returns the
    number of docs removed."""
    removed = 0
    try:
        meta = store.all_doc_meta(KIND_FILE)
    except Exception:  # noqa: BLE001
        return 0
    if not meta:
        return 0
    for key, info in meta.items():
        rel = str(info.get("file_path") or "")
        if not rel:
            continue
        # Keys are "file:<relpath>"; file_path is the relpath itself.
        try:
            full = os.path.realpath(os.path.join(root, rel))
            inside = full == os.path.realpath(root) or full.startswith(
                os.path.realpath(root) + os.sep
            )
            if (not inside or not os.path.isfile(full)) and store.remove(key):
                removed += 1
        except Exception:  # noqa: BLE001, S112 — best-effort prune
            continue
    return removed


def run_cleanup(
    store: VectorStore | None,
    root: str = "",
    memory_manager: object | None = None,
    vacuum_threshold_mb: int = 64,
) -> dict:
    """Run the full cleanup pass and return a human-readable report.

    ``store`` may be None (caller couldn't open it) — the report then says so
    instead of raising. ``memory_manager`` is a ``MemoryManager`` (or anything
    with ``purge_expired()``) and is optional.
    """
    report: dict = {"evicted": 0, "pruned_files": 0, "expired_notes": 0, "vacuumed": False}

    if store is not None:
        try:
            report["evicted"] = int(store.evict() or 0)
        except Exception:  # noqa: BLE001, S110 — best-effort, never raises
            pass
        if root:
            report["pruned_files"] = _prune_missing_files(store, root)

    if memory_manager is not None:
        try:
            report["expired_notes"] = int(memory_manager.purge_expired() or 0)
        except Exception:  # noqa: BLE001, S110 — best-effort, never raises
            pass

    # VACUUM only when the DB is meaningfully large and something was removed,
    # so we never pay the full-rewrite cost on tiny or untouched stores.
    if store is not None and (report["evicted"] or report["pruned_files"]):
        try:
            db_file = getattr(store, "_db_path", "") or ""
            if db_file and os.path.isfile(db_file):
                size_mb = os.path.getsize(db_file) / (1024 * 1024)
                if size_mb >= vacuum_threshold_mb:
                    store._conn.execute("VACUUM")
                    report["vacuumed"] = True
        except Exception:  # noqa: BLE001, S110 — best-effort, never raises
            pass
    return report
