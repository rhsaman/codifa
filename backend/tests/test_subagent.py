"""Live test: the explore SUB-AGENT runs end-to-end.

The parent model calls `explore`; explore spins up an ISOLATED pydantic-ai
sub-agent (its own model request against the mock, JSON not SSE) which produces
a report; explore returns that report to the parent. If any link is broken the
tool falls back to "unavailable"/"failed"/"step budget exceeded".
"""
import asyncio
import json
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subagent-data-")
os.environ["CODER_DATA_DIR"] = _TMP

from mock_openai import (
    mock,
    start_server,
    stop_server,
    text_reply,
    tool_call,
)

from agents import _subagent_target, run_agent


def check_resolution():
    """Hermetic unit checks of the subagent entry resolver (no network / no key).

    Cover the user-reported case: parent on the opencode gateway, subagent set to
    "openrouter/free" with NO saved OpenRouter provider row (env-var auth) — the
    prefix must route through OpenRouter instead of being dumped on the parent.
    """
    parent = {
        "parent_provider": "opencode",
        "parent_base_url": "http://parent.example/v1",
        "parent_api_key": "parent-key",
        "parent_env_var": "",
        "parent_oauth_token": "",
    }

    def no_row(_pid):
        return None

    # 1. User's exact case: openrouter/free, no saved row -> kind openrouter.
    t = _subagent_target("openrouter/free", **parent, provider_lookup=no_row)
    assert t is not None, "openrouter/free must resolve"
    kind, model, base, key, env, oauth = t
    assert kind == "openrouter", f"kind={kind}"
    assert model == "openrouter/free", f"model={model}"
    assert base and base == __import__("providers").OPENROUTER_BASE, f"base={base}"
    assert key == "" and env == "" and oauth == "", "env-only creds expected"
    print("  resolve OK: openrouter/free (no saved row) -> openrouter, env creds")

    # 2. A SAVED openrouter row (stored key) must still win over meta defaults.
    row = {
        "id": "openrouter",
        "kind": "openrouter",
        "baseUrl": "ignored",
        "apiKey": "sk-saved",
        "envVar": "",
        "oauthRefreshToken": "oauth-saved",
    }
    t = _subagent_target("openrouter/free", **parent, provider_lookup=lambda _p: row)
    assert t is not None and t[0] == "openrouter" and t[1] == "openrouter/free", t
    assert t[3] == "sk-saved" and t[5] == "oauth-saved", "saved row creds must win"
    print("  resolve OK: saved openrouter row creds win")

    # 3. Parent-kind prefix keeps the PARENT's own creds (no regression).
    t = _subagent_target("opencode/free", **parent, provider_lookup=no_row)
    assert t == ("opencode", "free", "http://parent.example/v1", "parent-key", "", ""), t
    print("  resolve OK: parent-kind prefix keeps parent creds")

    # 4. Bare model id stays parent-relative.
    t = _subagent_target("free", **parent, provider_lookup=no_row)
    assert t == ("opencode", "free", "http://parent.example/v1", "parent-key", "", ""), t
    print("  resolve OK: bare model id stays parent-relative")

    # 5. Parent IS openrouter: openrouter/free keeps parent creds (legacy path).
    parent_or = {**parent, "parent_provider": "openrouter"}
    t = _subagent_target("openrouter/free", **parent_or, provider_lookup=no_row)
    assert t == ("openrouter", "free", "http://parent.example/v1", "parent-key", "", ""), t
    print("  resolve OK: openrouter parent -> parent creds (qualify adds prefix)")


async def main():
    check_resolution()
    task, base = await start_server()
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-subagent-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def foo():\n    return 42\n")

        mock.script = [
            tool_call("explore", json.dumps({"task": "find where foo is defined"})),
            text_reply("SUBAGENT REPORT: foo is defined in app.py:1"),
            text_reply("Done. The exploration is complete."),
        ]
        mock.captured = []

        events = []
        async for ev in run_agent(
            provider="custom", model_name="mock-model", base_url=base, api_key="test",
            root=ws, mode="coder", prompt="explore the workspace for foo", history=[],
            chat_id="chat-sub-1",
            subagent_models={"explore": "mock-model"},
        ):
            events.append(ev)

        assert len(mock.captured) >= 3, \
            f"expected parent+sub-agent requests, got {len(mock.captured)}"
        print("  subagent OK: 3 model requests (parent x2 + sub-agent x1)")

        tool_results = [e for e in events if e.get("kind") == "tool_result" and e.get("tool") == "explore"]
        assert tool_results and "chars" in tool_results[0].get("summary", ""), \
            f"unexpected explore result: {tool_results[0] if tool_results else 'none'}"
        streamed = "".join(e.get("content", "") for e in events if e.get("kind") == "text")
        assert "SUBAGENT REPORT" not in streamed, "sub-agent report leaked into parent stream"
        sub_req = mock.captured[1]
        sub_system = "".join(
            m.get("content", "") for m in sub_req.get("messages", [])
            if m.get("role") == "system"
        )
        assert sub_system, "sub-agent request has no system prompt"
        assert "The exploration is complete." in streamed, "parent never finished after the sub-agent"
        print("  subagent OK: explore ran its isolated sub-agent and returned a report")

        # Opt-in live check of the user's exact scenario: subagent set to
        # "openrouter/free" with no saved OpenRouter row (env-var auth). The
        # build happens via the resolver above against the REAL openrouter kind;
        # assert the subagent_models routing event reports openrouter/free.
        # Skipped when the test env has no OPENROUTER_API_KEY (build would fail
        # legitimately without a credential). No explore call is made, so no
        # network request happens — this only proves resolution + build.
        if os.environ.get("OPENROUTER_API_KEY"):
            mock.script = [text_reply("ok")]
            mock.captured = []
            events = []
            async for ev in run_agent(
                provider="custom", model_name="mock-model", base_url=base, api_key="test",
                root=ws, mode="coder", prompt="hi", history=[],
                chat_id="chat-sub-2",
                subagent_models={"explore": "openrouter/free", "search": "openrouter/free"},
            ):
                events.append(ev)
            routing = next(
                (e.get("models") for e in events if e.get("kind") == "subagent_models"), {}
            )
            assert routing.get("explore") == "openrouter/free", routing
            assert routing.get("search") == "openrouter/free", routing
            assert "ok" in "".join(e.get("content", "") for e in events if e.get("kind") == "text"), \
                "run did not complete"
            print("  subagent OK: openrouter/free routes & builds (env key present)")
        else:
            print("  subagent SKIP: no OPENROUTER_API_KEY in env (openrouter routing unchecked)")

        print("SUBAGENT TESTS PASSED")
    finally:
        await stop_server(task)


if __name__ == "__main__":
    asyncio.run(main())