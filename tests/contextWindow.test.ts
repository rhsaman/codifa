// Test for the per-model context-window fix in src/lib/api.ts:
// streamChat must send the PER-MODEL window (contextMap[model] first, then the
// provider-wide fallback) as context_window — NOT provider.contextWindow alone.
// Before the fix, a provider whose contextMap[model] was smaller than its
// contextWindow made the frontend meter exceed 100% while the backend (which
// only received the provider-wide window) never compacted.
// Run: npx esbuild test/contextWindow.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-cw.mjs --external:electron \
//        && node test/.tmp-cw.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => 'http://127.0.0.1:8899',
    onSidecarChanged: () => {},
    onSidecarDead: () => {},
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// Capture the /chat/stream request body; answer with a one-frame SSE stream so
// streamChat finishes without needing a real sidecar.
const sent: Array<{ body: Record<string, any> }> = []
;(globalThis as any).fetch = async (_url: string, init: RequestInit) => {
  sent.push({ body: JSON.parse(String(init.body)) })
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"kind":"done"}\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const { streamChat } = await import('../src/lib/api.ts')

const params = (provider: any) => ({
  provider,
  root: '/tmp/ws',
  mode: 'ask' as const,
  prompt: 'hello',
  chatId: 'c1',
  history: [],
  maxHistory: 10,
})

async function sentBody(provider: any): Promise<Record<string, any>> {
  sent.length = 0
  await streamChat(params(provider) as any, () => {})
  if (!sent[0]) throw new Error('no request captured')
  return sent[0].body
}

console.log('1) contextMap[model] کوچکتر از contextWindow پرووایدر → پنجرهٔ مدل فرستاده میشود (باگ اصلی):')
{
  const body = await sentBody({
    id: 'openai',
    kind: 'openai',
    apiKey: 'k',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    contextMap: { 'gpt-4o': 128000 },
    contextWindow: 200000,
  })
  check('context_window = 128000 (پنجرهٔ مدل، نه 200000 پرووایدر)', body.context_window === 128000, body)
}

console.log('2) بدون contextMap → مدل ناشناخته، context_window صفر (بکاند از کاتالوگ models.dev حل میکند):')
{
  const body = await sentBody({
    id: 'openai',
    kind: 'openai',
    apiKey: 'k',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    contextWindow: 200000,
  })
  check('context_window = 0 (fallback به provider.contextWindow حذف شده)', body.context_window === 0, body)
}

console.log('3) نه contextMap نه contextWindow → صفر (بکاند از کاتالوگ models.dev حل میکند):')
{
  const body = await sentBody({
    id: 'openai',
    kind: 'openai',
    apiKey: 'k',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  })
  check('context_window = 0', body.context_window === 0, body)
}

console.log('4) کلید پیشونددار id/model (NVIDIA /models فرم پیشوندی برمیگرداند):')
{
  const body = await sentBody({
    id: 'nvidia',
    kind: 'openai',
    apiKey: 'k',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'deepseek-ai/deepseek-v3',
    contextMap: { 'nvidia/deepseek-ai/deepseek-v3': 64000 },
    contextWindow: 131072,
  })
  check('context_window = 64000 (از کلید پیشوندی)', body.context_window === 64000, body)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای context_window پاس شدند')
