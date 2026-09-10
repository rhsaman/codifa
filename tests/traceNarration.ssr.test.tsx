// تست SSR برای رندر narration (TraceNarration) و کپشن‌های per-call داخل گروه.
// پوشش:
//  - متن کوتاهِ قبل از فراخوانی تکی → ردیف .trace-narration جدا بالای ردیف ابزار
//    (مثل Claude.ai که خط روایت و ردیف ابزار در یک کارت درمی‌آمیزند)
//  - باگ «گروه‌های جدا»: در الگوی «caption، ابزار، caption، ابزار» همهٔ
//    فراخوانی‌ها باید در «یک» گروه واحد بمانند (کپشن‌ها per-call داخل پنل)
//    و ران به چند گروه/کارت جدا شکسته نشود
//  - متن بلند/فرمت‌دار → پاراگراف prose معمولی (نه narration)
//  - گروه ۲+ فراخوانی بدون narration → فقط سرِ گروه، بدون ردیف narration
//  - گروه ۲+ فراخوانی با narration → کپشن داخل خود گروه (در سرِ گروه)، نه
//    ردیف جدا بیرون آن — رفع نمایش تکراری آخرین کپشن
// Mock پل الکترون قبل از import کامپوننت.
;(globalThis as any).window = {
  addEventListener: () => {},
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

const { renderToString } = await import('react-dom/server')
const { ChatMessageView } = await import('../src/components/ChatMessage')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

/** ساخت پیام assistant با segments داده‌شده + toolActivity متناظر. */
function makeMessage(
  segments: Array<{ kind: 'text'; text: string } | { kind: 'tool'; index: number }>,
  tools: Array<string | { tool: string; elapsedMs?: number }>,
) {
  return {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: segments as never,
    toolActivity: tools.map((t) => {
      const spec = typeof t === 'string' ? { tool: t } : t
      return {
        tool: spec.tool,
        status: 'done' as const,
        summary: 'ok',
        args: { path: 'src/a.ts' },
        elapsedMs: spec.elapsedMs,
      }
    }) as never,
  }
}

console.log('1) narration کوتاه قبل از ابزار تکی → ردیف trace-narration داخل کارت trace:')
{
  const msg = makeMessage(
    [
      { kind: 'text', text: 'بذار ببینم این فایل کجاست…' },
      { kind: 'tool', index: 0 },
    ],
    ['grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('کارت trace رندر شد', html.includes('tool-trace'))
  check('ردیف narration دارد', html.includes('trace-narration'))
  check('متن narration نمایش داده شد', html.includes('بذار ببینم این فایل کجاست'))
  check('ردیف ابزار تکی دارد', html.includes('trace-row'))
  check('narration قبل از ردیف ابزار است', html.indexOf('trace-narration') < html.indexOf('trace-row-head'))
  check('کلاس narrated ادغام‌شده حذف شد', !html.includes('narrated'))
}

console.log('2) باگ «گروه‌های جدا»: caption، ابزار، caption، ابزار → یک گروه واحد:')
{
  const msg = makeMessage(
    [
      { kind: 'text', text: 'اول فایل اول را می‌خوانم…' },
      { kind: 'tool', index: 0 },
      { kind: 'text', text: 'حالا فایل دوم را می‌خوانم…' },
      { kind: 'tool', index: 1 },
    ],
    ['read', 'read'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  // کل ران باید یک گروه واحد بماند — نه دو گروه/کارت جدا:
  check('فقط یک گروه رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('ردیف narration جدا بیرون گروه ندارد', !html.includes('trace-narration'))
  // آخرین کپشن باید عنوان سرِ گروه باشد (مثل Claude.ai):
  check('آخرین کپشن عنوان سرِ گروه است', html.includes('trace-head-caption'))
  check('متن آخرین کپشن در سرِ گروه', html.includes('حالا فایل دوم را می‌خوانم'))
  // کپشن اول فقط داخل پنل بازشده رندر می‌شود (گروه در SSR بسته است) —
  // پس در HTML جمع‌شده نباید دیده شود؛ با باز شدن گروه ظاهر می‌شود.
  check('کپشن اول فقط در پنل بازشده است', !html.includes('اول فایل اول را می‌خوانم'))
}

console.log('3) متن بلند/فرمت‌دار → prose معمولی، نه narration:')
{
  const long = 'این یک متن خیلی طولانی است. '.repeat(20)
  const msg = makeMessage(
    [
      { kind: 'text', text: long },
      { kind: 'tool', index: 0 },
    ],
    ['grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('ردیف narration ندارد', !html.includes('trace-narration'))
  check('به‌عنوان prose رندر شد', html.includes('markdown-body'))
}

console.log('4) گروه ۲+ ابزار بدون narration → فقط سرِ گروه:')
{
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    ['read', 'grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('سرِ گروه رندر شد', html.includes('trace-head'))
  check('ردیف narration ندارد', !html.includes('trace-narration'))
}

console.log('5) گروه ۲+ ابزار با narration → کپشن داخل گروه، نه ردیف جدا:')
{
  const msg = makeMessage(
    [
      { kind: 'text', text: 'دنبال تعریف تابع می‌گردم…' },
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    ['read', 'grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('سرِ گروه رندر شد', html.includes('trace-head'))
  check('کپشن داخل سرِ گروه است', html.includes('trace-head-caption'))
  check('متن کپشن در سرِ گروه نمایش داده شد', html.includes('دنبال تعریف تابع می‌گردم'))
  check('ردیف narration جدا بیرون گروه ندارد', !html.includes('trace-narration'))
}

console.log('6) کپشن یتیم (بدون ابزار بعدش) → prose، نه حذف:')
{
  const msg = makeMessage(
    [
      { kind: 'text', text: 'این را نگه می‌دارم برای بعد…' },
    ],
    [],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  // بدون ابزار بعدش، nextIsGroupable نیست → از اول prose است؛ ولی مسیر
  // دفاعی flush (کپشن نگه‌داشته‌شده در پایان ران) نباید متن را حذف کند.
  check('متن حذف نشد', html.includes('این را نگه می‌دارم برای بعد'))
  check('به‌عنوان prose رندر شد', html.includes('markdown-body'))
}

console.log('7) کپشن‌ها از خط لولهٔ bidi متن‌ها (prepareContent) عبور می‌کنند:')
{
  // ZWSP بین «فارسی» و «english» باید به فاصلهٔ واقعی تبدیل شود و
  // جداکنندهٔ bidi (LRE) حذف شود — همان کاری که با متن‌های prose می‌شود.
  const dirty = 'بررسی\u200Bconfig.ts\u202A در ادامه'
  const msg = makeMessage(
    [
      { kind: 'text', text: dirty },
      { kind: 'tool', index: 0 },
    ],
    ['grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('ZWSP به فاصله تبدیل شد', html.includes('بررسی config.ts'))
  check('جداکنندهٔ bidi حذف شد', !html.includes('\u202A'))
  check('متن کپشن نمایش داده شد', html.includes('در ادامه'))
}

console.log('8) مدت زمان: بیش از ۶۰ ثانیه → دقیقه + ثانیه:')
{
  // ۷۲ ثانیه → «1m 12s»؛ ۶۰ ثانیه دقیق → «1m»؛ زیر ۶۰ ثانیه → همان s
  const msg = makeMessage(
    [
      { kind: 'text', text: 'جست‌وجوی طولانی…' },
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    [
      { tool: 'grep', elapsedMs: 42000 },
      { tool: 'read', elapsedMs: 30000 },
    ],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('۷۲ ثانیه به «1m 12s» تبدیل شد', html.includes('1m 12s'))
  check('مقدار خام ms نمایش داده نشد', !html.includes('72000'))
  // ۹۰ دقیقه‌ای هم نباید «5400s» شود:
  const msg2 = makeMessage(
    [{ kind: 'tool', index: 0 }],
    [{ tool: 'task', elapsedMs: 5400000 }],
  )
  const html2 = renderToString(<ChatMessageView message={msg2} />)
  check('۹۰ دقیقه به «90m» تبدیل شد', html2.includes('90m'))
  check('ثانیه‌های خام نمایش داده نشد', !html2.includes('5400s'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
