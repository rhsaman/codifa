// Pure helpers of the right panel's Terminals section (run via
// test/run-frontend.sh). Covers: runningAgentTerminals (running-only filter,
// junk rows dropped) and formatRunningFor (the zcode-style "18m 35s" ticker).

import {
  runningAgentTerminals,
  visibleAgentTerminals,
  terminalExitLabel,
  formatRunningFor,
  TERMINAL_EXIT_GRACE_MS,
} from "../src/lib/agentTerminals"
import type { AgentTerminalInfo } from "../src/lib/api"

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

function row(partial: Partial<AgentTerminalInfo>): AgentTerminalInfo {
  return {
    id: "bg-x",
    chat_id: "chat-a",
    command: "vite",
    cwd: "/w",
    started_at_ms: 0,
    running: true,
    exit_code: null,
    log_path: "/logs/x.log",
    pid: 1,
    ...partial,
  }
}

console.log("۱) runningAgentTerminals — فقط ردیف‌های در حال اجرا:")
{
  const rows = [
    row({ id: "bg-run", running: true }),
    row({ id: "bg-exit", running: false, exit_code: 0 }),
  ]
  const out = runningAgentTerminals(rows)
  check("ردیف running نگه داشته می‌شود", out.length === 1 && out[0].id === "bg-run", out)
  check("ردیف exited حذف می‌شود", !out.some((t) => t.id === "bg-exit"))
}

console.log("۲) runningAgentTerminals — ورودی خراب/خالی:")
{
  check("null → خالی", runningAgentTerminals(null as any).length === 0)
  check("undefined → خالی", runningAgentTerminals(undefined as any).length === 0)
  check("آرایه خالی → خالی", runningAgentTerminals([]).length === 0)
  // یک ردیف ناقص از بک‌اند قدیمی نباید کل پنل را بیندازد
  const broken = [null, {}, row({ running: false })] as any
  check("ردیف ناقص حذف می‌شود", runningAgentTerminals(broken).length === 0)
}

console.log("۳) formatRunningFor — قالب zcode («18m 35s»):")
{
  check("زیر یک دقیقه فقط ثانیه", formatRunningFor(42_000) === "42s", formatRunningFor(42_000))
  check("دقیقه و ثانیه با صفر پیش‌رو", formatRunningFor(18 * 60_000 + 35_000) === "18m 35s")
  check("مرز دقیقه", formatRunningFor(60_000) === "1m 00s", formatRunningFor(60_000))
  check("بعد از یک ساعت ساعت هم می‌آید", formatRunningFor(3600_000 + 120_000) === "1h 02m 00s", formatRunningFor(3720_000))
  check("منفی → صفر ثانیه", formatRunningFor(-5) === "0s", formatRunningFor(-5))
  check("کسری از ثانیه رند پایین می‌شود", formatRunningFor(1_999) === "1s", formatRunningFor(1_999))
}

console.log("۴) visibleAgentTerminals — زنده‌ها + خروج‌یافته‌های داخل پنجرهٔ grace:")
{
  const now = 1_000_000
  const rows = [
    row({ id: "bg-run", running: true }),
    // خروجِ تازه — دستور کوتاهی که بین دو پول تمام شده ولی باید دیده شود
    row({ id: "bg-fresh", running: false, exit_code: 0, exited_at_ms: now - 5_000 }),
    // خروجِ قدیم‌تر از پنجره
    row({
      id: "bg-old",
      running: false,
      exit_code: 1,
      exited_at_ms: now - TERMINAL_EXIT_GRACE_MS - 1,
    }),
    // ردیف مردهٔ قدیمی بدون مُهر زمان (بک‌اند قدیمی) — مثل قبل پنهان
    row({ id: "bg-legacy", running: false, exit_code: 0 }),
  ]
  const out = visibleAgentTerminals(rows, now)
  check("ردیف زنده نشان داده می‌شود", out.some((t) => t.id === "bg-run"), out)
  check("خروجِ تازه (داخل grace) نشان داده می‌شود", out.some((t) => t.id === "bg-fresh"), out)
  check("خروجِ قدیم‌تر از grace حذف می‌شود", !out.some((t) => t.id === "bg-old"), out)
  check("خروجِ بدون مُهر زمان (legacy) حذف می‌شود", !out.some((t) => t.id === "bg-legacy"), out)
  check("مرز دقیق پنجره (خودِ TERMINAL_EXIT_GRACE_MS) نشان داده می‌شود",
    visibleAgentTerminals(
      [row({ running: false, exit_code: 0, exited_at_ms: now - TERMINAL_EXIT_GRACE_MS })],
      now,
    ).length === 1)
  // مُهر زمانِ جلوتر از ساعت فرانت (skew بک‌اند) نباید ردیف منفی‌نشده بسازد
  check("مُهر زمانِ آینده حذف می‌شود",
    visibleAgentTerminals(
      [row({ running: false, exit_code: 0, exited_at_ms: now + 60_000 })],
      now,
    ).length === 0)
}

console.log("۵) visibleAgentTerminals — ورودی خراب/خالی:")
{
  check("null → خالی", visibleAgentTerminals(null as any, 0).length === 0)
  check("undefined → خالی", visibleAgentTerminals(undefined as any, 0).length === 0)
  check("آرایه خالی → خالی", visibleAgentTerminals([], 0).length === 0)
  const broken = [null, {}, row({ running: false, exited_at_ms: 999 })] as any
  check("ردیف ناقص حذف می‌شود", visibleAgentTerminals(broken, 1_000).length === 1)
}

console.log("۶) terminalExitLabel — برچسب وضعیت ردیف خروج‌یافته:")
{
  check("کد صفر → «exit 0»", terminalExitLabel(row({ running: false, exit_code: 0 })) === "exit 0")
  check("کد ناموفق → «exit 3»", terminalExitLabel(row({ running: false, exit_code: 3 })) === "exit 3")
  check("بدون کد → «finished»", terminalExitLabel(row({ running: false, exit_code: null })) === "finished")
  check("کد undefined → «finished»", terminalExitLabel(row({ running: false })) === "finished")
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
