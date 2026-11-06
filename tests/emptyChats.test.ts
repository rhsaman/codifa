// Empty chats never reach disk: a fresh "new chat" tab only becomes real
// (sidebar row + file) once the first message is sent.
import './_globals.ts'

const { sanitizeChats } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const empty = { id: 'e1', messages: [] }
const full = { id: 'f1', messages: [{ id: 'm1', role: 'user', content: 'hi' }] }

{
  console.log('── emptyChats: message-less chats are dropped from disk writes ──')
  const out = sanitizeChats([empty, full] as never[])
  check('empty chat filtered out', out.length === 1 && out[0].id === 'f1', out.map((c: { id: string }) => c.id))
  check('all-empty writes nothing', sanitizeChats([empty] as never[]).length === 0)
  check('non-empty chat kept with messages', (out[0] as { messages: unknown[] }).messages.length === 1)
}

// A fork PENDING its first user message holds the compacted system seed, so
// `messages.length > 0` — the empty-chat rule above alone would persist it the
// moment the fork was created. Pending forks follow the new-chat rule instead:
// in-memory until the first user turn.
{
  console.log('── emptyChats: pending forks are dropped until the first user message ──')
  const seed = { id: 's1', role: 'system', content: '[Forked context]' }
  const pending = { id: 'd1', title: 'New chat', pendingFirstMessage: true, messages: [seed] }
  const out = sanitizeChats([pending] as never[])
  check('seeded pending fork filtered out', out.length === 0, out.map((c: { id: string }) => c.id))

  const graduated = { id: 'd1', title: 'فورک', pendingFirstMessage: false, messages: [seed, { id: 'u1', role: 'user', content: 'ادامه بده' }] }
  const out2 = sanitizeChats([graduated] as never[])
  check('fork with a user turn is persisted', out2.length === 1 && out2[0].id === 'd1')

  // Belt-and-suspenders: even with the flag stuck on, a user turn commits the fork.
  const stuckFlag = { id: 'd2', title: 'فورک', pendingFirstMessage: true, messages: [seed, { id: 'u2', role: 'user', content: 'hi' }] }
  const out3 = sanitizeChats([stuckFlag] as never[])
  check('a user turn commits the fork even with a stale pending flag', out3.length === 1 && out3[0].id === 'd2')
}

if (failed) {
  console.error(`FAILED (${failed})`)
  process.exit(1)
} else {
  console.log('emptyChats: all checks passed')
}
