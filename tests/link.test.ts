// Unit tests for the external-link helpers used by markdown links.
// Run: node test/link.test.ts
import { extractUrls, handleLinkClick, isExternalHref, splitTextByUrls } from '../src/lib/link.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) isExternalHref:')
check('لینک https خارجی است', isExternalHref('https://example.com'))
check('لینک http خارجی است', isExternalHref('http://example.com'))
check('لینک https با حروف بزرگ خارجی است', isExternalHref('HTTPS://Example.COM/x'))
check('لینک داخلی # غیرخارجی است', !isExternalHref('#section'))
check('لینک mailto غیرخارجی است', !isExternalHref('mailto:a@b.com'))
check('لینک نسبی غیرخارجی است', !isExternalHref('/page'))
check('undefined غیرخارجی است', !isExternalHref(undefined))

console.log('2) handleLinkClick:')
{
  const box: { prevented: boolean; opened: string | null } = { prevented: false, opened: null }
  const handled = handleLinkClick(
    { preventDefault: () => { box.prevented = true } },
    'https://example.com',
    (url) => { box.opened = url },
  )
  check('لینک خارجی مدیریت شد', handled === true)
  check('پیش‌فرض جلوگیری شد', box.prevented)
  check('به مرورگر سیستم فرستاده شد', box.opened === 'https://example.com')
}
{
  const box: { prevented: boolean; opened: string | null } = { prevented: false, opened: null }
  const handled = handleLinkClick(
    { preventDefault: () => { box.prevented = true } },
    '#section',
    (url) => { box.opened = url },
  )
  check('لینک داخلی مدیریت نشد', handled === false)
  check('پیش‌فرض جلوگیری نشد', !box.prevented)
  check('به مرورگر فرستاده نشد', box.opened === null)
}

console.log('3) splitTextByUrls:')
check('متن بدون لینک دست‌نخورده می‌ماند', JSON.stringify(splitTextByUrls('hello world')) === JSON.stringify(['hello world']))
{
  const parts = splitTextByUrls('https://example.com/x')
  check('تک‌لینک به یک بخش URL تبدیل می‌شود', parts.length === 1 && typeof parts[0] !== 'string' && (parts[0] as { url: string }).url === 'https://example.com/x')
}
{
  const parts = splitTextByUrls('see https://example.com/x here')
  check('متن ترکیبی به سه بخش تقسیم می‌شود', parts.length === 3 && parts[0] === 'see ' && typeof parts[1] !== 'string' && parts[2] === ' here')
}
{
  const parts = splitTextByUrls('go to https://example.com/x.')
  const urlPart = parts.find((p) => typeof p !== 'string') as { url: string } | undefined
  check('نقطه پایانی جمله جزو لینک نیست', urlPart !== undefined && urlPart.url === 'https://example.com/x' && parts[parts.length - 1] === '.')
}
check('extractUrls لینک‌ها را برمی‌گرداند', JSON.stringify(extractUrls('a https://example.com/x b http://foo.bar/y')) === JSON.stringify(['https://example.com/x', 'http://foo.bar/y']))
check('extractUrls برای متن بدون لینک خالی است', extractUrls('no links here').length === 0)

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
