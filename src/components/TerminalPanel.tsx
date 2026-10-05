/**
 * Bottom-docked terminal panel (Cmd/Ctrl+J).
 *
 * Each tab owns one node-pty session living in the Electron main process;
 * this component only renders xterm.js screens and shuttles I/O over IPC.
 * Sessions outlive the panel being hidden (like VSCode) — the panel merely
 * toggles `display`, and the last tab closing hides the whole panel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../lib/store'
import { focusChatInput } from '../lib/chatFocus'
import { isApplePlatform } from '../lib/shortcuts'

interface TerminalTab {
  id: string
  shell: string
  cwd: string
}

interface XtermEntry {
  term: Terminal
  fit: FitAddon
  el: HTMLElement | null
}

const HEIGHT_KEY = 'coder:terminalHeight'
const MIN_HEIGHT = 140
const DEFAULT_HEIGHT = 300

function loadTerminalHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT
  } catch {
    return DEFAULT_HEIGHT
  }
}

function persistTerminalHeight(px: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(px)))
  } catch {
    /* storage unavailable */
  }
}

function hasTerminalApi(): boolean {
  return typeof window !== 'undefined' && typeof window.coder?.terminalCreate === 'function'
}

function cwdBasename(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd || '~'
}

/** Map the app's active theme CSS variables onto the xterm palette so the
 *  terminal never looks bolted-on. Falls back to the Catppuccin defaults. */
function xtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    background: v('--bg-alt', '#181825'),
    foreground: v('--text', '#cdd6f4'),
    cursor: v('--text', '#cdd6f4'),
    cursorAccent: v('--bg-alt', '#181825'),
    selectionBackground: v('--accent-dim', '#45475a'),
    selectionForeground: v('--text', '#cdd6f4'),
  }
}

export function TerminalPanel() {
  const open = useStore((s) => s.terminalPanelOpen)
  const theme = useStore((s) => s.theme)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [height, setHeight] = useState(loadTerminalHeight)

  // Once the panel has been opened in this session it stays mounted (hidden
  // via CSS) so the xterm buffers and the shells behind it survive toggling.
  // Before the very first open there is nothing to keep alive — render null
  // so no shells spawn just because the app booted. A ref (not state) keeps
  // the first open paint instant: `open` alone already unblocks the render.
  const everOpenedRef = useRef(false)
  const bootstrappedRef = useRef(false)

  const entries = useRef(new Map<string, XtermEntry>())
  const screens = useRef(new Map<string, HTMLElement | null>())
  const tabsRef = useRef<TerminalTab[]>([])
  tabsRef.current = tabs
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const fitRaf = useRef<number | null>(null)

  // Chat that was focused before the terminal opened; closing the panel
  // returns the caret to its composer input.
  const preTerminalChatRef = useRef<string | null>(null)
  useEffect(() => {
    if (open) {
      preTerminalChatRef.current = useStore.getState().activeChatId || null
      return
    }
    // Only restore when the panel was actually open before; otherwise this
    // effect would steal focus on first mount (open starts false).
    const id = preTerminalChatRef.current
    preTerminalChatRef.current = null
    if (!id) return
    const st = useStore.getState()
    if (!st.chats.some((c) => c.id === id)) return
    if (st.activeChatId !== id) st.focusWindow(id)
    requestAnimationFrame(() => focusChatInput(id))
  }, [open])

  const supported = hasTerminalApi()

  /** Fit + push the new cols/rows to the pty. Skips while hidden (0 size). */
  const fitActive = useCallback((id: string | null) => {
    if (!id) return
    const entry = entries.current.get(id)
    const el = entry?.el
    if (!entry || !el) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 40) return
    try {
      entry.fit.fit() // fires term.onResize → terminal:resize IPC
    } catch {
      /* fit before open() completed */
    }
  }, [])

  const scheduleFit = useCallback(() => {
    if (fitRaf.current !== null) cancelAnimationFrame(fitRaf.current)
    fitRaf.current = requestAnimationFrame(() => {
      fitRaf.current = null
      fitActive(activeId)
    })
  }, [activeId, fitActive])

  const spawnSession = useCallback(async (cwd?: string) => {
    if (!hasTerminalApi()) return
    // Default to the focused chat's workspace, resolved at call time — a
    // workspace switched while the panel was open must still apply to the
    // next new shell. Empty root falls back to home in the main process.
    const dir =
      cwd ??
      useStore.getState().chats.find((c) => c.id === useStore.getState().activeChatId)?.root ??
      useStore.getState().root ??
      ''
    try {
      const info = await window.coder.terminalCreate(dir || '')
      setTabs((prev) => [...prev, info])
      setActiveId(info.id)
    } catch (err) {
      console.error('[terminal] spawn failed:', err)
    }
  }, [])

  // Adopt sessions from a previous renderer (dev reload) on first open, or
  // spawn the initial shell in the current workspace.
  useEffect(() => {
    if (!open || bootstrappedRef.current) return
    bootstrappedRef.current = true
    everOpenedRef.current = true
    if (!hasTerminalApi()) return
    let cancelled = false
    void (async () => {
      const live = await window.coder.terminalList().catch(() => [])
      if (cancelled) return
      const known = new Set(tabsRef.current.map((t) => t.id))
      const adopt = live.filter((s) => !known.has(s.id))
      if (adopt.length > 0) {
        setTabs((prev) => [...prev, ...adopt])
        setActiveId((cur) => cur ?? adopt[0].id)
      } else if (tabsRef.current.length === 0) {
        await spawnSession()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, spawnSession])

  // pty output → the matching xterm; exit → drop the tab (and hide the panel
  // when the last one dies, like VSCode).
  useEffect(() => {
    if (!supported) return
    const offData = window.coder.onTerminalData((id, data) => {
      entries.current.get(id)?.term.write(data)
    })
    const offExit = window.coder.onTerminalExit((id) => {
      const entry = entries.current.get(id)
      if (entry) {
        entry.term.dispose()
        entries.current.delete(id)
        screens.current.delete(id)
      }
      const next = tabsRef.current.filter((t) => t.id !== id)
      tabsRef.current = next
      setTabs(next)
      setActiveId((cur) => (cur === id || !next.some((t) => t.id === cur)) ? (next[next.length - 1]?.id ?? null) : cur)
      if (next.length === 0) useStore.getState().setTerminalPanelOpen(false)
    })
    return () => {
      offData()
      offExit()
    }
  }, [supported])

  // Re-paint the xterm palette when the app theme changes.
  useEffect(() => {
    const t = xtermTheme()
    for (const entry of entries.current.values()) entry.term.options.theme = t
  }, [theme])

  // Open/close is a CSS toggle (sessions keep running while hidden); on open
  // the geometry changed while display:none, so refit and hand over focus.
  useEffect(() => {
    if (!open || !activeId) return
    scheduleFit()
    const t = window.setTimeout(() => {
      fitActive(activeId)
      entries.current.get(activeId)?.term.focus()
    }, 50)
    return () => window.clearTimeout(t)
  }, [open, activeId, scheduleFit, fitActive])

  // Panel geometry changes (window resize, height drag) → refit.
  useEffect(() => {
    const el = bodyRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => scheduleFit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [scheduleFit])

  useEffect(() => {
    const onResize = () => scheduleFit()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [scheduleFit])

  const activate = useCallback(
    (id: string) => {
      setActiveId(id)
      scheduleFit()
      window.setTimeout(() => entries.current.get(id)?.term.focus(), 0)
    },
    [scheduleFit],
  )

  const closeSession = useCallback((id: string) => {
    const entry = entries.current.get(id)
    if (entry) {
      entry.term.dispose()
      entries.current.delete(id)
      screens.current.delete(id)
    }
    const next = tabsRef.current.filter((t) => t.id !== id)
    tabsRef.current = next
    setTabs(next)
    setActiveId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur))
    void window.coder.terminalKill(id).catch(() => {})
    if (next.length === 0) useStore.getState().setTerminalPanelOpen(false)
  }, [])

  const newSession = useCallback(() => {
    useStore.getState().setTerminalPanelOpen(true)
    void spawnSession()
  }, [spawnSession])

  // Cmd/Ctrl+W (routed from App.tsx while the terminal has focus) closes the
  // active terminal tab — closing the last one also hides the panel.
  useEffect(() => {
    const onCloseTab = () => {
      if (activeIdRef.current) closeSession(activeIdRef.current)
    }
    window.addEventListener('coder:close-terminal-tab', onCloseTab)
    return () => window.removeEventListener('coder:close-terminal-tab', onCloseTab)
  }, [closeSession])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const max = window.innerHeight * 0.7
      const next = Math.min(max, Math.max(MIN_HEIGHT, dragRef.current.startH - (ev.clientY - dragRef.current.startY)))
      setHeight(next)
      persistTerminalHeight(next)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Attach an xterm to a freshly-mounted screen div. The ref callback runs
  // again with null on unmount — the xterm entry survives that (the div comes
  // back on the next render); it is disposed explicitly in closeSession/exit.
  const attachScreen = useCallback(
    (tab: TerminalTab, el: HTMLDivElement | null) => {
      screens.current.set(tab.id, el)
      if (!el) return
      if (entries.current.has(tab.id)) return
      if (!hasTerminalApi()) return
      const term = new Terminal({
        fontSize: 12.5,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace",
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 4000,
        convertEol: false,
        theme: xtermTheme(),
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.open(el)
      term.onData((data) => {
        void window.coder.terminalWrite(tab.id, data)
      })
      term.onResize(({ cols, rows }) => {
        void window.coder.terminalResize(tab.id, cols, rows)
      })
      // Reserved chords must reach the window-level handler even while the
      // terminal has focus — return false so xterm neither sends them to the
      // shell nor eats them: Cmd/Ctrl+J toggles the panel, Cmd/Ctrl+W closes
      // the active terminal tab (Cmd on Apple platforms, Ctrl elsewhere).
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown' || ev.altKey || ev.shiftKey) return true
        const apple = isApplePlatform()
        const reserved = apple ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey
        if (reserved && (ev.key === 'j' || ev.code === 'KeyJ' || ev.key === 'w' || ev.code === 'KeyW')) return false
        return true
      })
      entries.current.set(tab.id, { term, fit, el })
      scheduleFit()
    },
    [scheduleFit],
  )

  // Nothing before the first open — no shells spawn just because the app booted.
  if (!everOpenedRef.current && !open) return null

  const toggleLabel = isApplePlatform() ? '⌘J' : 'Ctrl+J'

  return (
    <section className="terminal-panel" data-open={open} dir="ltr" style={{ height }} aria-label="Terminal">
      <div className="terminal-resize-handle" title="Drag to resize" onMouseDown={startResize} />
      <header className="terminal-tabbar">
        <span className="terminal-title">Terminal</span>
        <div className="terminal-tabs" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId}
              tabIndex={-1}
              className={
                'terminal-tab' + (tab.id === activeId ? ' terminal-tab-active' : '')
              }
              onClick={() => activate(tab.id)}
            >
              <span className="terminal-tab-shell">{tab.shell}</span>
              <span className="terminal-tab-cwd">{cwdBasename(tab.cwd)}</span>
              <button
                className="terminal-tab-close"
                aria-label={`Close ${tab.shell} terminal`}
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  closeSession(tab.id)
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <button
            className="terminal-action-btn"
            aria-label="New terminal"
            title="New terminal"
            onClick={newSession}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            className="terminal-action-btn"
            aria-label={`Hide terminal panel (${toggleLabel})`}
            title={`Hide panel (${toggleLabel})`}
            onClick={() => useStore.getState().setTerminalPanelOpen(false)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>
      <div className="terminal-body" ref={bodyRef}>
        {!supported ? (
          <div className="terminal-unsupported">
            The terminal panel needs the desktop app (Electron). In the browser build, use your
            system terminal instead.
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="terminal-screen" 
              data-active={tab.id === activeId}
              ref={(el) => attachScreen(tab, el)}
            />
          ))
        )}
      </div>
    </section>
  )
}
