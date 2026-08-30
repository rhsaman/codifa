"""Tests for de-duplication of chat files by id in ``state_db._iter_chat_files``."""

from __future__ import annotations

import json
import os

import state_db


def _write_chat(root: str, ws: str, cid: str, updated_at: float, title: str) -> str:
    ws_dir = os.path.join(root, "chats", ws)
    os.makedirs(ws_dir, exist_ok=True)
    path = os.path.join(ws_dir, f"{cid}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(
            {"id": cid, "title": title, "updatedAt": updated_at, "messages": []},
            fh,
        )
    return path


def test_iter_chat_files_dedupes_same_id_across_workspaces(tmp_path, monkeypatch):
    """Two files with the same chat id must yield exactly one object."""
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    _write_chat(str(tmp_path), "ws-a", "dup-id", 100.0, "older")
    _write_chat(str(tmp_path), "ws-b", "dup-id", 200.0, "newer")

    results = list(state_db._iter_chat_files())
    ids = [c["id"] for c in results]
    assert ids.count("dup-id") == 1
    # The newer updatedAt wins.
    kept = next(c for c in results if c["id"] == "dup-id")
    assert kept["title"] == "newer"


def test_iter_chat_files_keeps_distinct_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    _write_chat(str(tmp_path), "ws-a", "id-1", 100.0, "one")
    _write_chat(str(tmp_path), "ws-b", "id-2", 200.0, "two")

    results = list(state_db._iter_chat_files())
    assert sorted(c["id"] for c in results) == ["id-1", "id-2"]


def test_iter_chat_files_skips_files_without_id(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path))
    ws_dir = os.path.join(str(tmp_path), "chats", "ws-a")
    os.makedirs(ws_dir, exist_ok=True)
    with open(os.path.join(ws_dir, "no-id.json"), "w", encoding="utf-8") as fh:
        json.dump({"title": "no id"}, fh)

    assert list(state_db._iter_chat_files()) == []


def test_iter_chat_files_empty_when_no_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(state_db, "data_root", lambda: str(tmp_path / "missing"))
    assert list(state_db._iter_chat_files()) == []
