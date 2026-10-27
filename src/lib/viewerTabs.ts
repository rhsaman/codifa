import { create } from 'zustand'
import type { ReviewSource } from './reviewPanel'
import type { TraceTab } from './tracePanel'
import { runTargetKey } from './nvimEdit'
import { DEFAULT_TERMINAL_SHELL, shellLabel } from './nvimTerminals'
import { registerChatDeleteHook, useStore, workspaceKey } from './store'
import type { ChatDropPos, ChatTreeNode } from './chatTree'
import { appendChat as appendViewerLeaf, buildFromList as buildViewerTree, collectChatIds as collectViewerTabIds, containsChat as viewerTreeContains, dropOnto as dropViewerOnto, leafCount as viewerLeafCount, normalizeTree as normalizeViewerTreeRaw, removeChat as removeViewerLeaf, replaceChat as replaceViewerLeafTab, resizePair as resizeViewerPairRaw, setNodeSize as setViewerNodeSizeRaw } from './chatTree'

export type ViewerKind = 'review' | 'trace' | 'inbox' | 'schedule' | 'todos' | 'plan' | 'browser' | 'file' | 'text' | 'explore' | 'files' | 'artifact' | 'artifacts' | 'terminal'

/** Kinds that belong to ONE chat: their rail icon follows the focused chat.
 *  Only Trace and Browser remain chat-owned — everything else is scoped to
 *  the focused chat's WORKSPACE (or global), so switching chats inside one
 *  workspace never rearranges the rail. */
const CHAT_SCOPED_KINDS = new Set<ViewerKind>(['trace', 'browser'])

/** Kinds scoped to the WORKSPACE of the focused chat: one tab per workspace
 *  (`<kind>:<wsKey>`), shared by every chat of that workspace. File tabs add
 *  the path (`file:<wsKey>:<path>`), terminals the run target. */
// `files` is NOT here: the explorer is ONE global tab whose root follows the
// focused chat. A per-chat explorer gave every chat its own `files:<chatId>`
// tab, so the rail showed one icon per chat AND activating it pushed the open
// file tab out of the rail.
const WORKSPACE_SCOPED_KINDS = new Set<ViewerKind>(['review', 'plan', 'todos', 'text', 'explore', 'file', 'terminal'])

/** Kinds that are NEVER written to localStorage. A terminal tab is a live pty:
 *  restoring one after a restart would spawn a shell (or an editor) the user
 *  never asked for, and the session id in storage would be meaningless. */
const EPHEMERAL_KINDS = new Set<ViewerKind>(['terminal'])

/** Monotonic counter behind "new terminal tab" ids — Date.now alone could
 *  collide when two clicks land in the same millisecond. */
let shellCounter = 0

export function viewerTabId(kind: ViewerKind, scopeKey: string, path?: string): string {
  if (kind === 'file') {
    const clean = (path ?? '').trim()
    // Workspace-scoped file id `file:<wsKey>:<path>` (one tab per file per
    // workspace). Without a path keep the `file:<wsKey>` prefix so existing
    // callers keep working.
    return clean ? `file:${scopeKey}:${clean}` : `file:${scopeKey}`
  }
  if (kind === 'terminal') {
    // `target` is the run target (a bare shell, or the argv of an editor
    // request). It is part of the ID so re-opening the SAME file focuses the
    // tab that already edits it instead of starting a second Neovim — the whole
    // point, since one nvim with a plugin stack costs hundreds of MB.
    const target = (path ?? '').trim()
    return target ? `terminal:${scopeKey}:${target}` : `terminal:${scopeKey}`
  }
  // Chat-scoped kinds key on the chat id; workspace-scoped kinds on the
  // workspace key; global pages own their kind alone. The key is opaque here —
  // callers pass the right one for the kind.
  return CHAT_SCOPED_KINDS.has(kind) || WORKSPACE_SCOPED_KINDS.has(kind) ? `${kind}:${scopeKey}` : kind
}

/** Workspace scoping context: which tabs the pane shows. `wsKey` is the
 *  `workspaceKey` of the focused chat's root (workspace-scoped kinds match
 *  it), `chatId` the focused chat itself (trace/browser match it). */
export interface ViewerScope {
  wsKey: string
  chatId: string
}

/** Workspace key of `chatId`'s chat, falling back to the app root when the
 *  chat is unknown or carries no root of its own. */
export function workspaceKeyForChat(chatId?: string): string {
  const st = useStore.getState()
  const root = (chatId ? st.chats.find((c) => c.id === chatId)?.root : undefined) ?? st.root ?? ''
  return workspaceKey(root)
}

/** Scope of a chat (defaults to the focused one) for the store actions. */
export function viewerScopeForChat(chatId?: string): ViewerScope {
  return { wsKey: workspaceKeyForChat(chatId), chatId: chatId ?? currentChatId() }
}

/** Reactive scope of the FOCUSED chat — the visibility key the rail and the
 *  pane body filter tabs with. Subscribes to the store, so a chat switch (or
 *  a root change) re-renders every consumer. */
export function useViewerScope(): ViewerScope {
  const chatId = useStore((s) => s.activeChatId) ?? ''
  const chatRoot = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.root)
  const appRoot = useStore((s) => s.root)
  // A chat WITHOUT a root lands in the same "__none__" bucket the sidebar
  // uses, never silently inheriting the app root.
  return { wsKey: workspaceKey(chatRoot ?? appRoot ?? ''), chatId }
}

/** Every kind the store may rehydrate. An unknown kind (an older/newer build,
 *  a hand-edited localStorage payload) is dropped on load instead of being
 *  trusted — the whitelist is never widened into "accept anything". */
const VALID_KINDS: ReadonlySet<string> = new Set<ViewerKind>([
  'review',
  'trace',
  'inbox',
  'schedule',
  'todos',
  'plan',
  'browser',
  'file',
  'text',
  'explore',
  'files',
  'artifact',
  'artifacts',
  'terminal',
])


const VIEWER_KIND_LABEL: Record<ViewerKind, string> = {
  review: 'Git',
  trace: 'Trace',
  inbox: 'Inbox',
  schedule: 'Schedule',
  // Unused: a todos tab keeps its own title.
  todos: 'Todos',
  plan: 'Plan',
  browser: 'Browser',
  // Unused: file tabs keep their per-path title (the file name).
  file: 'File',
  text: 'Text',
  // Unused: explore tabs keep their own title ("Explore · <description>").
  explore: 'Explore',
  files: 'Files',
  artifacts: 'Artifacts',
  // Fallback only: artifact tabs keep their own document title (see
  // viewerTabTitle), otherwise every artifact tab reads "Artifact".
  artifact: 'Artifact',
  // Unused: a terminal tab keeps its own title ("nvim — a.ts", "zsh"), so two
  // terminal tabs are tellable apart.
  terminal: 'Terminal',
}

/** Display title for a viewer tab. File/text/explore tabs, artifact tabs and
 *  sub-agent trace tabs keep their own title — a sub-agent trace must never
 *  look like the main chat trace, and two artifacts of one chat must be
 *  tellable apart (they are one tab per document). Every other kind shows the
 *  shared kind label. Pure, for tests. */
export function viewerTabTitle(t: Pick<ViewerTab, 'kind' | 'title' | 'traceTaskId' | 'traceTitle'>): string {
  if (t.kind === 'file' || t.kind === 'text' || t.kind === 'explore') return t.title
  if (t.kind === 'artifact') return t.title || VIEWER_KIND_LABEL.artifact
  // A terminal tab carries its own title ("nvim — a.ts" / "zsh"), so two of
  // them are tellable apart in the rail.
  if (t.kind === 'terminal') return t.title || VIEWER_KIND_LABEL.terminal
  if (t.kind === 'trace' && ((t.traceTaskId ?? '').trim() || (t.traceTitle ?? '').trim())) return t.title
  return VIEWER_KIND_LABEL[t.kind] ?? t.title
}

/** Tabs visible while `scope` is focused: global pages + the focused
 *  workspace's own tabs + that chat's trace/browser. A legacy global file tab
 *  (pre chat-scoping: no chat, no workspace) stays visible in every chat so
 *  old sessions don't lose it. Pure, for tests. */
export function visibleTabs(tabs: ViewerTab[], scope: ViewerScope): ViewerTab[] {
  return tabs.filter((t) => {
    if (t.kind === 'file' && !t.chatId && !t.wsKey) return true
    // A schedule-run trace belongs to the synthetic chat `schedule-<sid>` that
    //  no focused chat owns — visible from every chat (like a global page).
    if (t.kind === 'trace' && (t.chatId ?? '').startsWith('schedule-')) return true
    if (CHAT_SCOPED_KINDS.has(t.kind)) return t.chatId === scope.chatId
    if (WORKSPACE_SCOPED_KINDS.has(t.kind)) return (t.wsKey ?? '') === scope.wsKey
    return true
  })
}

/** Id of the tab the pane body is showing RIGHT NOW, or `null` when the pane
 *  has no visible tab at all — the body then falls back to the todos page.
 *
 *  Mirrors the body rule in ViewerContent/ViewerWindows exactly. Pure, for
 *  tests. */
export function shownViewerTabId(
  tabs: ViewerTab[],
  activeId: string | null,
  scope: ViewerScope,
): string | null {
  const visible = visibleTabs(tabs, scope)
  // Falls back to the chat's own tab before a shared tab, so the pane never
  // lands on Schedule while the chat still has a trace/browser open.
  const active =
    visible.find((t) => t.id === activeId) ??
    visible.find((t) => t.chatId === scope.chatId) ??
    visible[0] ??
    null
  return active?.id ?? null
}

/** Kinds that render as TABS in the pane's top strip: documents and chat-owned
 *  surfaces (files, browser, trace, …). The dock pages below never appear
 *  there — the dock's fixed icons are their only affordance, which keeps the
 *  bottom row completely separate from the tab strip. */
export const TAB_STRIP_KINDS: ReadonlySet<ViewerKind> = new Set<ViewerKind>([
  'file',
  'browser',
  'trace',
  'text',
  'explore',
  'artifact',
])

/** Tabs the pane's top strip draws: the visible tabs of the tab-strip kinds.
 *  Dock pages (todos/git/artifacts/schedule/inbox/terminal + the explorer) are
 *  NOT here — the bottom dock's fixed icons represent them. Pure, for tests. */
export function viewerTabRows(tabs: ViewerTab[], scope: ViewerScope, _activeId?: string | null): ViewerTab[] {
  return visibleTabs(tabs, scope).filter((t) => TAB_STRIP_KINDS.has(t.kind))
}

/** True when the viewer tab-list has anything to show inline (visible open
 *  tabs or recently closed tabs). Pure, for the empty-state fallback. */
export function hasViewerTabListEntries(tabs: ViewerTab[], closedTabs: ClosedViewerTab[], scope: ViewerScope): boolean {
  if (closedTabs.length > 0) return true
  return visibleTabs(tabs, scope).length > 0
}

export interface ViewerTab {
  id: string
  kind: ViewerKind
  /** Owning chat for chat-scoped kinds (trace/browser); the OPENER chat for
   *  workspace-scoped kinds (used by panels that follow one chat). */
  chatId?: string
  /** Owning workspace (workspaceKey of the chat root) for workspace-scoped
   *  kinds: the tab is shared by every chat of that workspace and hidden in
   *  other workspaces. Global kinds carry none. */
  wsKey?: string
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
  /** Browser tab: the page the agent's browser tool asked to open (its `url`
   *  arg). Without it the panel always launched about:blank, so the user
   *  watched an empty browser while the agent worked on a real page. */
  browserUrl?: string
  /** Artifact tab: the document body + format the agent generated. In memory
   *  only (stripped by slimTab) — the panel refetches it by id after a restart. */
  artifactBody?: string
  artifactKind?: 'html' | 'md'
  artifactVersion?: number
  /** Backend id of the artifact (the part after `artifact:<chatId>:`), kept
   *  separate from the tab id so the panel can re-read the body after a
   *  restart without parsing the id back apart. */
  artifactId?: string
  /** Terminal tab: the pty's working directory, and the program + argv that run
   *  instead of a login shell (`nvim` + `+42 /w/a.ts` for the "Neovim here"
   *  target). Kept on the tab because the session is created when the tab
   *  mounts — the tab IS the request. */
  terminalCwd?: string
  terminalProgram?: string
  terminalArgs?: string[]
  /** Shell a program-less terminal tab runs ("" = the OS login shell). The
   *  session is created when the tab mounts, so the tab carries the choice. */
  terminalShell?: string
  createdAt: number
}

/** A tab that is gone for good. Modules that own a RESOURCE per tab (a pty
 *  session) register here instead of viewerTabs importing them: viewerTabs is
 *  in the startup chunk and must not pull xterm into it. */
type ViewerTabCloseHook = (tabId: string) => void
const tabCloseHooks: ViewerTabCloseHook[] = []

export function registerViewerTabCloseHook(hook: ViewerTabCloseHook): () => void {
  tabCloseHooks.push(hook)
  return () => {
    const at = tabCloseHooks.indexOf(hook)
    if (at !== -1) tabCloseHooks.splice(at, 1)
  }
}

function notifyTabClosed(tabId: string): void {
  for (const hook of tabCloseHooks) {
    // One failing hook must never break closing a tab.
    try {
      hook(tabId)
    } catch {
      /* the tab is closed either way */
    }
  }
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
  /** Open the Schedule page: the cron task list (create form + rows) in its
   *  own viewer tab, separate from the Todos page. One global tab. */
  openSchedule: () => void
  /** Open the Artifacts page: every document the agent built, newest first.
   *  GLOBAL on purpose — an artifact belongs to a chat, but the page's job is
   *  to show them across chats. */
  openArtifacts: () => void
  /** Open the implementation-plan document of a chat (Plan card's
   *  "View full plan"). Defaults to the active chat. */
  openPlan: (chatId?: string) => void
  /** Open the in-app virtual browser tab of a chat (the shared in-app browser).
   *  `url` is the page the agent's browser tool asked for, so the panel opens
   *  on that page instead of a blank tab. */
  openBrowser: (chatId?: string, url?: string) => void
  /** Point an ALREADY-open browser tab at a new page (the agent navigated
   *  again after the tab was docked). No-op when the chat has no browser tab. */
  setBrowserUrl: (chatId: string, url: string) => void
  /** Open (or refresh) the sandboxed artifact preview. One tab per artifact
   *  id, so re-rendering the same document updates it in place.
   *
   *  GLOBAL, like the Artifacts page it is opened from: the tab shows in every
   *  chat and opening it never switches or focuses one. The owner chat rides on
   *  the tab because that is what re-reads the body after a restart — it is not
   *  a visibility filter. */
  openArtifact: (
    chatId: string,
    artifact: { id: string; title: string; kind: string; body: string; version?: number },
  ) => void
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
  /** Open the workspace file explorer (one GLOBAL tab; its root follows the
   *  focused chat). The tree itself is read lazily from disk by the panel. */
  openFiles: () => void
  /** Open the chat's Todos page (turn usage + plan checklist) as its own
   *  closable tab: pages are ordinary tabs now, opened from the rail's "+". */
  openTodos: (chatId?: string) => void
  /** Open a TERMINAL tab in the side pane — an ordinary tab with its own pty
   *  (its own session, separate from the bottom panel's). With `program`/`args`
   *  the tab runs that program instead of a login shell, which is how the
   *  viewer's "Neovim here" target edits a file in the user's own Neovim.
   *  Re-requesting the same target FOCUSES the existing tab: two Neovim
   *  instances for one file would double the RAM and confuse the undo history. */
  openTerminal: (opts?: {
    cwd?: string
    program?: string
    args?: string[]
    title?: string
    chatId?: string
    /** Which shell a plain (program-less) tab runs. "" = the OS login shell. */
    shell?: string
    /** Force a BRAND NEW shell tab instead of focusing the one already open
     *  (the pane's "new terminal" action, like the bottom panel's +). */
    fresh?: boolean
  }) => void
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
   *  the pane falls back to the todos page. Persisted. */
  paneOpen: boolean
  setPaneOpen: (v: boolean) => void
  togglePane: () => void
  /** Bumped whenever Ctrl/Cmd+F asks for the file explorer's name filter.
   *  The tree's tab may not be the active one (opening a file switches the
   *  rail to that file), so the shortcut first ACTIVATES the explorer tab and
   *  then signals it here; the panel consumes the new value to open + focus
   *  its filter box. A counter, not a boolean, so repeated finds re-fire. */
  filesFilterFocusAt: number
  /** Ctrl/Cmd+F routing: show the file explorer and focus its filter. */
  focusFilesFilter: () => void
  /** Open folders of each chat's file explorer, keyed by chat id.
   *
   *  Kept HERE, not in the panel's own state, because the rail mounts only the
   *  active tab: opening a file unmounts the explorer and switching back
   *  remounted it blank, collapsing every folder the user had opened. Session
   *  state (not persisted) — a restart starts from the closed tree. */
  expandedByChat: Record<string, string[]>
  /** Remember one chat's open folders (the explorer's `expanded` set). */
  setExpandedDirs: (chatId: string | undefined, dirs: readonly string[]) => void
  /** Bumped when the file header asks the explorer to REVEAL one file: the
   *  panel consumes the new value, opens the file's folder chain and highlights
   *  the row. A counter so asking twice for the same file re-fires. */
  filesReveal: { chatId: string | null; path: string; at: number } | null
  /** Header click: show the explorer with `path` revealed + highlighted. */
  revealFile: (path: string) => void
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
  const next = capTabsRaw(tabs)
  // A dropped tab is a CLOSED tab: it leaves `tabs`, so anything it owned (a
  // terminal tab's pty) has to be released here. Without this, capping is a
  // silent leak — the session would outlive every trace of its tab.
  if (next.length !== tabs.length) {
    const kept = new Set(next.map((t) => t.id))
    for (const t of tabs) {
      if (!kept.has(t.id)) notifyTabClosed(t.id)
    }
  }
  return next
}

function capTabsRaw(tabs: ViewerTab[]): ViewerTab[] {
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
  // An artifact body can be a whole generated page: like a text tab, keep the
  // tab (id/title/chat) and refetch the body from the backend on demand.
  if (t.kind === 'artifact') return { ...t, artifactBody: undefined }
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
      ? parsed.tabs.filter(
          (t) => t && typeof t.id === 'string' && VALID_KINDS.has(t.kind) && !EPHEMERAL_KINDS.has(t.kind),
        )
      : []
    // One tab per kind per workspace (one per sub-agent for trace tabs).
    // Legacy GLOBAL file tabs (pre chat-scoping, no chatId, id `file:<path>`)
    // are kept so old sessions don't lose them; every other scoped kind
    // without an owner chat is dropped — its owner is unknowable. Artifact
    // tabs are global, so an ownerless one is kept too: its id still carries
    // the artifact id, which is all the panel needs to re-read the body.
    // Ids keep their persisted shape here (older builds stored
    // `<kind>:<chatId>` for the now workspace-scoped kinds); the one-time
    // scope migration below re-keys them once the chat index is hydrated.
    const seen = new Set<string>()
    const tabs: ViewerTab[] = []
    for (const t of valid) {
      if (t.kind !== 'file' && !t.chatId && (CHAT_SCOPED_KINDS.has(t.kind) || WORKSPACE_SCOPED_KINDS.has(t.kind))) continue
      // File tabs keep their full id (`file:<path>` legacy, `file:<chatId>:<path>`
      // scoped): recomputing via viewerTabId would collapse every file of one
      // chat into a single `file:<chatId>` id.
      const legacyId = viewerTabId(t.kind, t.chatId ?? '')
      const id =
        // Artifact tabs carry the artifact id in their own id
        // (`artifact:<chatId>:<artifactId>`), exactly like file tabs carry the
        // path: recomputing via `viewerTabId` collapses every artifact of one
        // chat into a single `artifact:<chatId>` tab and silently drops the
        // rest on reload.
        t.kind === 'file' || t.kind === 'artifact'
          ? t.id
          : t.kind === 'trace' && typeof (t as ViewerTab).traceTaskId === 'string' && (t as ViewerTab).traceTaskId
            ? t.id.startsWith('trace:')
              ? t.id
              : `trace:${t.chatId}:${(t as ViewerTab).traceTaskId}`
            : legacyId
      if (seen.has(id)) continue
      seen.add(id)
      tabs.push({
        ...t,
        id,
        // Tabs persisted before `artifactId` existed carry the id only inside
        // their tab id (`artifact:<chatId>:<artifactId>`) — recover it so the
        // restored panel can still re-read its body instead of showing the
        // "no longer in memory" notice forever.
        ...(t.kind === 'artifact' && !(t as ViewerTab).artifactId
          ? { artifactId: id.split(':').slice(2).join(':') || undefined }
          : {}),
        title: t.kind === 'review' ? 'Git' : t.title,
      })
    }
    // Enforce the tab cap on load so a bloated store never fills RAM/localStorage.
    const capped = capTabs(tabs)
    const activeId = typeof parsed.activeId === 'string' && capped.some((t) => t.id === parsed.activeId) ? parsed.activeId : (capped[0]?.id ?? null)
    const closed = Array.isArray(parsed.closed)
      ? parsed.closed
          .filter((c) => c && typeof c.closedAt === 'number' && c.tab && typeof c.tab.id === 'string' && VALID_KINDS.has(c.tab.kind))
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
    //
    // EPHEMERAL tabs (a terminal's live pty) are dropped ENTIRELY: restoring
    // one would spawn a fresh shell or editor on the next launch, and its
    // session id would point at nothing.
    const keep = (t: ViewerTab) => !EPHEMERAL_KINDS.has(t.kind)
    const slim = tabs.filter(keep).map((t) => slimTab(t))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: slim,
        activeId: tabs.some((t) => t.id === activeId && keep(t)) ? activeId : (slim[0]?.id ?? null),
        closed: closed.filter((c) => keep(c.tab)).map((c) => ({ tab: slimTab(c.tab), closedAt: c.closedAt })),
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

const VIEWER_TREE_KEY = 'coder:viewerTree'
const VIEWER_WINDOW_MAX = 4

/**
 * Make `activeId` visible in the pane group's split tree.
 *
 * The panes paint ONLY tree leaves, so a tab that has no leaf renders nowhere.
 * That is what made a file click look like it "closed the previous tab and
 * opened Schedule": the tab was in `tabs` and `activeId` pointed at it, but the
 * resumed/split tree still held the old leaves, so the pane kept painting the
 * previous page. Opening or re-activating a tab replaces the content of the
 * FOCUSED pane (it never splits — splitting stays an explicit gesture), so the
 * tab always lands where the user is looking.
 *
 * Pure + identity-stable: returns the inputs untouched when nothing changes.
 */
function revealViewerTab(
  tree: ChatTreeNode | null,
  activeId: string | null,
  focusedId: string | null,
  knownIds: Set<string>,
): { tree: ChatTreeNode | null; focusedId: string | null } | null {
  if (!activeId || !knownIds.has(activeId)) return null
  if (!tree) return { tree: buildViewerTree([activeId], 'row'), focusedId: activeId }
  if (viewerTreeContains(tree, activeId)) return { tree, focusedId: activeId }
  const anchor =
    focusedId && viewerTreeContains(tree, focusedId)
      ? focusedId
      : (collectViewerTabIds(tree)[0] ?? null)
  const nextTree = anchor
    ? replaceViewerLeafTab(tree, anchor, activeId)
    : buildViewerTree([activeId], 'row')
  return { tree: nextTree, focusedId: activeId }
}

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
  filesFilterFocusAt: 0,
  expandedByChat: {},
  filesReveal: null,
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
  focusFilesFilter: () =>
    set((s) => {
      // The explorer tab is activated by the same call, because Ctrl/Cmd+F must
      // work while ANY right-rail tab is showing (an open file, Git, todos…).
      // Global explorer id (no chatId): one tab for the whole app, so the rail
      // keeps a single `files` icon and activating it never displaces the open
      // file tab of whichever chat is focused.
      const id = viewerTabId('files', '')
      const entry: ViewerTab = {
        id,
        kind: 'files',
        title: 'Files',
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? entry : t))
        : [...s.tabs, entry])
      const next = {
        tabs,
        activeId: id,
        paneOpen: true,
        filesFilterFocusAt: s.filesFilterFocusAt + 1,
      }
      persist(next.tabs, next.activeId)
      return next
    }),
  setExpandedDirs: (chatId, dirs) =>
    set((s) => {
      const cid = chatId ?? currentChatId()
      if (!cid) return s
      // Stored sorted+unique so the same set never churns a new array identity
      // (the explorer writes on every toggle, and an identical value must not
      // re-render every subscriber).
      const next = [...new Set(dirs)].sort()
      const prev = s.expandedByChat[cid]
      if (prev && prev.length === next.length && prev.every((d, i) => d === next[i])) return s
      return { expandedByChat: { ...s.expandedByChat, [cid]: next } }
    }),
  revealFile: (path) =>
    set((s) => {
      // Same global explorer as `focusFilesFilter`: the tab carries no chatId,
      // so `activeId` moving to it leaves the chat's open file tab untouched.
      // The reveal SIGNAL still carries the focused chat, because only that
      // chat's explorer pane may jump to the file.
      const cid = currentChatId()
      const id = viewerTabId('files', '')
      const entry: ViewerTab = {
        id,
        kind: 'files',
        title: 'Files',
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? entry : t))
        : [...s.tabs, entry])
      const next = {
        tabs,
        activeId: id,
        paneOpen: true,
        filesReveal: { chatId: cid ?? null, path, at: (s.filesReveal?.at ?? 0) + 1 },
      }
      persist(next.tabs, next.activeId)
      return next
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
      const next = { tabs, activeId: tab.id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openReview: (messageId, path, chatId) =>
    set((s) => {
      // One diff tab per WORKSPACE: reopening a diff from any chat of the
      // workspace retargets the same tab in place.
      // User-gesture open: show the pane. Automatic (stream-driven) opens
      // happen only for plan/browser in Chat.tsx; nothing else auto-opens.
      const cid = chatId ?? currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = viewerTabId('review', wsKey)
      const tab: ViewerTab = {
        id,
        kind: 'review',
        chatId: cid,
        wsKey,
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
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openGitDiff: (chatId) =>
    set((s) => {
      // One diff tab per WORKSPACE: the uncommitted view replaces it in place.
      // User-gesture open: show the pane. Automatic (stream-driven) opens
      // happen only for plan/browser in Chat.tsx; nothing else auto-opens.
      const cid = chatId ?? currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = viewerTabId('review', wsKey)
      const tab: ViewerTab = {
        id,
        kind: 'review',
        chatId: cid,
        wsKey,
        title: 'Git',
        reviewMessageId: null,
        reviewSource: 'uncommitted',
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? tab : t))
        : [...s.tabs, tab])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
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
        title: tid
          ? `Trace · ${label ? label.slice(0, 28) : short}`
          : // No sub-agent id (e.g. a schedule-run trace): the label is the
            //  only thing telling two such tabs apart in the rail.
            label
            ? `Trace · ${label.slice(0, 28)}`
            : 'Trace',
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
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
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
      const next = { tabs, activeId: id, paneOpen: true }
      persist(next.tabs, next.activeId)
      // Pre-open the inbox flag BEFORE the docked pane mounts: its content
      // renders on the first paint and the docked close-watcher never sees
      // a stale false on mount (which used to close the tab in the same
      // tick it opened and dump the user on the previously active tab).
      useStore.getState().setScheduleInboxOpen(true)
      return next
    }),
  openSchedule: () =>
    set((s) => {
      const id = 'schedule'
      const entry: ViewerTab = {
        id,
        kind: 'schedule',
        title: 'Schedule',
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      const next = { tabs, activeId: id, paneOpen: true }
      persist(next.tabs, next.activeId)
      return next
    }),
  openArtifacts: () =>
    set((s) => {
      const id = 'artifacts'
      const entry: ViewerTab = {
        id,
        kind: 'artifacts',
        title: 'Artifacts',
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      const next = { tabs, activeId: id, paneOpen: true }
      persist(next.tabs, next.activeId)
      return next
    }),
  openPlan: (chatId) =>
    set((s) => {
      // One plan tab per WORKSPACE: opening it from another chat of the same
      // workspace retargets the tab (owner chat + scope) in place.
      const cid = chatId ?? currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = viewerTabId('plan', wsKey)
      const entry: ViewerTab = {
        id,
        kind: 'plan',
        chatId: cid,
        wsKey,
        title: 'Plan',
        createdAt: Date.now(),
      }
      const tabs = capTabs(
        s.tabs.some((t) => t.id === id)
          ? s.tabs.map((t) => (t.id === id ? { ...t, chatId: cid, wsKey } : t))
          : [...s.tabs, entry],
      )
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  setBrowserUrl: (chatId, url) =>
    set((s) => {
      const id = viewerTabId('browser', chatId)
      if (!s.tabs.some((t) => t.id === id)) return s
      const tabs = s.tabs.map((t) =>
        t.id === id ? { ...t, browserUrl: url } : t,
      )
      persist(tabs, s.activeId)
      return { tabs }
    }),

  openArtifact: (chatId, artifact) =>
    set((s) => {
      // One tab per artifact id: re-rendering the same document replaces its
      // body in place instead of stacking a tab per version.
      const cid = chatId || currentChatId()
      const id = `artifact:${cid}:${artifact.id}`
      const entry: ViewerTab = {
        id,
        kind: 'artifact',
        chatId: cid,
        title: artifact.title || artifact.id,
        artifactBody: artifact.body,
        artifactKind: artifact.kind === 'md' ? 'md' : 'html',
        artifactId: artifact.id,
        ...(artifact.version ? { artifactVersion: artifact.version } : {}),
        createdAt: Date.now(),
      }
      const tabs = capTabs(
        s.tabs.some((t) => t.id === id)
          ? s.tabs.map((t) => (t.id === id ? entry : t))
          : [...s.tabs, entry],
      )
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),

  openBrowser: (chatId, url) =>
    set((s) => {
      // One browser tab per chat; the panel shows the shared in-app browser.
      const cid = chatId ?? currentChatId()
      const id = viewerTabId('browser', cid)
      const entry: ViewerTab = {
        id,
        kind: 'browser',
        chatId: cid,
        title: 'Browser',
        // The agent's browser tool hands its `url` here (see Chat.tsx): the
        // panel then launches on the page the agent is really working with.
        ...(url && url !== 'about:blank' ? { browserUrl: url } : {}),
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openFile: (path, line, root, chatId) => {
    // An explicit `chatId` means a chat's OWN surface opened the file (its file
    // explorer / files panel). The tab is workspace-scoped, so the pane shows it
    // from any chat of the workspace — but the OWNER chat is still focused so
    // viewer comments (and the pane's own surfaces) land in the chat the user
    // opened the file FROM.
    const owner = (chatId ?? '').trim()
    if (owner) {
      const st = useStore.getState()
      if (
        owner !== st.activeChatId &&
        (st.openChatIds.includes(owner) || st.visibleChatIds.includes(owner))
      ) {
        st.focusWindow(owner)
      }
    }
    return set((s) => {
      const clean = path.trim()
      if (!clean) return {}
      // Workspace-scoped file tab: one tab per path per workspace, shared by
      // every chat of that workspace. Only path/line/root persist — never the
      // file body.
      const cid = (chatId ?? currentChatId()).trim()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = cid ? viewerTabId('file', wsKey, clean) : `file:${clean}`
      const entry: ViewerTab = {
        id,
        kind: 'file',
        ...(cid ? { chatId: cid, wsKey } : {}),
        title: clean.split(/[\\/]/).pop() || clean,
        filePath: clean,
        fileLine: line,
        fileRoot: root,
        createdAt: Date.now(),
      }
      const raw = s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? { ...t, fileLine: line, fileRoot: root ?? t.fileRoot, ...(cid ? { chatId: cid, wsKey } : {}) } : t))
        : [...s.tabs, entry]
      const tabs = capTabs(raw)
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      // The panes paint ONLY tree leaves: without this the new tab stayed
      // invisible whenever a resumed/split tree existed, so the pane kept the
      // previous page (e.g. Schedule) on screen while the rail marked this tab.
      const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(tabs.map((t) => t.id)))
      if (revealed?.tree && revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree)
      persist(next.tabs, next.activeId)
      return {
        ...next,
        viewerTree: revealed?.tree ?? s.viewerTree,
        focusedViewerId: revealed?.focusedId ?? s.focusedViewerId,
      }
    })
  },
  openText: (title, body, format) =>
    set((s) => {
      if (!body) return {}
      // One text tab per WORKSPACE: reopening updates it in place, never
      // stacks a new tab per click.
      const cid = currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = viewerTabId('text', wsKey)
      const entry: ViewerTab = {
        id,
        kind: 'text',
        chatId: cid,
        wsKey,
        title: title.trim() || 'Text',
        textBody: body,
        textFormat: format,
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? entry : t))
        : [...s.tabs, entry])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openExplore: (messageId, index, title, chatId) =>
    set((s) => {
      // One explore tab per WORKSPACE: reopening retargets the same tab in
      // place.
      const cid = chatId ?? currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = viewerTabId('explore', wsKey)
      const label = (title ?? '').trim()
      const entry: ViewerTab = {
        id,
        kind: 'explore',
        chatId: cid,
        wsKey,
        title: label ? `Explore · ${label.slice(0, 60)}` : 'Explore',
        exploreMessageId: messageId,
        exploreIndex: index,
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id)
        ? s.tabs.map((t) => (t.id === id ? { ...t, ...entry } : t))
        : [...s.tabs, entry])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openTodos: (chatId) =>
    set((s) => {
      // One todos tab per WORKSPACE: the page reads the focused chat's own
      // usage + plan, so the tab stays put while chats switch inside the
      // workspace.
      const cid = chatId ?? currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const id = viewerTabId('todos', wsKey)
      const entry: ViewerTab = {
        id,
        kind: 'todos',
        chatId: cid,
        wsKey,
        title: 'Todos',
        createdAt: Date.now(),
      }
      const tabs = capTabs(
        s.tabs.some((t) => t.id === id)
          ? s.tabs.map((t) => (t.id === id ? { ...t, chatId: cid, wsKey } : t))
          : [...s.tabs, entry],
      )
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      persist(next.tabs, next.activeId)
      return next
    }),
  openFiles: () =>
    set((s) => {
      // One GLOBAL explorer tab: its root follows the focused chat (the panel
      // resolves that itself), so the rail shows a single `files` icon.
      const id = viewerTabId('files', '')
      const entry: ViewerTab = {
        id,
        kind: 'files',
        title: 'Files',
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      const next = { tabs, activeId: id, paneOpen: true }
      persist(next.tabs, next.activeId)
      return next
    }),
  openTerminal: (opts) =>
    set((s) => {
      const cid = opts?.chatId ?? currentChatId()
      const wsKey = workspaceKeyForChat(cid || undefined)
      const program = (opts?.program ?? '').trim()
      const args = opts?.args ?? []
      // The run target is the tab's IDENTITY, not just its payload: re-asking
      // for the same file must land on the tab already editing it. Two Neovim
      // instances for one file is exactly the RAM blow-up this avoids.
      //
      // A PLAIN SHELL is the exception: "new terminal" means a genuinely new
      // shell (like the bottom panel's +), so it gets a unique target instead of
      // re-focusing the one already open.
      const target = program
        ? runTargetKey([program, ...args])
        : opts?.fresh
          ? `shell-${Date.now()}-${shellCounter++}`
          : 'shell'
      const id = viewerTabId('terminal', wsKey, target)
      // Reuse ANY tab already running this run target, not just one with an
      // identical id: the id is scoped per chat, so opening the same file from
      // two chats (or a second window) minted a second tab and a SECOND nvim
      // for one file. Neovim is ~600 MB with its language servers, so the
      // identity that matters is the program + argv, exactly as the bottom
      // panel's reuse guard treats it (src/lib/nvimEdit.ts).
      const existing = program
        ? s.tabs.find(
            (t) =>
              t.kind === 'terminal' &&
              t.terminalProgram != null &&
              runTargetKey([t.terminalProgram, ...(t.terminalArgs ?? [])]) === target,
          ) ?? s.tabs.find((t) => t.id === id)
        : s.tabs.find((t) => t.id === id)
      if (existing) {
        // Focus (and re-title) the tab that already runs this target.
        const title = opts?.title ?? existing.title
        const tabs = title === existing.title ? s.tabs : s.tabs.map((t) => (t === existing ? { ...t, title } : t))
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: existing.id } : s.lastActiveByChat
        return { tabs, activeId: existing.id, paneOpen: true, lastActiveByChat, focusedViewerId: existing.id }
      }
      const cwd = opts?.cwd ?? useStore.getState().root ?? ''
      const entry: ViewerTab = {
        id,
        kind: 'terminal',
        chatId: cid,
        wsKey,
        // A terminal tab shows WHAT it runs ("nvim — a.ts", "zsh — codifa"):
        // "Terminal" for every one of them would make the rail unreadable.
        title: opts?.title || (program ? program : shellLabel(opts?.shell || DEFAULT_TERMINAL_SHELL)),
        terminalCwd: cwd,
        ...(program
          ? { terminalProgram: program, terminalArgs: args }
          : { terminalShell: (opts?.shell ?? '').trim() || DEFAULT_TERMINAL_SHELL }),
        createdAt: Date.now(),
      }
      const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry])
      const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat
      // NOT persisted (see EPHEMERAL_KINDS): a restored terminal tab would
      // spawn a shell nobody asked for.
      const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat }
      // The panes paint ONLY tree leaves — the same rule openFile documents
      // above. Without revealing the new tab here it existed in `tabs`, showed
      // up in the rail for one render, and was then dropped from the tree as an
      // unknown leaf: the "+" tab looked like it appeared and vanished. The
      // bottom panel never had this problem because it keeps no tree at all.
      const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(tabs.map((t) => t.id)))
      if (revealed?.tree && revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree)
      persist(next.tabs, next.activeId)
      return {
        ...next,
        viewerTree: revealed?.tree ?? s.viewerTree,
        focusedViewerId: revealed?.focusedId ?? s.focusedViewerId,
      }
    }),
  closeViewer: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return {}
      const removed = s.tabs[idx]
      // A tab that owned a resource (a pty session) must release it HERE: the
      // tab object leaving `tabs` is the only "closed for good" signal, and a
      // plain unmount also happens when the user merely switches tabs.
      notifyTabClosed(id)
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
      const toClose = chatId ? visibleTabs(s.tabs, viewerScopeForChat(chatId)) : s.tabs
      if (toClose.length === 0) return {}
      const closeIds = new Set(toClose.map((t) => t.id))
      for (const t of toClose) notifyTabClosed(t.id)
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
      // A clicked row must become what the pane SHOWS: the tree paints only its
      // leaves, so a tab without one would keep the previous page on screen
      // while the rail marked the clicked tab as active.
      const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(s.tabs.map((t) => t.id)))
      if (!revealed) return { activeId: id, lastActiveByChat }
      if (revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree)
      return {
        activeId: id,
        lastActiveByChat,
        viewerTree: revealed.tree,
        focusedViewerId: revealed.focusedId,
      }
    }),
  reopenClosedViewerTab: (id) =>
    set((s) => {
      const entry = s.closedTabs.find((c) => c.tab.id === id)
      if (!entry) return {}
      // A terminal tab's pty dies WITH the tab, so its entry in "Recently
      // closed" is a tombstone: reopening it would mount a tab whose session id
      // points at nothing. Drop the entry instead of resurrecting it.
      if (EPHEMERAL_KINDS.has(entry.tab.kind)) {
        // Also drop it from the PERSISTED list: a leftover tombstone would come
        // back after a restart and offer a tab that can never be reopened.
        const closedTabs = s.closedTabs.filter((c) => c.tab.id !== id)
        persist(s.tabs, s.activeId, closedTabs)
        return { closedTabs }
      }
      const closedTabs = s.closedTabs.filter((c) => c.tab.id !== id)
      const exists = s.tabs.some((t) => t.id === id)
      const tabs = capTabs(exists ? s.tabs : [...s.tabs, entry.tab])
      const lastActiveByChat = entry.tab.chatId
        ? { ...s.lastActiveByChat, [entry.tab.chatId]: id }
        : s.lastActiveByChat
      const next = { closedTabs, tabs, activeId: id, paneOpen: true, lastActiveByChat }
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
      // The pane group paints ONLY tree leaves, so an active tab without a leaf
      // renders nowhere: with a split/resumed tree the previous page stayed on
      // screen and a file click looked like it closed the tab and reopened
      // Schedule. Reveal the active tab in the FOCUSED leaf — opening a tab
      // replaces that pane's content, it never splits the pane.
      let focusedViewerId = s.focusedViewerId
      const revealed = revealViewerTab(tree, s.activeId, focusedViewerId, valid)
      if (revealed) {
        tree = revealed.tree
        focusedViewerId = revealed.focusedId
      }
      persistViewerTree(tree)
      const ids = collectViewerTabIds(tree)
      if (!focusedViewerId || !ids.includes(focusedViewerId)) {
        focusedViewerId = s.activeId && ids.includes(s.activeId) ? s.activeId : (ids[0] ?? null)
      }
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
      return { viewerTree: tree, activeId: id, focusedViewerId: id, paneOpen: true }
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
      return { viewerTree: tree, activeId: dragId, focusedViewerId: dragId, paneOpen: true }
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
      return { activeId: id, focusedViewerId: id, lastActiveByChat }
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
 *  chat's OWN newest tab — never a global page tab. */
export function resolveViewerForChat(
  visible: ViewerTab[],
  lastActiveByChat: Record<string, string>,
  chatId: string,
): string | null {
  if (visible.length === 0) return null
  const remembered = lastActiveByChat[chatId]
  if (remembered && visible.some((t) => t.id === remembered)) return remembered
  // Global page tabs (schedule/inbox/…) own a rail icon and outlive the chat
  // that happened to open them, so they must never win this fallback: doing so
  // yanked the pane to the Schedule page on every chat switch/mount, and the
  // file tab the user just opened merely stopped being active — which reads as
  // "my tab closed and Schedule replaced it".
  const own = visible.filter((t) => t.chatId === chatId)
  return own.length ? own[own.length - 1].id : null
}

/** Switch the viewer group to the tab belonging to a chat (pure helper for
 *  multi-window focus). No-op when the chat has no visible tab or its tab is
 *  already active. */
export function syncViewerToChat(chatId: string): void {
  const vt = useViewerTabs.getState()
  const scope = viewerScopeForChat(chatId)
  const visible = visibleTabs(vt.tabs, scope)
  if (visible.length === 0) return
  // The pane already shows a tab of THIS chat or a shared tab of THIS
  // workspace: nothing to retarget. This effect runs AFTER a focus change,
  // i.e. it can land right after the click that opened a file — without this
  // guard it yanked the pane back to the chat's remembered tab (trace), which
  // read as "clicking a file opened trace". A deliberate open/activate always
  // wins over the memory. Workspace tabs STICK across chat switches (that is
  // the point of workspace scoping); a global page does NOT — the chat's own
  // remembered tab still wins over Schedule/Inbox, exactly as before.
  if (vt.activeId && visible.some((t) => t.id === vt.activeId)) {
    const shownTab = vt.tabs.find((t) => t.id === vt.activeId)
    const sticky =
      (shownTab && shownTab.wsKey != null && shownTab.wsKey === scope.wsKey) ||
      (shownTab && CHAT_SCOPED_KINDS.has(shownTab.kind) && shownTab.chatId === chatId)
    if (sticky) return
  }
  const target = resolveViewerForChat(visible, vt.lastActiveByChat, chatId)
  if (target && vt.activeId !== target) {
    // A chat switch only retargets the BACKGROUND active tab; nothing else in
    // the pane's state (tree, focus) is touched.
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

// A deleted chat must not keep its viewer tabs (nor the `lastActiveByChat`
// entries behind them) alive for the rest of the session. Registered through
// the store's delete hook instead of importing the store from here in the other
// direction — this module already imports ./store, so an import back would be a
// circular import.
registerChatDeleteHook((chatId) => {
  useViewerTabs.getState().closeAllViewers(chatId)
})

// --- one-time scope migration ---------------------------------------------
// Tabs persisted before workspace scoping key on the chat (`review:<chatId>`),
// and the chat index hydrates ASYNC, after this module's loadPersisted ran.
// The first store update that carries chats re-keys every workspace-scoped tab
// to its chat's workspace (`<kind>:<wsKey>`), so two chats of one workspace
// share ONE Git/plan/file tab instead of stacking per-chat duplicates the
// visibility filter can no longer tell apart. Runs at most once.
let scopesMigrated = false
let unsubScopeMigration: (() => void) | null = null
function migrateTabScopes(): void {
  if (scopesMigrated) return
  const st = useStore.getState()
  if (!Array.isArray(st.chats) || st.chats.length === 0) return
  scopesMigrated = true
  unsubScopeMigration?.()
  const keyFor = (chatId?: string) => {
    const root = (chatId ? st.chats.find((c) => c.id === chatId)?.root : undefined) ?? st.root ?? ''
    return workspaceKey(root)
  }
  const vt = useViewerTabs.getState()
  let changed = false
  let activeId = vt.activeId
  const seen = new Set<string>()
  const remap = new Map<string, string>()
  const migrate = (tab: ViewerTab): ViewerTab => {
    if (!WORKSPACE_SCOPED_KINDS.has(tab.kind) || tab.wsKey) return tab
    // A pre-workspace GLOBAL file tab (no owner chat) stays global.
    if (tab.kind === 'file' && !tab.chatId) return tab
    const wsKey = keyFor(tab.chatId)
    const id =
      tab.kind !== 'file'
        ? viewerTabId(tab.kind, wsKey)
        : (tab.filePath ?? '').trim()
          ? viewerTabId('file', wsKey, tab.filePath)
          : tab.id
    if (id === tab.id) return { ...tab, wsKey }
    changed = true
    remap.set(tab.id, id)
    if (activeId === tab.id) activeId = id
    return { ...tab, id, wsKey }
  }
  const tabs: ViewerTab[] = []
  for (const tab of vt.tabs) {
    const next = migrate(tab)
    if (seen.has(next.id)) {
      // Two chats of one workspace each used to own a tab for this kind: the
      // duplicate is a real closure now, so its resources are released.
      notifyTabClosed(tab.id)
      if (activeId === tab.id) activeId = remap.get(tab.id) ?? tabs[tabs.length - 1]?.id ?? null
      changed = true
      continue
    }
    seen.add(next.id)
    if (next !== tab) changed = true
    tabs.push(next)
  }
  let closedChanged = false
  const closedTabs = vt.closedTabs.map((c) => {
    const tab = migrate(c.tab)
    if (tab !== c.tab) closedChanged = true
    return { ...c, tab }
  })
  if (!changed && !closedChanged) return
  persist(tabs, activeId, closedTabs)
  useViewerTabs.setState({ tabs, activeId, closedTabs })
}
migrateTabScopes()
unsubScopeMigration = useStore.subscribe(migrateTabScopes)
