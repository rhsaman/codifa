// تست SSR پنل Trace — ردیف فشرده، گروه‌بندی step و فیلتر تب‌ها.
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
const { TraceRow, TraceStepGroup, groupTracesByStep, traceStep, traceGroupKey, traceEntrySearchParts } = await import(
  '../src/components/TracePanel'
)
const { countTraceEntryHits, countTraceHits, stepHitIndex, locateHit } = await import(
  '../src/lib/diffSearch.ts'
)

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const rows = [
  { id: '1', at: 1, kind: 'tool', summary: 'read', detail: { name: 'read', step: 6 } },
  { id: '2', at: 2, kind: 'llm', summary: '', model: 'm', tokens: { total: 100 }, detail: { step: 6 } },
  { id: '3', at: 3, kind: 'tool', summary: 'grep', detail: { name: 'grep', step: 7 } },
] as any

console.log('1) گروه‌بندی step:')
{
  check('step از detail خوانده می‌شود', traceStep(rows[0]) === 6)
  check('step ناموجود null است', traceStep({ id: 'x', at: 1, kind: 'laya', summary: 's' } as any) === null)
  const groups = groupTracesByStep(rows)
  check('دو گروه ساخته شد', groups.length === 2)
  check('گروه اول step 6 با دو ردیف است', groups[0].step === 6 && groups[0].entries.length === 2)
  check('گروه دوم step 7 با یک ردیف است', groups[1].step === 7 && groups[1].entries.length === 1)
}

console.log('2) ردیف فشرده تک‌خطی چپ‌چین:')
{
  const html = renderToString(<TraceRow entry={rows[0]} />)
  check('کلاس ردیف پنل دارد', html.includes('trace-panel-row'))
  check('نقطه نوع دارد', html.includes('trace-panel-dot'))
  check('عنوان فشرده دارد', html.includes('trace-panel-title'))
  check('چیپ step دارد', /step(?:\s|<!-- -->)*6/.test(html))
  check('ساعت دارد', html.includes('trace-panel-time'))
  check('شورون دارد', html.includes('trace-panel-chev'))
  check('کارت قدیمی ندارد', !html.includes('trace-row-block'))
}

console.log('3) سربرگ تاشوی step:')
{
  const html = renderToString(
    <TraceStepGroup step={6} entries={[rows[0], rows[1]]} />,
  )
  check('هدر step دارد', html.includes('trace-panel-step-head'))
  check('عنوان Step 6 دارد', html.includes('Step 6'))
  check('شمارش ردیف‌ها دارد', /2(?:<!-- -->)? events/.test(html))
  check('هر دو ردیف رندر شدند', (html.match(/trace-panel-row/g) || []).length === 2)
}

console.log('4) کلید پایدار گروه با لاگ جدید:')
{
  const oldGroups = groupTracesByStep(rows)
  const oldKeys = oldGroups.map((g) => traceGroupKey(g.step, g.entries))
  const withNewStep = [
    { id: '0', at: 0, kind: 'tool', summary: 'ls', detail: { name: 'ls', step: 8 } },
    ...rows,
  ] as any
  const newGroups = groupTracesByStep(withNewStep)
  const newKeys = newGroups.map((g) => traceGroupKey(g.step, g.entries))
  check('گروه‌های قبلی کلیدشان حفظ شد', oldKeys.every((k) => newKeys.includes(k)))
  const withNewRow = [
    { id: '4', at: 4, kind: 'tool', summary: 'cat', detail: { name: 'cat', step: 7 } },
    ...rows,
  ] as any
  const grownGroups = groupTracesByStep(withNewRow)
  const grownKeys = grownGroups.map((g) => traceGroupKey(g.step, g.entries))
  check('گروه step قبلی با ردیف جدید کلیدش حفظ شد', oldKeys.every((k) => grownKeys.includes(k)))
}

console.log('5) ناوبری سرچ (شمارش + چرخش جلو/عقب):')
{
  const parts = traceEntrySearchParts({
    id: '9',
    at: 9,
    kind: 'tool',
    summary: 'read config',
    prompt: '{"path": "config"}',
    result: 'config ok',
    detail: { name: 'read' },
  } as any)
  check('بخش‌های سرچ استخراج شد', parts.title === 'read config' && parts.prompt.includes('config'))
  const hits = countTraceEntryHits(parts, 'config')
  check('سه رخداد شمرده شد', hits === 3, hits)
  check('کوئری خالی صفر است', countTraceEntryHits(parts, '  ') === 0)
  const list = [parts, traceEntrySearchParts(rows[0])]
  check('جمع رخدادهای لیست درست است', countTraceHits(list, 'config') === 3, countTraceHits(list, 'config'))
  check('جلو از آخر می‌چرخد', stepHitIndex(2, 3, 1) === 0)
  check('عقب از اول می‌چرخد', stepHitIndex(0, 3, -1) === 2)
  const loc = locateHit([3, 1], 3)
  check('رخداد چهارم در ورودی دوم است', loc?.fileIndex === 1 && loc?.localIndex === 0, loc)
}

console.log('6) رندر هایلایت فعال سرچ:')
{
  const html = renderToString(<TraceRow entry={rows[0]} query="read" hitBase={0} activeHit={0} />)
  check('هایلایت فعال دارد', html.includes('trace-hit-active'))
  const plain = renderToString(<TraceRow entry={rows[0]} query="read" />)
  check('بدون ناوبری هایلایت فعال ندارد', !plain.includes('trace-hit-active'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
