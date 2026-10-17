import { create } from 'zustand'
import type { ReviewSource } from './reviewPanel'
import type { TraceTab } from './tracePanel'
import { useStore } from './store'
import type { ChatDropPos, ChatTreeNode } from './chatTree'
import { appendChat as appendViewerLeaf, buildFromList as buildViewerTree, collectChatIds as collectViewerTabIds, containsChat as viewerTreeContains, dropOnto as dropViewerOnto, leafCount as viewerLeafCount, normalizeTree as normalizeViewerTreeRaw, removeChat as removeViewerLeaf, resizePair as resizeViewerPairRaw, setNodeSize as setViewerNodeSizeRaw } from './chatTree'

export type ViewerKind = 'review' | 'trace' | 'inbox' | 'plan' | 'browser' | 'file' | 'text' | 'explore'

/** Kinds that belong to ONE chat. File tabs are chat-scoped too
 *  (`file:<chatId>:<path>`) so each chat keeps its own open files and
 *  live edits only refresh the owning chat. Inbox stays global. */
const CHAT_SCOPED_KINDS = new Set<ViewerKind>(['review', 'trace', 'plan', 'browser', 'text', 'file', 'explore'])

export function viewerTabId(kind: ViewerKind, chatId: string, path?: string): string {
  if (kind === 'file') {
    const clean = (path ?? '').trim()
    // Chat-scoped file id `file:<chatId>:<path>` (one tab per file per chat).
    // Without a path keep the `file:<chatId>` prefix so existing callers keep working.
    return clean ? `file:${chatId}:${clean}` : `file:${chatId}`
  }
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
  // Unused: explore tabs keep their own title ("Explore · <description>").
  explore: 'Explore',
}

/** Display title for a viewer tab. File/text tabs and sub-agent trace tabs
 *  keep their own title so a sub-agent trace never looks like the main chat
 *  trace; every other kind shows the shared kind label. Pure, for tests. */
export function viewerTabTitle(t: Pick<ViewerTab, 'kind' | 'title' | 'traceTaskId'>): string {
  if (t.kind === 'file' || t.kind === 'text' || t.kind === 'explore') return t.title
  if (t.kind === 'trace' && (t.traceTaskId ?? '').trim()) return t.title
  return VIEWER_KIND_LABEL[t.kind] ?? t.title
}

/** Tabs visible while `chatId` is active: global tabs + that chat's own tabs.
 *  Legacy global file tabs (no chatId, pre chat-scoping) stay visible in
 *  every chat so old sessions don't lose them. */
export function visibleTabs(tabs: ViewerTab[], chatId: string): ViewerTab[] {
  return tabs.filter((t) => {
    if (t.kind === 'file' && !t.chatId) return true
    return !CHAT_SCOPED_KINDS.has(t.kind) || t.chatId === chatId
  })
}

/** True when the viewer tab-list has anything to show inline (visible open
 *  tabs or recently closed tabs). Pure, for the empty-state fallback. */
export function hasViewerTabListEntries(tabs: ViewerTab[], closedTabs: ClosedViewerTab[], chatId: string): boolean {
  if (closedTabs.length > 0) return true
  return visibleTabs(tabs, chatId).length > 0
}

export interface ViewerTab {
  id: string
  kind: ViewerKind
  /** Owning chat for chat-scoped kinds (review/trace/plan/browser/text/file). */
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
  /** Explore tab: the sub-agent run it shows, addressed by the owning message
   *  id + the run's index into message.toolActivity, read live from the store
   *  so running calls and the final report update in place. */
  exploreMessageId?: string
  exploreIndex?: number
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
  /** Open a workspace file in its own viewer tab, scoped to ONE chat
   *  (id `file:<chatId>:<path>`, one tab per file per chat). Reopening the
   *  same path in the same chat focuses the tab and updates the target line.
   *  `chatId` defaults to the active chat; empty means a legacy global tab. */
  openFile: (path: string, line?: number, root?: string, chatId?: string) => void
  /** Open a collapsed chat text in its own viewer tab (one tab per chat).
   *  Reopening updates the tab in place. `format` sets the default render
   *  mode: "md" renders the body as markdown (default), "text" keeps it
   *  verbatim (terminal logs read better raw). */
  openText: (title: string, body: string, format?: 'md' | 'text') => void
  /** Open ONE sub-agent run's tool group in the Explore panel. Chat-scoped
   *  with one tab per chat: clicking another run retargets the same tab
   *  instead of stacking a tab per run. */
  openExplore: (messageId: string, index: number, title?: string, chatId?: string) => void
  closeViewer: (id: string) => void
  /** Close all viewer tabs, or only the tabs visible in one chat.
   *  Closed tabs land in the "Recently closed" list so they can be
   *  reopened from the tab-list menu. */
  closeAllViewers: (chatId?: string) => void
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
  /** Multi-window split tree for the right panel (VSCode-like). Each leaf
   *  holds one viewer tab id (stored in the leaf `chatId` field). Single leaf
   *  = classic single-pane behavior; multiple leaves = split panes with
   *  independent content, drag-split, resize and click-focus. */
  viewerTree: ChatTreeNode | null
  /** Focused viewer window (leaf tab id). Mirrors activeId in single mode. */
  focusedViewerId: string | null
  ensureViewerTree: () => void
  openViewerInWindow: (id: string) => void
  dropViewerOnto: (dragId: string, targetId: string, pos: ChatDropPos) => void
  closeViewerWindow: (id: string) => void
  focusViewerWindow: (id: string) => void
  resizeViewerPair: (parentId: string, firstId: string, secondId: string, firstSize: number, secondSize: number) => void
  setViewerTreeNodeSize: (nodeId: string, size: number) => void
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

/** Cap open tabs so hidden file tabs never fill RAM/localStorage. */
const TOTAL_TAB_CAP = 30

/** Cap file tabs separately so a file-open spree never squeezes out
 *  review/trace/plan/browser tabs. Oldest file tabs drop first. */
const FILE_TAB_CAP = 20

function capTabs(tabs: ViewerTab[]): ViewerTab[] {
  let next = tabs
  // File-tab cap first: a file-open spree never squeezes out
  // review/trace/plan/browser tabs. Oldest file tabs drop first.
  const files = next.filter((t) => t.kind === 'file').sort((a, b) => a.createdAt - b.createdAt)
  if (files.length > FILE_TAB_CAP) {
    const dropFiles = new Set(files.slice(0, files.length - FILE_TAB_CAP).map((t) => t.id))
    next = next.filter((t) => !dropFiles.has(t.id))
  }
  if (next.length <= TOTAL_TAB_CAP) return next
  // Total cap: drop oldest file tabs first, then oldest of the rest.
  const filesByAge = next.filter((t) => t.kind === 'file').sort((a, b) => a.createdAt - b.createdAt)
  const drop = new Set<string>()
  let over = next.length - TOTAL_TAB_CAP
  for (const f of filesByAge) {
    if (over <= 0) break
    drop.add(f.id)
    over--
  }
  next = next.filter((t) => !drop.has(t.id))
  if (next.length > TOTAL_TAB_CAP) {
    const sorted = [...next].sort((a, b) => a.createdAt - b.createdAt)
    const extra = new Set(sorted.slice(0, next.length - TOTAL_TAB_CAP).map((t) => t.id))
    next = next.filter((t) => !extra.has(t.id))
  }
  return next
}

function slimTab(t: ViewerTab): ViewerTab {
  if (t.kind === 'text') return { ...t, textBody: undefined }
  // File tabs persist only id/path/chatId (plus title/line/root for restore).
  // The file body is never stored so localStorage and RAM stay low.
  if (t.kind === 'file') {
    return {
      id: t.id,
      kind: t.kind,
      ...(t.chatId ? { chatId: t.chatId } : {}),
      title: t.title,
      filePath: t.filePath,
      fileLine: t.fileLine,
      fileRoot: t.fileRoot,
      createdAt: t.createdAt,
    } as ViewerTab
  }
  return t
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
    // Legacy GLOBAL file tabs (pre chat-scoping, no chatId, id `file:<path>`)
    // are kept so old sessions don't lose them; every other chat-scoped kind
    // without an owner is dropped — its owner chat is unknowable.
    const seen = new Set<string>()
    const tabs: ViewerTab[] = []
    for (const t of valid) {
      if (CHAT_SCOPED_KINDS.has(t.kind) && !t.chatId && t.kind !== 'file') continue
      // File tabs keep their full id (`file:<path>` legacy, `file:<chatId>:<path>`
      // scoped): recomputing via viewerTabId would collapse every file of one
      // chat into a single `file:<chatId>` id.
      const legacyId = viewerTabId(t.kind, t.chatId ?? '')
      const id =
        t.kind === 'file'
          ? t.id
          : t.kind === 'trace' && typeof (t as ViewerTab).traceTaskId === 'string' && (t as ViewerTab).traceTaskId
            ? t.id.startsWith('trace:')
              ? t.id
              : `trace:${t.chatId}:${(t as ViewerTab).traceTaskId}`
            : legacyId
      if (seen.has(id)) continue
      seen.add(id)
      tabs.push({ ...t, id, title: t.kind === 'review' ? 'Git' : t.title })
    }
    // Enforce the tab cap on load so a bloated store never fills RAM/localStorage.
    const capped = capTabs(tabs)
    const activeId = typeof parsed.activeId === 'string' && capped.some((t) => t.id === parsed.activeId) ? parsed.activeId : (capped[0]?.id ?? null)
    const closed = Array.isArray(parsed.closed)
      ? parsed.closed
          .filter((c) => c && typeof c.closedAt === 'number' && c.tab && typeof c.tab.id === 'string' && (c.tab.kind === 'review' || c.tab.kind === 'trace' || c.tab.kind === 'inbox' || c.tab.kind === 'plan' || c.tab.kind === 'browser' || c.tab.kind === 'file' || c.tab.kind === 'text'))
          .slice(0, CLOSED_CAP)
      : []
    return { tabs: capped, activeId, closed }
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

const VIEWER_TREE_KEY = 'coder:viewerTree'
const VIEWER_WINDOW_MAX = 4

function loadViewerTree(): ChatTreeNode | null {
  try {
    const raw = localStorage.getItem(VIEWER_TREE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ChatTreeNode | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind !== 'leaf' && parsed.kind !== 'split') return null
    return parsed
  } catch {
    return null
  }
}

function persistViewerTree(tree: ChatTreeNode | null): void {
  try {
    if (!tree) localStorage.removeItem(VIEWER_TREE_KEY)
    else localStorage.setItem(VIEWER_TREE_KEY, JSON.stringify(tree))
  } catch {
    /* storage unavailable */
  }
}

const initialViewerTree = (() => {
  if (typeof window === 'undefined') return null
  const valid = new Set(initial.tabs.map((t) => t.id))
  const norm = normalizeViewerTreeRaw(loadViewerTree(), valid)
  if (norm) return norm
  if (initial.tabs.length === 0) return null
  const id = initial.activeId && valid.has(initial.activeId) ? initial.activeId : initial.tabs[0]?.id
  return id ? buildViewerTree([id], 'row') : null
})()

export const useViewerTabs = create<ViewerTabsState>((set) => ({
  tabs: initial.tabs,
  activeId: initial.activeId,
  viewerTree: initialViewerTree,
  focusedViewerId: initial.activeId,
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
      // File bodies are never stored on the tab (only path/line/root), so
      // capping here bounds RAM/localStorage without losing content.
      const tabs = capTabs(exists
        ? s.tabs.map((t) => (t.id === normalized.id ? { ...t, ...normalized } : t))
        : [...s.tabs, { ...normalized, createdAt: Date.now() }])
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
      // User-gesture open: show the pane. Automatic (stream-driven) opens
      // happen only for plan/browser in Chat.tsx; nothing else auto-opens.
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
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? tab : t))
        : [...s.tabs, tab])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openGitDiff: (chatId) =>
    set((s) => {
      // One diff tab per chat: the uncommitted view replaces it in place.
      // User-gesture open: show the pane. Automatic (stream-driven) opens
      // happen only for plan/browser in Chat.tsx; nothing else auto-opens.
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
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? tab : t))
        : [...s.tabs, tab])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openTraces: (chatId, tab, taskId, title) =>
    set((s) => {
      // One trace tab per chat; each sub-agent gets its own filtered tab.
      // User-gesture open: show the pane. Automatic (stream-driven) opens
      // happen only for plan/browser in Chat.tsx; nothing else auto-opens.
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
      const tabs = capTabs(prev
        ? s.tabs.map((t) =>
            t.id === id
              ? {
                  ...entry,
                  traceTab: tab ?? t.traceTab ?? prev.traceTab,
                  traceTitle: label || (t.traceTitle ?? prev.traceTitle),
                }
              : t,
          )
        : [...s.tabs, entry])
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
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      // User-gesture open: show the pane. Automatic (stream-driven) opens
      // happen only for plan/browser in Chat.tsx; nothing else auto-opens.
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
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
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
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openFile: (path, line, root, chatId) =>
    set((s) => {
      const clean = path.trim()
      if (!clean) return {}
      // Chat-scoped file tab: each chat keeps its own open files, so live
      // edits refresh only the owning chat and switching chats swaps the
      // visible files. Only path/line/root persist — never the file body.
      const cid = (chatId ?? currentChatId()).trim()
      const id = cid ? viewerTabId('file', cid, clean) : `file:${clean}`
      const entry: ViewerTab = {
        id,
        kind: 'file',
        ...(cid ? { chatId: cid } : {}),
        title: clean.split(/[\\/]/).pop() || clean,
        filePath: clean,
        fileLine: line,
        fileRoot: root,
        createdAt: Date.now(),
      }
      const raw = s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? { ...t, fileLine: line, fileRoot: root ?? t.fileRoot } : t))
        : [...s.tabs, entry]
      const tabs = capTabs(raw)
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
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
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? entry : t))
        : [...s.tabs, entry])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openExplore: (messageId, index, title, chatId) =>
    set((s) => {
      // One explore tab per chat: reopening retargets the same tab in place.
      const cid = chatId ?? currentChatId()
      const id = viewerTabId('explore', cid)
      const label = (title ?? '').trim()
      const entry: ViewerTab = {
        id,
        kind: 'explore',
        chatId: cid,
        title: label ? `Explore · ${label.slice(0, 60)}` : 'Explore',
        exploreMessageId: messageId,
        exploreIndex: index,
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? { ...t, ...entry } : t))
        : [...s.tabs, entry])
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
      // Prune the split tree so closed tabs never linger as empty panes.
      let viewerTree = s.viewerTree
      let focusedViewerId = s.focusedViewerId
      if (viewerTree && viewerTreeContains(viewerTree, id)) {
        const valid = new Set(tabs.map((t) => t.id))
        viewerTree = normalizeViewerTreeRaw(removeViewerLeaf(viewerTree, id), valid)
        if (!viewerTree && tabs.length > 0) {
          const fallback = activeId && valid.has(activeId) ? activeId : tabs[0]?.id
          viewerTree = fallback ? buildViewerTree([fallback], 'row') : null
        }
        persistViewerTree(viewerTree)
        const ids = viewerTree ? collectViewerTabIds(viewerTree) : []
        if (focusedViewerId === id || (focusedViewerId && !ids.includes(focusedViewerId))) {
          focusedViewerId = activeId ?? ids[0] ?? null
        }
      } else if (focusedViewerId === id) {
        focusedViewerId = activeId
      }
      return { tabs, activeId, closedTabs, lastActiveByChat, viewerTree, focusedViewerId }
    }),
  closeAllViewers: (chatId) =>
    set((s) => {
      const toClose = chatId ? visibleTabs(s.tabs, chatId) : s.tabs
      if (toClose.length === 0) return {}
      const closeIds = new Set(toClose.map((t) => t.id))
      const tabs = s.tabs.filter((t) => !closeIds.has(t.id))
      const activeId = s.activeId && closeIds.has(s.activeId) ? (tabs[0]?.id ?? null) : s.activeId
      const closedTabs = [
        ...toClose.map((tab) => ({ tab, closedAt: Date.now() })),
        ...s.closedTabs.filter((c) => !closeIds.has(c.tab.id)),
      ].slice(0, CLOSED_CAP)
      persist(tabs, activeId, closedTabs)
      const lastActiveByChat = { ...s.lastActiveByChat }
      for (const removed of toClose) {
        if (removed.chatId && lastActiveByChat[removed.chatId] && closeIds.has(lastActiveByChat[removed.chatId])) {
          delete lastActiveByChat[removed.chatId]
        }
      }
      let viewerTree = s.viewerTree
      let focusedViewerId = s.focusedViewerId
      if (viewerTree && toClose.some((t) => viewerTreeContains(viewerTree, t.id))) {
        const valid = new Set(tabs.map((t) => t.id))
        let tree: ChatTreeNode | null = viewerTree
        for (const t of toClose) {
          tree = removeViewerLeaf(tree, t.id)
          if (!tree) break
        }
        viewerTree = normalizeViewerTreeRaw(tree, valid)
        if (!viewerTree && tabs.length > 0) {
          const fallback = activeId && valid.has(activeId) ? activeId : tabs[0]?.id
          viewerTree = fallback ? buildViewerTree([fallback], 'row') : null
        }
        persistViewerTree(viewerTree)
        const ids = viewerTree ? collectViewerTabIds(viewerTree) : []
        if ((focusedViewerId && closeIds.has(focusedViewerId)) || (focusedViewerId && !ids.includes(focusedViewerId))) {
          focusedViewerId = activeId ?? ids[0] ?? null
        }
      } else if (focusedViewerId && closeIds.has(focusedViewerId)) {
        focusedViewerId = activeId
      }
      return { tabs, activeId, closedTabs, lastActiveByChat, viewerTree, focusedViewerId }
    }),
  setActiveViewer: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab) return {}
      persist(s.tabs, id, s.closedTabs)
      const lastActiveByChat = tab.chatId
        ? { ...s.lastActiveByChat, [tab.chatId]: id }
        : s.lastActiveByChat
      // Single-pane focus follows the active tab; split focus stays until clicked.
      const focusedViewerId = s.viewerTree && viewerLeafCount(s.viewerTree) > 1 ? s.focusedViewerId : id
      return { activeId: id, panelMode: false, lastActiveByChat, focusedViewerId }
    }),
  reopenClosedViewerTab: (id) =>
    set((s) => {
      const entry = s.closedTabs.find((c) => c.tab.id === id)
      if (!entry) return {}
      const closedTabs = s.closedTabs.filter((c) => c.tab.id !== id)
      const exists = s.tabs.some((t) => t.id === id)
      const tabs = capTabs(exists ? s.tabs : [...s.tabs, entry.tab])
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
  ensureViewerTree: () =>
    set((s) => {
      const valid = new Set(s.tabs.map((t) => t.id))
      let tree = s.viewerTree ? normalizeViewerTreeRaw(s.viewerTree, valid) : null
      if (!tree) {
        if (s.tabs.length === 0) {
          if (s.viewerTree !== null || s.focusedViewerId !== null) {
            persistViewerTree(null)
            return { viewerTree: null, focusedViewerId: null }
          }
          return {}
        }
        const id = s.activeId && valid.has(s.activeId) ? s.activeId : s.tabs[0].id
        tree = buildViewerTree([id], 'row')
      }
      persistViewerTree(tree)
      const ids = collectViewerTabIds(tree)
      const focusedViewerId = s.focusedViewerId && ids.includes(s.focusedViewerId)
        ? s.focusedViewerId
        : (s.activeId && ids.includes(s.activeId) ? s.activeId : (ids[0] ?? null))
      if (tree === s.viewerTree && focusedViewerId === s.focusedViewerId) return {}
      return { viewerTree: tree, focusedViewerId }
    }),
  openViewerInWindow: (id) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return {}
      let tree = s.viewerTree ?? (s.activeId ? buildViewerTree([s.activeId], 'row') : null)
      if (!tree) tree = buildViewerTree([id], 'row')
      else if (!viewerTreeContains(tree, id)) {
        if (viewerLeafCount(tree) >= VIEWER_WINDOW_MAX) {
          persist(s.tabs, id, s.closedTabs)
          return { activeId: id, focusedViewerId: id }
        }
        tree = appendViewerLeaf(tree, id, 'row')
      }
      persistViewerTree(tree)
      persist(s.tabs, id, s.closedTabs)
      return { viewerTree: tree, activeId: id, focusedViewerId: id, paneOpen: true, panelMode: false }
    }),
  dropViewerOnto: (dragId, targetId, pos) =>
    set((s) => {
      if (!dragId || !targetId || dragId === targetId) return {}
      if (!s.tabs.some((t) => t.id === dragId) || !s.tabs.some((t) => t.id === targetId)) return {}
      const base = s.viewerTree ?? buildViewerTree([targetId], 'row')
      if (!base) return {}
      if (!viewerTreeContains(base, dragId) && viewerLeafCount(base) >= VIEWER_WINDOW_MAX) {
        persist(s.tabs, s.activeId, s.closedTabs)
        return { activeId: targetId, focusedViewerId: targetId }
      }
      const tree = dropViewerOnto(base, dragId, targetId, pos)
      if (!tree) return {}
      persistViewerTree(tree)
      persist(s.tabs, dragId, s.closedTabs)
      return { viewerTree: tree, activeId: dragId, focusedViewerId: dragId, paneOpen: true, panelMode: false }
    }),
  closeViewerWindow: (id) =>
    set((s) => {
      if (!s.viewerTree || !viewerTreeContains(s.viewerTree, id)) return {}
      const ids = collectViewerTabIds(s.viewerTree)
      if (ids.length <= 1) return {}
      const idx = ids.indexOf(id)
      const valid = new Set(s.tabs.map((t) => t.id))
      const tree = normalizeViewerTreeRaw(removeViewerLeaf(s.viewerTree, id), valid)
        ?? buildViewerTree(ids.filter((x) => x !== id), 'row')
      persistViewerTree(tree)
      const nextIds = collectViewerTabIds(tree)
      const fallback = nextIds[Math.min(Math.max(idx, 0), nextIds.length - 1)] ?? nextIds[0] ?? s.activeId
      persist(s.tabs, fallback, s.closedTabs)
      return { viewerTree: tree, activeId: fallback, focusedViewerId: fallback }
    }),
  focusViewerWindow: (id) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return {}
      if (s.focusedViewerId === id && s.activeId === id) return {}
      const tab = s.tabs.find((t) => t.id === id)
      persist(s.tabs, id, s.closedTabs)
      const lastActiveByChat = tab?.chatId
        ? { ...s.lastActiveByChat, [tab.chatId]: id }
        : s.lastActiveByChat
      return { activeId: id, focusedViewerId: id, panelMode: false, lastActiveByChat }
    }),
  resizeViewerPair: (parentId, firstId, secondId, firstSize, secondSize) =>
    set((s) => {
      if (!s.viewerTree) return {}
      const tree = resizeViewerPairRaw(s.viewerTree, parentId, firstId, secondId, firstSize, secondSize)
      if (!tree || tree === s.viewerTree) return {}
      persistViewerTree(tree)
      return { viewerTree: tree }
    }),
  setViewerTreeNodeSize: (nodeId, size) =>
    set((s) => {
      if (!s.viewerTree) return {}
      const tree = setViewerNodeSizeRaw(s.viewerTree, nodeId, size)
      if (!tree || tree === s.viewerTree) return {}
      persistViewerTree(tree)
      return { viewerTree: tree }
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
    // Chat switch must not exit panel mode (todos/schedules): update the
    // background active tab so leaving the panel shows the right tab,
    // but keep panelMode untouched.
    const tab = vt.tabs.find((t) => t.id === target)
    const lastActiveByChat = tab?.chatId
      ? { ...vt.lastActiveByChat, [tab.chatId]: target }
      : vt.lastActiveByChat
    const focusedViewerId =
      vt.viewerTree && viewerLeafCount(vt.viewerTree) > 1 ? vt.focusedViewerId : target
    persist(vt.tabs, target, vt.closedTabs)
    useViewerTabs.setState({ activeId: target, lastActiveByChat, focusedViewerId })
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
  return clampSplitWidth(n, vw)
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
  // Drag caps at half the viewport so chats keep at least half; fullscreen bypasses this via CSS.
  const max = Math.min(width / 2, width - 320)
  return Math.max(320, Math.min(max, w))
}
