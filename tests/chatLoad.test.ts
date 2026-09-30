// Regression test for the intermittent "workspaces show but chats disappear"
// bug: a transient backend miss (empty payload on a background refresh, e.g.
// `sidecar:changed` after a sidecar restart) must never wipe the held chats.
// Run: npx esbuild tests/chatLoad.test.ts --bundle --platform=node --format=esm \
//        --packages=external --external:electron --outfile=tests/.tmp-load.mjs \
//        && node tests/.tmp-load.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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

const { selectLoadedChats } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const held = [{ id: 'a' }, { id: 'b' }] as any[]

console.log('1) full transient miss keeps everything (no downgrade):')
{
  const out = selectLoadedChats(held, [], { settingsMissing: true, hasSettingsFile: true })
  check('held chats kept', out.chats === held)
  check('emptyMiss flagged', out.emptyMiss === true)
}

console.log('2) partial miss (settings arrived) keeps held chats:')
{
  const out = selectLoadedChats(held, [], { settingsMissing: false, hasSettingsFile: true })
  check('held chats kept', out.chats === held)
  check('kept flagged', out.kept === true)
  check('not an empty miss', out.emptyMiss === false)
}

console.log('3) genuine wipe (no settings file) settles to empty:')
{
  const out = selectLoadedChats(held, [], { settingsMissing: true, hasSettingsFile: false })
  check('settles to empty', out.chats.length === 0)
  check('nothing kept', out.kept === false && out.emptyMiss === false)
}

console.log('3b) fresh profile (nothing held) settles to empty:')
{
  const out = selectLoadedChats([], [], { settingsMissing: true, hasSettingsFile: false })
  check('settles to empty', out.chats.length === 0)
  check('nothing kept', out.kept === false && out.emptyMiss === false)
}

console.log('4) fresh payload replaces held chats:')
{
  const fresh = [{ id: 'c' }] as any[]
  const out = selectLoadedChats(held, fresh, { settingsMissing: false, hasSettingsFile: true })
  check('fresh payload wins', out.chats === fresh)
  check('nothing kept', out.kept === false && out.emptyMiss === false)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed ❌`)
  process.exit(1)
}
console.log('\nAll chat load tests passed ✅')
process.exit(0)
