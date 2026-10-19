// Unit tests for the external-open wrappers in src/lib/fs.ts:
// api.openFileExternal / openWorkspaceFolder / openWorkspaceTerminal must
// survive a stale preload (missing bridge function) with a clear error, and
// pass through the main-process result when the bridge exists.
// Run: node_modules/.bin/esbuild src/lib/fs.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/fs.test.mjs && node /tmp/fs.test.mjs

;(globalThis as any).window = { coder: {} }
;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const { api } = await import('./fs')

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

console.log('1) missing bridge reports a clear error instead of throwing:')
{
  const r1 = await api.openFileExternal('/tmp/a.ts', 'nvim')
  check('openFileExternal ok:false', r1.ok === false, r1)
  check('mentions unavailable', String(r1.error).includes('unavailable'), r1.error)
  const r2 = await api.openWorkspaceFolder('/tmp')
  check('openWorkspaceFolder ok:false', r2.ok === false, r2)
  const r3 = await api.openWorkspaceTerminal('/tmp')
  check('openWorkspaceTerminal ok:false', r3.ok === false, r3)
}

console.log('2) bridge result passes through:')
{
  ;(globalThis as any).window.coder = {
    openFileExternal: async () => ({ ok: true }),
    openWorkspaceFolder: async () => ({ ok: false, error: 'nope' }),
    openWorkspaceTerminal: async () => ({ ok: true }),
  }
  const r1 = await api.openFileExternal('/tmp/a.ts', 'vscode')
  check('success passes through', r1.ok === true, r1)
  const r2 = await api.openWorkspaceFolder('/tmp')
  check('error passes through', r2.ok === false && r2.error === 'nope', r2)
  const r3 = await api.openWorkspaceTerminal('/tmp')
  check('terminal success', r3.ok === true, r3)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll fs checks passed')
process.exit(0)
