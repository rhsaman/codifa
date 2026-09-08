"""تست‌های seed کردن builtinهای MCP (docker + playwright) per-name.

``seed_builtin_mcp`` باید هر builtin غایب را seed کند (بدون بازنویسی
ورودی‌های موجود) و در خطای DB لیست خالی برگرداند.
"""
import json

import tools


class _FakeStateDb:
    def __init__(self, existing: dict | None = None, fail: bool = False):
        self.rows = dict(existing or {})
        self.fail = fail

    def list_mcp(self):
        if self.fail:
            raise RuntimeError("db down")
        return self.rows

    def save_mcp(self, name, cfg_json):
        if self.fail:
            raise RuntimeError("db down")
        self.rows[name] = json.loads(cfg_json)


def _run(monkeypatch, db):
    monkeypatch.setattr(tools, "_state_db", db)
    return tools.seed_builtin_mcp()


def test_seeds_all_builtins_on_empty_table(monkeypatch):
    db = _FakeStateDb()
    seeded = _run(monkeypatch, db)
    assert set(seeded) == {"docker", "playwright"}
    assert db.rows["playwright"]["command"] == "npx"
    assert db.rows["docker"]["command"] == "docker"


def test_seeds_only_missing_builtin(monkeypatch):
    # جدول موجود فقط docker دارد → فقط playwright seed شود
    db = _FakeStateDb({"docker": {"command": "docker", "args": ["mcp", "gateway", "run"]}})
    seeded = _run(monkeypatch, db)
    assert seeded == ["playwright"]
    assert "docker" in db.rows


def test_user_entry_with_builtin_name_not_overwritten(monkeypatch):
    # ورودی کاربر با نام playwright → seed آن skip شود و بازنویسی نشود
    user_cfg = {"command": "npx", "args": ["-y", "@playwright/mcp@0.0.1"]}
    db = _FakeStateDb({"playwright": user_cfg})
    seeded = _run(monkeypatch, db)
    assert "playwright" not in seeded
    assert db.rows["playwright"] == user_cfg


def test_db_error_returns_empty(monkeypatch):
    db = _FakeStateDb(fail=True)
    assert _run(monkeypatch, db) == []
