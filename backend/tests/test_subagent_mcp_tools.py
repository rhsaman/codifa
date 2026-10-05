"""Sub-agents must survive live MCP tools in the inherited parent toolset.

``graph.merge_mcp_tools`` injects ready BaseTool instances (MCP tools built by
``mcp_bridge._make_tool``) INTO the same dict that ``_PARENT_TOOLS_CTX``
references, so a spawned sub-agent's toolset mixes plain callbacks with
BaseTool instances. Regression for the crash this caused:

``descriptor '__call__' for 'type' objects doesn't apply to a 'StructuredTool'
object`` — ``langchain_tool_loop`` rebuilt ``StructuredTool.from_function``
around each value, and ``inspect``-ing a BaseTool INSTANCE resolves
``__call__`` through the metaclass (BaseTool defines no ``__call__`` of its
own). BaseTool values are now passed through untouched and invoked via the
Runnable ``ainvoke`` API.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subagent-mcp-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from conftest import await_task_report
from langchain_core.messages import AIMessage
from langchain_core.tools import BaseTool, StructuredTool

from tools import _PARENT_TOOLS_CTX, make_tool_callbacks


class _BindRecordingModel:
    """Fake model: records bound tool names + transcripts, calls the MCP tool."""

    model_name = "fake"

    def __init__(self, tool_to_call: str, reply: str = "MCP DONE") -> None:
        self._tool_to_call = tool_to_call
        self._reply = reply
        self._called = False
        self.bound_names: list[str] = []
        self.last_msgs: list = []

    def bind_tools(self, lc_tools):
        self.bound_names = [str(getattr(t, "name", "") or "") for t in lc_tools]
        return self

    async def ainvoke(self, msgs):
        self.last_msgs = list(msgs)
        if not self._called:
            self._called = True
            return AIMessage(
                content="",
                tool_calls=[
                    {"name": self._tool_to_call, "args": {"query": "x"}, "id": "m1"}
                ],
            )
        return AIMessage(content=self._reply)


def _fake_mcp_tool() -> BaseTool:
    async def _run(query: str) -> str:
        return f"MCPRESULT:{query}"

    return StructuredTool.from_function(
        coroutine=_run, name="container_list", description="[MCP:docker] list"
    )


async def test_task_subagent_runs_with_mcp_base_tool_in_parent_toolset():
    model = _BindRecordingModel("container_list")
    cbs = make_tool_callbacks(
        tempfile.mkdtemp(prefix="coder-test-mcp-ws-"),
        lambda ev: None,
        main_model=model,
    )
    st = _fake_mcp_tool()
    token = _PARENT_TOOLS_CTX.set({"container_list": st, "read": cbs["read"]})
    try:
        ack = await cbs["task"](
            description="list containers",
            prompt="List the docker containers via the MCP tool.",
            subagent_type="subagent",
        )
        report = await await_task_report(ack)
    finally:
        _PARENT_TOOLS_CTX.reset(token)
    assert "MCP DONE" in str(report), f"sub-agent failed: {report!r}"
    # The MCP tool was bound under its short name (instance .name == key).
    assert "container_list" in model.bound_names, model.bound_names
    # And it actually executed via the Runnable path (no __call__ crash):
    # a ToolMessage with the tool's output is in the transcript.
    tool_contents = [
        str(getattr(m, "content", ""))
        for m in model.last_msgs
        if type(m).__name__ == "ToolMessage"
    ]
    assert any("MCPRESULT:x" in c for c in tool_contents), tool_contents


async def test_subagent_inherits_mcp_tools_unwrapped():
    model = _BindRecordingModel("container_list")
    cbs = make_tool_callbacks(
        tempfile.mkdtemp(prefix="coder-test-mcp-ws2-"),
        lambda ev: None,
        main_model=model,
    )
    st = _fake_mcp_tool()
    token = _PARENT_TOOLS_CTX.set({"container_list": st})
    try:
        ack = await cbs["task"](
            description="mcp work",
            prompt="Use the connector.",
            subagent_type="subagent",
        )
        report = await await_task_report(ack)
    finally:
        _PARENT_TOOLS_CTX.reset(token)
    assert "MCP DONE" in str(report), f"sub-agent failed: {report!r}"
    assert "container_list" in model.bound_names


if __name__ == "__main__":
    asyncio.run(test_task_subagent_runs_with_mcp_base_tool_in_parent_toolset())
    asyncio.run(test_subagent_inherits_mcp_tools_unwrapped())
    print("OK")
