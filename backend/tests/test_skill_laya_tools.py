"""Regression tests for load_skill and laya tools.

Covers: tool registration, skill lookup by slug, laya status reason.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import state_db
import tools


def test_load_skill_matches_slug(tmp_path, monkeypatch):
    """load_skill must resolve by slug as well as display name."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "code-review.md").write_text(
        "---\nname: Code Review\ndescription: review helper\n---\n\n# Code Review\n\nBody here.\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(tools, "_builtin_skills_dir", lambda: str(src))
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    state_db.invalidate_skills_cache()
    try:
        tools.sync_builtin_skills()
        cbs = tools.make_tool_callbacks(root="/tmp", emit=lambda e: None)
        assert "load_skill" in cbs
        assert "laya" in cbs
        out = asyncio.run(cbs["load_skill"]("code-review"))
        assert "===== SKILL: Code Review =====" in out
        assert "Body here." in out
    finally:
        state_db.invalidate_skills_cache()


def test_laya_status_reason_when_missing(monkeypatch):
    """Status must report precise reason and never ready without package."""
    import laya_decide

    monkeypatch.setattr(laya_decide, "is_available", lambda: False)
    monkeypatch.setattr(laya_decide, "is_ready", lambda: True)
    st = laya_decide.status()
    assert st["available"] is False
    assert st["ready"] is False
    assert st["reason"] == "laya-not-installed"
    assert laya_decide.router_unavailable_reason() == "laya-not-installed"

    monkeypatch.setattr(laya_decide, "is_available", lambda: True)
    monkeypatch.setattr(laya_decide, "is_ready", lambda: False)
    st = laya_decide.status()
    assert st["ready"] is False
    assert st["reason"] == "laya-weights-missing"
    assert laya_decide.router_unavailable_reason() == "laya-weights-missing"
