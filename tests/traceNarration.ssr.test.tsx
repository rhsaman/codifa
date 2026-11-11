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
//  - کارت ساب‌ایجنت (explore/agent__) دیگر کارت اختصاصی ندارد: همان
//    ToolGroupView رندر می‌شود با pill نام ساب‌ایجنت در هدر، tallies ابزارهای
//    داخلی و آخرین خط narration به‌عنوان caption
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
  tools: Array<
    | string
    | {
        tool: string
        elapsedMs?: number
        startedAt?: number
        status?: 'done' | 'running'
      }
  >,
  streaming = false,
) {
  return {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    streaming,
    segments: segments as never,
    toolActivity: tools.map((t) => {
      const spec = typeof t === 'string' ? { tool: t } : t
      return {
        tool: spec.tool,
        status: spec.status ?? ('done' as const),
        summary: 'ok',
        args: { path: 'src/a.ts' },
        elapsedMs: spec.elapsedMs,
        startedAt: spec.startedAt,
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

console.log('3) محدودیت کپشن: متن بلند/چندخطی بین ابزارها → prose بیرون از گروه:')
{
  // فقط جواب‌های کوتاه داخل گروه ابزار می‌مانند؛ متنِ بلند (بیش از ۲۶۰
  // کاراکتر) محتوای واقعی است و باید مثل prose معمولی بیرونِ گروه رندر شود —
  // وگرنه پاسخ ایجنت داخل کارت گروه گیر می‌کند.
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
  check('به‌عنوان prose رندر شد (بیرون گروه)', html.includes('markdown-body'))
  check('داخل سرِ گروه نرفت', !html.includes('trace-head-caption'))
  check('ران شکست (دو کارت trace جدا)', (html.match(/tool-trace/g) || []).length === 2)
  check('متن بلند نمایش داده شد', html.includes('این یک متن روایی خیلی طولانی'))

  // متن کوتاه در مجموع کاراکتر ولی بیش از ۲ خط → باز هم prose (سقف خط).
  const multiline = 'خط اول\nخط دوم\nخط سوم'
  const msg2 = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'text', text: multiline },
      { kind: 'tool', index: 1 },
    ],
    ['grep', 'grep'],
  )
  const html2 = renderToString(<ChatMessageView message={msg2} />)
  check('متن چندخطی (>۲ خط) هم prose شد', html2.includes('markdown-body'))
  check('چندخطی داخل گروه نرفت', !html2.includes('trace-head-caption'))
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
  check('کپشن داخل سرِ گروه است (trace-head-text)', html.includes('trace-head-text'))
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
  // متن narration از MarkdownProse می‌گذرد؛ رندرکنندهٔ bidi واژه‌های لاتین را
  // در span جزیره‌ای با علامت‌های isolate (U+2066/U+2069) می‌پیچد، پس تطبیق
  // باید روی متنِ بدون تگ و بدون کاراکترهای کنترل bidi باشد — فاصلهٔ واقعی
  // (تبدیل ZWSP) همچنان لازم است تا چک پاس شود.
  const plain = html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u200B-\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '')
  check('ZWSP به فاصله تبدیل شد', plain.includes('بررسی config.ts'))
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
    [{ tool: 'explore', elapsedMs: 5400000 }],
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
  // شمارش ×N از هدر حذف شده (user request): نام آخرین فراخوانی (Search Files
  // برای grep) قبل از متن هدر می‌آید و badge تعداد هیچ‌جا رندر نمی‌شود.
  check('badge تعداد (trace-pill-count) رندر نشد', !html.includes('trace-pill-count'))
  check('نام آخرین ابزار (Search Files) قبل از متن هدر است', /trace-head-tool[^>]*>Search Files</.test(html) && html.indexOf('trace-head-tool') < html.indexOf('trace-head-text'))
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
  check('سه فراخوانی در یک گروه، نام آخرین ابزار (Read File) در هدر', /trace-head-tool[^>]*>Read File</.test(html))
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
  check('هر گروه نام آخرین ابزارش را در هدر دارد (دو trace-head-tool)', (html.match(/trace-head-tool/g) || []).length === 2)
  check('گروه دوم ×2 ندارد — شمارش از هدر حذف شده', !/×(?:<!-- -->)?2/.test(html))
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
  check('نام آخرین ابزار گروه (Read File) در هدر است', /trace-head-tool[^>]*>Read File</.test(html))
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

console.log('14) کارت ساب‌ایجنت دقیقاً مثل tool group رندر می‌شود (نام در هدر + نام آخرین ابزار + caption):')
{
  // کارت delegation دیگر ExploreCard نیست: همان ToolGroupView با قاب
  // tool-trace؛ نام ساب‌ایجنت اولِ هدر، بعد نام آخرین فراخوانی داخلی، بعد
  // آخرین خط narration ساب‌ایجنت به‌عنوان caption (نریشن از narrationParts
  // می‌آید — قرارداد event ساب‌ایجنت).
  const msg = {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: [{ kind: 'tool', index: 0 }] as never,
    toolActivity: [
      {
        tool: 'explore',
        status: 'done' as const,
        summary: 'ok',
        args: { description: 'پیدا کردن تعریف store' },
        elapsedMs: 12000,
        narrationParts: [
          { after: 0, text: 'اول layout را می‌خوانم…' },
          { after: 2, text: 'حالا store را باز می‌کنم…' },
        ],
        children: [
          { tool: 'grep', status: 'done' as const, summary: 'ok', args: { pattern: 'useStore' } },
          { tool: 'grep', status: 'done' as const, summary: 'ok', args: { pattern: 'toolActivity' } },
          { tool: 'read', status: 'done' as const, summary: 'ok', args: { path: 'src/lib/store.ts' } },
        ],
      },
    ] as never,
  }
  const html = renderToString(<ChatMessageView message={msg} />)
  check('کارت با قاب tool-trace رندر شد', html.includes('tool-trace'))
  check('یک گروه واحد رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('نام ساب‌ایجنت («Explore») در هدر است', /trace-head-name[^>]*>Explore</.test(html))
  check('کارت explore قدیمی (tool-card explore) رندر نشد', !html.includes('tool-card explore') && !html.includes('explore-card-open'))
  // ترتیب هدر: نام ساب‌ایجنت → نام آخرین فراخوانی داخلی (read) → متن.
  check('نام آخرین ابزار داخلی (Read File) بعد از نام و قبل از متن', /trace-head-tool[^>]*>Read File</.test(html) && html.indexOf('trace-head-name') < html.indexOf('trace-head-tool') && html.indexOf('trace-head-tool') < html.indexOf('trace-head-text'))
  check('آخرین خط narration caption هدر است', html.includes('حالا store را باز می‌کنم'))
  check('خط اول narration در هدر نیست (فقط آخرین کپشن)', !html.includes('اول layout را می‌خوانم'))
  // توضیح وظیفه وقتی narration هست در متن هدر نمی‌آید؛ فقط وقتی اجرا حرفی
  // نزده باشد caption هدر می‌شود.
  const plainText = html.replace(/<!--.*?-->/g, '').replace(/<[^>]*>/g, '')
  check('توضیح وظیفه در متن هدر نیست', !plainText.includes('پیدا کردن تعریف store'))
  // اجرای ساکت (بدون narrationParts): توضیح وظیفه caption هدر می‌شود.
  const silent = {
    ...msg,
    toolActivity: [
      {
        tool: 'explore',
        status: 'done' as const,
        summary: 'ok',
        args: { description: 'پیدا کردن تعریف store' },
        elapsedMs: 12000,
        children: [{ tool: 'read', status: 'done' as const, summary: 'ok', args: { path: 'src/lib/store.ts' } }],
      },
    ] as never,
  }
  const htmlSilent = renderToString(<ChatMessageView message={silent} />)
  check('توضیح وظیفه در هدر اجرای ساکت caption است', htmlSilent.includes('پیدا کردن تعریف store'))
  check('زمان اجرا از elapsed ساب‌ایجنت می‌آید', html.includes('12.0s'))
  check('ردیف‌های داخلی فقط وقتی گروه باز است', !html.includes('trace-list'))
}

console.log('15) caption زندهٔ استریم: narration بین دو فراخوانی مستقیم در هدر آپدیت می‌شود، نه prose در چت:')
{
  // حین استریم، فراخوانی سوم هنوز نرسیده و متن narration تازه تایپ شده.
  // قبلاً همین متن prose چت می‌شد و با رسیدن فراخوانی بعدی به هدر می‌پرید —
  // حالا مستقیم caption زندهٔ هدر همان گروه است (user request).
  const mid = makeMessage(
    [
      { kind: 'text', text: 'اول فایل اول را می‌خوانم…' },
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'text', text: 'حالا فایل سوم را می‌خوانم…' },
    ],
    ['read', 'read'],
    true,
  )
  const html = renderToString(<ChatMessageView message={mid} />)
  check('یک گروه رندر شد', (html.match(/tool-group/g) || []).length === 1)
  check('نریشن prose چت نشد (بدون markdown-body)', !html.includes('markdown-body'))
  check('نریشن در متن سرِ گروه است', html.includes('حالا فایل سوم را می‌خوانم'))
  check('کپشن قبلی در هدر نیست (فقط تازه‌ترین)', !html.includes('اول فایل اول را می‌خوانم'))
  check('ردیف narration جدا رندر نشد', !html.includes('trace-narration'))
  // وقتی فراخوانی سوم برسد، همان گروه و همان متن ادامه پیدا می‌کند — کلید
  // گروه بین رندر caption زنده و رندر نهایی پایدار می‌ماند.
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
  const groupOf = (card: any) => {
    const kids = Array.isArray(card.props.children)
      ? card.props.children
      : [card.props.children]
    return kids.find((c: any) => Array.isArray(c?.props?.activities))
  }
  const cardMid = traceCard(mid)
  const cardFin = traceCard(fin)
  check(
    `کلید گروه بین caption زنده و caption نهایی پایدار است (${groupOf(cardMid)?.key})`,
    !!groupOf(cardMid)?.key && groupOf(cardMid)?.key === groupOf(cardFin)?.key,
  )
}

console.log('16) تک‌فراخوانی حین استریم با caption زنده → گروه (هدر دارد)؛ پایان ترن → ردیف تکی + prose:')
{
  const live = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'text', text: 'در ادامه تنظیمات را بررسی می‌کنم…' },
    ],
    ['read'],
    true,
  )
  const html = renderToString(<ChatMessageView message={live} />)
  check('گروه رندر شد (هدر برای caption زنده دارد)', html.includes('tool-group') && html.includes('trace-head'))
  check('ردیف تکی (trace-row single) نیست', !html.includes('trace-row single'))
  check('caption زنده در هدر است', html.includes('در ادامه تنظیمات را بررسی می‌کنم'))
  check('نام ابزار قبل از متن هدر است', html.indexOf('trace-head-tool') < html.indexOf('trace-head-text'))
  // پایان ترن (streaming=false): متن پاسخ نهایی است → prose بعد از ردیف تکی،
  // دقیقاً مثل قبل — متن از هدر به prose می‌رود، نه برعکس.
  const fin = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'text', text: 'در ادامه تنظیمات را بررسی می‌کنم…' },
    ],
    ['read'],
  )
  const htmlFin = renderToString(<ChatMessageView message={fin} />)
  check('پایان ترن: prose رندر شد', htmlFin.includes('markdown-body'))
  check('پایان ترن: گروه نیست (ردیف تکی)', !htmlFin.includes('tool-group'))
}

console.log('17) هدر گروه: نام آخرین فراخوانی قبل از متن می‌آید:')
{
  // بدون narration: فقط نام آخرین ابزار در هدر است (Read File برای read).
  const plain = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    ['grep', 'read'],
  )
  const html = renderToString(<ChatMessageView message={plain} />)
  check('نام آخرین ابزار (Read File) در هدر است', /trace-head-tool[^>]*>Read File</.test(html))
  check('نام ابزار قبل از متن هدر است', html.indexOf('trace-head-tool') < html.indexOf('trace-head-text'))
  // با narration: متن هدر = آخرین کپشن، نام ابزار = فراخوانی آخر.
  const narrated = makeMessage(
    [
      { kind: 'text', text: 'اول دنبال الگو می‌گردم…' },
      { kind: 'tool', index: 0 },
      { kind: 'text', text: 'حالا فایل را می‌خوانم…' },
      { kind: 'tool', index: 1 },
    ],
    ['grep', 'read'],
  )
  const html2 = renderToString(<ChatMessageView message={narrated} />)
  check('متن هدر = آخرین کپشن', html2.includes('حالا فایل را می‌خوانم'))
  check('کپشن اول در هدر نیست', !html2.includes('اول دنبال الگو می‌گردم'))
  check('نام ابزارِ آخرین فراخوانی (Read File) در هدر است', /trace-head-tool[^>]*>Read File</.test(html2))
  check('ترتیب هدر: ابزار قبل از متن', html2.indexOf('trace-head-tool') < html2.indexOf('trace-head-text'))
}

console.log('18) ساعت گروه: از شروع ران تا پایان همان گروه — نه تا پایان ترن:')
{
  // دو فراخوانی: اولی ۲ ثانیه (۱۰ ثانیه پیش شروع)، دومی ۲ ثانیه (۷ ثانیه پیش
  // شروع، ۵ ثانیه پیش تمام) → اسپن گروه = ۵ ثانیه.
  const now0 = Date.now()
  const calls = [
    { tool: 'read', startedAt: now0 - 10000, elapsedMs: 2000 },
    { tool: 'grep', startedAt: now0 - 7000, elapsedMs: 2000 },
  ]
  // الف) ران با prose واقعی بسته شده ولی ترن هنوز در جریان است → ساعت هدر روی
  // پایان آخرین فراخوانی فریز می‌شود (۵ ثانیه)، نه تا «الان» (~۱۰ ثانیه).
  const closed = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'text', text: 'جواب نهایی بلند که prose حساب می‌شود: '.repeat(20) },
    ],
    calls,
    true,
  )
  const html = renderToString(<ChatMessageView message={closed} />)
  check('رانِ بسته حین استریم: ساعت روی پایان گروه فریز است (5.0s)', html.includes('5.0s'))
  check('رانِ بسته حین استریم: ساعت تا الان تیک نخورده', !/10\.\ds/.test(html))
  // ب) همان ران ولی هنوز باز (segments به فراخوانی دوم ختم می‌شود، ترن در
  // جریان) → ساعت لایو تا «الان» تیک می‌خورد — گپ بین فراخوانی‌ها جزو گروه است.
  const open = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    calls,
    true,
  )
  const html2 = renderToString(<ChatMessageView message={open} />)
  check('رانِ باز: ساعت لایو تا الان تیک می‌خورد (~10s)', /10\.\ds/.test(html2))
  check('رانِ باز: ساعت روی 5s فریز نشده', !html2.includes('5.0s'))
  // ج) پایان ترن (streaming=false): فریز روی پایان گروه حتی بدون prose بعدش.
  const ended = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    calls,
  )
  const html3 = renderToString(<ChatMessageView message={ended} />)
  check('پایان ترن: ساعت روی پایان گروه فریز است (5.0s)', html3.includes('5.0s'))
  check('پایان ترن: ساعت تا الان تیک نخورده', !/10\.\ds/.test(html3))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
