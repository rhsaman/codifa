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
console.log('۲) reserved>0 → percentage relative to usable = window - scaleReserved(window, reserved):')
{
  // opencode's isOverflow compares against usable(), so the meter must fill
  // toward usable, not the raw window. Default headroom 20k on a 200k window
  // scales to 20k (cap = max(2000, 10% of 200k) = 20k), so usable = 180k.
  const reserved = 20000
  const window = 200000
  const usable = window - scaleReserved(window, reserved) // 180000
  check('scaleReserved(200k, 20k) = 20000', scaleReserved(window, reserved) === 20000, scaleReserved(window, reserved))
  check('used=180000 → 100% (reaches usable)', contextPercent(180000, window, reserved) === 100, contextPercent(180000, window, reserved))
  check('used=90000 → 50% of usable', contextPercent(90000, window, reserved) === 50, contextPercent(90000, window, reserved))
  check('used=100000 → ~56% of usable', contextPercent(100000, window, reserved) === Math.round((100000 / usable) * 100), contextPercent(100000, window, reserved))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) small window → reserved clamped down (opencode clamps buffer to maxOutputTokens):')
{
  // cap = max(2000, 10% of 20000) = 2000, so a 20k headroom is clamped to 2k.
  const window = 20000
  const reserved = 20000
  check('scaleReserved(20k, 20k) = 2000', scaleReserved(window, reserved) === 2000, scaleReserved(window, reserved))
  // usable = 18000 → used=18000 is 100%.
  check('used=18000 → 100% (usable)', contextPercent(18000, window, reserved) === 100, contextPercent(18000, window, reserved))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) edge cases:')
{
  // No window → null (meter shows a dash).
  check('window=0 → null', contextPercent(100, 0, 0) === null)
  check('window=null → null', contextPercent(100, null, 0) === null)
  // No 100% cap: opencode's overflow check is a raw `count >= usable`, which can
  // exceed the window, so an overflow stays visible (>100%).
  check('used > usable → >100 (no cap)', contextPercent(200000, 200000, 20000) > 100, contextPercent(200000, 200000, 20000))
  // reserved >= window: scaleReserved clamps to cap = max(2000, 10% of window),
  // so usable stays positive and the % is relative to that usable (not raw window).
  // window=100000 → cap=10000 → usable=90000 → used=50000 ≈ 56%.
  check('reserved >= window → relative to clamped usable', contextPercent(50000, 100000, 100000) === Math.round((50000 / 90000) * 100), contextPercent(50000, 100000, 100000))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
