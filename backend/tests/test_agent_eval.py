"""خودآزمایی آزمونگاه ارزیابی ایجنت (``agent_eval.py``).

با mock درون‌پردازشی ثابت می‌کند که harness درست کار می‌کند:
گریدر معیارها را درست قضاوت می‌کند، رانر ایجنت واقعی را اجرا می‌کند و
گزارش/JSON خروجی درست تولید می‌کند — بدون نیاز به پروایدر واقعی.
"""
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ.setdefault("CODER_DATA_DIR", os.path.join(
    __import__("tempfile").mkdtemp(prefix="coder-eval-test-data-")))

from mock_openai import mock, text_reply, tool_call

import agent_eval
from agent_eval import Check, EvalTask, grade_check, run_task

# ---------------------------------------------------------------------------
# گریدر: قضاوت معیارها به‌صورت مستقیم
# ---------------------------------------------------------------------------

def test_grade_file_checks(tmp_path):
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    ok = grade_check(Check(kind="file_exists", path="a.py"), str(tmp_path), [])
    assert ok.passed
    miss = grade_check(Check(kind="file_exists", path="nope.py"), str(tmp_path), [])
    assert not miss.passed
    contains = grade_check(
        Check(kind="file_contains", path="a.py", text=r"x\s*=\s*1"), str(tmp_path), [])
    assert contains.passed
    absent = grade_check(Check(kind="file_absent", path="nope.py"), str(tmp_path), [])
    assert absent.passed


def test_grade_no_error_events():
    ok = grade_check(Check(kind="no_error_events"), "", [
        {"kind": "text", "content": "hi"},
        {"kind": "tool_result", "tool": "read", "status": "ok"},
    ])
    assert ok.passed
    bad = grade_check(Check(kind="no_error_events"), "",
                      [{"kind": "error", "content": "boom"}])
    assert not bad.passed
    assert "1 error event" in bad.detail
    tool_err = grade_check(Check(kind="no_error_events"), "", [
        {"kind": "tool_result", "tool": "run_terminal",
         "status": "error", "summary": "exit 1"},
    ])
    assert not tool_err.passed


def test_grade_command_check(tmp_path):
    (tmp_path / "ok.txt").write_text("hi", encoding="utf-8")
    ok = grade_check(Check(kind="command", command="cat ok.txt"), str(tmp_path), [])
    assert ok.passed
    bad = grade_check(Check(kind="command", command="cat missing.txt"), str(tmp_path), [])
    assert not bad.passed
    assert "exit=" in bad.detail
    # {python} باید با مفسر جاری harness جایگزین شود
    py = grade_check(Check(kind="command", command='{python} -c "print(7)"'),
                     str(tmp_path), [])
    assert py.passed


def test_grade_unknown_check_kind():
    r = grade_check(Check(kind="bogus"), "", [])
    assert not r.passed
    assert "unknown check kind" in r.detail


# ---------------------------------------------------------------------------
# رانر: اجرای ایجنت واقعی روی mock + قضاوت
# ---------------------------------------------------------------------------

async def test_run_task_pass_with_mock(mock_server):
    """اسکریپت موفق باید تسک را PASS کند — ایجنت واقعی روی mock اجرا می‌شود."""
    base, _m = mock_server
    task = EvalTask(
        name="demo-pass",
        prompt="یک فایل hello.py بساز که print('hello') داشته باشد.",
        files={},
        checks=[
            Check(kind="file_exists", path="hello.py", label="فایل ساخته شود"),
            Check(kind="file_contains", path="hello.py", text=r"print\(.hello.\)",
                  label="print موجود باشد"),
            Check(kind="no_error_events", label="بدون خطا"),
        ],
        mock_script=[
            tool_call("write_file", json.dumps({
                "path": "hello.py", "content": "print('hello')\n"})),
            text_reply("انجام شد."),
        ],
    )
    mock.script = task.mock_script
    result = await run_task(task, provider="custom", model="mock-model",
                            base_url=base, api_key="test")
    assert result.passed, [c.detail for c in result.checks]
    assert result.tool_calls == 1
    assert result.error is None


async def test_run_task_fail_when_check_fails(mock_server):
    """اسکریپتی که فایل موردنظر را نمی‌سازد باید FAIL شود."""
    base, _m = mock_server
    task = EvalTask(
        name="demo-fail",
        prompt="یک فایل hello.py بساز.",
        files={},
        checks=[Check(kind="file_exists", path="hello.py", label="فایل ساخته شود")],
        mock_script=[text_reply("نمی‌سازمش.")],
    )
    mock.script = task.mock_script
    result = await run_task(task, provider="custom", model="mock-model",
                            base_url=base, api_key="test")
    assert not result.passed
    assert any(not c.passed for c in result.checks)


async def test_run_task_error_event_fails(mock_server):
    """رویداد خطا در استریم باید کل تسک را FAIL کند.

    با ``mock.error_at`` یک خطای ۵۰۰ در همان درخواست اول تزریق می‌کنیم؛
    گراف بعد از retryهای خودش رویداد error ساطع می‌کند.
    """
    base, _m = mock_server
    task = EvalTask(
        name="demo-error",
        prompt="هر کاری.",
        files={},
        checks=[Check(kind="no_error_events", label="بدون خطا")],
        mock_script=[text_reply("ok")],
    )
    mock.error_at = {0: (500, "internal server error")}
    result = await agent_eval.run_task(
        task, provider="custom", model="mock-model",
        base_url=base, api_key="test",
    )
    assert not result.passed
    assert result.error or any(not c.passed for c in result.checks)


async def test_run_task_skipped_when_requires_missing():
    """تسکِ نیازمند ابزارِ غایب باید بدون اجرای ایجنت SKIP شود."""
    task = EvalTask(
        name="demo-skip",
        prompt="هر کاری.",
        files={},
        checks=[Check(kind="file_exists", path="x.py")],
        requires=["definitely-missing-tool-xyz"],
    )
    result = await run_task(task, provider="custom", model="mock-model",
                            base_url="http://unused", api_key="test")
    assert result.skipped
    assert "definitely-missing-tool-xyz" in result.skip_reason
    assert result.tool_calls == 0
    assert result.checks == []


# ---------------------------------------------------------------------------
# گزارش و JSON
# ---------------------------------------------------------------------------

def test_format_report_and_json(tmp_path):
    r1 = agent_eval.TaskResult(name="t1", passed=True, time_seconds=1.2,
                               total_tokens=10, tool_calls=2)
    r2 = agent_eval.TaskResult(name="t2", passed=False, time_seconds=2.0,
                               total_tokens=20, tool_calls=1,
                               error="boom")
    r2.checks.append(agent_eval.CheckResult("file_exists", "فایل", False, "missing"))
    r3 = agent_eval.TaskResult(name="t3", passed=False, skipped=True,
                                skip_reason="نیازمند go")
    report = agent_eval.format_report([r1, r2, r3])
    assert "[PASS] t1" in report and "[FAIL] t2" in report
    assert "[SKIP] t3" in report
    assert "1/3" in report
    data = agent_eval.results_to_json([r1, r2, r3])
    assert data["summary"]["total"] == 3
    assert data["summary"]["passed"] == 1
    assert data["summary"]["skipped"] == 1
    assert data["tasks"][1]["checks"][0]["passed"] is False
    assert data["tasks"][2]["skipped"] is True
    # سریال‌سازی واقعی JSON هم باید کار کند
    out = tmp_path / "report.json"
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert json.loads(out.read_text(encoding="utf-8"))["summary"]["passed"] == 1


# ---------------------------------------------------------------------------
# تسک‌های نمونه: ساختار سالم
# ---------------------------------------------------------------------------

def test_eval_tasks_structure():
    from eval_tasks import TASKS
    assert len(TASKS) >= 4
    names = [t.name for t in TASKS]
    assert len(names) == len(set(names)), "نام تسک‌ها باید یکتا باشد"
    for t in TASKS:
        assert t.prompt and t.checks, f"تسک {t.name} باید prompt و checks داشته باشد"
        assert t.mock_script, f"تسک {t.name} باید mock_script داشته باشد"
        assert isinstance(t.requires, list), f"تسک {t.name} باید requires (list) داشته باشد"
        for c in t.checks:
            assert c.kind in {"file_exists", "file_contains", "file_absent",
                              "command", "no_error_events"}, \
                f"نوع معیار ناشناخته در {t.name}: {c.kind}"


def test_eval_tasks_mock_scripts_are_valid():
    """اسکریپت‌های mock باید فرمت درست mock_openai را داشته باشند."""
    from eval_tasks import TASKS
    for t in TASKS:
        assert isinstance(t.mock_script, list) and t.mock_script
        for item in t.mock_script:
            assert isinstance(item, list), \
                f"آیتم mock_script در {t.name} باید list باشد"
