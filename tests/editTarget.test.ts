// Store-level test for the pinned composer badge: a backend `edit_target`
// event pins chat.editTarget (setChatEditTarget) AND FORCES the chat's mode to
// Build for the whole session — the previous mode is saved and restored by the
// badge's × (clearChatEditTarget) — while ONE session per chat: a DIFFERENT
// target is refused while a badge is open, until the user ends it with ×.
// Run: bash tests/run-frontend.sh
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

const target = {
  target: 'plugin',
  action: 'update',
  name: 'healer-article-pipeline',
  path: '/tmp/codifa-store-test/plugins/healer-article-pipeline',
} as const

console.log('بج ویرایش: پین شدن با set و پاک شدن فقط با ×:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const before = useStore.getState().chats.find((c) => c.id === chatId)!
  check('چت تازه بج ندارد', before.editTarget === undefined, before.editTarget)

  useStore.getState().setChatEditTarget(chatId, target)
  const pinned = useStore.getState().chats.find((c) => c.id === chatId)
  check('بج بعد از set همان هدف است', JSON.stringify(pinned?.editTarget) === JSON.stringify(target), pinned?.editTarget)
  check('مود چت برای کل سشن forced به build شد', pinned?.mode === 'build', pinned?.mode)
  check('مود قبل برای بازگردانی ذخیره شد', pinned?.editTargetPrevMode === before.mode, pinned?.editTargetPrevMode)

  useStore.getState().clearChatEditTarget(chatId)
  const cleared = useStore.getState().chats.find((c) => c.id === chatId)
  check('× بج را حذف می‌کند', cleared?.editTarget === undefined, cleared?.editTarget)
  check('بعد از × مود به همان حالت قبل برمی‌گردد', cleared?.mode === before.mode, cleared?.mode)
  check('بعد از × مود ذخیره‌شده هم پاک می‌شود', cleared?.editTargetPrevMode === undefined, cleared?.editTargetPrevMode)

  useStore.getState().deleteChat(chatId)
}

console.log('گارد یک سشن در هر چت — فقط × سشن را می‌بندد:')
{
  const s = useStore.getState()
  const chatId = s.newChat('build')
  useStore.getState().setChatEditTarget(chatId, target)

  // A DIFFERENT target while the badge is open is refused: the pinned folder
  // and Build override must hold until the user closes the session.
  const refused = useStore.getState().setChatEditTarget(chatId, {
    ...target,
    target: 'skill',
    name: 'Probe',
  })
  const held = useStore.getState().chats.find((c) => c.id === chatId)
  check('هدف متفاوت وقتی بج باز است رد می‌شود', refused === false, refused)
  check('بج روی همان هدف اول مانده', held?.editTarget?.name === target.name, held?.editTarget)

  // Re-pinning the SAME target is an echo, not a conflict.
  const again = useStore.getState().setChatEditTarget(chatId, target)
  check('پین دوبارهٔ همان هدف بی‌ضرر است', again === true, again)

  // The × is the only way out: afterwards a new target is accepted.
  useStore.getState().clearChatEditTarget(chatId)
  const modeAfterX = useStore.getState().chats.find((c) => c.id === chatId)?.mode
  check('بعد از × مود همان buildِ قبل از پین است', modeAfterX === 'build', modeAfterX)
  const after = useStore.getState().setChatEditTarget(chatId, {
    ...target,
    target: 'skill',
    name: 'Probe',
    path: '/tmp/codifa-store-test/skills/probe',
  })
  const switched = useStore.getState().chats.find((c) => c.id === chatId)
  check('بعد از × هدف جدید پذیرفته می‌شود', after === true, after)
  check('بج حالا هدف جدید است', switched?.editTarget?.name === 'Probe', switched?.editTarget)

  useStore.getState().deleteChat(chatId)
}

if (failed) {
  console.error(`FAILED: ${failed} check(s)`)
  process.exit(1)
}
console.log('editTarget badge store checks passed')
