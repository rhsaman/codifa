"""Generic laya tool behavior: choice/score/status without hard-coded domains."""

import asyncio
import json
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-laya-tool-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import laya_decide
from tools import make_tool_callbacks


def _run(coro):
    return asyncio.run(coro)


def test_laya_tool_choice_returns_handled_decision(monkeypatch):
    """Generic choice with caller-supplied labels returns the laya decision."""
    monkeypatch.setattr(
        laya_decide,
        "choice",
        lambda state, options, threshold=0.65, provider_id="": laya_decide.LayaDecision(
            handled=True, kind="choice", value="label-b", confidence=0.9,
            abstained=False, reason="local-decision",
            usage={"kind": "usage", "provider_id": "local"},
            provider_id="local", model="test-repo",
        ),
    )
    cbs = make_tool_callbacks(root=os.getcwd(), emit=lambda ev: None)
    assert "laya" in cbs
    out = _run(cbs["laya"](operation="choice", state={"text": "sample"}, options=["label-a", "label-b"]))
    payload = json.loads(out)
    assert payload["operation"] == "choice"
    assert payload["handled"] is True
    assert payload["value"] == "label-b"
    assert payload["confidence"] == 0.9
    assert payload["abstained"] is False


def test_laya_tool_abstain_signals_main_model_fallback(monkeypatch):
    """Abstained/low-confidence score tells the caller to use the main model."""
    monkeypatch.setattr(
        laya_decide,
        "score",
        lambda state, candidate, threshold=0.65, provider_id="": laya_decide.LayaDecision(
            handled=False, kind="score", value=0.0, confidence=0.2,
            abstained=True, reason="abstained",
            usage=None, provider_id="local", model="",
        ),
    )
    cbs = make_tool_callbacks(root=os.getcwd(), emit=lambda ev: None)
    out = _run(cbs["laya"](operation="score", state={"text": "sample"}, candidate="candidate-x"))
    payload = json.loads(out)
    assert payload["operation"] == "score"
    assert payload["handled"] is False
    assert payload["abstained"] is True
