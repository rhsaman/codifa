// Transcript window: count page + char budget for fast chat switching.
// A count-only page still mounts megabytes on giant chats (SSR-measured:
// ~100ms per 30KB message, ~300ms per 300KB), so the initial window is also
// capped by text. "Load older" raises both caps, never stalls.
import { sliceWindow } from '../src/lib/messageWindow.ts'
import { windowBudget, MSG_WINDOW_FIRST, MSG_WINDOW_PER_PAGE } from '../src/lib/messageWindow.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const msg = (id: string, len: number) => ({ id, content: 'x'.repeat(len) })

{
  console.log('── sliceWindow: small chats behave exactly like the count page ──')
  const items = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 100))
  const out = sliceWindow(items, 30, 150_000, 5, (m) => m.content.length)
  check('all 10 render when under both caps', out.length === 10)
}

{
  console.log('── sliceWindow: giant tail is cut by budget, newest always kept ──')
  const items = [...Array.from({ length: 10 }, (_, i) => msg(`small${i}`, 100)), msg('giant', 500_000)]
  const out = sliceWindow(items, 30, 150_000, 5, (m) => m.content.length)
  check('newest (giant) message kept', out[out.length - 1].id === 'giant')
  check('window holds minKeep newest', out.length === 5)
}

{
  console.log('── sliceWindow: count limit still applies on normal chats ──')
  const items = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 100))
  const out = sliceWindow(items, 30, 150_000, 5, (m) => m.content.length)
  check('30 newest by count', out.length === 30 && out[0].id === 'm20')
}

{
  console.log('── sliceWindow: raising both caps reveals more (button never stalls) ──')
  const items = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 10_000))
  const first = sliceWindow(items, 30, 150_000, 5, (m) => m.content.length)
  const more = sliceWindow(items, 60, 300_000, 5, (m) => m.content.length)
  check('second page renders strictly more', more.length > first.length, [first.length, more.length])
  check('empty input renders empty', sliceWindow([], 30, 150_000, 5, () => 0).length === 0)
}

if (failed) {
  console.error(`FAILED (${failed})`)
  process.exit(1)
} else {
  console.log('messageWindow: all checks passed')
}

{
  console.log('── windowBudget: first page small, expansions generous ──')
  check('first page is 150K', windowBudget(30, 30) === MSG_WINDOW_FIRST)
  check('second page adds 250K', windowBudget(60, 30) === MSG_WINDOW_FIRST + MSG_WINDOW_PER_PAGE)
  check('starts at one page even for tiny limits', windowBudget(5, 30) === MSG_WINDOW_FIRST)
  check('grows without bound (never stalls load-more)', windowBudget(300, 30) > windowBudget(60, 30))
}
