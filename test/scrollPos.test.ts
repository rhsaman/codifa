// Store-level test for the chat scroll-position persistence:
//  - setChatScrollPos stores the EXACT anchor {id, offset, atBottom} per chat
//  - it does NOT bump updatedAt (scrolling must never reorder chats)
//  - the sanitized chats payload written to the DB keeps scrollPos, so the
//    exact viewport survives a restart (chat switch / app close)
//  - setChatScrollPosMem updates the store WITHOUT persisting (no extra write)
// Run: npx esbuild test/scrollPos.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-scroll.mjs --external:electron \
//        && node test/.tmp-scroll.mjs
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
            writes.push([key, value])
            return true
          }
        }
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const writes: Array<[string, unknown]> = []

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

const lastChatsWrite = () => [...writes].reverse().find(([k]) => k === 'chats')?.[1] as
  | Array<{ id: string; scrollPos?: unknown }>
  | undefined

console.log('1) setChatScrollPos موقعیت دقیق (anchor + offset) را ذخیره میکند:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const m1 = s.addMessage(chatId, { role: 'user', content: 'سلام' })
  const m2 = s.addMessage(chatId, { role: 'assistant', content: 'سلام! چطور کمکت کنم؟' })
  const chat = () => useStore.getState().chats.find((c) => c.id === chatId)!
  const before = chat().updatedAt

  // کاربر بالای صفحه اسکرول کرده — anchor دقیقاً همان پیامِ بالای ویوپورت + offset:
  s.setChatScrollPos(chatId, { id: m2.id, offset: -12, atBottom: false })
  const pos = chat().scrollPos
  check(
    'anchor دقیق ذخیره شد (id + offset + atBottom)',
    pos?.id === m2.id && pos?.offset === -12 && pos?.atBottom === false,
    pos,
  )
  check('updatedAt تغییر نکرد (اسکرول چتها را مرتب نمیکند)', chat().updatedAt === before, chat().updatedAt)

  // persist() → writeStateNow → api.storeSet('chats', sanitizeChats(...)):
  const payload = lastChatsWrite()?.find((c) => c.id === chatId)
  check(
    'scrollPos در snapshot دیسک هست (بعد از restart هم میماند)',
    payload?.scrollPos?.id === m2.id && (payload?.scrollPos as any)?.offset === -12,
    payload?.scrollPos,
  )
  void m1
}

console.log('2) setChatScrollPosMem بدون persist آپدیت میکند (بدون نوشتن اضافه):')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'سلام' })
  const chat = () => useStore.getState().chats.find((c) => c.id === chatId)!
  const before = chat().updatedAt
  const writesBefore = writes.length

  // حالت atBottom (پایین صفحه) — id استفاده نمیشود، خالی است:
  s.setChatScrollPosMem(chatId, { id: '', offset: 0, atBottom: true })
  check('موقعیت atBottom ذخیره شد', chat().scrollPos?.atBottom === true && chat().scrollPos?.id === '', chat().scrollPos)
  check('هیچ نوشتهای به دیسک نرفت', writes.length === writesBefore, writes.length - writesBefore)
  check('updatedAt تغییر نکرد', chat().updatedAt === before, chat().updatedAt)
}

console.log('3) پاک کردن موقعیت با null:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'سلام' })
  const chat = () => useStore.getState().chats.find((c) => c.id === chatId)!
  s.setChatScrollPos(chatId, { id: 'x', offset: 5, atBottom: false })
  check('قبل از پاک کردن ذخیره شده', chat().scrollPos !== null)
  s.setChatScrollPos(chatId, null)
  check('setChatScrollPos(chatId, null) پاک میکند', chat().scrollPos === null)
}

console.log('4) موقعیت per-chat است (چتهای دیگر دست نمیخورند):')
{
  const s = useStore.getState()
  const a = s.newChat('ask')
  const b = s.newChat('ask')
  s.addMessage(a, { role: 'user', content: 'سلام' })
  s.addMessage(b, { role: 'user', content: 'سلام' })
  s.setChatScrollPos(a, { id: 'anchor-a', offset: -3, atBottom: false })
  const chatB = useStore.getState().chats.find((c) => c.id === b)!
  // چت تازه scrollPos ندارد (undefined/null — هر دو «ذخیره نشده» هستند):
  check('چت B بدون scrollPos ماند', chatB.scrollPos == null, chatB.scrollPos)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست ناموفق`)
  process.exit(1)
}
console.log('\n✅ همه تستهای scrollPos پاس شدند')