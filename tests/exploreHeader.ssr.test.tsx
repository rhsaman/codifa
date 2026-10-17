// SSR test for the tool-group header with PARALLEL explore runs.
//
// The main agent fires several explores in one step; the header must show one
// pill PER explore carrying its short description (so the user can tell what
// each one is looking for) instead of collapsing them into a single
// "Explore ×2" count. Non-sub-agent tools keep the counted-pill behaviour.
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

console.log('1) دو explore موازی → دو کارت مستقل، هر کدام با هدر «Explore · توضیح»:')
{
  const msg = makeMessage([
    {
      tool: 'explore',
      status: 'running',
      args: { description: 'Find the auth flow', prompt: 'where is login handled' },
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
  check('پیل ساب‌ایجنت رندر شد', html.includes('trace-pill-sub'))
  check(
    'هر explore کارت تول‌گروپ مستقل خودش را دارد',
    (html.match(/class="tool-group/g) || []).length === 2,
    (html.match(/class="tool-group/g) || []).length,
  )
  check(
    'هدر کارت اول «Explore · توضیح» است',
    text.includes('Explore · Find the auth flow'),
    text.slice(0, 300),
  )
  check(
    'هدر کارت دوم توضیح خودش را دارد',
    text.includes('Explore · Map the settings store'),
    text.slice(0, 300),
  )
  check(
    'دو پیل جدا (نه یک ×2)',
    (html.match(/trace-pill-sub/g) || []).length === 2,
    (html.match(/trace-pill-sub/g) || []).length,
  )
  check('شمارنده ×2 برای explore ساخته نشد', !html.includes('Explore ×2'))
}

console.log('2) ابزارهای معمولی همچنان شمارنده‌ای جمع می‌شوند:')
{
  const msg = makeMessage([
    { tool: 'read', status: 'done', args: { filePath: 'a.ts' } },
    { tool: 'read', status: 'done', args: { filePath: 'b.ts' } },
    { tool: 'grep', status: 'done', args: { pattern: 'x' } },
  ])
  const html = renderToString(<ChatMessageView message={msg} />)
  // React SSR splits `×{n}` into two text nodes with a `<!-- -->` separator,
  // so strip comments before matching the badge content.
  const plain = html.replace(/<!--.*?-->/g, '')
  const badge = plain.match(/trace-pill-count[^>]*>([^<]*)</)
  check(
    'شمارندهٔ تعداد برای ابزارهای معمولی رندر شد',
    !!badge && badge[1].includes('2'),
    badge?.[1],
  )
  check('پیل ساب‌ایجنت ساخته نشد', !html.includes('trace-pill-sub'))
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
