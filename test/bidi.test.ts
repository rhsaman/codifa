// Unit tests for the bidi helpers used by the chat renderer (mixed Persian+English
// text direction detection and model-injected control-character cleanup).
// Run: node test/bidi.test.ts
import { RTL_CHAR_RE, detectDir, stripBidiMarks, fixZwsp, prepareContent, applyRtlToSvgText } from '../src/lib/bidi.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) RTL_CHAR_RE: تشخیص کاراکتر فارسی:')
{
  check('فارسی مثبت', RTL_CHAR_RE.test('سلام'))
  check('انگلیسی منفی', !RTL_CHAR_RE.test('hello'))
}

console.log('2) detectDir: جهت کانتینر از کل متن (نه فقط اولین کاراکتر):')
{
  check('متن فارسی → rtl', detectDir('کاربر: سئوی hamemigan.com رو بین') === 'rtl')
  check('متن انگلیسی → ltr', detectDir('just english text') === 'ltr')
  check('باز شدن با لاتین باز هم rtl', detectDir('API key رو بده') === 'rtl')
}

console.log('3) stripBidiMarks: حذف کنترل‌کاراکترهای جهت‌دهی مدل (LRI/PDI):')
{
  const out = stripBidiMarks('a\u2066b\u2069c')
  check('کنترل‌کاراکترها حذف شدند', out === 'abc', out)
}

console.log('4) fixZwsp: جداکنندهٔ نامرئی بین دو کلمه → فاصله:')
{
  const out = fixZwsp('سلام\u200Bجهان')
  check('ZWSP بین کلمه‌ها به فاصله تبدیل شد', out === 'سلام جهان', out)
}

console.log('5) prepareContent: پاکسازی متن آمادهٔ نمایش:')
{
  const out = prepareContent('کاربر\u2066X\u2069 گفت')
  check('کنترل‌کاراکترها حذف شدند', out === 'کاربرX گفت', out)
}

console.log('6) applyRtlToSvgText: نود فارسی → dir="auto"، نود انگلیسی دست‌نخورده:')
{
  const fa = '<text x="10" y="20">کاربر: سئوی hamemigan.com</text>'
  const out = applyRtlToSvgText(fa)
  check('نود فارسی dir=auto می‌گیره', out.includes('dir="auto"') && out.includes('>کاربر: سئوی hamemigan.com</text>'), out)

  const en = '<text x="10" y="20">just english</text>'
  check('نود انگلیسی دست‌نخورده می‌ماند', applyRtlToSvgText(en) === en, applyRtlToSvgText(en))

  const nested = '<text x="1" y="2">a<tspan>متن فارسی</tspan>b</text>'
  const nout = applyRtlToSvgText(nested)
  check('محتوای فارسی کل text رو dir=auto می‌کند', nout.includes('<text dir="auto" x="1" y="2">') && nout.includes('<tspan dir="auto">متن فارسی</tspan>'), nout)

  const dup = '<text dir="ltr" x="1" y="2">متن فارسی</text>'
  check('dir موجود بازنویسی نمی‌شود', applyRtlToSvgText(dup) === dup, applyRtlToSvgText(dup))

  // برچسب مختلطی که با لاتین شروع می‌شود نباید کلش RTL بازترتیب شود (وایران شدن
  // بخش لاتین). dir=auto جهت را از اولین کاراکتر قوی تشخیص می‌دهد → LTR می‌ماند
  // و فقط بخش فارسی انتهایی درست نمایش داده می‌شود.
  const mixed = '<text x="10" y="20">shutdown ... .پایان کار شما</text>'
  const mout = applyRtlToSvgText(mixed)
  check('برچسب مختلط با لاتین dir=auto می‌گیرد (نه rtl)', mout.includes('dir="auto"') && !mout.includes('dir="rtl"'), mout)
}

console.log('7) applyRtlToSvgText: برچسب‌های HTML درون foreignObject (htmlLabels پیش‌فرض mermaid):')
{
  // mermaid با htmlLabels:true برچسب نود را به‌صورت <div> درون <foreignObject>
  // رندر می‌کند؛ کانتینر dir="ltr" است پس متن فارسی باید خودش dir="auto" بگیرد.
  const fo = '<foreignObject x="0" y="0" width="100" height="40"><div>کاربر: سنوی hamemigan.com</div></foreignObject>'
  const out = applyRtlToSvgText(fo)
  check('div فارسی درون foreignObject dir=auto می‌گیرد', out.includes('<div dir="auto">کاربر: سنوی hamemigan.com</div>'), out)

  const enFo = '<foreignObject x="0" y="0" width="100" height="40"><div>just english</div></foreignObject>'
  check('div انگلیسی دست‌نخورده می‌ماند', applyRtlToSvgText(enFo) === enFo, applyRtlToSvgText(enFo))

  const dupFo = '<foreignObject x="0" y="0" width="100" height="40"><div dir="ltr">متن فارسی</div></foreignObject>'
  check('dir موجود درون foreignObject بازنویسی نمی‌شود', applyRtlToSvgText(dupFo) === dupFo, applyRtlToSvgText(dupFo))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
