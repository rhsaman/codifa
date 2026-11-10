/** Per-tab memory for the virtual-browser panel's sizing intent.
 *
 *  The panel is mounted with a per-tab `key`, so switching to another chat and
 *  back REMOUNTS it and every local state resets: the follow toggle fell back
 *  to its default, so a size the user had pinned silently turned back into
 *  follow mode on every return.
 *
 *  These are soft UI preferences, not data: they live in a module-level Map so
 *  they survive the remount and are dropped with the window, exactly like the
 *  backend's in-memory per-chat viewport. Nothing is written to disk — a size
 *  is per tab (a chat can hold more than one browser tab), and a restart
 *  starts from the backend's own default anyway.
 */

/** First-mount default for follow-the-pane. ON: dragging the right panel's
 *  splitter must reflow the PAGE (the emulated viewport follows the pane), not
 *  merely scale the rendered frame. The old OFF default made the browser look
 *  frozen at one width until the user found the toolbar toggle. */
export const DEFAULT_FIT_TO_PANE = true

export interface BrowserFitMemory {
  /** Follow-the-pane toggle as the user last left it. The fixed width itself
   *  lives in the backend's per-tab viewport, so it needs no UI memory. */
  fitToPane: boolean
}

/** Schema version of a stored entry. v1 had no version and was written while
 *  follow-the-pane defaulted to OFF — every tab therefore carries a `false`
 *  the user never chose. Bumping the version makes those legacy entries
 *  unreadable, so the panel starts from the (ON) default instead of freezing
 *  the page at the old emulated width. */
const VERSION = 2

type StoredFit = BrowserFitMemory & { v: number }

const memory = new Map<string, StoredFit>()

/** Memory key: the tab id when the caller has one, else the chat. A tab id
 *  already carries its chat, so it is the more specific of the two. */
export function browserFitKey(tabId: string | undefined, chatId: string): string {
  return tabId && tabId.trim() ? tabId : chatId
}

/** Remembered sizing intent for a key, or null on first mount. Legacy (v1)
 *  entries are treated as absent — see `VERSION`. */
export function loadBrowserFit(key: string): BrowserFitMemory | null {
  const hit = memory.get(key)
  return hit && hit.v === VERSION ? hit : null
}

/** Record the sizing intent. Called on every toggle change so the next
 *  remount restores exactly what the user left behind. */
export function saveBrowserFit(key: string, fit: BrowserFitMemory): void {
  memory.set(key, { ...fit, v: VERSION })
}

/** Forget a key — used when its browser session is stopped. */
export function clearBrowserFit(key: string): void {
  memory.delete(key)
}
