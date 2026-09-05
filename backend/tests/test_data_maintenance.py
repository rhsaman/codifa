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


def test_delete_chat_cascades_plan(monkeypatch):
    """Deleting a chat also removes its plan folder (no orphan left on disk)."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        state_db.bootstrap()

        root = os.path.join(tmp, "proj")
        os.makedirs(root, exist_ok=True)
        chat = {
            "id": "chat-1",
            "root": root,
            "updatedAt": 1.0,
            "messages": [],
        }
        state_db._write_chat(chat)
        state_db.save_plan(state_db._chat_workspace(chat), "plan", "## Plan\nstep", chat_id="chat-1")

        plan_dir = state_db._plan_dir(state_db._chat_workspace(chat), "chat-1")
        assert os.path.isdir(plan_dir)

        state_db._delete_chat_by_id("chat-1")
        assert not os.path.isdir(plan_dir)


def test_remove_workspace_vectors_cascades_plan(monkeypatch):
    """Removing a workspace also drops its whole plan folder."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        state_db.bootstrap()

        root = os.path.join(tmp, "proj")
        os.makedirs(root, exist_ok=True)
        chat = {"id": "chat-1", "root": root, "updatedAt": 1.0, "messages": []}
        state_db._write_chat(chat)
        ws = state_db._chat_workspace(chat)
        state_db.save_plan(ws, "plan", "## Plan\nstep", chat_id="chat-1")

        plan_ws = os.path.join(state_db.plans_dir(), ws)
        assert os.path.isdir(plan_ws)

        state_db.remove_workspace_vectors([root])
        assert not os.path.isdir(plan_ws)


def test_prune_orphan_plans_removes_stale_folders(monkeypatch):
    """prune_orphan_plans() deletes plan folders with no matching live chat."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        state_db.bootstrap()

        root = os.path.join(tmp, "proj")
        os.makedirs(root, exist_ok=True)
        chat = {"id": "chat-1", "root": root, "updatedAt": 1.0, "messages": []}
        state_db._write_chat(chat)
        ws = state_db._chat_workspace(chat)

        # live chat plan — must survive
        state_db.save_plan(ws, "plan", "## Plan\nlive", chat_id="chat-1")
        # orphaned chat plan (no matching chat) — must be pruned
        orphan_dir = state_db._plan_dir(ws, "ghost-chat")
        os.makedirs(orphan_dir, exist_ok=True)
        (Path(orphan_dir) / "plan.md").write_text("## Plan\nghost", encoding="utf-8")
        # whole-workspace plan folder with no live chat — must be pruned
        dead_ws = os.path.join(state_db.plans_dir(), "dead-workspace")
        os.makedirs(dead_ws, exist_ok=True)
        (Path(dead_ws) / "plan.md").write_text("## Plan\ndead", encoding="utf-8")

        removed = state_db.prune_orphan_plans()
        assert removed == 2
        assert os.path.isdir(state_db._plan_dir(ws, "chat-1"))
        assert not os.path.isdir(orphan_dir)
        assert not os.path.isdir(dead_ws)


def test_run_cleanup_purges_expired_result_cache(monkeypatch):
    """run_cleanup() must purge expired entries from the tool-result cache
    (cache.sqlite). Lazy purge on read only removes keys that are read again;
    entries never re-read would otherwise keep the file growing forever."""
    import time as _time

    import state_db
    from cache import Cache, cache_path_for
    from cleanup import run_cleanup

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        monkeypatch.setattr(state_db, "_root_cache", None, raising=False)
        state_db.bootstrap()

        c = Cache(cache_path_for(state_db.data_root()))
        c.set("expired", "old", ttl_seconds=1)
        c.set("fresh", "new", ttl_seconds=3600)
        c.close()
        _time.sleep(1.1)  # let the short TTL lapse

        report = run_cleanup(store=None, root="")

        assert report["cache_purged"] == 1
        # the fresh entry survives
        c2 = Cache(cache_path_for(state_db.data_root()))
        try:
            assert c2.get("fresh") == "new"
            assert c2.get("expired") is None
        finally:
            c2.close()


def test_run_cleanup_cache_purge_never_raises(monkeypatch):
    """A broken data root (or locked cache.sqlite) must not crash cleanup —
    the step is best-effort like every other one."""
    import cleanup

    def _boom(*_a, **_k):
        raise RuntimeError("cache unavailable")

    # Cache construction fails inside _purge_result_cache; its try/except must
    # swallow that and report 0 instead of crashing the whole cleanup pass.
    monkeypatch.setattr("cache.Cache", _boom, raising=False)
    report = cleanup.run_cleanup(store=None, root="")
    assert report["cache_purged"] == 0
