// Unit tests for the bare vim scroll keys (src/lib/scrollKeys.ts).
//
// The viewer and the git diff hand these letters to a scroll container instead
// of the caret, so the interesting behaviour is the direction mapping and the
// guard that keeps typing (and other panes) intact.
import { SCROLL_FAST_MULTIPLIER, SCROLL_STEP_PX, canScrollFrom, edgeDelta, halfPageDelta, scrollDelta } from '../src/lib/scrollKeys'

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

console.log('1) scrollDelta — h/j/k/l map to left/down/up/right:')
{
  check('h → left', JSON.stringify(scrollDelta('h')) === JSON.stringify({ dx: -SCROLL_STEP_PX, dy: 0 }))
  check('l → right', JSON.stringify(scrollDelta('l')) === JSON.stringify({ dx: SCROLL_STEP_PX, dy: 0 }))
  check('j → down', JSON.stringify(scrollDelta('j')) === JSON.stringify({ dx: 0, dy: SCROLL_STEP_PX }))
  check('k → up', JSON.stringify(scrollDelta('k')) === JSON.stringify({ dx: 0, dy: -SCROLL_STEP_PX }))
  check('H uppercase → left', JSON.stringify(scrollDelta('H')) === JSON.stringify({ dx: -SCROLL_STEP_PX, dy: 0 }))
}

console.log('2) scrollDelta — non-scroll keys are refused:')
{
  check('x → null', scrollDelta('x') === null)
  check('empty → null', scrollDelta('') === null)
  check('undefined → null', scrollDelta(undefined) === null)
  check('Escape → null', scrollDelta('Escape') === null)
}

console.log('3) scrollDelta — Shift is the fast (coarse) step:')
{
  check('fast dx is multiplied', scrollDelta('l', true)?.dx === SCROLL_STEP_PX * SCROLL_FAST_MULTIPLIER)
  check('fast dy is multiplied', scrollDelta('k', true)?.dy === -SCROLL_STEP_PX * SCROLL_FAST_MULTIPLIER)
  check('fast keeps the axis', scrollDelta('j', true)?.dx === 0)
}

console.log('4) halfPageDelta — Ctrl+D / Ctrl+U move half a viewport:')
{
  check('down is half the height', JSON.stringify(halfPageDelta('down', 800)) === JSON.stringify({ dx: 0, dy: 400 }))
  check('up is negative', JSON.stringify(halfPageDelta('up', 800)) === JSON.stringify({ dx: 0, dy: -400 }))
  check('an odd height rounds', halfPageDelta('down', 733)?.dy === 367)
  check('a tiny viewport still moves a pixel', halfPageDelta('down', 1)?.dy === 1)
  check('no horizontal component', halfPageDelta('down', 800)?.dx === 0)
}

console.log('5) edgeDelta — gg pins the top, G the bottom:')
{
  const view = { scrollTop: 240, scrollHeight: 2000, clientHeight: 600 }
  check('gg scrolls up by the current offset', edgeDelta('top', view)?.dy === -240)
  check('G scrolls to the last page', edgeDelta('bottom', view)?.dy === 1160)
  check(
    'G at the bottom is a no-op (never negative)',
    edgeDelta('bottom', { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 })?.dy === 0,
  )
  check(
    'gg at the top is a no-op',
    edgeDelta('top', { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 })?.dy === 0,
  )
  check('edge jumps have no horizontal component', edgeDelta('bottom', view)?.dx === 0)
}

console.log('6) canScrollFrom — only a target inside the pane may scroll it:')
{
  // Minimal stand-ins: the function only uses `closest` and `contains`.
  const makeEl = (opts: { editable?: boolean; inside?: boolean }): Element =>
    ({
      closest: (sel: string) => (opts.editable && sel.includes('textarea') ? ({} as Element) : null),
      __inside: opts.inside,
    }) as unknown as Element
  const owner = { contains: (el: unknown) => (el as { __inside?: boolean })?.__inside === true } as unknown as Element

  check('plain node inside the pane scrolls', canScrollFrom(makeEl({ inside: true }), owner))
  check('node outside the pane is ignored', !canScrollFrom(makeEl({ inside: false }), owner))
  check('textarea is never hijacked', !canScrollFrom(makeEl({ editable: true, inside: true }), owner))
  check('missing target is refused', !canScrollFrom(null, owner))
  check('missing owner is refused', !canScrollFrom(makeEl({ inside: true }), null))
  // Nothing focused (the target is <body>): the pane claims the key, or the
  // scroll keys look broken right after clicking a diff line.
  check('idle focus lets the pane scroll', canScrollFrom(makeEl({ inside: false }), owner, true))
  check('idle focus still spares a textarea', !canScrollFrom(makeEl({ editable: true, inside: false }), owner, true))
}

if (failures > 0) {
  console.error(`\n${failures} scrollKeys check(s) failed`)
  process.exit(1)
}
console.log('\nscrollKeys: all checks passed')
