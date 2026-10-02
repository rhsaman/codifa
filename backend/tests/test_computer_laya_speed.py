"""تست سرعت/رفتار computer و Playwright با laya — بدون UI واقعی.

هدف: اثبات سریع‌تر شدن بدون شکستن رفتار قبلی —
see کمتر (گیت درخت)، درخت کوچک‌تر (عمق هوشمند + کش)، snapshot سبک‌تر
(فشرده‌سازی Playwright) و رتبه‌بندی درست selector/ابزار مرورگر.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import computer_use as cu
import laya_decide
import mcp_bridge


def _handled(value, kind="choice"):
    return laya_decide.LayaDecision(
        handled=True, kind=kind, value=value, confidence=0.9,
        abstained=False, reason="local-decision",
    )


def _abstained():
    return laya_decide.LayaDecision(
        handled=False, kind="choice", value=None, confidence=0.0,
        abstained=True, reason="abstained",
    )


def test_computer_next_step_shortcuts(monkeypatch):
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _handled("act_direct"),
    )
    assert laya_decide.computer_next_step("click the OK button", "Notes") == "act_direct"
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _handled("read_first"),
    )
    assert laya_decide.computer_next_step("explore the window", "Notes") == "read_first"
    assert laya_decide.computer_act_mode("type hello") in ("act", "sequence", None)
    # واگذاری امن: اطمینان پایین یعنی None و رفتار قبلی
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _abstained(),
    )
    assert laya_decide.computer_next_step("x", "y") is None
    assert laya_decide.browser_next_step("x") is None


def test_secondary_decisions_use_short_timeout(monkeypatch):
    seen: dict = {}

    def _fake_choice(state, options, threshold=0.65, provider_id="", timeout=4.0):
        seen["timeout"] = timeout
        return _handled(options[0])

    monkeypatch.setattr(laya_decide, "choice", _fake_choice)
    laya_decide.computer_next_step("click ok", "Notes")
    assert seen["timeout"] == laya_decide.SECONDARY_PREDICT_TIMEOUT
    laya_decide.browser_next_step("read page")
    assert seen["timeout"] == laya_decide.SECONDARY_PREDICT_TIMEOUT


def test_secondary_predict_skips_locked_router():
    import concurrent.futures

    laya_decide._PREDICT_LOCK.acquire()
    try:
        with __import__("pytest").raises(TimeoutError, match="locked"):
            laya_decide._predict_local(
                object(), {"a": "1"}, {"q": "x"},
                timeout=laya_decide.SECONDARY_PREDICT_TIMEOUT,
            )
    finally:
        laya_decide._PREDICT_LOCK.release()
    # تایم‌اوت اصلی همچنان منتظر قفل می‌ماند (رفتار قبلی مسیر FAST ROUTE).
    laya_decide._PREDICT_LOCK.acquire()
    try:
        def _slow() -> None:
            import time as _t

            _t.sleep(0.05)
            laya_decide._PREDICT_LOCK.release()

        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        pool.submit(_slow)
        out = laya_decide._predict_local(
            type("R", (), {"predict": lambda self, s, q: "ok"})(),
            {"a": "1"}, {"q": "x"}, timeout=4.0,
        )
        pool.shutdown(wait=True)
        assert out == "ok"
    finally:
        if laya_decide._PREDICT_LOCK.locked():
            laya_decide._PREDICT_LOCK.release()


def test_shallow_depth_accepts_borderline_confidence(monkeypatch):
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: laya_decide.LayaDecision(
            handled=True, kind="choice", value="shallow", confidence=0.51,
            abstained=False, reason="local-decision",
        ),
    )
    assert cu.suggest_tree_depth("Notes", "click") == cu._SHALLOW_TREE_DEPTH


def test_dock_activate_error_hints_real_app():
    msg = cu._friendly_error(RuntimeError("Can’t continue activate. (-1708)"))
    assert "Dock" in msg or "activate" in msg.lower()
    assert "open_app" in msg


def test_browser_next_step_and_rank(monkeypatch):
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _handled("snapshot_first"),
    )
    assert laya_decide.browser_next_step("read the page") == "snapshot_first"
    tools = [
        {"name": "browser_navigate", "description": "open a url in browser"},
        {"name": "browser_snapshot", "description": "read the page snapshot"},
        {"name": "browser_click", "description": "click an element"},
    ]
    ranked = laya_decide.rank_browser_tools("open the url", tools, top_k=2)
    assert isinstance(ranked, list)
    assert len(ranked) <= 2
    assert mcp_bridge.suggest_browser_snapshot_mode("read the page") in (
        "act_direct", "snapshot_first", None,
    )


def test_suggest_tree_depth_busy_app(monkeypatch):
    assert cu.suggest_tree_depth("Google Chrome", "click") == cu._SHALLOW_TREE_DEPTH
    # Notes شلوغ نیست و به laya می‌رسد — با abstain جلوی لود مدل واقعی را می‌گیریم
    # تا تست سریع بماند و قفل/روتر全局 تست‌های بعدی را آلوده نکند.
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _abstained(),
    )
    assert cu.suggest_tree_depth("Notes", "click") == cu.DEFAULT_MAX_DEPTH


def test_rank_actionable_targets_keeps_order_without_signal(monkeypatch):
    targets = ["button[name='OK'] -> center=(1,2)", "link[name='x'] -> center=(3,4)"]
    monkeypatch.setattr(laya_decide, "rank_selectors", lambda task, sels, top_k=5, **kw: [])
    assert cu.rank_actionable_targets("click ok", targets) == targets


def test_rank_actionable_targets_reorders_with_signal(monkeypatch):
    targets = ["button[name='OK'] -> center=(1,2)", "button[name='Cancel'] -> center=(3,4)"]
    monkeypatch.setattr(
        laya_decide, "rank_selectors",
        lambda task, sels, top_k=5, **kw: [
            {"name": targets[1], "confidence": 0.9, "score": 2.0, "reason": "keyword-rank"},
            {"name": targets[0], "confidence": 0.2, "score": 1.0, "reason": "keyword-rank"},
        ],
    )
    out = cu.rank_actionable_targets("cancel", targets)
    assert out[0] == targets[1]


def test_compact_browser_snapshot_trims_but_keeps_refs():
    big = "\n".join(
        [f"- generic filler line number {i} with some words" for i in range(400)]
        + ["- button \"Save\" [ref=e1] clicking saves the form"]
    )
    out = mcp_bridge.compact_browser_snapshot(big, task="click save", max_chars=2000)
    assert len(out) < len(big)
    assert "ref=e1" in out
    assert "truncated" in out


def test_compact_browser_snapshot_short_passthrough():
    assert mcp_bridge.compact_browser_snapshot("short", task="x") == "short"


def test_secondary_decisions_emit_trace_and_live(monkeypatch):
    import trace_store

    seen: list = []
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _handled("act_direct"),
    )
    trace_store.clear("chat-speed")
    out = laya_decide.computer_next_step("click ok", "Notes", chat_id="chat-speed", emit=seen.append)
    assert out == "act_direct"
    assert seen and seen[0].get("kind") == "laya"
    assert seen[0].get("route") == "computer"
    assert "computer_next_step" in str(seen[0].get("reason", ""))
    rows = trace_store.list_traces("chat-speed", "laya")
    assert any("computer_next_step" in str(r.get("detail", {}).get("sub", "")) for r in rows)
    trace_store.clear("chat-speed")


def test_step_route_gate_routes_and_falls_back(monkeypatch):
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _handled("cheap_step"),
    )
    assert laya_decide.step_route("click the next page", "browser_navigate", False, 3) == "cheap_step"
    assert laya_decide.step_route("think hard", "read", False, 5) == "cheap_step"
    # واگذاری امن: abstain یعنی None و گام روی مدل اصلی اجرا می‌شود.
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="", timeout=4.0, **_kw: _abstained(),
    )
    assert laya_decide.step_route("x") is None


def test_step_route_uses_short_timeout_and_small_state(monkeypatch):
    seen: dict = {}

    def _fake_choice(state, options, threshold=0.65, provider_id="", timeout=4.0):
        seen["timeout"] = timeout
        seen["state_keys"] = sorted(state.keys())
        return _handled(options[0])

    monkeypatch.setattr(laya_decide, "choice", _fake_choice)
    laya_decide.step_route("click ok", "browser_navigate", True, 2)
    assert seen["timeout"] == laya_decide.SECONDARY_PREDICT_TIMEOUT
    # The gate state is deliberately small — no transcript ever reaches it.
    assert seen["state_keys"] == ["last_error", "last_tools", "step", "task"]
