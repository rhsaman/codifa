"""Skill catalog selection tests: language-agnostic catalog.

The catalog itself is language-agnostic — it is built the same way
whatever language the prompt is in. Bodies are inlined only for
@mentioned skills; everything else is served via load_skill.
"""
import graph


def test_catalog_is_language_agnostic(monkeypatch):
    """The catalog is built the same way whatever the prompt language is."""
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
    out = graph._build_skills_section([], "/x")
    assert "AVAILABLE SKILLS" in out
    assert "UI Design" in out
    assert "BODY-UI" not in out, "no picks: catalog only, no body inlined"
