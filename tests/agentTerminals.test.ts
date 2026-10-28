// Pure helpers of the right panel's Terminals section (run via
// test/run-frontend.sh). Covers: runningAgentTerminals (running-only filter,
// junk rows dropped) and formatRunningFor (the zcode-style "18m 35s" ticker).

import { runningAgentTerminals, formatRunningFor } from "../src/lib/agentTerminals"
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

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
