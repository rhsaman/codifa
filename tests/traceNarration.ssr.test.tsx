// تست SSR برای رندر narration جدا (TraceNarration) در renderSegments.
// پوشش:
//  - متن کوتاهِ قبل از فراخوانی ابزار → ردیف .trace-narration داخل همان کارت trace
//    (مثل Claude.ai که خط روایت و ردیف ابزار در یک کارت درمی‌آمیزند)
//  - باگ overwrite: در الگوی «caption، ابزار، caption، ابزار» هر caption باید
//    بالای ردیف ابزارِ خودش بماند و دومی جای اولی را نگیرد
//  - متن بلند/فرمت‌دار → پاراگراف prose معمولی (نه narration)
//  - گروه ۲+ فراخوانی بدون narration → فقط سرِ گروه، بدون ردیف narration
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
  tools: string[],
) {
  return {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: segments as never,
    toolActivity: tools.map((tool) => ({
      tool,
      status: 'done' as const,
      summary: 'ok',
      args: { path: 'src/a.ts' },
    })) as never,
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

console.log('2) باگ overwrite: هر caption بالای ابزار خودش می‌ماند:')
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
  const first = html.indexOf('اول فایل اول را می‌خوانم')
  const second = html.indexOf('حالا فایل دوم را می‌خوانم')
  check('هر دو narration رندر شدند', first !== -1 && second !== -1)
  check('narration دوم بعد از اولی است', first < second)
  check('دو ردیف narration دارد', (html.match(/trace-narration/g) || []).length === 2)
  // هر narration باید قبل از ردیف ابزارِ بعدی خودش باشد:
  const row1 = html.indexOf('trace-row-head')
  check('narration اول قبل از اولین ردیف ابزار', first < row1)
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

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
