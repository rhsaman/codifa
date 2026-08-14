import json
import os
import shutil
import sqlite3
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix="codefa-test-")
os.environ["CODER_DATA_DIR"] = tmp
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

# 1) build a legacy coder.db like the old schema
db = os.path.join(tmp, "coder.db")
conn = sqlite3.connect(db)
conn.executescript(
    """
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE chat (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE skill (name TEXT PRIMARY KEY, slug TEXT NOT NULL, description TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE mcp (name TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE plan (workspace TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, updated_at REAL NOT NULL);
"""
)
conn.execute("INSERT INTO kv VALUES('settings', ?)", (json.dumps({"theme": "dark", "dataPath": tmp}),))
conn.execute(
    "INSERT INTO chat VALUES(?, ?, ?)",
    ("c1", json.dumps({"id": "c1", "title": "T1", "root": "/proj/a", "messages": [], "createdAt": 1, "updatedAt": 1}), 1.0),
)
conn.execute(
    "INSERT INTO chat VALUES(?, ?, ?)",
    ("c2", json.dumps({"id": "c2", "title": "T2", "root": "", "messages": [], "createdAt": 2, "updatedAt": 2}), 2.0),
)
conn.execute(
    "INSERT INTO skill VALUES(?, ?, ?, ?, ?, ?)",
    ("Code Review", "code-review", "review helper", "db://skills/code-review", "# Code Review\nbody here", 3.0),
)
conn.execute("INSERT INTO mcp VALUES(?, ?, ?)", ("Docker MCP", json.dumps({"command": "docker"}), 4.0))
conn.execute("INSERT INTO plan VALUES(?, ?, ?, ?)", ("proj-a", "My Plan", "## Plan\nstep 1", 5.0))
conn.commit()
conn.close()

import state_db

st = state_db.get_state()
assert st["settings"]["theme"] == "dark", st
assert {c["id"] for c in st["chats"]} == {"c1", "c2"}, st["chats"]
assert not os.path.exists(db), "coder.db should be renamed after migration"
assert os.path.exists(db + ".migrated"), "migrated db should exist"

# 2) file layout checks


def ls(base):
    out = []
    for r, _d, f in os.walk(base):
        for x in f:
            out.append(os.path.relpath(os.path.join(r, x), base))
    return sorted(out)


print("LAYOUT:", ls(tmp))

# 3) skills / mcp / plans round-trip
sk = state_db.list_skills()
assert len(sk) == 1 and sk[0]["name"] == "Code Review" and sk[0]["content"].startswith("# Code Review"), sk
assert state_db.list_mcp() == {"Docker MCP": {"command": "docker"}}, state_db.list_mcp()
pl = state_db.get_plan("proj-a")
assert pl and pl["content"].startswith("## Plan") and pl["chat_id"] == "", pl

# 4) per-chat plan save/get + most-recent
state_db.save_plan("proj-a", "P2", "## Plan\nnew plan", chat_id="chat-xyz")
pl2 = state_db.get_plan("proj-a", chat_id="chat-xyz")
assert pl2["chat_id"] == "chat-xyz" and pl2["content"] == "## Plan\nnew plan", pl2
most = state_db.get_plan("proj-a")  # empty chat_id -> most recent
assert most["chat_id"] == "chat-xyz", most

# 5) delete + settings/chats writes
state_db.delete_plan("proj-a", chat_id="chat-xyz")
assert state_db.get_plan("proj-a", chat_id="chat-xyz") is None
state_db.save_settings({"theme": "light"})
assert state_db.get_settings() == {"theme": "light"}
state_db.save_chats(
    [{"id": "c3", "title": "T3", "root": "/proj/b", "messages": [], "createdAt": 9, "updatedAt": 9}],
    deleted_ids=["c1"],
)
ids = {c["id"] for c in state_db.get_state()["chats"]}
assert ids == {"c2", "c3"}, ids
state_db.save_mcp("Files", json.dumps({"url": "https://x"}))
assert state_db.list_mcp().get("Files") == {"url": "https://x"}
assert state_db.delete_skill("Code Review") is True
assert state_db.list_skills() == []

# 6) idempotent migration (no db -> no-op)
state_db._migrate_legacy_db()
print("ALL ASSERTIONS PASSED")
shutil.rmtree(tmp, ignore_errors=True)
