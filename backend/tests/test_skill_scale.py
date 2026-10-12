"""Skill routing at scale: a thousand skills, router sees prefiltered candidates.

Locks the no-catalog design: only the decision router's picks reach the
main-model prompt (full bodies, no AVAILABLE SKILLS section), the router
itself only ever sees the embedding-prefiltered top candidates, and there
is no keyword fallback anywhere in the path.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-skill-scale-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import graph
import skill_prefilter


def _make_store(n=1000):
    skills = [
        {
            "name": f"skill-{i:04d}",
            "slug": f"skill-{i:04d}",
            "description": f"does unrelated thing number {i}",
            "content": f"BODY-{i:04d}",
            "fa_keywords": [],
        }
        for i in range(n)
    ]
    # The one relevant skill sits at the very END of store order: without a
    # prefilter the router's caps would cut it off and it could never win.
    skills.append({
        "name": "Movie Finder",
        "slug": "movie-finder",
        "description": "find good movies and cinema recommendations",
        "content": "MOVIE-BODY",
        "fa_keywords": ["film"],
    })
    return skills


def _reset_router():
    graph._SKILL_ROUTE_CACHE.clear()
    graph._skill_route_state["fails"] = 0
    graph._skill_route_state["paused_until"] = 0.0


def test_prefilter_ranks_even_when_store_fits(monkeypatch):
    # Store order is alphabetical, not relevance: a small store must still be
    # embedding-ranked so the router's tiny candidate slice is the best one.
    import embeddings

    def _fake_embed(texts):
        # One-hot vectors: the query matches the Movie Finder passage only.
        out = []
        for t in texts:
            vec = [0.0, 0.0]
            if "movie" in t.casefold():
                vec = [1.0, 0.0]
            elif t and t[0].isdigit():
                vec = [0.0, 1.0]
            out.append(vec)
        return out

    monkeypatch.setattr(embeddings, "is_available", lambda: True)
    monkeypatch.setattr(embeddings, "embed_queries", lambda qs: _fake_embed(qs))
    monkeypatch.setattr(embeddings, "embed_passages", lambda ps: _fake_embed(ps))
    rows = _make_store(10)
    ranked = skill_prefilter.prefilter_skills("find movies please", rows)
    assert sorted(ranked, key=lambda s: s["name"]) == sorted(rows, key=lambda s: s["name"])
    assert ranked[0]["name"] == "Movie Finder"


def test_prefilter_empty_prompt_returns_store_order():
    rows = _make_store(10)
    assert skill_prefilter.prefilter_skills("", rows) == rows


def test_prefilter_fail_open_without_embedder(monkeypatch):
    import embeddings

    monkeypatch.setattr(embeddings, "is_available", lambda: False)
    rows = _make_store(100)
    assert skill_prefilter.prefilter_skills("find movies please", rows) == rows


def test_top_indices_ranking():
    idx = skill_prefilter._top_indices(
        [1.0, 0.0], [[0.0, 1.0], [1.0, 0.0], [0.5, 0.5]], 2
    )
    assert idx == [1, 2]


def test_route_skills_sees_prefiltered_candidates_only(monkeypatch):
    _reset_router()
    store = _make_store()
    seen = {}

    def _fake_prefilter(prompt, rows, limit=50):
        seen["n_in"] = len(rows)
        out = rows[-50:]
        seen["names"] = [s["name"] for s in out]
        return out

    monkeypatch.setattr(skill_prefilter, "prefilter_skills", _fake_prefilter)

    async def _fake_generate(model, *, system="", user="", sub=False, chat_id=""):
        seen["user"] = user
        return ('["Movie Finder"]', None)

    monkeypatch.setattr(graph, "llm_generate", _fake_generate)
    out = asyncio.run(
        graph._route_skills(
            "find good movies for the weekend fun",
            store,
            object(),
            emit=lambda ev: None,
        )
    )
    assert out == ["Movie Finder"]
    assert seen["n_in"] == 1001
    assert "Movie Finder" in seen["names"]
    assert "skill-0000" not in seen["user"]


def test_section_has_no_catalog_only_router_picks(monkeypatch):
    store = _make_store()
    monkeypatch.setattr(graph._agents, "_load_skills", lambda _r: store)
    out = graph._build_skills_section(
        [], "/x", prompt="find good movies", auto_names=["Movie Finder"]
    )
    assert "MOVIE-BODY" in out
    assert "AVAILABLE SKILLS" not in out
    assert "BODY-0000" not in out


def test_section_empty_when_router_returns_nothing(monkeypatch):
    store = _make_store()
    monkeypatch.setattr(graph._agents, "_load_skills", lambda _r: store)
    assert graph._build_skills_section([], "/x", auto_names=None) == ""
    assert graph._build_skills_section([], "/x", auto_names=[]) == ""


def test_no_keyword_fallback_without_router(monkeypatch):
    """A request matching fa_keywords is NOT auto-inlined without the router."""
    store = _make_store()
    monkeypatch.setattr(graph._agents, "_load_skills", lambda _r: store)
    out = graph._build_skills_section([], "/x", prompt="film khub moarefi kon")
    assert out == ""


def test_no_keyword_fallback_helpers_remain():
    import agents

    assert not hasattr(agents, "_auto_pick_skills")
    assert not hasattr(agents, "_SKILL_FA_CONCEPTS")
    assert not hasattr(graph, "_skill_generic_pick")
