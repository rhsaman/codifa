// Store-level test for the new-chat default model + recent-models sorting:
//  - newChat() must start from the most-recently-used model (recentModels[0]),
//    NOT the active provider's default model.
//  - addRecentModel() must keep recentModels sorted most-recent-first, so the
//    model you just picked lands at the top of the recent list (and is the one
//    a freshly created chat inherits).
// Run: npx esbuild test/newChatModel.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-ncm.mjs --external:electron \
//        && node test/.tmp-ncm.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { useStore } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const s0 = useStore.getState()
const activeId = s0.settings.activeProviderId
const activeDefault = s0.settings.providers.find((p) => p.id === activeId)?.model

// هیچ provider پیش‌فرضی نباید model هاردکد داشته باشه — مدل هر provider از
// کاتالوگ واقعی خودش درمیاد (fetchAndPersist → updateProvider).
check(
  'هیچ provider پیشفرضی model هاردکد ندارد',
  s0.settings.providers.every((p) => !p.model),
  s0.settings.providers.map((p) => `${p.id}=${p.model}`).join(', '),
)

console.log('۱) recentModels خالی → newChat از مدل پیشفرض پرووایدر فعال استفاده میکند:')
{
  useStore.setState({ recentModels: [] })
  const id = useStore.getState().newChat('ask')
  const chat = useStore.getState().chats.find((c) => c.id === id)!
  check('مدل = پیشفرض پرووایدر فعال', chat.model === activeDefault, { got: chat.model, want: activeDefault })
  check('providerId = پرووایدر فعال', chat.providerId === activeId, { got: chat.providerId, want: activeId })
}

console.log('۲) recentModels دارد → newChat از مدل اخیر (recentModels[0]) استفاده میکند نه پیشفرض:')
{
  // مدل اخیر متفاوت از پیشفرض پرووایدر فعال، با providerId معتبر
  const recentModel = 'gpt-5.2'
  useStore.setState({
    recentModels: [{ providerId: activeId, model: recentModel, lastUsed: Date.now() }],
  })
  const id = useStore.getState().newChat('ask')
  const chat = useStore.getState().chats.find((c) => c.id === id)!
  check('مدل = مدل اخیر', chat.model === recentModel, { got: chat.model, want: recentModel })
  check('providerId = پرووایدر مدل اخیر', chat.providerId === activeId, { got: chat.providerId, want: activeId })
  check('تست معنادار است (مدل اخیر ≠ پیشفرض)', recentModel !== activeDefault)
}

console.log('۳) انتخاب پشت‌سرهم مدلها → recentModels مرتبِ جدیدترین-اول میماند و newChat جدیدترین را برمیدارد:')
{
  useStore.setState({ recentModels: [] })
  const a = useStore.getState().addRecentModel('model-A', activeId)
  const b = useStore.getState().addRecentModel('model-B', activeId)
  const rm = useStore.getState().recentModels
  check('model-B بالای لیست است (جدیدترین اول)', rm[0]?.model === 'model-B', rm.map((r) => r.model))
  check('model-A زیرش است', rm[1]?.model === 'model-A', rm.map((r) => r.model))
  const id = useStore.getState().newChat('ask')
  const chat = useStore.getState().chats.find((c) => c.id === id)!
  check('newChat مدل جدیدترین (model-B) را برداشت', chat.model === 'model-B', chat.model)
  void a
  void b
}

console.log('۴) دوباره انتخاب کردن یک مدل قدیمی → آن مدل دوباره بالای لیست میرود:')
{
  // ادامهٔ وضعیت سناریو ۳: لیست [model-B, model-A]
  useStore.getState().addRecentModel('model-A', activeId) // انتخاب دوبارهٔ A
  const rm = useStore.getState().recentModels
  check('model-A دوباره بالای لیست است', rm[0]?.model === 'model-A', rm.map((r) => r.model))
  check('model-B پایین رفت', rm[1]?.model === 'model-B', rm.map((r) => r.model))
  const id = useStore.getState().newChat('ask')
  const chat = useStore.getState().chats.find((c) => c.id === id)!
  check('newChat حالا model-A را برمیدارد', chat.model === 'model-A', chat.model)
}

console.log('۵) پین کردن → پین‌شده بالای لیست می‌ماند و سقف ۳ رعایت می‌شود:')
{
  useStore.setState({ recentModels: [] })
  useStore.getState().addRecentModel('model-A', activeId)
  useStore.getState().addRecentModel('model-B', activeId)
  useStore.getState().addRecentModel('model-C', activeId)
  useStore.getState().addRecentModel('model-D', activeId)
  // قدیمی‌ترین (A) را پین کن → باید بالای لیست بیاید حتی با اینکه تازه‌ترین نیست
  check('پین A موفق است', useStore.getState().togglePinRecentModel('model-A', activeId) === true)
  let rm = useStore.getState().recentModels
  check('مدل پین‌شده بالای لیست است', rm[0]?.model === 'model-A' && rm[0]?.pinned === true, rm.map((r) => `${r.model}${r.pinned ? '*' : ''}`))
  // دو تای دیگر را پین کن → سقف ۳ پر می‌شود
  check('پین B موفق است', useStore.getState().togglePinRecentModel('model-B', activeId) === true)
  check('پین C موفق است', useStore.getState().togglePinRecentModel('model-C', activeId) === true)
  // چهارمی نباید پین شود (سقف ۳)
  check('پین چهارم (D) رد می‌شود', useStore.getState().togglePinRecentModel('model-D', activeId) === false)
  rm = useStore.getState().recentModels
  check('فقط ۳ مدل پین‌شده‌اند', rm.filter((r) => r.pinned).length === 3, rm.map((r) => `${r.model}${r.pinned ? '*' : ''}`))
  check('D پین نشده است', rm.find((r) => r.model === 'model-D')?.pinned !== true)
  // آنپین A → دوباره D قابل پین شدن است
  check('آنپین A موفق است (false برمی‌گردد)', useStore.getState().togglePinRecentModel('model-A', activeId) === false)
  rm = useStore.getState().recentModels
  check('A دیگر پین نیست', rm.find((r) => r.model === 'model-A')?.pinned !== true)
  check('حالا پین D موفق است', useStore.getState().togglePinRecentModel('model-D', activeId) === true)
}

console.log('۶) حذف از لیست اخیر + مصونیت پین‌شده از حذف خودکار:')
{
  useStore.setState({ recentModels: [] })
  useStore.getState().addRecentModel('keep-me', activeId)
  useStore.getState().togglePinRecentModel('keep-me', activeId)
  useStore.getState().addRecentModel('other', activeId)
  // حذف دستی مدل غیرپین
  useStore.getState().removeRecentModel('other', activeId)
  let rm = useStore.getState().recentModels
  check('مدل حذف‌شده از لیست رفته است', !rm.some((r) => r.model === 'other'), rm.map((r) => r.model))
  check('مدل پین‌شده سر جایش است', rm.some((r) => r.model === 'keep-me' && r.pinned === true))
  // لیست را با ۲۰+ مدل غیرپین پر کن → پین‌شده نباید با سقف حذف شود
  for (let i = 0; i < 25; i++) useStore.getState().addRecentModel(`filler-${i}`, activeId)
  rm = useStore.getState().recentModels
  check('پین‌شده از حذف خودکار مصون است', rm.some((r) => r.model === 'keep-me' && r.pinned === true), rm.map((r) => r.model))
  check('پین‌شده هنوز بالای لیست است', rm[0]?.model === 'keep-me', rm.slice(0, 3).map((r) => r.model))
  // حذف دستی پین‌شده ممکن نیست — اول باید آنپین شود
  useStore.getState().removeRecentModel('keep-me', activeId)
  rm = useStore.getState().recentModels
  check('حذف دستی پین‌شده کار نمی‌کند (مصون است)', rm.some((r) => r.model === 'keep-me' && r.pinned === true))
  // بعد از آنپین، حذف دستی کار می‌کند
  useStore.getState().togglePinRecentModel('keep-me', activeId)
  useStore.getState().removeRecentModel('keep-me', activeId)
  rm = useStore.getState().recentModels
  check('بعد از آنپین، حذف دستی کار می‌کند', !rm.some((r) => r.model === 'keep-me'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
// The store keeps timers alive (persistSoon etc.) — force-exit so the test
// script terminates cleanly instead of hanging.
process.exit(0)
