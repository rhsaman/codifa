// Bounds for pathological message sizes: per-message render cap, paste cap.
import { capText, fmtSize, PASTE_MAX, RENDER_CAP } from '../src/lib/renderCap.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

{
  console.log('── capText: short text passes through untouched ──')
  const out = capText('hello')
  check('same text, zero cut', out.text === 'hello' && out.cut === 0)
}

{
  console.log('── capText: monster text is cut with exact remainder ──')
  const big = 'x'.repeat(RENDER_CAP + 500)
  const out = capText(big)
  check('capped length', out.text.length === RENDER_CAP, out.text.length)
  check('cut counted', out.cut === 500, out.cut)
}

{
  console.log('── fmtSize: human units ──')
  check('chars', fmtSize(500) === '500 chars')
  check('KB', fmtSize(252_000) === '252KB')
  check('MB', fmtSize(1_524_000) === '1.5MB')
  check('paste cap is 100K', PASTE_MAX === 100_000)
}

if (failed) {
  console.error(`FAILED (${failed})`)
  process.exit(1)
} else {
  console.log('renderCap: all checks passed')
}
