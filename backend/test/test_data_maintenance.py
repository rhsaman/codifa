"""Tests for Data & maintenance paths (data root + memory dir migration).

These guard the Settings -> Storage -> "Data & maintenance" panel so that
moving the data path (and the legacy memory/ folder cleanup) cannot silently
break. The actual file move is performed by the Electron main process; here we
verify the backend helpers it relies on behave correctly.
"""
import os
import tempfile
from pathlib import Path

import state_db


def test_data_root_uses_env_override(monkeypatch):
    """CODER_DATA_DIR wins and is created if missing."""
    with tempfile.TemporaryDirectory() as tmp:
        target = os.path.join(tmp, "new_root")
        monkeypatch.setenv("CODER_DATA_DIR", target)
        # clear any cached root
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        root = state_db.data_root()
        assert root == target
        assert os.path.isdir(root)


def test_data_root_falls_back_to_default(monkeypatch):
    """Without CODER_DATA_DIR it resolves to ~/.codifa (created)."""
    monkeypatch.delenv("CODER_DATA_DIR", raising=False)
    fake_home = tempfile.mkdtemp()
    monkeypatch.setattr(os.path, "expanduser", lambda p: p.replace("~", fake_home))
    monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
    root = state_db.data_root()
    assert root.endswith(".codifa")
    assert os.path.isdir(root)


def test_bootstrap_creates_core_dirs_without_memory(monkeypatch):
    """bootstrap() makes the essential dirs but no longer creates memory/."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        state_db.bootstrap()
        assert os.path.isdir(state_db.skills_dir())
        assert os.path.isdir(state_db.mcp_dir())
        assert os.path.isdir(state_db.plans_dir())
        assert os.path.isdir(state_db.models_dir())
        assert os.path.isdir(state_db.resume_dir())
        assert os.path.isdir(state_db.vector_db_dir())
        # memory/ must NOT be auto-created anymore (feature removed)
        assert not os.path.isdir(state_db.memory_dir())


def test_memory_dir_path_still_resolvable(monkeypatch):
    """memory_dir() still returns a path (for migration) but is not required."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        assert state_db.memory_dir().endswith("memory")


def test_migrate_memory_dir_moves_folder(monkeypatch):
    """A legacy memory/ folder is moved into the target root, source removed."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        src = state_db.memory_dir()
        os.makedirs(src, exist_ok=True)
        (Path(src) / "memories.jsonl").write_text("note\n", encoding="utf-8")

        target = os.path.join(tmp, "moved")
        os.makedirs(target, exist_ok=True)
        moved = state_db.migrate_memory_dir(target)

        assert moved is True
        assert os.path.isdir(os.path.join(target, "memory"))
        assert os.path.isfile(os.path.join(target, "memory", "memories.jsonl"))
        # source gone after move
        assert not os.path.isdir(src)


def test_migrate_memory_dir_noop_when_absent(monkeypatch):
    """When no legacy memory/ exists, migration is a safe no-op."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        target = os.path.join(tmp, "moved")
        os.makedirs(target, exist_ok=True)
        assert state_db.migrate_memory_dir(target) is False
