// تست unit برای resolveStuckActivities:
// تابع resolveStuckActivities باید همه کارت‌های "running" (از جمله فرزندان
// nested در task cards) رو به "done" تبدیل کنه، بدون تغییر کارت‌های
// done/error/denied.
// اجرا: npx esbuild src/lib/toolActivity.stuckCards.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-stuckCards.mjs \
//        && node src/lib/.tmp-stuckCards.mjs

import type { ToolActivity } from "../types"
import { resolveStuckActivities } from "./toolActivity"

export {}

const NOW = 1_700_000_000_000 // ثابت برای reproducibility

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

// ─── ۱) کارت top-level running → done ───
console.log("۱) کارت top-level running → done تبدیل می‌شود:")
{
  const acts: ToolActivity[] = [
    { tool: "grep", status: "running", startedAt: NOW - 5000 } as any,
  ]
  const out = resolveStuckActivities(acts, NOW)
  check("status done شد", out[0].status === "done")
  check("elapsedMs محاسبه شد", out[0].elapsedMs === 5000, out[0].elapsedMs)
}

// ─── ۲) کارت task با children running → هم والد هم فرزندان done ───
console.log("۲) کارت task با children running → هم والد و هم فرزندان done می‌شوند:")
{
  const acts: ToolActivity[] = [
    {
      tool: "task",
      status: "running",
      startedAt: NOW - 10000,
      branch: 0,
      children: [
        { tool: "grep", status: "running", startedAt: NOW - 8000 } as any,
        { tool: "read", status: "running", startedAt: NOW - 6000 } as any,
      ],
    } as any,
  ]
  const out = resolveStuckActivities(acts, NOW)
  check("والد done شد", out[0].status === "done", out[0].status)
  check("والد elapsedMs", out[0].elapsedMs === 10000, out[0].elapsedMs)
  check("فرزند اول done", out[0].children![0].status === "done")
  check("فرزند اول elapsedMs", out[0].children![0].elapsedMs === 8000)
  check("فرزند دوم done", out[0].children![1].status === "done")
  check("فرزند دوم elapsedMs", out[0].children![1].elapsedMs === 6000)
}

// ─── ۳) کارت task با children mixed (بعضی done، بعضی running) ───
console.log("۳) کارت task با children mixed → فقط runningها done می‌شوند:")
{
  const acts: ToolActivity[] = [
    {
      tool: "task",
      status: "running",
      startedAt: NOW - 10000,
      branch: 0,
      children: [
        { tool: "grep", status: "done", startedAt: NOW - 9000, elapsedMs: 1000 } as any,
        { tool: "read", status: "running", startedAt: NOW - 5000 } as any,
      ],
    } as any,
  ]
  const out = resolveStuckActivities(acts, NOW)
  check("والد done شد", out[0].status === "done")
  check("فرزند done دست‌نخورده", out[0].children![0].status === "done")
  check("فرزند done elapsedMs اصلی حفظ شد", out[0].children![0].elapsedMs === 1000)
  check("فرزند running done شد", out[0].children![1].status === "done")
  check("فرزند running elapsedMs", out[0].children![1].elapsedMs === 5000)
}

// ─── ۴) کارت‌های done/error تغییر نمی‌کنند ───
console.log("۴) کارت‌های done/error/denied تغییر نمی‌کنند:")
{
  const acts: ToolActivity[] = [
    { tool: "grep", status: "done", startedAt: NOW - 3000, elapsedMs: 3000 } as any,
    { tool: "read", status: "error", startedAt: NOW - 2000 } as any,
    { tool: "glob", status: "denied", startedAt: NOW - 1000 } as any,
  ]
  const out = resolveStuckActivities(acts, NOW)
  check("done حفظ شد", out[0].status === "done")
  check("done elapsedMs حفظ شد", out[0].elapsedMs === 3000)
  check("error حفظ شد", out[1].status === "error")
  check("denied حفظ شد", out[2].status === "denied")
}

// ─── ۵) آرایه خالی ───
console.log("۵) آرایه خالی → آرایه خالی برمی‌گرداند:")
{
  const out = resolveStuckActivities([], NOW)
  check("طول صفر", out.length === 0)
}

// ─── ۶) فرزند nested عمیق (task → task → grep) ───
console.log("۶) فرزند nested عمیق → همه سطوح done می‌شوند:")
{
  const acts: ToolActivity[] = [
    {
      tool: "task",
      status: "running",
      startedAt: NOW - 20000,
      branch: 0,
      children: [
        {
          tool: "task",
          status: "running",
          startedAt: NOW - 15000,
          branch: 1,
          children: [
            { tool: "grep", status: "running", startedAt: NOW - 10000 } as any,
          ],
        } as any,
      ],
    } as any,
  ]
  const out = resolveStuckActivities(acts, NOW)
  const root = out[0]
  const mid = root.children![0]
  const leaf = mid.children![0]
  check("ریشه done", root.status === "done")
  check("میانی done", mid.status === "done")
  check("برگ done", leaf.status === "done")
  check("برگ elapsedMs", leaf.elapsedMs === 10000)
}

// ─── ۷) والد done ولی فرزند orphan (race condition edge case) ───
console.log("۷) والد done ولی فرزند orphan → فقط فرزند done می‌شود:")
{
  const acts: ToolActivity[] = [
    {
      tool: "task",
      status: "done",
      startedAt: NOW - 10000,
      elapsedMs: 10000,
      branch: 0,
      children: [
        { tool: "grep", status: "done", startedAt: NOW - 9000, elapsedMs: 1000 } as any,
        { tool: "read", status: "running", startedAt: NOW - 5000 } as any,
      ],
    } as any,
  ]
  const out = resolveStuckActivities(acts, NOW)
  check("والد done دست‌نخورده", out[0].status === "done")
  check("والد elapsedMs اصلی حفظ شد", out[0].elapsedMs === 10000)
  check("فرزند done دست‌نخورده", out[0].children![0].status === "done")
  check("فرزند done elapsedMs اصلی حفظ شد", out[0].children![0].elapsedMs === 1000)
  check("فرزند orphan running → done شد", out[0].children![1].status === "done")
  check("فرزند orphan elapsedMs", out[0].children![1].elapsedMs === 5000)
}

// ─── نتیجه ───
console.log()
if (failed > 0) {
  console.error(`❌ ${failed} تست ناموفق`)
  process.exit(1)
} else {
  console.log("✅ همه تست‌ها موفق")
}
