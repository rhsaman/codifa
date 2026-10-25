// Unit tests for `listMarketplace` (src/lib/plugins.ts).
//
// Why it matters: browsing is the FIRST thing the Marketplaces tab does on its
// own, with no click. It must always settle and always answer with either an
// index or an `error` string — never reject. A rejection escaped the call site
// once (the sidecar IPC threw with no `window.coder`) and the tab sat on
// "Reading the index…" forever with no way to retry.
//
// Run: npx esbuild tests/marketplaceBrowse.test.ts --bundle --platform=node \
//        --format=esm --packages=external --external:electron --outfile=.tmp.mjs \
//      && node .tmp.mjs

let urlCalls = 0
let sidecarUrl: string | null = 'http://127.0.0.1:8899'
let bridgeThrows = false

;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => {
      urlCalls++
      if (bridgeThrows) throw new Error("Cannot read properties of undefined (reading 'getSidecarUrl')")
      return sidecarUrl
    },
    onSidecarChanged: () => () => {},
    onSidecarDead: () => () => {},
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const INDEX = {
  name: 'Demo Market',
  description: 'a catalogue',
  source: 'acme/market',
  count: 1,
  plugins: [{ name: 'Ponytail', description: 'tail', repo: 'acme/ponytail' }],
}

/** fetch mock: /health is always alive; the index route answers per case. */
let indexReply: { status: number; body: unknown } = { status: 200, body: INDEX }
;(globalThis as any).fetch = async (url: string) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.includes('/plugins/marketplace')) {
    return new Response(JSON.stringify(indexReply.body), {
      status: indexReply.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('', { status: 404 })
}

const { listMarketplace } = await import('../src/lib/plugins.ts')
const { invalidateSidecarCache } = await import('../src/lib/api.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const ADDRESS = { repo: 'acme/market', path: 'plugins', git_ref: 'main' }

console.log('1) a good index comes back whole:')
{
  invalidateSidecarCache()
  indexReply = { status: 200, body: INDEX }
  const out = await listMarketplace(ADDRESS)
  check('count is carried through', (out as any).count === 1, out)
  check('the row survives', (out as any).plugins?.[0]?.name === 'Ponytail', out)
}

console.log('2) a missing preload bridge is an error, NOT a rejection:')
{
  // The real bug: `ensureSidecar` was awaited OUTSIDE the try, so this rejected.
  invalidateSidecarCache()
  bridgeThrows = true
  let threw = false
  let out: any = null
  try {
    out = await listMarketplace(ADDRESS)
  } catch {
    threw = true
  }
  bridgeThrows = false
  check('the promise resolves', !threw, threw)
  check('the failure is an error string', typeof out?.error === 'string' && out.error.length > 0, out)
}

console.log('3) no bridge URL at all says the backend is not ready:')
{
  invalidateSidecarCache()
  sidecarUrl = null
  const out: any = await listMarketplace(ADDRESS)
  check('error mentions the backend', /backend/i.test(out?.error ?? ''), out)
  sidecarUrl = 'http://127.0.0.1:8899'
}

console.log('4) a backend that refuses explains itself:')
{
  invalidateSidecarCache()
  indexReply = { status: 400, body: { detail: 'no marketplace index in acme/market' } }
  const out: any = await listMarketplace(ADDRESS)
  check('the backend detail is surfaced', /no marketplace index/.test(out?.error ?? ''), out)
}

console.log('5) the address is sent as the exact three args an install repeats:')
{
  invalidateSidecarCache()
  indexReply = { status: 200, body: INDEX }
  let seen = ''
  const real = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string) => {
    if (url.includes('/plugins/marketplace')) seen = url
    return real(url)
  }
  await listMarketplace(ADDRESS)
  ;(globalThis as any).fetch = real
  check('repo is in the query', seen.includes('repo=acme%2Fmarket'), seen)
  check('path is in the query', /[?&]path=plugins/.test(seen), seen)
  check('ref is in the query', /[?&]git_ref=main/.test(seen), seen)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} marketplace browse tests failed`)
  process.exit(1)
}
console.log('\n✅ all marketplace browse tests passed')
