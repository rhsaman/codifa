"""Tests for the reasoning-effort 400 retry path.

Covers ``_is_reasoning_effort_error`` (detecting the always-thinking 400 from
gateways like agentrouter) and ``_remap_reasoning_effort`` (mapping the user's
level onto the nearest value the route accepts, parsed from the error text).
"""

from llm import (
    _is_reasoning_effort_error,
    _is_reasoning_param_error,
    _parse_allowed_efforts,
    _remap_reasoning_effort,
)


class _Fake400(Exception):
    """Minimal exception that carries an HTTP status_code, like openai's APIError."""

    def __init__(self, msg: str, status_code: int = 400):
        super().__init__(msg)
        self.status_code = status_code


class _FakeModel:
    """Minimal LangChain-like model with a reasoning_effort field."""

    def __init__(self, effort=None, model_kwargs=None):
        self.reasoning_effort = effort
        self.model_kwargs = dict(model_kwargs or {})

    def model_copy(self, deep=False):
        clone = _FakeModel(self.reasoning_effort, dict(self.model_kwargs))
        return clone


# --- _is_reasoning_effort_error ---------------------------------------------

AGENTROUTER_400 = (
    "Error code: 400 - {'error': {'message': 'The request is invalid: "
    "该模型始终思考，不支持关闭思考；请使用 low、high 或 max。. Please check "
    "the request body, required fields, and request format.', "
    "'type': 'invalid_request_error'}}"
)


def test_detects_agentrouter_always_thinking_400():
    assert _is_reasoning_effort_error(_Fake400(AGENTROUTER_400))


def test_detects_english_always_thinking_400():
    exc = _Fake400(
        "Error code: 400 - this model always thinks; disabling thinking is "
        "not supported, use low, high or max"
    )
    assert _is_reasoning_effort_error(exc)


def test_ignores_temperature_400():
    assert not _is_reasoning_effort_error(
        _Fake400("Error code: 400 - temperature is not supported")
    )


def test_ignores_stream_options_400():
    assert not _is_reasoning_effort_error(
        _Fake400("Error code: 400 - unsupported parameter: stream_options")
    )


def test_ignores_non_400_status():
    assert not _is_reasoning_effort_error(_Fake400(AGENTROUTER_400, status_code=429))
    assert not _is_reasoning_effort_error(_Fake400(AGENTROUTER_400, status_code=500))


def test_parses_status_from_message_text():
    # No status_code attribute — the status must be parsed from the text.
    assert _is_reasoning_effort_error(Exception(AGENTROUTER_400))


# --- _remap_reasoning_effort -------------------------------------------------

def test_remaps_medium_to_high_when_low_high_max_allowed():
    model = _FakeModel(effort="medium")
    out = _remap_reasoning_effort(model, _Fake400(AGENTROUTER_400))
    assert out.reasoning_effort == "high"
    # The original model is untouched.
    assert model.reasoning_effort == "medium"


def test_remaps_high_to_max_when_max_allowed():
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, _Fake400(AGENTROUTER_400))
    assert out.reasoning_effort == "max"


def test_keeps_high_when_max_not_allowed():
    exc = _Fake400(
        "Error code: 400 - 该模型始终思考，不支持关闭思考；请使用 low 或 high。"
    )
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, exc)
    assert out.reasoning_effort == "high"


def test_remaps_low_to_low():
    model = _FakeModel(effort="low")
    out = _remap_reasoning_effort(model, _Fake400(AGENTROUTER_400))
    assert out.reasoning_effort == "low"


def test_no_effort_set_falls_to_weakest_allowed():
    model = _FakeModel(effort=None)
    out = _remap_reasoning_effort(model, _Fake400(AGENTROUTER_400))
    assert out.reasoning_effort == "low"


def test_effort_in_model_kwargs_is_remapped_too():
    model = _FakeModel(effort=None, model_kwargs={"reasoning_effort": "medium"})
    out = _remap_reasoning_effort(model, _Fake400(AGENTROUTER_400))
    assert out.reasoning_effort == "high"
    assert out.model_kwargs["reasoning_effort"] == "high"


# --- English "Supported values" parsing (the max-vs-xhigh provider split) ----

XHIGH_400 = (
    "Error code: 400 - {'error': {'message': \"Unsupported value: "
    "'reasoning_effort' does not support 'max' with this model. Supported "
    "values are: 'none', 'low', 'medium', 'high', and 'xhigh'. "
    "[trace_id=8c8]\", 'type': 'invalid_request_error', 'param': '', "
    "'code': None}}"
)


def test_detects_english_supported_values_400():
    assert _is_reasoning_effort_error(_Fake400(XHIGH_400))


def test_rejected_value_is_never_an_allowed_target():
    # The core regression: 'max' appears in the error text both as the REJECTED
    # value and (in other providers) as an allowed one. The parser must exclude
    # the rejected 'max' — remapping max -> max caused an infinite retry loop.
    model = _FakeModel(effort="max")
    out = _remap_reasoning_effort(model, _Fake400(XHIGH_400))
    # 'max' is rejected; the strongest remaining allowed rung is 'xhigh'.
    assert out.reasoning_effort == "xhigh"


def test_high_upgrades_to_xhigh_when_xhigh_allowed():
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, _Fake400(XHIGH_400))
    assert out.reasoning_effort == "xhigh"


def test_high_stays_high_when_only_max_allowed():
    # agentrouter-style: allowed = low/high/max → high upgrades to max.
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, _Fake400(AGENTROUTER_400))
    assert out.reasoning_effort == "max"


def test_high_upgrades_to_max_when_xhigh_not_listed():
    # Provider lists max but not xhigh: high is allowed → upgrade to max
    # (the strongest rung the route accepts).
    exc = _Fake400(
        "Error code: 400 - this model always thinks; unsupported value "
    "'medium' with this model. Supported values are: 'low', 'high', 'max'."
    )
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, exc)
    assert out.reasoning_effort == "max"


def test_rejected_current_maps_to_nearest_rung():
    # 'high' itself is rejected and only low/medium/max remain: the nearest
    # rung by ladder distance is medium (1 step down vs 2 up to max).
    exc = _Fake400(
        "Error code: 400 - this model always thinks; unsupported value "
    "'high' with this model. Supported values are: 'low', 'medium', 'max'."
    )
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, exc)
    assert out.reasoning_effort == "medium"


def test_medium_maps_to_nearest_when_xhigh_allowed():
    # medium IS in the allowed list → the user's pick is kept (only "high"
    # upgrades to a stronger rung). The rejected 'max' plays no role here.
    model = _FakeModel(effort="medium")
    out = _remap_reasoning_effort(model, _Fake400(XHIGH_400))
    assert out.reasoning_effort == "medium"


def test_none_effort_skips_off_rungs():
    # 'none' is listed as supported but means "off" — an always-thinking
    # route needs a real level; pick the weakest non-off allowed value.
    model = _FakeModel(effort=None)
    out = _remap_reasoning_effort(model, _Fake400(XHIGH_400))
    assert out.reasoning_effort == "low"


def test_bad_request_prefix_variant_is_parsed():
    # The same upstream error sometimes arrives prefixed with "Bad request:".
    exc = _Fake400(
        "Error code: 400 - {'error': {'message': \"Bad request: Unsupported "
        "value: 'reasoning_effort' does not support 'max' with this model. "
        "Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.\", "
        "'type': 'invalid_request_error'}}"
    )
    model = _FakeModel(effort="max")
    out = _remap_reasoning_effort(model, exc)
    assert out.reasoning_effort == "xhigh"


# --- river.ai generic invalid-request shape (no thinking wording) -----------

RIVER_400 = (
    "Error code: 400 - {'error': {'message': \"Invalid inference request. "
    "Check the model's supported parameters and input limits.\", "
    "'type': 'invalid_request_error', 'code': 'invalid_request'}}"
)


def test_detects_river_generic_invalid_request():
    # No thinking/effort wording — the VALUE-remap detector must NOT match
    # (it would loop remapping onto the same rejected value); the generic
    # invalid-request detector must match instead.
    assert not _is_reasoning_effort_error(_Fake400(RIVER_400))
    assert _is_reasoning_param_error(_Fake400(RIVER_400))


def test_river_remaps_medium_to_high_keeping_reasoning():
    # river.ai accepts only low/high/max (verified live): medium 400s with a
    # generic invalid-request message that lists NO allowed values. The remap
    # falls back to the {low,high,max} set and keeps reasoning ON by mapping
    # medium -> the nearest stronger rung (high) — never dropping the param.
    model = _FakeModel(effort="medium")
    out = _remap_reasoning_effort(model, _Fake400(RIVER_400))
    assert out.reasoning_effort == "high"


def test_river_remaps_none_to_low():
    model = _FakeModel(effort="none")
    out = _remap_reasoning_effort(model, _Fake400(RIVER_400))
    assert out.reasoning_effort == "low"


def test_river_keeps_high_untouched():
    # high is already accepted by river — the remap must keep it (upgrading
    # high -> max here would be wrong: max IS allowed, but the user picked
    # high and the request only failed for a different reason).
    model = _FakeModel(effort="high")
    out = _remap_reasoning_effort(model, _Fake400(RIVER_400))
    assert out.reasoning_effort == "max"


# --- Kimi K3 double-quote thinking_effort= shape ---

KIMI_400 = (
    "Error code: 400 - {'error': {'message': 'Unsupported Kimi K3 "
    'thinking_effort="xhigh"; supported values are low, high, and max\', '
    "'type': 'invalid_request_error', 'param': None, 'code': 400}}"
)


def test_detects_kimi_double_quote_400():
    assert _is_reasoning_effort_error(_Fake400(KIMI_400))


def test_kimi_xhigh_remaps_to_max():
    # The JSON tail contains 'None' (param) — it must not parse as allowed 'none'.
    assert _parse_allowed_efforts(_Fake400(KIMI_400)) == {"low", "high", "max"}
    model = _FakeModel(effort="xhigh")
    out = _remap_reasoning_effort(model, _Fake400(KIMI_400))
    assert out.reasoning_effort == "max"
