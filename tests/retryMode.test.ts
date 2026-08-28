// Store-level test: a retry (restart-from-message) must run in the CURRENT
// chat mode, NOT the mode the old message was created in. The user can switch
// mode (e.g. Plan → Coder) and then hit retry; the re-sent turn must use the
// new mode, and the freshly created user bubble must record that mode.
// Run: npx esbuild test/retryMode.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-retry-mode.mjs --external:electron \
//        && node test/.tmp-retry-mode.mjs
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
const { planRetry } = await import('../src/lib/retry.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) retry بعد از تغییر مود → از مود فعلی استفاده می‌کند (نه مود پیام قدیمی):')
{
  const s = useStore.getState()
  // Start a chat in PLAN mode, send a user message (records mode: plan).
  const chatId = s.newChat('plan')
  const u1 = s.addMessage(chatId, {
    role: 'user',
    content: 'برنامه بساز',
    mode: 'plan',
  })
  s.addMessage(chatId, {
    role: 'assistant',
    content: 'دارم برنامه‌ریزی می‌کنم... [Interrupted before finishing',
    error: true,
    retry: { attempt: 3, maxAttempts: 3, delay: 0, reason: 'boom', gaveUp: true },
  })

  // User switches to CODER mode (like clicking the mode tab / Tab key).
  s.setChatMode(chatId, 'coder')

  const ch = () => useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const plan = planRetry(ch(), u1.id, 'message')
  check('plan = restart', plan?.action === 'restart', plan)
  if (plan?.action === 'restart') {
    // Mimic restartFromMessage: truncate, then send() re-creates the user bubble.
    check('truncateTo موفق', useStore.getState().truncateTo(u1.id) === true)
    // send() reads chat.mode (now 'coder') and stamps it on the new user bubble.
    const freshUser = useStore.getState().addMessage(chatId, {
      role: 'user',
      content: plan.target.content,
      mode: useStore.getState().chats.find((c) => c.id === chatId)!.mode,
    })
    check(
      'پیام کاربرِ جدید مود فعلی (coder) را دارد، نه مود قدیمی (plan)',
      freshUser.mode === 'coder',
      freshUser.mode,
    )
    check(
      'مود چت همچنان coder است (تغییر نکرده)',
      useStore.getState().chats.find((c) => c.id === chatId)!.mode === 'coder',
    )
  }
}

console.log('2) پیام کاربرِ جدید همیشه مود چت را ضبط می‌کند (یکدستی تاریخچه):')
{
  const chatId = useStore.getState().newChat('ask')
  const chatMode = useStore.getState().chats.find((c) => c.id === chatId)!.mode
  const u = useStore.getState().addMessage(chatId, {
    role: 'user',
    content: 'سوال',
    mode: chatMode,
  })
  check('مود پیام کاربر = مود چت (ask)', u.mode === 'ask', u.mode)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
