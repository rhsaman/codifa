// تست حلقهٔ تب‌ها برای کورد VS Code: Cmd+Shift+[ / ] در مک و
// Ctrl+Shift+[ / ] در ویندوز/لینوکس (تشخیص کورد در tests/shortcuts.test.ts و
// قدم زدن در App.tsx `cycleFocusedTabs`).
// اجرا: npx esbuild tests/tabCycle.test.ts --bundle --platform=node \
//        --format=esm --outfile=tests/.tmp-tabCycle.mjs && node tests/.tmp-tabCycle.mjs

import { cycleId } from "../src/lib/tabCycle"

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

const ids = ['a', 'b', 'c', 'd']

console.log('۱) cycleId — قدم بین تب‌های پیکر:')
{
  check('next از وسط → تب بعدی', cycleId(ids, 'b', 1) === 'c')
  check('prev از وسط → تب قبلی', cycleId(ids, 'c', -1) === 'b')
}

console.log('۲) cycleId — wrap مثل VS Code:')
{
  check('last + نگاه به بعد → first', cycleId(ids, 'd', 1) === 'a')
  check('first + نگاه به قبل → last', cycleId(ids, 'a', -1) === 'd')
}

console.log('۳) cycleId — لبه‌ها (کورد نباید بی‌اثر شود):')
{
  check('یک تب → همان تب', cycleId(['a'], 'a', 1) === 'a')
  check('یک تب با prev → همان تب', cycleId(['a'], 'a', -1) === 'a')
  check('لیست خالی → null', cycleId([], 'a', 1) === null)
}

console.log('۴) cycleId — activeId ناشناخته (تبی که همین حالا بسته شده):')
{
  check('next → اولین تب', cycleId(ids, null, 1) === 'a')
  check('next با id ناشناخته → اولین تب', cycleId(ids, 'gone', 1) === 'a')
  check('prev → آخرین تب', cycleId(ids, null, -1) === 'd')
  check('prev با id ناشناخته → آخرین تب', cycleId(ids, 'gone', -1) === 'd')
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\nهمه تست‌های چرخهٔ تب پاس شدند ✅')
