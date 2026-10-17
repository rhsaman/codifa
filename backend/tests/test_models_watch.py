"""Tripwire: a ready model dir that vanishes without remove() warns once."""

import json
import shutil

import model_download


def _status_with_dirs(tmp_path, monkeypatch, dirs):
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    monkeypatch.setattr(model_download, "_raw_models_root", lambda: str(tmp_path))
    for d in dirs:
        (tmp_path / d).mkdir(exist_ok=True)
        # A non-empty weight file is what makes a dir count as ready.
        (tmp_path / d / "model.bin").write_text("x")
    monkeypatch.setattr(
        model_download, "whisper_dir",
        lambda: str(tmp_path / dirs[0]) if dirs else str(tmp_path / "whisper"),
    )
    return model_download.status()


def test_tripwire_warns_on_external_deletion(tmp_path, monkeypatch, caplog):
    import logging

    model_download._REMOVED_BY_APP.clear()
    _status_with_dirs(tmp_path, monkeypatch, ["whisper"])
    watch = tmp_path.parent / "models-watch.json"
    assert watch.is_file(), "witness file must be written next to models/"
    saved = json.loads(watch.read_text())
    assert "whisper" in saved["ready"]

    # External deletion: dir gone, no remove() call.
    shutil.rmtree(tmp_path / "whisper")
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
    _status_with_dirs(tmp_path, monkeypatch, ["whisper"])
    # An explicit remove() must not be reported as an external deletion.
    model_download.remove("whisper", "x/y")
    model_download._REMOVED_BY_APP.add("whisper")
    with caplog.at_level(logging.WARNING, logger="models"):
        _status_with_dirs(tmp_path, monkeypatch, [])
    assert not [r for r in caplog.records if "vanished WITHOUT" in r.message]
