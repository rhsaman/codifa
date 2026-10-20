// تست واحد برای ریاضیات ترتیب تب‌ها (پیش‌نمایش درگ در ریل).
// اجرا: node tests/tabOrder.test.ts
import { previewOrder, previewSlot } from '../src/lib/tabOrder.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const A = ['a', 'b', 'c', 'd']

console.log('۱) previewOrder: افتادن قبل از تب هدف:')
{
  check('d قبل از a → [d,a,b,c]', previewOrder(A, 'd', 'a', false).join('') === 'dabc')
  check('a قبل از c → [b,a,c,d]', previewOrder(A, 'a', 'c', false).join('') === 'bacd')
}

console.log('۲) previewOrder: افتادن بعد از تب هدف:')
{
  check('a بعد از c → [b,c,a,d]', previewOrder(A, 'a', 'c', true).join('') === 'bcad')
  check('a بعد از d → [b,c,d,a]', previewOrder(A, 'a', 'd', true).join('') === 'bcda')
}

console.log('۳) previewOrder: بدون تغییر (تکرار/ناشناخته):')
{
  check('همان تب', previewOrder(A, 'b', 'b', true).join('') === 'abcd')
  check('شناسه ناشناخته', previewOrder(A, 'x', 'a', false).join('') === 'abcd')
  check('هدف ناشناخته', previewOrder(A, 'a', 'x', false).join('') === 'abcd')
}

console.log('۴) previewOrder: هیچ تبی گم/تکرار نمی‌شود:')
{
  for (const from of A) {
    for (const to of A) {
      for (const after of [false, true]) {
        const out = previewOrder(A, from, to, after)
        const ok = out.length === A.length && new Set(out).size === A.length && A.every((id) => out.includes(id))
        if (!ok) check(`جابه‌جایی ${from}→${to} (${after ? 'بعد' : 'قبل'})`, false, out)
      }
    }
  }
  check('همه‌ی ۳۲ حالت سالم ماند', true)
}

console.log('۵) previewSlot: اسلات هر شناسه:')
{
  const slot = previewSlot(A, 'a', 'c', true)
  check('a در اسلات ۲', slot.get('a') === 2)
  check('b در اسلات ۰', slot.get('b') === 0)
  check('c در اسلات ۱', slot.get('c') === 1)
  check('d در اسلات ۳', slot.get('d') === 3)
  check('اسلات‌ها یکتا هستند', new Set([...slot.values()]).size === A.length)
}

console.log('۶) previewOrder با لیست خالی/تکی:')
{
  check('لیست خالی', previewOrder([], 'a', 'b', false).length === 0)
  check('تک‌عضوی', previewOrder(['a'], 'a', 'a', true).join('') === 'a')
}

if (failed) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
}
console.log('\nهمه‌ی تست‌ها پاس شدند.')
