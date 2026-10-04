import { create } from 'zustand'
import type { ReviewSource } from './reviewPanel'
import type { TraceTab } from './tracePanel'

export type ViewerKind = 'review' | 'trace' | 'inbox' | 'plan' | 'browser'

export interface ViewerTab {
  id: string
  kind: ViewerKind
  title: string
  reviewMessageId?: string | null
  reviewPath?: string
  reviewSource?: ReviewSource
  reviewRev?: string
  traceChatId?: string
  traceTab?: TraceTab
  createdAt: number
}

interface ViewerTabsState {
  tabs: ViewerTab[]
  activeId: string | null
  openViewer: (tab: Omit<ViewerTab, 'createdAt'>) => void
  openReview: (messageId: string, path?: string) => void
  openGitDiff: () => void
  openTraces: (chatId?: string, tab?: TraceTab) => void
  openInbox: () => void
  /** Open the implementation-plan document of the active chat (Plan card's
   *  "View full plan"). Follows the active chat like the trace tab. */
  openPlan: () => void
  /** Open the in-app virtual browser (shared Playwright session). */
  openBrowser: () => void
  closeViewer: (id: string) => void
  setActiveViewer: (id: string) => void
  /** VSCode-style drag reorder: move the dragged tab to the drop position. */
  moveViewerTab: (fromId: string, toId: string, after?: boolean) => void
  /** Fullscreen toggle for the side-by-side viewer group (hides the chat
   *  group). Per-tab header buttons flip this; persisted across restarts. */
  fullscreen: boolean
  setFullscreen: (v: boolean) => void
  toggleFullscreen: () => void
}

const STORAGE_KEY = 'coder:viewerTabs'

function loadPersisted(): { tabs: ViewerTab[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { tabs: [], activeId: null }
    const parsed = JSON.parse(raw) as { tabs?: ViewerTab[]; activeId?: string | null }
    const valid = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((t) => t && typeof t.id === 'string' && (t.kind === 'review' || t.kind === 'trace' || t.kind === 'inbox' || t.kind === 'plan' || t.kind === 'browser'))
      : []
    // Single tab per kind: collapse legacy multiples (e.g. review-turn-xxx,
    // trace-<chatId>) into one tab per kind, keeping the first of each.
    const seen = new Set<ViewerKind>()
    const tabs: ViewerTab[] = []
    for (const t of valid) {
      if (seen.has(t.kind)) continue
      seen.add(t.kind)
      tabs.push({ ...t, id: t.kind, title: t.kind === 'review' ? 'Git' : t.title })
    }
    const activeId = typeof parsed.activeId === 'string' && tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : (tabs[0]?.id ?? null)
    return { tabs, activeId }
  } catch {
    return { tabs: [], activeId: null }
  }
}

function persist(tabs: ViewerTab[], activeId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId }))
  } catch {
    /* storage unavailable */
  }
}

const initial = typeof window !== 'undefined' ? loadPersisted() : { tabs: [], activeId: null }

const FULLSCREEN_KEY = 'coder:viewerFull'

function loadFullscreen(): boolean {
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === '1'
  } catch {
    return false
  }
}

function persistFullscreen(v: boolean) {
  try {
    localStorage.setItem(FULLSCREEN_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

export const useViewerTabs = create<ViewerTabsState>((set) => ({
  tabs: initial.tabs,
  activeId: initial.activeId,
  fullscreen: typeof window !== 'undefined' ? loadFullscreen() : false,
  openViewer: (tab) =>
    set((s) => {
      const normalized = tab.kind === 'review' ? { ...tab, title: 'Git' } : tab
      const exists = s.tabs.some((t) => t.id === normalized.id)
      const tabs = exists
        ? s.tabs.map((t) => (t.id === normalized.id ? { ...t, ...normalized } : t))
        : [...s.tabs, { ...normalized, createdAt: Date.now() }]
      const next = { tabs, activeId: tab.id }
      persist(next.tabs, next.activeId)
      return next
    }),
  openReview: (messageId, path) =>
    set((s) => {
      // Single diff tab: reopening a diff updates it in place.
      const id = 'review'
      const tab: ViewerTab = {
        id,
        kind: 'review',
        title: 'Git',
        reviewMessageId: messageId,
        reviewPath: path,
        reviewSource: 'turn',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.kind === 'review')
        ? s.tabs.map((t) => (t.kind === 'review' ? tab : t))
        : [...s.tabs, tab]
      const next = { tabs, activeId: id }
      persist(next.tabs, next.activeId)
      return next
    }),
  openGitDiff: () =>
    set((s) => {
      // Single diff tab: the uncommitted view replaces whatever diff is open.
      const id = 'review'
      const tab: ViewerTab = {
        id,
        kind: 'review',
        title: 'Git',
        reviewMessageId: null,
        reviewSource: 'uncommitted',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.kind === 'review')
        ? s.tabs.map((t) => (t.kind === 'review' ? tab : t))
        : [...s.tabs, tab]
      const next = { tabs, activeId: id }
      persist(next.tabs, next.activeId)
      return next
    }),
  openTraces: (chatId, tab) =>
    set((s) => {
      // Single trace tab: it always follows the active chat (TracePanel reads
      // the live activeChatId), so reopening only focuses it.
      const id = 'trace'
      const entry: ViewerTab = {
        id,
        kind: 'trace',
        title: 'Trace',
        traceChatId: chatId,
        traceTab: tab,
        createdAt: Date.now(),
      }
      const prev = s.tabs.find((t) => t.kind === 'trace')
      const tabs = prev
        ? s.tabs.map((t) =>
            t.kind === 'trace'
              ? { ...entry, traceTab: tab ?? t.traceTab ?? prev.traceTab }
              : t,
          )
        : [...s.tabs, entry]
      const next = { tabs, activeId: id }
      persist(next.tabs, next.activeId)
      return next
    }),
  openInbox: () =>
    set((s) => {
      const id = 'inbox'
      const entry: ViewerTab = {
        id,
        kind: 'inbox',
        title: 'Inbox',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]
      const next = { tabs, activeId: id }
      persist(next.tabs, next.activeId)
      return next
    }),
  openPlan: () =>
    set((s) => {
      // Single plan tab: it always follows the active chat (PlanPanel reads the
      // live activeChatId), so reopening only focuses it.
      const id = 'plan'
      const entry: ViewerTab = {
        id,
        kind: 'plan',
        title: 'Plan',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]
      const next = { tabs, activeId: id }
      persist(next.tabs, next.activeId)
      return next
    }),
  openBrowser: () =>
    set((s) => {
      // Single browser tab: the panel shows the shared in-app Playwright
      // session, so reopening only focuses it.
      const id = 'browser'
      const entry: ViewerTab = {
        id,
        kind: 'browser',
        title: 'Browser',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]
      const next = { tabs, activeId: id }
      persist(next.tabs, next.activeId)
      return next
    }),
  closeViewer: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return {}
      const tabs = s.tabs.filter((t) => t.id !== id)
      let activeId = s.activeId
      if (s.activeId === id) {
        activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
      }
      persist(tabs, activeId)
      return { tabs, activeId }
    }),
  setActiveViewer: (id) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return {}
      persist(s.tabs, id)
      return { activeId: id }
    }),
  setFullscreen: (v) =>
    set(() => {
      persistFullscreen(v)
      return { fullscreen: v }
    }),
  toggleFullscreen: () =>
    set((s) => {
      persistFullscreen(!s.fullscreen)
      return { fullscreen: !s.fullscreen }
    }),
  moveViewerTab: (fromId, toId, after = false) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === fromId)
      const to = s.tabs.findIndex((t) => t.id === toId)
      if (from === -1 || to === -1 || from === to) return {}
      const tabs = s.tabs.slice()
      const [moved] = tabs.splice(from, 1)
      let dest = tabs.findIndex((t) => t.id === toId) + (after ? 1 : 0)
      dest = Math.max(0, Math.min(tabs.length, dest))
      tabs.splice(dest, 0, moved)
      persist(tabs, fromId)
      return { tabs, activeId: fromId }
    }),
}))

/** Split width between chat group and viewer group. Default half viewport. */
export function loadSplitWidth(fallbackRatio = 0.5): number {
  if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') return 720
  const vw = window.innerWidth
  const saved = (() => {
    try {
      return parseInt(localStorage.getItem('coder:splitWidth') ?? '', 10)
    } catch {
      return NaN
    }
  })()
  const fallback = Math.round(vw * fallbackRatio)
  const n = Number.isFinite(saved) ? saved : fallback
  return Math.max(320, Math.min(vw - 320, n))
}

export function persistSplitWidth(w: number) {
  try {
    localStorage.setItem('coder:splitWidth', String(w))
  } catch {
    /* storage unavailable */
  }
}

export function clampSplitWidth(w: number, vw?: number): number {
  const width = typeof vw === 'number' && Number.isFinite(vw) ? vw : typeof window !== 'undefined' ? window.innerWidth : 1024
  return Math.max(320, Math.min(width - 320, w))
}
