"""تست توابع workspace-summary در state_db."""
import json
import os

from state_db import (
    chats_dir,
    get_workspace_summary,
    iter_workspace_chats,
    save_workspace_summary,
    workspace_summaries_dir,
)


def test_save_and_get_roundtrip(tmp_path, monkeypatch):
    """ذخیره و بازخوانی summary باید roundtrip کامل باشد."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    save_workspace_summary("ws1", "bullet 1\nbullet 2", {"c1": 3, "c2": 5})
    out = get_workspace_summary("ws1")
    assert out is not None
    assert out["covered_message_counts"] == {"c1": 3, "c2": 5}
    assert "bullet 1" in out["content"]
    assert "bullet 2" in out["content"]


def test_get_missing_returns_none(tmp_path, monkeypatch):
    """برای workspace بدون summary باید None برگردد."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    assert get_workspace_summary("nope") is None


def test_empty_content_returns_none(tmp_path, monkeypatch):
    """summary خالی باید None برگرداند."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    save_workspace_summary("ws2", "   ", {})
    assert get_workspace_summary("ws2") is None


def test_iter_workspace_chats_counts_messages(tmp_path, monkeypatch):
    """iter_workspace_chats باید تعداد پیام هر chat را درست بشمارد."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    ws = "ws2"
    ws_dir = os.path.join(chats_dir(), ws)
    os.makedirs(ws_dir, exist_ok=True)
    with open(os.path.join(ws_dir, "chat-A.json"), "w") as fh:
        json.dump(
            {"history": [{"role": "user"}, {"role": "assistant"}]}, fh
        )
    with open(os.path.join(ws_dir, "chat-B.json"), "w") as fh:
        json.dump({"messages": [{"role": "user"}]}, fh)
    out = iter_workspace_chats(ws)
    counts = {c["chat_id"]: c["message_count"] for c in out}
    assert counts == {"chat-A": 2, "chat-B": 1}


def test_iter_workspace_chats_empty(tmp_path, monkeypatch):
    """برای workspace بدون chat باید لیست خالی برگردد."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    assert iter_workspace_chats("nonexistent") == []


def test_overwrite_summary(tmp_path, monkeypatch):
    """نوشتن مجدد summary باید قبلی را بازنویسی کند."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    save_workspace_summary("ws3", "first version", {"c1": 1})
    save_workspace_summary("ws3", "second version", {"c1": 5, "c2": 3})
    out = get_workspace_summary("ws3")
    assert out is not None
    assert "second version" in out["content"]
    assert "first version" not in out["content"]
    assert out["covered_message_counts"] == {"c1": 5, "c2": 3}


def test_workspace_summaries_dir_path(tmp_path, monkeypatch):
    """workspace_summaries_dir باید مسیر درست برگرداند."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    d = workspace_summaries_dir()
    assert d.endswith("workspace-summary")
    assert str(tmp_path) in d
