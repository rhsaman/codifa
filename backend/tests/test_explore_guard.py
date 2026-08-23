"""Guardrails on repo discovery:

* Part B -- junk directories (``release`` bundled app copy, ``_tmp_user_cfg``
  test temp, ``skills`` methodology) are excluded from discovery, but real
  test source (``backend/tests/*.py``) is NOT.
* Part C -- when the derived spec is empty (no glob/grep/queries) the reader
  must NOT blindly rank+read the whole repo; it returns an empty context and
  flags ``explore_empty`` so the planner asks instead.
* Part A -- a freshly-answered ask_user question is captured and re-triggers
  exploration (``repo_derive``) so the planner searches against the new info.
"""
import asyncio

import graph
from graph import (
    _is_excluded_discovery_path,
    _parse_glob_files,
    _parse_grep_files,
    _repo_source_files,
    _build_tree,
    _route_plan_validate,
)


# --------------------------------------------------------------------------
# Part B -- discovery-junk exclusion
# --------------------------------------------------------------------------

def test_is_excluded_discovery_path():
    assert _is_excluded_discovery_path("release/mac-arm64/backend/x.py")
    assert _is_excluded_discovery_path("backend/tests/_tmp_user_cfg/meta.json")
    assert _is_excluded_discovery_path("backend/skills/foo.md")
    # real test source must remain discoverable
    assert not _is_excluded_discovery_path("backend/tests/test_real.py")
    assert not _is_excluded_discovery_path("tests/test_x.py")
    assert not _is_excluded_discovery_path("src/main.py")


def _write(root, rel, content="x"):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def test_repo_source_files_excludes_junk_but_keeps_tests(tmp_path):
    _write(tmp_path, "release/app.py")
    _write(tmp_path, "backend/tests/_tmp_user_cfg/gen.py")
    _write(tmp_path, "backend/tests/test_real.py")
    _write(tmp_path, "skills/foo.md")
    _write(tmp_path, "src/main.py")

    files = _repo_source_files(str(tmp_path))
    assert "src/main.py" in files
    assert "backend/tests/test_real.py" in files
    assert not any("release" in f for f in files)
    assert not any("_tmp_user_cfg" in f for f in files)
    assert not any(f.startswith("skills") or "/skills/" in f for f in files)


def test_parse_glob_files_drops_release():
    out = _parse_glob_files("release/app.py\nbackend/tests/test_real.py\n")
    assert out == ["backend/tests/test_real.py"]


def test_parse_grep_files_drops_release():
    out = _parse_grep_files("release/app.py:1:x\nbackend/tests/test_real.py:2:y\n")
    assert out == ["backend/tests/test_real.py"]


def test_build_tree_excludes_release(tmp_path):
    _write(tmp_path, "release/app.py")
    _write(tmp_path, "src/main.py")
    tree = _build_tree(str(tmp_path))
    assert "release" not in tree
    assert "src/main.py" in tree


# --------------------------------------------------------------------------
# Part C -- no blind read on an empty spec
# --------------------------------------------------------------------------

async def test_repo_read_empty_spec_does_not_blindly_read(tmp_path):
    state = {
        "root": str(tmp_path),
        "request": "use the ui design skill but I dont know how the frontend looks",
        "chat_id": "chat-partc",
        "search_spec": {},
        "history": [],
        "_queue": asyncio.Queue(),
    }
    res = await graph.repo_read(state)
    assert res.get("explore_empty") is True
    assert res.get("read_context", "") == ""


async def test_repo_read_empty_spec_with_named_file_still_reads(tmp_path):
    _write(tmp_path, "backend/graph.py", "def f(): pass\n")
    state = {
        "root": str(tmp_path),
        "request": "look at backend/graph.py",
        "chat_id": "chat-partc2",
        "search_spec": {},
        "history": [],
        "_queue": asyncio.Queue(),
        "provider": "custom", "model_name": "x", "base_url": "",
        "api_key": "", "env_var": "", "oauth_token": "",
        "vector_db_path": "", "vector_config": None,
    }
    res = await graph.repo_read(state)
    # a named file is a targeted read, not a blind repo scan
    assert "backend/graph.py" in res.get("read_context", "")


# --------------------------------------------------------------------------
# Part A -- re-explore after an ask_user answer
# --------------------------------------------------------------------------

def test_route_plan_validate_reexplores_on_new_answer():
    graph._ASK_ANSWERS["chatA"] = "components live in src"
    try:
        # new, unexplored answer -> re-derive
        st = {"mode": "plan", "chat_id": "chatA", "plan_valid": False, "plan_attempts": 1}
        assert _route_plan_validate(st) == "repo_derive"

        # same answer already explored -> don't loop
        st2 = {
            "mode": "plan", "chat_id": "chatA", "plan_valid": False,
            "plan_attempts": 1, "_explored_ask_answer": "components live in src",
        }
        graph._ASK_ANSWERS["chatA"] = "components live in src"
        assert _route_plan_validate(st2) == "plan_build"

        # too many attempts -> bail to coder
        st3 = {"mode": "plan", "chat_id": "chatA", "plan_valid": False, "plan_attempts": 3}
        assert _route_plan_validate(st3) == "coder"

        # no answer at all -> normal plan_build loop
        graph._ASK_ANSWERS.pop("chatA", None)
        st4 = {"mode": "plan", "chat_id": "chatA", "plan_valid": False, "plan_attempts": 0}
        assert _route_plan_validate(st4) == "plan_build"
    finally:
        graph._ASK_ANSWERS.pop("chatA", None)


async def test_repo_derive_consumes_answer_into_spec(tmp_path, monkeypatch):
    async def _fake_llm(*a, **k):
        return None

    monkeypatch.setattr(graph, "_llm_derive_explore_patterns", _fake_llm)
    # avoid any skill-DB reads; isolate the answer-folding behavior
    monkeypatch.setattr(graph, "_skill_names_to_strip", lambda state: [])

    chat = "chat-derive"
    graph._ASK_ANSWERS[chat] = "look at the components in src"
    try:
        state = {
            "root": str(tmp_path),
            "request": "use the ui design skill, how does the frontend look?",
            "chat_id": chat,
            "_queue": asyncio.Queue(),
            "provider": "custom", "model_name": "x", "base_url": "",
            "api_key": "", "env_var": "", "oauth_token": "",
            "vector_db_path": "", "vector_config": None,
            "history": [],
        }
        res = await graph.repo_derive(state)
        spec = res["search_spec"]
        joined = " ".join(
            spec.get("grep", []) + spec.get("queries", []) + spec.get("glob", [])
        ).lower()
        # the captured answer's keyword is folded into the search
        assert "components" in joined
        assert res.get("_explored_ask_answer") == "look at the components in src"
        # answer consumed so we don't re-explore it forever
        assert graph._ASK_ANSWERS.get(chat) is None
    finally:
        graph._ASK_ANSWERS.pop(chat, None)
