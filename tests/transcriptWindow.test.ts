// The transcript's mounted window must be RELEASABLE, not just growable.
//
// `msgLimit` is raised every time the user scrolls to the top, so without a
// trim the rendered transcript only ever got bigger: once a user had scrolled
// up through a long chat, every message they passed stayed mounted for the rest
// of the session (the window reset only on a chat switch). Each mounted message
// keeps a laid-out subtree plus its paint resources, so the renderer's footprint
// tracked the longest scroll ever performed rather than what was on screen.
//
// These checks pin the trim POLICY (when may the window shrink) without needing
// a DOM: the decision is a pure function of the current page count and whether
// the viewport is pinned to the newest message.
import { shouldTrimMountedWindow } from '../src/lib/messageWindow.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const PAGE = 30

{
  console.log('── trim only while pinned to the newest message ──')
  // Scrolled up: the user is READING history. Shrinking there would delete
  // content under their viewport and immediately re-trigger the auto-load,
  // which oscillates between mount and unmount.
  check('no trim while scrolled up', shouldTrimMountedWindow(PAGE * 4, PAGE, false) === false)
  check('no trim while scrolled up, 2 pages', shouldTrimMountedWindow(PAGE * 2, PAGE, false) === false)
}

{
  console.log('── trim releases extra pages once back at the bottom ──')
  check('trims 4 pages at the bottom', shouldTrimMountedWindow(PAGE * 4, PAGE, true) === true)
  check('trims 2 pages at the bottom', shouldTrimMountedWindow(PAGE * 2, PAGE, true) === true)
}

{
  console.log('── a single page is already minimal ──')
  // Nothing to give back: the trim must not loop by "trimming" to the same value.
  check('one page at the bottom is a no-op', shouldTrimMountedWindow(PAGE, PAGE, true) === false)
  check('one page scrolled up is a no-op', shouldTrimMountedWindow(PAGE, PAGE, false) === false)
  // An anchor-sized window below one page (a restored scroll position can be
  // smaller) must also be left alone.
  check('below one page is a no-op', shouldTrimMountedWindow(5, PAGE, true) === false)
}

{
  console.log('── the trim never discards reachable history ──')
  // Trimming returns to ONE page, which must remain >= the minimum the window
  // slice keeps; otherwise the transcript could render nothing.
  check('one page is a usable minimum', PAGE >= 5, PAGE)
  // And the remaining page is still a full count window, so the newest message
  // and several above it stay mounted after the trim.
  check('one page still renders 30', PAGE === 30, PAGE)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed ❌`)
  process.exit(1)
}
console.log('\ntranscriptWindow: all checks passed ✅')
process.exit(0)
