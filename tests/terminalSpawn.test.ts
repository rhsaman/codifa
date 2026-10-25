// Who owns the FIRST spawn in a freshly opened terminal panel
// (shouldSpawnShell in src/components/TerminalPanel.tsx).
//
// The panel boots, adopts whatever ptys survived in the Rust shell, and spawns
// a shell only when it adopted nothing — a panel that found live sessions must
// not start a second one. (An in-app nvim no longer queues a request here: it
// opens its own viewer TAB, so the bottom panel is never asked to run a program.)
//
// Browser globals come first: the panel's import chain reaches the store, which
// touches `window`/`localStorage` at module init. Static imports hoist above
// that setup, so the module is pulled in dynamically (same shape as
// terminalPanel.ssr.test.tsx).
;(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
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

const { shouldSpawnShell } = await import('../src/components/TerminalPanel')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

console.log('1) an empty panel owes the user a shell:')
check('no tabs', shouldSpawnShell(0) === true)

console.log('2) an adopted session is never doubled:')
check('one adopted tab', shouldSpawnShell(1) === false)
check('many tabs', shouldSpawnShell(4) === false)

export {}

if (failed > 0) {
  console.error(`\nterminalSpawn: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nterminalSpawn: all checks passed')
