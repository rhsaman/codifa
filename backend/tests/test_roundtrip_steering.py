"""Round-trip steering pins: wasteful solo update_plan steps burn a full LLM
call for nothing. These tests pin the instruction text that steers the
model away from them:

* update_plan (tool description + checklist continuation rule) prefers
  batching with the next tool calls, while explicitly allowing solo calls
  that mark steps completed (final tick) or create the initial checklist —
  an absolute solo ban taught the model to never call update_plan, leaving
  todos/plan stale.
* repeated reads/greps always re-serve their full content — no stub
  withholds it, so a re-issued call is never a wasted no-op.
"""


def _cbs(root):
    import tools

    return tools.make_tool_callbacks(root, lambda ev: None, main_model=None)


def test_update_plan_description_prefers_batching_allows_solo_on_completion(
    tmp_path,
):
    cbs = _cbs(str(tmp_path))
    doc = cbs["update_plan"].__doc__ or ""
    assert "Batch update_plan with your next tool calls" in doc
    assert "a solo update_plan is fine when marking steps completed" in doc


def test_checklist_continuation_rule_prefers_batching():
    from agents import _plan_reuse_note

    history = [
        {
            "mode": "coder",
            "plan": [{"content": "do the thing", "status": "pending"}],
        }
    ]
    note = _plan_reuse_note(history)
    assert "EXISTING CHECKLIST" in note, note
    assert "Batch update_plan with your next tool calls" in note, note


async def test_repeat_read_reserves_full_content(tmp_path):
    root = str(tmp_path)
    (tmp_path / "a.py").write_text("alpha\nbeta\n")
    cbs = _cbs(root)
    out1 = await cbs["read"](filePath="a.py")
    assert "alpha" in out1, out1
    # A repeat serves the full content again — nothing is withheld.
    out2 = await cbs["read"](filePath="a.py")
    assert "alpha" in out2 and "beta" in out2, out2


async def test_repeat_grep_reserves_full_content(tmp_path):
    root = str(tmp_path)
    (tmp_path / "a.py").write_text("alpha marker here\n")
    cbs = _cbs(root)
    out1 = await cbs["grep"]("marker", path="")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("marker", path="")
    assert "MATCHES for" in out2 and "marker" in out2, out2
