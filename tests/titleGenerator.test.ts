// Title-generator apply chain (run via tests/run-frontend.sh as `titleGenerator`).
// The first user message of a fresh chat triggers POST /chats/title and the
// returned title replaces the auto title; a manual rename in between wins;
// later messages never trigger.
export {}
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {
      getSidecarUrl: async () => 'http://127.0.0.1:1',
      storeSet: async () => {},
    },
    {
      get: (t, prop) => {
        if (prop === 'then') return undefined
        const v = (t as any)[prop]
        if (v !== undefined) return v
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

let titleCalls = 0
let titleDone = 0
;(globalThis as any).fetch = async (url: string) => {
  const u = String(url)
  if (u.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) }
  if (u.endsWith('/chats/title')) {
    titleCalls++
    titleDone++
    return {
      ok: true,
      status: 200,
      json: async () => ({
        title: 'نمایش درصد در دایره',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          model: 'oc/space-bunny-free',
          provider: 'custom',
          provider_id: 'custom-muiw3uo6',
        },
      }),
    }
  }
  throw new Error('unexpected fetch ' + u)
}

const { useStore } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) return false
    await new Promise((r) => setTimeout(r, 10))
  }
  return true
}
async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

const LONG_TEXT =
  'توی اینپوت کامپوزر جایی که دایره کانتکس را نشان میدهد میخواهم وسط دایره با فونت کوچک عدد درصد را بنویسد فقط عددش را'

console.log('1) first user message applies the model title:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: LONG_TEXT })
  const ok = await waitFor(
    () =>
      useStore.getState().chats.find((c) => c.id === chatId)?.title ===
      'نمایش درصد در دایره',
  )
  check(
    'model title applied',
    ok,
    useStore.getState().chats.find((c) => c.id === chatId)?.title,
  )
}

console.log('2) manual rename in between is preserved:')
{
  const s = useStore.getState()
  const before = titleDone
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: LONG_TEXT })
  // Synchronous rename always lands before the async title response resolves.
  s.renameChat(chatId, 'عنوان دستی')
  const ok = await waitFor(() => titleDone > before)
  check('title response arrived', ok)
  await flush()
  check(
    'manual title kept',
    useStore.getState().chats.find((c) => c.id === chatId)?.title === 'عنوان دستی',
    useStore.getState().chats.find((c) => c.id === chatId)?.title,
  )
}

console.log('3) later messages never trigger:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: LONG_TEXT })
  const ok = await waitFor(
    () =>
      useStore.getState().chats.find((c) => c.id === chatId)?.title ===
      'نمایش درصد در دایره',
  )
  check('first title applied', ok)
  const calls = titleCalls
  s.addMessage(chatId, { role: 'user', content: 'پیام دوم' })
  await flush()
  check('no second title call', titleCalls === calls, { calls, titleCalls })
}

console.log('4) build/plan mode switch before first send still triggers:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  // Switching modes inserts a system notice — must not block the trigger.
  s.setChatMode(chatId, 'build')
  const before = titleCalls
  s.addMessage(chatId, { role: 'user', content: LONG_TEXT })
  const triggered = await waitFor(() => titleCalls === before + 1)
  check('title triggered despite mode-switch notice', triggered, {
    before,
    titleCalls,
  })
  const ok = await waitFor(
    () =>
      useStore.getState().chats.find((c) => c.id === chatId)?.title ===
      'نمایش درصد در دایره',
  )
  check('model title applied in build mode', ok)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll title generator checks passed')
process.exit(0)
