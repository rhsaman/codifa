"""Laya tool-call gaps: precheck wiring, step-call ranking, trace visibility."""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-laya-toolcall-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import laya_decide
import trace_store


def _handled(value, confidence=0.9, kind="choice"):
    return laya_decide.LayaDecision(
        handled=True, kind=kind, value=value, confidence=confidence,
        abstained=False, reason="local-decision",
        usage={"kind": "usage", "provider_id": "local"},
        provider_id="local", model="test-repo",
    )


def _abstained(kind="choice"):
    return laya_decide.LayaDecision(
        handled=False, kind=kind, value=None, confidence=0.2,
        abstained=True, reason="abstained",
        usage=None, provider_id="local", model="",
    )


def test_precheck_reports_trace_and_returns_local(monkeypatch):
    """precheck با handle_locally: دیکشنری + ردیف laya در trace."""
    import agents

    monkeypatch.setattr(
        laya_decide, "decide",
        lambda state, question, *a, **k: _handled("handle_locally"),
    )
    trace_store.clear("chat-precheck")
    out = agents.laya_precheck("hello", "ask", 0, chat_id="chat-precheck", emit=lambda ev: None)
    assert isinstance(out, dict) and out.get("handled") is True
    rows = trace_store.list_traces("chat-precheck", "laya")
    assert len(rows) == 1
    assert rows[0]["detail"].get("sub") == "precheck"


def test_precheck_fallback_returns_none_but_still_traces(monkeypatch):
    """واگذاری precheck: None ولی trace ثبت می‌شود."""
    import agents

    monkeypatch.setattr(
        laya_decide, "decide",
        lambda state, question, *a, **k: _abstained(),
    )
    trace_store.clear("chat-precheck-fb")
    out = agents.laya_precheck("hello", "ask", 0, chat_id="chat-precheck-fb", emit=lambda ev: None)
    assert out is None
    rows = trace_store.list_traces("chat-precheck-fb", "laya")
    assert len(rows) == 1


def test_rank_step_calls_reorders_and_never_raises(monkeypatch):
    """مرتب‌سازی بچ: سیگنال laya ترتیب را عوض می‌کند؛ بدون سیگنال همان ترتیب."""
    from tool_batching import _rank_step_calls

    monkeypatch.setattr(
        laya_decide, "rank",
        lambda text, cands, top_k=5, instructions="": [
            {"name": "b", "confidence": 0.9, "score": 2.0, "reason": "keyword-rank"},
            {"name": "a", "confidence": 0.3, "score": 1.0, "reason": "keyword-rank"},
        ],
    )
    calls = [{"name": "a", "args": {}, "id": "1"}, {"name": "b", "args": {}, "id": "2"}]
    ordered = _rank_step_calls(calls, "query")
    assert [c["name"] for c in ordered] == ["b", "a"]

    monkeypatch.setattr(laya_decide, "rank", lambda *a, **k: [])
    assert _rank_step_calls(calls, "query") == calls
    monkeypatch.setattr(laya_decide, "rank", lambda *a, **k: 1 / 0)
    assert _rank_step_calls(calls, "query") == calls


def test_execute_readonly_calls_preserves_input_order(monkeypatch):
    """با وجود reorder داخلی، خروجی به ترتیب ورودی برمی‌گردد."""
    from tool_batching import execute_readonly_calls

    monkeypatch.setattr(
        laya_decide, "rank",
        lambda text, cands, top_k=5, instructions="": list(reversed(cands)),
    )

    async def _execute(call):
        await asyncio.sleep(0)
        return f"res:{call['id']}"

    calls = [{"name": "a", "args": {}, "id": "1"}, {"name": "b", "args": {}, "id": "2"}]
    out = asyncio.run(execute_readonly_calls(calls, _execute, query="q"))
    assert out == ["res:1", "res:2"]


def test_rank_candidates_logs_trace(monkeypatch):
    """_rank_candidates موفق: ردیف laya در trace."""
    import graph

    monkeypatch.setattr(
        laya_decide, "rank",
        lambda text, cands, top_k=5, instructions="": [
            {"name": "x", "confidence": 0.7, "score": 1.0, "reason": "keyword-rank"},
        ],
    )
    trace_store.clear("chat-rank")
    out = graph._rank_candidates(
        "q", [{"name": "x"}], 1,
        chat_id="chat-rank", emit=lambda ev: None, sub="rank", route="normal", prompt="q",
    )
    assert out and out[0]["name"] == "x"
    rows = trace_store.list_traces("chat-rank", "laya")
    assert len(rows) == 1
