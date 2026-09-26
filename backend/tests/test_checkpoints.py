"""تست‌های سیستم Checkpoint/Undo (backend/checkpoints.py).

سناریوها:
  - save/restore پایه (فایل موجود و فایل جدید)
  - تجمیع per-turn (چند write در یک turn → یک seq)
  - تشخیص changed (فایل بعد از snapshot عوض شده باشد)
  - path-escape (snapshot از workspace دیگری نباید بیرون root بنویسد)
  - prune و delete_chat_checkpoints
  - قلاب در write_file_tool و edit_file_tool (event دارای checkpoint باشد)
"""

import asyncio
import os

import pytest

import checkpoints
import tools


@pytest.fixture(autouse=True)
def _fresh_data_dir(tmp_path, monkeypatch):
    """هر تست data root و workspace تازه بگیرد."""
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def _write(ws, rel, content):
    p = ws / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


def test_save_and_restore_existing_file(_fresh_data_dir):
    ws = _fresh_data_dir
    _write(ws, "a.txt", "old")
    state = {}
    seq = checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "old", state)
    assert seq == 1
    # مدل فایل را عوض می‌کند
    _write(ws, "a.txt", "new content")
    out = checkpoints.restore("chat1", seq, str(ws))
    assert "error" not in out
    assert out["restored"] == [{"path": "a.txt", "changed": True}]
    assert (ws / "a.txt").read_text(encoding="utf-8") == "old"


def test_save_new_file_restore_deletes_it(_fresh_data_dir):
    ws = _fresh_data_dir
    state = {}
    seq = checkpoints.save_pre_edit("chat1", str(ws), "b.txt", None, state)
    _write(ws, "b.txt", "created by model")
    out = checkpoints.restore("chat1", seq, str(ws))
    assert "error" not in out
    assert not (ws / "b.txt").exists()


def test_per_turn_merge_multiple_writes(_fresh_data_dir):
    ws = _fresh_data_dir
    _write(ws, "a.txt", "a-old")
    _write(ws, "b.txt", "b-old")
    state = {}
    s1 = checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "a-old", state)
    s2 = checkpoints.save_pre_edit("chat1", str(ws), "b.txt", "b-old", state)
    # هر دو write همان turn → همان seq
    assert s1 == s2 == 1
    # turn بعدی (state تازه) → seq جدید
    state2 = {}
    s3 = checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "a-old", state2)
    assert s3 == 2


def test_same_file_not_saved_twice_in_one_turn(_fresh_data_dir):
    ws = _fresh_data_dir
    _write(ws, "a.txt", "v1")
    state = {}
    checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "v1", state)
    # مدل دوباره همان فایل را در همان turn عوض می‌کند — snapshot اول می‌ماند
    seq = checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "v2", state)
    assert seq == 1
    out = checkpoints.restore("chat1", seq, str(ws))
    assert len(out["restored"]) == 1
    # محتوای snapshot همان v1 اول است
    assert (ws / "a.txt").read_text(encoding="utf-8") == "v1"


def test_restore_detects_unchanged(_fresh_data_dir):
    ws = _fresh_data_dir
    _write(ws, "a.txt", "same")
    seq = checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "same", {})
    out = checkpoints.restore("chat1", seq, str(ws))
    assert out["restored"][0]["changed"] is False


def test_restore_missing_checkpoint(_fresh_data_dir):
    out = checkpoints.restore("chat1", 99, str(_fresh_data_dir))
    assert "error" in out


def test_restore_blocks_path_escape(_fresh_data_dir):
    ws = _fresh_data_dir
    # snapshot با مسیر خطرناک — مستقیم manifest می‌سازیم
    checkpoints.save_pre_edit("chat1", str(ws), "ok.txt", "ok", {})
    base = checkpoints._base_dir("chat1")
    man_path = os.path.join(base, "000001", "manifest.json")
    import json

    with open(man_path, encoding="utf-8") as fh:
        man = json.load(fh)
    man["files"].append({"path": "../escape.txt", "existed": True, "sha256": "x"})
    with open(man_path, "w", encoding="utf-8") as fh:
        json.dump(man, fh)
    out = checkpoints.restore("chat1", 1, str(ws))
    assert any("escapes" in e for e in out.get("errors", []))
    assert not (ws.parent / "escape.txt").exists()


def test_list_and_prune(_fresh_data_dir):
    ws = _fresh_data_dir
    for i in range(5):
        _write(ws, f"f{i}.txt", "x")
        checkpoints.save_pre_edit("chat1", str(ws), f"f{i}.txt", "x", {})
    lst = checkpoints.list_checkpoints("chat1")
    assert [c["seq"] for c in lst] == [5, 4, 3, 2, 1]
    checkpoints.prune("chat1", keep=2)
    lst = checkpoints.list_checkpoints("chat1")
    assert [c["seq"] for c in lst] == [5, 4]


def test_delete_chat_checkpoints(_fresh_data_dir):
    ws = _fresh_data_dir
    checkpoints.save_pre_edit("chat1", str(ws), "a.txt", "a", {})
    checkpoints.delete_chat_checkpoints("chat1")
    assert checkpoints.list_checkpoints("chat1") == []


def test_write_file_tool_emits_checkpoint(_fresh_data_dir):
    """قلاب در write_file_tool: event diff باید فیلد checkpoint داشته باشد."""
    ws = _fresh_data_dir
    _write(ws, "w.txt", "before")
    emitted = []

    def emit(ev):
        emitted.append(ev)

    cbs = tools.make_tool_callbacks(
        root=str(ws), emit=emit, main_model=None, chat_id="chat-tools"
    )
    asyncio.run(cbs["write_file"]("w.txt", "after"))
    diffs = [e for e in emitted if e.get("kind") == "diff"]
    assert diffs, "no diff event emitted"
    assert diffs[0].get("checkpoint") == 1


def test_edit_file_tool_emits_checkpoint(_fresh_data_dir):
    """قلاب در edit_file_tool: event diff باید فیلد checkpoint داشته باشد."""
    ws = _fresh_data_dir
    _write(ws, "e.txt", "line1\nline2\n")
    emitted = []

    def emit(ev):
        emitted.append(ev)

    cbs = tools.make_tool_callbacks(
        root=str(ws), emit=emit, main_model=None, chat_id="chat-tools"
    )
    asyncio.run(cbs["edit_file"]("e.txt", "line1", "CHANGED"))
    diffs = [e for e in emitted if e.get("kind") == "diff"]
    assert diffs, "no diff event emitted"
    assert diffs[0].get("checkpoint") == 1
