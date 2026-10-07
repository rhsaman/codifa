// تست واحد برای resetStreamForRetry:
// حالت resume: tool segments حفظ می‌شوند، text segments حذف می‌شوند.
// حالت restart: همه چیز حذف می‌شود.
// اجرا: npx esbuild src/lib/retry.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-retry.mjs && node src/lib/.tmp-retry.mjs

import type { MessageSegment } from "../types"
import { AutoRetryScheduler, resetStreamForRetry, resolveRestartUser, shouldIgnoreLateRetryEvent } from "./retry"

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

console.log('۳) حالت restart: text و tool پاک می‌شوند، user/compact می‌مانند:')
{
  const segments: MessageSegment[] = [
    { kind: "text", text: "hello" },
    { kind: "tool", index: 0 },
    { kind: "user", id: "u1" },
    { kind: "compact", id: "c1" },
  ]
  const out = resetStreamForRetry("hello", segments, "restart")
  check('content خالی است', out.content === "")
  check('text حذف شد', !out.segments.some((s) => s.kind === "text"))
  check('tool حذف شد', !out.segments.some((s) => s.kind === "tool"))
  check('user حفظ شد', out.segments.some((s) => s.kind === "user"))
  check('compact حفظ شد', out.segments.some((s) => s.kind === "compact"))
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

console.log('۷) resolveRestartUser روی پیام دستیار، پیام کاربر بالایی را برمی‌گرداند:')
{
  const msgs = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: 'hi' },
  ] as any
  const out = resolveRestartUser(msgs, 'a1')
  check('مالک u1 است', out?.id === 'u1', out?.id)
}

console.log('۸) resolveRestartUser روی پیام کاربر، خودش را برمی‌گرداند:')
{
  const msgs = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: 'hi' },
  ] as any
  const out = resolveRestartUser(msgs, 'u1')
  check('خودش است', out?.id === 'u1', out?.id)
}

console.log('۹) resolveRestartUser با شناسه نامعتبر null است:')
{
  const msgs = [{ id: 'u1', role: 'user', content: 'hello' }] as any
  check('null برمی‌گردد', resolveRestartUser(msgs, 'nope') === null)
}

console.log('۱۰) resolveRestartUser با محتوای خالی null است:')
{
  const msgs = [{ id: 'u1', role: 'user', content: '   ' }] as any
  check('null برمی‌گردد', resolveRestartUser(msgs, 'u1') === null)
}

console.log('11) AutoRetryScheduler: stop prevents a scheduled retry from firing:');
{
  // Fake timers: deterministic, no real sleeps.
  const pending = new Map<number, () => void>()
  let nextId = 1
  const fakeSet = (cb: () => void, _ms: number): number => {
    const id = nextId++
    pending.set(id, cb)
    return id
  }
  const fakeClear = (id: unknown): void => {
    pending.delete(id as number)
  }
  const runAll = () => {
    const cbs = [...pending.values()]
    pending.clear()
    for (const cb of cbs) cb()
  }
  const sched = new AutoRetryScheduler(fakeSet, fakeClear)
  let fired = 0
  sched.schedule(5000, () => { fired++ })
  sched.stop()
  runAll()
  check('scheduled retry did not fire after stop', fired === 0)
  check('stale error after stop must be ignored', shouldIgnoreLateRetryEvent(sched.isStopped) === true)
}

console.log('12) AutoRetryScheduler: normal retry still fires without stop, and re-arms on the next turn:');
{
  const pending = new Map<number, () => void>()
  let nextId = 1
  const fakeSet = (cb: () => void, _ms: number): number => {
    const id = nextId++
    pending.set(id, cb)
    return id
  }
  const fakeClear = (id: unknown): void => {
    pending.delete(id as number)
  }
  const runAll = () => {
    const cbs = [...pending.values()]
    pending.clear()
    for (const cb of cbs) cb()
  }
  const sched = new AutoRetryScheduler(fakeSet, fakeClear)
  let fired = 0
  sched.schedule(5000, () => { fired++ })
  runAll()
  check('scheduled retry fired without stop', fired === 1)
  check('error without stop is not ignored', shouldIgnoreLateRetryEvent(sched.isStopped) === false)
  // A fresh turn re-arms the scheduler after a stop.
  sched.stop()
  sched.beginTurn()
  let fired2 = 0
  sched.schedule(0, () => { fired2++ })
  runAll()
  check('retry works again on the next turn', fired2 === 1)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
