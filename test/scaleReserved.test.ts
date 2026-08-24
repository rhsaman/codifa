// Test for scaleReserved() in src/lib/context.ts: the compaction headroom must
// be clamped to ~10% of the context window (min 2000) so auto-compaction never
// fires near the start of a conversation on small windows, while large windows
// keep the full 20k default. Mirrors opencode's reserved-buffer clamping.
// Run: npx esbuild test/scaleReserved.test.ts --bundle --platform=node \
//        --format=esm --packages=external --outfile=test/.tmp-sr.mjs \
//        && node test/.tmp-sr.mjs

import { scaleReserved } from '../src/lib/context.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) پنجرهٔ کوچک ۴۰هزار → headroom 20000 کلمپ میشود به 10% = 4000:')
check('scaleReserved(40000, 20000) === 4000', scaleReserved(40000, 20000) === 4000, scaleReserved(40000, 20000))

console.log('2) پنجرهٔ بزرگ ۱۹۹۰هزار → headroom به ۱۰٪ = ۱۹۰۰۰ کلمپ میشود (بافر متناسب با پنجره):')
check('scaleReserved(190000, 20000) === 19000', scaleReserved(190000, 20000) === 19000, scaleReserved(190000, 20000))

console.log('3) پنجرهٔ ناشناخته (۰) → headroom دستنخورده عبور میکند:')
check('scaleReserved(0, 20000) === 20000', scaleReserved(0, 20000) === 20000, scaleReserved(0, 20000))

console.log('4) کف ۲۰۰۰: پنجرهٔ خیلی کوچک ۸هزار → 10% = 800 کلمپ به 2000:')
check('scaleReserved(8000, 20000) === 2000', scaleReserved(8000, 20000) === 2000, scaleReserved(8000, 20000))

console.log('5) headroom کوچکتر از ۱۰٪ پنجره → باز هم ۱۰٪ پنجره برمیگردد (۱۰هزار روی ۴۰هزار → ۴۰۰۰):')
check('scaleReserved(40000, 10000) === 4000', scaleReserved(40000, 10000) === 4000, scaleReserved(40000, 10000))

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای scaleReserved پاس شدند')
