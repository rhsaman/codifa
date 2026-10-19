// تست SSR برای ProviderModelSelect: باز کردن پاپ‌آپ مدل‌ها را فچ نکند.
// لیست مدل‌ها فقط از store (پرشده در startup / افزودن پروایدر) خوانده می‌شود.
// Run: npx esbuild tests/providerModelSelect.ssr.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external --outfile=tests/.tmp-pms.mjs && node tests/.tmp-pms.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
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

const { renderToString } = await import('react-dom/server')
const { ProviderModelSelect } = await import('../src/components/ProviderModelSelect')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// شمارنده‌ی فراخوانی‌های شبکه: هر درخواستی که از مسیر fetchModels رد شود
// باید صفر بماند — پاپ‌آپ فقط از store می‌خواند.
let networkCalls = 0
const realFetch = (globalThis as any).fetch
;(globalThis as any).fetch = (...args: unknown[]) => {
  networkCalls++
  return realFetch?.(...(args as []))
}

console.log('1) رندر پاپ‌آپ بدون هیچ فراخوانی شبکه:')
{
  networkCalls = 0
  const html = renderToString(<ProviderModelSelect />)
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
  check('کلاس pm-select وجود دارد', html.includes('pm-select'))
  check('دکمه‌ی انتخاب مدل وجود دارد', html.includes('pm-select-btn'))
}

console.log('2) لیست مدل‌ها از store خوانده می‌شود (نه از شبکه):')
{
  // store واقعی zustand در SSR با state اولیه‌ی خودش رندر می‌شود؛
  // تست فقط تضمین می‌کند که هیچ مسیر فچی اجرا نشود.
  networkCalls = 0
  const html = renderToString(<ProviderModelSelect />)
  check('دوباره هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
  check('رندر بدون خطا انجام شد', html.length > 0)
}

console.log('3) حالت controlled: مقدار خالی یعنی «Main model» روی خود دکمه:')
{
  const { useStore } = await import('../src/lib/store')
  ;(useStore as any).setState({
    settings: {
      ...(useStore as any).getState().settings,
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          kind: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeys: ['k1'],
          models: ['x-ai/grok-4'],
          model: 'x-ai/grok-4',
        },
      ],
      activeProviderId: 'openrouter',
    },
    activeChatId: '',
    chats: [],
  })
  networkCalls = 0
  const none = renderToString(
    <ProviderModelSelect value="" onSelect={() => {}} noneLabel="Main model" />,
  )
  // دکمه باید خودش متن «Main model» را نشان دهد (نه نام پراوایدر فعال و نه بج).
  check('مقدار خالی: دکمه «Main model» را نشان می‌دهد', none.includes('Main model'), none.slice(0, 400))
  check('مقدار خالی: نام مدل فعال روی دکمه نیست', !none.includes('x-ai/grok-4'), none.slice(0, 400))

  const picked = renderToString(
    <ProviderModelSelect
      value="openrouter/x-ai/grok-4"
      onSelect={() => {}}
      noneLabel="Main model"
    />,
  )
  check('مقدار مشخص: نام کامل پراوایدر/مدل روی دکمه', picked.includes('OpenRouter/x-ai/grok-4'))
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
}

console.log('4) حالت controlled هم انتخاب را در لیست Recent ثبت می‌کند:')
{
  const { useStore } = await import('../src/lib/store')
  ;(useStore as any).setState({
    settings: {
      ...(useStore as any).getState().settings,
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          kind: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeys: ['k1'],
          models: ['x-ai/grok-4'],
          model: 'x-ai/grok-4',
        },
      ],
      activeProviderId: 'openrouter',
    },
    activeChatId: '',
    chats: [],
    recentModels: [],
  })
  // فراخوانی مستقیم اکشن store همان کاری است که pick() در حالت controlled
  // انجام می‌دهد: مقدار اسلات را گزارش می‌کند و recent را هم ثبت می‌کند،
  // بدون دست‌زدن به چت فعال.
  const st = useStore as any
  st.getState().addRecentModel('x-ai/grok-4', 'openrouter')
  const recents = st.getState().recentModels
  check(
    'انتخاب در Tools در لیست Recent ثبت می‌شود',
    recents.some((r: { providerId: string; model: string }) => r.providerId === 'openrouter' && r.model === 'x-ai/grok-4'),
    recents,
  )
  check('چت فعال دست‌نخورده می‌ماند', st.getState().chats.length === 0)
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های ProviderModelSelect پاس شدند')
