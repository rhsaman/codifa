import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi.testclient import TestClient

import agents
import llm
import server
from server import app


@pytest.fixture
def client(monkeypatch):
    async def fake_compact(model, history, ctx=0, reserved=2000, fallback_model=None, last_error=None, force=False):
        # Mirror `_compact_history`'s contract: a new history whose first
        # message carries the opencode-style prefix, plus the number of
        # recent turns preserved verbatim, plus the summarizer's usage (None here).
        return (
            [{"role": "system", "content": "[Compacted earlier context]\nmerged"}],
            2,
            None,
        )

    monkeypatch.setattr(server, "_compact_history", fake_compact)
    # Skip the real provider/model construction — tests have no live provider.
    monkeypatch.setattr(server, "build_chat_model", lambda *a, **k: object())
    return TestClient(app)


def test_manual_compact_success(client):
    history = [
        {"role": "system", "content": "[Compacted earlier context]\nold"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
        {"role": "user", "content": "again"},
        {"role": "assistant", "content": "world"},
    ]
    res = client.post(
        "/chat/compact",
        json={
            "provider": "custom",
            "model": "m",
            "base_url": "u",
            "api_key": "k",
            "fallback_provider": "custom",
            "fallback_model": "m",
            "fallback_base_url": "u",
            "fallback_api_key": "k",
            "history": history,
            "context_window": 100000,
            "reserved": 2000,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["summary"].startswith("[Compacted earlier context]")
    assert body["keep"] == 2


def test_manual_compact_empty(client):
    res = client.post("/chat/compact", json={"history": []})
    assert res.status_code == 200
    assert res.json()["summary"] is None


def test_manual_compact_no_primary_model(client):
    # No model configured -> primary builder fails -> null summary + error.
    res = client.post(
        "/chat/compact",
        json={"history": [{"role": "user", "content": "x"}]},
    )
    body = res.json()
    assert res.status_code == 200
    assert body["summary"] is None
    assert body.get("error") == "invalid primary model"


def _big_history(with_prior=False):
    history = []
    if with_prior:
        history.append(
            {"role": "system", "content": "[Compacted earlier context]\nOLD SUMMARY"}
        )
    # Enough large turns to overflow the tail budget (so `older` is non-empty).
    for i in range(8):
        history.append({"role": "user", "content": f"u{i} " + "x" * 1000})
        history.append({"role": "assistant", "content": f"a{i} " + "y" * 1000})
    return history


def test_compact_history_merges_prior_summary(monkeypatch):
    captured = {}

    async def fake_llm(m, system="", user=""):
        captured["system"] = system
        captured["user"] = user
        return "MERGED", None

    monkeypatch.setattr(llm, "llm_complete", fake_llm)
    import importlib

    importlib.reload(agents)

    class DummyModel:
        pass

    new_history, keep, _usage = asyncio.run(
        agents._compact_history(
            DummyModel(), _big_history(with_prior=True), ctx=10000, reserved=20000
        )
    )
    # The prior summary is folded into the new one (running summary).
    assert new_history[0]["content"] == "[Compacted earlier context]\nMERGED"
    assert "OLD SUMMARY" in captured["user"]
    # The recent tail is preserved verbatim and reported via `keep`.
    assert keep >= 1
    assert new_history[-keep]["role"] == "user"


def test_compact_history_merges_prior_summary_at_tail(monkeypatch):
    # Regression for the "compact loop": the frontend appends the compact summary
    # at the END of the array (so it renders below the reply), not the head. The
    # backend must normalize order and still find/merge that prior summary instead
    # of swallowing it into the recent tail and re-counting it every turn.
    captured = {}

    async def fake_llm(m, system="", user=""):
        captured["system"] = system
        captured["user"] = user
        return "MERGED", None

    monkeypatch.setattr(llm, "llm_complete", fake_llm)
    import importlib

    importlib.reload(agents)

    class DummyModel:
        pass

    # Build the same large history but place the prior summary at the TAIL.
    history = []
    for i in range(8):
        history.append({"role": "user", "content": f"u{i} " + "x" * 1000})
        history.append({"role": "assistant", "content": f"a{i} " + "y" * 1000})
    history.append(
        {"role": "system", "content": "[Compacted earlier context]\nOLD SUMMARY"}
    )

    new_history, keep, _usage = asyncio.run(
        agents._compact_history(
            DummyModel(), history, ctx=10000, reserved=20000
        )
    )
    # Exactly ONE summary at the head, and it carries the merged content.
    summaries = [m for m in new_history if m.get("role") == "system"]
    assert len(summaries) == 1, f"expected 1 summary, got {len(summaries)}"
    assert new_history[0]["content"] == "[Compacted earlier context]\nMERGED"
    # The prior summary was found and folded into the new one (not re-counted).
    assert "OLD SUMMARY" in captured["user"]
    # The recent tail is preserved verbatim and reported via `keep`.
    assert keep >= 1
    assert new_history[-keep]["role"] == "user"


def test_compact_history_fresh_no_prior(monkeypatch):
    captured = {}

    async def fake_llm(m, system="", user=""):
        captured["received"] = user
        return "FRESH", None

    monkeypatch.setattr(llm, "llm_complete", fake_llm)
    import importlib

    importlib.reload(agents)

    class DummyModel:
        pass

    new_history, keep, _usage = asyncio.run(
        agents._compact_history(
            DummyModel(), _big_history(with_prior=False), ctx=10000, reserved=20000
        )
    )
    assert new_history[0]["content"] == "[Compacted earlier context]\nFRESH"
    # The tail (recent turns) is preserved verbatim and reported via `keep`.
    assert keep >= 1


def test_compact_logs_info_to_stdout_not_stderr(client, capsys):
    # Informational lines (request / built / success) must NOT be written to
    # stderr (which the terminal renders red); only genuine problems should.
    history = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    res = client.post(
        "/chat/compact",
        json={
            "provider": "custom",
            "model": "m",
            "base_url": "u",
            "api_key": "k",
            "fallback_provider": "custom",
            "fallback_model": "m",
            "fallback_base_url": "u",
            "fallback_api_key": "k",
            "history": history,
            "context_window": 100000,
            "reserved": 2000,
        },
    )
    assert res.status_code == 200
    out, err = capsys.readouterr()
    assert "success: keep=" in out, out
    assert "[compact]" in out, out
    # No informational line should leak to stderr on the happy path.
    assert "success: keep=" not in err, err


def test_compact_empty_history_warns_to_stderr(client, capsys):
    # A genuine problem (empty history) should surface on stderr at WARNING.
    res = client.post("/chat/compact", json={"history": []})
    assert res.status_code == 200
    out, err = capsys.readouterr()
    assert "empty history -> nothing to do" in err, err
    assert "WARNING" in err, err
    assert "empty history -> nothing to do" not in out, out
