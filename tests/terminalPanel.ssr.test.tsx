// SSR test for the Terminal panel, booted with the panel PERSISTED OPEN
// (localStorage flag set before the store module loads — zustand's server
// render snapshot is the store's initial state). Asserts the chrome: tab
// strip, +/× actions, open marker. The xterm screens themselves only mount
// in a real browser (effects never run during SSR).
const localStorageStub = {
  getItem: (k: string) => (k === 'coder:terminalPanel' ? '1' : null),
  setItem: () => {},
  removeItem: () => {},
}
;(globalThis as any).localStorage = localStorageStub
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
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

const { renderToString } = await import('react-dom/server')
const { TerminalPanel } = await import('../src/components/TerminalPanel')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const openHtml = renderToString(<TerminalPanel />)
check('renders the panel when persisted open', openHtml.includes('terminal-panel'), openHtml.slice(0, 120))
check('panel is marked open', openHtml.includes('data-open="true"'), openHtml.slice(0, 160))
check('has the Terminal title', openHtml.includes('>Terminal<'))
check('has the new-terminal button', openHtml.includes('New terminal'))
check('has the hide-panel button', openHtml.includes('Hide terminal panel'))
check('has a resize handle', openHtml.includes('terminal-resize-handle'))
check('has the terminal fullscreen button', openHtml.includes('Fullscreen terminal (Ctrl+M)'))
check('marks fullscreen state', openHtml.includes('data-fullscreen="false"'), openHtml.slice(0, 160))

// Browser/webonly build without the terminal bridge: a friendly fallback
// note instead of empty screens.
;(globalThis as any).window.coder = {}
const unsupportedHtml = renderToString(<TerminalPanel />)
check('shows the unsupported note without the bridge', unsupportedHtml.includes('terminal-unsupported'))

export {}

if (failed > 0) {
  console.error(`terminalPanel: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('terminalPanel: all checks passed')
