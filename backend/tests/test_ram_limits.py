"""RAM limits: lightweight embedder checks, DB-stored dim, shared web store."""

from __future__ import annotations

import os
import sqlite3

import embeddings as emb_mod
import symbol_index as sym_mod
import tools as tools_mod


def test_is_available_does_not_load_model(monkeypatch):
    """is_available checks files only and never loads the session."""
    called = {"load": False}

    def _boom():
        called["load"] = True
        raise AssertionError("model must not load on availability check")

    monkeypatch.setattr(emb_mod, "_load", _boom)
    monkeypatch.setattr(emb_mod, "model_dir", lambda: "/tmp/fake-model")
    assert emb_mod.is_available() is True
    monkeypatch.setattr(emb_mod, "model_dir", lambda: "")
    assert emb_mod.is_available() is False
    # Direct proof: is_available never touched _load (would have raised).
    assert called["load"] is False


def test_embed_dim_does_not_load_model(monkeypatch):
    def _boom():
        raise AssertionError("embed_dim must not load the model")

    monkeypatch.setattr(emb_mod, "_load", _boom)
    emb_mod._CACHE.pop("dim", None)
    assert emb_mod.embed_dim() == 768
    emb_mod._CACHE["dim"] = 512
    try:
        assert emb_mod.embed_dim() == 512
    finally:
        emb_mod._CACHE.pop("dim", None)


def test_vector_store_reads_dim_from_db_meta(monkeypatch, tmp_path):
    """Opening a store with stored vec_dim must not call embed_dim loader."""
    db = str(tmp_path / "w.vectors.sqlite")
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    conn.execute("INSERT INTO meta(k, v) VALUES ('vec_dim', '256')")
    conn.commit()
    conn.close()

    def _boom():
        raise AssertionError("VectorStore open must not wake the model")

    monkeypatch.setattr(emb_mod, "embed_dim", _boom)
    from vector_store import VectorStore

    store = VectorStore(db)
    try:
        assert store._dim == 256
    finally:
        store.close()


def test_web_store_is_shared(monkeypatch, tmp_path):
    """Repeated _get_web_store calls reuse one sqlite connection."""
    monkeypatch.setattr(tools_mod._state_db, "vector_db_dir", lambda: str(tmp_path))
    monkeypatch.setattr(tools_mod._state_db, "get_settings", dict)
    tools_mod.close_web_store()
    try:
        first = tools_mod._get_web_store("/tmp/root-a")
        second = tools_mod._get_web_store("/tmp/root-b")
        assert first is not None and first is second
    finally:
        tools_mod.close_web_store()


def test_symbol_cache_bounded_and_scoped(tmp_path, monkeypatch):
    """Per-root clear drops only that project; range cache stays bounded."""
    sym_mod._FILE_CACHE.clear()
    sym_mod._CACHE.clear()
    sym_mod._SYMBOL_RANGE_CACHE.clear()
    try:
        sym_mod._FILE_CACHE["/proj-a/f.py"] = (1, 1, [], [])
        sym_mod._CACHE["/proj-a/f.py"] = (0.0, [], (0, 0, 0))
        sym_mod._SYMBOL_RANGE_CACHE["/proj-a/f.py"] = (0.0, {}, {})
        sym_mod._FILE_CACHE["/proj-b/g.py"] = (1, 1, [], [])
        sym_mod.clear_symbol_cache("/proj-a")
        assert "/proj-a/f.py" not in sym_mod._FILE_CACHE
        assert "/proj-a/f.py" not in sym_mod._SYMBOL_RANGE_CACHE
        assert "/proj-b/g.py" in sym_mod._FILE_CACHE
        # Bound: range cache evicts oldest-first once over the cap.
        monkeypatch.setattr(sym_mod, "_SYMBOL_RANGE_CACHE_MAX_FILES", 3)
        sym_mod._SYMBOL_RANGE_CACHE.clear()
        paths = []
        for i in range(5):
            p = tmp_path / f"f{i}.py"
            p.write_text(f"def fn{i}():\n    pass\n", encoding="utf-8")
            paths.append(str(p))
        for p in paths:
            sym_mod.get_symbol_ranges(p)
        assert len(sym_mod._SYMBOL_RANGE_CACHE) <= 3
        # get_symbol_ranges on a missing file returns {} without growing cache.
        before = len(sym_mod._SYMBOL_RANGE_CACHE)
        assert sym_mod.get_symbol_ranges(os.path.join("/definitely", "missing.py")) == {}
        assert len(sym_mod._SYMBOL_RANGE_CACHE) == before
    finally:
        sym_mod._FILE_CACHE.clear()
        sym_mod._CACHE.clear()
        sym_mod._SYMBOL_RANGE_CACHE.clear()
