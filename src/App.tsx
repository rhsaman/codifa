import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './lib/store'
import { ChatPanel } from './components/Chat'
import { Sidebar } from './components/Sidebar'
import { SettingsModal } from './components/SettingsModal'
import { SearchOverlay } from './components/SearchOverlay'
import { DownloadModelGate } from './components/DownloadModelGate'
import { LoadingScreen } from './components/LoadingScreen'
import { getModelsStatus } from './lib/api'
import { PREFIX_KEY, physicalKey, PREFIX_SHORTCUTS } from './lib/shortcuts'
import { DEFAULT_THEME, THEMES } from './lib/themes'
import { UpdateButton } from './components/UpdateButton'

export default function App() {
  const loaded = useStore((s) => s.loaded)
  const load = useStore((s) => s.load)
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  )
  const activeChatId = useStore((s) => s.activeChatId)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const [searchOpen, setSearchOpen] = useState(false)
  const [embeddingGate, setEmbeddingGate] = useState<'unknown' | 'ready' | 'missing'>('unknown')
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

  // First-run "download essential model" gate: RAG memory and skill
  // auto-selection need the on-device embedding model. Until a ready
  // embedding build exists, the app is fully blocked behind a download
  // page. Re-checks every few seconds so it clears automatically the
  // moment a download finishes (and never appears once one is installed).
  // A transient fetch failure stays 'unknown' and retries; after a few
  // failures it falls through to the app so a sidecar hiccup never traps
  // the user (the gate reappears on the next launch).
  useEffect(() => {
    if (!loaded || embeddingGate === 'ready') return
    let cancelled = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = () => {
      getModelsStatus()
        .then((st) => {
          if (cancelled) return
          const ready = (st.embedding?.dirs ?? []).some((d) => d.ready)
          setEmbeddingGate(ready ? 'ready' : 'missing')
        })
        .catch(() => {
          failures++
          if (failures > 3) {
            setEmbeddingGate('ready')
            return
          }
          timer = setTimeout(check, 2500)
        })
    }
    check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [loaded, embeddingGate])

  const recheckEmbedding = () => setEmbeddingGate('unknown')

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
          void window.coder.selectFolder().then((dir) => dir && openWorkspace(dir))
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

  if (!loaded || embeddingGate === 'unknown') {
    return <LoadingScreen />
  }

  if (embeddingGate === 'missing') {
    return <DownloadModelGate onReady={recheckEmbedding} />
  }

  return (
    <div className="app">
      <div className="titlebar">
        <button
          className="icon-btn"
          title={sidebarOpen ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)'}
          onClick={() => useStore.getState().toggleSidebar()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <span className="app-title">Codifa</span>
        <div id="titlebar-toolbar" />
        <UpdateButton />
        <button
          className="workspace-btn"
          title={activeChatRoot || 'No workspace open — pick a folder for this chat'}
          onClick={() => void window.coder.selectFolder().then((dir) => dir && openWorkspace(dir))}
        >
          📁 {activeChatRoot ? activeChatRoot.split('/').filter(Boolean).pop() : 'Open workspace'}
        </button>
      </div>

      <div className="app-body">
        <Sidebar />
        <main className="main">
          <ChatPanel key={activeChatId} />
        </main>
      </div>

      {settingsOpen && <SettingsModal onClose={() => useStore.getState().setSettingsOpen(false)} />}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </div>
  )
}