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

function makeMessage(toolActivity: Array<unknown>, streaming = false) {
  return {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    streaming,
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

// The very bug this test guards: a sub-agent run that ENDED while the outer
// turn was still streaming. The card must settle to "done" — and its clock must
// freeze at the delegation call's own elapsed time — even though a stale child
// is still marked running and the message keeps streaming.
const doneStreaming = renderToString(
  <ChatMessageView
    message={
      makeMessage(
        [
          {
            tool: 'explore',
            status: 'done',
            startedAt: Date.now() - 600000,
            elapsedMs: 4100,
            args: { description: 'Map the settings store' },
            children: [{ tool: 'read', status: 'running', args: { filePath: 'src/b.ts' } }],
          },
        ],
        true,
      ) as never
    }
  />,
)

const checks: Array<[string, boolean]> = [
  // SSR class order: `tool-group ${open ? "open" : ""} ${state}` — collapsed
  // runs leave a double space, so match with \s*.
  ['running: group renders in running state', /class="tool-group\s+running"/.test(running)],
  ['running: agent name in the head', /trace-head-name[^>]*>Explore</.test(running)],
  // Header order (user request): agent name → LATEST inner tool → caption text.
  ['running: latest inner tool (Search Files) named in the head', /trace-head-tool[^>]*>Search Files</.test(running)],
  ['running: name → tool → text order', running.indexOf('trace-head-name') < running.indexOf('trace-head-tool') && running.indexOf('trace-head-tool') < running.indexOf('trace-head-text')],
  ['running: progress dots shown', running.includes('trace-head-dots')],
  ['running: NO check tick', !running.includes('trace-head-check')],
  ['running: title (description) as head caption', running.includes('Find the auth flow')],
  ['running: clock ticks in the head', running.includes('trace-head-ms')],
  ['done: group settles to done state', /class="tool-group\s+done"/.test(done)],
  ['done: progress dots gone', !done.includes('trace-head-dots')],
  ['done: check tick at the head', done.includes('trace-head-check')],
  ['done: tick sits LEFT of the agent name', done.indexOf('trace-head-check') < done.indexOf('trace-head-name')],
  ['done: NO running group state', !/class="tool-group\s+running"/.test(done)],
  ['done: NO progress rail', !done.includes('explore-card-progress')],
  ['done: latest inner tool (Read File) named in the head', /trace-head-tool[^>]*>Read File</.test(done)],
  ['done: elapsed time from the delegation call', done.includes('4.1s')],
  ['done: title (description) as head caption', done.includes('Map the settings store')],
  // The regression itself: streaming must NOT restart a finished run's clock.
  ['done while streaming: card settles to done', /class="tool-group\s+done"/.test(doneStreaming)],
  ['done while streaming: clock frozen on the run elapsed', doneStreaming.includes('4.1s')],
  ['done while streaming: clock did NOT count on to the turn end', !doneStreaming.includes('10m')],
]


let failed = 0
for (const [name, ok] of checks) {
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}`)
  if (!ok) failed++
}
console.log(failed ? `\n${failed} FAILED` : '\nvisual smoke OK')
process.exit(failed ? 1 : 0)
