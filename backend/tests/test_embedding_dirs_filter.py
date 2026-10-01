"""Laya checkpoints must never appear in the Settings Memory card.

Root cause: HF_HOME pointed at the shared models/ root, so Router.predict
auto-downloads created ``models--convaiinnovations--laya/`` there and
embedding_dirs() listed it as an "incomplete" embedding row.
"""
import os

import laya_decide
import model_download
from model_download import embedding_dirs, laya_dirs


def _make_models(tmp_path, monkeypatch):
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    # Ready embedding model (flat layout).
    emb = tmp_path / "models--intfloat--multilingual-e5-base"
    (emb / "onnx").mkdir(parents=True)
    (emb / "tokenizer.json").write_text("{}")
    (emb / "onnx" / "model.onnx").write_text("x")
    # Stale laya HF-cache orphan (the bug: listed as incomplete embedding).
    orphan = tmp_path / "models--convaiinnovations--laya"
    orphan.mkdir()
    (orphan / "config.json").write_text("{}")
    # Real laya checkpoint (must keep working on the laya side).
    laya = tmp_path / "laya--convaiinnovations--laya"
    laya.mkdir()
    (laya / "rl_agent_config.json").write_text("{}")
    return tmp_path


def test_embedding_dirs_excludes_laya_orphan(tmp_path, monkeypatch):
    _make_models(tmp_path, monkeypatch)
    dirs = embedding_dirs()
    assert [d["repo"] for d in dirs] == ["intfloat/multilingual-e5-base"]
    assert dirs[0]["ready"] is True


def test_laya_dirs_still_lists_checkpoint(tmp_path, monkeypatch):
    _make_models(tmp_path, monkeypatch)
    assert [d["repo"] for d in laya_dirs()] == ["convaiinnovations/laya"]


def test_router_cache_dir_isolated_from_embedding_scan(tmp_path, monkeypatch):
    _make_models(tmp_path, monkeypatch)
    cache = laya_decide._router_cache_dir()
    assert cache == os.path.join(str(tmp_path), "hub-cache")
    # Nested HF layout inside hub-cache stays invisible to the top-level scan.
    nested = tmp_path / "hub-cache" / "models--convaiinnovations--laya"
    nested.mkdir(parents=True)
    (nested / "config.json").write_text("{}")
    assert [d["repo"] for d in embedding_dirs()] == [
        "intfloat/multilingual-e5-base"
    ]


def test_migrate_moves_orphan_to_hub_cache(tmp_path, monkeypatch):
    _make_models(tmp_path, monkeypatch)
    model_download._migrate_laya_orphans(str(tmp_path))
    assert not (tmp_path / "models--convaiinnovations--laya").exists()
    moved = tmp_path / "hub-cache" / "models--convaiinnovations--laya"
    assert (moved / "config.json").is_file()
    # Idempotent: second run is a no-op, embedding stays clean.
    model_download._migrate_laya_orphans(str(tmp_path))
    assert [d["repo"] for d in embedding_dirs()] == [
        "intfloat/multilingual-e5-base"
    ]


def test_migrate_never_deletes_when_dest_exists(tmp_path, monkeypatch):
    _make_models(tmp_path, monkeypatch)
    dest = tmp_path / "hub-cache" / "models--convaiinnovations--laya"
    dest.mkdir(parents=True)
    (dest / "config.json").write_text("{}")
    model_download._migrate_laya_orphans(str(tmp_path))
    # Stale copy left alone (still excluded from the Memory card).
    assert (tmp_path / "models--convaiinnovations--laya").is_dir()
    assert [d["repo"] for d in embedding_dirs()] == [
        "intfloat/multilingual-e5-base"
    ]


def test_is_laya_repo(tmp_path, monkeypatch):
    assert model_download._is_laya_repo("convaiinnovations/laya")
    assert model_download._is_laya_repo("convaiinnovations/laya-multilingual")
    assert not model_download._is_laya_repo("intfloat/multilingual-e5-base")
    assert not model_download._is_laya_repo("")


def test_migrate_never_reenters_models_dir(tmp_path, monkeypatch):
    """_migrate_legacy_models runs under the non-reentrant _MIGRATE_LOCK:
    touching _models_dir() from the orphan migration hung the sidecar at
    startup. Any such call must fail loudly here instead of deadlocking."""
    def _boom():
        raise AssertionError("_models_dir called during migration")

    monkeypatch.setattr(model_download, "_models_dir", _boom)
    monkeypatch.setattr(model_download, "BACKEND_DIR", str(tmp_path))
    (tmp_path / "models--convaiinnovations--laya").mkdir()
    model_download._migrate_legacy_models(str(tmp_path))
    assert (tmp_path / "hub-cache" / "models--convaiinnovations--laya").is_dir()
