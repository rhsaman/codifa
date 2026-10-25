// Quick sanity test for src/lib/thinking.ts (run: node test/thinking.test.ts)
import { supportsReasoning } from '../src/lib/thinking.ts'
import { modelReasoning, modelThinkingLevels } from '../src/lib/context.ts'
import {
  THINKING_OPTIONS,
  levelFromSource,
  thinkingOptionsFor,
} from '../src/lib/thinking-options.ts'
import type { ProviderConfig, ThinkingLevel } from '../src/types.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) مدل‌های hy3 (مثل hy3-free) دیگر از روی نام شناسایی نمی‌شوند:')
{
  // هیوریستیک نام‌محور نباید مدل‌هایی مثل hy3-free را بدون سیگنال بک‌اند تشخیص دهد
  // (هارد‌کد حذف شد — شناسایی از فیلد reasoning اندپوینت /models می‌آید).
  check('hy3-free بدون پرچم reasoning رد می‌شود', supportsReasoning('hy3-free', 'custom') === false)
  check('opencode/hy3-free (فرم پیشوند‌دار) بدون پرچم رد می‌شود', supportsReasoning('opencode/hy3-free', 'custom') === false)
  check('HY3-FREE (حساس به بزرگی/کوچکی نیست) بدون پرچم رد می‌شود', supportsReasoning('HY3-FREE', 'custom') === false)
}

console.log('')
console.log('2) مدل‌های شناخته‌شدهٔ قبلی همچنان کار می‌کنند:')
{
  check('deepseek-r1', supportsReasoning('deepseek-r1', 'openrouter') === true)
  check('qwen3', supportsReasoning('qwen3', 'ollama') === true)
  check('o3 (خانوادهٔ OpenAI، kind=nvidia به عنوان نماینده) رد نمی‌شود', supportsReasoning('o3', 'nvidia') === true)
}

console.log('')
console.log('3) مدل‌های غیر-reasoning رد می‌شوند:')
{
  check('gpt-4o رد می‌شود', supportsReasoning('gpt-4o', 'nvidia') === false)
  check('مدل خالی رد می‌شود', supportsReasoning('', 'custom') === false)
}

console.log('')
console.log('4) پرچم صریح reasoning بر هیوریستیک اولویت دارد:')
{
  check('reasoning=false رد می‌شود حتی برای مدل ناشناخته', supportsReasoning('weird-model', 'custom', false) === false)
  check('reasoning=true تایید می‌شود حتی برای مدل ناشناخته', supportsReasoning('weird-model', 'custom', true) === true)
}

console.log('')
console.log('5) منوی سطح‌های thinking فقط سطح‌های واقعی مدل را نشان می‌دهد:')
{
  const provider = (over: Partial<ProviderConfig>): ProviderConfig =>
    ({ id: 'custom-1', kind: 'custom', thinkingLevelsMap: {}, ...over }) as ProviderConfig

  // گیت‌وی گفته thinking یک سوییچ است و effort درجه‌بندی ندارد → فقط off + بالاترین.
  const switchOnly = provider({ thinkingLevelsMap: { 'm-switch': ['none', 'high'] } })
  check(
    'سطح‌های گزارش‌شده منو را محدود می‌کنند',
    JSON.stringify(thinkingOptionsFor(modelThinkingLevels(switchOnly, 'm-switch'))) ===
      JSON.stringify([
        ['none', 'None'],
        ['high', 'High'],
      ]),
  )

  // مدل ناشناخته: هیچ منبعی سطحی نام نبرده، پس حدسی ساخته نمی‌شود BUT لیست
  // کامل می‌ماند تا انتخاب‌گر پنهان نشود؛ مسدودسازی فقط سر ارسال است.
  const unknown = provider({ thinkingLevelsMap: {} })
  check(
    'مدل ناشناخته لیست کامل را نگه می‌دارد (انتخاب‌گر پنهان نمی‌شود)',
    thinkingOptionsFor(modelThinkingLevels(unknown, 'nobody-knows')).length ===
      THINKING_OPTIONS.length &&
      thinkingOptionsFor(null).length === THINKING_OPTIONS.length,
  )
  check(
    'هیچ سطحِ نام‌برده‌نشده‌ای فرستاده نمی‌شود',
    levelFromSource(modelThinkingLevels(unknown, 'nobody-knows'), 'xhigh') === '',
  )

  // گیت‌وی xhigh را نام برده و high را نه: منو باید دقیقاً همان‌ها را بدهد،
  // چون بک‌اند توکن را بدون collapse می‌فرستد.
  const enumerated = provider({
    thinkingLevelsMap: { 'qwen/qwen3.8-27b': ['low', 'medium', 'xhigh'] },
  })
  const enumeratedOptions = thinkingOptionsFor(
    modelThinkingLevels(enumerated, 'qwen/qwen3.8-27b'),
  )
  check(
    'سطح‌های شمارش‌شدهٔ گیت‌وی بدون حذف/افزودن نشان داده می‌شوند',
    JSON.stringify(enumeratedOptions) ===
      JSON.stringify([
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['xhigh', 'Max'],
      ]),
  )
  check(
    'هر سطح نمایش‌داده‌شده عضوی از لیست مشترک است',
    enumeratedOptions.every(([v]) => THINKING_OPTIONS.some(([o]) => o === v)),
  )

  // آرایه‌ی خالی = مدل اصلاً حالت thinking ندارد.
  const none = provider({ thinkingLevelsMap: { 'm-plain': [] } })
  check(
    'آرایه‌ی خالی یعنی هیچ سطحی وجود ندارد',
    thinkingOptionsFor(modelThinkingLevels(none, 'm-plain')).length === 0,
  )
  check(
    'آرایه‌ی خالی از ناشناخته تفکیک می‌شود',
    modelThinkingLevels(none, 'm-plain') !== null &&
      modelThinkingLevels(unknown, 'nobody-knows') === null,
  )

  // فرم پیشوند‌دار id (همان قاعده‌ی context/reasoning).
  const prefixed = provider({ thinkingLevelsMap: { 'custom-1/m-prefixed': ['none', 'low', 'high'] } })
  check(
    'id پیشوند‌دار با نام پروایدر پیدا می‌شود',
    JSON.stringify(modelThinkingLevels(prefixed, 'm-prefixed')) ===
      JSON.stringify(['none', 'low', 'high'] as ThinkingLevel[]),
  )
}

console.log('')
console.log('۵) شاهدِ مشاهده‌شده (observedReasoningMap) — پروایدری که هیچ capability نمی‌گوید:')
{
  const provider = (over: Partial<ProviderConfig>): ProviderConfig =>
    ({ id: 'custom-1', kind: 'custom', thinkingLevelsMap: {}, ...over }) as ProviderConfig

  // NVIDIA NIM و بیشتر گیت‌وی‌های کاستوم در /models فقط id/object/created/owned_by
  // می‌دهند: هیچ سیگنال capability وجود ندارد. تنها شاهد، خودِ پاسخ مدل است که
  // reasoning تولید کرده.
  const silent = provider({
    reasoningMap: {},
    observedReasoningMap: { 'minimaxai/minimax-m3.1-flash': true },
  })
  check(
    'مدلی که هیچ منبعی توصیفش نکرده ولی شاهد دارد → reasoning=true',
    modelReasoning(silent, 'minimaxai/minimax-m3.1-flash') === true,
  )
  check(
    'مدل دیگر همان پروایدر همچنان ناشناخته می‌ماند (بدون حدس)',
    modelReasoning(silent, '01-ai/yi-large') === null,
  )

  // شاهد یک‌طرفه است: نبودِ شاهد هرگز «reasoning ندارد» معنا نمی‌شود.
  check(
    'نبودِ شاهد با false اشتباه گرفته نمی‌شود',
    modelReasoning(provider({ reasoningMap: {} }), 'adept/fuyu-8b') === null,
  )

  // شاهد بر پرچمِ گزارش‌شده اولویت دارد (اگر /models اشتباه بگوید false).
  check(
    'شاهدِ مشاهده‌شده بر پرچم false گزارش‌شده اولویت دارد',
    modelReasoning(
      provider({
        reasoningMap: { 'z-ai/glm-5.3': false },
        observedReasoningMap: { 'z-ai/glm-5.3': true },
      }),
      'z-ai/glm-5.3',
    ) === true,
  )
  check(
    'توگل دستی کاربر همچنان بالاترین اولویت را دارد',
    modelReasoning(
      provider({
        manualReasoningMap: { 'z-ai/glm-5.3': false },
        observedReasoningMap: { 'z-ai/glm-5.3': true },
      }),
      'z-ai/glm-5.3',
    ) === false,
  )

  // id گیت‌وی می‌تواند خودش vendor-namespaced باشد و نباید نرمال شود.
  check(
    'id وندور-نام‌دار درست resolve می‌شود',
    modelReasoning(provider({ observedReasoningMap: { 'nvidia/nemotron-3-super': true } }), 'nvidia/nemotron-3-super') === true,
  )
  check(
    'فرم پیشوند‌دار با id پروایدر هم پشتیبانی می‌شود',
    modelReasoning(
      provider({ id: 'nv-1', observedReasoningMap: { 'nv-1/m-x': true } }),
      'm-x',
    ) === true,
  )
}

console.log('')
console.log('6) فقط سطحی که یک منبع برای همان مدل نام برده اجازه‌ی ارسال دارد:')
{
  const named: ThinkingLevel[] = ['low', 'medium', 'xhigh']
  check('سطح نام‌برده‌شده می‌رود', levelFromSource(named, 'xhigh') === 'xhigh')
  // دلیل اصلی باگ: سطح ذخیره‌شده‌ی چت با تغییر مدل باقی می‌ماند و گیت‌وی
  // سطحی را که نام نبرده با 400 رد می‌کند.
  check('سطحی که منبع نام نبرده حذف می‌شود', levelFromSource(named, 'high') === '')
  check('سطحی که منبع نام نبرده حذف می‌شود (نردبان کامل)', levelFromSource(['low'], 'high') === '')
  check('نردبان حدسی جای منبع را نمی‌گیرد', levelFromSource(null, 'high') === '')
  check('خاموش‌بودن همیشه مجاز است', levelFromSource(named, 'none') === 'none')
  check('خالی یعنی پیش‌فرض پروایدر', levelFromSource(named, '') === '')
  check('max با xhigh یکی است', levelFromSource(['xhigh'], 'max') === 'xhigh')
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های thinking پاس شدند')
