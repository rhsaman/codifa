import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './lib/store'
import { ChatPanel } from './components/Chat'
import { Sidebar } from './components/Sidebar'
import { CodeMapPanel } from './components/CodeMapPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { TracePanel } from './components/TracePanel'
import { useReviewPanel } from './lib/reviewPanel'
import { useTracePanel } from './lib/tracePanel'
import { RightPanel } from './components/TodosPanel'
import { ScheduleInbox, ScheduleInboxButton } from './components/ScheduleInbox'
import { SettingsModal } from './components/SettingsModal'
import { SearchOverlay } from './components/SearchOverlay'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PREFIX_KEY, physicalKey, PREFIX_SHORTCUTS, panelToggleTarget } from './lib/shortcuts'
import { DEFAULT_THEME, THEMES } from './lib/themes'
import { UpdateButton } from './components/UpdateButton'
import { UsageChip } from './components/UsageChip'
import { invalidateSidecarCache } from './lib/api'
import { fetchAndPersist } from './lib/provider-fetch'

export default function App() {
  const loaded = useStore((s) => s.loaded)
  const load = useStore((s) => s.load)
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  )
  const activeChatId = useStore((s) => s.activeChatId)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const codeMapPanelOpen = useStore((s) => s.codeMapPanelOpen)
  const rightPanelOpen = useStore((s) => s.rightPanelOpen)
  // پنل Review سمت راست (سبک کدکس): با کلیک روی کارت edit_file/write_file باز
  // می‌شود و ترنِ همان پیام را نشان می‌دهد.
  const reviewOpen = useReviewPanel((s) => s.open)
  const reviewSource = useReviewPanel((s) => s.source)
  const traceOpen = useTracePanel((s) => s.open)
  const [searchOpen, setSearchOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

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
      if (target === 'right') st.setRightPanelOpen(!st.rightPanelOpen)
      else st.setSidebarOpen(!st.sidebarOpen)
      return true
    }

    function onKey(e: KeyboardEvent) {
      // While the prefix is armed, the very next key runs (or cancels) it.
      if (prefixActiveRef.current) {
        cancelPrefix()
        const k = physicalKey(e)
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
        case 'o': {
          e.preventDefault()
          useStore.getState().toggleCodeMapPanel()
          break
        }
        case 'm': {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('coder:toggle-mode'))
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
    <div className="app">
      <header className="titlebar" role="banner">
        <button
          className="icon-btn titlebar-icon-btn"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          title={sidebarOpen ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)'}
          aria-pressed={sidebarOpen}
          onClick={() => useStore.getState().toggleSidebar()}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <span className="app-title">Codifa</span>
        <button
          className="workspace-btn"
          aria-label="Open workspace folder"
          title={activeChatRoot || 'No workspace open — pick a folder for this chat'}
          onClick={() => void window.coder.selectFolder().then((dir) => dir && openWorkspace(dir))}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          <span className="workspace-btn-label">{activeChatRoot ? activeChatRoot.split('/').filter(Boolean).pop() : 'Open workspace'}</span>
        </button>
        <div id="titlebar-toolbar" />
        <UsageChip />
        <UpdateButton />
        <div className="titlebar-workspace">
          <ScheduleInboxButton />
          <button
            className="titlebar-icon-btn"
            title="Chat traces — laya / LLM / prompts"
            aria-label="Chat traces — laya / LLM / prompts"
            aria-pressed={traceOpen}
            onClick={() => useTracePanel.getState().openTraces()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M4 12h10M4 18h7" />
              <path d="M17 16l3 3m0-3l-3 3" />
            </svg>
          </button>
          <button
            className="titlebar-icon-btn"
            title="Git diff — uncommitted changes"
            aria-label="Git diff — uncommitted changes"
            aria-pressed={reviewOpen && reviewSource === 'uncommitted'}
            onClick={() => useReviewPanel.getState().openGitDiff()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="6" r="2.4" />
              <circle cx="6" cy="18" r="2.4" />
              <circle cx="18" cy="8" r="2.4" />
              <path d="M6 8.4v7.2M18 10.4c0 4.2-4.5 3.6-8.6 3.6" />
            </svg>
          </button>
          <span className="titlebar-divider" aria-hidden="true" />
          <button
            className="titlebar-icon-btn panel-toggle"
            title={rightPanelOpen ? 'Hide right panel (⌘⇧B)' : 'Show right panel (⌘⇧B)'}
            aria-label={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
            aria-keyshortcuts="Control+Shift+B Meta+Shift+B"
            aria-pressed={rightPanelOpen}
            onClick={() => useStore.getState().toggleRightPanel()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16" />
              <rect x="16.2" y="6.5" width="4.1" height="11" rx="1.2" fill="currentColor" stroke="none" opacity="0.55" className="panel-toggle-fill" />
            </svg>
          </button>
        </div>
      </header>

      <div className="app-body">
        <ErrorBoundary>
          <Sidebar />
          <main className="main">
            {/* No key={activeChatId}: a full remount re-parses every markdown +
              highlight block and re-runs all mount effects, which is the main
              cost of switching chats. ChatPanel already resets its per-chat
              state (input/draft/scroll/msgLimit) from the chat id, so keeping
              the instance mounted across switches is safe and instant. */}
            <ChatPanel />
          </main>
          {reviewOpen && <ReviewPanel />}
          {traceOpen && <TracePanel />}
          {codeMapPanelOpen && (
            <CodeMapPanel
              onJumpToFile={(path, line) => {
                // فعلاً: یه CustomEvent می‌فرستیم که هر listener (مثل editor آینده)
                // بتونه فایل رو در خط دلخواه باز کنه. این نقطه‌ی توسعه‌ست.
                window.dispatchEvent(
                  new CustomEvent('coder:open-file', { detail: { path, line } }),
                )
              }}
            />
          )}
          <RightPanel />
        </ErrorBoundary>
      </div>

      {settingsOpen && <SettingsModal onClose={() => useStore.getState().setSettingsOpen(false)} />}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
      <ScheduleInbox />
    </div>
  )
}