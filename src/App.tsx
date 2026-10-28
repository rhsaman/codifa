import { useCallback, useEffect, useRef, useState, Suspense, lazy } from 'react'
import { useStore } from './lib/store'
import { ChatWindows } from './components/ChatWindows'

/** Tab row visible only in single-window mode. Multi-window hides the row:
 *  each stacked window carries its own header (title + hide button). */
function ChatTabsRow() {
  return (
    <div className="chat-tabs-row">
      <ChatTabListButton />
      <ChatTabBar />
    </div>
  )
}
import { Sidebar } from './components/Sidebar'
import { ChatTabBar } from './components/ChatTabBar'
import { ViewerTabBar } from './components/ViewerTabBar'
import { ViewerWindows } from './components/ViewerWindows'
import { clampSplitWidth, cycleTerminalTabs, loadSplitWidth, persistSplitWidth, useViewerTabs } from './lib/viewerTabs'
import { ViewerAddButton, ViewerDockBar, ViewerPaneFullscreenButton, ViewerPaneToggleButton, ViewerTabListButton } from './components/ViewerTabBar'
import { ChatTabListButton } from './components/ChatTabBar'
import { SettingsModal } from './components/SettingsModal'
import { SearchOverlay } from './components/SearchOverlay'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PREFIX_KEY, physicalKey, PREFIX_SHORTCUTS, panelToggleTarget, isWindowMoveChord, isApplePlatform } from './lib/shortcuts'
import { resolveChatClose } from './lib/chatClose'
import { collectChatIds, pickNeighborByRect, type WindowNavDir, type WindowRect } from './lib/chatTree'
import { focusChatInput } from './lib/chatFocus'
import { activePane, focusAppPane } from './lib/paneFocus'
import { cyclePane } from './lib/paneCycle'
import { paneOwner, snapshotIntent } from './lib/panePointer'
import { applyInputSuppression } from './lib/inputSuppress'
import { DEFAULT_THEME, THEMES } from './lib/themes'
import { UpdateButton } from './components/UpdateButton'
import { UsageChip } from './components/UsageChip'
import { invalidateSidecarCache } from './lib/api'
import { fetchAndPersist } from './lib/provider-fetch'
import { WindowStripCluster } from './components/WindowStripCluster'
import { WorkspaceMenuButton } from './components/WorkspaceMenuButton'
// xterm.js (term rendering) is only needed once the panel is actually opened,
// so it is split out of the startup chunk: the panel is a plain component with
// no imperative handle, and it renders `null` until the first open anyway.
const TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
)

/**
 * Is this keyboard event's target (or the focused element) inside a TERMINAL?
 *
 * Two independent hosts run a pty: the bottom panel (`.terminal-panel`) and a
 * right-pane terminal TAB (`.terminal-tab-panel`). App-level chords (Cmd+W
 * and the move/h/j/k/l family) must be swallowed in EITHER of them, or the pane
 * tab never sees the key — and its Ctrl+W closed the wrong thing.
 */
/** True when the key landed inside a host matching `sel` — the event target
 *  OR the focused element (xterm focus can sit in a hidden helper). */
function insideTerminalHost(target: HTMLElement | null | undefined, sel: string): boolean {
  return !!(target?.closest?.(sel) || document.activeElement?.closest?.(sel))
}

/** ANY terminal host: the bottom panel AND a right-pane terminal tab. Cmd+W
 *  closes whichever one holds the caret; Ctrl+M only ever fullscreens the
 *  bottom one (in a tab the pane below takes the fullscreen — see case 'm'). */
function isInsideTerminal(target: HTMLElement | null | undefined): boolean {
  return insideTerminalHost(target, '.terminal-panel, .terminal-tab-panel')
}

/** True when a direct Cmd/Ctrl+H/J/K/L window move must NOT run: inside a
 *  dialog/overlay (their own keys own the Ctrl chords there), inside a text
 *  input (readline keeps Ctrl+H as backspace and Ctrl+K kills the line), or
 *  when an @mention/command picker popup is open (its Ctrl+J/K walk its
 *  list). The terminals ARE in this list: xterm hands Ctrl+H/K/L to the shell
 *  (^H backspace, ^K kill-line). One exception: in a right-pane terminal TAB
 *  Ctrl+H (`left`) leaves the terminal for the chat — the way back from the
 *  Ctrl+L that entered it; its other chords stay shell input. The bottom panel
 *  keeps every one. The bottom panel itself toggles ONLY through the Ctrl+X J
 *  prefix chord. */
function isWindowMoveBlocked(t: HTMLElement | null | undefined, dir?: WindowNavDir | null): boolean {
  if (t?.closest?.('[role="dialog"], .settings-modal, .search-overlay, .terminal-panel')) return true
  if (t?.closest?.('.terminal-tab-panel') && dir !== 'left') return true
  // A text field only blocks the chord when the key could be TYPING. Every
  // move chord is Cmd/Ctrl+H/J/K/L (checked by isWindowMoveChord before this
  // runs), so a modified key is never plain text input: the chat composer's
  // textarea is `document.activeElement` almost all the time, and gating on
  // it made all four move chords dead there.
  if (document.querySelector('.mention-popup')) return true
  return false
}

/**
 * Cmd+W while a terminal has focus: close the thing the user is looking at.
 *
 * The BOTTOM panel is a multi-tab host, so it owns that gesture itself (it
 * listens for `coder:close-terminal-tab` and closes its ACTIVE tab). A
 * right-pane terminal tab is an ordinary viewer tab, so the window handler
 * closes it directly — dispatching the panel event for it did nothing at all,
 * which is why Ctrl+W in the pane terminal was a no-op.
 */
function closeFocusedTerminal(): void {
  if (document.activeElement?.closest?.('.terminal-panel')) {
    window.dispatchEvent(new CustomEvent('coder:close-terminal-tab'))
    return
  }
  const tabs = useViewerTabs.getState()
  const active = tabs.tabs.find((t) => t.id === tabs.activeId)
  if (active?.kind === 'terminal') tabs.closeViewer(active.id)
}

export default function App() {
  const loaded = useStore((s) => s.loaded)
  const load = useStore((s) => s.load)
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  )
  const settingsOpen = useStore((s) => s.settingsOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  // Keyboard suggestions follow this setting instead of the platform default
  // (see src/lib/inputSuppress.ts). `?? true` keeps them suppressed while the
  // settings payload is still cold-start defaults.
  const disableTextSuggestions = useStore(
    (s) => s.settings.disableTextSuggestions ?? true,
  )
  const viewerFull = useViewerTabs((s) => s.fullscreen)
  const paneOpen = useViewerTabs((s) => s.paneOpen)
  const chatFull = useStore((s) => s.chatFullscreen)
  // Animated open/close for the right pane — same shape as the sidebar: the
  // section itself STAYS MOUNTED (a fresh node would skip its first transition,
  // so remounting could never animate the open) and only its inline width
  // animates 0 ↔ splitW; the heavy content (ViewerWindows) mounts when open
  // and unmounts after the close transition. Opening/closing lands silently —
  // rings ride on Ctrl+X hops.
  const [paneContentMounted, setPaneContentMounted] = useState(paneOpen)
  useEffect(() => {
    if (paneOpen) {
      setPaneContentMounted(true)
      return
    }
    const t = window.setTimeout(() => setPaneContentMounted(false), 320)
    return () => window.clearTimeout(t)
  }, [paneOpen])
  const [searchOpen, setSearchOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // VSCode-style split between chat group and viewer group. Default half
  // viewport, resizable via the dock handle, persisted in localStorage.
  const [splitW, setSplitW] = useState(() => loadSplitWidth(0.5))
  const splitDrag = useRef<{ startX: number; startW: number } | null>(null)
  const viewerContentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onResize = () => setSplitW((w) => clampSplitWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startSplitResize = (e: React.MouseEvent) => {
    e.preventDefault()
    splitDrag.current = { startX: e.clientX, startW: splitW }
    const onMove = (ev: MouseEvent) => {
      if (!splitDrag.current) return
      const w = clampSplitWidth(splitDrag.current.startW - (ev.clientX - splitDrag.current.startX))
      setSplitW(w)
      persistSplitWidth(w)
    }
    const onUp = () => {
      splitDrag.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Loads persisted state. On failure we surface the error on the loading
  // screen (with a Retry button) instead of trapping the user on an endless
  // spinner — `load()` only sets store state at the very end, so a failed
  // attempt leaves nothing half-applied and retrying is safe.
  const runLoad = useCallback(() => {
    setLoadError(null)
    load().catch((err: unknown) => {
      console.error('[app] failed to load state:', err)
      setLoadError(err instanceof Error ? err.message : String(err))
    })
  }, [load])

  // tmux-style prefix sequence (Ctrl+X then u/r/c/x). The flag lives in a ref
  // so the window listener reads the latest state without re-subscribing.
  const prefixActiveRef = useRef(false)
  const prefixTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('coder:search', openSearch)
    return () => window.removeEventListener('coder:search', openSearch)
  }, [])

  // `coder:open-file` is the app-wide "open this workspace file" event (fired
  // by file chips and any future external-editor hook). Opening
  // happens here once so every dispatcher shares the same right-panel path.
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; line?: number }>).detail
      if (!detail?.path) return
      const st = useStore.getState()
      const root = st.chats.find((c) => c.id === st.activeChatId)?.root ?? st.root
      useViewerTabs.getState().openFile(detail.path, detail.line, root)
    }
    window.addEventListener('coder:open-file', onOpenFile)
    return () => window.removeEventListener('coder:open-file', onOpenFile)
  }, [])

  useEffect(() => {
    let saved = DEFAULT_THEME
    try {
      const t = localStorage.getItem('coder:theme')
      if (t && THEMES.some((th) => th.id === t)) saved = t
    } catch {}
    useStore.getState().setTheme(saved)
    runLoad()
  }, [load, runLoad])

  // The main.tsx installer only stamps fields on focus; this effect makes the
  // whole UI consistent as soon as the setting (or the hydrated state) lands,
  // and undoes it losslessly when the user switches suggestions back on. The
  // re-run on `loaded` matters: while the store is still loading, App renders
  // only the loading screen, so the first sweep would miss every real field.
  useEffect(() => {
    applyInputSuppression(disableTextSuggestions)
  }, [disableTextSuggestions, loaded])

  // Background sidecar health probe. Fires every 60s while the app is open
  // and pings /health against the cached URL. If the sidecar hung (process
  // alive but HTTP server wedged) the `sidecar:dead` event from main never
  // fires, so the cached URL stays stale and every subsequent call hits a
  // dead port. Catching that proactively keeps the next ensureSidecar() from
  // waiting for a real /models or /credits request to fail first. Bypasses
  // the in-flight dedup on purpose — we want a fresh probe, not the
  // previously-cached result.
  useEffect(() => {
    const PROBE_INTERVAL_MS = 60_000
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = async () => {
      if (cancelled) return
      try {
        const ok = await window.coder.probeSidecar()
        if (cancelled) return
        if (!ok) invalidateSidecarCache()
      } catch {
        /* probe itself failed — leave the cache; the next real call will surface it */
      }
      if (!cancelled) timer = setTimeout(probe, PROBE_INTERVAL_MS)
    }
    timer = setTimeout(probe, PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  // One-time startup model refresh: for every configured provider, ask the
  // sidecar `/models` endpoint and persist the result (model ids, context
  // windows, per-model pricing, reasoning support) into the store. This is
  // the ONLY automatic fetch — the model picker popup reads the persisted
  // list and never refetches on open, so models are fetched exactly at
  // startup and when a provider is added/edited (SettingsModal).
  //
  // Runs ONCE per session (gated by `loaded` so it only fires after the
  // persisted providers are in the store). Parallel via `allSettled` so a
  // single unreachable provider (e.g. ollama not running) doesn't block the
  // rest. Custom-added and explicitly-removed entries are preserved via the
  // same merge rule the Settings modal uses.
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    void (async () => {
      const providers = useStore.getState().settings.providers
      await Promise.allSettled(
        providers.map((p) => fetchAndPersist(p, { cancelled: () => cancelled })),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [loaded])

  useEffect(() => {
    const cancelPrefix = () => {
      if (!prefixActiveRef.current) return
      prefixActiveRef.current = false
      if (prefixTimerRef.current !== null) {
        window.clearTimeout(prefixTimerRef.current)
        prefixTimerRef.current = null
      }
      window.dispatchEvent(new CustomEvent('coder:prefix', { detail: false }))
    }

    // Panel toggles (Cmd/Ctrl+B, Cmd/Ctrl+Shift+B) must feel instant: flip
    // the boolean synchronously on keydown with zero extra work — no
    // prefix/palette checks, no async persist. The store debounces the
    // settings write to the background (see persistPanelsSoon in store.ts).
    function togglePanelFromKey(e: KeyboardEvent): boolean {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return false
      const target = panelToggleTarget(e)
      if (!target) return false
      e.preventDefault()
      // Stop the event here so no other window-level handler (search
      // overlay, pickers) re-processes the same chord after the default
      // is already prevented.
      e.stopPropagation()
      const st = useStore.getState()
      // Opening a panel puts the caret INSIDE it; closing it hands the caret
      // back to the chat (otherwise it stays on a hidden element and the next
      // keys go nowhere). One frame later: the panel mounts/unmounts on the
      // next React commit.
      let opened: boolean
      if (target === 'right') {
        const vt = useViewerTabs.getState()
        opened = !vt.paneOpen
        vt.togglePane()
      } else {
        opened = !st.sidebarOpen
        st.setSidebarOpen(opened)
      }
      requestAnimationFrame(() =>
        focusAppPane(opened ? (target === 'right' ? 'viewer' : 'sidebar') : 'chat'),
      )
      return true
    }

    /** Direct Cmd/Ctrl+H/J/K/L moves focus BETWEEN CHAT WINDOWS (no Ctrl+X
     *  prefix) — each key always walks its OWN vim direction: k=up, j=down,
     *  h=left, l=right.
     *
     *  The target is the window that REALLY lies in that direction on screen
     *  (pickNeighborByRect: live rects, nearest edge, same row/column first).
     *  With no window on that side the key does nothing — it NEVER crosses
     *  into the sidebar, the right pane or the terminal: the three sections
     *  are reached only through the Ctrl+X prefix (l/h/t). Returns false only
     *  when the chord is NOT ours (the caret sits outside the chat windows). */
    function moveChatWindow(dir: WindowNavDir): boolean {
      const st = useStore.getState()
      if (activePane() !== 'chat') return false
      const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds
      const rects: Record<string, WindowRect> = {}
      document.querySelectorAll<HTMLElement>('[data-chat-window]').forEach((el) => {
        const id = el.getAttribute('data-chat-window')
        if (!id || !ids.includes(id)) return
        if (el.classList.contains('window-hidden') || el.getAttribute('aria-hidden') === 'true') return
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return
        rects[id] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      })
      // `dir` already is the vim direction of the pressed key (isWindowMoveChord:
      // h=left, j=down, k=up, l=right). It used to be compared against the
      // letters 'h'/'l'/'k' here, so EVERY chord fell through to 'down'.
      const next = pickNeighborByRect(rects, st.activeChatId, dir)
      if (next && next !== st.activeChatId) {
        st.focusWindow(next)
        requestAnimationFrame(() => focusChatInput(next))
      }
      // No neighbour on that side: consume the chord, move nothing. The panes
      // beyond the edges are reached through the Ctrl+X prefix, never here.
      return true
    }

    function onKey(e: KeyboardEvent) {
      // While the prefix is armed, the very next key runs (or cancels) it.
      if (prefixActiveRef.current) {
        cancelPrefix()
        const k = physicalKey(e)
        // The prefix owns the SECTION hops: l/h move focus across the app's
        // three sections (sidebar ↔ chats ↔ right pane) and t lands in the
        // bottom terminal. Window-level movement between split CHAT WINDOWS
        // stays on the direct Ctrl+H/J/K/L chord (below) and is never taken
        // here. `j` toggles the terminal panel, also while the caret is inside
        // a terminal; `v`/Space are the voice toggles.
        // A key the prefix CONSUMES must not travel on: the capture listener
        // above xterm would otherwise let the second key through, and a
        // terminal with focus typed the `j` into the shell.
        // Live session has a dedicated toggle (coder:toggle-live), separate
        // from dictation (coder:toggle-voice) so the modes never mix. It lives
        // on `V` (voice).
        if (k === 'v') {
          e.preventDefault()
          e.stopPropagation()
          window.dispatchEvent(new CustomEvent('coder:toggle-live'))
          return
        }
        const sc = PREFIX_SHORTCUTS[k]
        if (sc) {
          e.preventDefault()
          e.stopPropagation()
          if (sc.action === 'voice') {
            // Ctrl+X then Space: toggle voice recording (the mic button).
            window.dispatchEvent(new CustomEvent('coder:toggle-voice'))
          } else if (sc.action === 'live') {
            // Ctrl+X then V: toggle the realtime voice session.
            window.dispatchEvent(new CustomEvent('coder:toggle-live'))
          } else if (sc.action === 'terminal') {
            // Ctrl+X then J: toggle the bottom terminal panel.
            useStore.getState().toggleTerminalPanel()
          } else if (sc.action === 'pane-right' || sc.action === 'pane-left') {
            // Ctrl+X then L/H: the ONLY way focus crosses the three sections —
            // the direct Ctrl+L/H chord never leaves the chat windows. A closed
            // pane is a valid destination: the right pane is revealed by
            // focusAppPane, so the sidebar opens here to match.
            const current = activePane()
            const next = cyclePane(current, sc.action === 'pane-right' ? 'l' : 'h')
            if (next !== current) {
              if (next === 'sidebar' && !useStore.getState().sidebarOpen) {
                useStore.getState().setSidebarOpen(true)
              }
              // The arrival ring fires HERE and nowhere else: opening/closing
              // the sidebar or the pane (buttons, Ctrl+B, store actions) and
              // mouse presses never flash — only an explicit Ctrl+X jump does.
              focusAppPane(next, { ring: true })
            }
          } else if (sc.action === 'terminal-focus') {
            // Ctrl+X then T: the RIGHT-PANE terminal tab — focus the plain
            // shell tab (spawning it when none exists; the pane opens with
            // it) and land the caret in its xterm. The BOTTOM panel keeps
            // its own chords: Ctrl+X then J toggles it.
            useViewerTabs.getState().openTerminal({ cwd: useStore.getState().root ?? undefined })
            focusAppPane('viewer', { ring: true })
          } else if (sc.action === 'files') {
            // Ctrl+X then E: the file explorer tab (opens the pane) with its
            // filter box focused. This used to sit on Ctrl/Cmd+F; that chord
            // now belongs to the chat transcript's find bar.
            useViewerTabs.getState().focusFilesFilter()
          } else if (sc.action === 'git') {
            // Ctrl+X then G: the focused chat's git diff page.
            useViewerTabs.getState().openGitDiff(useStore.getState().activeChatId ?? undefined)
          } else if (sc.action === 'artifacts') {
            // Ctrl+X then A: the artifacts page.
            useViewerTabs.getState().openArtifacts()
          } else if (sc.action === 'schedule') {
            // Ctrl+X then S: the schedule page.
            useViewerTabs.getState().openSchedule()
          } else if (sc.action === 'terminal-next' || sc.action === 'terminal-prev') {
            // Ctrl+X then ] / [: cycle the TERMINAL tabs — right-pane terminal
            // tabs (revealing the pane if closed), falling back to the bottom
            // panel's shells when the pane has none. Works while the caret is
            // inside a terminal too: the consumed key never reaches the shell.
            cycleTerminalTabs(sc.action === 'terminal-next' ? 1 : -1)
          } else {
            window.dispatchEvent(new CustomEvent('coder:cmd', { detail: sc.cmd }))
          }
        }
        return
      }
      // Arm the prefix: Ctrl+X with no other modifiers. Cmd+X (macOS cut)
      // still works because it sets metaKey, which we exclude here.
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        physicalKey(e) === PREFIX_KEY
      ) {
        e.preventDefault()
        prefixActiveRef.current = true
        window.dispatchEvent(new CustomEvent('coder:prefix', { detail: true }))
        prefixTimerRef.current = window.setTimeout(cancelPrefix, 2000)
        return
      }
      // DIRECT chord — Cmd/Ctrl + H/J/K/L (no Ctrl+X prefix): move focus
      // between the split chat windows. h=left, l=right on a horizontal
      // split, j=down, k=up on a vertical stack. Ranked lower than the app's
      // other chords on purpose: a defaultPrevented event (sidebar Ctrl+K
      // search focus) stands down, picker popups stopPropagation before the
      // event reaches here, and inside dialogs/overlay the pickers keep the
      // keys. The terminal keeps its shell chords too (xterm sends ^H/^K/^L),
      // so a blocked chord falls through instead of returning.
      const winDir = e.defaultPrevented ? null : isWindowMoveChord(e)
      if (winDir && !isWindowMoveBlocked(e.target as HTMLElement | null, winDir)) {
        if (moveChatWindow(winDir)) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
      // Fast path first: panel toggle never falls through to the switch.
      if (togglePanelFromKey(e)) return
      if (!(e.metaKey || e.ctrlKey)) return
      const k = physicalKey(e)
      // VSCode-style close: Cmd+W (Ctrl on non-Apple platforms) closes whatever
      // is in focus — the active TERMINAL tab while the terminal has focus,
      // else the focused CHAT WINDOW in multi-window mode (chat stays in
      // sidebar), else the active viewer tab, else the active chat tab. The
      // OTHER half of the chord is never a close: bare Ctrl+W on Apple is the
      // shell's delete-previous-word (^W) inside a terminal, and merely
      // swallowed elsewhere so it can never close the host window. Skip while
      // typing in the composer so a stray chord never eats the draft
      // mid-sentence (the xterm textarea does NOT count as "typing" here —
      // its chord closes the terminal tab). Multi-window chat windows are
      // exempt: their draft survives in the sidebar, so the close chord there
      // always closes that window.
      if (k === 'w' && !e.shiftKey && !e.altKey) {
        const isClosePlatformChord = isApplePlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
        const t = e.target as HTMLElement | null
        const inTerminal = isInsideTerminal(t)
        if (!isClosePlatformChord) {
          // Not the close half: outside a terminal it is swallowed so the
          // host window never closes; inside one it is ordinary shell input
          // (^W delete-word) and MUST reach the pty — no preventDefault there.
          if (!inTerminal) {
            e.preventDefault()
            e.stopPropagation()
          }
          return
        }
        const inDialog = !!t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')
        // Multi-window: the platform close chord on a chat window closes THAT
        // window, even
        // while typing in its composer (draft survives in the sidebar).
        // Resolved from the event target so a non-focused window closes
        // when its own composer has focus.
        if (!inDialog) {
          const winEl = t?.closest?.('[data-chat-window]') as HTMLElement | null
          const winId = winEl?.getAttribute('data-chat-window') || null
          if (winId) {
            const st0 = useStore.getState()
            const treeIds0 = st0.chatTree ? collectChatIds(st0.chatTree) : st0.visibleChatIds
            if (treeIds0.length > 1 && treeIds0.includes(winId)) {
              e.preventDefault()
              e.stopPropagation()
              if (inTerminal) {
                closeFocusedTerminal()
                return
              }
              st0.closeWindow(winId)
              return
            }
          }
        }
        if (inDialog) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (inTerminal) {
          e.preventDefault()
          e.stopPropagation()
          closeFocusedTerminal()
          return
        }
        // Always swallow Ctrl+W so the app itself never closes. A single
        // chat window closes its own tab (draft survives in the sidebar);
        // typing in other inputs is swallowed without closing to avoid
        // eating a draft mid-sentence.
        e.preventDefault()
        e.stopPropagation()
        const ownWinEl = t?.closest?.('[data-chat-window]') as HTMLElement | null
        const ownWinId = ownWinEl?.getAttribute('data-chat-window') || null
        if (ownWinId) {
          const stOwn = useStore.getState()
          const treeIdsOwn = stOwn.chatTree ? collectChatIds(stOwn.chatTree) : stOwn.visibleChatIds
          const action = resolveChatClose(ownWinId, treeIdsOwn, stOwn.activeChatId)
          if (action?.kind === 'window') stOwn.closeWindow(action.id)
          else if (action && action.id) stOwn.closeChatTab(action.id)
          return
        }
        const typingInInput =
          !!t &&
          (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
        if (typingInInput) return
        {
          const vt = useViewerTabs.getState()
          if (vt.activeId) vt.closeViewer(vt.activeId)
          else {
            const st = useStore.getState()
            const treeIds = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds
            const action = resolveChatClose(st.activeChatId, treeIds, st.activeChatId)
            if (action?.kind === 'window') st.closeWindow(action.id)
            else if (action && action.id) st.closeChatTab(action.id)
          }
          return
        }
      }
      switch (k) {
        case ',': {
          e.preventDefault()
          useStore.getState().setSettingsOpen(true)
          break
        }
        case 'p': {
          // navChord در پیکرهای @mention/پالت فرمان هم "k" و هم "p" را ناوبری
          // بالا حساب می‌کند و preventDefault می‌زند؛ اگر رویداد با
          // defaultPrevented به این‌جا رسیده، مالِ یک پیکرِ در فوکوس است و
          // نباید سرچ فایل را باز کنیم (رگرسیون مشابه Ctrl+K سایدبار).
          if (e.defaultPrevented) break
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('coder:search'))
          break
        }
        case 'm': {
          // Fullscreen ladder, decided by WHERE focus is: the BOTTOM terminal
          // panel first (a right-pane terminal TAB belongs to the pane step
          // below), then the right viewer pane — but only when the focus is
          // INSIDE it, so a merely-open pane never steals the chord from a
          // focused chat window — then the focused chat window (single window
          // falls back to the whole chat area). Dialogs keep their own chords.
          const t = e.target as HTMLElement | null
          if (t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')) break
          e.preventDefault()
          if (insideTerminalHost(t, '.terminal-panel')) {
            useStore.getState().toggleTerminalFullscreen()
            break
          }
          // The pane claims the chord when FOCUS sits inside it (event target
          // or the active element — xterm hosts the caret on its own helper
          // node) — a merely-open pane must never steal Ctrl+M from a focused
          // chat window. WebKit adds a wrinkle: clicking non-focusable pane
          // content (a diff line, a code row) never MOVES focus, so the
          // keydown still carries the composer's stale caret. The pointer
          // intent (panePointer — the same source the Ctrl+X chords read)
          // covers that case: the last-clicked pane claims the chord as long
          // as no newer typing intent (a return to an input) outvotes it.
          const paneEl =
            t?.closest?.('.viewer-group') ||
            document.activeElement?.closest?.('.viewer-group') ||
            (() => {
              const owner = paneOwner()
              if (!owner) return null
              const st = snapshotIntent()
              if (st.typingAt > st.regionAt) return null
              return owner.closest?.('.viewer-group') ?? null
            })()
          if (paneEl) {
            const vt = useViewerTabs.getState()
            const next = !vt.fullscreen
            vt.setFullscreen(next)
            if (next) useStore.getState().setChatFullscreen(false)
            break
          }
          useStore.getState().toggleWindowFullscreen()
          const after = useStore.getState().activeChatId
          if (after) requestAnimationFrame(() => focusChatInput(after))
          break
        }
        case 't': {
          e.preventDefault()
          // A terminal holding the caret owns the chord: Ctrl+T spawns another
          // shell THERE (exactly what its own "+" does) instead of yanking the
          // user out of the terminal into a new chat.
          const termTarget = e.target as HTMLElement | null
          if (insideTerminalHost(termTarget, '.terminal-panel')) {
            window.dispatchEvent(new CustomEvent('coder:new-terminal'))
            break
          }
          if (insideTerminalHost(termTarget, '.terminal-tab-panel')) {
            useViewerTabs.getState().openTerminal({
              cwd: useStore.getState().root,
              fresh: true,
            })
            break
          }
          useStore.getState().newChat()
          break
        }
        default:
          break
      }
    }
    // CAPTURE phase: the composer (a plain textarea) is usually the focused
    // element and stops keydown propagation, so a bubble listener on `window`
    // never saw Cmd/Ctrl+H/J/K/L at all. Capturing here lets the app claim its
    // chords first; onKey returns early for everything that is plain typing.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancelPrefix)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancelPrefix)
    }
  }, [])

  if (loadError) {
    return <LoadingScreen error={loadError} onRetry={runLoad} />
  }

  if (!loaded) {
    return <LoadingScreen />
  }

  return (
    <div
      className="app"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        maxHeight: "100vh",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        className="app-body"
        style={{
          flex: "1 1 0",
          display: "flex",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <ErrorBoundary>
          <Sidebar />
          <div className={
            "editor-area" +
            (viewerFull && !chatFull ? " viewer-full" : "") +
            (chatFull ? " chat-full" : "")
          }
            style={{
              flex: "1 1 auto",
              display: "flex",
              minHeight: 0,
              minWidth: 0,
              overflow: "hidden",
            }}>
            <section className="chat-group" aria-label="Chats">
              {/* Chat-scoped app bar — spans ONLY the chat column, never the
                  sidebar or the viewer panels. Keeps the `titlebar` class for
                  the window drag region and the #titlebar-toolbar portal
                  styles. `solo` marks the sidebar-closed state: on macOS the
                  window-strip cluster renders inline here (the sidebar strip
                  is gone), so the bar clears the traffic lights; while the
                  sidebar is open the cluster lives in the sidebar's strip and
                  this bar starts right at the chat column. */}
              <header
                className={`titlebar chat-topbar${sidebarOpen ? "" : " solo"}`}
                role="banner"
              >
                <WindowStripCluster />
                <WorkspaceMenuButton root={activeChatRoot} />
                <div id="titlebar-toolbar" />
                <UpdateButton />
                {/* Empty stretch that carries the window drag region: the bar
                    itself must stay no-drag so its horizontal scrollbar stays
                    draggable when the pills overflow. */}
                <span className="titlebar-drag-spacer" aria-hidden="true" />
                {/* Right-side mount: the model-usage chip is a static child so
                    it sits LEFT of the wallet chip (portaled here from
                    ChatPanel right after it). */}
                <div id="titlebar-right">
                  <UsageChip />
                </div>
                {/* The single side-pane switch (like the reference app): opens
                    the right pane when it's closed. While the pane is OPEN the
                    switch hides — the pane header carries its own panel toggle
                    and collapse, so the app bar would only duplicate them. */}
                {!paneOpen && (
                  <button
                    className="titlebar-icon-btn pane-toggle"
                    title="Show side pane"
                    aria-label="Show side pane"
                    aria-pressed={false}
                    onClick={() => useViewerTabs.getState().togglePane()}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="16" rx="2.5" />
                      <path d="M15 4v16" />
                      <rect x="16.2" y="6.5" width="4.1" height="11" rx="1.2" fill="currentColor" stroke="none" opacity="0.55" className="panel-toggle-fill" />
                    </svg>
                  </button>
                )}
              </header>
              {/* Tab row stays visible in every mode; multi-window adds one header per window (title + status + close) and the stack below carries one ChatPanel per visible chat. */}
              <ChatTabsRow />
              <main className="main">
                {/* Each visible chat mounts its own ChatPanel (independent
                  scroll/draft/composer); single window = one panel, same as
                  before. No key remount: panels reset per-chat state by id. */}
                <ChatWindows />
              </main>
            </section>
            {!chatFull && (
              <>
                {!viewerFull && paneOpen && (
                  <div
                    className="dock-resize-handle"
                    title="Drag to resize"
                    onMouseDown={startSplitResize}
                  />
                )}
                <section
                  className={"viewer-group" + (paneOpen ? "" : " closing")}
                  style={
                    viewerFull && paneOpen
                      ? {
                          display: "flex",
                          flexDirection: "column",
                          minHeight: 0,
                          minWidth: 0,
                          overflow: "hidden",
                        }
                      : ({
                          /* The width animates 0 ↔ splitW on the persistent
                             section; closed it rests at 0 (invisible, inert).
                             max-width rides along INLINE: the stylesheet's
                             min(50%, …) cap would otherwise clamp the first
                             ~40% of the close transition into a visible
                             plateau (width stuck, then a sudden drop). */
                          flexBasis: paneOpen ? splitW : 0,
                          width: paneOpen ? splitW : 0,
                          maxWidth: paneOpen ? splitW : undefined,
                          display: "flex",
                          flexDirection: "column",
                          minHeight: 0,
                          minWidth: 0,
                          overflow: "hidden",
                        } as React.CSSProperties)
                  }
                  aria-label="Viewers"
                >
                  {/* Pane body: a titled tab strip along the TOP edge (files,
                      browser, trace — the tab-like surfaces; "+" opens only
                      the chat-owned Browser/Trace), the viewer content, and a
                      fixed launcher dock along the BOTTOM edge that stays
                      completely separate from the tabs (one permanent icon
                      per page; clicking again closes the page). */}
                  <div className="viewer-pane-body">
                    <div className="viewer-pane-head">
                      <ViewerTabListButton />
                      <ViewerTabBar />
                      {/* The single tab entry point: its menu opens only the
                          chat-owned pages (Browser/Trace) as ordinary tabs. */}
                      <ViewerAddButton />
                      <span className="viewer-pane-spacer" aria-hidden="true" />
                      <div className="viewer-pane-actions">
                        <ViewerPaneFullscreenButton />
                        <ViewerPaneToggleButton />
                      </div>
                    </div>
                    <div
                      ref={viewerContentRef}
                      tabIndex={-1}
                      className="viewer-content"
                      style={{
                        flex: "1 1 auto",
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        minWidth: 0,
                        overflow: "hidden",
                      }}
                      // Click-to-focus: WebKit never moves the caret when a
                      // click lands on non-focusable pane content (a diff
                      // line, a code row), so the pane never "has focus" and
                      // pane-scoped chords (Ctrl+M) misfire. Give the pane
                      // host the caret — unless the click already landed on
                      // something that takes focus of its own (a button, the
                      // find box, an xterm screen). xterm manages its own
                      // focus: its mousedown handler focuses the hidden
                      // textarea, but the click TARGET is the canvas, so the
                      // target-based editable probe below can never see it —
                      // excluding `.xterm` here is what keeps a pane-terminal
                      // click from having its caret stolen right back.
                      onMouseDown={(e) => {
                        const t = e.target as HTMLElement | null
                        if (t?.closest?.(
                          'input, textarea, select, button, a, [contenteditable="true" i], [tabindex]:not([tabindex="-1"]), .xterm',
                        )) return
                        viewerContentRef.current?.focus({ preventScroll: true })
                      }}
                    >
                      {paneContentMounted ? <ViewerWindows /> : null}
                    </div>
                    {/* The dock rides the CONTENT mount (not paneOpen): it
                        stays through the close fade instead of vanishing
                        under a still-collapsing pane. */}
                    {paneContentMounted ? <ViewerDockBar /> : null}
                  </div>
                </section>
              </>
            )}
          </div>
        </ErrorBoundary>
      </div>

      <Suspense fallback={null}>
        <TerminalPanel />
      </Suspense>

      {settingsOpen && <SettingsModal onClose={() => useStore.getState().setSettingsOpen(false)} />}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </div>
  )
}