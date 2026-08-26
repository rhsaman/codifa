// Focused tests for the mid-stream persistence heartbeat:
//  - sanitizeChats keeps toolActivity (trimmed) and marks streaming messages
//    as `interrupted`, so a power cut no longer loses the whole in-flight turn
//  - persist() throttles to one chats-only write per MID_STREAM_MS (2s) while
//    streaming, and falls back to the full write once streaming ends
// Run: npx esbuild test/persistHeartbeat.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-hb.mjs --external:electron \
//        && node test/.tmp-hb.mjs

const storeCalls: Array<[string, unknown]> = []
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        if (prop === 'storeSet') {
          return async (key: string, value: unknown) => {
            storeCalls.push([key, value])
            return true
          }
        }
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

// Controllable clock so the 2s throttle can be tested without waiting.
let fakeNow = 1_000_000
Date.now = () => fakeNow

const { useStore } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const chatsCalls = () => storeCalls.filter(([k]) => k === 'chats')
const lastChatsPayload = () => chatsCalls().at(-1)?.[1] as any

function makeToolActivity() {
  return [
    {
      tool: 'bash',
      args: { cmd: 'ls', big: 'y'.repeat(3000) },
      summary: 'x'.repeat(5000),
      status: 'done' as const,
      items: Array.from({ length: 60 }, (_, i) => ({
        title: `t${i}`,
        url: `u${i}`,
        snippet: 'z'.repeat(800),
      })),
      children: [
        { tool: 'read', args: { path: '/a' }, summary: 'nested', status: 'done' as const },
      ],
    },
  ]
}

console.log('1) persist هنگام streaming: toolActivity حفظ و تریم میشود + flag interrupted:')
{
  storeCalls.length = 0
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'سلام' })
  const asst = s.addMessage(chatId, {
    role: 'assistant',
    content: 'دارم کار میکنم...',
    streaming: true,
    toolActivity: makeToolActivity(),
  })
  // addMessage → persist() → streaming → اولین heartbeat فوری (lastMidStreamPersist=0)
  const payload = lastChatsPayload()
  const msgs = payload.find((c: any) => c.id === chatId).messages
  const m = msgs.find((x: any) => x.id === asst.id)
  check('toolActivity حفظ شد', Array.isArray(m.toolActivity) && m.toolActivity.length === 1, m.toolActivity)
  check('flag interrupted=true', m.interrupted === true, m.interrupted)
  check('streaming حذف شد', !('streaming' in m), m)
  check('summary تریم شد (4000+…)', m.toolActivity[0].summary.length === 4001, m.toolActivity[0].summary.length)
  check('args رشته بزرگ تریم شد (2000+…)', m.toolActivity[0].args.big.length === 2001, m.toolActivity[0].args.big.length)
  check('args رشته کوچک دستنخورده', m.toolActivity[0].args.cmd === 'ls')
  // `items` (the full tool result) is intentionally NOT truncated — trimming it
  // would silently shrink the context sent to the provider on reconnect.
  check('items کامل حفظ شد (60)', m.toolActivity[0].items.length === 60, m.toolActivity[0].items.length)
  check('snippet کامل حفظ شد (800)', m.toolActivity[0].items[0].snippet.length === 800, m.toolActivity[0].items[0].snippet.length)
  check('children بازگشتی تریم شد', m.toolActivity[0].children[0].summary === 'nested')
  check('پیام کاربر flag ندارد', !msgs.find((x: any) => x.role === 'user').interrupted)
}

console.log('2) throttle: حداکثر یک نوشتن در هر ۲ ثانیه هنگام streaming:')
{
  const before = chatsCalls().length
  // هنوز streaming است → persist دوباره در همان پنجره → نباید بنویسد
  useStore.getState().persist()
  check('persist دوم در پنجرهٔ ۲ ثانیه ننوشت', chatsCalls().length === before, chatsCalls().length - before)
  // ۲.۵ ثانیه بعد → باید بنویسد
  fakeNow += 2500
  useStore.getState().persist()
  check('persist بعد از ۲.۵ ثانیه نوشت', chatsCalls().length === before + 1, chatsCalls().length - before)
}

console.log('3) پایان streaming: write کامل، flag interrupted پاک میشود:')
{
  const s = useStore.getState()
  const chatId = s.chats[0].id
  const asst = s.chats[0].messages.find((m) => m.role === 'assistant')!
  s.updateMessage(asst.id, { streaming: false })
  const before = chatsCalls().length
  s.persist()
  check('write کامل انجام شد', chatsCalls().length === before + 1, chatsCalls().length - before)
  const payload = lastChatsPayload()
  const m = payload.find((c: any) => c.id === chatId).messages.find((x: any) => x.id === asst.id)
  check('flag interrupted پاک شد', !m.interrupted, m.interrupted)
  check('toolActivity همچنان هست', Array.isArray(m.toolActivity) && m.toolActivity.length === 1)
}

console.log('4) updateMessage هنگام streaming → heartbeat (maybePersistMidStream):')
{
  storeCalls.length = 0
  const s = useStore.getState()
  const chatId = s.chats[0].id
  const asst = s.addMessage(chatId, { role: 'assistant', content: '', streaming: true })
  // addMessage → persist → اولین heartbeat فوری (lastMidStreamPersist از تست ۳ ریست شده)
  check('addMessage اولین heartbeat را نوشت', chatsCalls().length === 1, chatsCalls().length)
  // updateMessage در همان پنجره → نباید بنویسد
  s.updateMessage(asst.id, { content: 'توکن جدید' })
  check('updateMessage در پنجره ننوشت', chatsCalls().length === 1, chatsCalls().length)
  // بعد از ۲ ثانیه → heartbeat بعدی
  fakeNow += 2000
  s.updateMessage(asst.id, { content: 'توکن جدیدتر' })
  check('updateMessage بعد از ۲ ثانیه heartbeat نوشت', chatsCalls().length === 2, chatsCalls().length)
}

// Cleanup: end the fake stream so the pending 500ms debounce timer (scheduled by
// updateMessage → maybePersistMidStream → persistSoon) doesn't keep re-arming
// forever — the fake clock never advances on its own, so the throttle would
// never allow a write and node would never exit.
{
  const s = useStore.getState()
  const chatId = s.chats[0].id
  const streaming = s.chats[0].messages.find((m) => m.streaming)
  if (streaming) s.updateMessage(streaming.id, { streaming: false })
  s.persist() // not streaming → full write, no re-arm → event loop drains
}

if (failed) {
  console.error(`\n❌ ${failed} تست ناموفق`)
  process.exit(1)
}
console.log('\n✅ همه تستهای heartbeat پاس شدند')