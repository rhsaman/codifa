// Quick sanity test for src/lib/provider-meta.ts → isForeignModelId
// (run: node tests/foreignProviderId.test.ts)
//
// این تست تضمین می‌کند که id مدل‌های متعلق به provider دیگر (مثلاً
// "openrouter/sonnet" که به اشتباه در ردیف nvidia ذخیره شده، یا
// "local/opencode/big-pickle" که به صورت doubly-prefixed در ردیف local
// مانده) از لیست dropdown زیر provider اشتباه حذف می‌شوند، ولی idهای
// داخلی provider (مثل "meta-llama/llama-3.1-70b-instruct" برای nvidia
// که خودش prefix داخلی دارد) حفظ می‌شوند.
//
// نکتهٔ کلیدی: helper روی `b` (مدل بعد از `bareModel`) کار می‌کند، نه
// روی `m` خام. بنابراین تماس‌گیرنده باید قبل از فراخوانی، prefix اضافی
// `${p.id}/` را strip کند. در این تست خودمان هم این کار را می‌کنیم تا
// رفتار helper را مستقل از لایهٔ UI بررسی کنیم.
import { isForeignModelId, FOREIGN_PROVIDER_PREFIXES } from '../src/lib/provider-meta.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// همان bareModel که در ProviderModelSelect.tsx و SettingsModal.tsx
// استفاده می‌شود: prefix اضافی `${p.id}/` را از ابتدای id حذف می‌کند.
function bareModel(p: { id: string }, m: string): string {
  return m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
}

console.log('1) prefix یک provider دیگر، زیر provider اشتباه، حذف می‌شود:')
{
  const nvidia = { id: 'nvidia' }
  check('openrouter/sonnet زیر nvidia خارجی است', isForeignModelId(nvidia, bareModel(nvidia, 'openrouter/sonnet')))
  check('opencode/gpt-5 زیر nvidia خارجی است', isForeignModelId(nvidia, bareModel(nvidia, 'opencode/gpt-5')))
  check('cloudflare/@cf/meta/llama-3.1 زیر nvidia خارجی است', isForeignModelId(nvidia, bareModel(nvidia, 'cloudflare/@cf/meta/llama-3.1')))
  check('anthropic/claude-3.5 زیر nvidia خارجی است', isForeignModelId(nvidia, bareModel(nvidia, 'anthropic/claude-3.5')))
}

console.log('')
console.log('2) idهای داخلی provider حفظ می‌شوند (nvidia خودش مدل‌های "meta-llama/..." و "google/gemma-*" دارد):')
{
  const nvidia = { id: 'nvidia' }
  check('meta-llama/llama-3.1-70b-instruct داخلی nvidia است', !isForeignModelId(nvidia, bareModel(nvidia, 'meta-llama/llama-3.1-70b-instruct')))
  check('mistralai/mistral-large داخلی nvidia است', !isForeignModelId(nvidia, bareModel(nvidia, 'mistralai/mistral-large')))
  check('id بدون اسلش (bare) داخلی است', !isForeignModelId(nvidia, bareModel(nvidia, 'llama-3.1')))
  // NIM کاتالوگ واقعی‌اش Gemma را با پیشوند google/ برمی‌گرداند — نباید فیلتر شود.
  check('google/gemma-3-4b-it داخلی nvidia است (NIM host می‌کند)', !isForeignModelId(nvidia, bareModel(nvidia, 'google/gemma-3-4b-it')))
}

console.log('')
console.log('3) prefix همان provider اشتباه گرفته نمی‌شود:')
{
  const nvidia = { id: 'nvidia' }
  check('nvidia/foo داخلی nvidia است (همان prefix)', !isForeignModelId(nvidia, bareModel(nvidia, 'nvidia/foo')))
}

console.log('')
console.log('4) ردیف custom با نام "opencode" (id دلخواه کاربر): idهای خام داخلی هستند:')
{
  // کاربر می‌تواند ردیف custom خودش را "opencode" نام‌گذاری کند؛ idهای خام
  // بدون اسلش داخلی‌اند و self-prefix هم strip می‌شود.
  const oc = { id: 'opencode' }
  check('big-pickle داخلی است (id خام)', !isForeignModelId(oc, bareModel(oc, 'big-pickle')))
  check('gpt-5 داخلی است (id خام)', !isForeignModelId(oc, bareModel(oc, 'gpt-5')))
  // self-prefix در عمل بی‌ضرر است چون bareModel prefix را strip می‌کند،
  // و helper نباید entry دستی کاربر را حذف کند.
  check('opencode/big-pickle (self-prefix) داخلی است چون head===p.id', !isForeignModelId(oc, bareModel(oc, 'opencode/big-pickle')))
}

console.log('')
console.log('5) openrouter: vendor-prefixهای کاتالوگ خودش داخلی‌اند، gateway-id خارجی:')
{
  const or = { id: 'openrouter' }
  check('openai/gpt-4o داخلی openrouter است', !isForeignModelId(or, bareModel(or, 'openai/gpt-4o')))
  check('anthropic/claude-3.5-sonnet داخلی openrouter است', !isForeignModelId(or, bareModel(or, 'anthropic/claude-3.5-sonnet')))
  check('google/gemini-3.8-flash داخلی openrouter است', !isForeignModelId(or, bareModel(or, 'google/gemini-3.8-flash')))
  check('nvidia/nemotron-3.5-lightning داخلی openrouter است', !isForeignModelId(or, bareModel(or, 'nvidia/nemotron-3.5-lightning')))
  check('ollama/llama3 خارجی openrouter است (gateway-id)', isForeignModelId(or, bareModel(or, 'ollama/llama3')))
  // ولی اگر یک entry عجیب مثل "opencode/foo" در openrouter باشد، خارجی است
  check('opencode/foo خارجی است (مدل متعلق به opencode)', isForeignModelId(or, bareModel(or, 'opencode/foo')))
}

console.log('')
console.log('6) ردیف custom با baseUrl پوینت‌شده به openrouter — پیشوند openrouter/ خود گیت‌وی داخلی است:')
{
  const customOr = { id: 'custom-abc', kind: 'custom', baseUrl: 'https://openrouter.ai/api/v1' }
  check('openrouter/auto داخلی custom→openrouter است', !isForeignModelId(customOr, bareModel(customOr, 'openrouter/auto')))
  check('anthropic/claude داخلی custom→openrouter است', !isForeignModelId(customOr, bareModel(customOr, 'anthropic/claude-3.5-sonnet')))
  check('opencode/foo خارجی custom→openrouter است', isForeignModelId(customOr, bareModel(customOr, 'opencode/foo')))
}

console.log('')
console.log('7) سناریوی کلیدی: p.id=local با entry doubly-prefixed "local/opencode/big-pickle":')
{
  // recentModels migration یا یک entry قدیمی می‌تواند id را به صورت
  // doubly-prefixed در p.models باقی بگذارد. raw check روی `m` (head=local)
  // آن را داخلی می‌بیند و bug تولید می‌کند. helper جدید روی `b` کار
  // می‌کند و head را بعد از strip بررسی می‌کند.
  const local = { id: 'local' }
  const m = 'local/opencode/big-pickle'
  const b = bareModel(local, m)
  check('bareModel "local/opencode/big-pickle" → "opencode/big-pickle"', b === 'opencode/big-pickle', `got ${JSON.stringify(b)}`)
  check('"local/opencode/big-pickle" زیر local خارجی است (helper روی b)', isForeignModelId(local, b))
}

console.log('')
console.log('8) FOREIGN_PROVIDER_PREFIXES همه kindهای built-in را شامل می‌شود:')
{
  for (const k of ['openrouter', 'google', 'nvidia', 'cloudflare', 'tokenrouter', 'ollama', 'custom', 'anthropic', 'opencode']) {
    check(`kind "${k}" در مجموعه است`, FOREIGN_PROVIDER_PREFIXES.has(k))
  }
}

console.log('')
if (failed === 0) {
  console.log('✅ همهٔ تست‌های isForeignModelId پاس شدند')
} else {
  console.error(`❌ ${failed} تست fail شد`)
  process.exit(1)
}
