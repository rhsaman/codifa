"""تست ران‌های یتیم: حذف تسک نباید تاریخچه را پاک کند، ولی تابع جدید باید آن را جمع کند."""

from __future__ import annotations

import state_db


def test_orphan_runs_survive_delete_then_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    task = state_db.save_schedule({"name": "t", "prompt": "p", "cron": ""})
    live = state_db.save_schedule({"name": "live", "prompt": "p", "cron": ""})
    state_db.save_schedule_run({"schedule_id": task["id"], "status": "done", "started_at": 100.0})
    state_db.save_schedule_run({"schedule_id": live["id"], "status": "done", "started_at": 200.0})
    assert state_db.delete_schedule(task["id"])
    # تاریخچه تسک حذف‌شده می‌ماند (یتیم)
    assert len(state_db.list_schedule_runs("", limit=100)) == 2
    assert state_db.delete_orphan_schedule_runs() == 1
    remaining = state_db.list_schedule_runs("", limit=100)
    assert len(remaining) == 1
    assert remaining[0]["schedule_id"] == live["id"]


def test_delete_single_schedule_run(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    task = state_db.save_schedule({"name": "t", "prompt": "p", "cron": ""})
    run = state_db.save_schedule_run({"schedule_id": task["id"], "status": "done", "started_at": 100.0})
    assert state_db.delete_schedule_run(run["id"])
    assert state_db.list_schedule_runs(task["id"]) == []
    assert not state_db.delete_schedule_run("no-such-run")
    assert not state_db.delete_schedule_run("")
