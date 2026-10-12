"""Uploaded-file access: attachments under the app data root resolve.

Picking a file from OUTSIDE the workspace copies it into ``<data
root>/uploads`` (electron ``file:import``); the backend must treat that path
as readable via ``allow_coder`` instead of rejecting it as a workspace
escape. Arbitrary outside paths stay rejected. Every file inside the
workspace resolves without any permission gate.
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import tempfile

import pytest

import state_db
from tools import PathEscapeError, resolve_safe


def _isolate_temp(monkeypatch, tmp_path):
    """Point the temp-dir gate at an empty dir so tmp_path files prove the real gate."""
    fake_temp = tmp_path / "fake-temp"
    fake_temp.mkdir(exist_ok=True)
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(fake_temp))
    return fake_temp


def test_workspace_files_resolve_without_gate(tmp_path, monkeypatch):
    root = str(tmp_path / "proj")
    os.makedirs(os.path.join(root, "src"))
    target = os.path.join(root, "src", "app.py")
    with open(target, "w", encoding="utf-8") as fh:
        fh.write("x = 1\n")
    _isolate_temp(monkeypatch, tmp_path)
    # Relative and absolute workspace paths need no permit.
    assert resolve_safe(root, "src/app.py") == os.path.realpath(target)
    assert resolve_safe(root, os.path.realpath(target)) == os.path.realpath(target)


def test_upload_attachment_under_data_root_resolves(tmp_path, monkeypatch):
    root = str(tmp_path / "proj")
    os.makedirs(os.path.join(root, "src"))
    _isolate_temp(monkeypatch, tmp_path)
    data = str(tmp_path / "data")
    monkeypatch.setenv("CODER_DATA_DIR", data)
    uploads = os.path.join(state_db.data_root(), "uploads")
    os.makedirs(uploads, exist_ok=True)
    uploaded = os.path.join(uploads, "notes.txt")
    with open(uploaded, "w", encoding="utf-8") as fh:
        fh.write("hello")

    # Readable through the coder-data gate, never a permission prompt.
    assert resolve_safe(root, os.path.realpath(uploaded), allow_coder=True) == os.path.realpath(uploaded)
    # Without the gate it is still an outside path.
    with pytest.raises(PathEscapeError):
        resolve_safe(root, os.path.realpath(uploaded))


def test_outside_attachment_outside_data_root_stays_rejected(tmp_path, monkeypatch):
    root = str(tmp_path / "proj")
    os.makedirs(root)
    _isolate_temp(monkeypatch, tmp_path)
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    outside_dir = os.path.join(str(tmp_path), "elsewhere")
    outside = os.path.join(outside_dir, "secret.txt")
    os.makedirs(outside_dir)
    with open(outside, "w", encoding="utf-8") as fh:
        fh.write("x")

    with pytest.raises(PathEscapeError):
        resolve_safe(root, os.path.realpath(outside), allow_coder=True)
    with pytest.raises(PathEscapeError):
        resolve_safe(root, os.path.realpath(outside))
