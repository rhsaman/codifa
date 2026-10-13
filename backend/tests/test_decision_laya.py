"""Tests for the local Laya decision path and decision usage forwarding.

Covers: the ``"laya"`` sentinel detection, the local branch of
``graph._route_skills`` (no usage emitted for the free on-device model),
the external branch (usage forwarded via ``emit`` so Model Usage accrues
it), and the fail-open fallbacks.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-decision-laya-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import graph


def _reset_router():
    graph._SKILL_ROUTE_CACHE.clear()
    graph._skill_route_state["fails"] = 0
    graph._skill_route_state["paused_until"] = 0.0


_ROWS = [
    {"name": "Movie Finder", "description": "find good movies"},
    {"name": "summarization", "description": "condense long content"},
]

_PROMPT = "Please find good movies for the weekend, something fun"


def test_is_laya_decision():
    assert graph._is_laya_decision("laya")
    assert graph._is_laya_decision(" LAYA ")
    assert graph._is_laya_decision("Laya")
    assert not graph._is_laya_decision("")
    assert not graph._is_laya_decision("main model")
    assert not graph._is_laya_decision("openrouter/free")
    assert not graph._is_laya_decision(None)
    assert not graph._is_laya_decision(123)


def test_laya_sentinel_is_not_a_model():
    assert isinstance(graph._LAYA_LOCAL_MODEL, str)
    assert graph._LAYA_LOCAL_MODEL != "laya"


def test_route_skills_laya_local_emits_no_usage(monkeypatch):
    _reset_router()
    import laya_router

    monkeypatch.setattr(
        laya_router, "predict", lambda prompt, rows, chat_id="": ["Movie Finder"]
    )
    emitted: list[dict] = []
    out = asyncio.run(
        graph._route_skills(
            _PROMPT + " local-1", _ROWS, graph._LAYA_LOCAL_MODEL,
            emit=emitted.append,
        )
    )
    assert out == ["Movie Finder"]
    # Local models are free: no usage event is forwarded.
    assert emitted == []


def test_route_skills_laya_unavailable_returns_none(monkeypatch):
    _reset_router()
    import laya_router

    monkeypatch.setattr(
        laya_router, "predict", lambda prompt, rows, chat_id="": None
    )
    out = asyncio.run(
        graph._route_skills(
            _PROMPT + " local-2", _ROWS, graph._LAYA_LOCAL_MODEL,
            emit=lambda ev: None,
        )
    )
    assert out is None


def test_route_skills_external_forwards_usage(monkeypatch):
    _reset_router()
    fake_usage = {
        "kind": "usage",
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "model": "tiny-router",
        "sub": True,
    }

    async def _fake_generate(model, *, system="", user="", sub=False,
                             chat_id=""):
        return ('["Movie Finder"]', dict(fake_usage))

    monkeypatch.setattr(graph, "llm_generate", _fake_generate)
    emitted: list[dict] = []
    out = asyncio.run(
        graph._route_skills(
            _PROMPT + " external-1", _ROWS, object(), emit=emitted.append
        )
    )
    assert out == ["Movie Finder"]
    assert emitted == [fake_usage]


def test_laya_router_predict_no_dir_returns_none(monkeypatch):
    import laya_router

    monkeypatch.setattr(laya_router, "_resolve_model_dir", lambda prompt: "")
    assert laya_router.predict(_PROMPT, _ROWS) is None


class _FakeLayaAgent:
    """Deterministic stand-in for the loaded Laya agent.

    ``margins`` maps skill name -> P(skill) - P(none); the rendered
    probabilities are the unique pair with that margin.
    """

    def __init__(self, margins: dict[str, float]) -> None:
        self._margins = margins

    def system_one(self, state, questions):
        answers = {}
        for qid in questions:
            margin = self._margins.get(qid, -1.0)
            p_skill = max(0.0, (1.0 + margin) / 2.0)
            answers[qid] = {
                "type": "choice",
                "choice": qid if margin >= 0 else "none",
                "probabilities": {qid: p_skill, "none": 1.0 - p_skill},
                "confidence": 0.5,
            }
        return {"model": "laya-local", "answers": answers}


def _fake_laya(monkeypatch, margins):
    """Point laya_router at a fake agent with the given skill margins."""
    import laya_router

    agent = _FakeLayaAgent(margins)
    monkeypatch.setattr(laya_router, "_resolve_model_dir", lambda prompt: "/laya")
    monkeypatch.setattr(laya_router, "_get_agent", lambda d: agent)
    return agent


def test_binary_questions_one_per_candidate():
    import laya_router

    qs = laya_router._binary_questions(_ROWS)
    assert set(qs) == {"Movie Finder", "summarization"}
    for name, q in qs.items():
        assert q["type"] == "choice"
        assert set(q["criteria"]) == {name, "none"}


def test_predict_picks_only_margin_winners(monkeypatch):
    import laya_router

    _fake_laya(monkeypatch, {"Movie Finder": 0.9, "summarization": 0.1})
    # summarization is below the margin gate: only Movie Finder loads.
    assert laya_router.predict("find movies", _ROWS) == ["Movie Finder"]


def test_predict_caps_and_sorts_picks(monkeypatch):
    import laya_router

    rows = [
        {"name": "a", "description": "x"},
        {"name": "b", "description": "x"},
        {"name": "c", "description": "x"},
    ]
    _fake_laya(monkeypatch, {"a": 0.4, "b": 0.9, "c": 0.6})
    out = laya_router.predict("anything", rows)
    assert out == ["b", "c"]  # sorted by margin, capped at _MAX_PICKS


def test_predict_missing_skill_loads_nothing(monkeypatch):
    import laya_router

    _fake_laya(monkeypatch, {"Movie Finder": -0.2, "summarization": 0.29})
    # Every candidate below the gate: nothing loads (no fallback).
    assert laya_router.predict("unrelated request", _ROWS) == []


def test_predict_asks_at_most_max_options(monkeypatch):
    import laya_router

    seen: dict = {}

    class _Counting(_FakeLayaAgent):
        def system_one(self, state, questions):
            seen["n"] = len(questions)
            return super().system_one(state, questions)

    agent = _Counting({})
    monkeypatch.setattr(laya_router, "_resolve_model_dir", lambda p: "/laya")
    monkeypatch.setattr(laya_router, "_get_agent", lambda d: agent)
    rows = [{"name": f"s{i}", "description": "x"} for i in range(10)]
    assert laya_router.predict("anything", rows) == []
    assert seen["n"] == laya_router._MAX_OPTIONS


def test_laya_router_entry_helper():
    import laya_router

    assert laya_router.is_laya_entry("laya")
    assert laya_router.is_laya_entry(" Laya ")
    assert not laya_router.is_laya_entry("openrouter/free")
    assert not laya_router.is_laya_entry("")


def test_laya_unload_drops_cached_agent(monkeypatch):
    import laya_router

    monkeypatch.setattr(laya_router, "_resolve_model_dir", lambda prompt: "/laya")
    monkeypatch.setattr(laya_router, "_get_agent", lambda d: object())
    laya_router._agent = object()
    laya_router._agent_dir = "/laya"
    assert laya_router.unload() is True
    assert laya_router._agent is None
    assert laya_router.unload() is False


def test_parse_skill_route_tolerant_prose_reply():
    # Main models often answer in prose instead of a JSON array.
    out = graph._parse_skill_route(
        "به نظرم اسکیل Movie Finder برای این درخواست مناسب است", _ROWS, 2
    )
    assert out == ["Movie Finder"]


def test_parse_skill_route_prose_without_skill_returns_none():
    assert graph._parse_skill_route("این یک جواب فارسی بدون نام است", _ROWS, 2) is None


def test_route_skills_short_persian_prompt_routes(monkeypatch):
    # Short Persian prompts (below the old 8-char gate) must still route.
    _reset_router()

    async def _fake_generate(model, *, system="", user="", sub=False, chat_id=""):
        return ('["Movie Finder"]', None)

    monkeypatch.setattr(graph, "llm_generate", _fake_generate)
    out = asyncio.run(
        graph._route_skills("فیلم", _ROWS, object(), emit=lambda ev: None)
    )
    assert out == ["Movie Finder"]


def test_route_skills_external_emits_trace(monkeypatch):
    _reset_router()
    import trace_store

    async def _fake_generate(model, *, system="", user="", sub=False, chat_id=""):
        return ('["Movie Finder"]', None)

    monkeypatch.setattr(graph, "llm_generate", _fake_generate)
    seen: list[dict] = []
    monkeypatch.setattr(trace_store, "append", lambda *a, **k: seen.append(k) or {})
    out = asyncio.run(
        graph._route_skills(
            _PROMPT + " external-trace", _ROWS, object(), emit=lambda ev: None
        )
    )
    assert out == ["Movie Finder"]
    assert seen, "external decision path must append a trace entry"
