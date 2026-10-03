"""Tripwire: a ready model dir that vanishes without remove() warns once."""

import json

import model_download


def _status_with_dirs(tmp_path, monkeypatch, dirs):
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    monkeypatch.setattr(model_download, "_raw_models_root", lambda: str(tmp_path))
    for d in dirs:
        (tmp_path / d).mkdir(exist_ok=True)
    monkeypatch.setattr(
        model_download, "embedding_dirs",
        lambda: [{"dir": d, "ready": True} for d in dirs],
    )
    monkeypatch.setattr(model_download, "laya_dirs", list)
    return model_download.status()


def test_tripwire_warns_on_external_deletion(tmp_path, monkeypatch, caplog):
    import logging

    model_download._REMOVED_BY_APP.clear()
    _status_with_dirs(tmp_path, monkeypatch, ["models--a"])
    watch = tmp_path.parent / "models-watch.json"
    assert watch.is_file(), "witness file must be written next to models/"
    saved = json.loads(watch.read_text())
    assert "models--a" in saved["ready"]

    # External deletion: dir gone, no remove() call.
    (tmp_path / "models--a").rmdir()
    with caplog.at_level(logging.WARNING, logger="models"):
        _status_with_dirs(tmp_path, monkeypatch, [])
    assert any("vanished WITHOUT a Codifa remove call" in r.message for r in caplog.records), [
        r.message for r in caplog.records
    ]

    # Warn-once: second poll stays quiet.
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="models"):
        _status_with_dirs(tmp_path, monkeypatch, [])
    assert not [r for r in caplog.records if "vanished WITHOUT" in r.message]


def test_tripwire_quiet_on_explicit_remove(tmp_path, monkeypatch, caplog):
    import logging

    model_download._REMOVED_BY_APP.clear()
    _status_with_dirs(tmp_path, monkeypatch, ["models--b"])
    assert model_download.remove("embedding", "x/y") in (True, False)
    model_download._REMOVED_BY_APP.add("models--b")
    (tmp_path / "models--b").rmdir()
    with caplog.at_level(logging.WARNING, logger="models"):
        _status_with_dirs(tmp_path, monkeypatch, [])
    assert not [r for r in caplog.records if "vanished WITHOUT" in r.message]
