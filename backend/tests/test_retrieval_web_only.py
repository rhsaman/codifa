"""تست محدود کردن RAG فقط به وب/fetch (KIND_WEB)."""

from __future__ import annotations

from unittest.mock import patch

import embeddings
from context_builder import build_context
from retrieval import RetrievalSettings, retrieve
from vector_store import KIND_WEB, VectorStore


def _zero_vecs(texts):
    # به ازای هر متن، یه بردار صفر برمی‌گردونه (طول لیست باید با تعداد متن‌ها یکی باشه)
    return [[0.0] * 768 for _ in texts]


def _make_store(tmp_path) -> VectorStore:
    # upsert_doc واقعاً embed می‌کنه؛ چون توی محیط تست embedding نداریم،
    # embeddings رو mock می‌کنیم تا store بتونه سند وب رو ذخیره کنه.
    # vector_store.py از `from embeddings import embed_passages` استفاده می‌کنه
    # (نام مستقیم)، پس باید روی vector_store.embed_passages پچ بزنیم.
    # نکته: side_effect لیستی به اندازه‌ی تعداد متن‌ها برمی‌گردونه (نه فقط یک بردار).
    # همچنین embedder_available رو False می‌کنیم تا retrieve فقط FTS بزنه
    # (رفتار واقعی وقتی embedding دانلود نشده — RAG اختیاری).
    # پاک کردن _CACHE قبل از with (تا ایزوله بمونه از تست‌های قبلی).
    embeddings._CACHE.clear()
    with patch("vector_store.embed_passages", side_effect=_zero_vecs), patch(
        "vector_store.embed_queries", side_effect=_zero_vecs
    ), patch("vector_store.embed_dim", return_value=768), patch(
        "embeddings.embedder_available", lambda: False
    ), patch("embeddings.is_available", lambda: False):
        store = VectorStore(str(tmp_path / "v.sqlite"), "ws")
        # فقط سند وب (فایل‌ها دیگه توی RAG ایندکس نمی‌شن)
        store.upsert_doc("web:http://x", KIND_WEB, "X", ["some web page"], {"source_url": "http://x"})
    return store


def test_retrieve_kinds_web_only(tmp_path):
    store = _make_store(tmp_path)
    hits = retrieve(store, "web page", kinds=(KIND_WEB,))
    assert all(h.kind == KIND_WEB for h in hits)


def test_build_context_includes_web_kind(tmp_path):
    store = _make_store(tmp_path)
    settings = RetrievalSettings(
        include_files=False, include_web=True, include_memory=False, auto_recall=True
    )
    from retrieval import retrieve
    hits = retrieve(store, "web page", kinds=(KIND_WEB,))
    block = build_context(store, "web page", settings, kinds=(KIND_WEB,))
    assert "web" in block.lower() or "http://x" in block, f"block empty; hits={len(hits)}"
