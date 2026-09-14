"""Tool routing fixes:

* fetch_url is for WEB pages only — it must reject a local workspace path
  instead of silently web-fetching a file the model should read with `read`.
* request_permission is for OUTSIDE-workspace access. A path INSIDE the
  workspace root must auto-grant (no needless dialog); only genuinely
  OUTSIDE paths should require the user's approval.
"""
import asyncio
import os
import sys
import tempfile

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tools import make_tool_callbacks


def _callbacks(ws, gates=None):
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        permission_gates=gates if gates is not None else {},
        permit={},
    )
    return tools, emitted


async def test_fetch_url_rejects_local_path():
    ws = tempfile.mkdtemp()
    tools, emitted = _callbacks(ws)
    out = await tools["fetch_url"](os.path.join(ws, "package.json"))
    assert "web pages" in out, f"expected local-path rejection, got: {out}"
    assert "read" in out
    # The tool must NOT have performed a web fetch (no network) — only an error
    # tool_result is emitted.
    results = [e for e in emitted if e.get("kind") == "tool_result"]
    assert results and results[0].get("status") == "error"


async def test_request_permission_auto_grants_in_workspace():
    ws = tempfile.mkdtemp()
    tools, emitted = _callbacks(ws)
    inside = os.path.join(ws, "src", "main.py")
    out = await tools["request_permission"](action="read config", path=inside)
    assert "GRANTED" in out, f"in-workspace must auto-grant, got: {out}"
    # No permission DIALOG should be shown for in-workspace access.
    assert not any(e.get("kind") == "permission" for e in emitted)


async def test_request_permission_gates_outside_workspace():
    ws = tempfile.mkdtemp()
    tools, emitted = _callbacks(ws)
    outside = "/tmp/definitely-outside-the-workspace.txt"
    # An outside path must go to the permission gate (await a future) and NOT
    # auto-grant — so the coroutine should suspend, never returning quickly.
    timed_out = False
    try:
        await asyncio.wait_for(
            tools["request_permission"](action="read config", path=outside),
            timeout=0.2,
        )
    except asyncio.TimeoutError:
        timed_out = True
    assert timed_out, "outside-workspace access must NOT auto-grant"
    # It must have asked the user via a permission dialog.
    assert any(e.get("kind") == "permission" for e in emitted)


async def test_request_permission_grants_only_requested_folder():
    """تأیید کاربر فقط پوشه‌ی درخواستی را به permit["folders"] اضافه می‌کند —
    نه permit["outside"] (کل فضای بیرون) و نه پوشه‌های دیگر."""
    ws = tempfile.mkdtemp()
    gates: dict = {}
    permit: dict = {"outside": False, "folders": []}
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        permission_gates=gates,
        permit=permit,
    )
    allowed_dir = os.path.join(tempfile.gettempdir(), "permitted-by-dialog")
    os.makedirs(allowed_dir, exist_ok=True)
    target = os.path.join(allowed_dir, "cfg.toml")

    async def _grant():
        # پاسخ کاربر را شبیه‌سازی می‌کنیم: به‌محض ظاهرشدن دیالوگ، GRANT.
        for _ in range(50):
            if gates:
                pid, fut = next(iter(gates.items()))
                if not fut.done():
                    fut.set_result(True)
                del pid
                return
            await asyncio.sleep(0.01)

    task = asyncio.ensure_future(_grant())
    out = await asyncio.wait_for(
        tools["request_permission"](action="write config", path=target),
        timeout=2,
    )
    task.cancel()
    assert "GRANTED" in out
    # فقط پوشه‌ی درخواستی مجاز شده — نه کل فضای بیرون از ریشه.
    assert permit.get("outside") is not True
    assert permit["folders"] == [os.path.realpath(allowed_dir)]
    # رویداد permission باید پوشه‌ی نرمال‌شده را برای «همیشه اجازه» بفرستد.
    perm_events = [e for e in emitted if e.get("kind") == "permission"]
    assert perm_events and perm_events[0].get("folder") == os.path.realpath(allowed_dir)
    # درخواست بعدی برای همان پوشه باید بی‌دیالوگ auto-grant شود.
    emitted.clear()
    out2 = await tools["request_permission"](action="read config", path=target)
    assert "GRANTED" in out2
    assert not any(e.get("kind") == "permission" for e in emitted)


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
