// Deterministic proof that a model's context capacity survives the WHOLE
// persistence round-trip: the fetch writes it, settings encryption writes it to
// disk, and the loader reads the SAME number back to the meter.
//
// The product rule for capacity is **models.dev → the provider's metadata →
// 200k**, applied once at fetch time (`mergeContextMap`) so every stored model
// carries a number. This test locks the last leg of that chain — the part that
// was previously asserted only by reading code: encryption keeps every
// non-secret field, and normalization does not drop the maps.
//
// No Tauri needed: `window.coder.secretsGetKey` is stubbed with a real 32-byte
// base64 key, so the actual AES-GCM path runs.
import './_globals.ts'

let pass = 0
let fail = 0
function assert(name: string, cond: unknown): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

// A real AES-GCM key, base64-encoded exactly like the sidecar returns it, so
// `getKey()` imports a genuine CryptoKey and encryption is not skipped.
//
// `_globals.ts` installs a catch-all Proxy whose `get` ignores the target, so a
// plain property assignment would be shadowed. Replace the whole bridge with a
// Proxy that answers `secretsGetKey` for real and keeps the inert default for
// every other method the store touches at import time.
const KEY = '0123456789abcdef0123456789abcdef'
;(globalThis as any).window.coder = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      if (prop === 'secretsGetKey') return async () => btoa(KEY)
      return async () => ({ ok: true, data: null })
    },
  },
)

const { encryptSettings, decryptSettings } = await import('../src/lib/secrets.ts')
const { useStore } = await import('../src/lib/store.ts')
const { modelContextWindow, DEFAULT_CONTEXT_WINDOW } = await import('../src/lib/context.ts')
const { mergeContextMap } = await import('../src/lib/provider-fetch.ts')

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) فچ ظرفیت را با هر مدل ذخیره می‌کند (models.dev → پروایدر → ۲۰۰ هزار):')
{
  const p = {
    id: 'acme',
    name: 'Acme',
    kind: 'custom',
    apiKey: '',
    apiKeys: ['sk-secret'],
    baseUrl: 'https://acme.test/v1',
    model: 'big-1m',
    models: [],
  } as any

  // What the backend /models returned: two real windows, one model unreported.
  const contextMap = mergeContextMap(
    p,
    ['big-1m', 'mid-200k', 'unknown-model'],
    { 'big-1m': 1_000_000, 'mid-200k': 200_000 },
    undefined,
  )

  assert('مدل ۱ میلیونی با ظرفیت واقعی ذخیره شد', contextMap['big-1m'] === 1_000_000)
  assert('مدل ۲۰۰ هزارتایی با ظرفیت واقعی ذخیره شد', contextMap['mid-200k'] === 200_000)
  assert(
    'مدلی که پروایدر گزارش نکرد دیفالت ۲۰۰ هزار گرفت (نه بی‌ظرفیت)',
    contextMap['unknown-model'] === DEFAULT_CONTEXT_WINDOW,
  )

  // ── the real persistence chain ────────────────────────────────────────────
  const settings = {
    providers: [{ ...p, contextMap }],
    activeProviderId: 'acme',
  } as any

  // 1. What the store hands the writer (encrypted), then 2. what actually lands
  //    on disk as JSON.
  const encrypted = await encryptSettings(settings)
  const onDisk = JSON.parse(JSON.stringify(encrypted))

  assert(
    'کلید API روی دیسک رمز شده (اثبات اینکه مسیر رمزنگاری واقعاً اجرا شد)',
    typeof onDisk.providers[0].apiKeys[0] === 'string' &&
      onDisk.providers[0].apiKeys[0].startsWith('enc:v1:'),
  )
  assert(
    'contextMap روی دیسک به‌صورت عدد خام مانده (رمزنگاری فیلد غیرسری را دست نزد)',
    onDisk.providers[0].contextMap['big-1m'] === 1_000_000 &&
      onDisk.providers[0].contextMap['unknown-model'] === DEFAULT_CONTEXT_WINDOW,
  )

  // 3. Read back through the loader's decryption.
  const loaded = await decryptSettings(onDisk)
  const restored = loaded.providers[0] as any
  assert('کلید API بعد از خواندن به متن اصلی برگشت', restored.apiKeys[0] === 'sk-secret')
  assert(
    'ظرفیت هر سه مدل بعد از رفت‌وبرگشت دیسک دست‌نخورده است',
    JSON.stringify(restored.contextMap) === JSON.stringify(contextMap),
  )

  // 4. The meter reads that exact stored number — not a fallback guess.
  assert('متر مدل ۱ میلیونی همان ۱٬۰۰۰٬۰۰۰ را می‌خواند', modelContextWindow(restored, 'big-1m') === 1_000_000)
  assert('متر مدل ۲۰۰ هزارتایی همان ۲۰۰٬۰۰۰ را می‌خواند', modelContextWindow(restored, 'mid-200k') === 200_000)
  assert(
    'متر مدل ناشناخته به دیفالت ۲۰۰ هزار می‌افتد',
    modelContextWindow(restored, 'unknown-model') === DEFAULT_CONTEXT_WINDOW,
  )
  assert(
    'مدل ۱ میلیونی به دیفالت برنگشته (باگ کامپکت زودهنگام)',
    modelContextWindow(restored, 'big-1m') !== DEFAULT_CONTEXT_WINDOW,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n۲) نرمال‌سازی store (normalizeProvider) نقشهٔ ظرفیت را حذف نمی‌کند:')
{
  const st = useStore.getState()
  const id = st.settings.providers[0].id
  const contextMap = {
    'big-1m': 1_000_000,
    'mid-200k': 200_000,
    'unknown-model': DEFAULT_CONTEXT_WINDOW,
  }
  // `updateProvider` is the public path that runs the private normalizeProvider.
  useStore.getState().updateProvider(id, { contextMap })

  const p = useStore.getState().settings.providers.find((x) => x.id === id) as any
  assert('contextMap بعد از نرمال‌سازی سرجایش است', p?.contextMap?.['big-1m'] === 1_000_000)
  assert(
    'هر سه مدل بعد از نرمال‌سازی ظرفیت دارند',
    p?.contextMap?.['big-1m'] === 1_000_000 &&
      p?.contextMap?.['mid-200k'] === 200_000 &&
      p?.contextMap?.['unknown-model'] === DEFAULT_CONTEXT_WINDOW,
  )
  assert('متر بعد از نرمال‌سازی همان عدد را می‌دهد', modelContextWindow(p, 'big-1m') === 1_000_000)
  assert(
    'مقدار دستی کاربر بر ظرفیت ذخیره‌شده اولویت دارد',
    modelContextWindow({ id: 'acme', contextMap: { m: 128_000 }, manualContextMap: { m: 32_000 } }, 'm') === 32_000,
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
