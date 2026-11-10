// Unit: PER-PAGE width of the right viewer pane.
//
// Reported live: switching from a wide page (Review) to Todos GREW with an
// animation but SHRANK with a snap. The pane rides its target width inline as
// `max-width` (so the stylesheet cap cannot freeze a close), and an
// un-transitioned `max-width` clamps the very first frame of a shrink — the
// animation never gets to run. These checks pin both halves:
//   • the pure width store (defaults, isolation, persistence, clamps);
//   • the CSS/JS contract that keeps a shrink animating.
// Run: npx esbuild tests/paneWidths.test.ts --bundle --platform=node \
//        --format=esm --outfile=tests/.tmp-paneWidths.mjs && node tests/.tmp-paneWidths.mjs

// viewerTabs.ts (imported by paneWidths.ts) touches window/localStorage at
// module load and useStore reads activeChatId — stub both before import, same
// pattern as tests/viewerTabs.test.ts.
const memStore = new Map<string, string>()
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1280,
  localStorage: {
    getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      memStore.set(k, v)
    },
    removeItem: (k: string) => {
      memStore.delete(k)
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).document = { documentElement: { style: { setProperty: () => {} } } }

const {
  PANE_DEFAULT_WIDTH,
  PANE_MIN_WIDTH,
  clampPaneWidth,
  loadPaneWidths,
  paneWidthFor,
  savePaneWidth,
} = await import('../src/lib/paneWidths')
const { readFileSync } = await import('node:fs')

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

console.log('1) defaults — Todos opens at the site minimum, other pages keep room:')
{
  check('the pane never renders narrower than PANE_MIN_WIDTH', PANE_MIN_WIDTH === 320)
  check('todos defaults to the minimum', PANE_DEFAULT_WIDTH.todos === PANE_MIN_WIDTH)
  check(
    'every page has a default at least as wide as the minimum',
    Object.values(PANE_DEFAULT_WIDTH).every((w) => typeof w === 'number' && w >= PANE_MIN_WIDTH),
  )
  check('review is the widest default (code needs the room)', PANE_DEFAULT_WIDTH.review >= PANE_DEFAULT_WIDTH.file)
}

console.log('2) paneWidthFor — a page only ever reads its OWN width:')
{
  check('an unsaved page opens at ITS default, not the legacy global width', paneWidthFor({}, 'todos', 900) === PANE_MIN_WIDTH)
  check('an unsaved review opens at review width', paneWidthFor({}, 'review', 900) === PANE_DEFAULT_WIDTH.review)
  check('a saved width wins over the default', paneWidthFor({ review: 640 }, 'review', 900) === 640)
  check(
    'widening review never leaks into todos',
    paneWidthFor({ review: 900 }, 'todos', 900) === PANE_MIN_WIDTH,
  )
  check('no page at all falls back to the legacy split width', paneWidthFor({}, undefined, 900) === 900)
  check('a junk saved width is ignored', paneWidthFor({ review: Number.NaN }, 'review', 900) === PANE_DEFAULT_WIDTH.review)
  check('a zero saved width is ignored', paneWidthFor({ review: 0 }, 'review', 900) === PANE_DEFAULT_WIDTH.review)
  check('a negative saved width is ignored', paneWidthFor({ review: -1 }, 'review', 900) === PANE_DEFAULT_WIDTH.review)
}

console.log('3) persistence — only the dragged page is written, junk is rejected:')
{
  const before = loadPaneWidths()
  check('a fresh store is empty', Object.keys(before).length === 0)

  const afterTodos = savePaneWidth(before, 'todos', 420)
  check('the drag is recorded for that page', afterTodos.todos === 420)
  check('the previous map is not mutated', before.todos === undefined)
  check('the value survives a reload', loadPaneWidths().todos === 420)

  const afterReview = savePaneWidth(afterTodos, 'review', 700)
  check('a second page is added', afterReview.review === 700)
  check('the first page keeps its width', loadPaneWidths().todos === 420)

  const rounded = savePaneWidth(afterReview, 'browser', 512.6)
  check('a drag is rounded to whole pixels', rounded.browser === 513)

  memStore.set('coder:paneWidths', JSON.stringify({ review: 640, todos: 'wide', browser: -4, plan: 0, trace: null }))
  const cleaned = loadPaneWidths()
  check('a valid entry is kept', cleaned.review === 640)
  check('a non-number entry is dropped', cleaned.todos === undefined)
  check('a negative entry is dropped', cleaned.browser === undefined)
  check('a zero entry is dropped', cleaned.plan === undefined)
  check('a null entry is dropped', cleaned.trace === undefined)

  memStore.set('coder:paneWidths', 'not json')
  check('unparseable storage degrades to an empty map', Object.keys(loadPaneWidths()).length === 0)
}

console.log('4) clampPaneWidth — never overflows the chat or collapses the pane:')
{
  check('a comfortable width is untouched', clampPaneWidth(820, 1400, 0) === 820)
  check(
    'the docked right panel is subtracted from the ceiling',
    clampPaneWidth(820, 1000, 220) === 1000 - 320 - 220,
  )
  check('a too-narrow request is floored at the site minimum', clampPaneWidth(200, 1400, 0) === PANE_MIN_WIDTH)
  check(
    'a very narrow container returns a positive width (never 0)',
    clampPaneWidth(820, 400, 0) === 80 && 80 > 0,
  )
}

console.log('5) the shrink ANIMATION contract (the reported snap):')
{
  const css = readFileSync('src/styles/global/09-right-panel-claude-todos.css', 'utf8')
  const group = /\.viewer-group\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('the pane transitions flex-basis', /flex-basis\s+0\.24s/.test(group))
  check('the pane transitions width', /width\s+0\.24s/.test(group))
  check('the pane transitions max-width too — a shrink must not snap', /max-width\s+0\.24s/.test(group))
  check('all three width properties share one easing', (group.match(/0\.24s cubic-bezier\(0\.4, 0, 0\.2, 1\)/g) ?? []).length === 3)
  check('a drag still disables every transition', /body\.coder-resizing \.viewer-group\s*\{[^}]*transition:\s*none\s*!important/.test(css))

  const app = readFileSync('src/App.tsx', 'utf8')
  check(
    'the open pane rides its width as an inline max-width',
    app.includes('maxWidth: paneOpen ? paneW : undefined'),
  )
  check(
    'the rendered width is resolved per shown page',
    app.includes('paneWidthFor(paneWidths, paneKind, splitW)'),
  )
  check(
    'a drag persists under the shown page only',
    app.includes('setPaneWidths(savePaneWidth(paneWidthsRef.current, paneKind, w))'),
  )
  check(
    'the no-tab fallback page counts as Panel for width',
    app.includes('const paneKind = shownTab?.kind ?? FALLBACK_VIEWER_KIND'),
  )
}

console.log('6) the pane focus ring — thin, and glued to a resizing pane:')
{
  const flash = readFileSync('src/lib/paneFlash.ts', 'utf8')
  check('the ring border is 1px', /border:\s*1px solid var\(--accent/.test(flash))
  check('the old 2px ring is gone', !/border:\s*2px solid/.test(flash))
  check(
    'the ring re-reads the pane rect every frame',
    flash.includes('requestAnimationFrame(sync)') && flash.includes('el.getBoundingClientRect()'),
  )
  check('the tracking loop is cancelled with the ring', flash.includes('cancelAnimationFrame(raf)'))
  check('a disconnected pane ends the loop', flash.includes('!el.isConnected'))
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall paneWidths checks passed')
