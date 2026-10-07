"""Unit test: the search-strategy prompt is unified across all modes.

Two bugs were fixed:
1. `_SEARCH_RULE` (the authoritative "BROAD/multi-file -> use explore" rule)
   was gated behind `if mode not in ("coder","ask","plan","reader")` in
   graph.py, so it never reached any default mode. Now it is appended to
   every mode.
2. The per-mode prompts and `_MODE_CAPS` repeated a weak "or delegate broad
   exploration to the Explore sub-agent" clause with the word `or`, making
   delegation optional. Those duplicate clauses were removed so `_SEARCH_RULE`
   is the single source of truth (it makes broad/multi-file delegation the
   required path, grep/glob/read only for targeted lookups).
"""

import os
import pathlib
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import agent_registry
import agents


def test_search_rule_reserves_task_for_parallel_work():
    """_SEARCH_RULE must keep file lookups on grep/glob/read and reserve task for parallel chunks."""
    rule = agents._SEARCH_RULE
    assert "subagent_type='subagent'" in rule
    assert "NEVER delegate file lookups to task" in rule
    assert "parallelizable implementation chunks" in rule
    # grep/glob/read stay the file-lookup path, never delegated.
    assert "TARGETED" in rule.upper()


def test_no_duplicate_delegate_clause_in_mode_prompts():
    """Per-mode prompts must not repeat the weak 'or delegate' clause."""
    for mode, prompt in agents.SYSTEM_PROMPTS.items():
        assert "delegate broad exploration" not in prompt, (
            f"{mode} prompt still has the duplicate delegate clause"
        )


def test_no_duplicate_delegate_clause_in_mode_caps():
    """_MODE_CAPS must not repeat the weak 'or delegate' clause."""
    for mode, caps in agents._MODE_CAPS.items():
        assert "delegate" not in caps, (
            f"{mode} caps still reference delegation"
        )


def test_search_rule_is_the_single_source_of_truth():
    """No mode prompt should contradict _SEARCH_RULE by re-allowing broad
    search directly (the word 'or delegate' implied that)."""
    for prompt in agents.SYSTEM_PROMPTS.values():
        # The only place 'explore' should appear in a mode prompt now is the
        # explore agent's own registry prompt, not the parent mode prompts.
        assert "delegate broad exploration" not in prompt


def test_doing_tasks_block_appended_to_every_mode():
    """_DOING_TASKS (opencode-style 'Doing tasks' guidance) must be defined and
    instruct the agent to use the search tools and never commit unprompted."""
    block = agents._DOING_TASKS
    assert "grep/glob/read" in block
    assert "NEVER commit changes" in block
    # It must not contradict the auto-verify discipline already in the coder
    # prompt (both say trust the auto-check).
    assert "auto-checks" in block


def test_tool_docstrings_reference_explore_delegation():
    """grep/glob docstrings must mirror opencode: an open-ended search should be
    delegated to the explore sub-agent rather than done inline.

    The tool functions are nested inside make_tool_callbacks, so we assert on
    the source text of tools.py rather than importing the functions directly.
    """
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "tools.py"
    text = src.read_text(encoding="utf-8")
    assert "subagent_type='subagent'" in text


def test_read_docstring_encourages_parallel_reads():
    """read docstring must mirror opencode: read multiple files in parallel."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "tools.py"
    text = src.read_text(encoding="utf-8")
    assert "read multiple independent files in parallel" in text


def test_coder_prompt_mentions_task_tool():
    """Coder prompt must name the task tool so the model spawns sub-agents."""
    assert "task(subagent_type='subagent')" in agents.SYSTEM_PROMPTS["coder"]
    assert "task(subagent_type='subagent')" in agents._MODE_CAPS["coder"]


def test_coder_prompt_mentions_parallel_implementation():
    """Coder must delegate parallelizable implementation, not just discovery."""
    coder = agents.SYSTEM_PROMPTS["coder"]
    assert "parallelizable" in coder
    assert "inherit your write/test tools" in coder
    assert "parallelizable" in agents._MODE_CAPS["coder"]


def test_search_rule_forces_parallel_task_spawn():
    """_SEARCH_RULE must order one task per chunk, not just allow it."""
    rule = agents._SEARCH_RULE
    assert "you MUST launch one task per chunk" in rule
    assert "FILE LOOKUPS (any breadth)" in rule


def test_coder_prompt_forces_parallel_task_spawn():
    """Coder prompt must order parallel task spawn first, not just allow it."""
    coder = agents.SYSTEM_PROMPTS["coder"]
    assert "you MUST spawn one task" in coder
    assert "NEVER edit files you delegated" in coder
    assert "parallelizable" in agents._MODE_CAPS["coder"]


def test_ask_and_plan_prompts_mention_task_tool():
    """Ask/plan prompts must name the task tool so those modes also spawn sub-agents."""
    for mode in ("ask", "plan"):
        assert "task(subagent_type='subagent')" in agents.SYSTEM_PROMPTS[mode], (
            f"{mode} prompt does not mention the task tool"
        )
        assert "task(subagent_type='subagent')" in agents._MODE_CAPS[mode], (
            f"{mode} caps do not mention the task tool"
        )


def test_no_discover_word_in_prompts():
    """Prompts must not contain the word discovery (token saving)."""
    for mode, prompt in agents.SYSTEM_PROMPTS.items():
        assert "discover" not in prompt.lower(), (
            f"{mode} prompt still contains discover"
        )
    for mode, caps in agents._MODE_CAPS.items():
        assert "discover" not in caps.lower(), (
            f"{mode} caps still contain discover"
        )
    assert "discover" not in agents._DISCOVERY_BLOCK.lower()
    assert "discover" not in agent_registry.SUBAGENT_SYSTEM.lower()
    assert "discover" not in agent_registry.SUBAGENT_DESCRIPTION.lower()
    tools_text = pathlib.Path(__file__).resolve().parent.parent.joinpath("tools.py").read_text(encoding="utf-8")
    for marker in ("Do your file lookup", "not to search for files"):
        assert marker in tools_text


def test_search_rule_requires_targeted_order():
    """_SEARCH_RULE must enforce LSP-first (coder) / scoped grep, symbol read, stop rule."""
    rule = agents._SEARCH_RULE
    assert "LSP" in rule
    assert "SCOPE" in rule
    assert "symbols=[...]" in rule
    assert "2-3 search batches" in rule
    assert "plan's Files" in rule or "plan Files" in rule


def test_coder_prompt_requires_targeted_search():
    """Coder prompt must require LSP first and SCOPE-limited search."""
    coder = agents.SYSTEM_PROMPTS["coder"]
    assert "LSP" in coder
    assert "SCOPE" in coder
    assert "symbols=[...]" in coder
    assert "2-3 search batches" in coder
    assert "whole workspace blindly" in coder


def test_graph_pins_scope_for_coder():
    """graph.py must pin SCOPE and targeted search for the coder turn."""
    import pathlib

    text = pathlib.Path(__file__).resolve().parent.parent.joinpath("graph.py").read_text(encoding="utf-8")
    assert "TARGETED SEARCH (CODER)" in text
    assert "Search ONLY within them" in text
    assert "LSP" in text
    assert "2-3 search batches" in text


def test_plan_file_paths_extracts_files_line():
    """Plan Files line must become an enforceable search scope."""
    history = [
        {
            "role": "assistant",
            "mode": "plan",
            "content": "## Plan\n- change foo\nFiles: backend/a.py, backend/b.py",
            "plan": [{"content": "change foo", "status": "pending"}],
        }
    ]
    assert agents._plan_file_paths(history) == ["backend/a.py", "backend/b.py"]


def test_tool_docstrings_require_scope():
    """grep/glob/read docstrings must require SCOPE-limited, LSP-first search."""
    import pathlib

    text = pathlib.Path(__file__).resolve().parent.parent.joinpath("tools.py").read_text(encoding="utf-8")
    assert text.count("SCOPE (ONLY THESE FILES)") >= 3
    assert "LSP first" in text
    assert "never scan the whole workspace blindly" in text.lower()



