"""Unit tests for the DRY helper functions in providers.py.

These cover the shared extractors (_first_int / _first_bool) and the
models.dev limit lookup (_models_dev_limit_int) that back the per-field
helpers (_entry_context, _entry_max_output, _entry_reasoning,
_models_dev_context, _models_dev_max_output).
"""


from providers import (
    _first_bool,
    _first_int,
    _models_dev_limit_int,
)


def test_first_int_prefers_first_matching_key():
    obj = {"max_model_len": "8192", "context_length": 4096}
    assert _first_int(obj, ("context_length", "max_model_len")) == 4096


def test_first_int_accepts_string_and_number():
    assert _first_int({"n": "128000"}, ["n"]) == 128000
    assert _first_int({"n": 128000}, ["n"]) == 128000


def test_first_int_skips_non_integers():
    assert _first_int({"n": "abc"}, ["n"]) is None


def test_first_int_coerces_floats():
    # Python's int() truncates floats rather than raising, so a float is kept.
    assert _first_int({"n": 1.5}, ["n"]) == 1


def test_first_int_returns_none_when_missing():
    assert _first_int({}, ["context_length"]) is None
    assert _first_int(None, ["context_length"]) is None


def test_first_int_skips_falsy_values():
    # Falsy (0 / empty) values are skipped so a real later key wins.
    assert _first_int({"a": 0, "b": 2048}, ["a", "b"]) == 2048


def test_first_bool_prefers_first_matching_key():
    obj = {"supports_reasoning": False, "reasoning": True}
    assert _first_bool(obj, ("reasoning", "supports_reasoning")) is True


def test_first_bool_returns_none_for_non_bool():
    assert _first_bool({"reasoning": "yes"}, ["reasoning"]) is None
    assert _first_bool({}, ["reasoning"]) is None
    assert _first_bool(None, ["reasoning"]) is None


def test_models_dev_limit_int_reads_nested_limit():
    catalog = {
        "openai": {
            "models": {
                "gpt-x": {"limit": {"context": 128000, "output": 4096}},
            }
        }
    }
    keys = ["openai"]
    assert _models_dev_limit_int(catalog, keys, "gpt-x", "context") == 128000
    assert _models_dev_limit_int(catalog, keys, "gpt-x", "output") == 4096


def test_models_dev_limit_int_missing_field_is_none():
    catalog = {"openai": {"models": {"gpt-x": {"limit": {}}}}}
    assert _models_dev_limit_int(catalog, ["openai"], "gpt-x", "context") is None


def test_models_dev_limit_int_string_value_coerced():
    catalog = {"openai": {"models": {"gpt-x": {"limit": {"context": "32768"}}}}}
    assert _models_dev_limit_int(catalog, ["openai"], "gpt-x", "context") == 32768
