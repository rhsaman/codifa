// Unit tests for list paging (src/lib/paging.ts).
//
// Why it matters: a marketplace index holds hundreds of entries (the Claude one
// ships 315), and the browser renders a page at a time. The page number comes
// from React state while the LIST comes from a search box, so the requested page
// can point past the end of a freshly filtered list — the clamp is the whole
// point of this function.

import { paginate, PAGE_SIZE } from '../src/lib/paging.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const items = (n: number) => Array.from({ length: n }, (_, i) => i)

console.log('1) paginate slices the requested page:')
{
  const p = paginate(items(315), 0, 10)
  check('the first page holds ten rows', p.rows.length === 10 && p.rows[0] === 0 && p.rows[9] === 9, p)
  check('the page count rounds UP for a partial last page', p.pages === 32, p.pages)
  check('the range is 1-based for the label', p.from === 0 && p.total === 315)
}

console.log('2) a page past the end clamps onto the last real one:')
{
  // A filter shrinks 315 rows to 2 while the page number still says 30 — the
  // unclamped slice would render an empty list and no way back.
  const p = paginate(items(2), 30, 10)
  check('the page is clamped, not empty', p.rows.length === 2 && p.page === 0, p)
  check('a negative page cannot slip through', paginate(items(20), -5, 10).page === 0)
}

console.log('3) an empty list still reports one page:')
{
  const p = paginate([], 0, 10)
  check('pages is never zero', p.pages === 1 && p.rows.length === 0, p)
  check('a zero page of an empty list stays 0', paginate([], 4, 10).page === 0)
}

console.log('4) the default page size is the one the tab uses:')
{
  check('PAGE_SIZE is a sane, positive number', Number.isInteger(PAGE_SIZE) && PAGE_SIZE > 0, PAGE_SIZE)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll tests passed. ✅')
}
