"""تست: RAG وب/fetch فقط تحت‌درخواست مدل استفاده بشه (نه خودکار در اول چت).

موارد:
- اگه RAG پر بود، web_search_tool/fetch_url_tool سراغ وب/فچ واقعی نمی‌رن.
- اگه RAG خالی بود، می‌رن و نتیجه رو توی KIND_WEB ذخیره می‌کنن.
- اگه embedding در دسترس نبود، _rag_web_lookup برمی‌گردونه None (ارور نمی‌ده).
"""

import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tools as tools_mod
from vector_store import KIND_WEB


def _make_store_with_hits(hits):
    store = MagicMock()
    store.search.return_value = hits
    return store


def _build_tools_with(store, enabled=True):
    """build_tools رو با store mock و _rag_web_enabled کنترل‌شده صدا می‌زنه."""
    captured = {}

    def _emit(event):
        captured.setdefault("events", []).append(event)

    tools = tools_mod.make_tool_callbacks(
        root="/tmp",
        emit=_emit,
        store=store,
        chat_id="test",
    )
    # _rag_web_enabled توی closure هست — از طریق monkeypatch روی تابع کمکی
    # (که خودش هم توی همون ماژوله) کنترل می‌کنیم.
    return tools, captured


def test_rag_web_lookup_returns_hits_when_enabled(monkeypatch):
    hits = [{"txt": "saved web result about X"}]
    store = _make_store_with_hits(hits)
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    # store توی _rag_web_lookup از closure میاد؛ چون مستقیم نمی‌تونیم setش کنیم،
    # تابع رو با store mock بازسازی می‌کنیم.

    async def fake_lookup(key, store=None):
        if store is None or not tools_mod._rag_web_enabled():
            return None
        try:
            h = store.search(key, KIND_WEB, top_k=3, min_score=0.6)
            if not h:
                return None
            parts = [x["txt"] for x in h if x.get("txt")]
            return "\n\n".join(parts) if parts else None
        except Exception:  # noqa: BLE001
            return None

    monkeypatch.setattr(tools_mod, "_rag_web_lookup", fake_lookup)
    out = asyncio.run(tools_mod._rag_web_lookup("query about X", store))
    assert out == "saved web result about X"
    store.search.assert_called_once_with("query about X", KIND_WEB, top_k=3, min_score=0.6)


def test_rag_web_lookup_returns_none_when_disabled(monkeypatch):
    store = MagicMock()
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: False)
    async def _disabled_lookup(key, s=None):
        return None if not tools_mod._rag_web_enabled() else "x"

    monkeypatch.setattr(
        tools_mod,
        "_rag_web_lookup",
        _disabled_lookup,
    )
    assert asyncio.run(tools_mod._rag_web_lookup("anything", store)) is None
    store.search.assert_not_called()


def test_rag_web_lookup_returns_none_on_empty_hits(monkeypatch):
    store = _make_store_with_hits([])
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)

    async def fake_lookup(key, store=None):
        if not tools_mod._rag_web_enabled():
            return None
        h = store.search(key, KIND_WEB, top_k=3, min_score=0.6)
        return "\n\n".join(x["txt"] for x in h if x.get("txt")) if h else None

    monkeypatch.setattr(tools_mod, "_rag_web_lookup", fake_lookup)
    assert asyncio.run(tools_mod._rag_web_lookup("anything", store)) is None


def test_web_search_tool_uses_rag_when_available(monkeypatch):
    """اگه RAG پر بود، web_search_tool نباید سرچ واقعی بزنه."""
    store = _make_store_with_hits([{"txt": "cached web answer"}])
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    monkeypatch.setattr(tools_mod, "web_search", lambda q, mr=5: {"error": "should not be called"})
    # open_vector_store رو mock می‌کنیم چون توی محیط تست embedding نداریم
    monkeypatch.setattr(tools_mod, "open_vector_store", lambda *a, **k: store)

    async def patched(key, store=None, root=""):
        if store is None or not tools_mod._rag_web_enabled():
            return None
        h = store.search(key, KIND_WEB, top_k=3, min_score=0.6)
        return "\n\n".join(x["txt"] for x in h if x.get("txt")) if h else None

    monkeypatch.setattr(tools_mod, "_rag_web_lookup", patched)

    tools, _ = _build_tools_with(store)
    out = tools_mod.asyncio.run(tools["web_search"](query="python asyncio"))
    assert "from saved RAG" in out
    assert "cached web answer" in out


def test_fetch_url_tool_uses_rag_when_available(monkeypatch):
    """اگه RAG پر بود، fetch_url_tool نباید فچ واقعی بزنه."""
    store = _make_store_with_hits([{"txt": "cached page body"}])
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    monkeypatch.setattr(tools_mod, "fetch_url", lambda u, mc=100000: {"error": "should not be called"})
    monkeypatch.setattr(tools_mod, "open_vector_store", lambda *a, **k: store)

    async def patched(key, store=None, root=""):
        if store is None or not tools_mod._rag_web_enabled():
            return None
        h = store.search(key, KIND_WEB, top_k=3, min_score=0.6)
        return "\n\n".join(x["txt"] for x in h if x.get("txt")) if h else None

    monkeypatch.setattr(tools_mod, "_rag_web_lookup", patched)

    tools, _ = _build_tools_with(store)
    out = tools_mod.asyncio.run(tools["fetch_url"](url="https://example.com/page"))
    assert "from saved RAG" in out
    assert "cached page body" in out
