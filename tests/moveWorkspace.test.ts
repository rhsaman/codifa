// تست واحد برای store.moveWorkspace: تغییر مسیر (root) یک ورک‌اسپیس.
// سناریو: کاربر از منوی سه‌نقطه سایدبار گزینه «تغییر مسیر» را می‌زند، پوشه جدید
// انتخاب می‌کند و همه چت‌ها/پین/رنگ باید به کلید جدید منتقل شوند.
// اجرا (تکی): npx esbuild tests/moveWorkspace.test.ts --bundle --platform=node
//   --format=esm --outfile=tests/.tmp-mw.mjs --external:electron && node tests/.tmp-mw.mjs

// store.ts هنگام بارگذاری سطح ماژول به window.coder وابسته است؛ پس باید
// window را پیش از import تعریف کنیم (هم‌الگو با tests/forkSection.test.ts).
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

const { useStore, workspaceKey } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) تغییر مسیر ورک‌اسپیس: چت‌ها، پین و رنگ منتقل می‌شوند:')
{
  const s0 = useStore.getState()
  s0.createWorkspace('/a')
  const chatId = s0.newChatInRoot('/a')
  useStore.getState().togglePinWorkspace(workspaceKey('/a'))
  useStore.getState().setWorkspaceColor(workspaceKey('/a'), '#ff0000')

  const nextKey = useStore.getState().moveWorkspace(workspaceKey('/a'), '/b')
  const s = useStore.getState()
  check('کلید جدید برابر مسیر جدید است', nextKey === workspaceKey('/b'), nextKey)
  check('ورک‌اسپیس قدیمی حذف شد', !s.workspaces.some((w) => w.key === workspaceKey('/a')))
  const ws = s.workspaces.find((w) => w.key === nextKey)
  check('ورک‌اسپیس جدید با root جدید هست', !!ws && ws.root === '/b', ws)
  check('چت به مسیر جدید منتقل شد', s.chats.find((c) => c.id === chatId)?.root === '/b')
  check('پین به کلید جدید منتقل شد', s.pinnedWorkspaces.includes(nextKey))
  check('رنگ به کلید جدید منتقل شد', s.workspaceColors[nextKey] === '#ff0000')
}

console.log('۲) مسیر یکسان با اسلش انتهایی: کلید عوض نمی‌شود:')
{
  const key = workspaceKey('/b')
  const out = useStore.getState().moveWorkspace(key, '/b/')
  const s = useStore.getState()
  check('همان کلید برگشت', out === key, out)
  check('ورک‌اسپیس تکراری ساخته نشد', s.workspaces.filter((w) => w.key === key).length === 1)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌ها پاس شدند ✅')
