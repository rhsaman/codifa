// Quick sanity test for src/lib/sections.ts (run: node test/sections.test.ts)
import { splitSections } from '../src/lib/sections.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) چند تیتر ساده:')
{
  const md = `## امکانات\n\nمتن بخش اول.\n\n### جزئیات\n\nمتن بخش دوم.`
  const s = splitSections(md)
  check('دو بخش پیدا شد', s.length === 2, s)
  check('تیتر اول = امکانات', s[0]?.title === 'امکانات', s[0])
  check('تیتر دوم = جزئیات', s[1]?.title === 'جزئیات', s[1])
  check('محتوا شامل متن است', s[0]?.content.includes('متن بخش اول'), s[0])
  check('سطح اول h2', s[0]?.level === 2, s[0])
  check('سطح دوم h3', s[1]?.level === 3, s[1])
}

console.log('2) تیترمانند داخل بلاک کد نادیده گرفته میشود:')
{
  const md = `## مقدمه\n\nکد زیر:\n\n\`\`\`python\n# این یک کامنت است\n## این تیتر نیست\n\`\`\`\n\n## نتیجه\n\nپایان.`
  const s = splitSections(md)
  check('فقط دو بخش واقعی', s.length === 2, s.map((x) => x.title))
  check('تیترها درستاند', s[0]?.title === 'مقدمه' && s[1]?.title === 'نتیجه', s)
}

console.log('3) بدون تیتر → خالی:')
{
  const s = splitSections('فقط یک متن ساده بدون تیتر.')
  check('هیچ بخشی نیست', s.length === 0, s)
}

console.log('4) محتوای خالی:')
{
  check('خالی → []', splitSections('').length === 0)
  check('undefined → []', splitSections(undefined as unknown as string).length === 0)
}

console.log('5) متن قبل از اولین تیتر حذف میشود:')
{
  const md = `مقدمه بدون تیتر.\n\n## بخش اول\n\nمتن.`
  const s = splitSections(md)
  check('فقط بخش اول', s.length === 1 && s[0]?.title === 'بخش اول', s)
}

console.log('6) تیترهای h1 تا h6:')
{
  const md = `# یک\n\nمتن یک\n\n## دو\n\nمتن دو\n\n### سه\n\nمتن سه\n\n#### چهار\n\nمتن چهار\n\n##### پنج\n\nمتن پنج\n\n###### شش\n\nمتن شش`
  const s = splitSections(md)
  check('شش بخش', s.length === 6, s.length)
  check('سطوح ۱ تا ۶', s.map((x) => x.level).join(',') === '1,2,3,4,5,6', s.map((x) => x.level))
}

console.log('7) فنس تیلد ~~~ هم نادیده گرفته میشود:')
{
  const md = `## الف\n\n~~~\n## داخل کد\n~~~\n\n## ب\n\nمتن ب`
  const s = splitSections(md)
  check('دو بخش', s.length === 2 && s[0]?.title === 'الف' && s[1]?.title === 'ب', s)
  check('محتوا شامل فنس است', s[0]?.content.includes('## داخل کد'), s[0])
}

console.log('8) بخش بدون محتوا (تیتر پشت تیتر) حذف میشود:')
{
  const md = `## الف\n\n## ب\n\nمتن ب`
  const s = splitSections(md)
  check('فقط بخش ب با محتوا', s.length === 1 && s[0]?.title === 'ب', s)
}

console.log('9) id یکتا است:')
{
  const md = `## الف\n\nمتن\n\n## ب\n\nمتن`
  const s = splitSections(md)
  check('id ها یکتا', s[0]?.id !== s[1]?.id && !!s[0]?.id && !!s[1]?.id, s)
}

console.log('10) تیتر با فاصله اضافه:')
{
  const s = splitSections('##   امکانات   \n\nمتن')
  check('تیتر trim شده', s[0]?.title === 'امکانات', s[0])
}

console.log('11) بدون هدینگ — آیتمهای شمارهدار به بخش تبدیل میشوند:')
{
  const md = `1. نصب وابستگیها\nمتن نصب.\n\n2. پیکربندی\nمتن پیکربندی.\n\n3. اجرا\nمتن اجرا.`
  const s = splitSections(md)
  check('سه بخش', s.length === 3, s.map((x) => x.title))
  check(
    'تیترها',
    s[0]?.title === 'نصب وابستگیها' && s[1]?.title === 'پیکربندی' && s[2]?.title === 'اجرا',
    s,
  )
  check('محتوا', s[0]?.content.includes('متن نصب'), s[0])
}

console.log('12) لیست شمارهدار بدون متن بدنه:')
{
  const s = splitSections('1. الف\n2. ب\n3. ج')
  check('سه بخش نگه داشته میشود', s.length === 3, s)
  check('محتوا = تیتر', s[0]?.content === 'الف', s[0])
}

console.log('13) بدون هدینگ — خطوط bold به بخش تبدیل میشوند:')
{
  const md = `**مقدمه**\nمتن مقدمه.\n\n**نتیجه**\nمتن نتیجه.`
  const s = splitSections(md)
  check('دو بخش', s.length === 2 && s[0]?.title === 'مقدمه' && s[1]?.title === 'نتیجه', s)
}

console.log('14) bold با متن دنبالهدار بخش نیست:')
{
  const s = splitSections('**نکته:** این مهم است.\nمتن دیگر.')
  check('هیچ بخشی نیست', s.length === 0, s)
}

console.log('15) هدینگ موجود → شمارهها بخش نمیشوند:')
{
  const md = `## مراحل\n\n1. الف\n2. ب`
  const s = splitSections(md)
  check('فقط بخش مراحل', s.length === 1 && s[0]?.title === 'مراحل', s)
  check('شمارهها داخل محتوا', s[0]?.content.includes('1. الف'), s[0])
}

console.log('16) شماره فارسی و پرانتزی:')
{
  const s = splitSections('۱. عنوان اول\nمتن.\n\n(2) عنوان دوم\nمتن.')
  check(
    'دو بخش',
    s.length === 2 && s[0]?.title === 'عنوان اول' && s[1]?.title === 'عنوان دوم',
    s,
  )
}

console.log('17) شماره داخل بلاک کد نادیده گرفته میشود:')
{
  const md = '1. الف\nمتن.\n\n```\n1. داخل کد\n```\n\n2. ب\nمتن.'
  const s = splitSections(md)
  check('دو بخش', s.length === 2 && s[0]?.title === 'الف' && s[1]?.title === 'ب', s)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')