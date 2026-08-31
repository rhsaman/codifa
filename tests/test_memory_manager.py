"""Quick smoke test for memory_manager + tools wiring (temp data root)."""
import os
import sys
import tempfile

os.environ["CODER_DATA_DIR"] = tempfile.mkdtemp(prefix="mm_test_")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from memory_manager import (
    MEM_TASK,
    MemoryManager,
)

mm = MemoryManager()
mm.add("The project uses FastAPI for the sidecar", project_id="myproj")
mm.add("Port 8080 is used for dev", project_id="myproj", memory_type=MEM_TASK)
mm.add("Different project note", project_id="other")

# Dedup: exact re-add of same content should skip
res = mm.add("The project uses FastAPI for the sidecar", project_id="myproj")
assert res.get("skipped") == "duplicate", res

# List scoped per project
mine = mm.list(project_id="myproj")
assert len(mine) == 2, mine
assert mm.list(project_id="other")[0]["content"] == "Different project note"

# FTS lexical search
hits = mm.search("fastapi", project_id="myproj", top_k=5)
assert any("FastAPI" in h["content"] for h in hits), hits
assert all(h["project_id"] == "myproj" for h in hits), hits

# Replace + Remove
r = mm.replace("Port 8080", "Port 9090 is used for dev", project_id="myproj")
assert r.get("ok") and r.get("replaced"), r
hits = mm.search("9090", project_id="myproj")
assert any("9090" in h["content"] for h in hits), hits
rm = mm.remove("FastAPI", project_id="myproj")
assert rm.get("removed"), rm
assert len(mm.list(project_id="myproj")) == 1

# Stats + persistence file exists
st = mm.stats()
assert st["total"] == 2, st
assert os.path.exists(mm._path), mm._path
print("MEMORY_MANAGER OK", st)
