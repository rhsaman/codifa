"""تست: کارت task باید branch داشته باشه تا sub-eventها (grep/glob/read) توی
children نِست بشن — حتی وقتی کارت task قبلاً done شده باشه."""

from tools import make_tool_callbacks


class _FakeModel:
    """مدل تستی حداقلی: فقط برای اینکه task_tool مسیر اجرای زیرعامل رو
    طی کنه (در غیر این صورت با main_model=None کارت task با خطای
    'unavailable' برمی‌گرده و langchain_tool_loop هرگز صدا زده نمی‌شه)."""

    model_name = "fake"

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, msgs):
        from langchain_core.messages import AIMessage

        return AIMessage(content="ok")


def _make_cbs():
    events = []

    def emit(ev):
        events.append(ev)

    cbs = make_tool_callbacks(
        root="/tmp",
        emit=emit,
        main_model=_FakeModel(),
        explore_model=None,
    )
    return cbs, events


async def test_task_card_carries_branch():
    """کارت task باید فیلد branch رو emit کنه (همون _ecall)."""
    from unittest.mock import patch

    cbs, events = _make_cbs()

    async def fake_loop(*args, **kwargs):
        # زیرعامل هیچ ابزاری نمی‌زنه — فقط برمی‌گرده
        return "ok"

    with patch("llm.langchain_tool_loop", fake_loop):
        await cbs["task"](
            description="find auth code",
            prompt="search the repo",
            subagent_type="explore",
        )

    task_cards = [e for e in events if e.get("tool") == "task"]
    assert task_cards, "کارت task ساخته نشد"
    assert "branch" in task_cards[0], "کارت task branch نداره"
    assert task_cards[0]["branch"] is not None


async def test_sub_events_nest_under_task_card():
    """sub-eventهای grep/glob/read باید توی children کارت task نِست بشن."""
    from unittest.mock import patch

    cbs, events = _make_cbs()

    async def fake_loop(*args, **kwargs):
        k = kwargs
        emit = k["emit"]
        # شبیه‌سازی چند تا جستجوی داخلی زیرعامل
        emit({"kind": "tool", "tool": "grep", "args": {"pattern": "def auth"}})
        emit({"kind": "tool", "tool": "read", "args": {"path": "a.py"}})
        emit({"kind": "tool_result", "tool": "grep", "summary": "2 hits"})
        return "found it"

    with patch("llm.langchain_tool_loop", fake_loop):
        await cbs["task"](
            description="find auth code",
            prompt="search the repo",
            subagent_type="explore",
        )

    task_cards = [e for e in events if e.get("tool") == "task"]
    assert task_cards, "کارت task ساخته نشد"
    card = task_cards[0]
    # sub-eventها باید sub=True + branch یکسان داشته باشن
    subs = [e for e in events if e.get("sub") is True]
    assert subs, "هیچ sub-eventی emit نشد"
    for s in subs:
        assert s.get("branch") == card["branch"], "branch sub-event با کارت یکی نیست"


async def test_sub_events_nest_even_when_card_done():
    """حتی اگه کارت task قبلاً done شده باشه، sub-eventها باز هم نِست بشن
    (شبیه‌سازی ordering جابجا / resolveStuckCards)."""
    from unittest.mock import patch

    cbs, events = _make_cbs()

    async def fake_loop(*args, **kwargs):
        k = kwargs
        emit = k["emit"]
        # اول کارت task رو done می‌کنیم (شبیه‌سازی tool_result که زودتر رسیده)
        emit({"kind": "tool_result", "tool": "task", "summary": "done"})
        # بعد sub-eventها می‌رسن
        emit({"kind": "tool", "tool": "glob", "args": {"pattern": "**/*.py"}})
        emit({"kind": "tool_result", "tool": "glob", "summary": "10 files"})
        return "ok"

    with patch("llm.langchain_tool_loop", fake_loop):
        await cbs["task"](
            description="find py files",
            prompt="search the repo",
            subagent_type="explore",
        )

    task_cards = [e for e in events if e.get("tool") == "task"]
    assert task_cards, "کارت task ساخته نشد"
    card = task_cards[0]
    # کارت باید branch داشته باشه تا فرانت‌اند بتونه نِست کنه
    assert "branch" in card
    # sub-event glob باید branch یکسان داشته باشه
    glob_ev = [e for e in events if e.get("tool") == "glob"]
    assert glob_ev, "event glob emit نشد"
    assert glob_ev[0].get("branch") == card["branch"]
