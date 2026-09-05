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
    vacuum_threshold_mb: int = 64,
) -> dict:
    """Run the full cleanup pass and return a human-readable report.

    ``store`` may be None (caller couldn't open it) — the report then says so
    instead of raising.
    """
    report: dict = {"evicted": 0, "pruned_files": 0, "vacuumed": False}

    if store is not None:
        try:
            report["evicted"] = int(store.evict() or 0)
        except Exception:  # noqa: BLE001, S110 — best-effort, never raises
            pass
        if root:
            report["pruned_files"] = _prune_missing_files(store, root)

    # Expired entries in the tool-result cache (cache.sqlite). Lazy purge on
    # read only removes keys that are read again; entries never re-read would
    # otherwise keep the file growing forever. Best-effort like every step.
    report["cache_purged"] = _purge_result_cache()

    # VACUUM only when the DB is meaningfully large and something was removed,
    # so we never pay the full-rewrite cost on tiny or untouched stores. The
    # store exposes ``vacuum()`` as the public API; reaching into the private
    # ``_conn`` would race with concurrent writers inside the store.
    if store is not None and (report["evicted"] or report["pruned_files"]):
        try:
            db_file = getattr(store, "db_path", "") or ""
            if (
                db_file
                and os.path.isfile(db_file)
                and os.path.getsize(db_file) / (1024 * 1024) >= vacuum_threshold_mb
                and store.vacuum()
            ):
                report["vacuumed"] = True
        except Exception:  # noqa: BLE001, S110 — best-effort, never raises
            pass
    return report


def _purge_result_cache() -> int:
    """Purge expired entries from the tool-result cache (cache.sqlite).

    Returns the number of rows removed; 0 on any failure (missing data root,
    locked DB, …). Never raises — mirrors the best-effort contract of
    ``run_cleanup``.
    """
    try:
        import state_db
        from cache import Cache, cache_path_for

        c = Cache(cache_path_for(state_db.data_root()))
        try:
            return int(c.purge_expired() or 0)
        finally:
            c.close()
    except Exception:  # noqa: BLE001 — best-effort, never raises
        return 0
