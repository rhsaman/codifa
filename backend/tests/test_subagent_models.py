"""Unit tests for subagent model resolution (backend/agents.py).

Covers the fix: when a Settings → Tools entry equals the parent (main)
model — either by name or via the "main model" literal — the subagent must
run on the main model — NOT silently fall back to another slot's default
(e.g. the explore model for the search/web slots).

Run: cd backend && .venv/bin/python -m pytest tests/test_subagent_models.py -q
"""
import os
import sys

_TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmp_user_cfg")
os.makedirs(_TMP, exist_ok=True)
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import agents  # noqa: E402


class _FakeModel:
    def __init__(self, name: str):
        self.model_name = name


def _no_provider(pid: str):
    return None


def _build(entry: str, parent_name: str = "main-model", monkeypatch=None, build_impl=None):
    """Call agents._build_subagent_model with a fake parent + optional build mock."""
    parent = _FakeModel(parent_name)
    if build_impl is not None:
        monkeypatch.setattr(agents, "build_model", build_impl)
    return agents._build_subagent_model(
        entry,
        parent,
        parent_name,
        "opencode",
        "", "", "", "",
        _no_provider,
    )


def test_entry_equal_to_parent_returns_parent(monkeypatch):
    # THE fix: entry == parent model → the parent model itself, NOT None
    result = _build("main-model", parent_name="main-model", monkeypatch=monkeypatch)
    assert result is not None
    built, name = result
    assert built.model_name == "main-model"
    assert name == "main-model"


def test_main_model_literal_returns_parent(monkeypatch):
    # "main model" literal → the parent model itself (the user's way of
    # pinning a tool to the main model without picking it from the list).
    for literal in ("main model", "main_model", "main", "  MAIN MODEL  "):
        result = _build(literal, parent_name="main-model", monkeypatch=monkeypatch)
        assert result is not None
        built, name = result
        assert built.model_name == "main-model"
        assert name == "main-model"


def test_main_model_literal_in_resolve(monkeypatch):
    # "main model" literal in a slot → that slot runs on the parent model,
    # and search/web do NOT silently land on the explore model.
    resolved = _resolve(
        {
            "explore": "explore-model",
            "search": "main model",
            "web": "main_model",
        },
        monkeypatch=monkeypatch,
    )
    assert resolved["explore"].model_name == "explore-model"
    assert resolved["search"].model_name == "main-model"
    assert resolved["web"].model_name == "main-model"


def test_empty_entry_returns_none(monkeypatch):
    assert _build("", monkeypatch=monkeypatch) is None
    assert _build("   ", monkeypatch=monkeypatch) is None


def test_different_model_builds(monkeypatch):
    calls = []

    def fake_build(kind, model, base, key, env, oauth_token=None):
        calls.append((kind, model))
        return _FakeModel(model)

    result = _build("other-model", monkeypatch=monkeypatch, build_impl=fake_build)
    assert result is not None
    built, name = result
    assert name == "other-model"
    assert built.model_name == "other-model"
    assert calls == [("opencode", "other-model")]


def test_build_failure_returns_none(monkeypatch):
    def fake_build(*args, **kwargs):
        raise RuntimeError("bad model")

    assert _build("broken-model", monkeypatch=monkeypatch, build_impl=fake_build) is None


def _resolve(subagent_models: dict, parent_name: str = "main-model", monkeypatch=None):
    """Call agents._resolve_subagent_models with a fake parent + mocked build."""
    parent = _FakeModel(parent_name)
    monkeypatch.setattr(
        agents,
        "build_model",
        lambda kind, model, base, key, env, oauth_token=None: _FakeModel(model),
    )
    return agents._resolve_subagent_models(
        subagent_models,
        parent,
        parent_name,
        "opencode",
        "", "", "", "",
        _no_provider,
    )


def test_slots_use_parent_when_entry_equals_parent(monkeypatch):
    # THE regression: search/web/compact/vision explicitly set to the main
    # model must resolve to the parent — search/web must NOT land on the
    # explore model.
    resolved = _resolve(
        {
            "explore": "explore-model",
            "search": "main-model",
            "web": "main-model",
            "compact": "main-model",
            "vision": "main-model",
        },
        monkeypatch=monkeypatch,
    )
    assert resolved["explore"].model_name == "explore-model"
    # search/web/compact/vision all explicitly = main model → parent
    assert resolved["search"].model_name == "main-model"
    assert resolved["web"].model_name == "main-model"
    assert resolved["compact"].model_name == "main-model"
    assert resolved["vision"].model_name == "main-model"


def test_slots_defaults_without_entries(monkeypatch):
    resolved = _resolve({}, monkeypatch=monkeypatch)
    assert resolved["explore"].model_name == "main-model"
    assert resolved["search"].model_name == "main-model"  # explore default == parent
    assert resolved["web"].model_name == "main-model"
    assert resolved["compact"].model_name == "main-model"
    assert resolved["vision"] is None


def test_search_falls_back_to_explore_when_unset(monkeypatch):
    # search/web fall back to the EXPLORE model when unset (documented chain)
    resolved = _resolve({"explore": "explore-model"}, monkeypatch=monkeypatch)
    assert resolved["explore"].model_name == "explore-model"
    assert resolved["search"] is resolved["explore"]
    assert resolved["web"] is resolved["explore"]
    assert resolved["compact"].model_name == "main-model"
    assert resolved["vision"] is None