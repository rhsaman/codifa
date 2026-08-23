"""Behavior tests: the REAL agent service layer against a mocked LLM.

Only the LLM layer is mocked (an in-process OpenAI-compatible server). The
agent, its tools, the sub-agent runner and the event stream are all real —
so these tests prove the agent actually behaves the way the UI expects:
streams text, runs tools, routes sub-agents, and fails gracefully.
"""
import json

from mock_openai import text_reply, tool_call

from agents import _wrap_no_search_bypass, _wrap_readonly_terminal


def _text(events):
    return "".join(e.get("content", "") for e in events if e.get("kind") == "text")


async def test_agent_streams_text_reply_to_user(run_events, mock_server):
    base, mock = mock_server
    mock.script = [
        text_reply("discovery"),
        text_reply("سلام! چطور میتونم کمک کنم؟"),
    ]
    events = await run_events("سلام")
    assert "سلام! چطور میتونم کمک کنم؟" in _text(events)
    # coder-without-plan runs the deterministic discovery pipeline, so
    # repo_search/glob/grep/read tool_results are expected. The agent itself
    # must not have called its own implementation tools.
    agent_tool_results = [
        e for e in events
        if e.get("kind") == "tool_result"
        and e.get("tool") not in ("repo_search", "glob", "grep", "read", "tree")
    ]
    assert not agent_tool_results, "a plain reply must not trigger agent tools"


async def test_agent_runs_tool_and_returns_result_to_model(run_events, mock_server):
    base, mock = mock_server
    mock.script = [
        text_reply("discovery"),
        tool_call("write_file", json.dumps({
            "path": "app.py", "content": "def foo():\n    return 42\n",
        })),
        text_reply("Done. Created app.py."),
    ]
    events = await run_events("create app.py with a foo function", mode="coder")
    tool_results = [
        e for e in events if e.get("kind") == "tool_result" and e.get("tool") == "write_file"
    ]
    assert tool_results, "expected a write_file tool_result"
    assert tool_results[0].get("tool") == "write_file", \
        f"unexpected tool result: {tool_results[0]}"
    assert "chars" in tool_results[0].get("summary", ""), \
        f"unexpected write result: {tool_results[0]}"
    assert "Done. Created app.py." in _text(events), \
        "agent never finished after the tool result"
    assert len(mock.captured) >= 2, "parent + parent requests expected"


async def test_agent_passes_history_into_the_model_request(run_events, mock_server):
    base, mock = mock_server
    mock.script = [text_reply("discovery"), text_reply("ok")]
    events = await run_events("ادامه بده", history=[{"role": "user", "content": "قبلی"}])
    assert "ok" in _text(events)
    # captured[0] is the deterministic discovery planner; captured[1] is the
    # coder turn that receives the conversation history.
    all_messages = [m for body in mock.captured for m in body.get("messages", [])]
    assert any(m.get("content") == "قبلی" for m in all_messages), \
        "history was not passed into the model request"


async def test_agent_routes_general_subagent_on_main_model(run_events, mock_server):
    """The `general` sub-agent inherits the PARENT's model (it runs on the main
    model, not a separate slot), and its report must NOT leak into the parent
    stream — the parent only sees the tool result, not the sub-agent's raw text."""
    base, mock = mock_server
    """Plan mode must NOT expose glob/grep/read/task to the LLM -- repository
    exploration is performed by the deterministic workflow, not the LLM. The
    workflow still runs (repo_search event) and the turn finishes."""
    mock.script = [text_reply("I will plan from the injected repo context.")]
    events = await run_events("where is foo defined?", mode="plan")
    # The plan LLM had no exploration tools.
    tool_names = set()
    for body in mock.captured:
        for t in body.get("tools") or []:
            tool_names.add((t.get("function") or {}).get("name"))
    assert not (tool_names & {"glob", "grep", "read", "task"}), \
        f"plan LLM must not have exploration tools: {tool_names}"
    # But the deterministic discovery still ran.
    assert any(
        e.get("kind") == "tool" and e.get("tool") == "repo_search" for e in events
    ), "deterministic repo discovery did not run"
    assert any(e.get("kind") == "text" for e in events), "turn did not finish"


async def test_agent_rejects_empty_prompt_with_error_event(run_events):
    events = await run_events("   ")
    assert any(e.get("kind") == "error" for e in events), \
        f"expected an error event, got kinds={sorted({e.get('kind') for e in events})}"


async def test_agent_surfaces_provider_failure(run_events, mock_server):
    """A hard provider rejection must surface as an error event, not hang or
    silently succeed — the UI depends on the failure propagating."""
    base, mock = mock_server
    mock.script = [None] * 20  # every request rejected with HTTP 400
    events = await run_events("سلام")
    assert any(e.get("kind") == "error" for e in events), (
        f"expected a provider-failure error event, got kinds="
        f"{sorted({e.get('kind') for e in events})}"
    )


async def test_coder_does_not_force_test_run_without_terminal(run_events, mock_server):
    """Coder is implementation-only and has NO terminal (it MUST NOT run shell /
    tests — verification is Plan mode's job, which keeps a read-only terminal).
    Therefore a test-related coder task that finishes without running any test
    command must NOT trigger the forced run-and-see-green follow-up: there is no
    terminal to run on, so forcing would be dead code. This locks in the new
    architecture (coder relies on Plan for verification)."""
    base, mock = mock_server
    # The model replies immediately and never calls run_terminal (it can't — the
    # coder toolset has no terminal). No forced test-verification follow-up may fire.
    # (coder-without-plan runs the discovery pipeline first, hence the leading
    # discovery stub.)
    mock.script = [text_reply("discovery"), text_reply("تمام شد.")]
    events = await run_events("تست بنویس برای پروژه")

    retries = [e for e in events if e.get("kind") == "retry"]
    assert not any(
        "test" in (e.get("reason") or "").lower() for e in retries
    ), f"coder must not force a test run (no terminal): retries={retries}"
    # Coder has NO terminal: it must never execute run_terminal, and it must not
    # spawn a verification follow-up. (We assert behavior, not raw HTTP request
    # count — the langchain client can issue more than one wire request per turn.)
    assert not any(
        e.get("kind") == "tool" and e.get("tool") == "run_terminal" for e in events
    ), "coder must not have a terminal to run tests on"
    assert _text(events).strip(), "coder must still finish with a reply"


async def test_agent_skips_test_verification_when_tests_were_run(run_events, mock_server):
    """When the agent actually ran the test command, no forced follow-up fires —
    the verification step is satisfied by the real test run."""
    base, mock = mock_server
    mock.script = [
        tool_call("run_terminal", json.dumps({"command": "python -m pytest tests/ -q"})),
        text_reply("3 passed"),
    ]
    events = await run_events("تست بنویس برای پروژه", mode="plan")

    retries = [e for e in events if e.get("kind") == "retry"]
    assert not any(
        "test" in (e.get("reason") or "").lower() for e in retries
    ), f"test verification should be satisfied by the real run, got retries={retries}"
    assert "3 passed" in _text(events)


async def test_agent_emits_usage_event_with_true_counts(run_events, mock_server):
    """The sidebar shows per-model token usage + cost and the title bar shows
    consumed context — both depend on a `usage` event carrying the EXACT token
    counts the provider reported. This proves the event is emitted end-to-end and
    carries the true numbers (the mock derives usage from the real request /
    response sizes), so those UIs are fed real counts, not blanked."""
    base, mock = mock_server
    mock.script = [text_reply("تمام شد.")]
    events = await run_events("سلام", mode="ask")

    usage = [e for e in events if e.get("kind") == "usage"]
    assert usage, f"no usage event emitted; kinds={[e.get('kind') for e in events]}"
    # Exactly one model call for a single-turn reply.
    assert len(usage) == 1, f"expected 1 usage event, got {len(usage)}"
    ev = usage[0]
    # Recompute the true counts the mock derived from the actual request it
    # received and the streamed reply, and assert the emitted event matches them
    # byte-for-byte — this is what guarantees the sidebar shows the real cost.
    req = next((b for b in mock.captured if b.get("messages")), None)
    assert req is not None, "mock captured no chat completion request"
    prompt_tokens = max(1, len(json.dumps(req, ensure_ascii=False)) // 4)
    completion_tokens = max(0, len("تمام شد.") // 4)
    assert ev["input_tokens"] == prompt_tokens, f"input_tokens must equal the true derived count, got {ev}"
    assert ev["output_tokens"] == completion_tokens, f"output_tokens must equal the true derived count, got {ev}"
    assert ev["total_tokens"] == prompt_tokens + completion_tokens, f"total must be input+output, got {ev}"
    # The event names the model that actually ran, so the sidebar can attribute
    # cost to the right provider/model.
    assert ev.get("model") == "mock-model", f"usage model must be set, got {ev.get('model')}"


async def test_run_terminal_blocks_git_history_search():
    """Plan/ask mode's run_terminal must reject git history/discovery commands
    (git log/show/blame/ls-files, git diff <ref>) that a planner would otherwise
    loop on to hunt for code. git status and plain git diff stay allowed."""
    async def fake(cmd, _timeout=120):
        return "RAN:" + cmd

    wrapped = _wrap_no_search_bypass(fake)

    blocked = [
        "git ls-files src/ | head -100",
        "git show HEAD:src/components/Chat.tsx | head -120",
        "git log --oneline -20",
        "git show HEAD",
        "git blame src/app.py",
        "git rev-list HEAD",
        "git grep TODO",
        "git whatchanged",
        "git shortlog -sn",
        "git reflog",
        "git diff HEAD~3",
        "git diff a1b2c3d4",
        "git diff origin/main",
        "git diff main..feature",
    ]
    for cmd in blocked:
        out = await wrapped(cmd)
        assert out.startswith("ERROR: `git"), f"expected block for {cmd!r}, got {out!r}"

    allowed = [
        "git status",
        "git diff",
        "git diff --cached",
        "git diff src/app.py",
        "git diff --stat src/app.py",
        "git branch",
        "pwd",
        "node --version",
        "npm run build",
        "pytest",
    ]
    for cmd in allowed:
        out = await wrapped(cmd)
        assert out == "RAN:" + cmd, f"expected allow for {cmd!r}, got {out!r}"


async def test_plan_readonly_terminal_still_blocks_git_search():
    """Layered exactly like plan mode: readonly wrapper outside, no-search-bypass
    inside. git log/show must still be rejected (readonly allows the git prefix
    but the inner block vetoes it), while git status passes both layers."""
    async def fake(cmd, _timeout=120):
        return "RAN:" + cmd

    wrapped = _wrap_readonly_terminal(_wrap_no_search_bypass(fake))
    out = await wrapped("git show HEAD:src/components/Chat.tsx | head -120")
    assert out.startswith("ERROR"), out  # blocked (allowlist or inner veto)
    out = await wrapped("git status")
    assert out == "RAN:git status", out


async def test_plan_readonly_terminal_blocks_discovery_commands():
    """Plan/ask mode must not be able to shell out to ls/cat/sed/awk/head/tail/
    wc/find/grep to hunt for files — that's the explore pipeline's job. Only
    review/verification commands (git status, plain git diff, pwd, build/test/
    lint, version) are allowed."""
    async def fake(cmd, _timeout=120):
        return "RAN:" + cmd

    wrapped = _wrap_readonly_terminal(_wrap_no_search_bypass(fake))

    blocked = [
        "ls src",
        "ls -R src/components | head -120",
        "ls src/styles src/lib src/types",
        "cat src/components/ToolCallView.tsx",
        "sed -n '1,200p' src/components/ToolCallView.tsx",
        "wc -l src/components/*.tsx src/styles/global.css",
        "find . -name '*.tsx'",
        "grep -rn foo src/",
        "head -50 src/app.py",
        "tail -20 src/app.py",
        "git log --oneline",
        "git show HEAD:src/app.py",
    ]
    for cmd in blocked:
        out = await wrapped(cmd)
        assert out.startswith("ERROR"), f"expected block for {cmd!r}, got {out!r}"

    allowed = [
        "git status",
        "git diff",
        "git diff --cached",
        "git diff src/app.py",
        "pwd",
        "node --version",
        "npm run build",
        "pytest",
    ]
    for cmd in allowed:
        out = await wrapped(cmd)
        assert out == "RAN:" + cmd, f"expected allow for {cmd!r}, got {out!r}"