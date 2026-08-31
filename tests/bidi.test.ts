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

console.log('6b) foldLineCaptions: فرمت path:line (مثل changePhoneConfirm.go:32):')
{
  // مدل نام فایل و شماره لاین را با فرمت غربی path:line می‌نویسد؛ باید به
  // فنس بعدی چسبانده شود تا هدر نام فایل و لاین واقعی را نشان دهد.
  const out = prepareContent('توی changePhoneConfirm.go:32 تغییر شماره فقط فیلد phone رو آپدیت میکنه:\n\n```go\ndb.UpdateOne("_id", userID, map[string]any{"phone": newPhone}, "user")\n```')
  check('فنس lang:start-end:path می‌گیرد', out.includes('```go:32-32:changePhoneConfirm.go'), out)
  check('کپشن path:line از متن حذف نشد (فقط به فنس چسبید)', out.includes('changePhoneConfirm.go:32'), out)
}

console.log('6c) foldLineCaptions: path:line-line (مثل Plan.go:19-20):')
{
  const out = prepareContent('در Plan.go:19-20 اینطوریه:\n\n```go\nx := 1\ny := 2\n```')
  check('فنس range را با path می‌گیرد', out.includes('```go:19-20:Plan.go'), out)
}

console.log('6d) foldLineCaptions: path:line بدون فنس بعدی فقط lastPath را ست می‌کند:')
{
  // اگر فنسی نباشد، خط نباید حذف شود و path باید برای فنس‌های بعدی یادآوری شود.
  const out = prepareContent('فایل changePhoneConfirm.go:32 را ببین.\n\n```go\ndb.UpdateOne("_id", userID, map[string]any{"phone": newPhone}, "user")\n```')
  check('فنس بعدی path را از lastPath می‌گیرد', out.includes('```go:32-32:changePhoneConfirm.go'), out)
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

console.log('8) foldLineCaptions: فرمت path:line (مثل changePhoneConfirm.go:32):')
{
  // مدل گاهی نام فایل و شماره لاین را با کولون مینویسد (نه «خط N»). این باید
  // در فنس بعدی به صورت lang:start-end:path تزریق شود تا هدر نام فایل و لاین
  // درست را نشان دهد.
  const out = prepareContent('توی changePhoneConfirm.go:32 تغییر شماره فقط فیلد phone رو آپدیت میکنه:\n```go\ndb.UpdateOne("_id", userID, map[string]any{"phone": newPhone}, "user")\n```')
  check('فنس lang:start-end:path می‌گیرد', out.includes('```go:32-32:changePhoneConfirm.go'), out)
  check('کپشن path:line حذف نمی‌شود (متن دست‌نخورده می‌ماند)', out.includes('changePhoneConfirm.go:32'), out)
}

console.log('9) foldLineCaptions: path:line-line (مثل Plan.go:19-20):')
{
  const out = prepareContent('در Plan.go:19-20 کد اینطوریه:\n```go\nx := 1\ny := 2\n```')
  check('فنس lang:start-end:path با رنج می‌گیرد', out.includes('```go:19-20:Plan.go'), out)
}

console.log('10) foldLineCaptions: path:line روی فنس‌های بعدی (lastPath):')
{
  // وقتی مدل مسیر را یکبار با :line می‌نویسد، فنس‌های بعدی که فقط lang:start-end
  // دارند باید همان مسیر را از lastPath بگیرند (بدون تغییرِ شماره لاینِ خودشان).
  const out = prepareContent('توی changePhoneConfirm.go:32 بررسی کن:\n\n```go:40-41\nz := 3\n```')
  check('فنس بعدی مسیر را از lastPath می‌گیرد', out.includes('```go:40-41:changePhoneConfirm.go'), out)
  check('شماره لاینِ فنسِ بعدی دست‌نخورده می‌ماند', out.includes('```go:40-41:changePhoneConfirm.go'), out)
}

console.log('8) foldLineCaptions: فرمت path:line (مثل changePhoneConfirm.go:32):')
{
  // مدل گاهی نام فایل و شماره لاین را با فرمت غربی `path:line` مینویسد (نه
  // «خط N»). باید در فنس بعدی به‌صورت lang:start-end:path تزریق شود تا هدرِ
  // بلاک کد نام فایل و شماره لاینِ واقعی را نشان دهد.
  const out = prepareContent('توی changePhoneConfirm.go:32 تغییر شماره فقط فیلد phone رو آپدیت میکنه:\n\n```go\ndb.UpdateOne("_id", userID, map[string]any{"phone": newPhone}, "user")\n```')
  check('نام فایل و لاین به فنس تزریق شد', out.includes('```go:32-32:changePhoneConfirm.go'), out)
  check('کپشن path:line از متن حذف نشد (بخشی از پروز است)', out.includes('changePhoneConfirm.go:32'), out)
}

console.log('9) foldLineCaptions: فرمت path:line-line (مثل Plan.go:19-20):')
{
  const out = prepareContent('در Plan.go:19-20 اینطوریه:\n\n```go\nx := 1\ny := 2\n```')
  check('بازه لاین به فنس تزریق شد', out.includes('```go:19-20:Plan.go'), out)
}

console.log('10) foldLineCaptions: path:line بدون فنس بعدی فقط path را یاد می‌دهد:')
{
  // اگر فنسی نباشد، خط نباید تغییر کند (فقط path در lastPath ذخیره میشود).
  const out = prepareContent('ببین changePhoneConfirm.go:32 را')
  check('خط path:line بدون فنس دست‌نخورده می‌ماند', out === 'ببین changePhoneConfirm.go:32 را', out)
}

console.log('11) <br/> بیرون بلوک کد → \\n تبدیل شود:')
{
  const out = prepareContent('مرحله ۱</br>مرحله ۲<br/>مرحله ۳')
  check('<br/> → \\n', out === 'مرحله ۱\nمرحله ۲\nمرحله ۳', out)
}

console.log('12) <br/> داخل بلوک کد → دست‌نخورده بماند:')
{
  const out = prepareContent('متن\n\n```html\n<br/>\n```')
  check('<br/> داخل کد حفظ شد', out.includes('<br/>'), out)
}

console.log('13) <br/> ترکیبی (بیرون + داخل):')
{
  const out = prepareContent('خط اول<br/>خط دوم\n\n```html\n<br/>\n```')
  check('بیرون تبدیل شد', out.startsWith('خط اول\nخط دوم'), out)
  check('داخل حفظ شد', out.includes('<br/>'), out)
}

console.log('14) خط connector فارسی «تا»: خط ۱۹ تا ۲۰')
{
  const out = prepareContent('خط ۱۹ تا ۲۰ در Plan.go:\n\n```go\nx := 1\n```')
  check('بازه با تا تزریق شد', out.includes('```go:19-20:Plan.go'), out)
}

console.log('15) خط connector فارسی «الی»: خط ۱۹ الی ۲۰')
{
  const out = prepareContent('خط ۱۹ الی ۲۰ در Plan.go:\n\n```go\nx := 1\n```')
  check('بازه با الی تزریق شد', out.includes('```go:19-20:Plan.go'), out)
}

console.log('16) خط با em dash: خط ۱۹—۲۰')
{
  const out = prepareContent('خط ۱۹—۲۰ در Plan.go:\n\n```go\nx := 1\n```')
  check('بازه با em dash تزریق شد', out.includes('```go:19-20:Plan.go'), out)
}

console.log('17) فنس با ارقام فارسی در range:')
{
  const out = prepareContent('خط ۱۹ تا ۲۰ در Plan.go:\n\n```go:۱۹-۲۰\nx := 1\n```')
  check('اقلام فارسی به لاتین تبدیل شد', out.includes('```go:19-20:Plan.go'), out)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
