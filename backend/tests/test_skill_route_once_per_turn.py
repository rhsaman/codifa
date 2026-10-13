"""Skill routing (embedding prefilter + decision model) runs once per turn.

A mid-turn reconnect / auto-retry rebuilds the turn context and calls
``_route_skills`` again with the same chat + prompt; the memo must replay the
first outcome without touching the embedder or the decision model."""
import graph

SKILLS = [{"name": "code-expert", "description": "write code", "fa_keywords": ["کد"]}]


async def test_same_turn_replays_first_result(monkeypatch):
    graph._SKILL_TURN_CACHE.clear()
    calls = []

    async def fake(prompt, skills, model, chat_id="", emit=None):
        calls.append(prompt)
        return ["code-expert"]

    monkeypatch.setattr(graph, "_route_skills_uncached", fake)
    a = await graph._route_skills("fix the bug", SKILLS, object(), chat_id="c1")
    b = await graph._route_skills("fix the bug", SKILLS, object(), chat_id="c1")
    assert a == b == ["code-expert"]
    assert len(calls) == 1


async def test_none_and_empty_results_are_memoized_too(monkeypatch):
    graph._SKILL_TURN_CACHE.clear()
    results = iter([None, ["x"]])
    calls = []

    async def fake(prompt, skills, model, chat_id="", emit=None):
        calls.append(1)
        return next(results)

    monkeypatch.setattr(graph, "_route_skills_uncached", fake)
    assert await graph._route_skills("hello there", SKILLS, object(), chat_id="c2") is None
    assert await graph._route_skills("hello there", SKILLS, object(), chat_id="c2") is None
    assert len(calls) == 1


async def test_different_prompt_or_chat_routes_again(monkeypatch):
    graph._SKILL_TURN_CACHE.clear()
    calls = []

    async def fake(prompt, skills, model, chat_id="", emit=None):
        calls.append((prompt, chat_id))
        return []

    monkeypatch.setattr(graph, "_route_skills_uncached", fake)
    await graph._route_skills("one", SKILLS, object(), chat_id="c3")
    await graph._route_skills("two", SKILLS, object(), chat_id="c3")
    await graph._route_skills("one", SKILLS, object(), chat_id="c4")
    assert len(calls) == 3


async def test_exception_is_not_memoized(monkeypatch):
    graph._SKILL_TURN_CACHE.clear()
    state = {"n": 0}

    async def fake(prompt, skills, model, chat_id="", emit=None):
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError("boom")
        return ["code-expert"]

    monkeypatch.setattr(graph, "_route_skills_uncached", fake)
    try:
        await graph._route_skills("p", SKILLS, object(), chat_id="c5")
    except RuntimeError:
        pass
    assert await graph._route_skills("p", SKILLS, object(), chat_id="c5") == ["code-expert"]


async def test_no_chat_id_never_memoized(monkeypatch):
    graph._SKILL_TURN_CACHE.clear()
    calls = []

    async def fake(prompt, skills, model, chat_id="", emit=None):
        calls.append(1)
        return []

    monkeypatch.setattr(graph, "_route_skills_uncached", fake)
    await graph._route_skills("p", SKILLS, object(), chat_id="")
    await graph._route_skills("p", SKILLS, object(), chat_id="")
    assert len(calls) == 2
