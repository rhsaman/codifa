"""تست نشت حافظه: VectorStore connectionهای sqlite + sqlite_vec که توی
web_search_tool / fetch_url_tool / _rag_web_lookup باز می‌شن باید بعد از
استفاده بسته بشن (با try/finally) — وگرنه توی RAM می‌مونن تا آخر عمر پروسه
و سایدکار اواسط ترن OOM می‌شه.

موارد:
- وقتی _rag_web_lookup خودش store رو باز می‌کنه (store=None)، حتماً close()
  صدا زده می‌شه.
- وقتی store از بیرون پاس داده می‌شه، _rag_web_lookup نباید ببنده‌ش (مالکیت
  با فراخواننده‌ست).
- web_search_tool / fetch_url_tool وقتی خودشون _get_web_store رو صدا زدن،
  connection رو می‌بندن.
"""

import asyncio
from unittest.mock import MagicMock

import tools as tools_mod
from vector_store import KIND_WEB


def _make_store_with_hits(hits):
    store = MagicMock()
    store.search.return_value = hits
    return store


def _build_tools_with(store, enabled=True):
    captured = {}

    def _emit(event):
        captured.setdefault("events", []).append(event)

    tools = tools_mod.make_tool_callbacks(
        root="/tmp",
        emit=_emit,
        store=store,
        chat_id="test",
    )
    return tools, captured


def test_rag_web_lookup_closes_store_it_opened(monkeypatch):
    """وقتی store=None باشه و _rag_web_enabled() True باشه، _rag_web_lookup
    خودش _get_web_store رو صدا می‌زنه و باید close() رو صدا بزنه."""
    hits = [{"txt": "saved web result about X"}]
    opened = _make_store_with_hits(hits)
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    # _get_web_store رو جایگزین می‌کنیم تا store باز‌شده رو برگردونه.
    monkeypatch.setattr(tools_mod, "_get_web_store", lambda root: opened)

    out = asyncio.run(tools_mod._rag_web_lookup("query about X", None, "/tmp"))
    assert out == "saved web result about X"
    opened.search.assert_called_once_with("query about X", KIND_WEB, 3, 0.6)
    # نشت حافظه: connection باید بسته شده باشه.
    opened.close.assert_called_once()


def test_rag_web_lookup_does_not_close_external_store(monkeypatch):
    """وقتی store از بیرون پاس داده می‌شه، نباید بسته بشه (مالکیت با فراخواننده)."""
    hits = [{"txt": "saved web result about X"}]
    external = _make_store_with_hits(hits)
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)

    out = asyncio.run(tools_mod._rag_web_lookup("query about X", external, "/tmp"))
    assert out == "saved web result about X"
    external.close.assert_not_called()


def test_rag_web_lookup_closes_on_empty_hits(monkeypatch):
    """حتی وقتی هیتی پیدا نشد، connection باز‌شده باید بسته بشه."""
    opened = _make_store_with_hits([])
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_web_store", lambda root: opened)

    out = asyncio.run(tools_mod._rag_web_lookup("anything", None, "/tmp"))
    assert out is None
    opened.close.assert_called_once()


def test_web_search_tool_closes_store_it_opened(monkeypatch):
    """وقتی RAG فعاله و store=None، web_search_tool باید connection رو ببنده."""
    store = _make_store_with_hits([{"txt": "cached web answer"}])
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    monkeypatch.setattr(tools_mod, "web_search", lambda q, mr=5: {"error": "should not be called"})
    monkeypatch.setattr(tools_mod, "open_vector_store", lambda *a, **k: store)
    # _get_web_store رو جایگزین می‌کنیم (چون open_vector_store داخلش صدا زده می‌شه).
    monkeypatch.setattr(tools_mod, "_get_web_store", lambda root: store)

    async def patched(key, store=None, root=""):
        if store is None or not tools_mod._rag_web_enabled():
            return None
        h = store.search(key, KIND_WEB, top_k=3, min_score=0.6)
        return "\n\n".join(x["txt"] for x in h if x.get("txt")) if h else None

    monkeypatch.setattr(tools_mod, "_rag_web_lookup", patched)

    tools, _ = _build_tools_with(None)
    out = asyncio.run(tools["web_search"](query="python asyncio"))
    assert "from saved RAG" in out
    store.close.assert_called()


def test_fetch_url_tool_closes_store_it_opened(monkeypatch):
    """وقتی RAG فعاله و store=None، fetch_url_tool باید connection رو ببنده."""
    store = _make_store_with_hits([{"txt": "cached page body"}])
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: True)
    monkeypatch.setattr(tools_mod, "fetch_url", lambda u, mc=100000: {"error": "should not be called"})
    monkeypatch.setattr(tools_mod, "open_vector_store", lambda *a, **k: store)
    monkeypatch.setattr(tools_mod, "_get_web_store", lambda root: store)

    async def patched(key, store=None, root=""):
        if store is None or not tools_mod._rag_web_enabled():
            return None
        h = store.search(key, KIND_WEB, top_k=3, min_score=0.6)
        return "\n\n".join(x["txt"] for x in h if x.get("txt")) if h else None

    monkeypatch.setattr(tools_mod, "_rag_web_lookup", patched)

    tools, _ = _build_tools_with(None)
    out = asyncio.run(tools["fetch_url"](url="https://example.com/page"))
    assert "from saved RAG" in out
    store.close.assert_called()
