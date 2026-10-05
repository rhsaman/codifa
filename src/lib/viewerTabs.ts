import { create } from 'zustand'
import type { ReviewSource } from './reviewPanel'
import type { TraceTab } from './tracePanel'
import { useStore } from './store'

export type ViewerKind = 'review' | 'trace' | 'inbox' | 'plan' | 'browser' | 'file' | 'text'

/** Kinds that belong to ONE chat. Everything else (the schedule inbox) is
 *  global. Chat-scoped ids are `<kind>:<chatId>`, so every chat keeps its own
 *  tab set and switching chats swaps the whole visible group. */
const CHAT_SCOPED_KINDS = new Set<ViewerKind>(['review', 'trace', 'plan', 'browser', 'text'])

export function viewerTabId(kind: ViewerKind, chatId: string): string {
  return CHAT_SCOPED_KINDS.has(kind) ? `${kind}:${chatId}` : kind
}

const VIEWER_KIND_LABEL: Record<ViewerKind, string> = {
  review: 'Git',
  trace: 'Trace',
  inbox: 'Inbox',
  plan: 'Plan',
  browser: 'Browser',
  // Unused: file tabs keep their per-path title (the file name).
  file: 'File',
  text: 'Text',
}

/** Display title for a viewer tab. File/text tabs and sub-agent trace tabs
 *  keep their own title so a sub-agent trace never looks like the main chat
 *  trace; every other kind shows the shared kind label. Pure, for tests. */
export function viewerTabTitle(t: Pick<ViewerTab, 'kind' | 'title' | 'traceTaskId'>): string {
  if (t.kind === 'file' || t.kind === 'text') return t.title
  if (t.kind === 'trace' && (t.traceTaskId ?? '').trim()) return t.title
  return VIEWER_KIND_LABEL[t.kind] ?? t.title
}

/** Tabs visible while `chatId` is active: global tabs + that chat's own tabs. */
export function visibleTabs(tabs: ViewerTab[], chatId: string): ViewerTab[] {
  return tabs.filter((t) => !CHAT_SCOPED_KINDS.has(t.kind) || t.chatId === chatId)
}

export interface ViewerTab {
  id: string
  kind: ViewerKind
  /** Owning chat for chat-scoped kinds (review/trace/plan/browser). */
  chatId?: string
  title: string
  reviewMessageId?: string | null
  reviewPath?: string
  reviewSource?: ReviewSource
  reviewRev?: string
  traceChatId?: string
  traceTab?: TraceTab
  /** Background sub-agent job id shown in this trace tab (empty = main chat trace). */
  traceTaskId?: string
  /** Short label for a sub-agent trace tab (job description). */
  traceTitle?: string
  /** File-viewer tab: path as written (relative to the workspace root or
   *  absolute), optional line to scroll to, and the workspace root captured
   *  at open time so the panel survives chat switches. */
  filePath?: string
  fileLine?: number
  fileRoot?: string
  /** Text-viewer tab: full body of a collapsed chat text (long user message,
   *  summary, tool output). The body lives in memory only — persist() strips
   *  it so localStorage quota is never blown by a megabyte paste. */
  textBody?: string
  /** How the text viewer renders `textBody` by default: "md" renders the
   *  body as markdown (file paths become clickable chips, fences highlight)
   *  and "text" keeps it verbatim in a pre. The header toggle can always
   *  switch views. */
  textFormat?: 'md' | 'text'
  createdAt: number
}

/** Chat a new chat-scoped tab belongs to (empty string when no chat is open). */
function currentChatId(): string {
  return useStore.getState().activeChatId
}

interface ViewerTabsState {
  tabs: ViewerTab[]
  activeId: string | null
  openViewer: (tab: Omit<ViewerTab, 'createdAt'>) => void
  openReview: (messageId: string, path?: string, chatId?: string) => void
  openGitDiff: (chatId?: string) => void
  openTraces: (chatId?: string, tab?: TraceTab, taskId?: string, title?: string) => void
  openInbox: () => void
  /** Open the implementation-plan document of a chat (Plan card's
   *  "View full plan"). Defaults to the active chat. */
  openPlan: (chatId?: string) => void
  /** Open the in-app virtual browser tab of a chat (shared Playwright session). */
  openBrowser: (chatId?: string) => void
  /** Open a workspace file in its own viewer tab (one tab per path, global —
   *  files are not chat-scoped). Reopening the same path focuses the tab and
   *  updates the target line. */
  openFile: (path: string, line?: number, root?: string) => void
  /** Open a collapsed chat text in its own viewer tab (one tab per chat).
   *  Reopening updates the tab in place. `format` sets the default render
   *  mode: "md" renders the body as markdown (default), "text" keeps it
   *  verbatim (terminal logs read better raw). */
  openText: (title: string, body: string, format?: 'md' | 'text') => void
  closeViewer: (id: string) => void
  setActiveViewer: (id: string) => void
  /** Last active viewer tab per chat (chatId -> tab id). Multi-window focus
   *  restores each chat's own tab when it becomes focused, so the right
   *  panel (Git/Trace/...) always follows the focused chat. */
  lastActiveByChat: Record<string, string>
  /** Recently closed viewer tabs (newest first, capped) for the tab-list
   *  menu's "Recently closed" section. */
  closedTabs: ClosedViewerTab[]
  /** Reopen a closed tab by id: focuses it if still open, otherwise
   *  re-opens it with its original content and activates it. */
  reopenClosedViewerTab: (id: string) => void
  /** VSCode-style drag reorder: move the dragged tab to the drop position. */
  moveViewerTab: (fromId: string, toId: string, after?: boolean) => void
  /** Fullscreen toggle for the side-by-side viewer group (hides the chat
   *  group). Per-tab header buttons flip this; persisted across restarts. */
  fullscreen: boolean
  setFullscreen: (v: boolean) => void
  toggleFullscreen: () => void
  /** Side pane visibility (the whole docked viewer group). The app bar's
   *  single pane toggle flips it; every open* action forces it open so a tab
   *  opened from anywhere becomes visible. With the pane open but no tabs,
   *  the pane shows the "Open tab" chooser. Persisted. */
  paneOpen: boolean
  setPaneOpen: (v: boolean) => void
  togglePane: () => void
  /** Panel mode: the side pane shows the todos / sub-agents / schedules
   *  sections INSTEAD of viewer tab content. Toggled from the button inside
   *  the pane; activating any tab drops back to tabs mode. Persisted. */
  panelMode: boolean
  setPanelMode: (v: boolean) => void
  togglePanelMode: () => void
}

const STORAGE_KEY = 'coder:viewerTabs'

/** A closed viewer tab kept for the "Recently closed" list (newest first). */
export interface ClosedViewerTab {
  tab: ViewerTab
  closedAt: number
}

const CLOSED_CAP = 8

function slimTab(t: ViewerTab): ViewerTab {
  return t.kind === 'text' ? { ...t, textBody: undefined } : t
}

function loadPersisted(): {
  tabs: ViewerTab[]
  activeId: string | null
  closed: ClosedViewerTab[]
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { tabs: [], activeId: null, closed: [] }
    const parsed = JSON.parse(raw) as {
      tabs?: ViewerTab[]
      activeId?: string | null
      closed?: ClosedViewerTab[]
    }
    const valid = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((t) => t && typeof t.id === 'string' && (t.kind === 'review' || t.kind === 'trace' || t.kind === 'inbox' || t.kind === 'plan' || t.kind === 'browser' || t.kind === 'file' || t.kind === 'text'))
      : []
    // One tab per kind per chat (one per sub-agent for trace tabs).
    // Legacy flat tabs (pre per-chat ids, no chatId) are dropped — their
    // owner chat is unknowable.
    const seen = new Set<string>()
    const tabs: ViewerTab[] = []
    for (const t of valid) {
      if (CHAT_SCOPED_KINDS.has(t.kind) && !t.chatId) continue
      const legacyId = viewerTabId(t.kind, t.chatId ?? '')
      const id =
        t.kind === 'trace' && typeof (t as ViewerTab).traceTaskId === 'string' && (t as ViewerTab).traceTaskId
          ? t.id.startsWith('trace:')
            ? t.id
            : `trace:${t.chatId}:${(t as ViewerTab).traceTaskId}`
          : legacyId
      if (seen.has(id)) continue
      seen.add(id)
      tabs.push({ ...t, id, title: t.kind === 'review' ? 'Git' : t.title })
    }
    const activeId = typeof parsed.activeId === 'string' && tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : (tabs[0]?.id ?? null)
    const closed = Array.isArray(parsed.closed)
      ? parsed.closed
          .filter((c) => c && typeof c.closedAt === 'number' && c.tab && typeof c.tab.id === 'string' && (c.tab.kind === 'review' || c.tab.kind === 'trace' || c.tab.kind === 'inbox' || c.tab.kind === 'plan' || c.tab.kind === 'browser' || c.tab.kind === 'file' || c.tab.kind === 'text'))
          .slice(0, CLOSED_CAP)
      : []
    return { tabs, activeId, closed }
  } catch {
    return { tabs: [], activeId: null, closed: [] }
  }
}

function persist(tabs: ViewerTab[], activeId: string | null, closed: ClosedViewerTab[] = []) {
  try {
    // Text bodies stay in memory only: a pasted log can be megabytes and
    // would blow the localStorage quota. The tab (title/owner) persists so
    // the tab bar survives a restart; the body is re-opened from the chat.
    const slim = tabs.map((t) => slimTab(t))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: slim,
        activeId,
        closed: closed.map((c) => ({ tab: slimTab(c.tab), closedAt: c.closedAt })),
      }),
    )
  } catch {
    /* storage unavailable */
  }
}

const initial =
  typeof window !== 'undefined'
    ? loadPersisted()
    : { tabs: [], activeId: null, closed: [] as ClosedViewerTab[] }

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

const PANE_KEY = 'coder:viewerPane'

/** No recorded choice yet → keep the pre-pane behavior: the group follows
 *  whether any tab exists. */
function loadPaneOpen(tabCount: number): boolean {
  try {
    const raw = localStorage.getItem(PANE_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* storage unavailable */
  }
  return tabCount > 0
}

function persistPaneOpen(v: boolean) {
  try {
    localStorage.setItem(PANE_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

const PANEL_MODE_KEY = 'coder:panelMode'

function loadPanelMode(): boolean {
  try {
    return localStorage.getItem(PANEL_MODE_KEY) === '1'
  } catch {
    return false
  }
}

function persistPanelMode(v: boolean) {
  try {
    localStorage.setItem(PANEL_MODE_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

export const useViewerTabs = create<ViewerTabsState>((set) => ({
  tabs: initial.tabs,
  activeId: initial.activeId,
  lastActiveByChat: {},
  closedTabs: initial.closed,
  fullscreen: typeof window !== 'undefined' ? loadFullscreen() : false,
  paneOpen: typeof window !== 'undefined' ? loadPaneOpen(initial.tabs.length) : false,
  setPaneOpen: (v) =>
    set(() => {
      persistPaneOpen(v)
      return { paneOpen: v }
    }),
  togglePane: () =>
    set((s) => {
      persistPaneOpen(!s.paneOpen)
      return { paneOpen: !s.paneOpen }
    }),
  panelMode: typeof window !== 'undefined' ? loadPanelMode() : false,
  setPanelMode: (v) =>
    set(() => {
      persistPanelMode(v)
      return { panelMode: v }
    }),
  togglePanelMode: () =>
    set((s) => {
      persistPanelMode(!s.panelMode)
      return { panelMode: !s.panelMode }
    }),
  openViewer: (tab) =>
    set((s) => {
      const normalized = tab.kind === 'review' ? { ...tab, title: 'Git' } : tab
      const exists = s.tabs.some((t) => t.id === normalized.id)
      const tabs = exists
        ? s.tabs.map((t) => (t.id === normalized.id ? { ...t, ...normalized } : t))
        : [...s.tabs, { ...normalized, createdAt: Date.now() }]
      const lastActiveByChat = normalized.chatId
        ? { ...s.lastActiveByChat, [normalized.chatId]: normalized.id }
        : s.lastActiveByChat
      const next = { tabs, activeId: tab.id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openReview: (messageId, path, chatId) =>
    set((s) => {
      // One diff tab per chat: reopening a diff updates it in place.
      const cid = chatId ?? currentChatId()
      const id = viewerTabId('review', cid)
      const tab: ViewerTab = {
        id,
        kind: 'review',
        chatId: cid,
        title: 'Git',
        reviewMessageId: messageId,
        reviewPath: path,
        reviewSource: 'turn',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? tab : t))
        : [...s.tabs, tab]
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openGitDiff: (chatId) =>
    set((s) => {
      // One diff tab per chat: the uncommitted view replaces it in place.
      const cid = chatId ?? currentChatId()
      const id = viewerTabId('review', cid)
      const tab: ViewerTab = {
        id,
        kind: 'review',
        chatId: cid,
        title: 'Git',
        reviewMessageId: null,
        reviewSource: 'uncommitted',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? tab : t))
        : [...s.tabs, tab]
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openTraces: (chatId, tab, taskId, title) =>
    set((s) => {
      // One trace tab per chat; each sub-agent gets its own filtered tab.
      const cid = chatId ?? currentChatId()
      const tid = (taskId ?? '').trim()
      const id = tid ? `trace:${cid}:${tid}` : viewerTabId('trace', cid)
      const short = tid ? tid.slice(0, 8) : ''
      const label = (title ?? '').trim()
      const entry: ViewerTab = {
        id,
        kind: 'trace',
        chatId: cid,
        title: tid ? `Trace · ${label ? label.slice(0, 28) : short}` : 'Trace',
        traceChatId: chatId,
        traceTab: tab,
        traceTaskId: tid || undefined,
        traceTitle: label || undefined,
        createdAt: Date.now(),
      }
      const prev = s.tabs.find((t) => t.id === id)
      const tabs = prev
        ? s.tabs.map((t) =>
            t.id === id
              ? {
                  ...entry,
                  traceTab: tab ?? t.traceTab ?? prev.traceTab,
                  traceTitle: label || (t.traceTitle ?? prev.traceTitle),
                }
              : t,
          )
        : [...s.tabs, entry]
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
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
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false }
      persist(next.tabs, next.activeId)
      // Pre-open the inbox flag BEFORE the docked pane mounts: its content
      // renders on the first paint and the docked close-watcher never sees
      // a stale false on mount (which used to close the tab in the same
      // tick it opened and dump the user on the previously active tab).
      useStore.getState().setScheduleInboxOpen(true)
      return next
    }),
  openPlan: (chatId) =>
    set((s) => {
      // One plan tab per chat (PlanPanel reads the live activeChatId).
      const cid = chatId ?? currentChatId()
      const id = viewerTabId('plan', cid)
      const entry: ViewerTab = {
        id,
        kind: 'plan',
        chatId: cid,
        title: 'Plan',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openBrowser: (chatId) =>
    set((s) => {
      // One browser tab per chat; the panel shows the shared Playwright session.
      const cid = chatId ?? currentChatId()
      const id = viewerTabId('browser', cid)
      const entry: ViewerTab = {
        id,
        kind: 'browser',
        chatId: cid,
        title: 'Browser',
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openFile: (path, line, root) =>
    set((s) => {
      const clean = path.trim()
      if (!clean) return {}
      // One tab per file, GLOBAL (not chat-scoped): like an editor, opened
      // files stay across chat switches. Reopening re-targets the line.
      const id = `file:${clean}`
      const entry: ViewerTab = {
        id,
        kind: 'file',
        title: clean.split(/[\\/]/).pop() || clean,
        filePath: clean,
        fileLine: line,
        fileRoot: root,
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? { ...t, fileLine: line } : t))
        : [...s.tabs, entry]
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false }
      persist(next.tabs, next.activeId)
      return next
    }),
  openText: (title, body, format) =>
    set((s) => {
      if (!body) return {}
      // One text tab per chat: reopening updates it in place, never stacks
      // a new tab per click.
      const cid = currentChatId()
      const id = viewerTabId('text', cid)
      const entry: ViewerTab = {
        id,
        kind: 'text',
        chatId: cid,
        title: title.trim() || 'Text',
        textBody: body,
        textFormat: format,
        createdAt: Date.now(),
      }
      const tabs = s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? entry : t))
        : [...s.tabs, entry]
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  closeViewer: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return {}
      const removed = s.tabs[idx]
      const tabs = s.tabs.filter((t) => t.id !== id)
      let activeId = s.activeId
      if (s.activeId === id) {
        activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
      }
      const closedTabs = [
        { tab: removed, closedAt: Date.now() },
        ...s.closedTabs.filter((c) => c.tab.id !== id),
      ].slice(0, CLOSED_CAP)
      persist(tabs, activeId, closedTabs)
      const lastActiveByChat = { ...s.lastActiveByChat }
      if (removed.chatId && lastActiveByChat[removed.chatId] === id) {
        delete lastActiveByChat[removed.chatId]
      }
      return { tabs, activeId, closedTabs, lastActiveByChat }
    }),
  setActiveViewer: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab) return {}
      persist(s.tabs, id, s.closedTabs)
      const lastActiveByChat = tab.chatId
        ? { ...s.lastActiveByChat, [tab.chatId]: id }
        : s.lastActiveByChat
      return { activeId: id, panelMode: false, lastActiveByChat }
    }),
  reopenClosedViewerTab: (id) =>
    set((s) => {
      const entry = s.closedTabs.find((c) => c.tab.id === id)
      if (!entry) return {}
      const closedTabs = s.closedTabs.filter((c) => c.tab.id !== id)
      const exists = s.tabs.some((t) => t.id === id)
      const tabs = exists ? s.tabs : [...s.tabs, entry.tab]
      const lastActiveByChat = entry.tab.chatId
        ? { ...s.lastActiveByChat, [entry.tab.chatId]: id }
        : s.lastActiveByChat
      const next = { closedTabs, tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId, next.closedTabs)
      return next
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
      const lastActiveByChat = moved.chatId
        ? { ...s.lastActiveByChat, [moved.chatId]: fromId }
        : s.lastActiveByChat
      return { tabs, activeId: fromId, lastActiveByChat }
    }),
}))

/** Resolve which viewer tab id should be active for a chat (pure, for test).
 *  Prefers the chat's remembered tab when it is still visible, otherwise the
 *  first visible tab, otherwise null. */
export function resolveViewerForChat(
  visible: ViewerTab[],
  lastActiveByChat: Record<string, string>,
  chatId: string,
): string | null {
  if (visible.length === 0) return null
  const remembered = lastActiveByChat[chatId]
  if (remembered && visible.some((t) => t.id === remembered)) return remembered
  return visible[0].id
}

/** Switch the viewer group to the tab belonging to a chat (pure helper for
 *  multi-window focus). No-op when the chat has no visible tab or its tab is
 *  already active. */
export function syncViewerToChat(chatId: string): void {
  const vt = useViewerTabs.getState()
  const visible = visibleTabs(vt.tabs, chatId)
  if (visible.length === 0) return
  const target = resolveViewerForChat(visible, vt.lastActiveByChat, chatId)
  if (target && vt.activeId !== target) {
    vt.setActiveViewer(target)
  }
}

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
