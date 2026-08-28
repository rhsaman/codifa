// Sanity test for the self-healing reconnect layer in streamChat (src/lib/api.ts).
// Run via: npx esbuild test/streamChatReconnect.test.ts --bundle --platform=node \
//   --format=esm --packages=external --external:electron --outfile=test/.tmp-sc.mjs && node test/.tmp-sc.mjs
//
// Covers:
//  - a clean stream completes without any reconnect
//  - a network failure to CONNECT retries with exponential backoff, then succeeds
//  - a network failure MID-STREAM (reader throws) retries and resumes
//  - a manual abort does NOT trigger a reconnect (AbortError propagates)
//  - an HTTP error response (non-2xx) is NOT retried
//  - SSE ": keepalive" comments are forwarded as "keepalive" events (heartbeat)

// Stub the Electron bridge so ensureSidecar() returns a fixed URL. This MUST
// run before importing api.ts (which touches window.coder at module load).
;(globalThis as any).window = {
  coder: new Proxy(
    {
      getSidecarUrl: async () => 'http://localhost:9999',
    },
    {
      get: (target, prop) => {
        if (prop in target) return (target as any)[prop]
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}

const { streamChat } = await import('../src/lib/api.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// Build a fake SSE Response whose body streams the given events, then optionally
// throws mid-read to simulate a dropped connection. `keepalives` is the number of
// ": keepalive" heartbeat comments to interleave between events (the backend
// sends one every ~15s while the agent is legitimately silent).
function makeStreamResponse(events: any[], throwMidStream = false, keepalives = 0): Response {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  for (const ev of events) {
    chunks.push(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
    for (let k = 0; k < keepalives; k++) {
      chunks.push(encoder.encode(`: keepalive\n\n`))
    }
  }
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (throwMidStream && i === Math.floor(chunks.length / 2)) {
        controller.error(new Error('network dropped'))
        return
      }
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
  })
  return new Response(body, { status: 200 })
}

function makeErrorResponse(status: number): Response {
  return new Response(JSON.stringify({ detail: 'boom' }), { status })
}

const baseParams = {
  provider: {
    kind: 'openai',
    model: 'gpt-4o',
    apiKey: 'k',
    baseUrl: '',
    authType: '',
  } as any,
  root: '/tmp',
  mode: 'ask' as const,
  prompt: 'hi',
  chatId: 'c1',
  history: [] as any[],
}

async function run() {
  // 1) Clean stream → no reconnect, events delivered.
  {
    let calls = 0
    const received: any[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      calls++
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      return makeStreamResponse([{ kind: 'text', content: 'hi' }, { kind: 'done' }])
    }
    await streamChat(baseParams, (e) => received.push(e))
    check('۱) استریم سالم فقط یک‌بار fetch می‌زند', calls === 1, calls)
    check('۱) هر دو event رسید', received.length === 2, received)
  }

  // 2) Connect failure → retry with backoff, then succeed.
  {
    let calls = 0
    const received: any[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      calls++
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      if (calls === 2) throw new Error('connection refused') // first /chat/stream attempt fails
      return makeStreamResponse([{ kind: 'text', content: 'ok' }, { kind: 'done' }])
    }
    await streamChat(baseParams, (e) => received.push(e))
    check('۲) روی خطای اتصال دوباره تلاش می‌کند', calls >= 3, calls)
    check('۲) در نهایت event ها رسید', received.length === 2, received)
  }

  // 3) Mid-stream drop → retry and resume.
  {
    let calls = 0
    const received: any[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      calls++
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      // First attempt drops mid-stream; second completes cleanly.
      return makeStreamResponse(
        [{ kind: 'text', content: 'a' }, { kind: 'text', content: 'b' }, { kind: 'done' }],
        calls === 2,
      )
    }
    await streamChat(baseParams, (e) => received.push(e))
    check('۳) روی قطع شدن وسط استریم دوباره تلاش می‌کند', calls >= 3, calls)
    check('۳) استریم دوم کامل رسید', received.some((e) => e.kind === 'done'), received)
  }

  // 4) Manual abort → no reconnect, AbortError propagates.
  {
    let calls = 0
    const received: any[] = []
    const controller = new AbortController()
    ;(globalThis as any).fetch = async (url: string, init?: any) => {
      calls++
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      // Simulate the abort signal firing during the request.
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }
    let threw = false
    try {
      await streamChat({ ...baseParams, signal: controller.signal }, (e) => received.push(e))
    } catch (err) {
      threw = (err as Error).name === 'AbortError'
    }
    check('۴) قطع دستی باعث reconnect نمی‌شود', calls <= 2, calls)
    check('۴) AbortError پرتاب شد', threw)
  }

  // 5) HTTP error (non-2xx) → NOT retried.
  {
    let calls = 0
    ;(globalThis as any).fetch = async (url: string) => {
      calls++
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      return makeErrorResponse(500)
    }
    let msg = ''
    try {
      await streamChat(baseParams, () => {})
    } catch (err) {
      msg = (err as Error).message
    }
    check('۵) خطای HTTP باعث retry نمی‌شود', calls === 2, calls)
    check('۵) پیام خطای سرور برگشت', msg.includes('boom'), msg)
  }

  // 6) SSE ": keepalive" comments are forwarded as "keepalive" events.
  //    This is the backend's heartbeat while it's legitimately silent (running
  //    a tool / thinking). The frontend uses it to refresh its stall watchdog
  //    clock so a long-running tool is never mistaken for a dead connection.
  //    NOTE: ensureSidecar() also probes `${url}/health` once (cached URL), so
  //    we only count the actual /chat/stream fetches to assert "no reconnect".
  {
    let streamCalls = 0
    const received: any[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      if (url.endsWith('/chat/stream')) streamCalls++
      // Two text events with a heartbeat comment between them — exactly what
      // the backend emits while a tool is running.
      return makeStreamResponse(
        [{ kind: 'text', content: 'a' }, { kind: 'done' }],
        false,
        1,
      )
    }
    await streamChat(baseParams, (e) => received.push(e))
    check('۶) استریم با keepalive فقط یک‌بار fetch می‌زند', streamCalls === 1, streamCalls)
    check('۶) event keepalive از کامنت SSE ساخته شد', received.some((e) => e.kind === 'keepalive'), received)
    check('۶) event های data همچنان رسیدند', received.filter((e) => e.kind !== 'keepalive').length === 2, received)
  }

  // 7) Stream ends WITHOUT a terminal `done` (sidecar crashed mid-turn) →
  //    treated as a drop, reconnects and resumes (instead of silently stopping).
  {
    let streamCalls = 0
    const received: any[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      if (url.endsWith('/chat/stream')) streamCalls++
      // First attempt closes at EOF with NO `done` (simulates a sidecar crash);
      // second attempt is a normal, complete stream.
      if (streamCalls === 1) return makeStreamResponse([{ kind: 'text', content: 'partial' }])
      return makeStreamResponse([{ kind: 'text', content: 'rest' }, { kind: 'done' }])
    }
    await streamChat(baseParams, (e) => received.push(e))
    check('۷) استریم بدون done باعث reconnect می‌شود', streamCalls === 2, streamCalls)
    check('۷) پس از reconnect استریم کامل رسید', received.some((e) => e.kind === 'done'), received)
  }

  if (failed > 0) {
    console.error(`\n${failed} تست شکست خورد ❌`)
    process.exit(1)
  }
  console.log('\nهمه تستها پاس شدند ✅')
  process.exit(0)
}

run()
