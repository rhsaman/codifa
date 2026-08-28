"""Unit tests: auto-router steers BROAD / repeated searches to explore.

Guards the fix that re-enabled the auto-router (it had been disabled — `_is_broad_search`
always returned False and the wrapper was deleted). The router must:
1. Refuse to run a BROAD search inline (open glob, repo-wide grep, huge read).
2. Refuse to run after the cross-turn call count exceeds _AUTO_EXPLORE_THRESHOLD (10).
3. Allow normal targeted searches through unchanged.
4. Reset the counter at the start of each user message.
"""
import agents as _agents


async def test_broad_glob_refused():
    _agents.reset_auto_explore_counter()

    async def glob(pattern, path="", include=""):
        return f"ran:{pattern}"

    tools = {"glob": glob}
    wrapped = _agents._wrap_auto_explore_router(dict(tools))
    out = await wrapped["glob"](pattern="**/*.py")
    assert "explore" in out, f"broad glob should steer to explore, got: {out}"


async def test_repo_wide_grep_refused():
    _agents.reset_auto_explore_counter()

    async def grep(pattern, path="", include=""):
        return f"ran:{pattern}"

    tools = {"grep": grep}
    wrapped = _agents._wrap_auto_explore_router(dict(tools))
    out = await wrapped["grep"](pattern="def foo")
    assert "explore" in out, f"repo-wide grep should steer to explore, got: {out}"


async def test_huge_read_refused():
    _agents.reset_auto_explore_counter()

    async def read(filePath, offset=1, limit=2000):
        return f"ran:{limit}"

    tools = {"read": read}
    wrapped = _agents._wrap_auto_explore_router(dict(tools))
    out = await wrapped["read"](filePath="x.py", limit=200)
    assert "explore" in out, f"huge read should steer to explore, got: {out}"


async def test_targeted_search_allowed():
    _agents.reset_auto_explore_counter()

    async def grep(pattern, path="", include=""):
        return f"ran:{pattern}"

    tools = {"grep": grep}
    wrapped = _agents._wrap_auto_explore_router(dict(tools))
    out = await wrapped["grep"](pattern="def foo", path="src/")
    assert out == "ran:def foo", f"targeted grep must run inline, got: {out}"


async def test_repeated_calls_steer_after_threshold():
    _agents.reset_auto_explore_counter()
    calls = {"n": 0}

    async def fake_grep(pattern, path="", include=""):
        calls["n"] += 1
        return f"ran:{calls['n']}"

    tools = {"grep": fake_grep}
    wrapped = _agents._wrap_auto_explore_router(dict(tools))
    # Threshold is 10 — first 10 targeted calls run, 11th steers to explore.
    for i in range(10):
        out = await wrapped["grep"](pattern=f"x{i}", path="src/")
        assert out.startswith("ran:"), f"call {i} should run inline, got: {out}"
    out = await wrapped["grep"](pattern="x10", path="src/")
    assert "explore" in out, f"11th call should steer to explore, got: {out}"


async def test_counter_resets_per_message():
    _agents.reset_auto_explore_counter()

    async def grep(pattern, path="", include=""):
        return "ran"

    tools = {"grep": grep}
    wrapped = _agents._wrap_auto_explore_router(dict(tools))
    for _ in range(10):
        await wrapped["grep"](pattern="x", path="src/")
    # Reset, then a fresh batch of 10 should all run again.
    _agents.reset_auto_explore_counter()
    for i in range(10):
        out = await wrapped["grep"](pattern=f"y{i}", path="src/")
        assert out == "ran", f"after reset call {i} should run, got: {out}"


async def test_is_broad_search_signals():
    assert _agents._is_broad_search("glob", {"pattern": "**/*.py"}) is True
    assert _agents._is_broad_search("glob", {"pattern": "*.ts"}) is True
    assert _agents._is_broad_search("grep", {"path": ""}) is True
    assert _agents._is_broad_search("grep", {"path": "src/"}) is False
    assert _agents._is_broad_search("read", {"limit": 200}) is True
    assert _agents._is_broad_search("read", {"limit": 20}) is False
    assert _agents._is_broad_search("edit_file", {}) is False
