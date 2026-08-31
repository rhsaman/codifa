"""Tests: _friendly_error unwraps the OpenRouter / ai-gateway nested error.

When a provider wraps an upstream-provider failure as a 400 with body
``{"message": "Provider returned error", "metadata": {"raw": "..."}}``, the
outer message is the generic wrapper. The real failure is inside
``metadata.raw`` as an escaped JSON string. Without unwrapping, the user sees
the useless "Provider returned error" instead of the actual upstream error
(e.g. "Backend request failed with status 400").
"""
import os
import sys

_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_BACKEND_DIR))

from server import _friendly_error


def test_friendly_error_unwraps_metadata_raw():
    """Outer 'Provider returned error' + inner 'Backend request failed...':
    the returned text must surface the inner error, not the generic wrapper."""
    exc = Exception(
        "Error code: 400 - {'error': {'message': 'Provider returned error', "
        "'code': 400, 'metadata': {'raw': "
        "'{\\\"error\\\":{\\\"message\\\":\\\"Backend request failed with status 400\\\","
        "\\\"type\\\":\\\"backend_error\\\",\\\"code\\\":400}'"
        "}}'"
    )
    result = _friendly_error(exc, model="minimax/minimax-m3:free")
    # The actionable inner message must appear in the output — "Backend request
    # failed" is what tells the user the upstream hiccuped (and why the
    # retry loop can recover).
    assert "Backend request failed" in result, (
        f"Inner upstream error must be unwrapped from metadata.raw, got: {result!r}"
    )
    # The generic wrapper alone ("Provider returned error") is what the
    # user complained about — must NOT be the entire message.
    assert result != "Provider returned error", (
        "Result must include more context than the generic wrapper"
    )


def test_friendly_error_keeps_outer_when_meaningful():
    """When the outer message is already meaningful (not the generic wrapper),
    it should be kept verbatim — don't dig into metadata.raw and lose the
    gateway's specific error text."""
    exc = Exception(
        "Error code: 429 - {'error': {'message': 'Rate limit exceeded: 5 req/s', "
        "'code': 429, 'metadata': {'raw': '{\\\"error\\\":{\\\"message\\\":"
        "\\\"some upstream thing\\\"}'}}'"
    )
    result = _friendly_error(exc, model="minimax/minimax-m3:free")
    assert "Rate limit exceeded" in result, result
