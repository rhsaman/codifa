"""The Laya download must leave the decision router usable.

The native router loads an ONNX graph, not the torch checkpoint the downloader
fetches, so a download that does not convert would leave the decision slot
silently dead. These tests pin the two halves of that contract: the export
command falls back to `uv run --with` when the venv lacks the toolchain, and a
converted model reports ready even after the torch weights are pruned.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import model_download  # noqa: E402


def test_export_command_uses_uv_when_the_toolchain_is_absent(monkeypatch):
    """Without onnx/onnxscript in the venv, the export runs through `uv run`."""
    monkeypatch.setattr(model_download.shutil, "which", lambda name: "/usr/bin/uv")
    cmd = model_download._export_command("/s/export.py", "/m/laya")
    assert cmd[:5] == ["/usr/bin/uv", "run", "--with", "onnx", "--with"]
    assert cmd[5] == "onnxscript"
    assert cmd[-4:] == ["/s/export.py", "--model-dir", "/m/laya", "--prune-weights"]


def test_export_command_falls_back_to_the_interpreter_without_uv(monkeypatch):
    """No uv on PATH must still produce a runnable command, not a crash."""
    monkeypatch.setattr(model_download.shutil, "which", lambda name: None)
    cmd = model_download._export_command("/s/export.py", "/m/laya")
    assert cmd[0] == sys.executable
    assert cmd[1:] == ["/s/export.py", "--model-dir", "/m/laya", "--prune-weights"]


def test_export_command_always_prunes_the_torch_weights(monkeypatch):
    """The checkpoints are export input only; leaving them costs ~2 GB."""
    monkeypatch.setattr(model_download.shutil, "which", lambda name: None)
    assert "--prune-weights" in model_download._export_command("/s/e.py", "/m/l")


def test_decision_ignore_skips_the_unused_sub_builds():
    """typed-decisions/eval/assets are never loaded by the router."""
    assert "typed-decisions/*" in model_download._DECISION_IGNORE
    assert "eval/*" in model_download._DECISION_IGNORE


def test_dir_has_weights_accepts_a_pruned_onnx_install(tmp_path):
    """A converted model whose torch weights were pruned still counts as ready."""
    onnx_dir = tmp_path / "onnx"
    onnx_dir.mkdir()
    (onnx_dir / "model.int8.onnx").write_bytes(b"x" * 16)
    assert model_download._dir_has_weights(str(tmp_path)) is True


def test_dir_has_weights_rejects_an_empty_dir(tmp_path):
    """A half-downloaded dir must keep offering Download (= resume)."""
    assert model_download._dir_has_weights(str(tmp_path)) is False
