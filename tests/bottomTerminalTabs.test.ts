// BOTTOM terminal panel: rename + survive a restart + per-workspace tabs.
// (src/lib/bottomTerminalTabs.ts)
//
// Reported: (1) terminal tabs could not be renamed, (2) tabs vanished after an
// app restart, (3) a new terminal must open in the workspace the user is in,
// and (4) that after switching workspace the PREVIOUS workspace's tabs must not
// be shown — each workspace keeps its own saved strip.
import {
  allBottomTerminalWorkspaces,
  currentTerminalWorkspace,
  loadBottomTerminalTabs,
  normalizeTerminalTitle,
  saveBottomTerminalTabs,
  terminalTabLabel,
  workspaceCwdForNewTerminal,
  NO_WORKSPACE,
  type PersistedTerminalTab,
} from '../src/lib/bottomTerminalTabs'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('  ✓ ' + name)
  else {
    failures++
    console.log('  ✗ ' + name, detail === undefined ? '' : JSON.stringify(detail))
  }
}

// Minimal localStorage so the module's guards take the real path.
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}

console.log('۱) rename — نام تایپ‌شده، خالی = برگشت به نام شل')
check('نام ساده پذیرفته می‌شود', normalizeTerminalTitle('backend') === 'backend')
check('فاصله‌های اطراف حذف می‌شود', normalizeTerminalTitle('  api  ') === 'api')
check('خالی → undefined (برمی‌گردد به نام شل)', normalizeTerminalTitle('   ') === undefined)
check('عنوان دستی بر شل اولویت دارد', terminalTabLabel({ title: 'backend', shell: 'zsh' }) === 'backend')
check('بدون عنوان دستی، نام شل نمایش داده می‌شود', terminalTabLabel({ shell: 'zsh' }) === 'zsh')
check('عنوان خالی هم به شل برمی‌گردد', terminalTabLabel({ title: '  ', shell: 'bash' }) === 'bash')

console.log('\n۲) persist — تب‌ها در localStorage می‌مانند')
const tabsA: PersistedTerminalTab[] = [
  { key: 'pty-1', title: 'backend', shell: 'zsh', cwd: '/work/proj-a', wsKey: '/work/proj-a' },
  { key: 'pty-2', shell: 'zsh', cwd: '/work/proj-a', wsKey: '/work/proj-a', active: true },
]
saveBottomTerminalTabs('/work/proj-a', tabsA)
const back = loadBottomTerminalTabs('/work/proj-a')
check('هر دو تب برمی‌گردند', back.length === 2, back)
check('نام دستی حفظ شد', back[0].title === 'backend', back[0])
check('cwd حفظ شد', back[0].cwd === '/work/proj-a', back[0])
check('ورک‌اسپیس حفظ شد', back[0].wsKey === '/work/proj-a', back[0])
check('تبِ فعال مشخص است', back[1].active === true, back[1])
check('شناسهٔ pty هرگز ذخیره نمی‌شود', !('id' in (back[0] as any)), back[0])

console.log('\n۳) هر ورک‌اسپیس تب‌های خودش را دارد — تب ورک‌اسپیس قبلی نمایش داده نمی‌شود')
saveBottomTerminalTabs('/work/proj-b', [
  { key: 'p1', title: 'web', shell: 'zsh', cwd: '/work/proj-b', wsKey: '/work/proj-b' },
])
const a = loadBottomTerminalTabs('/work/proj-a')
const b = loadBottomTerminalTabs('/work/proj-b')
check('A فقط تب‌های خودش را می‌بیند', a.length === 2 && a.every((t) => t.wsKey === '/work/proj-a'), a)
check('B فقط تب‌های خودش را می‌بیند', b.length === 1 && b[0].wsKey === '/work/proj-b', b)
check('نام‌ها بین دو ورک‌اسپیس قاطی نمی‌شوند', a.some((t) => t.title === 'backend') && !b.some((t) => t.title === 'backend'), b)
check('هر دو ورک‌اسپیس ذخیره شده‌اند', allBottomTerminalWorkspaces().sort().join(',') === '/work/proj-a,/work/proj-b', allBottomTerminalWorkspaces())
check('ورک‌اسپیس ناشناخته → خالی (نه تب‌های دیگری)', loadBottomTerminalTabs('/work/other').length === 0)

console.log('\n۴) ذخیرهٔ یک ورک‌اسپیس، ورک‌اسپیس دیگر را پاک نمی‌کند')
saveBottomTerminalTabs('/work/proj-b', [])
check('خالی‌کردن B، A را نگه می‌دارد', loadBottomTerminalTabs('/work/proj-a').length === 2)
check('B واقعاً خالی شد', loadBottomTerminalTabs('/work/proj-b').length === 0)
check('B از فهرست ورک‌اسپیس‌ها حذف شد', !allBottomTerminalWorkspaces().includes('/work/proj-b'), allBottomTerminalWorkspaces())

console.log('\n۵) load — پیلود خراب/قدیمی پنل را نمی‌شکند')
mem.set('coder:bottomTerminalTabs', '{not json')
check('JSON خراب → []', loadBottomTerminalTabs('/work/proj-a').length === 0)
mem.delete('coder:bottomTerminalTabs')
check('نبود کلید → []', loadBottomTerminalTabs('/work/proj-a').length === 0)
// Legacy flat shape from the previous version: folds into its own wsKey bucket.
mem.set(
  'coder:bottomTerminalTabs',
  JSON.stringify({
    tabs: [
      { key: 'old-1', title: 'legacy', shell: 'zsh', cwd: '/work/proj-a', wsKey: '/work/proj-a' },
      { key: 'x' },
      null,
    ],
  }),
)
const legacy = loadBottomTerminalTabs('/work/proj-a')
check('پیلود قدیمی به باکت ورک‌اسپیس خودش منتقل می‌شود', legacy.length === 1 && legacy[0].title === 'legacy', legacy)
check('ردیف ناقص دور ریخته می‌شود', legacy.every((t) => typeof t.cwd === 'string'))

console.log('\n۶) ورک‌اسپیس — ترمینال جدید در ورک‌اسپیس فعلی باز می‌شود')
const twoProjects = {
  chats: [
    { id: 'c-a', root: '/work/proj-a' },
    { id: 'c-b', root: '/work/proj-b' },
  ],
  activeChatId: 'c-b',
  root: '/work/loaded-first',
}
check('cwd = ریشهٔ چتِ باز، نه پروژهٔ اولِ بارگذاری', workspaceCwdForNewTerminal(twoProjects) === '/work/proj-b')
check('بدون چت باز → ریشهٔ اپ', workspaceCwdForNewTerminal({ chats: [], activeChatId: null, root: '/work/app' }) === '/work/app')
check('خالی → رشتهٔ خالی (main process → home)', workspaceCwdForNewTerminal({ chats: [] }) === '')
// `currentTerminalWorkspace` is the store SELECTOR the panel subscribes with, so
// it must derive from the state it is HANDED. (It used to delegate to
// `workspaceKeyForChat`, which reads `useStore.getState()` internally: with the
// store not yet populated the selector answered `__none__`, so every
// workspace's tabs landed in the "no project" bucket and leaked into each
// other.) Pin the pure contract: a plain object decides the answer.
{
  check('شناسهٔ ورک‌اسپیس از چتِ باز (بدون خواندن استور)', currentTerminalWorkspace({ chats: twoProjects.chats, activeChatId: 'c-b', root: '/x' }) === '/work/proj-b', currentTerminalWorkspace({ chats: twoProjects.chats, activeChatId: 'c-b', root: '/x' }))
  const ka = currentTerminalWorkspace({ chats: twoProjects.chats, activeChatId: 'c-a', root: '/x' })
  check('چت دیگر → ورک‌اسپیس دیگر', ka === '/work/proj-a', ka)
  check('بدون پروژه → __none__', currentTerminalWorkspace({ chats: [], activeChatId: null, root: '' }) === NO_WORKSPACE)
  check('بدون چت باز → ریشهٔ اپ', currentTerminalWorkspace({ chats: [], activeChatId: null, root: '/work/app' }) === '/work/app')
}

console.log('\n۷) رفت‌وبرگشت — دو ترمینال جدا در یک ورک‌اسپیس')
mem.clear()
saveBottomTerminalTabs('/work/proj-a', [
  { key: 'k1', title: 'api', shell: 'zsh', cwd: '/work/proj-a', wsKey: '/work/proj-a' },
  { key: 'k2', title: 'web', shell: 'zsh', cwd: '/work/proj-a', wsKey: '/work/proj-a' },
])
const r = loadBottomTerminalTabs('/work/proj-a')
check('هر دو جدا می‌مانند', r.length === 2, r)
check('نام‌ها قاطی نمی‌شوند', r[0].title === 'api' && r[1].title === 'web', r)
check('کلیدها یکتا', new Set(r.map((t) => t.key)).size === 2)
check('باکت پیش‌فرض «بدون پروژه»', NO_WORKSPACE === '__none__' && loadBottomTerminalTabs().length === 0)

console.log('\n۸) نشتی — تب بدون wsKey نباید به همهٔ ورک‌اسپیس‌ها سرریز کند')
mem.clear()
// An ADOPTED shell (left running by a dev reload) carries no wsKey.
saveBottomTerminalTabs('/work/proj-a', [{ key: 'adopted', shell: 'zsh', cwd: '/work/proj-a' }])
check('تب بدون wsKey فقط در باکت خودش است', loadBottomTerminalTabs('/work/proj-a').length === 1)
check('ورک‌اسپیس دیگر آن را نمی‌بیند', loadBottomTerminalTabs('/work/proj-b').length === 0)
check('باكت __none__ هم آن را نمی‌بیند', loadBottomTerminalTabs(NO_WORKSPACE).length === 0)

console.log(failures === 0 ? '\nbottomTerminalTabs: all checks passed' : `\nbottomTerminalTabs: ${failures} FAILED`)
if (failures > 0) process.exit(1)
