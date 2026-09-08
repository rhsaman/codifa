"""ادغام جست‌وجوهای یکسانِ هم‌زمان: یک اجرای واقعی، رویدادهای مستقل."""

import asyncio

import pytest

import tools as T


@pytest.fixture(autouse=True)
def _clean_state():
    T._parent_search_cache.clear()
    T._search_generations.clear()
    T._search_inflight.clear()
    yield
    T._parent_search_cache.clear()
    T._search_generations.clear()
    T._search_inflight.clear()


async def test_identical_concurrent_searches_run_once():
    """دو جست‌وجوی یکسانِ هم‌زمان → یک اجرای واقعی، هر دو نتیجهٔ کامل می‌گیرند."""
    runs = []

    def slow_scan(root, pattern, path="", ctx=3, include=""):
        runs.append(pattern)
        # اجرای واقعی در thread دیگر؛ منتظر می‌مانیم تا هر دو فراخوان شروع شوند.
        import time
        time.sleep(0.05)
        return {"matches": [{"file": "a.py", "line": 1, "text": "x"}]}

    async def caller():
        return await T._shared_search(
            "/r", ("grep", "p", "", "", "3"), 0, slow_scan, "/r", "p",
        )

    results = await asyncio.gather(caller(), caller())
    assert len(runs) == 1
    assert all(r == {"matches": [{"file": "a.py", "line": 1, "text": "x"}]} for r in results)


async def test_different_searches_run_independently():
    """جست‌وجوهای متفاوت موازی می‌مانند — ادغام فقط برای عیناً یکسان است."""
    runs = []

    def scan_a(root, pattern, path="", ctx=3, include=""):
        runs.append(pattern)
        import time
        time.sleep(0.05)
        return {"matches": []}

    def scan_b(root, pattern, path="", ctx=3, include=""):
        runs.append(pattern)
        import time
        time.sleep(0.05)
        return {"matches": []}

    async def a():
        await asyncio.sleep(0)
        return await T._shared_search("/r", ("grep", "a", "", "", "3"), 0, scan_a, "/r", "a")

    async def b():
        await asyncio.sleep(0)
        return await T._shared_search("/r", ("grep", "b", "", "", "3"), 0, scan_b, "/r", "b")

    ra, rb = await asyncio.gather(a(), b())
    assert sorted(runs) == ["a", "b"]
    assert ra == {"matches": []} and rb == {"matches": []}


async def test_generation_isolation():
    """پس از ابطال (نسل جدید)، درخواست جدید به عملیات نسل قبلی متصل نمی‌شود."""
    runs = []

    def scan(root, pattern, path="", ctx=3, include=""):
        runs.append(pattern)
        import time
        time.sleep(0.05)
        return {"matches": []}

    first = asyncio.create_task(T._shared_search(
        "/r", ("grep", "p", "", "", "3"), 0, scan, "/r", "p",
    ))
    await asyncio.sleep(0)
    T._search_generations["/r"] = 1  # ابطال حین اجرا
    second = await T._shared_search(
        "/r", ("grep", "p", "", "", "3"), 1, scan, "/r", "p",
    )
    await first
    assert len(runs) == 2
    assert second == {"matches": []}


async def test_one_waiter_cancelled_scan_survives():
    """لغو یکی از منتظرها نباید عملیات مشترک را لغو کند."""
    runs = []

    def scan(root, pattern, path="", ctx=3, include=""):
        runs.append(pattern)
        import time
        time.sleep(0.05)
        return {"matches": []}

    t1 = asyncio.create_task(T._shared_search(
        "/r", ("grep", "p", "", "", "3"), 0, scan, "/r", "p",
    ))
    t2 = asyncio.create_task(T._shared_search(
        "/r", ("grep", "p", "", "", "3"), 0, scan, "/r", "p",
    ))
    await asyncio.sleep(0)
    t1.cancel()
    r2 = await t2
    assert r2 == {"matches": []}
    assert len(runs) == 1


async def test_error_propagates_and_no_stale_entry():
    """خطا به همهٔ منتظرها می‌رسد و ورودی معلق باقی نمی‌ماند."""
    def boom(root, pattern, path="", ctx=3, include=""):
        raise RuntimeError("شکست اسکن")

    with pytest.raises(RuntimeError):
        await T._shared_search("/r", ("grep", "p", "", "", "3"), 0, boom, "/r", "p")
    assert not T._search_inflight


async def test_workspace_isolation():
    """جست‌وجوی یکسان در دو فضای‌کاری متفاوت جدا اجرا می‌شود."""
    runs = []

    def scan(root, pattern, path="", ctx=3, include=""):
        runs.append(root)
        import time
        time.sleep(0.02)
        return {"matches": []}

    await asyncio.gather(
        T._shared_search("/r1", ("grep", "p", "", "", "3"), 0, scan, "/r1", "p"),
        T._shared_search("/r2", ("grep", "p", "", "", "3"), 0, scan, "/r2", "p"),
    )
    assert sorted(runs) == ["/r1", "/r2"]


def test_invalidation_drops_grep_glob_and_read_entries(tmp_path):
    """ابطال پس از ویرایش: نتایج grep/glob همان root و read همان فایل حذف می‌شوند."""
    root = str(tmp_path)
    a = tmp_path / "a.py"
    b = tmp_path / "b.py"
    a.write_text("x = 1\n", encoding="utf-8")
    b.write_text("y = 2\n", encoding="utf-8")
    T._parent_search_cache[("grep", "p", "", "", root, "50", "2000")] = "قدیمی"
    T._parent_search_cache[("glob", "*.py", "", "", root, "100")] = "قدیمی"
    T._parent_search_cache[("read", str(a), "1", "100")] = "قدیمی"
    T._parent_search_cache[("read", str(b), "1", "100")] = "قدیمی"
    T._search_generations[root] = 0
    T._invalidate_read_cache_for("a.py", root)
    assert ("grep", "p", "", "", root, "50", "2000") not in T._parent_search_cache
    assert ("glob", "*.py", "", "", root, "100") not in T._parent_search_cache
    assert ("read", str(a), "1", "100") not in T._parent_search_cache
    # فایل دیگر دست‌نخورده می‌ماند.
    assert ("read", str(b), "1", "100") in T._parent_search_cache
    assert T._search_generations[root] == 1
