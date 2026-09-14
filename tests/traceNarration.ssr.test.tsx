// تست SSR برای رندر narration (TraceNarration) و کپشن‌های per-call داخل گروه.
// پوشش:
//  - متن کوتاهِ قبل از فراخوانی تکی → ردیف .trace-narration جدا بالای ردیف ابزار
//    (مثل Claude.ai که خط روایت و ردیف ابزار در یک کارت درمی‌آمیزند)
//  - باگ «گروه‌های جدا»: در الگوی «caption، ابزار، caption، ابزار» همهٔ
//    فراخوانی‌ها باید در «یک» گروه واحد بمانند (کپشن‌ها per-call داخل پنل)
//    و ران به چند گروه/کارت جدا شکسته نشود
//  - باگ «narration بلند ران را می‌شکست»: متنِ بلند/چندخطی بین دو دستهٔ
//    ابزار هم narration است (سقف ۲۶۰ کاراکتر/۲ خط حذف شد) — ران یکی می‌ماند
//  - متن حاوی بلوک کد (```) → محتوای واقعی است → prose معمولی (نه narration)
//  - گروه ۲+ فراخوانی بدون narration → فقط سرِ گروه، بدون ردیف narration
//  - گروه ۲+ فراخوانی با narration → کپشن داخل خود گروه (در سرِ گروه)، نه
//    ردیف جدا بیرون آن — رفع نمایش تکراری آخرین کپشن
//  - باگ «گروه باز حین استریم بسته می‌شود»: کلید کارت trace (والدِ گروه)
//    باید به اولین فعالیتِ ران لنگر شود، نه به نقطهٔ flush — وگرنه هر فراخوانی
//    جدید وسط narration، کلید والد را عوض می‌کند و ری‌اکت با unmount کردن
//    زیردرخت، گروهِ بازشده را می‌بندد (state از بین می‌رود)
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
const { ChatMessageView, renderSegments } = await import('../src/components/ChatMessage')

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

console.log('2) الگوی واقعی داده‌ها: caption، ابزار، caption، ابزار → یک گروه واحد (کپشن‌ها per-call داخل گروه):')
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
  // باگ «گروه‌های جدا»: caption بین دو ابزار نباید ران را بشکند — هر دو
  // فراخوانی در «یک» گروه واحد می‌مانند و هر کپشن به فراخوانی خودش می‌چسبد.
  check('یک گروه واحد رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('ردیف narration جدا بیرون گروه ندارد', !html.includes('trace-narration'))
  // آخرین کپشن عنوان سرِ گروه است (مثل Claude.ai)؛ کپشن اول فقط داخل پنل
  // بازشده رندر می‌شود (گروه در SSR بسته است) — با باز شدن گروه ظاهر می‌شود.
  check('کپشن اول فقط در پنل بازشده است', !html.includes('اول فایل اول را می‌خوانم'))
  check('کپشن دوم عنوان سرِ گروه است', html.includes('حالا فایل دوم را می‌خوانم'))
}

console.log('3) باگ «narration بلند»: متن بلند/چندخطی بین ابزارها → هنوز یک گروه واحد:')
{
  // متن بلند (بیش از سقف قدیمی ۲۶۰ کاراکتر) + چندخطی بین دو دستهٔ ابزار —
  // باید narration بماند و ران را نشکند (قبلاً flush می‌شد و گروه جدا می‌افتاد).
  const long = 'این یک متن روایی خیلی طولانی است که مدل قبل از جست‌وجوی بعدی می‌نویسد. '.repeat(6)
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'text', text: long },
      { kind: 'tool', index: 1 },
    ],
    ['grep', 'grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('فقط یک گروه رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('به‌عنوان prose رندر نشد', !html.includes('markdown-body'))
  check('کپشن بلند عنوان سرِ گروه است', html.includes('trace-head-caption'))
  check('متن کپشن بلند نمایش داده شد', html.includes('این یک متن روایی خیلی طولانی'))
}

console.log('3ب) متن حاوی بلوک کد (```) → محتوای واقعی، نه narration:')
{
  // بلوک کد محتوای واقعی است — باید prose بماند و ران را بشکند.
  const withCode = 'نتیجه این است:\n```js\nconsole.log(1)\n```\nادامه.'
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'text', text: withCode },
      { kind: 'tool', index: 1 },
    ],
    ['grep', 'grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('به‌عنوان prose رندر شد', html.includes('markdown-body'))
  // ران می‌شکند: هر ابزار در کارت trace جدا می‌افتد (فراخوانی تکی = ToolSingleRow)
  check('کد ران را شکست (دو کارت trace جدا)', (html.match(/tool-trace/g) || []).length === 2)
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

console.log('9) badge تعداد (×N) همیشه کامل رندر می‌شود:')
{
  // ۶ فراخوانی grep + کپشن بلند که سرِ گروه را پر می‌کند — badge «×6»
  // باید کامل در HTML باشد (CSS فقط wrap می‌کند، هرگز clip/truncate نمی‌کند).
  const msg = makeMessage(
    [
      { kind: 'text', text: 'کپشن بلندی که فضای سرِ گروه را می‌گیرد…' },
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'tool', index: 2 },
      { kind: 'tool', index: 3 },
      { kind: 'tool', index: 4 },
      { kind: 'tool', index: 5 },
    ],
    ['grep', 'grep', 'grep', 'grep', 'grep', 'grep'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  // در SSR ری‌اکت بین «×» و عدد کامنت HTML (<!-- -->) می‌گذارد — الگو باید
  // هر دو حالت (با/بدون کامنت) را بگیرد تا badge کامل رندر شده باشد.
  check('badge ×6 رندر شد', /×(?:<!-- -->)?6/.test(html))
  check('کلاس trace-pill-count حذف نشد', html.includes('trace-pill-count'))
  check('فقط یک گروه رندر شد', (html.match(/tool-group/g) || []).length === 1)
}

console.log('10) متن فقط-فاصله بین ابزارها → ران نمی‌شکند و prose خالی رندر نمی‌شود:')
{
  // مدل گاهی بین دو فراخوانی پشت‌سرهم فقط «\n\n» می‌فرستد (بدون narration).
  // قبلاً این متن به‌عنوان prose واقعی flush می‌کرد: ران می‌شکست، کارت trace
  // بسته می‌شد و یک div خالی هم رندر می‌شد — شکستن نامرئی گروه‌ها. حالا
  // باید کامل نادیده گرفته شود.
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'text', text: '\n\n' },
      { kind: 'tool', index: 1 },
      { kind: 'text', text: '   \n\t ' },
      { kind: 'tool', index: 2 },
    ],
    ['read', 'read', 'read'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('یک گروه واحد رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('سه فراخوانی ادغام شدند (×3)', /×(?:<!-- -->)?3/.test(html))
  check('prose خالی رندر نشد', !html.includes('markdown-body'))
  check('فقط یک کارت trace دارد', (html.match(/tool-trace/g) || []).length === 1)
}

console.log('11) سناریوی عکس ۱: caption/فقط-فاصله بین ابزارها → ۳تای بالا یک گروه؛ prose واقعی → ۲تای پایین یک گروه:')
{
  const msg = makeMessage(
    [
      { kind: 'text', text: 'بذار ببینم فایل اول کجاست…' },
      { kind: 'tool', index: 0 },
      { kind: 'text', text: '\n\n' },
      { kind: 'tool', index: 1 },
      { kind: 'text', text: 'حالا سومی را می‌خوانم' },
      { kind: 'tool', index: 2 },
      { kind: 'text', text: 'نتیجهٔ بررسی:\n```\nconst x = 1\n```\nادامهٔ تحلیل' },
      { kind: 'tool', index: 3 },
      { kind: 'text', text: '  \n ' },
      { kind: 'tool', index: 4 },
    ],
    ['read', 'read', 'read', 'read', 'read'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('دو گروه رندر شد (۳تایی و ۲تایی)', (html.match(/tool-group/g) || []).length === 2)
  check('گروه اول ×3 دارد', /×(?:<!-- -->)?3/.test(html))
  check('گروه دوم ×2 دارد', /×(?:<!-- -->)?2/.test(html))
  check('prose واقعی (بلوک کد) رندر شد', html.includes('markdown-body'))
}

console.log('12) سناریوی عکس ۲: دو دسته ابزار با فقط-فاصله بین‌شان → یک گروه واحد، نه دو کارت پشت‌سرهم:')
{
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'tool', index: 2 },
      { kind: 'text', text: '\n\n' },
      { kind: 'tool', index: 3 },
      { kind: 'tool', index: 4 },
    ],
    ['read', 'run_terminal', 'read', 'run_terminal', 'read'],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('یک گروه واحد رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('pill های read ×3 و Ran a command ×2 هر دو دارد', /×(?:<!-- -->)?3/.test(html) && /×(?:<!-- -->)?2/.test(html))
  check('کارت trace دومی وجود ندارد', (html.match(/tool-trace/g) || []).length === 1)
}

console.log('13) باگ «گروه باز حین استریم بسته می‌شود»: کلید کارت trace والدِ گروه در همهٔ رندرها یکی می‌ماند:')
{
  // رندر ۱ (وسط استریم): narration دوم تازه رسیده و فراخوانیِ بعدش هنوز
  // نرسیده → موقتاً prose واقعی حساب می‌شود و رانِ جاری flush می‌شود.
  // رندر ۲ (نهایی): فراخوانی سوم رسید → همان narration حالا caption است و
  // کل ران در «همان» کارت trace flush می‌شود. اگر کلید کارت بین دو رندر
  // عوض شود (کلید پوزیشنال قدیمی: trace-3 ↔ trace-end) ری‌اکت کل زیردرخت
  // را unmount می‌کند و state باز/بستهٔ گروهِ بازشده از بین می‌رود — گروه
  // باید فقط با کلیک خود کاربر بسته شود، نه با رسیدن فراخوانی جدید.
  const mid = makeMessage(
    [
      { kind: 'text', text: 'اول فایل اول را می‌خوانم…' },
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'text', text: 'حالا فایل سوم را می‌خوانم…' },
    ],
    ['read', 'read'],
  )
  const fin = makeMessage(
    [
      { kind: 'text', text: 'اول فایل اول را می‌خوانم…' },
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'text', text: 'حالا فایل سوم را می‌خوانم…' },
      { kind: 'tool', index: 2 },
    ],
    ['read', 'read', 'read'],
  )
  const traceCard = (msg: ReturnType<typeof makeMessage>) =>
    renderSegments(msg).find(
      (n) => typeof n === 'object' && n !== null && (n as any).props?.className === 'tool-trace',
    ) as any
  const card1 = traceCard(mid)
  const card2 = traceCard(fin)
  check('کارت trace در هر دو رندر وجود دارد', !!card1 && !!card2)
  check(
    `کلید کارت trace پایدار ماند (${card1?.key} === ${card2?.key})`,
    !!card1?.key && card1.key === card2.key,
  )
  // گروه داخل کارت هم باید همان هویت grp-{اولین ایندکس} را نگه دارد.
  // (کلاس tool-group داخل خود ToolGroupView رندر می‌شود، نه در props —
  // پس element گروه را با props.activities شناسایی می‌کنیم.)
  const groupOf = (card: any) => {
    const kids = Array.isArray(card.props.children)
      ? card.props.children
      : [card.props.children]
    return kids.find((c: any) => Array.isArray(c?.props?.activities))
  }
  check(
    `کلید گروه پایدار ماند (${groupOf(card1)?.key} === ${groupOf(card2)?.key})`,
    groupOf(card1)?.key === groupOf(card2)?.key && !!groupOf(card1)?.key,
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
