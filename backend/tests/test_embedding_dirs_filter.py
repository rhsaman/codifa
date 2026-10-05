"""Embedding model dirs listed for the Settings Memory card."""

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
