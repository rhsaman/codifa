// SSR test for the tool-group header with PARALLEL explore runs.
//
// Each sub-agent run renders as its own ToolGroupView card (exactly like a
// regular tool group) with the agent's NAME leading the header; the head
// caption is the run's own latest narration line (else the task description).
// Narration arrives via `narrationParts` (the sub-agent event contract).
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

function makeMessage(toolActivity: Array<unknown>) {
  return {
    id: 'm-explore',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: toolActivity.map((_, index) => ({ kind: 'tool', index })) as never,
    toolActivity: toolActivity as never,
  }
}

console.log('1) دو explore موازی → دو کارت مستقل مثل tool group، هر کدام با نام خودش:')
{
  const msg = makeMessage([
    {
      tool: 'explore',
      status: 'running',
      args: { description: 'Find the auth flow', prompt: 'where is login handled' },
      narrationParts: [
        { after: 0, text: 'Reading src/auth.ts' },
        { after: 0, text: 'Now tracing the login handler' },
      ],
    },
    {
      tool: 'explore',
      status: 'done',
      args: { description: 'Map the settings store', prompt: 'how are settings persisted' },
      summary: '4 files',
    },
  ])
  const html = renderToString(<ChatMessageView message={msg} />)
  // React SSR splits adjacent text nodes with `<!-- -->` separators: strip
  // comments (and tags) before matching rendered header text.
  const plain = html.replace(/<!--.*?-->/g, '')
  const text = plain.replace(/<[^>]*>/g, '')
  check('نام ساب‌ایجنت در هدر رندر شد', html.includes('trace-head-name'))
  check(
    'هر explore کارت مستقل خودش را دارد (یک گروه در یک قاب tool-trace)',
    (html.match(/tool-group/g) || []).length === 2 &&
      (html.match(/tool-trace/g) || []).length === 2,
    [html.match(/tool-group/g)?.length, html.match(/tool-trace/g)?.length],
  )
  check(
    'کارت explore قدیمی (tool-card explore) رندر نشد',
    !html.includes('tool-card explore') && !html.includes('explore-card-open'),
  )
  // کارت اول narration دارد → caption هدر جملهٔ خود ساب‌ایجنت است و توضیح
  // وظیفه جایی رندر نمی‌شود.
  check(
    'کارت اول narration دارد → توضیح وظیفه‌اش رندر نمی‌شود',
    !text.includes('Find the auth flow'),
    text.slice(0, 400),
  )
  check(
    'هدر کارت دوم توضیح خودش را دارد (caption وقتی narration نیست)',
    text.includes('Map the settings store'),
    text.slice(0, 300),
  )
  check(
    'آخرین جملهٔ ساب‌ایجنت caption هدر است',
    text.includes('Now tracing the login handler'),
    text.slice(0, 400),
  )
  check(
    'جملهٔ اول narration در هدر نیست (فقط آخرین کپشن)',
    !text.includes('Reading src/auth.ts'),
    text.slice(0, 400),
  )
  check(
    'دو نام جدا (هر کارت pill نام خودش)',
    (html.match(/trace-head-name/g) || []).length === 2,
    (html.match(/trace-head-name/g) || []).length,
  )
  check('شمارنده ×2 برای explore ساخته نشد', !html.includes('Explore ×2'))
}

console.log('2) ابزارهای معمولی: یک گروه، نام آخرین فراخوانی در هدر، بدون شمارنده:')
{
  const msg = makeMessage([
    { tool: 'read', status: 'done', args: { filePath: 'a.ts' } },
    { tool: 'read', status: 'done', args: { filePath: 'b.ts' } },
    { tool: 'grep', status: 'done', args: { pattern: 'x' } },
  ])
  const html = renderToString(<ChatMessageView message={msg} />)
  check(
    'یک گروه واحد رندر شد',
    (html.match(/tool-group/g) || []).length === 1,
    html.match(/tool-group/g)?.length,
  )
  check(
    'نام آخرین فراخوانی (Search Files برای grep) در هدر است',
    /trace-head-tool[^>]*>Search Files</.test(html),
  )
  check('badge شمارنده (trace-pill-count) رندر نشد', !html.includes('trace-pill-count'))
  check('نام ساب‌ایجنت ساخته نشد', !html.includes('trace-head-name'))
}

console.log('3) برچسب ابزار MCP نام سرور و ابزار را نشان می‌دهد:')
{
  const msg = makeMessage([
    {
      tool: 'mcp__playwright__browser_navigate',
      status: 'done',
      args: { url: 'https://example.com' },
    },
  ])
  const html = renderToString(<ChatMessageView message={msg} />)
  check('نام ابزار MCP خوانا شد', html.includes('browser_navigate'), html.slice(0, 400))
  check('نام سرور MCP در برچسب هست', html.includes('playwright'))
  check('پیشوند خام mcp__ نمایش داده نشد', !html.includes('mcp__playwright__'))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log('\nهمه بررسی‌های هدر explore موفق بود')
}
