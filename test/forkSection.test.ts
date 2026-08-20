// Quick sanity test for store.forkSection (run: node test/forkSection.test.ts)
// Mock the Electron bridge before importing the store.
;(globalThis as any).window = {
  addEventListener: () => {},
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined // avoid thenable detection
        return async () => {}
      },
    },
  ),
}

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

// 1) یک چت مبدأ با یک پیام چندبخشی بساز
const srcId = useStore.getState().newChat('ask')
useStore.getState().addMessage(srcId, { role: 'user', content: 'سوال اول' })
useStore.getState().addMessage(srcId, {
  role: 'assistant',
  content: '## بخش الف\n\nمتن الف\n\n## بخش ب\n\nمتن ب',
})
const srcChat = useStore.getState().chats.find((c) => c.id === srcId)!
const srcMsg = srcChat.messages.find((m) => m.role === 'assistant')!

console.log('1) forkSection یک چت جدید با زمینه بخش میسازد:')
useStore.getState().forkSection(srcMsg.id, 'بخش ب', 'متن ب')

const s = useStore.getState()
const newChat = s.chats.find((c) => c.id === s.activeChatId)!
check('چت جدید ساخته شد', !!newChat && newChat.id !== srcId)
check('تیتر چت = تیتر بخش', newChat.title === 'بخش ب', newChat.title)
check('مود یکسان است', newChat.mode === srcChat.mode, newChat.mode)
check('یک پیام زمینه دارد', newChat.messages.length === 1, newChat.messages.length)
check('پیام زمینه role=user است', newChat.messages[0]?.role === 'user')
check('متن زمینه شامل محتوای بخش است', newChat.messages[0]?.content.includes('متن ب'))
check('متن زمینه برچسب دارد', newChat.messages[0]?.content.startsWith('📌 بخش «بخش ب»'))
check('activeChatId به چت جدید رفت', s.activeChatId === newChat.id)
check('focusComposer فعال شد', s.focusComposer === true)
check('چت مبدأ دست نخورد', useStore.getState().chats.find((c) => c.id === srcId)!.messages.length === 2)

console.log('2) messageId نامعتبر → هیچ کاری نمیکند:')
const before = useStore.getState().chats.length
useStore.getState().forkSection('does-not-exist', 'x', 'y')
check('چت جدیدی ساخته نشد', useStore.getState().chats.length === before)

console.log('3) تیتر خالی → پیشفرض «بخش»:')
const srcMsg2 = useStore.getState().chats.find((c) => c.id === srcId)!.messages.find((m) => m.role === 'assistant')!
useStore.getState().forkSection(srcMsg2.id, '   ', 'متن')
const newChat2 = useStore.getState().chats.find((c) => c.id === useStore.getState().activeChatId)!
check('تیتر پیشفرض «بخش»', newChat2.title === 'بخش', newChat2.title)

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')