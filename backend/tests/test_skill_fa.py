"""Skill routing tests: decision-router selection, no catalog.

Only the decision router's picks reach the main-model prompt (full bodies);
there is no AVAILABLE SKILLS catalog and no keyword fallback.
"""
import graph


def test_no_picks_no_catalog_any_language(monkeypatch):
    """Without router picks the section is empty whatever the prompt language."""
    monkeypatch.setattr(
        graph._agents,
        "_load_skills",
        lambda _r: [
            {
                "name": "UI Design",
                "description": "design web interfaces",
                "content": "BODY-UI",
            }
        ],
    )
    assert graph._build_skills_section([], "/x") == ""


def test_router_pick_inlines_body(monkeypatch):
    """A router pick inlines that skill's body only — no catalog."""
    monkeypatch.setattr(
        graph._agents,
        "_load_skills",
        lambda _r: [
            {
                "name": "UI Design",
                "description": "design web interfaces",
                "content": "BODY-UI",
            }
        ],
    )
    out = graph._build_skills_section([], "/x", prompt="redesign", auto_names=["UI Design"])
    assert "BODY-UI" in out
    assert "AVAILABLE SKILLS" not in out
