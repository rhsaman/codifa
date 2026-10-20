// SSR test for Trace panel — compact row, turn grouping, tab filter, per-turn copy.
// Mocks the electron bridge before importing the component.
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
const { TraceRow, TraceTurnGroup, getTraceTabCounts, groupTracesByTurn, traceStep, traceTurn, turnUserPreview, traceEntrySearchParts, formatTraceEntryAsText, formatTracesAsText, formatTurnAsText, filterTraces } = await import(
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
  { id: '1', at: 1, kind: 'laya', summary: 'normal', turn: 1, detail: { route: 'normal' } },
  { id: '2', at: 2, kind: 'prompt', summary: 'chat', turn: 1, prompt: '[system]\ns\n\n[user]\nhello world' },
  { id: '3', at: 3, kind: 'tool', summary: 'read', turn: 1, detail: { name: 'read', step: 2 } },
  { id: '4', at: 4, kind: 'tool', summary: 'grep', turn: 2, detail: { name: 'grep', step: 1 } },
] as any

console.log('1) turn grouping:')
{
  check('turn is read from entry', traceTurn(rows[0]) === 1)
  check('missing turn is null', traceTurn({ id: 'x', at: 1, kind: 'laya', summary: 's' } as any) === null)
  check('step still read from detail', traceStep(rows[2]) === 2)
  const groups = groupTracesByTurn(rows)
  check('two groups created', groups.length === 2)
  check('first group is turn 1 with three rows', groups[0].turn === 1 && groups[0].entries.length === 3)
  check('second group is turn 2 with one row', groups[1].turn === 2 && groups[1].entries.length === 1)
  const legacy = groupTracesByTurn([
    { id: 'a', at: 1, kind: 'llm', summary: 'm' },
    { id: 'b', at: 2, kind: 'prompt', summary: 'p', prompt: 'hi' },
  ] as any)
  check('legacy entries without turn split on prompt', legacy.length === 2)
  check('user preview extracted from prompt', turnUserPreview(rows[0].turn === 1 ? [rows[1]] : []) === 'hello world')
}

console.log('2) compact single-line row:')
{
  const html = renderToString(<TraceRow entry={rows[2]} />)
  check('has panel row class', html.includes('trace-panel-row'))
  check('has kind dot', html.includes('trace-panel-dot'))
  check('has compact title', html.includes('trace-panel-title'))
  check('has step chip', /step(?:\s|<!-- -->)*2/.test(html))
  check('has clock', html.includes('trace-panel-time'))
  check('has chevron', html.includes('trace-panel-chev'))
  check('has no legacy card', !html.includes('trace-row-block'))
  check('default closed (body not rendered)', !html.includes('trace-panel-body'))
  const openRow = renderToString(<TraceRow entry={rows[2]} defaultOpen />)
  check('body open with defaultOpen', openRow.includes('trace-panel-body'))
}

console.log('3) turn group header (default open):')
{
  const html = renderToString(
    <TraceTurnGroup turn={1} inferred={1} entries={[rows[0], rows[1], rows[2]]} />,
  )
  check('has turn header', html.includes('trace-panel-step-head'))
  check('has Turn 1 title', html.includes('Turn 1'))
  check('has row count', /3(?:<!-- -->)? events/.test(html))
  check('has per-turn copy button', html.includes('Copy') && html.includes('trace-copy-btn'))
  check('default open (rows rendered)', (html.match(/trace-panel-row/g) || []).length === 3)
}

console.log('3b) expanded body never renders an empty "{}":')
{
  // An llm row that recorded nothing but a token count used to expand to a
  // literal `{}` — the panel looked broken even though the row was "fine".
  const bare = { id: 'l1', at: 1, kind: 'llm', summary: 'm · 5 tokens', model: 'm' } as any
  const bareHtml = renderToString(<TraceRow entry={bare} defaultOpen />)
  check('no empty detail json', !bareHtml.includes('trace-detail-json'), bareHtml)
  check('explains the empty body', bareHtml.includes('No prompt/response recorded'), bareHtml)

  // A row WITH detail still shows the pretty-printed json instead of a note.
  const detailed = {
    id: 'l2',
    at: 1,
    kind: 'llm',
    summary: 'm · 5 tokens',
    model: 'm',
    detail: { provider: 'openrouter', step: 2, finish_reason: 'tool_calls' },
  } as any
  const detailedHtml = renderToString(<TraceRow entry={detailed} defaultOpen />)
  check('detail json rendered', detailedHtml.includes('trace-detail-json'), detailedHtml)
  check('no empty-body note', !detailedHtml.includes('No prompt/response recorded'))
  // The reply text wins over the detail dump (that is the llm row's real body).
  const withReply = renderToString(<TraceRow entry={{ ...detailed, result: 'I will read the file.' }} defaultOpen />)
  check('reply text rendered as the body', withReply.includes('I will read the file.'), withReply)
  check('detail json skipped when a reply exists', !withReply.includes('trace-detail-json'), withReply)
}

console.log('3c) an llm row shows the wire prompt it was sent:')
{
  const llm = {
    id: 'l1',
    at: 5,
    kind: 'llm',
    summary: 'm · 10 tokens',
    turn: 1,
    prompt: '[system] 40 chars\n\n[user]\nhello world',
    result: 'hi there',
    detail: { provider: 'openai', step: 1 },
  } as any
  const html = renderToString(<TraceRow entry={llm} defaultOpen />)
  check('has a prompt block', html.includes('trace-prompt-block'))
  check('prompt text is rendered', html.includes('hello world'), html.slice(0, 400))
  check('prompt is labelled', html.includes('Prompt'))
  check('response block is rendered', html.includes('hi there'))
  check('no empty-body placeholder', !html.includes('trace-empty-body'))
}

console.log('4) per-turn copy text:')
{
  const text = formatTurnAsText(1, 1, [rows[0], rows[1]])
  check('has turn header line', text.includes('Turn 1'))
  check('has both rows', text.includes('normal') && text.includes('hello world'))
}

console.log('5) search navigation (count + forward/back rotation):')
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
  check('search parts extracted', parts.title === 'read config' && parts.prompt.includes('config'))
  const hits = countTraceEntryHits(parts, 'config')
  check('three hits counted', hits === 3, hits)
  check('blank query is zero', countTraceEntryHits(parts, '  ') === 0)
  const list = [parts, traceEntrySearchParts(rows[2])]
  check('list hit sum correct', countTraceHits(list, 'config') === 3, countTraceHits(list, 'config'))
  check('forward wraps from end', stepHitIndex(2, 3, 1) === 0)
  check('back wraps from start', stepHitIndex(0, 3, -1) === 2)
  const loc = locateHit([3, 1], 3)
  check('fourth hit is in second entry', loc?.fileIndex === 1 && loc?.localIndex === 0, loc)
}

console.log('6) active search highlight render:')
{
  const html = renderToString(<TraceRow entry={rows[2]} query="read" hitBase={0} activeHit={0} />)
  check('has active highlight', html.includes('trace-hit-active'))
  const plain = renderToString(<TraceRow entry={rows[2]} query="read" />)
  check('no active highlight without navigation', !plain.includes('trace-hit-active'))
}

console.log('7) whole-trace copy (filtered only when filtered):')
{
  const text = formatTraceEntryAsText(rows[2])
  check('has kind and title', text.includes('TOOL') && text.includes('read'))
  check('has step', text.includes('step=2'))
  check('has turn', text.includes('turn=1'))
  const all = formatTracesAsText(rows)
  check('all rows in text', all.includes('read') && all.includes('grep'))
  check('empty list is empty text', formatTracesAsText([]) === '')
  const onlyTools = filterTraces(rows, 'read')
  check('filter keeps only matching row', onlyTools.length === 1 && onlyTools[0]?.id === '3')
  check('filtered text is only that row', formatTracesAsText(onlyTools).includes('read') && !formatTracesAsText(onlyTools).includes('grep'))
}

console.log('8) sub-agent trace view includes its own tools:')
{
  const subRows = [
    { id: 's1', at: 1, kind: 'tool', summary: 'grep', turn: 1, detail: { name: 'grep', sub: true, task_id: 'task-abc' } },
    { id: 's2', at: 2, kind: 'llm', summary: 'm · 5 tokens', turn: 1, detail: { sub: true } },
  ] as any
  const mainCounts = getTraceTabCounts(subRows)
  check('main view hides sub tools', mainCounts.tool === 0, mainCounts)
  const subCounts = getTraceTabCounts(subRows, true)
  check('sub-agent view counts its tools', subCounts.tool === 1, subCounts)
}

if (failed > 0) {
  console.error(`\n${failed} tests failed ❌`)
  process.exit(1)
}
console.log('\nAll tests passed ✅')
process.exit(0)
