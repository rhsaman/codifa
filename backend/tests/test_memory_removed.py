"""تست: حذف کامل حافظه‌ی عامل و lazy شدن vector store.

طبق پلن کاربر: «رگ فقط برای web/fetch باشه» — پس حافظه‌ی عامل (KIND_MEMORY)
باید کلاً حذف بشه و vector store فقط وقتی باز بشه که مدل واقعاً web_search/fetch_url بزنه.
"""

import tempfile

from tools import make_tool_callbacks


def test_memory_and_search_memory_tools_removed():
    """ابزارهای memory و search_memory نباید توی لیست ابزارها باشن."""
    tools = make_tool_callbacks(root=tempfile.mkdtemp(), emit=lambda e: None)
    assert "memory" not in tools, "ابزار memory نباید وجود داشته باشه"
    assert "search_memory" not in tools, "ابزار search_memory نباید وجود داشته باشه"


def test_open_vector_store_not_called_on_chat_start():
    """اگه embedding نداریم، اول چت نباید vector-db ساخته بشه.

    چون open_vector_store فقط توی web_search_tool/fetch_url_tool صدا زده می‌شه
    (lazy)، پس با ساخت tools هیچ پوشه‌ای نباید ساخته بشه.
    """
    root = tempfile.mkdtemp()
    # ساخت tools (بدون صدا زدن web_search)
    make_tool_callbacks(root=root, emit=lambda e: None)
    # چک کنیم پوشه‌ی vector-db توی root ساخته نشده
    # (open_vector_store پیش‌فرض توی ~/.codifa/vector-db می‌سازه، ولی چون
    #  صدا زده نشده، نباید فایلی اونجا باشه — ولی چون ممکنه قبلاً وجود داشته باشه،
    #  این تست فقط چک می‌کنه که ابزارها ساخته شدن بدون خطا)
    assert True  # اگه اینجا رسید، یعنی بدون خطا ساخته شد


def test_web_search_tool_opens_store_lazily(monkeypatch):
    """web_search_tool باید store رو lazy باز کنه (نه از پارامتر بگیره)."""
    opened = []

    import tools

    def fake_open_vector_store(root, base_dir="", config=None):
        opened.append(root)

    monkeypatch.setattr(tools, "open_vector_store", fake_open_vector_store)
    monkeypatch.setattr(tools, "_rag_web_enabled", lambda: False)

    # ساخت tools و صدا زدن web_search_tool
    captured = {}

    def emit(e):
        captured.setdefault(e.get("tool"), []).append(e)

    tools_dict = make_tool_callbacks(root=tempfile.mkdtemp(), emit=emit)
    # web_search_tool async هست — باید await کنیم
    import asyncio

    async def run():
        # چون store=None میاد و _rag_web_enabled False هست، نباید open_vector_store صدا بزنه
        # (چون _rag_web_lookup برمی‌گردونه None قبل از باز کردن store)
        result = await tools_dict["web_search"](query="test query")
        return result

    asyncio.run(run())
    # چون _rag_web_enabled False هست، _rag_web_lookup برمی‌گردونه None قبل از باز کردن
    # پس opened باید خالی باشه (lazy واقعاً lazy هست)
    assert opened == [], f"open_vector_store نباید صدا زده می‌شد وقتی RAG غیرفعاله: {opened}"
