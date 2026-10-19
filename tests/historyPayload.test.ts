// Send-payload projection (src/lib/historyPayload.ts): the /chat/stream
// history must carry ONLY what the Rust backend reads (agent.rs
// `history_recap`), otherwise every turn re-serializes megabytes of inline
// image data URLs, per-message thinking and full tool output for nothing.
import { projectHistoryMessage } from '../src/lib/historyPayload.ts'
import type { ChatMessage } from '../src/types.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const base = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  content: 'hi',
  createdAt: 0,
  ...over,
})

{
  console.log('── fields the backend never reads are not sent ──')
  const m = base({
    thinking: 't'.repeat(50_000),
    images: [
      {
        path: '/shot.png',
        name: 'shot.png',
        dataUrl: 'data:image/png;base64,' + 'A'.repeat(200_000),
      },
    ],
  })
  const out = projectHistoryMessage(m) as Record<string, unknown>
  check('thinking is dropped', !('thinking' in out))
  check('inline image data URLs are dropped', !JSON.stringify(out).includes('dataUrl'))
  // The image itself still travels — as a PATH the backend re-reads, so the
  // model keeps seeing an older screenshot without re-sending its bytes.
  check('image paths survive', JSON.stringify(out.images) === '["/shot.png"]')
  check('role survives', out.role === 'assistant')
  check('content survives', out.content === 'hi')
}

{
  console.log('── tool cards keep only what history_recap reads ──')
  const m = base({
    toolActivity: [
      {
        tool: 'write_file',
        status: 'done',
        args: { filePath: '/a.ts', content: 'C'.repeat(5_000) },
        summary: 'wrote file',
        items: [{ title: 'a.ts', url: 'file:///a.ts' }],
        diff: 'D'.repeat(10_000),
        results: [
          { content: 'R1'.repeat(500) },
          { content: 'R2'.repeat(500) },
          { content: 'R3'.repeat(500) },
        ],
        resultText: 'T'.repeat(20_000),
        children: [{ tool: 'grep', status: 'done' }],
        callId: 'c1',
        elapsedMs: 12,
        model: 'some-model',
      },
    ],
  })
  const act = (projectHistoryMessage(m).toolActivity ?? [])[0] as Record<
    string,
    unknown
  >
  check(
    'tool/status/summary survive',
    act.tool === 'write_file' && act.status === 'done' && act.summary === 'wrote file',
  )
  check('items (full result rows) dropped', !('items' in act))
  check('nested children dropped', !('children' in act))
  check('diff dropped', !('diff' in act))
  check(
    'callId/elapsedMs/model dropped',
    !('callId' in act) && !('elapsedMs' in act) && !('model' in act),
  )
  const results = act.results as Array<{ content?: string }>
  check('results trimmed to the 2 rows the recap reads', results.length === 2)
  check(
    'each result content capped at 400',
    results.every((r) => (r.content ?? '').length === 400),
  )
  check('resultText capped at 8000', (act.resultText as string).length === 8_000)
  const args = act.args as Record<string, string>
  check('long arg strings capped', args.content.length === 400)
  check('short arg strings untouched', args.filePath === '/a.ts')
}

{
  console.log('── LOSSLESSNESS: the 200 chars the recap keeps are byte-identical ──')
  const args = {
    filePath: '/src/really/long/path/to/some/nested/component.tsx',
    content: 'C'.repeat(5_000),
  }
  const m = base({
    toolActivity: [{ tool: 'write_file', status: 'done', args }],
  })
  const act = (projectHistoryMessage(m).toolActivity ?? [])[0]
  const before = JSON.stringify(args).slice(0, 200)
  const after = JSON.stringify(act.args).slice(0, 200)
  check('serialized prefix unchanged', before === after)
  check(
    'payload is dramatically smaller',
    JSON.stringify(act.args).length < JSON.stringify(args).length / 5,
    [JSON.stringify(act.args).length, JSON.stringify(args).length],
  )
}

{
  console.log('── running cards, preserved summary and checklist ──')
  const m = base({
    plan: [{ id: 'p1', content: 'do it', status: 'completed' }],
    preservedToolSummary: 'SUMMARY',
    toolActivity: [
      { tool: 'read', status: 'running' },
      { tool: 'grep', status: 'done' },
    ],
  })
  const out = projectHistoryMessage(m)
  check('running cards are not replayed', (out.toolActivity ?? []).length === 1)
  check('the finished card survives', out.toolActivity?.[0]?.tool === 'grep')
  check('preservedToolSummary survives', out.preservedToolSummary === 'SUMMARY')
  check('plan/checklist survives', out.plan?.[0]?.status === 'completed')
}

{
  console.log('── messages with no tools stay minimal ──')
  const out = projectHistoryMessage(base({})) as Record<string, unknown>
  check('no toolActivity key', !('toolActivity' in out))
  check('no plan key', !('plan' in out))
  check('no preservedToolSummary key', !('preservedToolSummary' in out))
  check('no images key', !('images' in out))
}

if (failed) {
  console.error(`FAILED (${failed})`)
  process.exit(1)
} else {
  console.log('historyPayload: all checks passed')
}
