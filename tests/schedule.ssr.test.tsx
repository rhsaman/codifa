// SSR sanity test for SchedulePanel pure helpers (run via tests/run-frontend.sh).
// Covers: formatNextRunFa (امروز/فردا/تاریخ/خالی) + runStatusFa (done/error/running).
//
// Mock the Electron/browser bridge before importing the component (the store
// module touches `window.coder` at import time).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) {
      return this._d[k] ?? null
    },
    setItem(k: string, v: string) {
      this._d[k] = String(v)
    },
    removeItem(k: string) {
      delete this._d[k]
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const { formatNextRunFa, runStatusFa } = await import(
  "../src/components/SchedulePanel"
)
const { unseenRunCount } = await import("../src/components/ScheduleInbox")

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

console.log("۱) formatNextRunFa — بدون نوبت:")
{
  check("null → No next run", formatNextRunFa(null) === "No next run")
  check("undefined → No next run", formatNextRunFa(undefined) === "No next run")
}

console.log("۲) formatNextRunFa — امروز/فردا:")
{
  const nowSec = Math.floor(Date.now() / 1000)
  const today = formatNextRunFa(nowSec + 3600)
  check("یک ساعت بعد Today است", today.startsWith("Today"), today)
  const tomorrow = formatNextRunFa(nowSec + 86400)
  // اگر ساعت +۲۴h روز بعد باشد «Tomorrow»، وگرنه تاریخ (مرز روز) — هر دو قابل‌قبول نیست؛ دقیق چک می‌کنیم
  const d = new Date((nowSec + 86400) * 1000)
  const isTomorrow = d.toDateString() === new Date(Date.now() + 86400000).toDateString()
  if (isTomorrow) {
    check("۲۴ ساعت بعد Tomorrow است", tomorrow.startsWith("Tomorrow"), tomorrow)
  } else {
    check("۲۴ ساعت بعد تاریخ دارد", !tomorrow.startsWith("Today"), tomorrow)
  }
}

console.log("۳) formatNextRunFa — تاریخ دور:")
{
  const far = formatNextRunFa(1893456000) // 2030-01-01 UTC
  check("تاریخ دور نه Today است نه Tomorrow", !far.startsWith("Today") && !far.startsWith("Tomorrow"), far)
}

console.log("۴) runStatusFa — هر سه وضعیت:")
{
  check("done → Done", runStatusFa("done") === "Done")
  check("error → Failed", runStatusFa("error") === "Failed")
  check("running → Running", runStatusFa("running") === "Running")
}

console.log("۵) unseenRunCount — بج Inbox:")
{
  const runs = [
    { id: "a", schedule_id: "s", status: "done", started_at: 1 },
    { id: "b", schedule_id: "s", status: "done", started_at: 2 },
  ] as any
  check("هیچ دیده‌ای → ۲", unseenRunCount(runs, []) === 2)
  check("یکی دیده → ۱", unseenRunCount(runs, ["a"]) === 1)
  check("همه دیده → ۰", unseenRunCount(runs, ["a", "b"]) === 0)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log("\nهمه بررسی‌ها موفق بود")
}
