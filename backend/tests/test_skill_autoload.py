"""Skill catalog for sub-agents.

A sub-agent spawned via ``task`` gets the compact skills catalog and a
bound load_skill tool, so a delegation like "apply skill X" works.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-skill-autoload-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from conftest import await_task_report
from langchain_core.messages import AIMessage

import state_db
from graph import skills_catalog_block

# ---------------------------------------------------------------------------
# Sub-agent skills catalog (graph.skills_catalog_block + task wiring)
# ---------------------------------------------------------------------------

_SKILL_BODY = "SKILLBODY-MARKER: always answer with a haiku."


def _seed_skill() -> None:
    state_db.save_skill(
        "Movie Finder",
        "movie-finder",
        "find good movies",
        _SKILL_BODY,
    )


def test_skills_catalog_block_content_and_empty(monkeypatch):
    import graph as G

    monkeypatch.setattr(
        G._agents, "_load_skills",
        lambda _r: [
            {"name": "Movie Finder", "description": "find good movies",
             "content": _SKILL_BODY},
        ],
    )
    block = skills_catalog_block()
    assert block.startswith("\n\n=== AVAILABLE SKILLS ===")
    assert "- Movie Finder: find good movies" in block
    # Catalog only: never the body (that is load_skill's job).
    assert _SKILL_BODY not in block
    # No skills -> zero tokens.
    monkeypatch.setattr(G._agents, "_load_skills", lambda _r: [])
    assert skills_catalog_block() == ""


def test_skills_catalog_block_never_truncates_huge_store(monkeypatch):
    """The skills catalog is part of the system prompt: every skill keeps a
    full line even for a huge store (no truncation, no '+N more' note)."""
    import graph as G

    many = [
        {"name": f"skill-{i}", "description": "d" * 180, "content": "x"}
        for i in range(40)
    ]
    monkeypatch.setattr(G._agents, "_load_skills", lambda _r: many)
    block = skills_catalog_block()
    for i in range(40):
        assert f"skill-{i}" in block
    assert "more skills not listed" not in block


class _MsgRecordingModel:
    """Fake model: records every transcript it sees; final reply is fixed."""

    model_name = "fake"

    def __init__(self, text: str = "SUBAGENT DONE") -> None:
        self._text = text
        self.seen_user: list[str] = []

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        for m in msgs:
            c = getattr(m, "content", "")
            if getattr(m, "type", "") == "human" and isinstance(c, str):
                self.seen_user.append(c)
        return AIMessage(content=self._text)


async def test_task_subagent_receives_skills_catalog_and_load_skill():
    """A spawned sub-agent sees the AVAILABLE SKILLS catalog in its prompt
    and can call load_skill (bound even though the spawn path inherits the
    parent toolset)."""
    _seed_skill()
    import tools as T

    emitted: list[dict] = []
    model = _MsgRecordingModel()
    cbs = T.make_tool_callbacks(
        tempfile.mkdtemp(prefix="coder-test-skill-ws-"),
        lambda ev: emitted.append(ev),
        main_model=model,
    )
    task = cbs["task"]

    ack = await task(
        description="apply the movie skill",
        prompt="Use the Movie Finder skill on watchlist.txt.",
        subagent_type="subagent",
    )
    await await_task_report(ack)
    assert model.seen_user, "sub-agent never ran"
    user_prompt = "\n".join(model.seen_user)
    assert "AVAILABLE SKILLS" in user_prompt
    assert "Movie Finder: find good movies" in user_prompt
    # The catalog is appended ONCE even across retry attempts.
    assert user_prompt.count("AVAILABLE SKILLS") == 1


class _LoadSkillModel:
    """Fake model: calls load_skill once, then echoes its result."""

    model_name = "fake"

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        last = msgs[-1]
        if getattr(last, "type", "") == "tool":
            return AIMessage(content=f"LOADED:{str(last.content)[:200]}")
        return AIMessage(
            content="",
            tool_calls=[
                {"name": "load_skill", "args": {"name": "Movie Finder"}, "id": "ls1"}
            ],
        )


async def test_task_subagent_can_call_load_skill():
    _seed_skill()
    import tools as T

    emitted: list[dict] = []
    model = _LoadSkillModel()
    cbs = T.make_tool_callbacks(
        tempfile.mkdtemp(prefix="coder-test-skill-ws2-"),
        lambda ev: emitted.append(ev),
        main_model=model,
    )
    ack = await cbs["task"](
        description="load the skill",
        prompt="load the Movie Finder skill",
        subagent_type="subagent",
    )
    report = await await_task_report(ack)
    assert "LOADED:" in report
    assert "haiku" in report, f"skill body not loaded: {report[:200]!r}"


async def test_task_subagent_gets_catalog_for_any_prompt():
    """The sub-agent inherits load_skill via the parent toolset but
    its registry prompt has no catalog either — it must get one."""
    _seed_skill()
    import tools as T

    model = _MsgRecordingModel()
    cbs = T.make_tool_callbacks(
        tempfile.mkdtemp(prefix="coder-test-skill-ws3-"),
        lambda ev: None,
        main_model=model,
    )
    ack = await cbs["task"](
        description="delegated work",
        prompt="Do delegated work.",
        subagent_type="subagent",
    )
    await await_task_report(ack)
    assert model.seen_user, "sub-agent never ran"
    user_prompt = "\n".join(model.seen_user)
    assert "AVAILABLE SKILLS" in user_prompt
    assert "Movie Finder" in user_prompt


# ---------------------------------------------------------------------------
# Compact catalog + staged load_skill matching (autoload hardening)
# ---------------------------------------------------------------------------


def test_compact_catalog_always_present(monkeypatch):
    """Compact catalog (small-context) still lists names and descriptions."""
    import graph as G

    monkeypatch.setattr(
        G._agents, "_load_skills",
        lambda _r: [
            {"name": "Movie Finder", "description": "find good movies",
             "content": _SKILL_BODY},
        ],
    )
    out = G._build_skills_section([], "/x", catalog=True, compact=True)
    assert "AVAILABLE SKILLS" in out
    assert "Movie Finder" in out
    assert _SKILL_BODY not in out
    assert "load_skill" in out
    assert len(out) <= 900


def test_catalog_lists_every_skill_for_huge_store(monkeypatch):
    """Full and compact catalogs list every skill with its full description."""
    import graph as G

    many = [
        {"name": f"skill-{i}", "description": "d" * 180, "content": "x"}
        for i in range(40)
    ]
    monkeypatch.setattr(G._agents, "_load_skills", lambda _r: many)
    for out in (
        G._build_skills_section([], "/x", catalog=True),
        G._build_skills_section([], "/x", catalog=True, compact=True),
        skills_catalog_block(),
    ):
        for i in range(40):
            assert f"skill-{i}" in out
        assert "d" * 180 in out


def test_load_skill_staged_match_keyword_and_fuzzy():
    """Keyword, substring and near-name queries resolve with one call."""
    import asyncio

    import tools as T
    from tools import persist_skill

    res = persist_skill(
        "---\nname: Movie Finder\ndescription: find good movies\nfa_keywords: film, cinema\n---\n\n# Movie Finder\n\n" + _SKILL_BODY,
        fallback_name="Movie Finder",
    )
    assert res.get("ok"), res
    state_db.invalidate_skills_cache()
    cbs = T.make_tool_callbacks(tempfile.mkdtemp(prefix="coder-test-skill-stage-"), lambda e: None)
    assert "load_skill" in cbs
    for query in ("movie finder", "movie-finder", "Movie", "cinema", "find good movies"):
        out = asyncio.run(cbs["load_skill"](query))
        assert not out.startswith("ERROR"), f"query {query!r}: {out[:120]!r}"
        assert "haiku" in out


def test_manual_persist_loads_by_same_name_and_slug():
    """Manually persisted skills load by the same name/slug load_skill uses."""
    import asyncio

    import tools as T
    from tools import persist_skill

    res = persist_skill(
        "---\nname: Code Review\ndescription: review code\n---\n\n# Code Review\n\nREVIEW-BODY",
        fallback_name="Code Review",
    )
    assert res.get("ok"), res
    state_db.invalidate_skills_cache()
    cbs = T.make_tool_callbacks(tempfile.mkdtemp(prefix="coder-test-skill-manual-"), lambda e: None)
    for query in ("Code Review", "code-review", "code review"):
        out = asyncio.run(cbs["load_skill"](query))
        assert "REVIEW-BODY" in out, f"query {query!r}: {out[:120]!r}"


if __name__ == "__main__":
    asyncio.run(asyncio.gather(*[
        test_task_subagent_receives_skills_catalog_and_load_skill(),
        test_task_subagent_can_call_load_skill(),
        test_task_subagent_gets_catalog_for_any_prompt(),
    ]))
    print("OK")
