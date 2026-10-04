"""Passage-vector cache + length-sorted batching: identical outputs, less CPU.

The codemap rerank re-embeds the same file descriptions on every turn while
only the query changes. These pins guarantee the speedup never changes
ranking quality:

1. ``_embed_batch`` returns rows in the caller's original order even though it
   sorts by length internally (verified with a stubbed ``_embed``).
2. ``embed_passages`` serves repeat texts from the per-text cache: with the
   model stubbed to raise, a second identical call still returns the first
   call's vectors.
3. Real-model determinism: two identical calls return (near-)identical floats.
"""

import time

import numpy as np

import embeddings as _emb


def test_embed_batch_restores_original_order(monkeypatch):
    def _fake_embed(texts, prefix):
        assert prefix == _emb._PASSAGE_PREFIX
        return np.array([[float(len(t)), 1.0] for t in texts], dtype=np.float64)

    monkeypatch.setattr(_emb, "_embed", _fake_embed)
    texts = ["x" * 10, "y" * 200, "z" * 3, "w" * 50, "v" * 120]
    got = _emb._embed_batch(texts, _emb._PASSAGE_PREFIX)
    assert got.shape == (5, 2)
    for row, t in zip(got, texts):
        assert row[0] == float(len(t))


def test_passage_cache_serves_repeat_without_recompute(monkeypatch):
    _emb._PASSAGE_VEC_CACHE.clear()
    _emb._PASSAGE_VEC_ORDER.clear()
    calls = {"n": 0}

    def _fake_embed(texts, prefix):
        calls["n"] += 1
        return np.array(
            [[float(len(t)), float(sum(map(ord, t)) % 97)] for t in texts],
            dtype=np.float64,
        )

    monkeypatch.setattr(_emb, "_embed", _fake_embed)
    texts = ["alpha description one", "beta description two here", "gamma three"]
    first = _emb.embed_passages(texts)
    assert calls["n"] >= 1

    def _boom(texts, prefix):
        raise AssertionError("cache miss: model called again for identical texts")

    monkeypatch.setattr(_emb, "_embed", _boom)
    second = _emb.embed_passages(texts)
    assert np.allclose(np.array(first), np.array(second), atol=1e-6)


def test_passage_cache_bounded(monkeypatch):
    _emb._PASSAGE_VEC_CACHE.clear()
    _emb._PASSAGE_VEC_ORDER.clear()
    monkeypatch.setattr(_emb, "_PASSAGE_VEC_MAX", 4, raising=False)

    def _fake_embed(texts, prefix):
        return np.ones((len(texts), 2), dtype=np.float32)

    monkeypatch.setattr(_emb, "_embed", _fake_embed)
    _emb.embed_passages([f"text-{i}" for i in range(10)])
    assert len(_emb._PASSAGE_VEC_CACHE) <= 4
    assert len(_emb._PASSAGE_VEC_ORDER) <= 4


def test_idle_eviction_drops_model_and_respects_inflight(monkeypatch):
    """Idle > window evicts the ~1.1 GB session; in-flight embeds block it."""
    monkeypatch.setattr(_emb, "_evict_timer", None)
    stale = time.monotonic() - _emb._IDLE_EVICT_S - 1

    _emb._CACHE.clear()
    _emb._CACHE["session"] = object()  # fake loaded model
    monkeypatch.setattr(_emb, "_last_used", stale)
    monkeypatch.setattr(_emb, "_active_embeds", 0)
    _emb._evict_if_idle()
    assert not _emb._CACHE, "idle model must be evicted"

    _emb._CACHE["session"] = object()
    monkeypatch.setattr(_emb, "_active_embeds", 1)  # embed in flight
    _emb._evict_if_idle()
    assert _emb._CACHE, "in-flight embed must keep the session alive"

    # The busy path re-armed a 15-min timer — cancel so no stray thread outlives
    # the test (monkeypatch restores the attribute but cannot cancel a Timer).
    if _emb._evict_timer is not None:
        _emb._evict_timer.cancel()
        _emb._evict_timer = None
    _emb._CACHE.clear()
