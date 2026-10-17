// SSR test: a long tool result never AUTO-opens the right-hand panel.
//
// The panel opens only from an explicit user click (row head → text tab for
// long output, the "more" button, openText). Rendering must not touch it, and
// no nested <details> block is involved — an expanded row scrolls its long
// body (trace-expand-pre has max-height + overflow). These checks pin that.
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
;(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { renderToString } = await import('react-dom/server')
const { ChatMessageView } = await import('../src/components/ChatMessage')
const { useViewerTabs } = await import('../src/lib/viewerTabs')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const LONG_TAIL = 'tail-marker-of-a-very-long-output'
function longOutput(lines = 120) {
  const body = Array.from({ length: lines }, (_, i) => `log line ${i + 1}`).join('\n')
  return `${body}\n${LONG_TAIL}`
}

function makeMessage(toolActivity: Array<unknown>) {
  return {
    id: 'm-output',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: toolActivity.map((_, index) => ({ kind: 'tool', index })) as never,
    toolActivity: toolActivity as never,
  }
}

function resetViewer() {
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as never)
}

console.log('1) خروجی بلند ترمینال به‌صورت خودکار پنل راست را باز نمی‌کند:')
{
  resetViewer()
  const msg = makeMessage([
    { tool: 'run_terminal', status: 'done', args: { command: 'npm run build' }, items: [{ content: longOutput() }] },
    { tool: 'read', status: 'done', args: { filePath: 'a.ts' }, summary: longOutput(60) },
  ])
  const html = renderToString(<ChatMessageView message={msg} />)
  const vt = useViewerTabs.getState()
  check('پنل راست باز نشد', vt.paneOpen === false, vt.paneOpen)
  check('هیچ تب متنی ساخته نشد', vt.tabs.length === 0, vt.tabs.map((t) => t.id))
  check('خروجی بلند به‌صورت پیش‌فرض باز نیست', !html.includes(LONG_TAIL))
  check('بدون بلوک details تودرتو', !html.includes('tool-out-collapse'))
  // read-only rows collapse into ONE closed tool group — the long output stays
  // inside it until the user opens the group or clicks the row (text tab).
  check('ردیف‌ها در گروه ابزار جمع شدند', html.includes('tool-group'), html.slice(0, 300))
}

console.log('2) خروجی کوتاه بدون بلوک اضافی رندر می‌شود:')
{
  resetViewer()
  const msg = makeMessage([
    { tool: 'read', status: 'done', args: { filePath: 'a.ts' }, summary: 'one short line' },
    { tool: 'grep', status: 'done', args: { pattern: 'x' }, summary: '2 matches' },
  ])
  const html = renderToString(<ChatMessageView message={msg} />)
  check('بدون details اضافی', !html.includes('tool-out-collapse'), html.slice(0, 300))
  check('پنل همچنان بسته است', useViewerTabs.getState().paneOpen === false)
}

console.log('3) راه دستی باز کردن خروجی در پنل حفظ شده است:')
{
  resetViewer()
  // The "more" affordance lives in FileResultLinks (shown once a row/group is
  // expanded): more results than the visible cap → button that opens the panel.
  const { FileResultLinks } = await import('../src/components/ToolCallView')
  const listHtml = renderToString(
    <FileResultLinks
      tool="grep"
      items={[
        { file: 'a.ts', line: 1, text: 'x' },
        { file: 'b.ts', line: 2, text: 'x' },
        { file: 'c.ts', line: 3, text: 'x' },
        { file: 'd.ts', line: 4, text: 'x' },
      ] as never}
    />,
  )
  check('دکمهٔ «بیشتر» برای باز کردن در پنل هست', listHtml.includes('file-result-more-btn'))
  resetViewer()
  useViewerTabs.getState().openText('grep results', 'body', 'md')
  check('openText دستی پنل را باز می‌کند', useViewerTabs.getState().paneOpen === true)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log('\nهمه بررسی‌های خروجی بلند ابزار موفق بود')
}
