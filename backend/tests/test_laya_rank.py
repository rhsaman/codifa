"""Generic ranking via laya_decide.rank without domain hard-coding."""

import asyncio
import json
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-laya-rank-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import laya_decide


def test_rank_orders_by_relevance():
    ranked = laya_decide.rank(
        "design landing page with pricing",
        [
            {"name": "landing-page-design", "description": "landing pages and pricing"},
            {"name": "git-workflow", "description": "git branches and commits"},
        ],
        top_k=2,
    )
    assert len(ranked) == 2
    assert ranked[0]["name"] == "landing-page-design"
    assert ranked[0]["confidence"] >= ranked[1]["confidence"]
    assert set(ranked[0]) >= {"name", "confidence", "score", "reason"}


def test_rank_empty_means_no_signal():
    assert laya_decide.rank("some text", []) == []
    assert laya_decide.rank("", [{"name": "a"}]) == []
    assert laya_decide.rank("text", [{"name": ""}]) == []


def test_rank_top_k_limits_results():
    cands = [{"name": f"skill-{i}", "description": "common task helper"} for i in range(6)]
    ranked = laya_decide.rank("common task", cands, top_k=2)
    assert len(ranked) <= 2


def test_rank_never_raises():
    assert laya_decide.rank(None, None) == []
    assert laya_decide.rank("text", "not-a-list") == []


def test_describe_tools_extracts_names():
    from types import SimpleNamespace

    import mcp_bridge

    tools = [
        SimpleNamespace(name="browser_navigate", description="open a url in browser"),
        SimpleNamespace(name="", description="empty skipped"),
    ]
    described = mcp_bridge.describe_tools(tools)
    assert described == [
        {"name": "browser_navigate", "description": "open a url in browser"}
    ]
    assert mcp_bridge.describe_tools(None) == []


def test_rank_candidates_falls_back_to_empty():
    import graph

    out = graph._rank_candidates("hello", [], 5)
    assert out == []
    out2 = graph._rank_candidates(
        "design work", [{"name": "a", "description": "design stuff"}], 5
    )
    assert isinstance(out2, list)


def test_laya_tool_rank_operation(monkeypatch):
    from tools import make_tool_callbacks

    monkeypatch.setattr(
        laya_decide,
        "rank",
        lambda text, cands, top_k=5, instructions="": [
            {"name": "label-a", "confidence": 0.8, "score": 0.8, "reason": "keyword-rank"}
        ],
    )
    cbs = make_tool_callbacks(root=os.getcwd(), emit=lambda ev: None)
    assert "laya" in cbs
    out = asyncio.run(
        cbs["laya"](
            operation="rank",
            state="sample task text",
            candidates=[{"name": "label-a"}, {"name": "label-b"}],
            top_k=1,
        )
    )
    payload = json.loads(out)
    assert payload["operation"] == "rank"
    assert payload["handled"] is True
    assert payload["ranked"][0]["name"] == "label-a"
