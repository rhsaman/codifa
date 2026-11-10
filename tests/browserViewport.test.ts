/**
 * Fit-to-pane invariants for the in-app browser panel.
 *
 * Regressions covered here:
 *   1. the panel froze at one size because a status poll collapsed the fit
 *      "cap" to the current width;
 *   2. even after that, follow mode stopped growing at the last manual width,
 *      so the toolbar toggle appeared dead.
 * Follow mode now means FOLLOW: the target is the pane's content width, with
 * no remembered cap. A manual size switches to fixed mode instead.
 */
import { DEFAULT_VIEWPORT_SIZE, VIEWPORT_LIMITS, clampViewportSize, fitHeightTarget, fitWidthTarget, frameZoom, rulerPctForWidth, rulerWidthForPct, shouldSyncViewportDrafts, visibleRulerTicks, widthRulerTicks } from '../src/lib/browserViewport'

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
// The pane is narrower than the default: follow it down.
check('narrow pane follows it down', fitWidthTarget(700) === 700, fitWidthTarget(700))
// The pane is wider than the old 1280 default: follow it UP too. This is the
// regression the user hit — a stale cap froze the page at the small width.
check('wide pane follows it up', fitWidthTarget(1600) === 1600, fitWidthTarget(1600))
check('very wide pane follows it up', fitWidthTarget(2400) === 2400, fitWidthTarget(2400))
// An explicit maximum still caps (the helper stays pure and testable).
check('explicit maximum is honoured', fitWidthTarget(4000, VIEWPORT_LIMITS.minWidth, 900) === 900, fitWidthTarget(4000, VIEWPORT_LIMITS.minWidth, 900))
// Degenerate pane measurements fall back to the backend default.
check('zero pane falls back to the default', fitWidthTarget(0) === DEFAULT_VIEWPORT_SIZE.width, fitWidthTarget(0))
check('NaN pane falls back to the default', fitWidthTarget(Number.NaN) === DEFAULT_VIEWPORT_SIZE.width, fitWidthTarget(Number.NaN))
// Never below the backend's minimum width.
check('clamped to the minimum width', fitWidthTarget(10) === VIEWPORT_LIMITS.minWidth, fitWidthTarget(10))
check('clamped to the maximum width', fitWidthTarget(99999) === VIEWPORT_LIMITS.maxWidth, fitWidthTarget(99999))
// Rounding keeps the reported size integral (the ruler shows whole pixels).
check('rounds fractional pane widths', fitWidthTarget(1024.6) === 1025, fitWidthTarget(1024.6))

console.log('fitHeightTarget')
check('short pane follows it down', fitHeightTarget(640) === 640, fitHeightTarget(640))
check('tall pane fills the panel', fitHeightTarget(1180) === 1180, fitHeightTarget(1180))
check('clamped to the minimum height', fitHeightTarget(10) === VIEWPORT_LIMITS.minHeight, fitHeightTarget(10))
check('clamped to the maximum height', fitHeightTarget(99999) === VIEWPORT_LIMITS.maxHeight, fitHeightTarget(99999))
check('zero pane falls back to the default height', fitHeightTarget(0) === DEFAULT_VIEWPORT_SIZE.height, fitHeightTarget(0))
check('NaN pane falls back to the default height', fitHeightTarget(Number.NaN) === DEFAULT_VIEWPORT_SIZE.height, fitHeightTarget(Number.NaN))
check('rounds fractional pane heights', fitHeightTarget(800.6) === 801, fitHeightTarget(800.6))

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

console.log('ruler 4K scale + label thinning')
// The ruler now runs 320 → 3840 (4K UHD), so the same percentage covers a
// wider range and the small breakpoints need fewer printed labels.
check('4K is the right edge', rulerPctForWidth(3840) === 100, rulerPctForWidth(3840))
check('320 is the left edge', rulerPctForWidth(320) === 0, rulerPctForWidth(320))
check('100% maps to 4K', rulerWidthForPct(100) === 3840, rulerWidthForPct(100))
check('all nine breakpoints are present', widthRulerTicks().length === 9, widthRulerTicks())
check('4K is a tick', widthRulerTicks().includes(3840))
// A narrow track cannot print 320/375/425 side by side: thinning keeps the
// first tick and the 4K anchor while dropping labels that would overlap.
const narrow = visibleRulerTicks(420)
check('narrow track keeps the 4K anchor', narrow.includes(3840), narrow)
check('narrow track keeps 320', narrow.includes(320), narrow)
check('narrow track drops the crowded 375/425 labels', !narrow.includes(375) && !narrow.includes(425), narrow)
check('narrow track labels fit the minimum gap', narrow.every((w, i) => i === 0 || (rulerPctForWidth(w) - rulerPctForWidth(narrow[i - 1])) / 100 * 420 >= 34), narrow)
// A wide track has room for every label.
const wide = visibleRulerTicks(4000)
check('wide track prints every tick', wide.length === widthRulerTicks().length, wide)
// Unknown width (first paint / SSR) falls back to all labels rather than none.
check('unmeasured track keeps all labels', visibleRulerTicks(0).length === widthRulerTicks().length)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
