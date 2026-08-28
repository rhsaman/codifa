// تست واحد برای dedupeChats: حذف چت‌های هم‌شناسه (id یکسان) در بارگذاری.
// دو چت با id یکسان باعث می‌شد منوی ۳ نقطه برای هر دو ردیف باز شود (چون منو
// بر اساس chat id کلید می‌خورد). این تست تضمین می‌کند که فقط یک نمونه باقی
// می‌ماند و آخرین رخداد (جدیدترین داده) برنده است.
// اجرا: npx esbuild src/lib/store.dedupe.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-dedupe.mjs && node src/lib/.tmp-dedupe.mjs

// store.ts هنگام بارگذاریِ سطح ماژول به window.coder وابسته است؛ پس باید
// window را پیش از import تعریف کنیم (هم‌الگو با tests/retryStore.test.ts).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { dedupeChats } = await import('./store')

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) آرایهٔ بدون تکرار دست‌نخورده باقی می‌ماند:')
{
  const chats = [
    { id: 'a', title: 'اول' },
    { id: 'b', title: 'دوم' },
    { id: 'c', title: 'سوم' },
  ] as any[]
  const out = dedupeChats(chats)
  check('طول تغییر نمی‌کند', out.length === 3, out.length)
  check('ترتیب حفظ می‌شود', out.map((c) => c.id).join(',') === 'a,b,c')
}

console.log('۲) دو چت با id یکسان به یکی تقلیل می‌یابند (آخرین برنده است):')
{
  const chats = [
    { id: 'dup', title: 'قدیمی' },
    { id: 'b', title: 'دوم' },
    { id: 'dup', title: 'جدید' },
  ] as any[]
  const out = dedupeChats(chats)
  check('فقط دو چت باقی می‌ماند', out.length === 2, out.length)
  check('id تکراری فقط یک بار ظاهر می‌شود', out.filter((c) => c.id === 'dup').length === 1)
  const dup = out.find((c) => c.id === 'dup')
  check('آخرین رخداد (جدیدترین داده) برنده است', !!dup && dup.title === 'جدید', dup)
  check('ترتیب نسبی حفظ می‌شود', out.map((c) => c.id).join(',') === 'b,dup')
}

console.log('۳) چت بدون id نادیده گرفته می‌شود:')
{
  const chats = [
    { id: 'a', title: 'اول' },
    { title: 'بی‌شناسه' } as any,
    { id: 'b', title: 'دوم' },
  ] as any[]
  const out = dedupeChats(chats)
  check('فقط چت‌های دارای id باقی می‌مانند', out.length === 2, out.length)
  check('هیچ چت بی‌شناسه‌ای نیست', out.every((c) => !!c.id))
}

console.log('۴) آرایهٔ خالی آرایهٔ خالی برمی‌گرداند:')
{
  const out = dedupeChats([])
  check('طول صفر است', out.length === 0, out.length)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
