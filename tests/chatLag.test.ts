// Regression test for composer/sidebar lag:
// - setChatDraft must only rebuild the edited chat (other chat objects keep identity)
// - repeating the same draft must be a no-op (no new chats array)
// - per-token updateMessage must keep other chats referentially stable
// Run: npx esbuild tests/chatLag.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=tests/.tmp-lag.mjs --external:electron \
//        && node tests/.tmp-lag.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

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

console.log('1) setChatDraft only rebuilds the edited chat:')
{
  const s = useStore.getState()
  const a = s.newChat('ask')
  const b = s.newChat('ask')
  const before = useStore.getState()
  const chatA = before.chats.find((c) => c.id === a)!
  const chatB = before.chats.find((c) => c.id === b)!
  useStore.getState().setChatDraft(a, { input: 'hello' })
  const after = useStore.getState()
  const nextA = after.chats.find((c) => c.id === a)!
  const nextB = after.chats.find((c) => c.id === b)!
  check('edited chat got a new object', nextA !== chatA)
  check('other chat kept identity', nextB === chatB)
  check('draft value applied', nextA.draft?.input === 'hello')
}

console.log('2) repeating the same draft is a no-op:')
{
  const s = useStore.getState()
  const id = s.newChat('ask')
  s.setChatDraft(id, { input: 'same' })
  const ref1 = useStore.getState().chats
  s.setChatDraft(id, { input: 'same' })
  const ref2 = useStore.getState().chats
  check('chats array identity kept on identical draft', ref1 === ref2, {
    same: ref1 === ref2,
  })
}

console.log('3) per-token updateMessage keeps other chats stable:')
{
  const s = useStore.getState()
  const a = s.newChat('ask')
  const b = s.newChat('ask')
  const stream = s.addMessage(a, { role: 'assistant', content: '', streaming: true })
  const beforeB = useStore.getState().chats.find((c) => c.id === b)!
  s.updateMessage(stream.id, { content: 'tok1' })
  s.updateMessage(stream.id, { content: 'tok1 tok2' })
  const afterB = useStore.getState().chats.find((c) => c.id === b)!
  check('other chat kept identity across tokens', beforeB === afterB)
  const msg = useStore.getState().chats.find((c) => c.id === a)!.messages.find((m) => m.id === stream.id)!
  check('streamed content applied', msg.content === 'tok1 tok2', msg.content)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed ❌`)
  process.exit(1)
}
console.log('\nAll chat lag tests passed ✅')
process.exit(0)
