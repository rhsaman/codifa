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

const { formatNextRunFa, runStatusFa, cronToPresetValue } = await import(
  "../src/components/SchedulePanel"
)
const { unseenRunCount, unseenRunCountForTask, pickInboxTask } = await import("../src/components/ScheduleInbox")
const { scheduleRunTokenTotal, taskTokenTotals, findNewScheduleRuns } = await import(
  "../src/lib/schedule-notify"
)

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

console.log("۶) unseenRunCountForTask — بج هر تسک:")
{
  const runs = [
    { id: "a", schedule_id: "s1", status: "done", started_at: 1 },
    { id: "b", schedule_id: "s2", status: "done", started_at: 2 },
    { id: "c", schedule_id: "s1", status: "done", started_at: 3 },
  ] as any
  check("تسک s1 دو دیده‌نشده دارد", unseenRunCountForTask(runs, [], "s1") === 2)
  check("تسک s2 یک دیده‌نشده دارد", unseenRunCountForTask(runs, [], "s2") === 1)
  check("تسک ناموجود صفر است", unseenRunCountForTask(runs, [], "s9") === 0)
  check("دیده‌شده کم می‌شود", unseenRunCountForTask(runs, ["a"], "s1") === 1)
}

console.log("۷) pickInboxTask — بج با پنل خالی همراه نشود:")
{
  const tasks = [
    { id: "s1", name: "اول", prompt: "p", cron: "", enabled: true, root: "", mode: "coder" },
    { id: "s2", name: "دوم", prompt: "p", cron: "", enabled: true, root: "", mode: "coder" },
  ] as any
  const runs = [
    { id: "b", schedule_id: "s2", status: "done", started_at: 2 },
    { id: "a", schedule_id: "s1", status: "done", started_at: 1 },
  ] as any
  check("بدون انتخاب → تسک تازه‌ترین ران (s2)", pickInboxTask(tasks, runs, null)?.id === "s2")
  check("انتخاب معتبر حفظ می‌شود", pickInboxTask(tasks, runs, "s1")?.id === "s1")
  check("انتخاب حذف‌شده → تازه‌ترین ران (s2)", pickInboxTask(tasks, runs, "gone")?.id === "s2")
  check("بدون ران → اولین تسک", pickInboxTask(tasks, [], null)?.id === "s1")
  check("بدون تسک → null", pickInboxTask([], runs, null) === null)
}

console.log("۸) cronToPresetValue — نگاشت کرون ذخیره‌شده به Repeat فرم:")
{
  check("کرون نرمال daily", cronToPresetValue("0 9 * * *") === "0 9 * * *")
  check("کرون نرمال every-15", cronToPresetValue("*/15 * * * *") === "*/15 * * * *")
  check("کرون نرمال hourly", cronToPresetValue("0 * * * *") === "0 * * * *")
  check("کرون نرمال weekly", cronToPresetValue("0 9 * * 1") === "0 9 * * 1")
  check("خالی → Once", cronToPresetValue("") === "")
  check("once → Once", cronToPresetValue("once") === "")
  check("نام قدیمی daily", cronToPresetValue("daily") === "0 9 * * *")
  check("نام قدیمی every 15 minutes", cronToPresetValue("every 15 minutes") === "*/15 * * * *")
  check("کرون سفارشی دست‌نخورده", cronToPresetValue("30 14 * * *") === "30 14 * * *")
}

console.log("۹) taskTokenTotals — مجموع توکن هر تسک روی خود تسک:")
{
  const runs = [
    { id: "a", schedule_id: "s1", status: "done", started_at: 1, usage: { entries: [{ providerId: "p", model: "m", input: 100, output: 50 }] } },
    { id: "b", schedule_id: "s1", status: "done", started_at: 2, usage: { entries: [{ providerId: "p", model: "m", input: 10, output: 5 }] } },
    { id: "c", schedule_id: "s2", status: "done", started_at: 3 },
  ] as any
  const totals = taskTokenTotals(runs)
  check("تسک s1 مجموع ۱۶۵ توکن", totals["s1"] === 165, totals)
  check("تسک بدون usage صفر است", (totals["s2"] ?? 0) === 0, totals)
  check("scheduleRunTokenTotal ران a برابر ۱۵۰", scheduleRunTokenTotal(runs[0]) === 150)
}

console.log("۱۰) findNewScheduleRuns — فقط ران واقعاً جدید اعلان می‌دهد:")
{
  const runs = [
    { id: "a", schedule_id: "s", status: "done", started_at: 1 },
    { id: "b", schedule_id: "s", status: "done", started_at: 2 },
  ] as any
  check("اولین پولینگ baseline است (بدون اعلان)", findNewScheduleRuns(new Set(), runs, []).length === 2)
  check("ران تکراری اعلان نمی‌دهد", findNewScheduleRuns(new Set(["a", "b"]), runs, []).length === 0)
  check("ران دیده‌شده اعلان نمی‌دهد", findNewScheduleRuns(new Set(["a"]), runs, ["b"]).length === 0)
  const withNew = [...runs, { id: "c", schedule_id: "s", status: "done", started_at: 3 }] as any
  const fresh = findNewScheduleRuns(new Set(["a", "b"]), withNew, [])
  check("فقط ران c جدید است", fresh.length === 1 && fresh[0].id === "c", fresh)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log("\nهمه بررسی‌ها موفق بود")
}
