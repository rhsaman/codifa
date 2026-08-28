"""Unit tests for sub-agent model resolution (backend/graph.py).

Covers the fix: when a Settings -> Tools entry equals the parent (main)
model -- either by name or via the "main model" literal -- the subagent must
run on the main model -- NOT silently fall back to another slot's default.

Slots: web / compact / vision. vision defaults to None; the others
default to the parent (main) model. (The former "search" slot was removed:
grep/glob/read/terminal-search now run on the main model directly.)

Run: cd backend && uv run python -m pytest tests/test_subagent_models.py -q
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-subagent-models-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from graph import resolve_subagent_model

PROVIDER = "opencode"
BASE = "https://opencode.ai/zen/v1"
KEY = ""
ENV = "OPENCODE_ZEN_API_KEY"
OAUTH = ""


def _build(entry: str, parent_name: str = "main-model"):
    """Call resolve_subagent_model with the opencode parent + given entry.

    Uses ``default_to_parent=False`` to mirror the single-model builder
    semantics: an empty/unset entry yields ``None`` (the resolver is what
    applies the web/compact parent default).
    """
    return resolve_subagent_model(
        PROVIDER, entry, BASE, KEY, ENV, OAUTH, parent_name,
        default_to_parent=False,
    )


def _name(model):
    return None if model is None else str(getattr(model, "model_name", "") or "")


def test_entry_equal_to_parent_returns_parent():
    # THE fix: entry == parent model -> the parent model itself, NOT None
    result = _build("main-model", parent_name="main-model")
    assert result is not None
    assert _name(result) == "main-model"


def test_main_model_literal_returns_parent():
    # "main model" literal -> the parent model itself (the user's way of
    # pinning a tool to the main model without picking it from the list).
    for literal in ("main model", "main_model", "main", "  MAIN MODEL  "):
        result = _build(literal, parent_name="main-model")
        assert result is not None
        assert _name(result) == "main-model"


def test_main_model_literal_in_resolve():
    # "main model" literal in a slot -> that slot runs on the parent model.
    resolved = resolve_subagent_model(
        PROVIDER, "main_model", BASE, KEY, ENV, OAUTH, "main-model"
    )
    assert _name(resolved) == "main-model"


def test_empty_entry_returns_none():
    assert _build("") is None
    assert _build("   ") is None
    assert _build(None) is None


def test_different_model_builds():
    result = _build("other-model", parent_name="main-model")
    assert result is not None
    assert _name(result) == "other-model"


def test_slots_use_parent_when_entry_equals_parent():
    # web/compact/vision explicitly set to the main model must resolve
    # to the parent.
    for slot in ("web", "compact", "vision"):
        resolved = resolve_subagent_model(
            PROVIDER, "main-model", BASE, KEY, ENV, OAUTH, "main-model"
        )
        assert _name(resolved) == "main-model"


def test_slots_defaults_without_entries():
    # Without entries every slot resolves to the parent (web/compact) and
    # vision stays None (it has no parent default).
    web = resolve_subagent_model(PROVIDER, "", BASE, KEY, ENV, OAUTH, "main-model")
    compact = resolve_subagent_model(PROVIDER, "", BASE, KEY, ENV, OAUTH, "main-model")
    vision = resolve_subagent_model(
        PROVIDER, "", BASE, KEY, ENV, OAUTH, "main-model", default_to_parent=False
    )
    assert _name(web) == "main-model"
    assert _name(compact) == "main-model"
    assert vision is None


def test_web_compact_default_to_parent_when_unset():
    # web/compact fall back to the PARENT model when unset (the explore slot no
    # longer exists, so there is no separate explore model to inherit).
    web = resolve_subagent_model(PROVIDER, None, BASE, KEY, ENV, OAUTH, "main-model")
    compact = resolve_subagent_model(PROVIDER, None, BASE, KEY, ENV, OAUTH, "main-model")
    vision = resolve_subagent_model(
        PROVIDER, None, BASE, KEY, ENV, OAUTH, "main-model", default_to_parent=False
    )
    assert _name(web) == "main-model"
    assert _name(compact) == "main-model"
    assert vision is None


def test_provider_slash_model_strips_prefix():
    # UI sub-agent entries are stored as "providerId/model". The provider
    # segment must be dropped from the API model name (the parent provider is
    # kept) -- otherwise the server rejects the full "provider/model" string
    # (e.g. llama.cpp: 401 "Model 'local/...' is not supported").
    result = _build("local/gemma-4-E2B-it-Q4_K_M.gguf", parent_name="main-model")
    assert result is not None
    assert _name(result) == "gemma-4-E2B-it-Q4_K_M.gguf"


def test_cross_provider_routing():
    # A "providerId/model" entry whose head matches a SAVED provider row must
    # be routed to that provider's OWN base URL / key -- not dumped onto the
    # parent (main) provider. This is the fix for "it uses the main model for
    # vision instead of the one picked in Tools settings".
    import agents as _agents

    def lookup(pid):
        if pid == "local":
            return {
                "id": "local",
                "kind": "local",
                "baseUrl": "http://localhost:1234/v1",
                "apiKey": "sk-local",
                "envVar": "",
                "oauthRefreshToken": "",
            }
        return None

    # head == saved row id -> routes to that provider.
    t = _agents._subagent_target(
        "local/gemma-4-E2B-it-Q4_K_M.gguf", "opencode",
        "https://opencode.ai/zen/v1", "", "OPENCODE_ZEN_API_KEY", "",
        lookup,
    )
    assert t is not None
    kind, model, base_url, api_key, _, _ = t
    assert kind == "local"
    assert model == "gemma-4-E2B-it-Q4_K_M.gguf"
    assert base_url == "http://localhost:1234/v1"
    assert api_key == "sk-local"

    # Unrecognized prefix -> prefix dropped, routed to the parent provider with
    # just the model id (never the full "provider/model" string).
    t2 = _agents._subagent_target(
        "unknown/gemma.gguf", "opencode",
        "https://opencode.ai/zen/v1", "", "OPENCODE_ZEN_API_KEY", "",
        lambda pid: None,
    )
    assert t2 is not None
    assert t2[0] == "opencode"
    assert t2[1] == "gemma.gguf"

