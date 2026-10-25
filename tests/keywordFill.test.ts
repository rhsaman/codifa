// Unit test for `fillMissingKeywords` (src/lib/plugins.ts).
//
// Why it matters: a plugin installed from a marketplace ships English
// descriptions, and the skill catalog is matched by Persian KEYWORD — so a
// freshly installed bundle used to be unreachable from a Persian request until
// its owner opened the detail page and clicked Translate. The install paths now
// run this automatically, which makes three things load-bearing:
//   1. only skills with NO keywords of their own are touched (a list the repo
//      shipped, or the user typed, must never be overwritten),
//   2. the whole batch is ONE model call (26 skills must not cost 26 calls),
//   3. a failure leaves every file as it was and reports WHY.
//
// Run: npx esbuild tests/keywordFill.test.ts --bundle --platform=node \
//        --format=esm --packages=external --external:electron --outfile=.tmp.mjs \
//      && node .tmp.mjs

let calls: Array<{ url: string; body: any }> = []
let keywordsReply: { status: number; body: unknown } = { status: 200, body: { keywords: {} } }

const SKILLS = {
  skills: [
    {
      name: 'Access',
      slug: 'access',
      description: 'Manage channel access',
      path: 'a',
      content: '',
      fa_keywords: [],
      plugin: 'Telegram',
      plugin_slug: 'telegram',
      plugin_enabled: true,
    },
    {
      name: 'Shipped',
      slug: 'shipped',
      description: 'Comes with its own phrases',
      path: 'b',
      content: '',
      fa_keywords: ['پیام', 'ارتباطات'],
      plugin: 'Telegram',
      plugin_slug: 'telegram',
      plugin_enabled: true,
    },
    {
      name: 'NoDescription',
      slug: 'nodesc',
      description: '',
      path: 'c',
      content: '',
      fa_keywords: [],
      plugin: 'Telegram',
      plugin_slug: 'telegram',
      plugin_enabled: true,
    },
    {
      name: 'OtherBundle',
      slug: 'other',
      description: 'A skill of a DIFFERENT bundle',
      path: 'd',
      content: '',
      fa_keywords: [],
      plugin: 'Docker',
      plugin_slug: 'docker',
      plugin_enabled: true,
    },
  ],
}

;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  location: { href: 'http://localhost/' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { addEventListener: () => {}, removeEventListener: () => {} },
  // The store (imported by keywordFill.ts) wires a dozen bridge calls at module
  // load. Any method it reaches for answers a harmless value instead of throwing
  // "not a function" — the test is about the fill logic, not the bridge.
  coder: new Proxy(
    {
      getSidecarUrl: async () => 'http://127.0.0.1:8899',
      onSidecarChanged: () => () => {},
      onSidecarDead: () => () => {},
    },
    {
      get: (target: Record<string, unknown>, key: string) =>
        key in target ? target[key] : () => () => {},
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

;(globalThis as any).fetch = async (url: string, init?: any) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  const body = init?.body ? JSON.parse(init.body) : undefined
  calls.push({ url, body })
  if (url.includes('/plugins/keywords')) {
    return new Response(JSON.stringify(keywordsReply.body), { status: keywordsReply.status })
  }
  if (url.includes('/plugins/skills')) {
    return new Response(JSON.stringify(SKILLS), { status: 200 })
  }
  if (url.includes('/skills/sync')) {
    return new Response(JSON.stringify({ ok: true, name: body?.name }), { status: 200 })
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}

let failures = 0
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (extra !== undefined) console.log('     got:', JSON.stringify(extra))
  }
}

const { fillMissingKeywords } = await import('../src/lib/plugins.ts')
const { fillKeywordsFromToolResult, pluginSlugFromReply } = await import(
  '../src/lib/keywordFill.ts'
)
const { useStore } = await import('../src/lib/store.ts')

const provider = {
  id: 'p1',
  name: 'P1',
  kind: 'openrouter' as const,
  model: 'm',
  baseUrl: 'https://x/v1',
  apiKeys: [],
}

export {}

console.log('۱) فقط اسکیل‌های بی‌کلیدواژهٔ همین باندل ترجمه و نوشته می‌شوند:')
{
  calls = []
  keywordsReply = { status: 200, body: { keywords: { Access: ['دسترسی', 'مدیریت دسترسی'] } } }
  const out = await fillMissingKeywords('telegram', { provider })
  check('فقط یک اسکیل نامزد بود (بی‌کلیدواژه، توضیح‌دار، همین باندل)', out.total === 1, out)
  check('یکی نوشته شد', out.filled === 1, out)
  check('خطایی نبود', out.error === undefined, out)
  const kwCall = calls.find((c) => c.url.includes('/plugins/keywords'))
  check('فقط یک فراخوانی مدل شد', calls.filter((c) => c.url.includes('/plugins/keywords')).length === 1)
  check(
    'اسکیل کلیدواژه‌دار و اسکیل باندل دیگر به مدل فرستاده نشدند',
    !kwCall?.body.items.some((i: any) => i.name === 'Shipped' || i.name === 'OtherBundle'),
    kwCall?.body.items,
  )
  const writes = calls.filter((c) => c.url.includes('/skills/sync'))
  check('فقط یک نوشتن شد', writes.length === 1, writes.map((w) => w.body.name))
  check('نوشتن بدون content است (بدنهٔ فایل دست‌نخورده)', writes[0]?.body.content === '', writes[0]?.body)
  check('باندل درست هدف گرفته شد', writes[0]?.body.plugin === 'telegram', writes[0]?.body)
  check('عبارت‌ها به‌صورت لیست رفتند', Array.isArray(writes[0]?.body.fa_keywords), writes[0]?.body.fa_keywords)
}

console.log('۲) باندلی که اسکیل بی‌کلیدواژه ندارد هیچ فراخوانی مدل نمی‌کند:')
{
  calls = []
  const out = await fillMissingKeywords('nothing-here', { provider })
  check('هیچ چیز نامزد نبود', out.total === 0 && out.filled === 0, out)
  check('فقط فهرست خوانده شد، ترجمه‌ای نرفت', calls.filter((c) => c.url.includes('/plugins/keywords')).length === 0, calls.map((c) => c.url))
}

console.log('۳) شکست ترجمه: فایل‌ها دست‌نخورده و دلیل گزارش می‌شود:')
{
  calls = []
  keywordsReply = { status: 200, body: { keywords: {}, error: 'key rejected (429)' } }
  const out = await fillMissingKeywords('telegram', { provider })
  check('چیزی نوشته نشد', out.filled === 0, out)
  check('دلیل واقعی گزارش شد', out.error === 'key rejected (429)', out)
  check('هیچ نوشتنی رخ نداد', calls.filter((c) => c.url.includes('/skills/sync')).length === 0)
}

console.log('۴) بدون provider هیچ فراخوانی‌ای نمی‌شود:')
{
  calls = []
  const out = await fillMissingKeywords('telegram', { provider: undefined })
  check('دلیل گفته شد', !!out.error, out)
  check('هیچ درخواستی نرفت', calls.length === 0, calls.map((c) => c.url))
}

console.log('۵) پاسخ ابزار plugin: slug از خط اول خوانده می‌شود، حتی با WARNING بعدش:')
{
  const wrote = JSON.stringify({ slug: 'telegram', skills: ['Access'] })
  check('بدون هشدار', pluginSlugFromReply(wrote) === 'telegram', pluginSlugFromReply(wrote))
  check(
    'با خط WARNING بعدش هم درست است',
    pluginSlugFromReply(`${wrote}\nWARNING: these skills have NO fa_keywords`) === 'telegram',
  )
  check('پاسخ list (بدون slug) → null', pluginSlugFromReply('[]') === null)
  check('خطای متنی → null', pluginSlugFromReply('plugin not found: x') === null)
}

console.log('۶) تنها اکشن‌های نویسنده پر می‌کنند و باندل تکراری یک‌بار:')
{
  const wrote = JSON.stringify({ slug: 'telegram' })
  calls = []
  const listed = await fillKeywordsFromToolResult('list', wrote)
  check('action=list هیچ کاری نمی‌کند', listed === null && calls.length === 0, calls.map((c) => c.url))

  calls = []
  const bad = await fillKeywordsFromToolResult('update', 'not json')
  check('پاسخ غیر-JSON → null', bad === null, bad)

  // `fillKeywordsAfterInstall` reads the provider from the STORE (one caller is a
  // chat handler), so the store has to hold one for the call to go out.
  useStore.setState({
    settings: { ...useStore.getState().settings, providers: [provider], activeProviderId: provider.id },
  })
  calls = []
  keywordsReply = { status: 200, body: { keywords: { Access: ['دسترسی'] } } }
  const create = await fillKeywordsFromToolResult('create', wrote)
  check('action=create پر می‌کند', create !== null && create.filled === 1, create)
  check('فراخوانی مدل انجام شد', calls.some((c) => c.url.includes('/plugins/keywords')), calls.map((c) => c.url))

  // Two writes of the SAME slug in one turn must not translate twice.
  calls = []
  const [a, b] = await Promise.all([
    fillKeywordsFromToolResult('update', wrote),
    fillKeywordsFromToolResult('install', wrote),
  ])
  check(
    'دو نوشتن همزمان یک باندل → یک فراخوانی',
    calls.filter((c) => c.url.includes('/plugins/keywords')).length === 1,
    { a, b, calls: calls.map((c) => c.url) },
  )
}

console.log(failures === 0 ? '\nهمهٔ بررسی‌ها سبز.' : `\n${failures} بررسی شکست خورد.`)
process.exit(failures === 0 ? 0 : 1)
