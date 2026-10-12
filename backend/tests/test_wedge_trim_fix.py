"""Regression tests for pylsp wedge defaults and turn-start trim age rule."""

from __future__ import annotations


def test_python_init_disables_slow_plugins():
    """pylsp must start with linters/formatters off so heavy files never wedge."""
    from lsp_manager import LspManager

    mgr = LspManager(root="/tmp")
    init = mgr.effective_initialization("python")
    plugins = init.get("pylsp", {}).get("plugins", {})
    for name in (
        "pycodestyle",
        "pyflakes",
        "pylint",
        "flake8",
        "pydocstyle",
        "autopep8",
        "yapf",
        "mccabe",
    ):
        assert plugins.get(name, {}).get("enabled") is False, name
    # Non-python languages keep the old empty default.
    assert mgr.effective_initialization("go") == {}


def test_python_init_custom_merges():
    """Custom per-language initialization merges on top of the safe defaults."""
    from lsp_manager import LspManager

    mgr = LspManager(
        root="/tmp",
        lsp_config={
            "python": {
                "initialization": {
                    "pylsp": {"plugins": {"pycodestyle": {"enabled": True}}}
                }
            }
        },
    )
    plugins = mgr.effective_initialization("python")["pylsp"]["plugins"]
    assert plugins["pycodestyle"]["enabled"] is True
    assert plugins["pyflakes"]["enabled"] is False


def test_truncate_old_tool_results_age_rule():
    """Results older than ~40 messages truncate even when still referenced.

    Without the age rule a common token (e.g. a filename still mentioned in
    chat) keeps EVERY old result verbatim and continuation turns start heavy.
    """
    from langchain_core.messages import AIMessage, ToolMessage

    import graph

    msgs: list = []
    for i in range(30):
        tcid = f"t{i}"
        # Recent AI messages mention the file so the exemption would trigger.
        content = "discussing local_tts.py here" if i >= 27 else "c"
        msgs.append(
            AIMessage(content=content, tool_calls=[{"id": tcid, "name": "read", "args": {}}])
        )
        msgs.append(ToolMessage(content=("x" * 2000) + " local_tts.py", tool_call_id=tcid))
    n = graph._truncate_old_tool_results(msgs)
    by_id = {m.tool_call_id: str(m.content) for m in msgs if isinstance(m, ToolMessage)}
    # Oldest result must truncate despite the still-referenced filename.
    assert by_id["t0"].startswith("[truncated read("), by_id["t0"][:80]
    # A result just outside the kept steps but within the 40-message window
    # stays verbatim because it is still referenced.
    assert "local_tts.py" in by_id["t26"] and not by_id["t26"].startswith("[truncated"), by_id[
        "t26"
    ][:80]
    assert n >= 1


def test_truncate_old_tool_results_caps_kept_steps():
    """Even kept (recent) results are capped so step 1 never starts heavy.

    Without the keep-cap, the last 3 steps stay fully verbatim — several
    60k results = ~60k tokens on step 1 (continuation-turn inflation).
    """
    from langchain_core.messages import AIMessage, ToolMessage

    import graph

    msgs: list = []
    for i in range(3):
        tcid = f"k{i}"
        msgs.append(
            AIMessage(content="c", tool_calls=[{"id": tcid, "name": "read", "args": {}}])
        )
        msgs.append(ToolMessage(content="y" * 60_000, tool_call_id=tcid))
    n = graph._truncate_old_tool_results(msgs)
    by_id = {m.tool_call_id: str(m.content) for m in msgs if isinstance(m, ToolMessage)}
    for tcid in ("k0", "k1", "k2"):
        assert len(by_id[tcid]) < 20_000, (tcid, len(by_id[tcid]))
        assert "truncated for turn-start" in by_id[tcid], by_id[tcid][:120]
    assert n == 3
