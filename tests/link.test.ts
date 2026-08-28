// Unit tests for the external-link helpers used by markdown links.
// Run: node test/link.test.ts
import { isExternalHref, handleLinkClick } from '../src/lib/link.ts'

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
  let prevented = false
  let opened: string | null = null
  const handled = handleLinkClick(
    { preventDefault: () => { prevented = true } },
    'https://example.com',
    (url) => { opened = url },
  )
  check('لینک خارجی مدیریت شد', handled === true)
  check('پیش‌فرض جلوگیری شد', prevented === true)
  check('به مرورگر سیستم فرستاده شد', opened === 'https://example.com')
}
{
  let prevented = false
  let opened: string | null = null
  const handled = handleLinkClick(
    { preventDefault: () => { prevented = true } },
    '#section',
    (url) => { opened = url },
  )
  check('لینک داخلی مدیریت نشد', handled === false)
  check('پیش‌فرض جلوگیری نشد', prevented === false)
  check('به مرورگر فرستاده نشد', opened === null)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
