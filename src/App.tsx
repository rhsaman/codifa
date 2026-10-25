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
import { clampSplitWidth, loadSplitWidth, persistSplitWidth, useViewerTabs } from './lib/viewerTabs'
import { ViewerAddButton, ViewerPaneFullscreenButton, ViewerTabListButton } from './components/ViewerTabBar'
import { ChatTabListButton } from './components/ChatTabBar'
import { SettingsModal } from './components/SettingsModal'
import { SearchOverlay } from './components/SearchOverlay'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PREFIX_KEY, physicalKey, PREFIX_SHORTCUTS, panelToggleTarget, isApplePlatform, prefixMoveDir } from './lib/shortcuts'
import { resolveChatClose } from './lib/chatClose'
import { collectChatIds, pickNeighborWindow } from './lib/chatTree'
import { focusChatInput } from './lib/chatFocus'
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
 * right-pane terminal TAB (`.terminal-tab-panel`). App-level chords (Cmd/Ctrl+W
 * and the move/h/j/k/l family) must be swallowed in EITHER of them, or the pane
 * tab never sees the key — and its Ctrl+W closed the wrong thing.
 */
function isInsideTerminal(target: HTMLElement | null | undefined): boolean {
  const sel = '.terminal-panel, .terminal-tab-panel'
  return !!(target?.closest?.(sel) || document.activeElement?.closest?.(sel))
}

/**
 * Ctrl/Cmd+W while a terminal has focus: close the thing the user is looking at.
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
  const activeChatId = useStore((s) => s.activeChatId)
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
  const [searchOpen, setSearchOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // VSCode-style split between chat group and viewer group. Default half
  // viewport, resizable via the dock handle, persisted in localStorage.
  const [splitW, setSplitW] = useState(() => loadSplitWidth(0.5))
  const splitDrag = useRef<{ startX: number; startW: number } | null>(null)
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

  const openWorkspace = (dir: string) => {
    const state = useStore.getState()
    state.setChatRoot(state.activeChatId, dir)
  }

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
      if (target === 'right') useViewerTabs.getState().togglePane()
      else st.setSidebarOpen(!st.sidebarOpen)
      return true
    }

    function onKey(e: KeyboardEvent) {
      // While the prefix is armed, the very next key runs (or cancels) it.
      if (prefixActiveRef.current) {
        cancelPrefix()
        const k = physicalKey(e)
        // Ctrl+X then H/J/K/L moves the focused chat window vim-style
        // (swaps with the neighbor). Wins over other `l` bindings when a
        // neighbor exists; otherwise falls through so Ctrl+X L still
        // toggles the live session in single-window mode.
        const moveDir = prefixMoveDir(k)
        if (moveDir) {
          const t = e.target as HTMLElement | null
          const inDialog = !!t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')
          if (!inDialog && !isInsideTerminal(t)) {
            const st = useStore.getState()
            const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds
            if (ids.length > 1) {
              const els = document.querySelectorAll<HTMLElement>('[data-chat-window]')
              const centers: Record<string, { x: number; y: number }> = {}
              els.forEach((el) => {
                const id = el.getAttribute('data-chat-window')
                if (!id) return
                if (el.classList.contains('window-hidden') || el.getAttribute('aria-hidden') === 'true') return
                const r = el.getBoundingClientRect()
                if (r.width <= 0 || r.height <= 0) return
                centers[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
              })
              const target = pickNeighborWindow(centers, st.activeChatId, moveDir)
              if (target) {
                e.preventDefault()
                e.stopPropagation()
                st.dropChatOnto(st.activeChatId, target, 'center')
                const after = useStore.getState().activeChatId
                if (after) requestAnimationFrame(() => focusChatInput(after))
                return
              }
            }
          }
          // No neighbor to move toward: h/j/k do nothing, l falls through
          // to the live toggle below so single-window behavior is unchanged.
          if (k !== 'l') return
        }
        // Live session has a dedicated toggle (coder:toggle-live), separate
        // from dictation (coder:toggle-voice) so the modes never mix.
        // Ctrl+X then L toggles the live session only (when no window move happened).
        if (k === 'l') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('coder:toggle-live'))
          return
        }
        // Ctrl+X then J toggles the bottom terminal panel (user request —
        // alongside the existing Cmd/Ctrl+J direct chord).
        if (k === 'j') {
          e.preventDefault()
          useStore.getState().toggleTerminalPanel()
          return
        }
        const sc = PREFIX_SHORTCUTS[k]
        if (sc) {
          e.preventDefault()
          if (sc.action === 'voice') {
            // Ctrl+X then Space: toggle voice recording (the mic button).
            window.dispatchEvent(new CustomEvent('coder:toggle-voice'))
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
      // Fast path first: panel toggle never falls through to the switch.
      if (togglePanelFromKey(e)) return
      if (!(e.metaKey || e.ctrlKey)) return
      const k = physicalKey(e)
      // VSCode-style close: Cmd/Ctrl+W closes whatever is in focus — the
      // active TERMINAL tab while the terminal panel has focus, else the
      // focused CHAT WINDOW in multi-window mode (chat stays in sidebar),
      // else the active viewer tab, else the active chat tab. Skip while
      // typing in the composer so a stray chord never eats the draft
      // mid-sentence (the xterm textarea does NOT count as "typing" here —
      // its chord closes the terminal tab). Multi-window chat windows are
      // exempt: their draft survives in the sidebar, so Ctrl+W there always
      // closes that window.
      if (k === 'w' && !e.shiftKey && !e.altKey) {
        const t = e.target as HTMLElement | null
        const inTerminal = isInsideTerminal(t)
        const inDialog = !!t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')
        // Multi-window: Ctrl+W on a chat window closes THAT window, even
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
        case 'j': {
          // Bottom terminal panel — Cmd+J on Apple platforms, Ctrl+J elsewhere
          // (the user-facing spec, unlike the app's usual Cmd/Ctrl duality).
          // Must also work while the terminal itself has focus: xterm's custom
          // key handler lets this chord bubble up instead of feeding it to
          // the shell.
          if (isApplePlatform() ? !e.metaKey : !e.ctrlKey) break
          e.preventDefault()
          useStore.getState().toggleTerminalPanel()
          break
        }
        case 'm': {
          // Window fullscreen inside the chat area (Tab still cycles agent
          // modes, so Ctrl/Cmd+M is free for this). Dialogs keep their own
          // Ctrl chords. While the terminal has focus the same chord
          // fullscreens the terminal panel instead.
          const t = e.target as HTMLElement | null
          if (t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')) break
          e.preventDefault()
          if (isInsideTerminal(t)) {
            useStore.getState().toggleTerminalFullscreen()
            break
          }
          useStore.getState().toggleWindowFullscreen()
          break
        }
        case 't': {
          e.preventDefault()
          useStore.getState().newChat()
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', cancelPrefix)
    return () => {
      window.removeEventListener('keydown', onKey)
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
            {paneOpen && !chatFull && (
              <>
                {!viewerFull && (
                  <div
                    className="dock-resize-handle"
                    title="Drag to resize"
                    onMouseDown={startSplitResize}
                  />
                )}
                <section
                  className="viewer-group"
                  style={
                    viewerFull
                      ? {
                          display: "flex",
                          flexDirection: "column",
                          minHeight: 0,
                          minWidth: 0,
                          overflow: "hidden",
                        }
                      : ({
                          flexBasis: splitW,
                          width: splitW,
                          display: "flex",
                          flexDirection: "column",
                          minHeight: 0,
                          minWidth: 0,
                          overflow: "hidden",
                        } as React.CSSProperties)
                  }
                  aria-label="Viewers"
                >
                  {/* Pane body: viewer content beside a vertical icon rail
                      pinned to the pane's right edge. Canonical rail order, top
                      to bottom: [collapse | tab list | fullscreen | "+" | tab
                      rows]. Pages have no fixed icons: the "+" opens them as
                      ordinary tabs, so anything opened can also be closed. */}
                  <div className="viewer-pane-body">
                    <div
                      className="viewer-content"
                      style={{
                        flex: "1 1 auto",
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        minWidth: 0,
                        overflow: "hidden",
                      }}
                    >
                      <ViewerWindows />
                    </div>
                    <div className="viewer-pane-head">
                      <div className="viewer-pane-actions">
                        <button
                          className="titlebar-icon-btn"
                          title="Hide side pane"
                          aria-label="Hide side pane"
                          onClick={() => useViewerTabs.getState().setPaneOpen(false)}
                        >
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="18" height="16" rx="2.5" />
                            <path d="M15 4v16" />
                            <rect x="16.2" y="6.5" width="4.1" height="11" rx="1.2" fill="currentColor" stroke="none" opacity="0.55" className="panel-toggle-fill" />
                          </svg>
                        </button>
                      </div>
                      <ViewerTabListButton />
                      <ViewerPaneFullscreenButton />
                      {/* The single page entry point: its menu opens any page as
                          a closable tab in the rows below. */}
                      <ViewerAddButton />
                      <ViewerTabBar />
                      <span className="viewer-pane-spacer" aria-hidden="true" />
                    </div>
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