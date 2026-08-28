// تست کنتراست هایلایت diff: متن خطوط اضافه/حذف‌شده نباید به رنگ تیرهٔ
// --on-accent (که در تم‌های تاریک روی زمینهٔ مبتنی‌بر --bg نامرئی می‌شود)
// فال‌بک دهد. فال‌بک باید --text باشد که همیشه برای خوانایی روی --bg تنظیم شده.
// اجرا: node test/diffContrast.test.ts
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) فال‌بک قدیمی (--on-accent) در هایلایت diff نباید وجود داشته باشد:')
{
  const bad = css.includes('var(--diff-text, var(--on-accent))')
  check('الگوی قدیمی حذف شده', !bad)
}

console.log('۲) هر دو سلول هایلایت diff باید به --text فال‌بک دهند:')
{
  const delOk = /\.diff-side-cell\.diff-del\s*\{[^}]*color:\s*var\(--diff-text,\s*var\(--text\)\)/.test(css)
  const addOk = /\.diff-side-cell\.diff-add\s*\{[^}]*color:\s*var\(--diff-text,\s*var\(--text\)\)/.test(css)
  check('.diff-side-cell.diff-del → var(--text)', delOk)
  check('.diff-side-cell.diff-add → var(--text)', addOk)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
