"""Browser MCP (Playwright) coexists with web_search.

When the browser connector is live, ``merge_mcp_tools`` keeps both
``web_search`` and browser tools, and ``_mcp_tools_note`` injects a
selection guide. Without a browser, previous behavior is unchanged.
"""
from types import SimpleNamespace

from graph import _mcp_tools_note, merge_mcp_tools
from mcp_bridge import is_browser_mcp_tool


def _tool(name: str):
    return SimpleNamespace(name=name)


def test_is_browser_mcp_tool():
    # فرم کوتاه (binding اصلی) و فرم کامل (fallback برخورد)
    assert is_browser_mcp_tool("browser_navigate")
    assert is_browser_mcp_tool("browser_click")
    assert is_browser_mcp_tool("mcp__playwright__browser_navigate")
    assert is_browser_mcp_tool("mcp__chrome__browser_click")
    # غیر مرورگر: ابزارهای MCP دیگر، ابزارهای native و نام‌های ناقص
    assert not is_browser_mcp_tool("mcp__docker__container_list")
    assert not is_browser_mcp_tool("web_search")
    assert not is_browser_mcp_tool("mcp__playwright")
    assert not is_browser_mcp_tool("mcp__a__b__browser_click")
    assert not is_browser_mcp_tool("navigate")


def test_merge_mcp_tools_keeps_web_search_when_browser_live():
    filtered = {"web_search": _tool("web_search"), "fetch_url": _tool("fetch_url")}
    # MCP tools bind under short names (browser_navigate)
    mcp = [_tool("browser_navigate"), _tool("container_list")]
    live = merge_mcp_tools(filtered, mcp, None)
    assert live is True
    assert "web_search" in filtered  # web_search stays free alongside browser
    assert "fetch_url" in filtered
    assert "browser_navigate" in filtered
    assert "container_list" in filtered


def test_merge_mcp_tools_keeps_web_search_without_browser():
    filtered = {"web_search": _tool("web_search")}
    mcp = [_tool("container_list")]
    live = merge_mcp_tools(filtered, mcp, None)
    assert live is False
    assert "web_search" in filtered
    assert "container_list" in filtered


def test_merge_mcp_tools_drops_browser_when_web_denied():
    # cap web=False → ابزار مرورگر هم web access است و باید حذف شود،
    # اما web_search هم (طبق filter_tools_for_mode) از قبل حذف شده.
    filtered = {"web_search": _tool("web_search")}
    mcp = [_tool("browser_navigate"), _tool("container_list")]
    live = merge_mcp_tools(filtered, mcp, {"web": False})
    assert live is True  # مرورگر live بود ولی به‌خاطر cap حذف شد
    assert "browser_navigate" not in filtered
    assert "container_list" in filtered


def test_mcp_tools_note_guide_only_when_browser_live():
    browser = [_tool("browser_navigate")]
    docker = [_tool("container_list")]
    note = _mcp_tools_note(browser, True)
    assert "DISABLED" not in note
    assert "web_search" in note  # selection guide mentions both options
    assert "browser_navigate" in note
    assert "MUST" in note  # open-site requests must use the browser
    assert "never answer an open-site request with web_search" in note
    assert "DISABLED" not in _mcp_tools_note(docker, False)
    assert "web_search" not in _mcp_tools_note(docker, False)
    # live tools without a browser -> only the connection is announced
    assert "Connected" in _mcp_tools_note(docker, False)


def test_mcp_tools_note_reads_server_from_metadata():
    # Server is read from metadata (short names carry no mcp__ prefix);
    # name parsing is only the fallback.
    t = SimpleNamespace(name="browser_navigate", metadata={"mcp_server": "playwright"})
    note = _mcp_tools_note([t], True)
    assert "playwright" in note
    # Without metadata -> full-name parsing as fallback
    t2 = SimpleNamespace(name="mcp__docker__container_list", metadata={})
    assert "docker" in _mcp_tools_note([t2], False)


def test_mcp_tools_note_tolerates_short_name_without_metadata():
    """A short-named tool without metadata must not crash (no IndexError) —
    it is just skipped in the server list."""
    tools = [_tool("browser_navigate"), _tool("mcp__docker__x")]
    note = _mcp_tools_note(tools, True)  # must not raise IndexError
    assert "docker" in note
    assert "Connected" in note
