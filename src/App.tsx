import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './lib/store'
import { ChatPanel } from './components/Chat'
import { Sidebar } from './components/Sidebar'
import { CodeMapPanel } from './components/CodeMapPanel'
import { SettingsModal } from './components/SettingsModal'
import { SearchOverlay } from './components/SearchOverlay'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PREFIX_KEY, physicalKey, PREFIX_SHORTCUTS } from './lib/shortcuts'
import { DEFAULT_THEME, THEMES } from './lib/themes'
import { UpdateButton } from './components/UpdateButton'
import { UsageChip } from './components/UsageChip'
import { fetchModels, invalidateSidecarCache } from './lib/api'
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
  // windows, per-model pricing, reasoning support) into the store. Without
  // this, dropdowns opened BEFORE the user clicks any provider show 0 models
  // (the picker used to wait for a click / dropdown-open to fetch), and the
  // local kind (ollama/llama.cpp/lmstudio) never auto-loads its model list
  // on app start.
  //
  // Runs ONCE per session (gated by `loaded` so it only fires after the
  // persisted providers are in the store). Parallel via `allSettled` so a
  // single unreachable provider (e.g. ollama not running) doesn't block the
  // rest. Custom-added and explicitly-removed entries are preserved via the
  // same merge rule the Settings modal uses. fetchModels already dedupes
  // in-flight requests by provider-config signature, so opening a dropdown
  // while this is still running will await the same promise rather than
  // refetching.
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
      if (!(e.metaKey || e.ctrlKey)) return
      const k = physicalKey(e)
      switch (k) {
        case 'b': {
          e.preventDefault()
          useStore.getState().toggleSidebar()
          break
        }
        case ',': {
          e.preventDefault()
          useStore.getState().setSettingsOpen(true)
          break
        }
        case 'p': {
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
          className="icon-btn"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          title={sidebarOpen ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)'}
          onClick={() => useStore.getState().toggleSidebar()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <span className="app-title">Codifa</span>
        <div id="titlebar-toolbar" />
        <UsageChip />
        <UpdateButton />
        <button
          className="workspace-btn"
          aria-label="Open workspace folder"
          title={activeChatRoot || 'No workspace open — pick a folder for this chat'}
          onClick={() => void window.coder.selectFolder().then((dir) => dir && openWorkspace(dir))}
        >
          📁 {activeChatRoot ? activeChatRoot.split('/').filter(Boolean).pop() : 'Open workspace'}
        </button>
      </header>

      <div className="app-body">
        <ErrorBoundary>
          <Sidebar />
          <main className="main">
            <ChatPanel key={activeChatId} />
          </main>
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
        </ErrorBoundary>
      </div>

      {settingsOpen && <SettingsModal onClose={() => useStore.getState().setSettingsOpen(false)} />}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </div>
  )
}