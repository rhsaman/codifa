"""Uploaded-file scoping: attachments under the app data root resolve.

Picking a file from OUTSIDE the workspace copies it into ``<data
root>/uploads`` (electron ``file:import``); the backend must treat that path
as readable scope (``allow_coder``) instead of rejecting it as a workspace
escape. Arbitrary outside paths stay rejected.
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import state_db
from agents import _scoped_rels
from tools import resolve_safe


def test_upload_attachment_under_data_root_is_scoped(tmp_path):
    root = str(tmp_path / "proj")
    os.makedirs(os.path.join(root, "src"))
    uploads = os.path.join(state_db.data_root(), "uploads")
    os.makedirs(uploads, exist_ok=True)
    uploaded = os.path.join(uploads, "notes.txt")
    with open(uploaded, "w", encoding="utf-8") as fh:
        fh.write("hello")

    rels = _scoped_rels(root, [uploaded], "")
    assert rels, "data-root upload must stay in scope"
    rel = next(r for r in rels if not r.startswith(os.sep))
    assert rel.replace("\\", "/").endswith("uploads/notes.txt")
    # The scoped set must ALSO carry the absolute form — the ATTACHED FILES
    # note shows outside uploads by absolute path, and the model passes the
    # path it was shown back to the scoped search tools.
    assert os.path.realpath(uploaded) in rels
    # The scoped rel path must resolve back through the read tools' gate.
    assert resolve_safe(root, rel, allow_coder=True) == os.path.realpath(uploaded)


def test_outside_attachment_outside_data_root_stays_rejected(tmp_path):
    root = str(tmp_path / "proj")
    os.makedirs(root)
    outside_dir = os.path.join(str(tmp_path), "elsewhere")
    outside = os.path.join(outside_dir, "secret.txt")
    os.makedirs(outside_dir)
    with open(outside, "w", encoding="utf-8") as fh:
        fh.write("x")

    assert _scoped_rels(root, [outside], "") == set()
