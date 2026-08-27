import './_globals.ts'
import { normalizeUsageEntry, providerForUsageEntry, normalizeUsageModel } from '../src/lib/usage.ts'
import type { ChatUsage, ChatUsageEntry, ProviderConfig } from '../src/types.ts'

function check(name: string, cond: any, extra?: any) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

const mkProvider = (id: string): ProviderConfig =>
  ({ id, name: id, kind: 'openrouter', models: [] } as ProviderConfig)

const providers = [mkProvider('myprovider'), mkProvider('openrouter')]
const providerIds = providers.map((p) => p.id)

console.log('۱) normalizeUsageEntry کلیدهای legacy را به entry صریح تبدیل می‌کند (ریشهٔ مشکل):')
{
  // کلید bare قدیمی -> زیر پرووایدر واقعی چت (نه active اشتباه)
  const legacy = { free: { input: 10, output: 5 } }
  const out = normalizeUsageEntry(legacy, 'openrouter', providerIds)
  check('کلید bare -> entry با providerId چت', out?.entries[0]?.providerId === 'openrouter', out)
  check('مدل دقیقاً همان کلید bare است', out?.entries[0]?.model === 'free', out)
  check('توکن‌ها حفظ شدند', out?.entries[0]?.input === 10 && out?.entries[0]?.output === 5, out)
}

console.log('۲) پیشوند namespace مدل (مثل anthropic/claude-...) نباید زیر پرووایدر اشتباه برود:')
{
  const legacy = { 'anthropic/claude-3.5-sonnet': { input: 1, output: 2 } }
  const out = normalizeUsageEntry(legacy, 'openrouter', providerIds)
  check('زیر پرووایدر واقعی چت می‌رود (نه anthropic)', out?.entries[0]?.providerId === 'openrouter', out)
  check('کل مدل (با پیشوندش) حفظ می‌شود', out?.entries[0]?.model === 'anthropic/claude-3.5-sonnet', out)
}

console.log('۳) پیشوند واقعی پرووایدر (subagent routing) حفظ می‌شود:')
{
  const legacy = { 'myprovider/free': { input: 3, output: 4 } }
  const out = normalizeUsageEntry(legacy, 'openrouter', providerIds)
  check('پرووایدر پیشوند به‌عنوان providerId می‌رود', out?.entries[0]?.providerId === 'myprovider', out)
  check('مدل باقی‌مانده درست است', out?.entries[0]?.model === 'free', out)
}

console.log('۴) دادهٔ جدید (شکل entry) دست‌نخورده عبور می‌کند:')
{
  const fresh: ChatUsage = {
    entries: [{ providerId: 'openrouter', model: 'free', input: 7, output: 8 }],
  }
  const out = normalizeUsageEntry(fresh, 'myprovider', providerIds)
  check('entry جدید تغییر نمی‌کند', out?.entries[0]?.providerId === 'openrouter' && out?.entries[0]?.model === 'free', out)
}

console.log('۵) providerForUsageEntry پرووایدر را مستقیم از entry برمی‌گرداند (بدون پارس):')
{
  const entry: ChatUsageEntry = { providerId: 'myprovider', model: 'free', input: 1, output: 1 }
  const p = providerForUsageEntry(entry, providers)
  check('entry صریح -> پرووایدر درست (نه active اشتباه)', p?.id === 'myprovider', p?.id)
  const entry2: ChatUsageEntry = { providerId: 'openrouter', model: 'free', input: 1, output: 1 }
  check('entry صریح openrouter -> openrouter', providerForUsageEntry(entry2, providers)?.id === 'openrouter')
}

console.log('۶) سناریوی دو پرووایدر با مدل یکسان (مشکل اصلی):')
{
  // دو چت روی دو پرووایدر مختلف، هر دو مدل "free" را صدا زدند.
  const a = normalizeUsageEntry({ free: { input: 1, output: 1 } }, 'myprovider', providerIds)
  const b = normalizeUsageEntry({ free: { input: 1, output: 1 } }, 'openrouter', providerIds)
  const pa = providerForUsageEntry(a!.entries[0], providers)
  const pb = providerForUsageEntry(b!.entries[0], providers)
  check('هر دو entry به پرووایدر واقعی خودشان نسبت داده می‌شوند', pa?.id === 'myprovider' && pb?.id === 'openrouter', { a: pa?.id, b: pb?.id })
  check('پرووایدرها یکسان نیستند (گروه‌بندی جدا)', pa?.id !== pb?.id, { a: pa?.id, b: pb?.id })
}

console.log('۷) normalizeUsageModel پیشوند provider تکراری را حذف می‌کند (توکن‌ها روی یک entry جمع می‌شوند):')
{
  check('مدل با پیشوند provider == providerId -> بدون پیشوند', normalizeUsageModel('openrouter', 'openrouter/claude-3.5-sonnet') === 'claude-3.5-sonnet', normalizeUsageModel('openrouter', 'openrouter/claude-3.5-sonnet'))
  check('مدل بدون پیشوند دست‌نخورده می‌ماند', normalizeUsageModel('openrouter', 'claude-3.5-sonnet') === 'claude-3.5-sonnet', normalizeUsageModel('openrouter', 'claude-3.5-sonnet'))
  check('namespace مدل (anthropic/...) حفظ می‌شود', normalizeUsageModel('openrouter', 'anthropic/claude-3.5-sonnet') === 'anthropic/claude-3.5-sonnet', normalizeUsageModel('openrouter', 'anthropic/claude-3.5-sonnet'))
  check('مدل خالی -> main', normalizeUsageModel('openrouter', '') === 'main', normalizeUsageModel('openrouter', ''))
}

console.log('۸) رویداد فقط-کش‌محور نباید حذف شود (توکن‌های cached از دست نمی‌روند):')
{
  // شبیه‌سازی منطق accrueChatUsage: رویدادی که فقط cacheRead دارد نباید رد شود.
  const delta = { input: 0, output: 0, cacheRead: 1200, cacheWrite: 0 }
  const hasTokens =
    (delta.input || 0) > 0 ||
    (delta.output || 0) > 0 ||
    (delta.cacheRead || 0) > 0 ||
    (delta.cacheWrite || 0) > 0
  check('رویداد cache-only دارای توکن محسوب می‌شود', hasTokens === true, delta)
  // و رویداد کاملاً خالی باید رد شود
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const emptyHas = (empty.input || 0) > 0 || (empty.output || 0) > 0 || (empty.cacheRead || 0) > 0 || (empty.cacheWrite || 0) > 0
  check('رویداد کاملاً خالی رد می‌شود', emptyHas === false, empty)
}

if ((globalThis as any).__FAILED) {
  console.error('\nFAILED')
  process.exit(1)
} else {
  console.log('\nALL PASSED')
}
