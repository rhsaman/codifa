// Temporary visual smoke test for the explore card states (running → done).
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

function makeMessage(toolActivity: Array<unknown>) {
  return {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: toolActivity.map((_, index) => ({ kind: 'tool', index })) as never,
    toolActivity: toolActivity as never,
  }
}

const running = renderToString(
  <ChatMessageView
    message={
      makeMessage([
        {
          tool: 'explore',
          status: 'running',
          startedAt: Date.now() - 3200,
          args: { description: 'Find the auth flow' },
          children: [
            { tool: 'read', status: 'done', args: { filePath: 'src/a.ts' } },
            { tool: 'grep', status: 'running', args: { pattern: 'login' } },
          ],
        },
      ]) as never
    }
  />,
)

const done = renderToString(
  <ChatMessageView
    message={
      makeMessage([
        {
          tool: 'explore',
          status: 'done',
          elapsedMs: 4100,
          args: { description: 'Map the settings store' },
          children: [{ tool: 'read', status: 'done', args: { filePath: 'src/b.ts' } }],
        },
      ]) as never
    }
  />,
)

const checks: Array<[string, boolean]> = [
  ['running: spinner rendered', running.includes('explore-card-status running') && running.includes('spinner')],
  ['running: progress rail rendered', running.includes('explore-card-progress')],
  ['running: NO check glyph', !running.includes('status-ok')],
  ['running: chips rendered', running.includes('explore-tool-n') && running.includes('Read File')],
  ['running: title rendered', running.includes('Find the auth flow')],
  ['running: live clock in card', running.includes('trace-time')],
  ['done: check glyph rendered', done.includes('status-ok') && done.includes('explore-card-status done')],
  ['done: NO spinner', !done.includes('spinner')],
  ['done: NO progress rail', !done.includes('explore-card-progress')],
  ['done: calls badge', done.includes('1 calls')],
  ['done: title rendered', done.includes('Map the settings store')],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}`)
  if (!ok) failed++
}
console.log(failed ? `\n${failed} FAILED` : '\nvisual smoke OK')
process.exit(failed ? 1 : 0)
