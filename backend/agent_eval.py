"""آزمونگاه ارزیابی ایجنت (agent evaluation harness).

اجرای ایجنتِ واقعی روی تسک‌های تعریف‌شده در ``eval_tasks.py``، در یک
ورک‌اسپیس موقت، و قضاوت خودکار نتیجه با معیارهای اعلامی. هدف: سنجش
توانایی ایجنت روی «هر پروژه و هر زبان برنامه‌نویسی» — نه فقط همین ریپو.

اجرا (پروایدر واقعی):

    uv run python agent_eval.py --provider openrouter --model qwen3-coder-480b

اجرا با mock درون‌پردازشی (بدون هزینه، برای خودآزمایی harness):

    uv run python agent_eval.py --mock

گزارش: جدول متنی روی کنسول + فایل JSON اختیاری با ``--json``.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agents import run_agent

# ---------------------------------------------------------------------------
# مدل‌های داده
# ---------------------------------------------------------------------------

@dataclass
class Check:
    """یک معیار خودکار روی نتیجه اجرا.

    نوع‌های پشتیبانی‌شده:
      * ``file_exists``   — path باید وجود داشته باشد.
      * ``file_contains`` — path باید شامل متن باشد (regex، با re.search).
      * ``file_absent``   — path نباید وجود داشته باشد.
      * ``command``       — اجرای یک فرمان در ورک‌اسپیس؛ موفق یعنی
                            exit_code == 0 (مگر با expected_exit مشخص شود).
      * ``no_error_events`` — هیچ رویداد SSE از نوع error و هیچ فراخوانی
                             ابزار ناموفق (tool_result با status=error).
    """

    kind: str
    path: str = ""
    text: str = ""
    command: str = ""
    expected_exit: int | None = None
    timeout: float = 120.0
    label: str = ""


@dataclass
class EvalTask:
    """یک تسک ارزیابی: پرامپت + فایل‌های اولیه + معیارهای موفقیت.

    ``mock_script`` فقط در حالت ``--mock`` استفاده می‌شود: پاسخ‌های
    از پیش اسکریپت‌شده برای mock سرور، تا خودِ harness قابل آزمودن باشد
    بدون هزینه پروایدر واقعی.

    ``requires`` — نام executableهایی که باید روی PATH موجود باشند؛
    اگر نباشند تسک بدون اجرای ایجنت SKIP می‌شود (صرفه‌جویی در توکن).
    """

    name: str
    prompt: str
    files: dict[str, str] = field(default_factory=dict)
    checks: list[Check] = field(default_factory=list)
    mode: str = "coder"
    timeout: float = 600.0
    mock_script: list[list[dict] | None] = field(default_factory=list)
    requires: list[str] = field(default_factory=list)


@dataclass
class CheckResult:
    kind: str
    label: str
    passed: bool
    detail: str = ""


@dataclass
class TaskResult:
    name: str
    passed: bool
    checks: list[CheckResult] = field(default_factory=list)
    time_seconds: float = 0.0
    total_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    error: str | None = None
    output_preview: str = ""
    skipped: bool = False
    skip_reason: str = ""


# ---------------------------------------------------------------------------
# گریدر
# ---------------------------------------------------------------------------

def _run_command_in(root: str, command: str, timeout: float) -> tuple[int, str]:
    """اجرای فرمان در ورک‌اسپیس؛ خروجی (exit_code, stdout+stderr).

    از ``subprocess`` همگام استفاده می‌کند تا هم داخل لوپ async رانر کار کند
    (گریدر بعد از پایان استریم ایجنت اجرا می‌شود) و هم در تست‌های همگام.
    ``{python}`` در فرمان با مفسر جاری harness جایگزین می‌شود.
    """
    command = command.replace("{python}", shlex.quote(sys.executable))
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=root,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        out = (proc.stdout or b"") + (proc.stderr or b"")
        return proc.returncode, out.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return 124, f"timeout after {timeout}s"
    except Exception as exc:  # noqa: BLE001 — خطای فرمان بخشی از نتیجه است
        return 1, f"{type(exc).__name__}: {exc}"


def grade_check(check: Check, root: str, events: list[dict]) -> CheckResult:
    """ارزیابی یک معیار؛ همیشه نتیجه برمی‌گرداند (هرگز exception نمی‌دهد)."""
    label = check.label or check.kind
    try:
        if check.kind == "file_exists":
            ok = (Path(root) / check.path).is_file()
            return CheckResult(check.kind, label, ok,
                               check.path if not ok else "")
        if check.kind == "file_absent":
            ok = not (Path(root) / check.path).exists()
            return CheckResult(check.kind, label, ok,
                               f"unexpected file: {check.path}" if not ok else "")
        if check.kind == "file_contains":
            p = Path(root) / check.path
            if not p.is_file():
                return CheckResult(check.kind, label, False, f"missing file: {check.path}")
            ok = bool(re.search(check.text, p.read_text(encoding="utf-8", errors="replace")))
            return CheckResult(check.kind, label, ok,
                               f"pattern not found: {check.text!r}" if not ok else "")
        if check.kind == "command":
            code, out = _run_command_in(root, check.command, check.timeout)
            ok = (code == check.expected_exit) if check.expected_exit is not None else (code == 0)
            if ok:
                return CheckResult(check.kind, label, True, f"exit=0, {len(out)} chars")
            tail = " | ".join(out.strip().splitlines()[-3:])[:200]
            return CheckResult(check.kind, label, False,
                               f"exit={code}" + (f" — {tail}" if tail else ""))
        if check.kind == "no_error_events":
            errs = [
                e for e in events
                if e.get("kind") == "error"
                or (e.get("kind") == "tool_result" and e.get("status") == "error")
            ]
            return CheckResult(check.kind, label, not errs,
                               f"{len(errs)} error event(s)" if errs else "")
        return CheckResult(check.kind, label, False, f"unknown check kind: {check.kind}")
    except Exception as exc:  # noqa: BLE001 — خطای گریدر نباید کل ارزیابی را بکشد
        return CheckResult(check.kind, label, False, f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# رانر
# ---------------------------------------------------------------------------

async def run_task(
    task: EvalTask,
    *,
    provider: str,
    model: str,
    base_url: str,
    api_key: str,
    keep_workspace: bool = False,
) -> TaskResult:
    """اجرای یک تسک در ورک‌اسپیس موقت و جمع‌آوری نتیجه + معیارها."""
    result = TaskResult(name=task.name, passed=False)
    missing = [c for c in (task.requires or []) if shutil.which(c) is None]
    if missing:
        result.skipped = True
        result.skip_reason = f"نیازمند {', '.join(missing)} روی PATH"
        return result
    start = time.time()
    events: list[dict] = []
    workspace = ""
    try:
        workspace = tempfile.mkdtemp(prefix=f"agent_eval_{task.name}_")
        root = Path(workspace)
        for rel, content in (task.files or {}).items():
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        async def _consume():
            async for ev in run_agent(
                provider=provider,
                model_name=model,
                base_url=base_url,
                api_key=api_key,
                root=workspace,
                mode=task.mode,
                prompt=task.prompt,
                history=[],
                chat_id=f"eval-{task.name}",
            ):
                events.append(ev)
                if ev.get("kind") == "usage":
                    result.total_tokens = ev.get("total_tokens", 0) or result.total_tokens
                    result.input_tokens = ev.get("input_tokens", 0) or result.input_tokens
                    result.output_tokens = ev.get("output_tokens", 0) or result.output_tokens
                elif ev.get("kind") == "tool":
                    result.tool_calls += 1
                elif ev.get("kind") == "text":
                    result.output_preview += ev.get("content", "")
                elif ev.get("kind") == "error":
                    if not result.error:
                        result.error = ev.get("content", "")

        await asyncio.wait_for(_consume(), timeout=task.timeout)

        result.checks = [grade_check(c, workspace, events) for c in task.checks]
        result.passed = all(c.passed for c in result.checks) and result.error is None
    except asyncio.TimeoutError:
        result.error = f"timeout after {task.timeout}s"
    except Exception as exc:  # noqa: BLE001 — خطا بخشی از گزارش ارزیابی است
        result.error = f"{type(exc).__name__}: {exc}"
    finally:
        result.time_seconds = time.time() - start
        if not keep_workspace:
            _cleanup_tree(workspace)
    return result


def _cleanup_tree(path: str) -> None:
    """حذف امن ورک‌اسپیس موقت (خطاها نادیده — پاک‌سازی best-effort است)."""
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:  # noqa: BLE001, S110
        pass


# ---------------------------------------------------------------------------
# گزارش
# ---------------------------------------------------------------------------

def format_report(results: list[TaskResult]) -> str:
    """گزارش متنی جدولی برای کنسول."""
    lines = ["", "=" * 72, "گزارش ارزیابی ایجنت", "=" * 72]
    for r in results:
        if r.skipped:
            lines.append(f"[SKIP] {r.name} — {r.skip_reason}")
            continue
        status = "PASS" if r.passed else "FAIL"
        lines.append(f"[{status}] {r.name}  ({r.time_seconds:.1f}s, "
                     f"{r.total_tokens} tokens, {r.tool_calls} tool calls)")
        for c in r.checks:
            mark = "✓" if c.passed else "✗"
            line = f"    {mark} {c.label}"
            if c.detail:
                line += f" — {c.detail}"
            lines.append(line)
        if r.error:
            lines.append(f"    ! خطا: {r.error[:200]}")
    passed = sum(1 for r in results if r.passed)
    skipped = sum(1 for r in results if r.skipped)
    lines.append("=" * 72)
    summary = f"نتیجه: {passed}/{len(results)} تسک موفق"
    if skipped:
        summary += f" ({skipped} ردشده)"
    lines.append(summary)
    lines.append("=" * 72)
    return "\n".join(lines)


def results_to_json(results: list[TaskResult]) -> dict:
    """سریال‌سازی نتایج برای فایل JSON."""
    return {
        "summary": {
            "total": len(results),
            "passed": sum(1 for r in results if r.passed),
            "skipped": sum(1 for r in results if r.skipped),
        },
        "tasks": [
            {
                "name": r.name,
                "passed": r.passed,
                "skipped": r.skipped,
                "skip_reason": r.skip_reason,
                "time_seconds": round(r.time_seconds, 2),
                "total_tokens": r.total_tokens,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "tool_calls": r.tool_calls,
                "error": r.error,
                "output_preview": r.output_preview[:500],
                "checks": [
                    {"kind": c.kind, "label": c.label, "passed": c.passed, "detail": c.detail}
                    for c in r.checks
                ],
            }
            for r in results
        ],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="آزمونگاه ارزیابی ایجنت")
    p.add_argument("--provider", default="openrouter", help="نوع پروایدر (پیش‌فرض: openrouter)")
    p.add_argument("--model", default="qwen3-coder-480b", help="نام مدل")
    p.add_argument("--base-url", default="", help="base_url دلخواه (برای پروایدر custom)")
    p.add_argument("--api-key", default="", help="کلید API (پیش‌فرض: از env_key)")
    p.add_argument("--task", action="append", help="فقط اجرای تسک(های) نام‌داده‌شده")
    p.add_argument("--json", default="", help="مسیر ذخیره گزارش JSON")
    p.add_argument("--mock", action="store_true",
                   help="اجرای درون‌پردازشی با mock (بدون پروایدر واقعی)")
    p.add_argument("--keep", action="store_true",
                   help="ورک‌اسپیس موقت را پاک نکن (برای دیباگ)")
    return p.parse_args(argv)


def _resolve_api_key(provider: str, api_key: str) -> str:
    if api_key:
        return api_key
    from providers import env_key
    return env_key(provider)


async def _run_mock_mode(tasks: list[EvalTask]) -> list[TaskResult]:
    """اجرای تسک‌ها با mock درون‌پردازشی (برای خودآزمایی harness)."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests"))
    from mock_openai import mock, start_server, stop_server

    task, base = await start_server()
    results: list[TaskResult] = []
    try:
        for t in tasks:
            mock.script = list(t.mock_script)
            results.append(await run_task(
                t, provider="custom", model="mock-model",
                base_url=base, api_key="test",
            ))
    finally:
        await stop_server(task)
    return results


async def _main(argv: list[str]) -> int:
    from eval_tasks import TASKS

    args = _parse_args(argv)
    selected = [t for t in TASKS if not args.task or t.name in args.task]
    if not selected:
        print("هیچ تسکی انتخاب نشد.")
        return 2

    if args.mock:
        results = await _run_mock_mode(selected)
    else:
        api_key = _resolve_api_key(args.provider, args.api_key)
        if not api_key:
            print(f"کلید API برای {args.provider} پیدا نشد.")
            return 2
        results = [
            await run_task(t, provider=args.provider, model=args.model,
                           base_url=args.base_url, api_key=api_key,
                           keep_workspace=args.keep)
            for t in selected
        ]

    print(format_report(results))
    if args.json:
        Path(args.json).write_text(
            json.dumps(results_to_json(results), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"گزارش JSON در {args.json} ذخیره شد.")
    return 0 if all(r.passed or r.skipped for r in results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(_main(sys.argv[1:])))
