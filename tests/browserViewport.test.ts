/**
 * Fit-to-pane invariants for the in-app browser panel.
 *
 * Regression: the panel froze at one size and the width ruler appeared to do
 * nothing. Two causes, both covered here:
 *   1. a status poll echoing our OWN fit-shrunk width overwrote the fit cap,
 *      so once cap === current width the target never differed again;
 *   2. a manual size did not leave follow mode, so the fit observer shrank it
 *      straight back to the pane width.
 * The cap bookkeeping lives in the component; these tests pin the pure rules
 * it relies on so the behaviour cannot silently regress.
 */
import { DEFAULT_VIEWPORT_SIZE, VIEWPORT_LIMITS, capAfterPoll, clampViewportSize, fitWidthTarget, frameZoom, shouldSyncViewportDrafts } from '../src/lib/browserViewport'

let failures = 0
function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`)
  }
}

console.log('fitWidthTarget')
// The pane is narrower than the cap: follow it down.
check('narrow pane shrinks to the pane width', fitWidthTarget(700, 1280) === 700, fitWidthTarget(700, 1280))
// The pane is wider than the cap: grow back up to the cap, never past it.
check('wide pane grows back to the cap', fitWidthTarget(1600, 1280) === 1280, fitWidthTarget(1600, 1280))
// A collapsed cap (the old bug) would pin the width forever — the helper must
// still honour a cap the caller passes, so the component must not collapse it.
check('cap is never exceeded', fitWidthTarget(4000, 900) === 900, fitWidthTarget(4000, 900))
// Degenerate pane measurements must not resize anything.
check('zero pane keeps the cap', fitWidthTarget(0, 1280) === 1280, fitWidthTarget(0, 1280))
check('NaN pane keeps the cap', fitWidthTarget(Number.NaN, 1280) === 1280, fitWidthTarget(Number.NaN, 1280))
// Never below the backend's minimum width.
check('clamped to the minimum width', fitWidthTarget(10, 1280) === VIEWPORT_LIMITS.minWidth, fitWidthTarget(10, 1280))
// Rounding keeps the reported size integral (the ruler shows whole pixels).
check('rounds fractional pane widths', fitWidthTarget(1024.6, 1280) === 1025, fitWidthTarget(1024.6, 1280))

console.log('capAfterPoll')
// The core regression: a status poll echoing our OWN fit-shrunk size must not
// collapse the cap, or once cap === current width the fit target never differs
// again and the panel freezes at one size (the ruler looks dead).
check('own poll keeps the cap', capAfterPoll({ w: 700, h: 800 }, 700, 800, 1280) === 1280, capAfterPoll({ w: 700, h: 800 }, 700, 800, 1280))
// A genuine external resize (agent / CDP) becomes the new cap.
check('external resize becomes the cap', capAfterPoll({ w: 700, h: 800 }, 1024, 800, 1280) === 1024, capAfterPoll({ w: 700, h: 800 }, 1024, 800, 1280))
// Same width but a different height is still an external change.
check('height-only change becomes the cap', capAfterPoll({ w: 700, h: 800 }, 700, 600, 1280) === 700, capAfterPoll({ w: 700, h: 800 }, 700, 600, 1280))
// Before the first apply there is nothing of ours to recognise.
check('no prior apply adopts the polled size', capAfterPoll(null, 900, 700, 1280) === 900, capAfterPoll(null, 900, 700, 1280))
// The cap survives a fit-shrink, so widening the pane grows the width back.
const keptCap = capAfterPoll({ w: 700, h: 800 }, 700, 800, 1280)
check('cap survives a fit-shrink and grows back', fitWidthTarget(1400, keptCap) === 1280, fitWidthTarget(1400, keptCap))

console.log('clampViewportSize')
check('keeps an in-range size', JSON.stringify(clampViewportSize(1024, 768)) === JSON.stringify({ width: 1024, height: 768 }))
check('clamps below the minimum', clampViewportSize(1, 1).width === VIEWPORT_LIMITS.minWidth)
check('clamps above the maximum', clampViewportSize(99999, 99999).width === VIEWPORT_LIMITS.maxWidth)
check('falls back on NaN', clampViewportSize(Number.NaN, Number.NaN).width === DEFAULT_VIEWPORT_SIZE.width)

console.log('frameZoom')
// Regression: the CSS stretched the frame to the pane, so a 375px and a 1600px
// viewport both filled the panel and the ruler looked dead. The frame is now
// rendered at this zoom, so the emulated size is always visible.
check('never upscales past 1:1', frameZoom(2000, 2000, 1280, 800) === 1, frameZoom(2000, 2000, 1280, 800))
check('shrinks to fit a narrow pane', frameZoom(640, 2000, 1280, 800) === 0.5, frameZoom(640, 2000, 1280, 800))
check('shrinks to fit a short pane', frameZoom(2000, 400, 1280, 800) === 0.5, frameZoom(2000, 400, 1280, 800))
check('picks the tighter axis', frameZoom(640, 400, 1280, 800) === 0.5, frameZoom(640, 400, 1280, 800))
check('a small viewport stays 1:1 in a big pane', frameZoom(1200, 900, 375, 667) === 1, frameZoom(1200, 900, 375, 667))
check('degenerate pane falls back to 1', frameZoom(0, 0, 1280, 800) === 1, frameZoom(0, 0, 1280, 800))
check('degenerate viewport falls back to 1', frameZoom(800, 600, 0, 0) === 1, frameZoom(800, 600, 0, 0))
check('NaN inputs fall back to 1', frameZoom(Number.NaN, 600, 1280, 800) === 1, frameZoom(Number.NaN, 600, 1280, 800))

console.log('shouldSyncViewportDrafts')
// A poll that echoes the size we just applied must not fight the user's typing.
check('never syncs while editing', shouldSyncViewportDrafts(1280, 800, 900, 800, true) === false)
check('syncs on a real change', shouldSyncViewportDrafts(1280, 800, 900, 800, false) === true)
check('ignores an identical size', shouldSyncViewportDrafts(1280, 800, 1280, 800, false) === false)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
