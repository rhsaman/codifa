/**
 * Bottom-docked terminal panel (Cmd/Ctrl+J).
 *
 * Each tab owns one pty session living in the Rust shell (src-tauri/src/pty.rs);
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
import { useViewerTabs } from '../lib/viewerTabs'
import { focusChatInput } from '../lib/chatFocus'
import { isApplePlatform } from '../lib/shortcuts'
import { suppressField } from '../lib/inputSuppress'
import { WebKitDeadKeyAddon } from '../lib/webkitDeadKey'

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

/** Cmd/Ctrl + one of these is an APP chord, never shell input (J = panel,
 *  W = close tab, M = fullscreen, X = prefix). Checked on `keypress` too —
 *  see the custom key handler in attachScreen. */
const RESERVED_TERMINAL_CHORDS = ['j', 'w', 'm', 'x']

function hasTerminalApi(): boolean {
  return typeof window !== 'undefined' && typeof window.coder?.terminalCreate === 'function'
}

function cwdBasename(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd || '~'
}

/** Map the app's active theme CSS variables onto the xterm palette so the
 *  terminal never looks bolted-on. Falls back to the Rose Pine defaults
 *  (DEFAULT_THEME) for the pre-hydration paint.
 *
 *  The ANSI slots below are deliberately spelled out instead of left to xterm:
 *  any slot the caller omits falls back to xterm's built-in Tango palette, whose
 *  greys are GREEN-TINTED (`#2e3436` for `black`, `#555753` for `brightBlack`).
 *  Both zsh-autosuggestions and zsh-syntax-highlighting paint their overlay text
 *  with `fg=8` (brightBlack), so an unset slot made every shell suggestion read
 *  as green instead of muted grey on these dark themes. Deriving the greys from
 *  the theme (`--bg-alt` / `--text-dim` / `--text`) fixes that, and mapping red /
 *  green / yellow onto `--danger` / `--success` / `--thinking` makes the
 *  terminal's git + ls output match the diff colours the app paints elsewhere. */
export function xtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  const bg = v('--bg-alt', '#21202e')
  const fg = v('--text', '#e0def4')
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: v('--accent-dim', '#403d52'),
    selectionForeground: fg,
    // Inactive selection (terminal unfocused): xterm's default is the same
    // bright selection colour at half opacity, which still reads as "selected"
    // — the theme's hover surface is the honest unfocused state.
    selectionInactiveBackground: v('--bg-hover', '#403d52'),
    // Scrollbar slider + overview-ruler border. Left unset, xterm derives the
    // slider from the FOREGROUND at 20/40/50% alpha, which ties the scrollbar
    // to the text colour instead of the theme's own structure colours. Only
    // plain CSS vars may be used here — xterm parses these as colour values and
    // cannot read a `color-mix()` expression.
    scrollbarSliderBackground: v('--border', '#524f67'),
    // Same var as `brightBlack` above, so it must carry the same fallback —
    // one CSS variable with two different fallbacks is how a palette drifts.
    scrollbarSliderHoverBackground: v('--text-dim', '#6e6a86'),
    scrollbarSliderActiveBackground: v('--text', '#e0def4'),
    overviewRulerBorder: v('--border', '#524f67'),
    // The whole 16-slot ANSI palette, every slot derived from the app theme, so
    // no xterm default leaks through and shell output matches the UI. Leaving a
    // slot out is not neutral: xterm falls back to its own GitHub-ish default
    // for that slot alone.
    //
    // `brightBlack` (slot 8) is the one that matters most here — it is what
    // zsh-autosuggestions asks for by default (`ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE
    // ='fg=8'`), so the inline suggestion renders as muted theme text rather
    // than the bright default grey. It only gets used this way once the pty has
    // a real TERM (see shell env in src-tauri/src/pty.rs); before that the shell
    // could not even resolve slot 8.
    black: bg,
    brightBlack: v('--text-dim', '#6e6a86'),
    red: v('--danger', '#eb6f92'),
    brightRed: v('--danger', '#eb6f92'),
    green: v('--success', '#3fb950'),
    brightGreen: v('--success', '#3fb950'),
    yellow: v('--thinking', '#f6c177'),
    brightYellow: v('--thinking', '#f6c177'),
    // Directories and prompt paths are the most common blue output; the app
    // already has a blue for links/paths, so reuse it instead of xterm's dull
    // `#3465a4`.
    blue: v('--link', '#4a9bc0'),
    brightBlue: v('--link', '#4a9bc0'),
    magenta: v('--accent', '#ebbcba'),
    brightMagenta: v('--accent', '#ebbcba'),
    // The app palette has no separate cyan tone, so cyan shares the success
    // colour rather than falling back to an unrelated xterm default.
    cyan: v('--success', '#3fb950'),
    brightCyan: v('--success', '#3fb950'),
    white: fg,
    brightWhite: fg,
  }
}

/** Viewport-space rectangle of the docked strip inside the side pane. */
export interface TerminalDockRect {
  left: number
  top: number
  width: number
  height: number
}

interface TerminalPanelProps {
  /** EFFECTIVE dock, decided by App (see resolveTerminalPlacement in the
   *  store): 'right' only while the side pane is really on screen. */
  placement?: 'bottom' | 'right'
  /** The pane strip the dock occupies, in viewport px. Only read when
   *  placement is 'right'; null makes the panel fall back to the bottom dock
   *  instead of painting at 0/0. */
  dock?: TerminalDockRect | null
  /** Ceiling for a drag inside the side pane (pane height minus the content
   *  that must stay visible). App owns the number because only App measures
   *  the pane. */
  maxDockHeight?: number
}

export function TerminalPanel({
  placement = 'bottom',
  dock = null,
  maxDockHeight,
}: TerminalPanelProps = {}) {
  const open = useStore((s) => s.terminalPanelOpen)
  const fullscreen = useStore((s) => s.terminalFullscreen)
  const theme = useStore((s) => s.theme)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Height lives in the STORE, not in local state: App reserves the very same
  // strip as padding on the side pane, so both sides must read one number.
  const height = useStore((s) => s.terminalHeight)

  const right = placement === 'right' && dock !== null

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
      // A bridge that RESOLVES null instead of rejecting (web build, a stub,
      // or a create that found no shell) must not push a null tab: the render
      // below reads `tab.id` and a null entry would crash the whole tree.
      if (!info || typeof info.id !== 'string') return
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
      // `?? []`: the bridge may RESOLVE null instead of rejecting (web build,
      // or a stubbed bridge), and `.catch` alone would let that null through to
      // `.filter` below.
      const live = (await window.coder.terminalList().catch(() => [])) ?? []
      if (cancelled) return
      const known = new Set(tabsRef.current.map((t) => t.id))
      // Same nullish-entry defence as spawnSession: only sessions carrying a
      // real id can become a tab (the render reads `tab.id`).
      const adopt = live.filter((s) => !!s && typeof s.id === 'string' && !known.has(s.id))
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

  // Full unmount (HMR, app teardown): dispose every xterm so no stale onData
  // handler keeps writing to live ptys after a remount adopts the sessions.
  useEffect(() => {
    return () => {
      for (const entry of entries.current.values()) entry.term.dispose()
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
  }, [right, open, activeId, scheduleFit, fitActive])

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
      // Side dock: the ceiling comes from App (pane height minus the content
      // that must stay visible), so a drag can never swallow the tabs and the
      // file tree above the dock. The bottom dock keeps the viewport cap.
      const max = maxDockHeight ?? window.innerHeight * 0.7
      const next = Math.min(max, dragRef.current.startH - (ev.clientY - dragRef.current.startY))
      // The store clamps to the minimum and persists; App reads the same value
      // back to reserve the strip, so the two sides never drift apart.
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
        entries.current.delete(tab.id)
      }
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
      // shell nor eats them: Cmd/Ctrl+J toggles the panel, Cmd/Ctrl+W closes
      // the active terminal tab (Cmd on Apple platforms, Ctrl elsewhere).
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
        // keydown alone still leaked ^J/^M/^X into the shell. `code` is
        // checked too so the chords survive non-Latin layouts.
        const physical = (ev.code || '').replace(/^Key/, '').toLowerCase()
        const pressed = (ev.key || '').toLowerCase()
        if (!RESERVED_TERMINAL_CHORDS.some((k) => pressed === k || physical === k)) {
          return true
        }
        ev.preventDefault()
        return false
      })
      entries.current.set(tab.id, { term, fit, el })
      scheduleFit()
    },
    [scheduleFit],
  )

  // Nothing before the first open — no shells spawn just because the app booted.
  if (!everOpenedRef.current && !open) return null

  const toggleLabel = isApplePlatform() ? '⌘J' : 'Ctrl+J'

  // Side dock: needs BOTH the effective placement and a measured strip —
  // without the strip the panel would paint at 0/0, so it falls back to the
  // bottom dock instead.
  //
  // The panel never changes its place in the React tree; `terminal-right` is
  // what moves it. Moving the element instead would unmount the xterm screens
  // and take every shell buffer with it.

  return (
    <section
      className={
        'terminal-panel' + (fullscreen ? ' terminal-full' : '') + (right ? ' terminal-right' : '')
      }
      data-open={open}
      data-fullscreen={fullscreen}
      data-placement={right ? 'right' : 'bottom'}
      dir="ltr"
      style={fullscreen ? undefined : right ? dock : { height }}
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
            className="terminal-action-btn terminal-move-btn"
            aria-label={right ? 'Move terminal to the bottom panel' : 'Move terminal to the side pane'}
            title={right ? 'Move to bottom panel' : 'Move to side pane'}
            aria-pressed={right}
            onClick={() => {
              const next = right ? 'bottom' : 'right'
              // Choosing the side pane implies wanting to see it, so reveal the
              // pane instead of parking the terminal back at the bottom.
              if (next === 'right') useViewerTabs.getState().setPaneOpen(true)
              useStore.getState().setTerminalPlacement(next)
            }}
          >
            {right ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v9m0 0-3.5-3.5M12 12l3.5-3.5M4 20h16" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="M15 4v16" />
              </svg>
            )}
          </button>
          <button
            className="terminal-action-btn"
            aria-label={right ? 'Hide terminal panel' : `Hide terminal panel (${toggleLabel})`}
            title={right ? 'Hide panel' : `Hide panel (${toggleLabel})`}
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
