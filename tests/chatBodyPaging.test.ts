// Chat body pagination: opening a chat must fetch only the NEWEST page, older
// pages must arrive on demand, and a paged window must never be persisted as if
// it were the full transcript (that would overwrite real history on disk).
//
// Run: npm run test:frontend
import './_globals.ts'
const store = await import('../src/lib/store.ts')
const {
  useStore,
  ensureChatTail,
  loadEarlierChatMessages,
  ensureChatHydrated,
  trimChatBodyWindow,
} = store

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const TOTAL = 100
const makeMessages = () =>
  Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    createdAt: i,
  }))

const messages = makeMessages()
const calls: Array<{ before?: number; limit?: number }> = []
const chatGet = async (
  _id: string,
  opts: { before?: number; limit?: number } = {},
) => {
  calls.push(opts)
  const base = {
    id: 'c1',
    title: 'Paging',
    mode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  }
  if (!opts.limit) {
    return { ...base, messages, bodyStart: 0, bodyTotal: TOTAL }
  }
  const end = opts.before ?? TOTAL
  const start = Math.max(0, end - opts.limit)
  return {
    ...base,
    messages: messages.slice(start, end),
    bodyStart: start,
    bodyTotal: TOTAL,
  }
}
// The shared test globals install a catch-all Proxy whose `get` ignores any
// assigned property; replace it so the store's dynamic `window.coder.chatGet`
// lookup reaches this mock.
;(globalThis as any).window.coder = new Proxy(
  { chatGet },
  {
    get: (target, prop) => {
      const own = (target as Record<string | symbol, unknown>)[prop]
      if (own !== undefined) return own
      return async () => ({ ok: true, data: null })
    },
  },
)

function setIndexRow() {
  useStore.setState({
    activeChatId: 'c1',
    chats: [
      {
        id: 'c1',
        title: 'Paging',
        mode: 'ask',
        messages: [],
        messageCount: TOTAL,
        hydrated: false,
        createdAt: 1,
        updatedAt: 1,
      } as any,
    ],
  })
}

console.log('1) opening a chat fetches only the newest page:')
{
  calls.length = 0
  setIndexRow()
  await ensureChatTail('c1')
  const c = useStore.getState().chats.find((x) => x.id === 'c1')!
  check('the first request is a bounded page', calls[0]?.limit === 60, calls[0])
  check('only the tail is resident', c.messages.length === 60, c.messages.length)
  check('the window knows where it starts', c.bodyStart === 40, c.bodyStart)
  check('the full count is known without loading', c.bodyTotal === TOTAL, c.bodyTotal)
  check(
    'the newest message is present',
    c.messages[c.messages.length - 1]?.id === `m${TOTAL - 1}`,
    c.messages[c.messages.length - 1]?.id,
  )
}

console.log('2) scrolling up pages the previous chunk from disk:')
{
  const added = await loadEarlierChatMessages('c1')
  const c = useStore.getState().chats.find((x) => x.id === 'c1')!
  check('the page before the window was requested', calls[calls.length - 1]?.before === 40, calls[calls.length - 1])
  check('all missing messages were added', added === 40, added)
  check('the whole transcript is now here', c.messages.length === TOTAL, c.messages.length)
  check('the window reaches message 0', c.bodyStart === 0, c.bodyStart)
  check(
    'order is chronological across pages',
    c.messages[0]?.id === 'm0' && c.messages[99]?.id === 'm99',
    [c.messages[0]?.id, c.messages[99]?.id],
  )
}

console.log('3) a paged window is never persisted as a full body:')
{
  setIndexRow()
  await ensureChatTail('c1')
  const partial = useStore.getState().chats.find((x) => x.id === 'c1')!
  const persisted = store.sanitizeChats([partial])
  check(
    'the partial chat still produces an index row',
    persisted.length === 1 && persisted[0].id === 'c1',
    persisted.length,
  )
  check(
    'no message fragment is written to disk',
    !('messages' in persisted[0]),
    Object.keys(persisted[0]),
  )
  check(
    'window bookkeeping is not persisted',
    !('bodyStart' in persisted[0]) && !('bodyTotal' in persisted[0]),
    Object.keys(persisted[0]),
  )
}

console.log('4) compaction refuses a paged window (full history required):')
{
  setIndexRow()
  await ensureChatTail('c1')
  useStore.getState().compactChat('c1', 'summary of only the tail', 1)
  const c = useStore.getState().chats.find((x) => x.id === 'c1')!
  check(
    'nothing was folded from the partial window',
    !c.messages.some((m) => m.role === 'system'),
    c.messages.map((m) => m.role),
  )
}

console.log('5) full hydration replaces the window with the whole body:')
{
  await ensureChatHydrated('c1')
  const c = useStore.getState().chats.find((x) => x.id === 'c1')!
  check('every message is resident', c.messages.length === TOTAL, c.messages.length)
  check('the window starts at the first message', c.bodyStart === 0, c.bodyStart)
  check(
    'the full body was requested (no limit)',
    calls[calls.length - 1]?.limit === undefined,
    calls[calls.length - 1],
  )
}

console.log('6) returning to the newest message releases old pages again:')
{
  trimChatBodyWindow('c1', 40)
  const c = useStore.getState().chats.find((x) => x.id === 'c1')!
  check('only the retention window stays in RAM', c.messages.length === 40, c.messages.length)
  check('the dropped range is remembered, not lost', c.bodyStart === 60, c.bodyStart)
  check('the total is still known', c.bodyTotal === TOTAL, c.bodyTotal)
  check(
    'the newest message survived the trim',
    c.messages[c.messages.length - 1]?.id === 'm99',
    c.messages[c.messages.length - 1]?.id,
  )
  const persisted = store.sanitizeChats([c])
  check(
    'a trimmed window is metadata-only on disk too',
    !('messages' in persisted[0]),
    Object.keys(persisted[0]),
  )
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed ❌`)
  process.exit(1)
}
console.log('\nAll chat body paging tests passed ✅')
process.exit(0)
