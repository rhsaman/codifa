// تست دکمه‌ی «Fetch models» در تب Providers تنظیمات:
// ۱) رندر مودال هیچ فچ خودکاری نمی‌زند (فچ خودکار هنگام افزودن/ویرایش/تعویض
//    پروایدر حذف شد) و دکمه‌ی دستی در تب Providers دیده می‌شود.
// ۲) هندلر fetchProviderModels: دقیقاً یک درخواست /models می‌زند، پیام نتیجه
//    می‌دهد و فرم را تازه می‌کند؛ بدون base URL هیچ درخواستی نمی‌رود و خطای
//    شبکه هم throw نمی‌شود بلکه پیام «Fetch failed» می‌دهد.
// Run: npx esbuild src/components/SettingsModal.fetchModels.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external \
//        --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
//        --outfile=tests/.tmp-sfm.mjs --external:electron && node tests/.tmp-sfm.mjs

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// پنجره/سایدکار جعلی — الگوی tests/settingsNoFetch.ssr.test.tsx + modelTest:
// getSidecarUrl آدرس می‌دهد تا fetchModels به fetch برسد و بشود شمارش کرد.
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        if (prop === 'getSidecarUrl') return async () => 'http://127.0.0.1:8899'
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { renderToString } = await import('react-dom/server')
const { SettingsModal, fetchProviderModels } = await import('./SettingsModal')
const { useStore } = await import('../lib/store')

// پروایدر هدف در استور تا persist های fetchAndPersist به آن برسد.
const s0 = useStore.getState()
useStore.setState({
  settings: {
    ...s0.settings,
    activeProviderId: 'fetch-btn',
    providers: [
      {
        id: 'fetch-btn',
        name: 'FetchBtn',
        kind: 'custom',
        apiKeys: ['k'],
        baseUrl: 'https://a/v1',
        model: 'old',
        pricingMap: {},
      },
    ],
  },
})

console.log('۱) رندر تب Providers — بدون فچ خودکار + وجود دکمه:')
{
  let networkCalls = 0
  ;(globalThis as any).fetch = async () => {
    networkCalls++
    return new Response('', { status: 200 })
  }
  const html = renderToString(<SettingsModal onClose={() => {}} initialTab="providers" />)
  check('هنگام رندر هیچ درخواست شبکه‌ای نمی‌رود', networkCalls === 0, networkCalls)
  check('دکمه «Fetch models» در تب Providers رندر شده', html.includes('Fetch models'))

  // SSR از اجرای useEffect جلوگیری می‌کند، پس حذف فچ خودکار را در همان سورس
  // قفل می‌کنیم: dependency array قدیمی effect فچ خودکار باید حذف شده باشد
  // و فراخوانی fetchAndPersist فقط در هندلر دستی (fetchProviderModels) بماند.
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/components/SettingsModal.tsx', 'utf8')
  check(
    'effect فچ خودکار قدیمی حذف شده (dependency array قبلی در سورس نیست)',
    !src.includes('[active.id, cfg.baseUrl, cfg.apiKey, cfg.kind]'),
  )
  const calls = src.split('fetchAndPersist(').length - 1
  check('فراخوانی fetchAndPersist فقط یک بار (هندلر دستی) مانده', calls === 1, calls)
}

console.log('۲) fetchProviderModels — یک درخواست + پیام نتیجه:')
{
  // مرز شبکه: /health همیشه 200، /models شمارش می‌شود و پاسخ کاتالوگ ۲ مدلی
  // برمی‌گرداند؛ failNext برای سناریوی خطای شبکه.
  let modelsCalls = 0
  let failNext = false
  ;(globalThis as any).fetch = async (url: unknown) => {
    const u = String(url)
    if (u.includes('/health')) return new Response('', { status: 200 })
    if (u.includes('/models?')) {
      modelsCalls++
      if (failNext) return new Response('', { status: 500 })
      return new Response(
        JSON.stringify({
          models: [
            { id: 'm1', context: 8192 },
            { id: 'm2', context: 4096 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('', { status: 200 })
  }

  const busy: boolean[] = []
  const msgs: string[] = []
  let refreshed = 0
  await fetchProviderModels(
    { id: 'fetch-btn', name: 'FetchBtn', kind: 'custom', apiKeys: ['k'], baseUrl: 'https://a/v1', model: 'old' } as any,
    {
      setFetching: (b) => busy.push(b),
      setMsg: (m) => msgs.push(m),
      refreshFormModel: () => {
        refreshed++
      },
    },
  )
  check('دقیقاً یک درخواست /models رفت', modelsCalls === 1, modelsCalls)
  check('busy ابتدا true و انتها false شد', busy[0] === true && busy[busy.length - 1] === false, busy)
  check('پیام نتیجه با شمارش مدل‌ها', msgs[msgs.length - 1]?.includes('2 models'), msgs)
  check('فرم بعد از موفقیت یک بار تازه شد', refreshed === 1, refreshed)

  // skip: بدون base URL هیچ درخواستی نمی‌رود و پیام دلیل skip داده می‌شود.
  modelsCalls = 0
  await fetchProviderModels(
    { id: 'fetch-btn', name: 'FetchBtn', kind: 'custom', apiKeys: [], baseUrl: '', model: '' } as any,
    {
      setFetching: () => {},
      setMsg: (m) => msgs.push(m),
      refreshFormModel: () => {
        refreshed++
      },
    },
  )
  check('بدون base URL هیچ درخواستی نمی‌رود', modelsCalls === 0, modelsCalls)
  check('پیام skip نشان داده شد', msgs[msgs.length - 1]?.includes('base URL'), msgs)

  // خطای شبکه: پاسخ 500 → throw نمی‌شود، پیام Fetch failed می‌دهد و فرم تازه نمی‌شود.
  failNext = true
  let threw: unknown = null
  try {
    await fetchProviderModels(
      // baseUrl متفاوت تا کش dedup درخواست‌های همزمان، سناریو را جواب ندهد.
      { id: 'fetch-btn', name: 'FetchBtn', kind: 'custom', apiKeys: ['k'], baseUrl: 'https://b/v1', model: 'old' } as any,
      {
        setFetching: () => {},
        setMsg: (m) => msgs.push(m),
        refreshFormModel: () => {
          refreshed++
        },
      },
    )
  } catch (err) {
    threw = err
  }
  check('خطا throw نمی‌شود', threw === null, threw)
  check('پیام «Fetch failed» نمایش یافت', msgs[msgs.length - 1]?.startsWith('Fetch failed'), msgs)
  check('فرم بعد از خطا تازه نشد', refreshed === 1, refreshed)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های Fetch models پاس شدند')
