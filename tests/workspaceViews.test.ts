// Per-workspace chat views: each project owns its tabs/windows, workspace
// switching restores that project's view, and opening/creating a chat from
// another project activates the chat's workspace first.
//
// Run: npm run test:frontend (or bundle with esbuild + --external:electron).

// store.ts touches window.coder at module load; define the bridge first.
const disk = new Map<string, string>()
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => {
      disk.set(k, String(v))
    },
    removeItem: (k: string) => {
      disk.delete(k)
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}

const { useStore, workspaceKey } = await import('../src/lib/store.ts')
const { buildGroups } = await import('../src/components/Sidebar.tsx')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const keyA = workspaceKey('/ws-a')
const keyB = workspaceKey('/ws-b')

useStore.getState().createWorkspace('/ws-a')
useStore.getState().createWorkspace('/ws-b')

console.log('۱) هر ورک‌اسپیس تب‌های خودش را دارد:')
const chatA1 = useStore.getState().newChatInRoot('/ws-a')
const chatA2 = useStore.getState().newChat('/ws-a')
{
  const s = useStore.getState()
  check('چت‌ها به ورک‌اسپیس فعال تعلق دارند', s.activeWorkspaceKey === keyA, s.activeWorkspaceKey)
  check('چت‌های A در تب‌های A هستند', s.openChatIds.includes(chatA1) && s.openChatIds.includes(chatA2))
  check('هیچ چت B ساخته نشده', s.chats.every((c) => workspaceKey(c.root ?? '') === keyA))
}

console.log('۲) رفتن به B نمای A را ذخیره و نمای B را بازیابی می‌کند:')
const chatB = useStore.getState().newChatInRoot('/ws-b')
{
  const s = useStore.getState()
  check('ورک‌اسپیس فعال B است', s.activeWorkspaceKey === keyB)
  check('تب‌های B فقط چت B را دارند', s.openChatIds.length === 1 && s.openChatIds[0] === chatB, s.openChatIds)
  check('چت A در تب‌های B نیست', !s.openChatIds.includes(chatA1))
  const savedA = s.workspaceViews[keyA]
  check(
    'نمای A با تب‌هایش ذخیره شد',
    !!savedA && savedA.openChatIds.includes(chatA1) && savedA.activeChatId === chatA2,
    savedA,
  )
}

console.log('۳) باز کردن چت A از هر جا اول A را فعال می‌کند:')
{
  useStore.getState().openChat(chatA1)
  const s = useStore.getState()
  check('ورک‌اسپیس فعال A شد', s.activeWorkspaceKey === keyA)
  check('چت A فوکوس گرفت', s.activeChatId === chatA1)
  check('تب B در نمای A نیست', !s.openChatIds.includes(chatB), s.openChatIds)
  const savedB = s.workspaceViews[keyB]
  check('نمای B با تب B ذخیره شد', !!savedB && savedB.openChatIds.includes(chatB), savedB)
}

console.log('۴) چت جدید به ورک‌اسپیس فعال می‌چسبد (نه آخرین مسیر):')
{
  const chatA3 = useStore.getState().newChat()
  const s = useStore.getState()
  check('root چت فعال A است', s.chats.find((c) => c.id === chatA3)?.root === '/ws-a', s.chats.find((c) => c.id === chatA3)?.root)
}

console.log('۵) حذف ورک‌اسپیس فعال به ورک‌اسپیس باقی‌مانده می‌رود:')
{
  useStore.getState().switchWorkspace(keyA)
  useStore.getState().deleteWorkspace(keyA)
  const s = useStore.getState()
  check('ورک‌اسپیس حذف شد', !s.workspaces.some((w) => w.key === keyA))
  check('ورک‌اسپیس فعال B شد', s.activeWorkspaceKey === keyB, s.activeWorkspaceKey)
  check('تب B بازیابی شد', s.openChatIds.includes(chatB), s.openChatIds)
  check('چت A حذف شد', !s.chats.some((c) => c.id === chatA1))
  check('نمای A حذف شد', s.workspaceViews[keyA] === undefined)
  check('سابقه A حذف شد', s.workspaceLastUsedAt[keyA] === undefined)
}

console.log('۶) ترتیب سایدبار: پین‌شده‌ها اول، بعد تازه‌ترین فعال‌سازی:')
{
  const workspaces = [
    { key: '/a', root: '/a', label: 'A' },
    { key: '/b', root: '/b', label: 'B' },
    { key: '/c', root: '/c', label: 'C' },
    { key: '/d', root: '/d', label: 'D' },
  ]
  const chats = [
    { id: '1', root: '/a', updatedAt: 100, createdAt: 1 },
    { id: '2', root: '/b', updatedAt: 200, createdAt: 1 },
    { id: '3', root: '/c', updatedAt: 300, createdAt: 1 },
    { id: '4', root: '/d', updatedAt: 400, createdAt: 1 },
  ]
  const groups = buildGroups(chats, workspaces, ['/c'], [], {
    '/a': 1000,
    '/b': 3000,
    '/c': 0,
    '/d': 2000,
  })
  check(
    'ترتیب = پین‌شده، سپس recency نزولی',
    groups.map((g) => g.key).join(',') === '/c,/b,/d,/a',
    groups.map((g) => g.key),
  )
  const noRecency = buildGroups(chats, workspaces, [], [], {})
  check(
    'بدون recency، تازه‌ترین چت ملاک است',
    noRecency.map((g) => g.key).join(',') === '/d,/c,/b,/a',
    noRecency.map((g) => g.key),
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌ها پاس شدند ✅')
