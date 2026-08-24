// Test for transcribeAudio in src/lib/api.ts.
// When the sidecar returns a 500 with a `detail` message, the client must throw
// that exact detail (so the user sees the real server error, e.g.
// "transcription failed: <exc>") rather than a generic "transcription failed (500)".
// Run: npx esbuild test/transcribe.test.ts --bundle --platform=node --format=esm \
//        --packages=external --external:electron --outfile=test/.tmp-tr.mjs \
//        && node test/.tmp-tr.mjs

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// Minimal sidecar wiring so ensureSidecar resolves a URL without touching the
// real Electron runtime.
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

// fetch mock: /health always succeeds; /transcribe returns the configured
// response so we can exercise the 500 + detail path.
let transcribeResponse: { ok: boolean; status: number; detail?: string } = {
  ok: true,
  status: 200,
}
;(globalThis as any).fetch = async (url: string) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/transcribe')) {
    return {
      ok: transcribeResponse.ok,
      status: transcribeResponse.status,
      json: async () => ({ detail: transcribeResponse.detail }),
    } as any
  }
  return new Response('', { status: 200 })
}

const { transcribeAudio } = await import('../src/lib/api.ts')

console.log('۱) سرور ۵۰۰ با detail برمیگرداند → همان detail throw میشود:')
{
  transcribeResponse = { ok: false, status: 500, detail: 'transcription failed: boom' }
  let thrown: unknown = null
  try {
    await transcribeAudio(new Blob(), () => {})
  } catch (err) {
    thrown = err
  }
  check(
    'خطا پیام detail را دارد',
    thrown instanceof Error && thrown.message === 'transcription failed: boom',
    thrown,
  )
}

console.log('۲) سرور ۵۰۰ بدون detail → پیام fallback با کد وضعیت:')
{
  transcribeResponse = { ok: false, status: 500 }
  let thrown: unknown = null
  try {
    await transcribeAudio(new Blob(), () => {})
  } catch (err) {
    thrown = err
  }
  check(
    'خطا پیام fallback (transcription failed (500)) را دارد',
    thrown instanceof Error && thrown.message === 'transcription failed (500)',
    thrown,
  )
}

console.log('۳) سرور ۲۰۰ با متن → متن برمیگردد:')
{
  transcribeResponse = { ok: true, status: 200 }
  // Override the /transcribe response to include the text payload.
  ;(globalThis as any).fetch = async (url: string) => {
    if (url.endsWith('/health')) return new Response('', { status: 200 })
    if (url.endsWith('/transcribe')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'hello world' }),
      } as any
    }
    return new Response('', { status: 200 })
  }
  const text = await transcribeAudio(new Blob(), () => {})
  check('متن برگشتی صحیح است', text === 'hello world', text)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای transcribe پاس شدند')
