// تست واحد برای dedupe در applyToolEvent:
// یک tool event که دوبار (از stream list-parts و از tool callback) می‌آید
// نباید دو کارت tool ایجاد کند. کارت موجود باید update شود.
// اجرا: npx esbuild src/lib/toolActivity.dedupe.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-toolActivity-dedupe.mjs \
//        && node src/lib/.tmp-toolActivity-dedupe.mjs

import type { SidecarEvent, ToolActivity } from "../types"
import { applyToolEvent, resolveToolResult } from "./toolActivity"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) tool event اول: کارت ساخته می‌شود:')
{
  const ev: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "def auth" },
    id: "toolu_42",
  } as any
  const out = applyToolEvent([], ev)
  check('یک کارت ساخته شد', out.length === 1, out.length)
  check('tool درست است', out[0].tool === "grep")
  check('callId از id استخراج شد', out[0].callId === "toolu_42", out[0].callId)
  check('status running است', out[0].status === "running")
}

console.log('۲) tool event دوم با همان id: dedupe می‌شود (کارت جدید نمی‌سازد):')
{
  const ev1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "def auth" },
    id: "toolu_42",
  } as any
  const ev2: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "def auth" },
    id: "toolu_42",
  } as any
  const out1 = applyToolEvent([], ev1)
  const out2 = applyToolEvent(out1, ev2)
  check('هنوز فقط یک کارت داریم', out2.length === 1, out2.length)
}

console.log('۳) tool event با call_id عددی (fallback) نیز dedupe می‌شود:')
{
  const ev1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x" },
    call_id: 7,
  } as any
  const ev2: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x" },
    call_id: 7,
  } as any
  const out1 = applyToolEvent([], ev1)
  const out2 = applyToolEvent(out1, ev2)
  check('call_id عددی هم dedupe می‌شود', out2.length === 1, out2.length)
  check('callId عددی ذخیره شد', out2[0].callId === 7, out2[0].callId)
}

console.log('۴) tool event های متفاوت: کارت‌های مجزا ساخته می‌شوند:')
{
  const ev1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x" },
    id: "toolu_1",
  } as any
  const ev2: SidecarEvent = {
    kind: "tool",
    tool: "read",
    args: { path: "a.py" },
    id: "toolu_2",
  } as any
  const out1 = applyToolEvent([], ev1)
  const out2 = applyToolEvent(out1, ev2)
  check('دو کارت مجزا داریم', out2.length === 2, out2.length)
  check('اولی grep است', out2[0].tool === "grep")
  check('دومی read است', out2[1].tool === "read")
}

console.log('۵) re-emit با args غنی‌تر: کارت موجود update می‌شود:')
{
  const ev1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x" },
    id: "toolu_1",
  } as any
  const ev2: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x", path: "a.py" }, // args غنی‌تر
    id: "toolu_1",
  } as any
  const out1 = applyToolEvent([], ev1)
  const out2 = applyToolEvent(out1, ev2)
  check('هنوز یک کارت', out2.length === 1, out2.length)
  check('args update شد', JSON.stringify(out2[0].args) === JSON.stringify({ pattern: "x", path: "a.py" }), out2[0].args)
}

console.log('۶) tool_result با id یکسان: کارت به done تغییر می‌کند:')
{
  const ev1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x" },
    id: "toolu_99",
  } as any
  const ev2: SidecarEvent = {
    kind: "tool_result",
    tool: "grep",
    summary: "3 hits",
    id: "toolu_99",
  } as any
  const out1 = applyToolEvent([], ev1)
  const out2 = resolveToolResult(out1, ev2)
  check('کارت به done تغییر کرد', out2[0].status === "done", out2[0].status)
  check('summary ذخیره شد', out2[0].summary === "3 hits")
}

console.log('۷) tool_result بدون match: کارت بدون تغییر باقی می‌ماند:')
{
  const ev1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "x" },
    id: "toolu_1",
  } as any
  const ev2: SidecarEvent = {
    kind: "tool_result",
    tool: "grep",
    summary: "done",
    id: "toolu_DIFFERENT",
  } as any
  const out1 = applyToolEvent([], ev1)
  const out2 = resolveToolResult(out1, ev2)
  check('کارت همچنان running است', out2[0].status === "running", out2[0].status)
}

console.log('۸) sub-event (branch) nesting: tool sub داخل task card قرار می‌گیرد:')
{
  // backend همیشه branch روی task card می‌ذاره (tools.py:3783-3786)
  const taskEvent: SidecarEvent = {
    kind: "tool",
    tool: "task",
    args: { prompt: "find files" },
    id: "task_1",
    branch: 0,
  } as any
  const subEvent: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "y" },
    id: "sub_1",
    sub: true,
    branch: 0,
  } as any
  const out1 = applyToolEvent([], taskEvent)
  const out2 = applyToolEvent(out1, subEvent)
  check('task card در سطح بالا است', out2.length === 1)
  check('sub در children است', (out2[0].children?.length ?? 0) === 1, out2[0].children)
  check('sub.tool درست است', out2[0].children?.[0].tool === "grep")
}

console.log('۹) sub-event duplicate: فقط یک child:')
{
  // backend همیشه branch روی task card می‌ذاره (tools.py:3783-3786)
  const taskEvent: SidecarEvent = {
    kind: "tool",
    tool: "task",
    args: { prompt: "x" },
    id: "task_1",
    branch: 0,
  } as any
  const subEvent1: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "y" },
    id: "sub_1",
    sub: true,
    branch: 0,
  } as any
  const subEvent2: SidecarEvent = {
    kind: "tool",
    tool: "grep",
    args: { pattern: "y" },
    id: "sub_1",
    sub: true,
    branch: 0,
  } as any
  const out1 = applyToolEvent([], taskEvent)
  const out2 = applyToolEvent(out1, subEvent1)
  const out3 = applyToolEvent(out2, subEvent2)
  check('یک child باقی مانده', (out3[0].children?.length ?? 0) === 1, out3[0].children)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
