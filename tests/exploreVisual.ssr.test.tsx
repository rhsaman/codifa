// Visual smoke test for the sub-agent card states (running → done).
// The chat card IS a ToolGroupView now (user request): the group carries the
// running/done state, the agent-name pill gets the running accent, and the
// elapsed time comes from the delegation call itself.
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
  // SSR class order: `tool-group ${open ? "open" : ""} ${state}` — collapsed
  // runs leave a double space, so match with \s*.
  ['running: group renders in running state', /class="tool-group\s+running"/.test(running)],
  ['running: name pill gets the running accent', running.includes('trace-pill trace-pill-sub running')],
  ['running: NO check glyph', !running.includes('status-ok')],
  ['running: inner tool pills rendered', running.includes('Read File') && running.includes('Search Files')],
  ['running: title (description) as head caption', running.includes('Find the auth flow')],
  ['running: live clock in card', running.includes('trace-time')],
  ['done: group settles to done state', /class="tool-group\s+done"/.test(done)],
  ['done: name pill without running accent', /trace-pill trace-pill-sub"[^>]*>Explore</.test(done)],
  ['done: NO running group state', !/class="tool-group\s+running"/.test(done)],
  ['done: NO progress rail', !done.includes('explore-card-progress')],
  ['done: elapsed time from the delegation call', done.includes('4.1s')],
  ['done: title (description) as head caption', done.includes('Map the settings store')],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}`)
  if (!ok) failed++
}
console.log(failed ? `\n${failed} FAILED` : '\nvisual smoke OK')
process.exit(failed ? 1 : 0)
