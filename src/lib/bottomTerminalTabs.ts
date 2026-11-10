/**
 * The BOTTOM terminal panel's tab list, persisted so a restart keeps it.
 *
 * The right pane's terminal tabs are ordinary viewer tabs and survive a
 * restart through `coder:viewerTabs` (src/lib/viewerTabs.ts). The bottom panel
 * is a separate host with its own tab list that lived only in component state,
 * so every restart emptied it. This module is its storage:
 *
 *  - only the TAB RECORD survives (title, cwd, shell, program) — never the pty
 *    id, which dies with the process. On boot each record spawns a FRESH shell,
 *    exactly like VS Code restoring a terminal.
 *  - `title` is what the user typed (double-click rename). It is separate from
 *    `shell` so the "renamed" name and the real shell label can both be shown.
 *  - `wsKey` pins the tab to the workspace it was opened in, which is what makes
 *    "new terminal opens in the workspace I am in" survive a restart.
 */
import { workspaceKey } from './store'

/** One restored tab: everything needed to spawn its shell again. */
export interface PersistedTerminalTab {
  /** Stable local id (NOT a pty id) used as the React key until spawn. */
  key: string
  /** User-visible name; empty/absent = fall back to the shell label. */
  title?: string
  shell: string
  cwd: string
  program?: string
  argv?: string[]
  /** Workspace the tab belongs to (`workspaceKeyForChat` of its chat). */
  wsKey?: string
  /** True for the tab that had the caret when the app closed. */
  active?: boolean
}

/**
 * Tabs are stored PER WORKSPACE: `{ byWorkspace: { [wsKey]: Tab[] } }`.
 *
 * A single flat list was wrong: switching to another workspace showed the
 * previous project's shells, and the first save there overwrote them. Keyed by
 * `wsKey` every workspace keeps its own strip, and a switch just reads a
 * different slot — nothing is lost and nothing leaks across projects.
 *
 * The older flat shape (`{ tabs: [...] }`, and a bare array before that) is
 * still read and folded under its own `wsKey`, so an upgrade keeps the tabs.
 */
interface StoreShape {
  byWorkspace: Record<string, PersistedTerminalTab[]>
}

const KEY = 'coder:bottomTerminalTabs'

function readStore(): StoreShape {
  if (typeof localStorage === 'undefined') return { byWorkspace: {} }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { byWorkspace: {} }
    const parsed = JSON.parse(raw) as Partial<StoreShape> & { tabs?: unknown }
    if (parsed && typeof parsed.byWorkspace === 'object' && parsed.byWorkspace) {
      return { byWorkspace: parsed.byWorkspace as Record<string, PersistedTerminalTab[]> }
    }
    // Legacy flat payload: group by each tab's own wsKey.
    const legacy = Array.isArray(parsed?.tabs) ? parsed.tabs : []
    const byWorkspace: Record<string, PersistedTerminalTab[]> = {}
    for (const row of sanitize(legacy)) {
      const k = row.wsKey || NO_WORKSPACE
      ;(byWorkspace[k] ||= []).push(row)
    }
    return { byWorkspace }
  } catch {
    // A corrupt payload must not brick the panel: start empty instead.
    return { byWorkspace: {} }
  }
}

/** Rows that carry everything needed to spawn a shell again. */
function sanitize(rows: unknown): PersistedTerminalTab[] {
  const list = Array.isArray(rows) ? rows : []
  return list.filter((r): r is PersistedTerminalTab => {
    const t = r as PersistedTerminalTab
    return (
      !!t &&
      typeof t.key === 'string' &&
      t.key.length > 0 &&
      typeof t.cwd === 'string' &&
      typeof t.shell === 'string'
    )
  })
}

/** Key used for tabs opened with no project at all (the "No project" bucket). */
export const NO_WORKSPACE = '__none__'

/** Restored tabs for ONE workspace (empty when that workspace has none). */
export function loadBottomTerminalTabs(wsKey: string = NO_WORKSPACE): PersistedTerminalTab[] {
  return sanitize(readStore().byWorkspace[wsKey])
}

/** Replace ONE workspace's tabs; the other workspaces are left untouched. */
export function saveBottomTerminalTabs(wsKey: string, tabs: PersistedTerminalTab[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    const store = readStore()
    if (tabs.length === 0) delete store.byWorkspace[wsKey]
    else store.byWorkspace[wsKey] = tabs
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Quota/private mode: persistence is best-effort, never fatal.
  }
}

/** Every saved workspace, for tests and diagnostics. */
export function allBottomTerminalWorkspaces(): string[] {
  return Object.keys(readStore().byWorkspace)
}

/** The user-typed name if there is one, else the shell label. */
export function terminalTabLabel(t: { title?: string; shell: string }): string {
  const custom = (t.title ?? '').trim()
  return custom || t.shell
}

/**
 * A trimmed rename. Empty input clears the custom name (the tab falls back to
 * its shell label) rather than leaving a nameless chip.
 */
export function normalizeTerminalTitle(next: string): string | undefined {
  const t = next.trim()
  return t ? t : undefined
}

/**
 * Where "new terminal" opens when the panel is used from the current view:
 * the OPEN CHAT's project root, else the app root, else home.
 *
 * Without the chat hop a new tab landed in whichever project the app loaded
 * first — the same bug the right pane had.
 */
export function workspaceCwdForNewTerminal(app: {
  chats?: Array<{ id: string; root?: string }>
  activeChatId?: string | null
  root?: string | null
  workspaces?: Array<{ key: string; root?: string | null }>
  activeWorkspaceKey?: string | null
}): string {
  const active = app.activeChatId
  const chat = Array.isArray(app.chats) ? app.chats.find((c) => c.id === active) : undefined
  if (chat?.root) return chat.root
  // No chat to take the project from: the ACTIVE WORKSPACE (`switchWorkspace`
  // keeps this current) beats the app-wide root, which is whatever project the
  // app happened to load first.
  const wsKey = app.activeWorkspaceKey
  const ws = Array.isArray(app.workspaces) && wsKey
    ? app.workspaces.find((w) => w.key === wsKey)
    : undefined
  return ws?.root || app.root || ''
}

/** Workspace key of the tab opened right now (pins it to its project).
 *
 *  Derived from the PASSED state, never from a global read: this is also the
 *  store SELECTOR the panel subscribes with, so it must stay pure — delegating
 *  to `workspaceKeyForChat` (which calls `useStore.getState()`) read a different
 *  store instance and answered `__none__` even with a chat open, which parked
 *  every workspace's tabs in the "no project" bucket.
 *
 *  The ACTIVE WORKSPACE wins when there is one: that is the value
 *  `switchWorkspace` writes, so clicking another project in the sidebar swaps
 *  the terminal strip immediately. A half-migrated state that has chats but no
 *  workspace record still follows the open chat.
 */
export function currentTerminalWorkspace(app: {
  chats?: Array<{ id: string; root?: string }>
  activeChatId?: string | null
  root?: string | null
  workspaces?: Array<{ key: string; root?: string | null }>
  activeWorkspaceKey?: string | null
}): string {
  const wsKey = (app.activeWorkspaceKey ?? '').trim()
  if (wsKey && wsKey !== NO_WORKSPACE) return wsKey
  return workspaceKey(workspaceCwdForNewTerminal(app))
}
