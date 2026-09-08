"""تست‌های ترجیح ابزار مرورگر MCP (Playwright) به‌جای web_search.

وقتی کانکتور مرورگر (Playwright) live است، ``merge_mcp_tools`` باید
``web_search`` را از toolset حذف کند و ``_mcp_tools_note`` باید قانون
WEB RESEARCH را تزریق کند. بدون مرورگر، رفتار قبلی برقرار می‌ماند.
"""
from types import SimpleNamespace

from graph import _mcp_tools_note, merge_mcp_tools
from mcp_bridge import is_browser_mcp_tool


def _tool(name: str):
    return SimpleNamespace(name=name)


def test_is_browser_mcp_tool():
    assert is_browser_mcp_tool("mcp__playwright__browser_navigate")
    assert is_browser_mcp_tool("mcp__chrome__browser_click")
    # غیر مرورگر: ابزارهای MCP دیگر، ابزارهای native و نام‌های ناقص
    assert not is_browser_mcp_tool("mcp__docker__container_list")
    assert not is_browser_mcp_tool("web_search")
    assert not is_browser_mcp_tool("mcp__playwright")
    assert not is_browser_mcp_tool("mcp__a__b__browser_click")


def test_merge_mcp_tools_swaps_web_search_when_browser_live():
    filtered = {"web_search": _tool("web_search"), "fetch_url": _tool("fetch_url")}
    mcp = [_tool("mcp__playwright__browser_navigate"), _tool("mcp__docker__x")]
    live = merge_mcp_tools(filtered, mcp, None)
    assert live is True
    assert "web_search" not in filtered
    assert "fetch_url" in filtered  # fetch_url می‌ماند
    assert "mcp__playwright__browser_navigate" in filtered
    assert "mcp__docker__x" in filtered


def test_merge_mcp_tools_keeps_web_search_without_browser():
    filtered = {"web_search": _tool("web_search")}
    mcp = [_tool("mcp__docker__container_list")]
    live = merge_mcp_tools(filtered, mcp, None)
    assert live is False
    assert "web_search" in filtered
    assert "mcp__docker__container_list" in filtered


def test_merge_mcp_tools_drops_browser_when_web_denied():
    # cap web=False → ابزار مرورگر هم web access است و باید حذف شود،
    # اما web_search هم (طبق filter_tools_for_mode) از قبل حذف شده.
    filtered = {"web_search": _tool("web_search")}
    mcp = [_tool("mcp__playwright__browser_navigate"), _tool("mcp__docker__x")]
    live = merge_mcp_tools(filtered, mcp, {"web": False})
    assert live is True  # مرورگر live بود ولی به‌خاطر cap حذف شد
    assert "mcp__playwright__browser_navigate" not in filtered
    assert "mcp__docker__x" in filtered


def test_mcp_tools_note_disabled_rule_only_when_browser_live():
    browser = [_tool("mcp__playwright__browser_navigate")]
    docker = [_tool("mcp__docker__container_list")]
    assert "DISABLED" in _mcp_tools_note(browser, True)
    assert "browser_navigate" in _mcp_tools_note(browser, True)
    assert "DISABLED" not in _mcp_tools_note(docker, False)
    assert "docker" in _mcp_tools_note(docker, False)
    # بدون مرورگر ولی با ابزار live → فقط اتصال اعلام می‌شود
    assert "Connected" in _mcp_tools_note(docker, False)
