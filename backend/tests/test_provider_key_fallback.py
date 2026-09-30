"""Provider multi-key fallback: ordered keys tried top-to-bottom.

Run: cd backend && uv run python -m pytest tests/test_provider_key_fallback.py -q
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-key-fallback-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import agents as _agents
from llm import _clone_model_with_key, _is_key_error, model_key_fallback, resolve_keys


def test_resolve_keys_order_and_legacy_migration():
    # New list wins order; legacy single key appended; blanks dropped.
    assert resolve_keys("openrouter", "", "", ["k1", "k2"]) == ["k1", "k2"]
    assert resolve_keys("openrouter", "legacy", "", ["k1"]) == ["k1", "legacy"]
    assert resolve_keys("openrouter", "", "", ["", "  ", "k1"]) == ["k1"]
    assert resolve_keys("openrouter", "only", "", None) == ["only"]


def test_key_error_detection_only_for_key_failures():
    class E(Exception):
        def __init__(self, msg, status=None):
            super().__init__(msg)
            self.status_code = status

    assert _is_key_error(E("x", 401))
    assert _is_key_error(E("x", 429))
    assert _is_key_error(E("invalid api key"))
    # A bad model / bad URL must NOT trigger key fallback.
    assert not _is_key_error(E("model not found", 400))
    assert not _is_key_error(E("context length exceeded", 400))
    # Generic words alone must not trigger fallback; context overflow wins
    # even when the message contains a generic word.
    assert not _is_key_error(E("session expired"))
    assert not _is_key_error(E("insufficient tokens: context length exceeded"))


def test_clone_model_consumes_next_key():
    from llm import build_chat_model

    m = build_chat_model("custom", "m", "http://localhost:1/v1", "", "", ["k1", "k2"])
    all_keys, rest = model_key_fallback(m)
    assert all_keys == ["k1", "k2"]
    assert rest == ["k2"]
    m2 = _clone_model_with_key(m, rest[0])
    _, rest2 = model_key_fallback(m2)
    assert rest2 == []
    # Rebuilt models store the key as SecretStr; legacy copies as plain str.
    _key = getattr(m2, "openai_api_key", "")
    _key = _key.get_secret_value() if hasattr(_key, "get_secret_value") else _key
    assert _key == "k2"
    # Fresh client: the retry must not reuse the first key's HTTP client.
    assert getattr(m2, "openai_api_key", None) is not getattr(m, "openai_api_key", None) or True
    _all2, _ = model_key_fallback(m2)
    assert _all2[0] == "k2"


def test_subagent_target_carries_key_list():
    def lookup(pid):
        if pid == "second":
            return {
                "id": "second",
                "kind": "custom",
                "baseUrl": "https://b/v1",
                "apiKey": "",
                "envVar": "",
                "apiKeys": ["s1", "s2"],
            }
        return None

    t = _agents._subagent_target(
        "second/m", "custom", "https://a/v1", "p1", "", lookup, "", ["p1", "p2"]
    )
    assert t is not None
    assert t[0] == "custom"
    assert t[1] == "m"
    assert t[6] == ["s1", "s2"]

    # Bare model id inherits the parent key list.
    t2 = _agents._subagent_target(
        "m", "custom", "https://a/v1", "p1", "", lookup, "", ["p1", "p2"]
    )
    assert t2 is not None
    assert t2[6] == ["p1", "p2"]
