// Sanity test for the error-text humanizer (src/lib/errorText.ts).
// Run: node tests/errorText.test.ts
import { humanizeError, fallbackReason } from '../src/lib/errorText.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) جای‌گذاری پیام داخل JSON تودرتوی پرووایدر:')
{
  // دقیقاً همان شکلی که بک‌اند می‌سازد: بدنهٔ خام (escape‌شده) چسبانده شده به متن
  const raw =
    'explore failed: key rejected (429): {"error":{"message":"[429]: {\\"error\\":{\\"type\\":\\"server_error\\",\\"message\\":\\"Upstream request failed: Endpoint is unavailable.\\"}}","type":"rate_limit_error","code":"rate_limit_exceeded"}} — trying the next model'
  const out = humanizeError(raw)
  check('پیام انسانی باقی می‌ماند', out.includes('Upstream request failed: Endpoint is unavailable.'), out)
  check('JSON خام حذف می‌شود', !out.includes('rate_limit_exceeded'), out)
  check('آکولاد اضافه نمی‌ماند', !out.includes('{"'), out)
  check('کد وضعیت برای زمینه می‌ماند', out.includes('429'), out)
  check('طول کوتاه', out.length < 140, out.length)
  check('بدون خط جدید', !out.includes('\n'), out)
}

console.log('2) پیام ساده بدون JSON دست‌نخورده می‌ماند:')
{
  check('upstream connection lost', humanizeError('upstream connection lost') === 'upstream connection lost')
  check('خالی', humanizeError('') === '')
  check('فاصله‌های تکراری جمع می‌شوند', humanizeError('a   b\n c') === 'a b c')
}

console.log('3) نویسه‌های نامرئی (bidi) حذف می‌شوند تا خط در RTL برنگردد:')
{
  const out = humanizeError('boom \u202e\u200f here')
  check('bidi حذف شد', out === 'boom here', out)
}

console.log('4) بریدن روی مرز کلمه، با …:')
{
  const long = 'x'.repeat(0) + Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  const out = humanizeError(long, 60)
  check('با … تمام می‌شود', out.endsWith('…'), out)
  check('طول محدود', out.length <= 61, out.length)
  check('کلمهٔ نیمه‌بریده ندارد', !/wor$/.test(out), out)
}

console.log('5) fallbackReason: پوشش جملهٔ بنر را دور می‌ریزد:')
{
  const raw =
    'explore failed: key rejected (429): {"error":{"message":"[429]: model not found"}} — trying the next model'
  const out = fallbackReason(raw)
  check('پیشوند ابزار حذف شد', !out.toLowerCase().includes('explore failed'), out)
  check('«trying the next model» حذف شد', !out.includes('trying the next model'), out)
  check('پیام خطا ماند', out.includes('model not found'), out)
  check('کد وضعیت ماند', out.includes('429'), out)
}

console.log('6) fallbackReason روی پیام ساده:')
{
  check(
    'بدون پیشوند/پسوند',
    fallbackReason('explore failed: timeout') === 'timeout',
    fallbackReason('explore failed: timeout'),
  )
  check('خالی', fallbackReason('') === '')
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
