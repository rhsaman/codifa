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

if (failed) {
  console.error(`FAILED (${failed})`)
  process.exit(1)
} else {
  console.log('emptyChats: all checks passed')
}
