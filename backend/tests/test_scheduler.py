"""تست‌های زمان‌بند تسک‌ها: کرون/preset در scheduler.py و ذخیره فایلی در state_db."""

from __future__ import annotations

import scheduler
import state_db


def test_normalize_cron_presets():
    assert scheduler.normalize_cron("") == ""
    assert scheduler.normalize_cron("once") == ""
    assert scheduler.normalize_cron("hourly") == "0 * * * *"
    assert scheduler.normalize_cron("daily") == "0 9 * * *"
    assert scheduler.normalize_cron("weekly") == "0 9 * * 1"
    assert scheduler.normalize_cron("every 15 minutes") == "*/15 * * * *"
    assert scheduler.normalize_cron("every 2 hours") == "0 */2 * * *"
    assert scheduler.normalize_cron("0 9 * * *") == "0 9 * * *"


def test_normalize_cron_invalid():
    import pytest

    with pytest.raises(ValueError):
        scheduler.normalize_cron("هر روز صبح")


def test_next_run_after_daily():
    # ۲۰۲۶-۰۱-۰۱ ساعت ۰۸:۰۰ UTC → نوبت بعدی روزانه ۹ صبح همان روز
    from datetime import datetime, timezone

    base = datetime(2026, 1, 1, 8, 0, tzinfo=timezone.utc).timestamp()
    nxt = scheduler.next_run_after("0 9 * * *", base)
    assert nxt is not None
    dt = datetime.fromtimestamp(nxt, tz=timezone.utc)
    assert (dt.hour, dt.minute) == (9, 0)
    assert dt.day == 1
    # بعد از ۹ صبح → فردا
    base2 = datetime(2026, 1, 1, 10, 0, tzinfo=timezone.utc).timestamp()
    nxt2 = scheduler.next_run_after("0 9 * * *", base2)
    dt2 = datetime.fromtimestamp(nxt2, tz=timezone.utc)
    assert dt2.day == 2 and (dt2.hour, dt2.minute) == (9, 0)


def test_next_run_every_15_minutes():
    from datetime import datetime, timezone

    base = datetime(2026, 1, 1, 8, 7, tzinfo=timezone.utc).timestamp()
    nxt = scheduler.next_run_after("*/15 * * * *", base)
    dt = datetime.fromtimestamp(nxt, tz=timezone.utc)
    assert dt.minute == 15 and dt.hour == 8


def test_compute_next_run_once_task():
    task = {"enabled": True, "cron": "", "last_run": 0}
    assert scheduler.compute_next_run(task, now=1000.0) == 1000.0
    task2 = {"enabled": True, "cron": "", "last_run": 900.0}
    assert scheduler.compute_next_run(task2, now=1000.0) is None
    task3 = {"enabled": False, "cron": "0 9 * * *"}
    assert scheduler.compute_next_run(task3, now=1000.0) is None


def test_compute_next_run_resume_skips_missed():
    # resume پس از مکث طولانی: last_run قدیمی نباید catch-up burst بسازد؛
    # نوبت بعدی همیشه از max(last_run, now) جلو می‌رود.
    from datetime import datetime, timezone

    now = datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc).timestamp()
    old_last = datetime(2026, 1, 1, 8, 0, tzinfo=timezone.utc).timestamp()
    task = {"enabled": True, "cron": "*/15 * * * *", "last_run": old_last}
    nxt = scheduler.compute_next_run(task, now=now)
    assert nxt is not None and nxt > now
    # is_due با next_run ذخیره‌شده قدیمی (stale) نباید due شود
    stale = {"enabled": True, "cron": "*/15 * * * *", "last_run": old_last, "next_run": old_last + 60}
    assert not scheduler.is_due(stale, now=now)


def test_delete_schedule_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    task = state_db.save_schedule({"name": "t", "prompt": "p", "cron": ""})
    state_db.save_schedule_run({"schedule_id": task["id"], "status": "done", "started_at": 100.0})
    state_db.save_schedule_run({"schedule_id": task["id"], "status": "done", "started_at": 200.0})
    assert len(state_db.list_schedule_runs(task["id"])) == 2
    assert state_db.delete_schedule_runs(task["id"]) == 2
    assert state_db.list_schedule_runs(task["id"]) == []


def test_save_schedule_drops_stale_next_run(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    saved = state_db.save_schedule({
        "name": "t", "prompt": "p", "cron": "*/15 * * * *",
        "last_run": 100.0, "next_run": 200.0,
    })
    # next_run گذشته نباید روی دیسک بماند (پنل ساعت گذشته نشان می‌داد)
    assert "next_run" not in saved


def test_is_due_with_next_run():
    assert scheduler.is_due({"enabled": True, "cron": "", "next_run": 500}, now=1000.0)
    assert not scheduler.is_due({"enabled": True, "cron": "", "next_run": 1500}, now=1000.0)
    assert not scheduler.is_due({"enabled": False, "cron": "", "next_run": 500}, now=1000.0)


def test_is_due_recurring_stored_next_run():
    # باگ اصلی: next_run ذخیره‌شده‌ای که تازه گذشته باید due شود.
    now = 1000.0
    due = {"enabled": True, "cron": "*/15 * * * *", "last_run": 100.0, "next_run": now - 10}
    assert scheduler.is_due(due, now=now)
    # آینده → هنوز نرسیده
    future = {"enabled": True, "cron": "*/15 * * * *", "last_run": 100.0, "next_run": now + 600}
    assert not scheduler.is_due(future, now=now)
    # بدون next_run → False (حلقه heal می‌کند، بدون burst فوری)
    missing = {"enabled": True, "cron": "*/15 * * * *", "last_run": 100.0}
    assert not scheduler.is_due(missing, now=now)
    # stale خیلی قدیمی (missed دوران مکث) → False، بدون catch-up
    stale = {"enabled": True, "cron": "*/15 * * * *", "last_run": 100.0, "next_run": now - 80000}
    assert not scheduler.is_due(stale, now=now)
    # once هرگز اجرا نشده → True؛ اجرا شده → False
    assert scheduler.is_due({"enabled": True, "cron": ""}, now=now)
    assert not scheduler.is_due({"enabled": True, "cron": "", "last_run": 900.0}, now=now)


def test_schedule_crud_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    saved = state_db.save_schedule({"name": "گزارش", "prompt": "گزارش بده", "cron": "0 9 * * *"})
    assert saved["id"]
    assert state_db.get_schedule(saved["id"])["prompt"] == "گزارش بده"
    assert len(state_db.list_schedules()) == 1
    assert state_db.delete_schedule(saved["id"])
    assert state_db.get_schedule(saved["id"]) is None
    assert state_db.list_schedules() == []


def test_schedule_run_history(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    task = state_db.save_schedule({"name": "t", "prompt": "p", "cron": ""})
    r1 = state_db.save_schedule_run({"schedule_id": task["id"], "status": "done", "started_at": 100.0})
    state_db.save_schedule_run({"schedule_id": task["id"], "status": "error", "started_at": 200.0})
    runs = state_db.list_schedule_runs(task["id"])
    assert len(runs) == 2
    # جدیدترین اول
    assert runs[0]["started_at"] == 200.0
    # prune فقط یکی نگه می‌دارد
    assert state_db.prune_schedule_runs(task["id"], keep=1) == 1
    assert len(state_db.list_schedule_runs(task["id"])) == 1
    assert r1["id"]


def test_run_due_schedules_heals_missing_next_run(tmp_path, monkeypatch):
    # تسک تکراری بدون next_run ذخیره‌شده: اجرا نمی‌شود ولی next_run تازه
    # persist می‌شود تا در نوبت بعدی سر وقتش اجرا شود (گیر نمی‌کند).
    import asyncio
    import time

    import server

    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    now = time.time()
    task = state_db.save_schedule({"name": "t", "prompt": "p", "cron": "*/15 * * * *"})
    assert "next_run" not in task
    started = asyncio.run(server._run_due_schedules(now=now))
    assert started == 0
    healed = state_db.get_schedule(task["id"])
    assert healed is not None
    assert float(healed.get("next_run") or 0) > now


def test_run_due_schedules_starts_due_task(tmp_path, monkeypatch):
    # تسک با next_run ذخیره‌شده تازه‌گذشته: حلقه اجرایش را شروع می‌کند.
    import asyncio
    import time

    import server

    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    monkeypatch.setattr(server, "_has_recent_running", lambda _sid, _now: False)
    calls: list[str] = []

    async def _fake_execute(schedule_id: str, run_id: str | None = None) -> None:
        calls.append(schedule_id)

    monkeypatch.setattr(server, "_execute_schedule", _fake_execute)
    now = time.time()
    task = state_db.save_schedule({"name": "t", "prompt": "p", "cron": "*/15 * * * *"})
    # next_run را مستقیم روی دیسک بگذار (save_schedule مقدار گذشته را پاک می‌کند)
    raw = dict(state_db.get_schedule(task["id"]) or {})
    raw["next_run"] = now - 10
    state_db._atomic_write_json(state_db._schedule_file(task["id"]), raw)
    started = asyncio.run(server._run_due_schedules(now=now))
    assert started == 1
    assert calls == [task["id"]]
