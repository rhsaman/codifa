/** Per-tab memory for the virtual-browser panel's sizing intent.
 *
 *  The panel is mounted with a per-tab `key`, so switching to another chat and
 *  back REMOUNTS it and every local state resets: follow-the-pane mode snapped
 *  back on and the fit cap fell to the default width, which made the panel
 *  silently re-fit (and clobber a size the user had set) on every return.
 *
 *  These are soft UI preferences, not data: they live in a module-level Map so
 *  they survive the remount and are dropped with the window, exactly like the
 *  backend's in-memory per-chat viewport. Nothing is written to disk — a size
 *  is per tab (a chat can hold more than one browser tab), and a restart
 *  starts from the backend's own default anyway.
 */

export interface BrowserFitMemory {
  /** Follow-the-pane toggle as the user last left it. */
  fitToPane: boolean
  /** Last manually applied width — the width fit-to-pane grows back up to. */
  capW: number
}

const memory = new Map<string, BrowserFitMemory>()

/** Memory key: the tab id when the caller has one, else the chat. A tab id
 *  already carries its chat, so it is the more specific of the two. */
export function browserFitKey(tabId: string | undefined, chatId: string): string {
  return tabId && tabId.trim() ? tabId : chatId
}

/** Remembered sizing intent for a key, or null on first mount. */
export function loadBrowserFit(key: string): BrowserFitMemory | null {
  return memory.get(key) ?? null
}

/** Record the sizing intent. Called on every change of either value so the
 *  next remount restores exactly what the user left behind. */
export function saveBrowserFit(key: string, fit: BrowserFitMemory): void {
  memory.set(key, fit)
}

/** Forget a key — used when its browser session is stopped. */
export function clearBrowserFit(key: string): void {
  memory.delete(key)
}
