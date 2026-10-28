/**
 * One right-pane terminal TAB.
 *
 * Same pty backend as the bottom panel (src-tauri/src/pty.rs) but a SEPARATE
 * host: this tab owns its own session (src/lib/terminalSessions.ts), so the
 * bottom panel and the pane never share or steal each other's shells. Switching
 * away only unmounts the screen — the xterm buffer and the pty stay alive, so
 * coming back shows the same scrollback.
 *
 * `program`/`args` are what make this an editor tab as well: the viewer's
 * "Neovim here" target opens an `nvim +<line> <file>` tab instead of a shell.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { useViewerTabs, useViewerScope, visibleTabs } from '../lib/viewerTabs'
import { xtermTheme } from '../lib/xtermTheme'
import {
  attachTerminalScreen,
  fitTerminalSession,
  openTerminalSession,
  peekTerminalSession,
} from '../lib/terminalSessions'

interface TerminalTabPanelProps {
  /** Viewer tab id — the session KEY, so one tab maps to exactly one pty. */
  tabId: string
  cwd: string
  program: string
  args: string[]
  /** Shell for a program-less tab (Settings → Terminal). "" = the OS login
   *  shell, which the backend resolves itself. */
  shell?: string
  /** Bumped by the store each time this tab's target is re-opened. A program
   *  target uses it to respawn when its earlier pty already exited; re-focusing
   *  a dead nvim used to silently do nothing. */
  reopenSeq?: number
}

export function TerminalTabPanel({ tabId, cwd, program, args, shell, reopenSeq }: TerminalTabPanelProps) {
  const theme = useStore((s) => s.theme)
  // The strip lists EVERY terminal tab of the focused workspace, exactly like
  // the bottom panel's strip lists its shells: the rail is an icon strip, so a
  // terminal tab was only discoverable as a hover-labelled glyph. Same chips,
  // same +.
  const allTabs = useViewerTabs((s) => s.tabs)
  const activeId = useViewerTabs((s) => s.activeId)
  const scope = useViewerScope()
  const terminalTabs = visibleTabs(allTabs, scope).filter((t) => t.kind === 'terminal')
  const [error, setError] = useState<string | null>(null)
  const screenRef = useRef<HTMLDivElement | null>(null)

  // `args` is an array prop, so the effect keys off its joined VALUE: an inline
  // literal from the caller must not re-run the spawn on every render.
  const argsKey = args.join('\u0000')
  // Only a program target respawns on re-open; a shell tab's id never repeats,
  // so the bump must not re-run its spawn effect either.
  const openSeq = program ? (reopenSeq ?? 0) : 0

  // Create the pty once per tab id. A missing binary has to say so INSIDE the
  // tab — an empty pane with the reason only in the console reads as broken.
  //
  // The screen is attached by the effect BELOW, not here: this promise resolves
  // after an await, by which time the ref callback has already run and `
  // screenRef.current` only holds the element if the ref re-ran. Attaching from
  // inside `.then()` therefore missed the element, `entry.el` stayed null and
  // the fit was skipped — xterm never opened, the pane stayed blank and typing
  // went nowhere.
  //
  // `openSeq` re-runs this effect when the target is re-opened: a session whose
  // program exited is disposed and respawned FRESH (openTerminalSession replaces
  // it), while a LIVE session is kept as-is — the bump alone must never blank a
  // running nvim just because its pane was re-focused.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    // Flags reset only ahead of an actual (re)spawn: when the session is alive
    // the screen is already attached and setReady(false) would blank it.
    const alive = peekTerminalSession(tabId)
    if (!alive || alive.exited) {
      setError(null)
      setReady(false)
    }
    openTerminalSession(
      tabId,
      cwd,
      program || undefined,
      argsKey ? argsKey.split('\u0000') : [],
      program ? undefined : shell,
    )
      .then(() => {
        // Re-run the mount effect now that the session exists; it owns
        // attach + fit + focus so there is exactly one place doing them.
        if (!cancelled) setReady(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [tabId, cwd, program, argsKey, shell, openSeq])

  // Attach the xterm screen, fit it and focus it. Runs after mount AND again
  // once `ready` flips (the pty exists), because the session cannot exist during
  // the very first commit. This is also what keeps a hidden-then-shown tab
  // correctly sized: a tab that was hidden measures 0 until it comes back.
  useEffect(() => {
    const el = screenRef.current
    const entry = peekTerminalSession(tabId)
    if (!el || !entry) return
    attachTerminalScreen(entry, el)
    // Focus the pty so typing reaches the shell (see the top-panel host for the
    // same rule). Only after attach: a detached element cannot take focus.
    entry.term.focus()

    // Fit on the NEXT frame, not now: this effect runs in the same tick the
    // screen element was inserted, and xterm measures 0 width until the browser
    // has laid the box out — a fit against 0 is silently skipped, so the grid
    // never reaches the pty and the canvas paints nothing.
    let raf = requestAnimationFrame(() => {
      const cur = peekTerminalSession(tabId)
      if (cur) fitTerminalSession(cur)
    })
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf)
    const ro = new ResizeObserver(() => {
      const cur = peekTerminalSession(tabId)
      if (cur) fitTerminalSession(cur)
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [tabId, ready])

  // Re-paint the screen when the app theme changes: the pty is untouched, only
  // the palette moves (same rule as the bottom panel).
  useEffect(() => {
    const entry = peekTerminalSession(tabId)
    if (entry) entry.term.options.theme = xtermTheme()
  }, [theme, tabId])

  return (
    <div className="terminal-tab-panel">
      <div className="terminal-tabbar">
        <span className="terminal-title">Terminal</span>
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {terminalTabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              tabIndex={-1}
              className={'terminal-tab' + (t.id === activeId ? ' terminal-tab-active' : '')}
              title={t.title}
              onClick={() => useViewerTabs.getState().setActiveViewer(t.id)}
            >
              <span className="terminal-tab-shell">{(t.title || '').split('/').pop() || t.title}</span>
              <button
                className="terminal-tab-close"
                aria-label={`Close ${t.title}`}
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  useViewerTabs.getState().closeViewer(t.id)
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
            data-terminal-new="1"
            onClick={() => {
              // An ordinary right-pane TAB with its own pty (like the bottom
              // panel's +): the bottom panel and the pane stay separate hosts.
              const app = useStore.getState()
              useViewerTabs.getState().openTerminal({
                cwd: app.root,
                shell,
                fresh: true,
              })
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
      {/* The screen must sit in its own relative BODY (exactly like the bottom
          panel's .terminal-body): .terminal-screen is position:absolute, so
          directly under the panel it would stretch over the strip above and
          paint OVER it — the strip appeared for one frame and vanished. */}
      <div className="terminal-body">
        <div
          className="terminal-screen"
          /* One terminal tab is mounted at a time, so its screen is always the
             active one (the shared rule hides inactive screens). */
          data-active="true"
          ref={(el) => {
            screenRef.current = el
            const entry = peekTerminalSession(tabId)
            if (entry) attachTerminalScreen(entry, el)
          }}
          aria-label="Terminal"
        />
        {error ? (
          <div className="terminal-tab-error" role="alert">
            <strong>{program || 'shell'}: </strong>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
