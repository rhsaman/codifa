// SSR test for the Terminal panel, booted CLOSED (no persisted flag):
// nothing renders at all so no shells spawn just because the app booted.
const localStorageStub = {
  getItem: () => null,
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

const closed = renderToString(<TerminalPanel />)
if (closed !== '') {
  console.error(`  ❌ renders nothing while closed`, closed.slice(0, 120))
  process.exit(1)
}
console.log('  ✅ renders nothing while closed')
console.log('terminalPanelClosed: all checks passed')
export {}
