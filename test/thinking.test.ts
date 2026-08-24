// Quick sanity test for src/lib/thinking.ts (run: node test/thinking.test.ts)
import { supportsReasoning } from '../src/lib/thinking.ts'

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
  check('hy3-free بدون پرچم reasoning رد می‌شود', supportsReasoning('hy3-free', 'opencode') === false)
  check('opencode/hy3-free (فرم پیشوند‌دار) بدون پرچم رد می‌شود', supportsReasoning('opencode/hy3-free', 'opencode') === false)
  check('HY3-FREE (حساس به بزرگی/کوچکی نیست) بدون پرچم رد می‌شود', supportsReasoning('HY3-FREE', 'opencode') === false)
}

console.log('')
console.log('2) مدل‌های شناخته‌شدهٔ قبلی همچنان کار می‌کنند:')
{
  check('deepseek-r1', supportsReasoning('deepseek-r1', 'openrouter') === true)
  check('qwen3', supportsReasoning('qwen3', 'ollama') === true)
  check('o3', supportsReasoning('o3', 'openai') === true)
}

console.log('')
console.log('3) مدل‌های غیر-reasoning رد می‌شوند:')
{
  check('gpt-4o رد می‌شود', supportsReasoning('gpt-4o', 'openai') === false)
  check('مدل خالی رد می‌شود', supportsReasoning('', 'opencode') === false)
}

console.log('')
console.log('4) پرچم صریح reasoning بر هیوریستیک اولویت دارد:')
{
  check('reasoning=false رد می‌شود حتی برای مدل ناشناخته', supportsReasoning('weird-model', 'opencode', false) === false)
  check('reasoning=true تایید می‌شود حتی برای مدل ناشناخته', supportsReasoning('weird-model', 'opencode', true) === true)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های thinking پاس شدند')
