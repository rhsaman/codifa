"""Smart (data-driven) skill selection tests: multi-pick per turn.

No hard-coded keyword tables: selection is laya rank + a confidence bar.
A turn may auto-inline 0..N skill bodies; flat chit-chat noise must inline
none. The catalog itself is language-agnostic — it is built the same way
whatever language the prompt is in.
"""
import graph


def _ranked(*pairs):
    return [{"name": n, "confidence": c} for n, c in pairs]


def test_auto_picks_empty_on_empty_or_nameless_input():
    assert graph._skill_auto_picks([]) == []
    assert graph._skill_auto_picks([{"confidence": 0.9}]) == []
    assert graph._skill_auto_picks([{"name": ""}, "junk", None]) == []


def test_auto_picks_flat_noise_inlines_nothing():
    # Greeting-like laya output: everything ~0.7x, no distinctive winner.
    assert graph._skill_auto_picks(_ranked(("a", 0.74), ("b", 0.72), ("c", 0.71))) == []
    assert graph._skill_auto_picks(_ranked(("movie-finder", 0.77), ("translation", 0.75))) == []
    # Every skill above the bar but all flat: still nothing stands out.
    assert graph._skill_auto_picks(_ranked(("a", 0.74), ("b", 0.73))) == []


def test_auto_picks_single_strong_match():
    ranked = _ranked(("landing-page-design", 0.92), ("other", 0.5))
    assert graph._skill_auto_picks(ranked) == ["landing-page-design"]


def test_auto_picks_several_skills_same_turn():
    ranked = _ranked(
        ("ui-design", 0.93),
        ("frontend-principles", 0.88),
        ("threejs-storytelling", 0.71),
        ("other", 0.4),
    )
    assert graph._skill_auto_picks(ranked) == [
        "ui-design",
        "frontend-principles",
        "threejs-storytelling",
    ]


def test_auto_picks_cap_bodies_per_turn():
    ranked = _ranked(("a", 0.95), ("b", 0.94), ("c", 0.93), ("d", 0.92), ("e", 0.4))
    assert graph._skill_auto_picks(ranked) == ["a", "b", "c"]
    assert graph._SKILL_AUTO_MAX == 3


def test_auto_picks_below_bar_pick_nothing():
    assert graph._skill_auto_picks(_ranked(("a", 0.69), ("b", 0.4))) == []


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
