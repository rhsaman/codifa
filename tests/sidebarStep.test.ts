// Unit tests for bare j/k walking the sidebar chat list (src/lib/sidebarStep.ts).
import { stepChatId } from '../src/lib/sidebarStep'

export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const ids = ['a', 'b', 'c']

console.log('1) stepChatId — walks the list in both directions:')
{
  check('j from a → b', stepChatId(ids, 'a', 1) === 'b')
  check('j from b → c', stepChatId(ids, 'b', 1) === 'c')
  check('k from c → b', stepChatId(ids, 'c', -1) === 'b')
  check('k from b → a', stepChatId(ids, 'b', -1) === 'a')
}

console.log('2) stepChatId — the ends do not wrap:')
{
  check('j at the last stays (null)', stepChatId(ids, 'c', 1) === null)
  check('k at the first stays (null)', stepChatId(ids, 'a', -1) === null)
}

console.log('3) stepChatId — no current selection enters from the right end:')
{
  check('j with no selection starts at the top', stepChatId(ids, null, 1) === 'a')
  check('k with no selection starts at the bottom', stepChatId(ids, null, -1) === 'c')
  check('unknown id behaves like no selection', stepChatId(ids, 'zzz', 1) === 'a')
}

console.log('4) stepChatId — degenerate inputs are safe:')
{
  check('empty list → null (down)', stepChatId([], 'a', 1) === null)
  check('empty list → null (up)', stepChatId([], null, -1) === null)
  check('delta 0 → null', stepChatId(ids, 'a', 0) === null)
  check('single item → null', stepChatId(['only'], 'only', 1) === null)
}

if (failures > 0) {
  console.error(`\n${failures} sidebarStep check(s) failed`)
  process.exit(1)
}
console.log('\nsidebarStep: all checks passed')
