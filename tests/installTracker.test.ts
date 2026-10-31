// Unit tests for the marketplace install registry and the late-install
// recovery (src/lib/plugins.ts).
//
// Why it matters: the Marketplaces editor unmounts on every tab switch, and its
// component-local "Installing…" died with it — a running install came back
// looking cancelled (the reported "my download was cancelled") and one busy
// STRING let a second install blank the first's indicator. The registry is
// module-level and per-address now. And because the webview cuts a request that
// hears no bytes for ~60s while the backend's blocking install keeps running, a
// dropped connection is no longer reported as a failure: the plugin list is
// polled for the bundle landing first.
//
// Run: npx esbuild tests/installTracker.test.ts --bundle --platform=node \
//        --format=esm --packages=external --external:electron --outfile=.tmp-it.mjs \
//      && node .tmp-it.mjs

;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  location: { href: 'http://localhost/' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { addEventListener: () => {}, removeEventListener: () => {} },
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

type Gate = () => Promise<Response>
/** Repo → a deferred /plugins/install reply, set per test. */
let installGates = new Map<string, Gate>()
/** What GET /plugins answers while the late-install watch polls. */
let pluginList: Array<Record<string, unknown>> = []
const SKILL_ROWS = [
  { name: 'Docx', slug: 'docx', plugin_slug: 'slow-bundle' },
  { name: 'Xlsx', slug: 'xlsx', plugin_slug: 'slow-bundle' },
  { name: 'Other', slug: 'other', plugin_slug: 'other-bundle' },
]
const CONNECTOR_ROWS = [
  { name: 'docs', cfg: {}, plugin_slug: 'slow-bundle' },
]

;(globalThis as any).fetch = async (url: string, init?: any) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/plugins/install')) {
    const body = init?.body ? JSON.parse(init.body) : undefined
    const gate = installGates.get(body?.repo)
    if (gate) return gate()
    return new Response(
      JSON.stringify({ installed: 'created', slug: 'quick', skills: [], mcp: [] }),
      { status: 200 },
    )
  }
  if (url.endsWith('/plugins/skills')) return new Response(JSON.stringify({ skills: SKILL_ROWS }), { status: 200 })
  if (url.endsWith('/plugins/mcp')) return new Response(JSON.stringify({ connectors: CONNECTOR_ROWS }), { status: 200 })
  if (url.endsWith('/plugins')) return new Response(JSON.stringify({ plugins: pluginList }), { status: 200 })
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
const tick = () => new Promise((r) => setTimeout(r, 5))

const {
  installPlugin,
  isRowInstalling,
  subscribeInstallChanges,
  installStateVersion,
  marketKey,
  _setLateInstallTimingForTests,
} = await import('../src/lib/plugins.ts')

export {}

console.log('۱) رجیستری چند نصب همزمان را جدا نگه می‌دارد و بعد از پایان تخلیه می‌شود:')
{
  installGates = new Map()
  let notifications = 0
  const unsubscribe = subscribeInstallChanges(() => {
    notifications++
  })
  const startVersion = installStateVersion()
  // Two gated installs: neither can finish until its gate opens.
  let releaseOne: (v: Response) => void = () => {}
  let releaseTwo: (v: Response) => void = () => {}
  installGates.set('o/one', () => new Promise<Response>((r) => (releaseOne = r)))
  installGates.set('o/two', () => new Promise<Response>((r) => (releaseTwo = r)))
  const one = installPlugin({ repo: 'o/one', name: 'One' })
  await tick()
  const two = installPlugin({ repo: 'o/two', name: 'Two' })
  await tick()
  const keyOne = marketKey('o/one')
  const keyTwo = marketKey('o/two')
  check('کلید آدرس، repo|path|ref است', keyOne === 'o/one||', keyOne)
  check('نصب اول در جریان دیده می‌شود', isRowInstalling(keyOne), keyOne)
  check('نصب دوم هم در جریان دیده می‌شود', isRowInstalling(keyTwo), keyTwo)
  releaseOne(new Response(JSON.stringify({ installed: 'created', slug: 'one', skills: [], mcp: [] }), { status: 200 }))
  await one
  await tick()
  check('پایان اول، دومی را کور نمی‌کند', isRowInstalling(keyTwo), keyTwo)
  check('اولی از رجیستری تخلیه شد', !isRowInstalling(keyOne), keyOne)
  releaseTwo(new Response(JSON.stringify({ installed: 'created', slug: 'two', skills: [], mcp: [] }), { status: 200 }))
  await two
  await tick()
  check('دومی هم تخلیه شد', !isRowInstalling(keyTwo), keyTwo)
  check('هر تغییر رجیستری خبر داد', notifications >= 4 && installStateVersion() > startVersion, notifications)
  unsubscribe()
}

console.log('۲) اتصال افتاده ≠ نصب شکست خورده: باندل با تاخیر پیدا می‌شود و موفق گزارش می‌شود:')
{
  installGates = new Map()
  _setLateInstallTimingForTests(15, 2_000)
  // The install request dies mid-flight (the webview's no-data cut), and the
  // bundle lands on the backend a moment later — visible only in the list.
  installGates.set('o/slow', () => Promise.reject(new TypeError('Load failed')))
  pluginList = []
  const appear = setTimeout(() => {
    pluginList = [
      { slug: 'slow-bundle', name: 'Slow', source_repo: 'o/slow', source_path: '', source_ref: '' },
    ]
  }, 60)
  const out = await installPlugin({ repo: 'o/slow', name: 'Slow' })
  clearTimeout(appear)
  check('خطا برگردانده نشد', !('error' in out), out)
  if (!('error' in out)) {
    check('اسلاگ باندل فرودآمده گزارش شد', out.slug === 'slow-bundle', out)
    check('اسکیل‌های همان باندل شمرده شدند', (out.skills ?? []).join(',') === 'Docx,Xlsx', out.skills)
    check('کانکتور همان باندل شمرده شد', (out.mcp ?? []).join(',') === 'docs', out.mcp)
  }
  check('رجیستری بعد از بازیابی تخلیه شد', !isRowInstalling('o/slow||'))
}

console.log('۳) باندلی که هیچ‌وقت فرود نمی‌آید: خطای واقعی + راهنما، و رجیستری تخلیه:')
{
  installGates = new Map()
  _setLateInstallTimingForTests(15, 150)
  installGates.set('o/gone', () => Promise.reject(new TypeError('Load failed')))
  pluginList = []
  const out = await installPlugin({ repo: 'o/gone', name: 'Gone' })
  check('خطا گزارش شد', 'error' in out, out)
  if ('error' in out) {
    check('دلیل واقعی (افت اتصال) داخل پیام است', out.error.includes('Load failed'), out)
    check('راهنمای «شاید هنوز نصب می‌شود» هست', out.error.includes('Plugins tab'), out)
  }
  check('رجیستری تخلیه شد', !isRowInstalling('o/gone||'))
}

if (failures) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll installTracker tests passed')
