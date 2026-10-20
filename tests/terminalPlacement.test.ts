// Placement of the terminal dock: the bottom panel (default) or the right side
// pane. Two things are locked here:
//   * hydration of the persisted `coder:terminalPlacement` key, and
//   * resolveTerminalPlacement — the rule that keeps a fixed-position terminal
//     from being stranded when the side pane is not on screen.
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

// Seed the persisted dock BEFORE the store module loads: zustand hydrates its
// initial state at import time, so a later localStorage write cannot reach it.
const disk = new Map<string, string>([
  ['coder:terminalPlacement', 'right'],
  ['coder:terminalPanel', '1'],
])
;(globalThis as any).localStorage = {
  getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
  setItem: (k: string, v: string) => {
    disk.set(k, String(v))
  },
  removeItem: (k: string) => {
    disk.delete(k)
  },
}
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1440,
  innerHeight: 900,
  // The store's import graph reaches src/lib/api.ts, which touches
  // window.coder while the module is still evaluating — without the bridge
  // stub the whole import throws before the first assertion runs.
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

const { resolveTerminalPlacement, useStore } = await import('../src/lib/store')
const {
  clampTerminalHeight,
  DEFAULT_TERMINAL_HEIGHT,
  MIN_PANE_CONTENT_HEIGHT,
  MIN_TERMINAL_HEIGHT,
  resolveTerminalDockHeight,
} = await import('../src/lib/store')

console.log('1) the persisted dock is hydrated at boot:')
{
  const s = useStore.getState() as any
  check('terminalPlacement reads the stored "right"', s.terminalPlacement === 'right', s.terminalPlacement)
  check('the panel itself is hydrated too', s.terminalPanelOpen === true)
}

console.log('2) the side dock degrades to the bottom whenever the pane is hidden:')
{
  check("right + visible pane -> 'right'", resolveTerminalPlacement('right', true, false) === 'right')
  check("right + closed pane -> 'bottom'", resolveTerminalPlacement('right', false, false) === 'bottom')
  check("right + fullscreen chat -> 'bottom'", resolveTerminalPlacement('right', true, true) === 'bottom')
  check("right + closed pane + fullscreen -> 'bottom'", resolveTerminalPlacement('right', false, true) === 'bottom')
  check("bottom stays bottom (pane open)", resolveTerminalPlacement('bottom', true, false) === 'bottom')
  check("bottom stays bottom (pane closed)", resolveTerminalPlacement('bottom', false, true) === 'bottom')
}

console.log('3) the setter persists and the store follows:')
{
  useStore.getState().setTerminalPlacement('bottom')
  check('state switches to bottom', (useStore.getState() as any).terminalPlacement === 'bottom')
  check('localStorage records bottom', disk.get('coder:terminalPlacement') === 'bottom', disk.get('coder:terminalPlacement'))

  useStore.getState().toggleTerminalPlacement()
  check('toggle flips to right', (useStore.getState() as any).terminalPlacement === 'right')
  check('toggle persists right', disk.get('coder:terminalPlacement') === 'right', disk.get('coder:terminalPlacement'))

  useStore.getState().toggleTerminalPlacement()
  check('toggle flips back to bottom', (useStore.getState() as any).terminalPlacement === 'bottom')
}

console.log('4) moving to the side pane leaves fullscreen (the dock would be invisible):')
{
  useStore.getState().setTerminalFullscreen(true)
  check('fullscreen is on', (useStore.getState() as any).terminalFullscreen === true)
  check('fullscreen opened the panel', (useStore.getState() as any).terminalPanelOpen === true)

  useStore.getState().setTerminalPlacement('right')
  check('the dock changed', (useStore.getState() as any).terminalPlacement === 'right')
  check('fullscreen was cleared', (useStore.getState() as any).terminalFullscreen === false)
  check('the cleared fullscreen was persisted', disk.get('coder:terminalFullscreen') === '0', disk.get('coder:terminalFullscreen'))
}

console.log('5) the dock height is hydrated, clamped and persisted:')
{
  check('the stored height is hydrated', (useStore.getState() as any).terminalHeight === 300, (useStore.getState() as any).terminalHeight)

  useStore.getState().setTerminalHeight(420)
  check('the setter applies', (useStore.getState() as any).terminalHeight === 420)
  check('the setter persists', disk.get('coder:terminalHeight') === '420', disk.get('coder:terminalHeight'))

  // Below the floor the tab strip would eat the shell; above the ceiling the
  // pane would lose its own content (the ceiling is applied by the pane side).
  useStore.getState().setTerminalHeight(10)
  check(
    'a too-small drag clamps up to the minimum',
    (useStore.getState() as any).terminalHeight === MIN_TERMINAL_HEIGHT,
    (useStore.getState() as any).terminalHeight,
  )
  check('the clamped value is what got stored', disk.get('coder:terminalHeight') === String(MIN_TERMINAL_HEIGHT))

  check('a non-numeric value falls back to the default', clampTerminalHeight(Number.NaN) === DEFAULT_TERMINAL_HEIGHT)
  check('a fractional drag is rounded', clampTerminalHeight(333.7) === 334)
}

console.log('6) the docked strip can never swallow the pane it lives in:')
{
  // The pane keeps MIN_PANE_CONTENT_HEIGHT of its own content above the dock.
  check('a tall stored height is capped by the pane', resolveTerminalDockHeight(900, 400) === 400 - MIN_PANE_CONTENT_HEIGHT)
  check('a short pane still leaves a usable dock', resolveTerminalDockHeight(900, 200) === MIN_TERMINAL_HEIGHT)
  check('an unmeasured pane keeps the stored height', resolveTerminalDockHeight(420, 0) === 420)
  check(
    'the pane always keeps its content band',
    400 - resolveTerminalDockHeight(900, 400) >= MIN_PANE_CONTENT_HEIGHT,
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
