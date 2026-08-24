"""Unit test: opencode model-id handling in qualify_model_id.

opencode.ai/zen accepts the model id EXACTLY as stored — both bare ids
(e.g. "hy3-free") and provider-prefixed ids (e.g. "opencode/claude-3.5-sonnet")
work in the form the UI saves them. We must NOT add a prefix ("opencode/<id>"
is rejected with HTTP 401 "Model is not supported") nor strip one. qualify_model_id
therefore passes opencode ids through unchanged.
"""
import os
import tempfile

# Hermetic data root BEFORE importing anything that touches state_db.
_TMP = tempfile.mkdtemp(prefix="coder-test-opencode-id-")
os.environ["CODER_DATA_DIR"] = _TMP

from providers import qualify_model_id  # noqa: E402


def test_opencode_bare_id_is_passed_through():
    # The compact / subagent / manual-compact bare id from the UI must NOT be
    # turned into "opencode/<id>" — opencode.ai/zen rejects that with 401.
    assert qualify_model_id("opencode", "hy3-free") == "hy3-free"


def test_opencode_prefixed_id_is_passed_through():
    # A model the user picked as "opencode/claude-3.5-sonnet" is already valid;
    # qualify must not mangle it.
    assert (
        qualify_model_id("opencode", "opencode/claude-3.5-sonnet")
        == "opencode/claude-3.5-sonnet"
    )


def test_opencode_does_not_add_prefix_unlike_nvidia():
    # Contrast: nvidia DOES require its provider prefix; opencode must not.
    assert qualify_model_id("nvidia", "nemotron-mini") == "nvidia/nemotron-mini"
    assert qualify_model_id("opencode", "nemotron-mini") == "nemotron-mini"


def test_empty_model_passes_through():
    assert qualify_model_id("opencode", "") == ""


if __name__ == "__main__":
    test_opencode_bare_id_is_passed_through()
    test_opencode_prefixed_id_is_passed_through()
    test_opencode_does_not_add_prefix_unlike_nvidia()
    test_empty_model_passes_through()
    print("ok")
