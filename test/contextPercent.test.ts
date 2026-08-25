import './_globals.ts'
import { contextPercent, scaleReserved } from '../src/lib/context.ts'

function check(name: string, cond: any, extra?: any) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) reserved=0 → percentage relative to the whole window (opencode usable == window):')
{
  // With no headroom, usable == window, so the meter fills toward the raw window.
  check('used=0 → 0%', contextPercent(0, 200000, 0) === 0)
  check('used=100000, window=200000 → 50%', contextPercent(100000, 200000, 0) === 50)
  check('used=200000 → 100%', contextPercent(200000, 200000, 0) === 100)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) reserved>0 → percentage relative to RAW window (opencode: meter is raw, headroom NOT subtracted):')
{
  // opencode's TUI shows tokens.total / limit.context — the RAW window, NOT
  // usable. The reserved headroom only affects where auto-compaction fires,
  // not the meter's denominator. So contextPercent ignores `reserved`.
  const reserved = 20000
  const window = 200000
  check('scaleReserved(200k, 20k) = 20000', scaleReserved(window, reserved) === 20000, scaleReserved(window, reserved))
  // raw: 180000 / 200000 = 90% (NOT 100% of usable)
  check('used=180000 → 90% (raw window, not usable)', contextPercent(180000, window, reserved) === 90, contextPercent(180000, window, reserved))
  check('used=90000 → 45% (raw)', contextPercent(90000, window, reserved) === 45, contextPercent(90000, window, reserved))
  check('used=100000 → 50% (raw)', contextPercent(100000, window, reserved) === 50, contextPercent(100000, window, reserved))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) small window → reserved clamped down (opencode clamps buffer to maxOutputTokens):')
{
  // cap = max(2000, 10% of 20000) = 2000, so a 20k headroom is clamped to 2k.
  const window = 20000
  const reserved = 20000
  check('scaleReserved(20k, 20k) = 2000', scaleReserved(window, reserved) === 2000, scaleReserved(window, reserved))
  // raw: 18000 / 20000 = 90% (NOT 100% of usable)
  check('used=18000 → 90% (raw window)', contextPercent(18000, window, reserved) === 90, contextPercent(18000, window, reserved))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) edge cases:')
{
  // No window → null (meter shows a dash).
  check('window=0 → null', contextPercent(100, 0, 0) === null)
  check('window=null → null', contextPercent(100, null, 0) === null)
  // Raw window: 200000 / 200000 = 100% (no cap, but raw so exactly 100%).
  check('used == window → 100% (raw)', contextPercent(200000, 200000, 20000) === 100, contextPercent(200000, 200000, 20000))
  // reserved >= window: raw window is used (reserved ignored), so 50000/100000 = 50%.
  check('reserved >= window → relative to raw window', contextPercent(50000, 100000, 100000) === 50, contextPercent(50000, 100000, 100000))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
