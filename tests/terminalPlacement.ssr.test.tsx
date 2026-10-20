// SSR test for the terminal dock geometry (side pane vs bottom panel).
//
// What it locks:
//   * the side dock is only claimed when BOTH the effective placement and a
//     measured rect exist — a fixed-position panel without a rect would sit at
//     0/0, so it must degrade to the bottom dock instead;
//   * the measured rect reaches the inline style untouched;
//   * the header offers a move action whose label matches the current dock.
//
// The panel is booted PERSISTED OPEN (localStorage flag set before the store
// module loads — zustand's server snapshot IS the initial state), because the
// component renders null until its first open.
const localStorageStub = {
  getItem: (k: string) => (k === 'coder:terminalPanel' ? '1' : null),
  setItem: () => {},
  removeItem: () => {},
}
;(globalThis as any).localStorage = localStorageStub
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1440,
  innerHeight: 900,
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
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { renderToString } = await import('react-dom/server')
const { TerminalPanel } = await import('../src/components/TerminalPanel')
const { MIN_TERMINAL_HEIGHT, resolveTerminalDockHeight } = await import('../src/lib/store')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) the default dock is the bottom panel:')
{
  const html = renderToString(<TerminalPanel />)
  check('marked as the bottom dock', html.includes('data-placement="bottom"'), html.slice(0, 200))
  check('no side-dock class', !html.includes('terminal-right'))
  check('the vertical drag handle is present', html.includes('terminal-resize-handle'))
  check('offers a move-to-side-pane action', html.includes('Move terminal to the side pane'))
  check(
    'the hide action keeps its shortcut hint',
    /Hide terminal panel \(\d|⌘J|Ctrl\+J/.test(html),
    html.slice(0, 400),
  )
}

console.log('2) the side dock applies the measured strip and swaps the move action:')
{
  const dock = { left: 100, top: 48, width: 612, height: 845 }
  const html = renderToString(<TerminalPanel placement="right" dock={dock} />)
  check('marked as the side dock', html.includes('data-placement="right"'), html.slice(0, 200))
  check('carries the side-dock class', html.includes('terminal-right'))
  check('applies the measured width', html.includes('width:612px'), html.slice(0, 400))
  check('applies the measured height', html.includes('height:845px'))
  check('applies the measured left offset', html.includes('left:100px'))
  check('applies the measured top offset', html.includes('top:48px'))
  check('keeps the drag handle (the strip is resized from its top edge)', html.includes('terminal-resize-handle'))
  check('offers the move-back action', html.includes('Move terminal to the bottom panel'), html.slice(0, 900))
  check('no longer offers move-to-side-pane', !html.includes('Move terminal to the side pane'))
  check('the hide action drops the panel shortcut hint', !html.includes('Hide terminal panel (⌘J)'))
}

console.log('3) the side dock falls back when the pane strip is unknown:')
{
  const html = renderToString(<TerminalPanel placement="right" dock={null} />)
  check('falls back to the bottom dock', html.includes('data-placement="bottom"'), html.slice(0, 200))
  check('drops the side-dock class', !html.includes('terminal-right'))
  check(
    'offers move-to-side-pane again',
    html.includes('Move terminal to the side pane'),
    html.slice(0, 900),
  )
}

console.log('4) the side dock never swallows the pane content (App supplies the ceiling):')
{
  // The strip is the pane minus a reserved content band; a taller stored height
  // must not push the pane's own tabs/tree out of view.
  check('pane 900px + stored 300px -> 300px', resolveTerminalDockHeight(300, 900) === 300)
  check('pane 400px + stored 900px -> 240px', resolveTerminalDockHeight(900, 400) === 240)
  check(
    'the dock never goes below the minimum',
    resolveTerminalDockHeight(10, 900) === MIN_TERMINAL_HEIGHT,
    resolveTerminalDockHeight(10, 900),
  )
  check(
    'an unmeasured pane leaves the stored height alone',
    resolveTerminalDockHeight(300, 0) === 300,
  )
}

export {}

if (failed > 0) {
  console.error(`terminalPlacement: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('terminalPlacement: all checks passed')
