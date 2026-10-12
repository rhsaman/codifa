"""Managed model dirs listed for the Settings cards (embedding / decision)."""

import model_download
from model_download import embedding_dirs


def _make_models(tmp_path):
    emb = tmp_path / "models--intfloat--multilingual-e5-base"
    (emb / "onnx").mkdir(parents=True)
    (emb / "tokenizer.json").write_text("{}")
    (emb / "onnx" / "model.onnx").write_text("x")
    return tmp_path


def test_embedding_dirs_lists_ready_model(tmp_path, monkeypatch):
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    _make_models(tmp_path)
    dirs = embedding_dirs()
    assert [d["repo"] for d in dirs] == ["intfloat/multilingual-e5-base"]
    assert dirs[0]["ready"] is True


def test_embedding_dirs_empty_without_models(tmp_path, monkeypatch):
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    assert embedding_dirs() == []


def test_decision_dirs_lists_only_ready_laya(tmp_path, monkeypatch):
    # The decision card tracks ONE repo (Laya); other models-- builds (e.g.
    # an embedding repo) must not leak into it, and vice versa. Ready = a
    # non-empty weights file (safetensors/bin/onnx), not just configs.
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    laya = tmp_path / "laya--convaiinnovations--laya"
    laya.mkdir()
    (laya / "model.safetensors").write_text("x")
    (tmp_path / "models--intfloat--multilingual-e5-base").mkdir()
    # A leftover pre-fix placeholder must not leak onto the decision card.
    (tmp_path / "models--convaiinnovations--laya").mkdir()
    dirs = model_download.decision_dirs()
    assert [d["repo"] for d in dirs] == ["convaiinnovations/laya"]
    assert dirs[0]["dir"] == "laya--convaiinnovations--laya"
    assert dirs[0]["ready"] is True
    # Laya never shows up on the embedding (Memory) card.
    assert all(d["repo"] != "convaiinnovations/laya" for d in embedding_dirs())


def test_decision_partial_dir_not_ready_and_status_section(tmp_path, monkeypatch):
    # A half-downloaded dir (configs only, no weights) reports ready=False so
    # the card keeps offering Download (= resume via HTTP Range), and
    # status() exposes the decision section for the Settings poll.
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    monkeypatch.setattr(model_download, "_raw_models_root", lambda: str(tmp_path))
    laya = tmp_path / "laya--convaiinnovations--laya"
    laya.mkdir()
    (laya / "config.json").write_text("{}")
    st = model_download.status()
    assert st["decision"]["dirs"][0]["ready"] is False
    assert "running" not in st["decision"]


def test_decision_legacy_models_dir_renamed(tmp_path, monkeypatch):
    # Pre-fix downloads lived under models--<repo>; the startup rename moves
    # them to the release layout so the model keeps being found.
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    old = tmp_path / "models--convaiinnovations--laya"
    old.mkdir()
    (old / "model.safetensors").write_text("x")
    model_download._migrate_decision_dir_name(str(tmp_path))
    assert not old.exists()
    assert (
        model_download.decision_model_dir()
        == str(tmp_path / "laya--convaiinnovations--laya")
    )
