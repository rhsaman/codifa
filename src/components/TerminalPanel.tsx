/**
 * Bottom-docked terminal panel (Ctrl+X then J).
 *
 * Each tab owns one pty session living in the Rust shell (src-tauri/src/pty.rs);
 * this component only renders xterm.js screens and shuttles I/O over IPC.
 * Sessions outlive the panel being hidden (like VSCode) — the panel merely
 * toggles `display`, and the last tab closing hides the whole panel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../lib/store'
import { focusChatInput } from '../lib/chatFocus'
import { suppressField } from '../lib/inputSuppress'
import { WebKitDeadKeyAddon } from '../lib/webkitDeadKey'
import { findOpenRunTarget } from '../lib/nvimEdit'
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, registerTerminalScreen, xtermTheme } from '../lib/xtermTheme'
import { isReservedTerminalChord } from '../lib/terminalKeys'
import { ownedPtyIds } from '../lib/terminalSessions'

interface TerminalTab {
  id: string
  shell: string
  cwd: string
  /** Command line for the tab tooltip (`nvim +42 /w/a.ts`). */
  program?: string
  /** The REQUESTED argv of a run target (`["nvim","+42","/w/a.ts"]`), kept for
   *  reuse: the backend reports the RESOLVED command line (absolute path, joined
   *  with spaces), which cannot be matched against a fresh request. */
  argv?: string[]
}

interface XtermEntry {
  term: Terminal
  fit: FitAddon
  el: HTMLElement | null
  /** Detaches this screen from the live-font registry (Settings → Appearance). */
  offFont: () => void
}

/** Cmd/Ctrl + one of the reserved chords is an APP chord, never shell input —
 *  the shared guard lives in src/lib/terminalKeys.ts so the bottom panel and the
 *  right-pane terminal tabs cannot drift apart. */

function hasTerminalApi(): boolean {
  return typeof window !== 'undefined' && typeof window.coder?.terminalCreate === 'function'
}

/** Does a freshly opened panel owe the user a login shell? Only when it has no
 *  tab at all: a panel that adopted surviving ptys must not start a second
 *  shell. Pure, for tests. */
export function shouldSpawnShell(tabCount: number): boolean {
  return tabCount === 0
}

function cwdBasename(cwd: string | undefined): string {
  // A session with no cwd (an older backend reply, a stub) must not crash the
  // whole tree: `undefined.replace` threw and unmounted the app.
  const parts = (cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd || '~'
}

export function TerminalPanel() {
  const open = useStore((s) => s.terminalPanelOpen)
  const fullscreen = useStore((s) => s.terminalFullscreen)
  const theme = useStore((s) => s.theme)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Height lives in the store (persisted) so a fresh render restores the size.
  const height = useStore((s) => s.terminalHeight)
  // Reason a program could not be started. Shown in the panel instead of
  // failing silently.
  const [spawnError, setSpawnError] = useState<string | null>(null)

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

  // A `coder:focus-terminal` request asks the panel to take the caret: the
  // panel is opened by the caller, this only focuses the ACTIVE session's
  // xterm, which is where typing has to land.
  useEffect(() => {
    const onFocusRequest = () => {
      const id = activeIdRef.current
      const term = id ? entries.current.get(id)?.term : null
      term?.focus()
    }
    window.addEventListener('coder:focus-terminal', onFocusRequest)
    return () => window.removeEventListener('coder:focus-terminal', onFocusRequest)
  }, [])

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
      // FitAddon + ResizeObserver can oscillate: a fit toggles the scrollbar,
      // which changes the body size, which schedules another fit — and every
      // fit pushes a resize to the pty, so the shell redraws its prompt line
      // over and over (the "extra characters appear by themselves" bug).
      // Only fit when the proposed geometry actually differs.
      const proposed = entry.fit.proposeDimensions()
      if (!proposed) return
      if (proposed.cols === entry.term.cols && proposed.rows === entry.term.rows) return
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

  const spawnSession = useCallback(async (cwd?: string, program?: string, args?: string[]) => {
    if (!hasTerminalApi()) return
    // Reuse a run target that is already open instead of starting a second one.
    // A run target can be heavy — the user's own Neovim with its LSP plugins
    // measured ~600 MB for ONE instance — so asking for the same file again must
    // focus that editor rather than pay for another whole process tree.
    if (program) {
      const open = findOpenRunTarget(tabsRef.current, [program, ...(args ?? [])])
      if (open) {
        setSpawnError(null)
        setActiveId(open.id)
        return
      }
    }
    // Default to the focused chat's workspace, resolved at call time — a
    // workspace switched while the panel was open must still apply to the
    // next new shell. Empty root falls back to home in the main process.
    const dir =
      cwd ??
      useStore.getState().chats.find((c) => c.id === useStore.getState().activeChatId)?.root ??
      useStore.getState().root ??
      ''
    try {
      const requested = program ? [program, ...(args ?? [])] : undefined
      const info = await window.coder.terminalCreate(dir || '', program, args)
      // A bridge that RESOLVES null instead of rejecting (web build, a stub,
      // or a create that found no shell) must not push a null tab: the render
      // below reads `tab.id` and a null entry would crash the whole tree.
      if (!info || typeof info.id !== 'string') return
      setTabs((prev) => [...prev, requested ? { ...info, argv: requested } : info])
      setActiveId(info.id)
      setSpawnError(null)
    } catch (err) {
      console.error('[terminal] spawn failed:', err)
      // A requested program (in-app nvim) that the backend could not start
      // would otherwise leave the panel open and empty with the reason only in
      // the console — the user asked for an editor and got nothing.
      if (program) setSpawnError(err instanceof Error ? err.message : String(err))
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
      // `?? []`: the bridge may RESOLVE null instead of rejecting (web build,
      // or a stubbed bridge), and `.catch` alone would let that null through to
      // `.filter` below.
      const live = (await window.coder.terminalList().catch(() => [])) ?? []
      if (cancelled) return
      const known = new Set(tabsRef.current.map((t) => t.id))
      // RIGHT-PANE sessions are NOT ours to adopt: `terminalList` returns every
      // backend pty, and adopting the pane's nvim duplicated it as a chip here
      // (and let closing this panel kill the in-app editor). Marked ids stay
      // with their own host.
      const paneOwned = ownedPtyIds()
      // Same nullish-entry defence as spawnSession: only sessions carrying a
      // real id can become a tab (the render reads `tab.id`).
      const adopt = live.filter((s) => !!s && typeof s.id === 'string' && !known.has(s.id) && !paneOwned.has(s.id))
      if (adopt.length > 0) {
        setTabs((prev) => [...prev, ...adopt])
        setActiveId((cur) => cur ?? adopt[0].id)
      } else if (shouldSpawnShell(tabsRef.current.length)) {
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
        entry.offFont()
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

  // Full unmount (HMR, app teardown): dispose every xterm so no stale onData
  // handler keeps writing to live ptys after a remount adopts the sessions.
  useEffect(() => {
    return () => {
      for (const entry of entries.current.values()) {
        entry.offFont()
        entry.term.dispose()
      }
      entries.current.clear()
      screens.current.clear()
    }
  }, [])

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

  // Dock switch (bottom panel <-> side pane) repaints the box; refit so the pty
  // adopts the new grid instead of keeping the old cols/rows.
  useEffect(() => {
    if (!open) return
    scheduleFit()
    const t = window.setTimeout(() => fitActive(activeId), 50)
    return () => window.clearTimeout(t)
  }, [open, activeId, scheduleFit, fitActive])

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
      entry.offFont()
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


  // Fullscreen toggle changes geometry while sessions keep running — refit
  // the active screen so the pty adopts the new size.
  useEffect(() => {
    if (!open || !fullscreen) return
    scheduleFit()
    const t = window.setTimeout(() => fitActive(activeId), 50)
    return () => window.clearTimeout(t)
  }, [fullscreen, open, activeId, scheduleFit, fitActive])

  // Escape exits terminal fullscreen (focus stays in the terminal).
  useEffect(() => {
    if (!open || !fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().setTerminalFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, fullscreen])

  const startResize = (e: React.MouseEvent) => {
    if (useStore.getState().terminalFullscreen) return
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const max = window.innerHeight * 0.7
      const next = Math.min(max, dragRef.current.startH - (ev.clientY - dragRef.current.startY))
      // The store clamps to the minimum and persists it.
      useStore.getState().setTerminalHeight(next)
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
      const existing = entries.current.get(tab.id)
      if (existing) {
        if (existing.el === el) return
        // The screen div was remounted (StrictMode double-mount, HMR, layout
        // switch): the old xterm is bound to a detached element but its onData
        // handler is still live — two handlers would write every keystroke to
        // the pty twice (duplicated typing). Dispose the stale instance and
        // rebuild on the new element.
        existing.term.dispose()
        existing.offFont()
        entries.current.delete(tab.id)
      }
      if (!hasTerminalApi()) return
      const term = new Terminal({
        // Live size from Settings → Appearance (same setting the right-pane
        // terminal tabs read, so both hosts stay in step).
        fontSize: useStore.getState().terminalFontSize || TERMINAL_FONT_SIZE,
        // Shared stack: the two terminal hosts must render identically.
        fontFamily: TERMINAL_FONT_FAMILY,
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
      // xterm's hidden input ships `autocorrect`/`autocapitalize`/`spellcheck`
      // off but NOT `autocomplete`, so macOS still offers autofill and inline
      // predictions over the terminal. Stamp it like every other text field
      // (no-op while the setting is switched off in Settings → General).
      suppressField(term.textarea)
      // WKWebView dead-key repair (see src/lib/webkitDeadKey.ts): inside the
      // Tauri webview a dead key duplicates the committed char and swallows
      // the next key, which reads as "extra characters appearing by
      // themselves". Loaded AFTER open() because it binds to the hidden
      // textarea xterm creates there; term.dispose() tears it down again.
      const deadKey = new WebKitDeadKeyAddon((data) => {
        void window.coder.terminalWrite(tab.id, data)
      })
      term.loadAddon(deadKey)
      term.onData((data) => {
        void window.coder.terminalWrite(tab.id, data)
      })
      let lastCols = -1
      let lastRows = -1
      term.onResize(({ cols, rows }) => {
        // Fit-loop guard: a scrollbar appearing/disappearing oscillates the fit
        // size; re-sending an unchanged size makes zsh redraw the prompt line
        // mid-typing (looked like extra characters appearing while typing).
        if (cols === lastCols && rows === lastRows) return
        lastCols = cols
        lastRows = rows
        void window.coder.terminalResize(tab.id, cols, rows)
      })
      // Reserved chords must reach the window-level handler even while the
      // terminal has focus — return false so xterm neither sends them to the
      // shell nor eats them: Cmd+W (Ctrl+W on other platforms) closes the
      // active terminal tab, while the chord's OTHER half (bare Ctrl+W on
      // Apple) stays ordinary shell input (^W delete-previous-word). The panel
      // toggle (Ctrl+X J) is
      // consumed by the window handler, which also stops the second key so
      // the `j` never reaches this xterm.
      term.attachCustomKeyEventHandler((ev) => {
        // `keyup` only clears xterm's own `_keyDownSeen`/`_keyPressHandled`
        // bookkeeping — never suppress it here.
        if (ev.type === 'keyup') return true
        // WebKit dead-key repair FIRST: it has to see `keypress` as well (that
        // is where xterm re-emits the committed dead char), and the chord
        // guard below would skip those events. Returning false suppresses
        // xterm for this event; the rescued character was already sent.
        if (deadKey.repair.handle(ev)) return false
        if (ev.altKey || ev.shiftKey) return true
        const chord = (ev.metaKey && !ev.ctrlKey) || (ev.ctrlKey && !ev.metaKey)
        if (!chord) return true
        // Reserve BOTH Cmd and Ctrl (each without the other) for the app's
        // chords on EVERY platform: Ctrl+M/Ctrl+J typed into the shell sent
        // ^M (Enter — ran the half-typed line!) and ^J, which read as "extra
        // characters while typing". They must bubble to the window-level
        // handler instead. Ctrl+X arms the app's prefix chord (X then J
        // toggles the panel) instead of sending ^X to the shell.
        //
        // This covers `keypress` as well as `keydown`: xterm's `_keyPress`
        // emits the chord character from `charCode` on its own, so gating on
        // keydown alone still leaked ^J/^M/^X into the shell. `code` is checked
        // too so the chords survive non-Latin layouts.
        if (!isReservedTerminalChord(ev)) return true
        ev.preventDefault()
        return false
      })
      entries.current.set(tab.id, {
        term,
        fit,
        el,
        offFont: registerTerminalScreen({ term, refit: () => fitActive(tab.id) }),
      })
      scheduleFit()
    },
    [scheduleFit],
  )

  // Nothing before the first open — no shells spawn just because the app booted.
  if (!everOpenedRef.current && !open) return null

  const toggleLabel = 'Ctrl+X J'

  return (
    <section
      className={'terminal-panel' + (fullscreen ? ' terminal-full' : '')}
      data-open={open}
      data-fullscreen={fullscreen}
      dir="ltr"
      style={fullscreen ? undefined : { height }}
      aria-label="Terminal"
    >
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
              title={tab.program}
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
            aria-label={fullscreen ? 'Exit terminal fullscreen (Ctrl+M)' : 'Fullscreen terminal (Ctrl+M)'}
            title={fullscreen ? 'Exit terminal fullscreen (Ctrl+M)' : 'Fullscreen terminal (Ctrl+M)'}
            aria-pressed={fullscreen}
            onClick={() => useStore.getState().toggleTerminalFullscreen()}
          >
            {fullscreen ? (
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.5 1.5v3.5h-3M4.5 1.5 1.6 4.4M7.5 10.5V7h3M7.5 10.5l2.9-2.9" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 1.5h3.5V5M10.5 1.5 7 5M5 10.5H1.5V7M1.5 10.5 5 7" />
              </svg>
            )}
          </button>
          <button
            className="terminal-action-btn"
            aria-label="Hide terminal panel"
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
            The terminal panel needs the desktop app. In the browser build, use your
            system terminal instead.
          </div>
        ) : (
          <>
            {spawnError && (
              <div className="terminal-spawn-error" role="alert">
                {spawnError}
              </div>
            )}
            {tabs.map((tab) => (
            <div
              key={tab.id}
              className="terminal-screen" 
              data-active={tab.id === activeId}
              ref={(el) => attachScreen(tab, el)}
            />
            ))}
          </>
        )}
      </div>
    </section>
  )
}
