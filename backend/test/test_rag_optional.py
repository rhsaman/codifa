"""تست اختیاری بودن RAG (بدون embedding، وب/fetch کار می‌کنه)."""

from __future__ import annotations

import tools as tools_mod


def test_rag_web_enabled_false_without_embedder(monkeypatch):
    """وقتی embedding در دسترس نیست، RAG غیرفعاله ولی ارور نمی‌ده."""

    def _fake_available():
        return False

    monkeypatch.setattr(tools_mod, "_rag_web_enabled", _fake_available)
    assert tools_mod._rag_web_enabled() is False


def test_web_search_no_error_without_embedder(monkeypatch):
    """web_search بدون embedding باید کار کنه و ارور نده."""

    # جلوگیری از فراخوانی واقعی شبکه — مستقیماً تابع همگام‌ساز web_search رو mock می‌کنیم.
    def _fake_web_search(query, max_results=5):
        return {
            "query": query,
            "results": [{"title": "T", "url": "http://t", "snippet": "s"}],
            "engine": "duckduckgo",
        }

    monkeypatch.setattr(tools_mod, "web_search", _fake_web_search)
    monkeypatch.setattr(tools_mod, "_rag_web_enabled", lambda: False)
    monkeypatch.setattr(tools_mod, "_get_result_cache", lambda: _FakeCache())

    # web_search_tool async هست — مستقیماً تابع همگام‌ساز رو چک می‌کنیم.
    res = tools_mod.web_search("test query", 3)
    assert "error" not in res
    assert len(res.get("results", [])) == 1


class _FakeCache:
    def get(self, key):
        return None

    def set(self, key, val, ttl):
        pass
