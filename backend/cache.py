"""Simple TTL-backed SQLite result cache for search / web / tool results.

Table::

    cache(key TEXT PRIMARY KEY, value TEXT, created_at REAL, expires_at REAL)

``get(key)`` returns ``None`` when the key is missing or expired (auto-purges
expired entries on read). ``set(key, value, ttl_seconds)`` upserts a record.
``purge_expired()`` does a bulk cleanup. All operations are best-effort: never
raise.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time

_LOCK = threading.RLock()


class Cache:
    """A single SQLite file acting as a TTL-backed key-value cache."""

    def __init__(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._path = path
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS cache ("
            "  key TEXT PRIMARY KEY,"
            "  value TEXT NOT NULL,"
            "  created_at REAL NOT NULL,"
            "  expires_at REAL NOT NULL"
            ")"
        )
        self._conn.commit()

    def get(self, key: str) -> str | None:
        with _LOCK:
            row = self._conn.execute(
                "SELECT value, expires_at FROM cache WHERE key = ?", (key,)
            ).fetchone()
            if not row:
                return None
            if row[1] < time.time():
                self._conn.execute("DELETE FROM cache WHERE key = ?", (key,))
                self._conn.commit()
                return None
            return str(row[0])

    def set(self, key: str, value: str, ttl_seconds: float = 3600.0) -> None:
        now = time.time()
        with _LOCK:
            self._conn.execute(
                "INSERT OR REPLACE INTO cache(key, value, created_at, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (key, value, now, now + ttl_seconds),
            )
            self._conn.commit()

    def purge_expired(self) -> int:
        with _LOCK:
            cur = self._conn.execute("DELETE FROM cache WHERE expires_at < ?", (time.time(),))
            self._conn.commit()
            return cur.rowcount

    def close(self) -> None:
        with _LOCK:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass


def cache_path_for(data_root: str) -> str:
    return os.path.join(data_root, "cache.sqlite")