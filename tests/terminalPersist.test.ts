// Right-pane terminal tabs: RENAME + SURVIVE A RESTART + stay in their
// workspace.
//
// Reported: (1) terminal tabs could not be renamed, (2) every terminal tab
// vanished after an app restart, (3) a "new terminal" opened in whichever
// project the app had loaded first instead of the current workspace.
//
// Cause of (2): `terminal` sat in EPHEMERAL_KINDS, so persist() dropped every
// terminal tab from localStorage; and even when kept, loadPersisted()
// recomputed the id from chatId, which collapsed several shells into one.
// Run with: node --test (bundled, see tests/run-frontend.sh entry `terminalPersist`).

import { EPHEMERAL_KINDS, useViewerTabs, viewerTabId, workspaceKeyForChat } from '../src/lib/viewerTabs'
import { useStore } from '../src/lib/store'

let failures = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const g = globalThis as any

/** Minimal localStorage the store's persist()/loadPersisted() agree on. */
function installStorage(): Map<string, string> {
  const mem = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }
  return mem
}

function reset(tabs: any[], activeId: string | null): void {
  // Seed the real store: reset() is what the app's own restart path uses.
  const cur = useViewerTabs.getState()
  useViewerTabs.setState({ ...cur, tabs, activeId, closedTabs: [] })
}

function snap() {
  const s = useViewerTabs.getState()
  return {
    tabs: s.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title, cwd: t.terminalCwd })),
    activeId: s.activeId,
  }
}

// ---------------------------------------------------------------- store seed
const mem = installStorage()
useStore.setState({
  ...useStore.getState(),
  root: '/work/proj-a',
  activeChatId: '',
  chats: [] as any,
})

section('۱) EPHEMERAL_KINDS دیگر terminal را دور نمی‌ریزد (تب‌ها بعد از ری‌استارت می‌مانند)')
check('terminal در EPHEMERAL_KINDS نیست', !EPHEMERAL_KINDS.has('terminal'), [...EPHEMERAL_KINDS])

section('۲) persist() تب ترمینال را با cwd/program/shell/عنوان ذخیره می‌کند')
{
  const wsKey = workspaceKeyForChat(undefined)
  const t1 = {
    id: viewerTabId('terminal', wsKey, 'shell'),
    kind: 'terminal' as const,
    chatId: '',
    wsKey,
    title: 'zsh',
    terminalCwd: '/work/proj-a',
    terminalShell: '/bin/zsh',
    createdAt: 1,
  }
  reset([t1] as any, t1.id)
  // Any shim that persists (rename is the cheapest) writes the whole list.
  useViewerTabs.getState().renameViewer(t1.id, 'backend')
  const raw = mem.get('coder:viewerTabs')
  const saved = raw ? JSON.parse(raw) : { tabs: [] }
  check('پیلود در localStorage نوشته شد', !!raw)
  check('تب ترمینال در پیلود هست', saved.tabs.some((t: any) => t.kind === 'terminal'), saved.tabs)
  const row = saved.tabs.find((t: any) => t.kind === 'terminal')
  check('cwd حفظ شد', row?.terminalCwd === '/work/proj-a', row)
  check('shell حفظ شد', row?.terminalShell === '/bin/zsh', row)
  check('عنوان تغییر یافته حفظ شد', row?.title === 'backend', row)
}

section('۳) renameViewer عنوان را عوض می‌کند و id/kind را دست نمی‌زند')
{
  const wsKey = workspaceKeyForChat(undefined)
  const id = viewerTabId('terminal', wsKey, 'shell')
  const t = {
    id,
    kind: 'terminal' as const,
    chatId: '',
    wsKey,
    title: 'zsh',
    terminalCwd: '/work/proj-a',
    terminalShell: '/bin/zsh',
    createdAt: 1,
  }
  reset([t] as any, id)
  useViewerTabs.getState().renameViewer(id, '  my   server  ')
  const after = snap().tabs[0]
  check('عنوان trim و فشرده شد', after.title === 'my server', after.title)
  check('id تغییر نکرد', after.id === id, after.id)
  check('kind تغییر نکرد', after.kind === 'terminal', after.kind)
  check('cwd تغییر نکرد', after.cwd === '/work/proj-a', after.cwd)

  // Blank clears the label (the strip then falls back to the shell name).
  useViewerTabs.getState().renameViewer(id, '   ')
  check('نام خالی پاک می‌شود', snap().tabs[0].title === '', snap().tabs[0].title)

  // A no-op rename must not churn state.
  useViewerTabs.getState().renameViewer(id, '')
  check('rename تکراری همان مقدار را نگه می‌دارد', snap().tabs[0].title === '')
  check('rename روی تب ناموجود بی‌اثر است', (() => {
    useViewerTabs.getState().renameViewer('terminal:nope:shell', 'x')
    return snap().tabs.length === 1
  })())
}

section('۴) چند ترمینال در یک ورک‌اسپیس بعد از ری‌استارت از هم جدا می‌مانند')
{
  const wsKey = workspaceKeyForChat(undefined)
  const a = {
    id: viewerTabId('terminal', wsKey, 'shell'),
    kind: 'terminal' as const,
    chatId: '',
    wsKey,
    title: 'zsh',
    terminalCwd: '/work/proj-a',
    terminalShell: '/bin/zsh',
    createdAt: 1,
  }
  const b = {
    id: viewerTabId('terminal', wsKey, 'shell-111-0'),
    kind: 'terminal' as const,
    chatId: '',
    wsKey,
    title: 'logs',
    terminalCwd: '/work/proj-a',
    terminalShell: '/bin/zsh',
    createdAt: 2,
  }
  reset([a, b] as any, b.id)
  useViewerTabs.getState().renameViewer(a.id, 'api') // force a persist
  const raw = JSON.parse(mem.get('coder:viewerTabs') || '{"tabs":[]}')
  const ids = raw.tabs.filter((t: any) => t.kind === 'terminal').map((t: any) => t.id)
  check('هر دو تب ترمینال ذخیره شدند', ids.length === 2, ids)
  check('شناسه‌ها یکتا هستند', new Set(ids).size === 2, ids)
  check('شناسه‌ها wsKey را دارند', ids.every((i: string) => i.includes(wsKey)), { ids, wsKey })
  check('شناسهٔ fresh ترمینال حفظ شد', ids.includes(viewerTabId('terminal', wsKey, 'shell-111-0')), ids)
}

section('۵) هر ورک‌اسپیس تب ترمینال خودش را دارد')
{
  const wsA = workspaceKeyForChat(undefined)
  // A chat rooted in another project: its scope key differs.
  useStore.setState({ ...useStore.getState(), chats: [{ id: 'c-b', root: '/work/proj-b' }] as any })
  const wsB = workspaceKeyForChat('c-b')
  check('کلید ورک‌اسپیس B از A جداست', wsA !== wsB, { wsA, wsB })
  const idA = viewerTabId('terminal', wsA, 'shell')
  const idB = viewerTabId('terminal', wsB, 'shell')
  check('شناسهٔ ترمینال دو ورک‌اسپیس یکسان نیست', idA !== idB, { idA, idB })
  check('هر شناسه ورک‌اسپیس خودش را دارد', idA.includes(wsA) && idB.includes(wsB), { idA, idB })
  // Back to the no-project bucket for cleanliness.
  useStore.setState({ ...useStore.getState(), chats: [] as any })
}

section('۶) loadPersisted — ری‌استارت واقعی: تب ترمینال از localStorage بازگردانی می‌شود')
{
  // THE regression that a persist-side test cannot catch: `terminal` is in
  // WORKSPACE_SCOPED_KINDS but a terminal row carries `chatId: ""`, so the
  // "ownerless scoped tab is unknowable" guard in loadPersisted() dropped every
  // restored terminal. loadPersisted runs at module load, so a fresh module
  // instance (cache busted via the query string) is the only honest restart.
  const wsKey = workspaceKeyForChat(undefined)
  mem.set(
    'coder:viewerTabs',
    JSON.stringify({
      tabs: [
        {
          id: viewerTabId('terminal', wsKey, 'shell'),
          kind: 'terminal',
          chatId: '',
          wsKey,
          title: 'api',
          terminalCwd: '/work/proj-a',
          terminalShell: '/bin/zsh',
          createdAt: 1,
        },
        {
          id: viewerTabId('terminal', wsKey, 'shell-9-0'),
          kind: 'terminal',
          chatId: '',
          wsKey,
          title: 'logs',
          terminalCwd: '/work/proj-a',
          terminalShell: '/bin/zsh',
          createdAt: 2,
        },
      ],
      activeId: viewerTabId('terminal', wsKey, 'shell-9-0'),
      closed: [],
    }),
  )
  const reloaded = await import('../src/lib/viewerTabs.ts')
  // The loader ran at import time, before we wrote the payload, so call it
  // directly: this is the EXACT function module load uses to restore tabs.
  const st = reloaded.loadPersisted()
  const terms = st.tabs.filter((t: any) => t.kind === 'terminal')
  check('تب‌های ترمینال بعد از ری‌استارت برمی‌گردند', terms.length === 2, st.tabs.map((t: any) => t.kind))
  check('عنوان‌های کاربر حفظ شد', terms.map((t: any) => t.title).sort().join(',') === 'api,logs', terms.map((t: any) => t.title))
  check('cwd حفظ شد', terms.every((t: any) => t.terminalCwd === '/work/proj-a'), terms.map((t: any) => t.terminalCwd))
  check('شناسه‌ها دست‌نخورده و یکتا', new Set(terms.map((t: any) => t.id)).size === 2, terms.map((t: any) => t.id))
  check('تب فعال همان ترمینال است', st.activeId === viewerTabId('terminal', wsKey, 'shell-9-0'), st.activeId)
}

console.log(failures === 0 ? '\nterminalPersist: all checks passed' : `\nterminalPersist: ${failures} FAILED`)
if (failures > 0) process.exit(1)