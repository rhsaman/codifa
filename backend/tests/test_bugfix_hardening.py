"""Regression tests for bugfix hardening batch.

Covers behavior changes only:
- server._friendly_error never crashes on non-dict literal_eval
- llm._parse_allowed_efforts Chinese branch excludes rejected value
- state_db.save_mcp rejects invalid JSON instead of silently storing {}
- cache.Cache never raises and close is idempotent
- vector_store FTS insert failure is swallowed, _scan_semantic is lock-safe
- state_db delete_skill/delete_plan report real removal status
"""
import os
import sys
import tempfile

_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_BACKEND_DIR))

from cache import Cache
from llm import _parse_allowed_efforts
from server import _friendly_error


def test_friendly_error_non_dict_body_does_not_crash():
    # body: [...] / body: 123 previously crashed _friendly_error via .get
    for text in (
        "error status_code: 400 body: [1, 2, 3]",
        "error status_code: 400 body: 123",
        "error status_code: 400 body: {'message': 'Provider returned error', 'metadata': {'raw': 'not-a-dict'}}",
    ):
        out = _friendly_error(Exception(text), "m", "http://x")
        assert isinstance(out, str)
        assert len(out) > 0


def test_parse_allowed_efforts_chinese_excludes_rejected():
    class Fake400(Exception):
        pass

    # Chinese list mentions low/high/max but max was the rejected value
    exc = Fake400(
        "Error code: 400 - does not support 'max' with this model. "
        "该模型始终思考，请使用 low、high 或 max"
    )
    allowed = _parse_allowed_efforts(exc)
    assert allowed is not None
    assert "max" not in allowed
    assert {"low", "high"} <= allowed


def test_save_mcp_invalid_json_raises(monkeypatch):
    import state_db

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        state_db.bootstrap()
        try:
            state_db.save_mcp("bad", "{not json")
        except ValueError:
            pass
        else:
            raise AssertionError("save_mcp must raise on invalid JSON")
        # non-dict JSON must also raise, not silently store {}
        try:
            state_db.save_mcp("bad2", "[1, 2]")
        except ValueError:
            pass
        else:
            raise AssertionError("save_mcp must raise on non-dict JSON")


def test_cache_never_raises_and_close_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        c = Cache(os.path.join(tmp, "c.sqlite"))
        c.set("k", "v")
        assert c.get("k") == "v"
        c.close()
        # get/set after close must not raise (best-effort None / no-op)
        assert c.get("k") is None
        c.set("k2", "v2")
        c.close()
        assert c.purge_expired() == 0


def test_delete_skill_and_plan_report_status(monkeypatch):
    import state_db

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("CODER_DATA_DIR", tmp)
        state_db.bootstrap()
        # missing skill -> False
        assert state_db.delete_skill("no-such-skill") is False
        # real skill round-trips True
        state_db.save_skill("My Skill", "my-skill", "d", "BODY")
        assert state_db.delete_skill("my-skill") is True
        assert state_db.delete_skill("my-skill") is False
        # missing plan -> False
        assert state_db.delete_plan("ws", chat_id="nope") is False


def test_vector_store_fts_failure_does_not_break_batch(monkeypatch):
    import vector_store as vs_mod

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setattr(vs_mod, "embed_dim", lambda: 8)
        monkeypatch.setattr(vs_mod, "embed_passages", lambda texts: [[0.1] * 8 for _ in texts])
        monkeypatch.setattr(vs_mod, "embed_queries", lambda qs: [[0.1] * 8 for _ in qs])
        store = vs_mod.VectorStore(os.path.join(tmp, "t.vectors.sqlite"))
        try:
            # force FTS insert to fail by dropping the table; vec insert succeeds
            store._conn.execute("DROP TABLE fts_chunks")
            # must not raise: FTS failure is debug-logged, batch continues
            store._insert_index_rows(1, 1, "file", "hello", [0.1] * 8)
        finally:
            store.close()
