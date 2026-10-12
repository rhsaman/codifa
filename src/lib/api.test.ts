// Test for createRealtimeSession in src/lib/api.ts.
// Covers request body shape and snake_case / camelCase response normalization.
// Run: npx esbuild src/lib/api.test.ts --bundle --platform=node --format=esm --packages=external --external:electron --outfile=tests/.tmp-api-realtime.mjs && node tests/.tmp-api-realtime.mjs

export {}

// Sidecar wiring must run before importing api.ts (module load subscribes).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => 'http://127.0.0.1:8899',
    onSidecarChanged: () => () => {},
    onSidecarDead: () => () => {},
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

// Fetch mock: /health always alive; /realtime/session replays queued payloads
// and records the last request for body-shape assertions.
let sessionQueue: Record<string, unknown>[] = []
let lastUrl = ''
let lastBody: Record<string, unknown> | null = null
;(globalThis as any).fetch = async (url: string, init?: { body?: unknown }) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/realtime/session')) {
    lastUrl = url
    try {
      lastBody = JSON.parse(String(init?.body ?? '{}'))
    } catch {
      lastBody = null
    }
    const next = sessionQueue.shift() ?? {}
    return { ok: true, status: 200, json: async () => next } as unknown as Response
  }
  return new Response('', { status: 200 })
}

const { createRealtimeSession, invalidateSidecarCache } = await import('./api')

const req = {
  kind: 'openai',
  baseUrl: 'https://api.example.com',
  apiKeys: ['k1', 'k2'],
  model: 'gpt-realtime',
  voice: 'alloy',
}

console.log('1) posts provider body and normalizes snake_case response:')
{
  invalidateSidecarCache()
  sessionQueue = [
    {
      ephemeral_token: 'tok-snake',
      websocket_url: 'wss://live.example/socket',
      expires_at: '2026-01-01T00:00:00Z',
    },
  ]
  const res = await createRealtimeSession(req)
  check('posts to sidecar realtime endpoint', lastUrl === 'http://127.0.0.1:8899/realtime/session', lastUrl)
  check('request body maps kind/baseUrl/apiKeys/model/voice', lastBody !== null &&
    lastBody['provider'] === 'openai' &&
    lastBody['base_url'] === 'https://api.example.com' &&
    lastBody['api_keys'] === JSON.stringify(['k1', 'k2']) &&
    lastBody['model'] === 'gpt-realtime' &&
    lastBody['voice'] === 'alloy', lastBody)
  check('snake_case normalized to camelCase', res.ephemeralToken === 'tok-snake' &&
    res.websocketUrl === 'wss://live.example/socket' &&
    res.expiresAt === '2026-01-01T00:00:00Z', res)
}

console.log('2) normalizes camelCase response:')
{
  invalidateSidecarCache()
  sessionQueue = [
    {
      ephemeralToken: 'tok-camel',
      websocketUrl: 'wss://live.example/socket2',
      expiresAt: '2026-01-02T00:00:00Z',
    },
  ]
  const res = await createRealtimeSession(req)
  check('camelCase normalized to camelCase', res.ephemeralToken === 'tok-camel' &&
    res.websocketUrl === 'wss://live.example/socket2' &&
    res.expiresAt === '2026-01-02T00:00:00Z', res)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll realtime session checks passed')
