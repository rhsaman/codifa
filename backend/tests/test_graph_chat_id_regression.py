"""Regression tests for chat_id plumbing in graph helpers.

Old bug: ``_vision_analyze`` and ``_summarize_history_head`` referenced an
undefined ``state`` variable when building the ``chat_id`` for ``llm_generate``.
The ``NameError`` was swallowed by the surrounding ``try/except`` so vision
analysis silently returned ``None`` and history summarization silently fell
back to "[history omitted by historyLimit]". These tests lock the fixed
behavior: both helpers accept ``chat_id`` explicitly and forward it.
"""

import graph


async def test_vision_analyze_forwards_chat_id(monkeypatch):
    graph._VISION_CACHE.clear()
    seen = {}

    async def _fake_llm_generate(
        model, *, system="", user="", images=None, sub=False, chat_id=""
    ):
        seen["chat_id"] = chat_id
        return ("analysis text", None)

    monkeypatch.setattr("llm.llm_generate", _fake_llm_generate)
    monkeypatch.setattr("graph.llm_generate", _fake_llm_generate)

    result = await graph._vision_analyze(
        object(), ["data:image/png;base64,AAAA"], "chat-123"
    )
    assert result == "analysis text"
    assert seen["chat_id"] == "chat-123"
    graph._VISION_CACHE.clear()


async def test_summarize_history_head_forwards_chat_id(monkeypatch):
    graph._HISTORY_SUMMARY_CACHE.clear()
    seen = {}

    async def _fake_llm_generate(model, *, system="", user="", chat_id=""):
        seen["chat_id"] = chat_id
        return ("[Compacted earlier context]\nsummary", None)

    monkeypatch.setattr("llm.llm_generate", _fake_llm_generate)
    monkeypatch.setattr("graph.llm_generate", _fake_llm_generate)

    older = [{"role": "user", "content": "hello"}]
    summary = await graph._summarize_history_head(
        object(), older, "test-root", "chat-456"
    )
    assert summary.startswith("[Compacted earlier context]")
    assert "summary" in summary
    assert seen["chat_id"] == "chat-456"
    graph._HISTORY_SUMMARY_CACHE.clear()
