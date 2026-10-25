// Fork-chat semantics (run via tests/run-frontend.sh as `forkChat`).
//
// A fork exists to escape a long, expensive conversation, so it must NOT copy
// the transcript: it carries ONE compacted `system` seed and resets the title
// to 'New chat', which lets the existing title generator name the fork from the
// user's first NEW message.
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
;(globalThis as any).fetch = async (url: string) => {
  const u = String(url)
  if (u.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) }
  if (u.endsWith('/chats/title')) {
    titleCalls++
    return {
      ok: true,
      status: 200,
      json: async () => ({
        title: 'عنوان فورک',
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

const { useStore, forkSeedMessage } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

console.log('1) a fork carries a compacted seed, never the transcript:')
{
  const s = useStore.getState()
  const srcId = s.newChat('ask')
  s.renameChat(srcId, 'چت طولانی')
  s.addMessage(srcId, { role: 'user', content: 'اولین سوال من درباره ی دیتابیس' })
  s.addMessage(srcId, { role: 'assistant', content: 'پاسخ اول' })
  s.addMessage(srcId, { role: 'user', content: 'سوال دوم درباره ی استریم' })
  s.addMessage(srcId, { role: 'assistant', content: 'پاسخ دوم' })

  const src = useStore.getState().chats.find((c) => c.id === srcId)!
  const forkId = useStore.getState().forkChatFromMessage(src.messages[3].id)!
  const fork = useStore.getState().chats.find((c) => c.id === forkId)!

  check('fork created', !!forkId && forkId !== srcId)
  check('exactly one seed message', fork.messages.length === 1, fork.messages.length)
  check('seed is a system message', fork.messages[0].role === 'system', fork.messages[0])
  check(
    'seed summaries the earlier conversation',
    fork.messages[0].content.includes('استریم') &&
      fork.messages[0].content.includes('دیتابیس'),
    fork.messages[0].content,
  )
  check(
    'seed is NOT compacted (must reach the model)',
    !fork.messages[0].compacted,
    fork.messages[0].compacted,
  )
  check('fork holds no copied user turn', !fork.messages.some((m) => m.role === 'user'))
  check('fork is far smaller than the source', fork.messages.length < src.messages.length)
}

console.log('2) the fork title regenerates from the first NEW message:')
{
  const s = useStore.getState()
  const srcId = s.newChat('ask')
  s.renameChat(srcId, 'چت طولانی')
  s.addMessage(srcId, { role: 'user', content: 'پیام قدیمی' })
  s.addMessage(srcId, { role: 'assistant', content: 'پاسخ قدیمی' })
  const src = useStore.getState().chats.find((c) => c.id === srcId)!
  const forkId = useStore.getState().forkChatFromMessage(src.messages[1].id)!

  check(
    'fork starts on the untouched placeholder',
    useStore.getState().chats.find((c) => c.id === forkId)?.title === 'New chat',
    useStore.getState().chats.find((c) => c.id === forkId)?.title,
  )

  const before = titleCalls
  useStore.getState().addMessage(forkId, { role: 'user', content: 'رفع خطای استریم' })
  const triggered = await waitFor(() => titleCalls === before + 1)
  check('first new message triggers the title call', triggered, { before, titleCalls })

  const applied = await waitFor(
    () => useStore.getState().chats.find((c) => c.id === forkId)?.title === 'عنوان فورک',
  )
  check('generated title applied to the fork', applied, {
    title: useStore.getState().chats.find((c) => c.id === forkId)?.title,
  })
}

console.log('3) a fork of a still-streaming turn is not itself streaming:')
{
  const s = useStore.getState()
  const srcId = s.newChat('ask')
  s.addMessage(srcId, { role: 'user', content: 'سوال' })
  s.addMessage(srcId, { role: 'assistant', content: 'در حال نوشتن', streaming: true })

  const live = useStore.getState().chats.find((c) => c.id === srcId)!
  const forkId = useStore.getState().forkChatFromMessage(live.messages[1].id)!
  const fork = useStore.getState().chats.find((c) => c.id === forkId)!
  check('fork copied nothing mid-stream', !fork.messages.some((m) => m.streaming), fork.messages)
}

console.log('4) the seed keeps the newest turns when the budget runs out:')
{
  const s = useStore.getState()
  const srcId = s.newChat('ask')
  for (let i = 0; i < 40; i++) {
    s.addMessage(srcId, { role: 'user', content: `پیام شماره ${i} ` + 'x'.repeat(500) })
  }
  const src = useStore.getState().chats.find((c) => c.id === srcId)!
  const seed = forkSeedMessage(src, src.messages.length - 1)
  check('seed stays within the budget', seed.content.length < 6000, seed.content.length)
  check('newest turn survives the cut', seed.content.includes('پیام شماره 39'))
  // 40 messages at ~515 chars each cannot fit the budget, so the seed must
  // carry only the newest slice — one line per quoted message.
  const quoted = seed.content.split('\n').filter((l) => l.startsWith('User: '))
  check('the seed is capped to the newest slice', quoted.length < 40, quoted.length)
  check(
    'the oldest turn was dropped',
    !quoted.some((l) => l.startsWith('User: پیام شماره 0 ')),
    quoted[0]?.slice(0, 40),
  )
  check(
    'the newest quoted turn is the last one',
    quoted[quoted.length - 1]?.startsWith('User: پیام شماره 39 '),
    quoted[quoted.length - 1]?.slice(0, 40),
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll fork chat checks passed')
