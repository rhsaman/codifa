// تست واحد برای resetStreamForRetry:
// حالت resume: tool segments حفظ می‌شوند، text segments حذف می‌شوند.
// حالت restart: همه چیز حذف می‌شود.
// اجرا: npx esbuild src/lib/retry.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-retry.mjs && node src/lib/.tmp-retry.mjs

import type { MessageSegment } from "../types"
import { resetStreamForRetry } from "./retry"

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

console.log('۱) حالت resume (پیش‌فرض): text segments حذف می‌شوند:')
{
  const segments: MessageSegment[] = [
    { kind: "text", content: "hello" } as any,
    { kind: "tool", tool: "read", args: {} } as any,
    { kind: "text", content: "world" } as any,
  ]
  const out = resetStreamForRetry("hello world", segments)
  check('content خالی است', out.content === "")
  check('text segments حذف شدند', !out.segments.some((s) => s.kind === "text"))
  check('tool segment حفظ شد', out.segments.some((s) => s.kind === "tool"))
}

console.log('۲) حالت resume: tool segments حفظ می‌شوند:')
{
  const segments: MessageSegment[] = [
    { kind: "text", text: "before" },
    { kind: "tool", index: 0 },
  ]
  const out = resetStreamForRetry("before", segments)
  check('text حذف شد', !out.segments.some((s) => s.kind === "text"))
  check('tool حفظ شد', out.segments.some((s) => s.kind === "tool"))
}

console.log('۳) حالت restart: همه چیز پاک می‌شود:')
{
  const segments: MessageSegment[] = [
    { kind: "text", text: "hello" },
    { kind: "tool", index: 0 },
  ]
  const out = resetStreamForRetry("hello", segments, "restart")
  check('content خالی است', out.content === "")
  check('همه segments پاک شدند', out.segments.length === 0, out.segments)
}

console.log('۴) حالت resume با segments تعریف‌نشده:')
{
  const out = resetStreamForRetry("hello")
  check('content خالی است', out.content === "")
  check('segments آرایه خالی است', out.segments.length === 0)
}

console.log('۵) حالت resume با content خالی و segments خالی:')
{
  const out = resetStreamForRetry("", [])
  check('content خالی', out.content === "")
  check('segments خالی', out.segments.length === 0)
}

console.log('۶) حالت resume: user segments نیز حفظ می‌شوند:')
{
  const segments: MessageSegment[] = [
    { kind: "text", text: "hello" },
    { kind: "user", id: "u1" },
  ]
  const out = resetStreamForRetry("hello", segments)
  check('text حذف شد', !out.segments.some((s) => s.kind === "text"))
  check('user segment حفظ شد', out.segments.some((s) => s.kind === "user"))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
