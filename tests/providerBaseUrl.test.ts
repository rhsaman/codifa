// Regression lock for the "cloudflare: missing account id" report.
//
// Cloudflare's catalog and chat endpoint are BOTH account-scoped, so the account
// id must come from the user. The row used to carry a read-only hint holding the
// literal `.../accounts/{account}/ai/v1` template — an input no user could ever
// fill in — and then an editable base URL, which asked the user to assemble a URL
// by hand and broke every request when they left it half-typed.
//
// This test pins the current contract: the id has its OWN field, the row's base
// URL is BUILT from it (never a half-filled template, never a broken URL), and an
// older row — which could only carry the id inside the URL — is migrated to that
// field once, keeping every request working.
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

// A real base64 key so the store's persistence path (AES-GCM) runs for real
// instead of rejecting on "encryption key unavailable".
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

const { providerMeta, PROVIDER_META, accountScopedBaseUrl, isAccountScoped } = await import(
  '../src/lib/provider-meta.ts'
)
const { useStore } = await import('../src/lib/store.ts')

const CLIENT = 'https://api.cloudflare.com/client/v4/accounts'

// `addProvider` builds its id from a timestamp, so rows created inside the same
// millisecond collide and `updateProvider` would then patch both. The test keeps
// its rows explicit: add one, use it, drop it — one live row at a time.
function withRow(patch: Record<string, unknown>, body: (id: string) => void): void {
  const store = useStore.getState()
  const id = store.addProvider()
  store.updateProvider(id, patch as never)
  try {
    body(id)
  } finally {
    useStore.getState().removeProvider(id)
  }
}
const rowById = (id: string) => useStore.getState().settings.providers.find((x) => x.id === id)

console.log('۱) متادیتای cloudflare یک اکانت‌اسکوپ است و id را در فیلد خودش می‌خواهد:')
{
  const meta = providerMeta('cloudflare')
  assert('اکانت‌اسکوپ تشخیص داده می‌شود', isAccountScoped('cloudflare') === true)
  assert('پروایدرهای معمولی اکانت‌اسکوپ نیستند', isAccountScoped('nvidia') === false)
  assert(
    'هیچ baseUrl پیش‌فرضِ نیمه‌پُری ثبت نشده (قالب غیرقابل‌تکمیل {account} حذف است)',
    !meta.defaultBaseUrl || !meta.defaultBaseUrl.includes('{'),
  )
  assert(
    'راهنمای Account ID متن راهنما دارد',
    (meta.accountIdHint ?? '').length > 0,
  )
  assert(
    'قالب endpoint در رجیستری هر دو سگمنت را دارد',
    (meta.accountScopedBaseUrl ?? '').includes('{account}') &&
      (meta.accountScopedBaseUrl ?? '').includes('/ai/'),
  )
}

console.log('\n۲) endpoint از روی id ساخته می‌شود — نه از روی متن تایپ‌شده:')
{
  assert(
    'id درست → endpoint کامل',
    accountScopedBaseUrl('cloudflare', 'abc123') === `${CLIENT}/abc123/ai/v1`,
  )
  assert(
    'یک URL کامل که کاربر paste کرده هم پذیرفته می‌شود (id استخراج می‌شود)',
    accountScopedBaseUrl('cloudflare', `${CLIENT}/abc123/ai/v1`) === `${CLIENT}/abc123/ai/v1`,
  )
  for (const bad of ['', '   ', '{account}', `${CLIENT}/{account}/ai/v1`, 'abc/123', 'a b']) {
    assert(
      `id نامعتبر ${JSON.stringify(bad)} → endpoint خالی (هیچ URL خرابی ساخته نمی‌شود)`,
      accountScopedBaseUrl('cloudflare', bad) === '',
    )
  }
  assert(
    'پروایدر اکانت‌اسکوپ‌نشده دست‌نخورده می‌ماند',
    accountScopedBaseUrl('nvidia', 'x') === undefined,
  )
}

console.log('\n۳) ردیف store دقیقاً همان endpoint را نگه می‌دارد (models/chat/credits یکی را می‌بینند):')
{
  withRow({ kind: 'cloudflare', accountId: 'abc123' }, (id) => {
    assert('baseUrl از id ساخته شد', rowById(id)?.baseUrl === `${CLIENT}/abc123/ai/v1`)
    assert('فیلد accountId حفظ شد', rowById(id)?.accountId === 'abc123')

    // Clearing the id in the FORM clears both (the form sets baseUrl from the id),
    // so a Cloudflare row with no id has no endpoint at all.
    useStore.getState().updateProvider(id, { accountId: '', baseUrl: '' })
    assert('بدون id هیچ URL خرابی ساخته نمی‌شود', rowById(id)?.baseUrl === '')
    assert('قالب {account} هرگز به baseUrl نمی‌رسد', !(rowById(id)?.baseUrl ?? '').includes('{'))

    // Back-compat: an id that is still recoverable from the row's own URL wins,
    // so a legacy row keeps working even before the user touches the new field.
    useStore.getState().updateProvider(id, { baseUrl: `${CLIENT}/abc123/ai/v1` })
    assert('id از URL موجود بازیابی می‌شود', rowById(id)?.accountId === 'abc123')
  })
}

console.log('\n۴) مهاجرت: ردیف قدیمی که id را فقط در URL داشت، یک‌بار منتقل می‌شود:')
{
  // A legacy row could only carry the id inside its URL: it is recovered once,
  // and the row keeps the very same working endpoint.
  const legacy = `${CLIENT}/legacyID123/ai/v1`
  withRow({ kind: 'cloudflare', baseUrl: legacy }, (id) => {
    assert('id از URL قدیمی استخراج شد', rowById(id)?.accountId === 'legacyID123')
    assert('baseUrl همان URL معتبر ماند (هیچ درخواستی نمی‌شکند)', rowById(id)?.baseUrl === legacy)
  })

  // The unexpanded template is not an id: that row gets an empty endpoint, and
  // the UI reports "enter the account id first" instead of a bogus key error.
  withRow({ kind: 'cloudflare', baseUrl: `${CLIENT}/{account}/ai/v1` }, (id) => {
    assert(
      'قالب غیرقابل‌تکمیل نه id می‌شود نه URL',
      rowById(id)?.accountId === '' && rowById(id)?.baseUrl === '',
    )
  })

  // A non-scoped provider keeps the user's own base URL untouched.
  withRow({ kind: 'custom', baseUrl: 'http://localhost:8080/v1' }, (id) => {
    assert('baseUrl پروایدر معمولی دست‌نخورده می‌ماند', rowById(id)?.baseUrl === 'http://localhost:8080/v1')
  })

  assert(
    'رجیستری هیچ kind دیگری اکانت‌اسکوپ نیست',
    Object.values(PROVIDER_META).filter((m) => m.accountScopedBaseUrl).length === 1,
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
