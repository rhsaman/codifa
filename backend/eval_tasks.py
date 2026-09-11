"""تسک‌های نمونه برای آزمونگاه ارزیابی ایجنت (``agent_eval.py``).

هر تسک یک پروژه کوچک چندزبانه است (پایتون، جاوااسکریپت، Go) با fixture
درون‌خطی و معیارهای خودکار — تا سنجش ایجنت به ریپوی فعلی وابسته نباشد
و «هر پروژه و هر زبان برنامه‌نویسی» قابل ارزیابی باشد.

هر تسک این بخش‌ها را دارد:
  * ``files``    — فایل‌های اولیه پروژه (fixture) که در ورک‌اسپیس موقت نوشته می‌شوند.
  * ``checks``   — معیارهای خودکار موفقیت (file_exists / file_contains / command / ...).
  * ``mock_script`` — پاسخ‌های اسکریپت‌شده برای حالت ``--mock`` (خودآزمایی harness).
  * ``requires`` — ابزارهای لازم روی PATH؛ اگر نباشند تسک SKIP می‌شود.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_eval import Check, EvalTask

# mock_openai در پوشه tests است؛ برای mock_script لازم است.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests"))
from mock_openai import text_reply, tool_call


def _tc(tool: str, args: dict, cid: str) -> list[dict]:
    """کمکی: ساخت پاسخ tool_call برای اسکریپت mock.

    ``cid`` باید در هر تسک یکتا باشد — گراف فراخوانی‌های هم‌شناسه را
    تکراری تشخیص می‌دهد و رد می‌کند (dedup بر پایه call_id).
    """
    return tool_call(tool, json.dumps(args), call_id=cid)


# ---------------------------------------------------------------------------
# تسک ۱: ایجاد فایل جدید در پروژه پایتونی
# ---------------------------------------------------------------------------
TASK_PY_CREATE = EvalTask(
    name="py-create-file",
    prompt=(
        "یک فایل جدید به نام utils.py در ریشه پروژه بساز که شامل تابع "
        "`add(a, b)` باشد و مقدار a+b را برگرداند. سپس یک فایل تست "
        "test_utils.py بنویس که با pytest صحت آن را بررسی کند."
    ),
    files={},
    checks=[
        Check(kind="file_exists", path="utils.py", label="utils.py ساخته شود"),
        Check(kind="file_contains", path="utils.py", text=r"def\s+add\s*\(",
              label="تابع add تعریف شود"),
        Check(kind="file_exists", path="test_utils.py", label="test_utils.py ساخته شود"),
        Check(kind="command", command="{python} -m pytest test_utils.py -q",
              label="pytest سبز شود", timeout=120),
        Check(kind="no_error_events", label="بدون رویداد خطا"),
    ],
    mock_script=[
        _tc("write_file", {"path": "utils.py",
                           "content": "def add(a, b):\n    return a + b\n"}, "c-py1"),
        _tc("write_file", {"path": "test_utils.py",
                           "content": "from utils import add\n\n\ndef test_add():\n"
                                      "    assert add(2, 3) == 5\n"}, "c-py2"),
        text_reply("انجام شد."),
    ],
)


# ---------------------------------------------------------------------------
# تسک ۲: رفع باگ در پروژه جاوااسکریپت
# ---------------------------------------------------------------------------
TASK_JS_FIX_BUG = EvalTask(
    name="js-fix-bug",
    prompt=(
        "در فایل src/math.js تابع `multiply` یک باگ دارد: به‌جای ضرب، جمع "
        "انجام می‌دهد. باگ را رفع کن و فایل src/math.test.js را هم اگر "
        "لازم است اصلاح کن تا تست‌ها پاس شوند."
    ),
    files={
        "package.json": json.dumps({
            "name": "eval-js-project",
            "version": "1.0.0",
            "scripts": {"test": "node src/math.test.js"},
        }, indent=2),
        "src/math.js": (
            "function multiply(a, b) {\n"
            "  return a + b; // BUG: should be multiplication\n"
            "}\n\n"
            "module.exports = { multiply };\n"
        ),
        "src/math.test.js": (
            "const { multiply } = require('./math');\n\n"
            "if (multiply(3, 4) !== 12) {\n"
            "  console.error('FAIL: multiply(3,4) =', multiply(3, 4));\n"
            "  process.exit(1);\n"
            "}\n"
            "console.log('OK');\n"
        ),
    },
    checks=[
        Check(kind="file_contains", path="src/math.js", text=r"a\s*\*\s*b",
              label="باگ ضرب رفع شود"),
        Check(kind="command", command="npm test --silent",
              label="npm test سبز شود", timeout=180),
        Check(kind="no_error_events", label="بدون رویداد خطا"),
    ],
    requires=["node", "npm"],
    mock_script=[
        _tc("read", {"filePath": "src/math.js"}, "c-js1"),
        _tc("edit_file", {"path": "src/math.js", "old_string": "return a + b;",
                          "new_string": "return a * b;"}, "c-js2"),
        text_reply("باگ رفع شد."),
    ],
)


# ---------------------------------------------------------------------------
# تسک ۳: اجرای تست در پروژه Go
# ---------------------------------------------------------------------------
TASK_GO_TEST = EvalTask(
    name="go-run-tests",
    prompt="تست‌های این پروژه Go را اجرا کن و اگر خطایی دیدی رفعش کن.",
    files={
        "go.mod": "module evalgo\n\ngo 1.21\n",
        "math.go": (
            "package evalgo\n\n"
            "// Add returns the sum.\n"
            "func Add(a, b int) int {\n"
            "\treturn a + b\n"
            "}\n"
        ),
        "math_test.go": (
            "package evalgo\n\n"
            "import \"testing\"\n\n"
            "func TestAdd(t *testing.T) {\n"
            "\tif Add(2, 3) != 5 {\n"
            "\t\tt.Errorf(\"Add(2,3) = %d, want 5\", Add(2, 3))\n"
            "\t}\n"
            "}\n"
        ),
    },
    checks=[
        Check(kind="command", command="go test ./...",
              label="go test سبز شود", timeout=180),
        Check(kind="no_error_events", label="بدون رویداد خطا"),
    ],
    requires=["go"],
    mock_script=[
        _tc("run_terminal", {"command": "go test ./..."}, "c-go1"),
        text_reply("تست‌ها پاس شدند."),
    ],
)


# ---------------------------------------------------------------------------
# تسک ۴: رفع باگ در پایتون با اجرای تست (رفتار واقعی‌تر)
# ---------------------------------------------------------------------------
TASK_PY_FIX_BUG = EvalTask(
    name="py-fix-bug",
    prompt=(
        "تست‌های این پروژه پایتون fail می‌شوند. باگ را در app.py پیدا و رفع کن."
    ),
    files={
        "app.py": (
            "def greet(name):\n"
            "    # BUG: greeting is wrong\n"
            "    return f\"Goodbye, {name}!\"\n"
        ),
        "test_app.py": (
            "from app import greet\n\n\n"
            "def test_greet():\n"
            "    assert greet(\"world\") == \"Hello, world!\"\n"
        ),
    },
    checks=[
        Check(kind="file_contains", path="app.py", text=r"Hello",
              label="سلام درست شود"),
        Check(kind="command", command="{python} -m pytest test_app.py -q",
              label="pytest سبز شود", timeout=120),
        Check(kind="no_error_events", label="بدون رویداد خطا"),
    ],
    mock_script=[
        _tc("read", {"filePath": "app.py"}, "c-py3"),
        _tc("edit_file", {"path": "app.py", "old_string": "Goodbye",
                          "new_string": "Hello"}, "c-py4"),
        text_reply("باگ رفع شد و تست‌ها سبز شدند."),
    ],
)


TASKS: list[EvalTask] = [
    TASK_PY_CREATE,
    TASK_JS_FIX_BUG,
    TASK_GO_TEST,
    TASK_PY_FIX_BUG,
]
