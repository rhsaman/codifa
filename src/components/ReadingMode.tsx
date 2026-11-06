import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatBubble } from './ChatBubble'
import type { ChatMessage } from '../types'
import { splitSections } from '../lib/sections'
import { APP_DIR, useStore } from '../lib/store'
import { detectDir } from '../lib/bidi'
import { physicalKey } from '../lib/shortcuts'
import 'highlight.js/styles/github-dark.min.css'

/** Chevron-up for the previous-section nav button. */
const ChevronUpIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m18 15-6-6-6 6" />
  </svg>
)

/** Chevron-down for the next-section nav button. */
const ChevronDownIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
)

/**
 * Reading mode — a centered floating panel (like Claude Code's docs viewer)
 * for a long agent answer: the contents list on the side, the selected
 * section's full content in a centered reading column like the chat's. The
 * chat stays visible behind it — a soft scrim focuses the panel without
 * fully blocking the conversation.
 */
export function ReadingMode({
  message,
  onClose,
}: {
  message: ChatMessage
  onClose: () => void
}) {
  // App-wide direction (RTL/LTR toggle). The panel mirrors like the main
  // messages do: in RTL the contents list moves to the right side and the
  // header/footer flow right-to-left. The section content follows the app
  // direction too (dir={dir}), so in RTL mode the text reads right-to-left
  // like the main messages.
  const dir = APP_DIR;
  const sections = useMemo(() => splitSections(message.content), [message.content])
  const [active, setActive] = useState(0)
  const [progress, setProgress] = useState(0)
  // Panel width — opens at half the viewport, then user-resizable by dragging
  // the left edge (VSCode-style, like the sidebar). The dragged width is
  // persisted locally (same pattern as coder:sidebarWidth) so the panel
  // reopens at the last used size.
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') return 720
    const max = window.innerWidth - 24
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem('coder:readingWidth') ?? '', 10)
      } catch {
        return NaN
      }
    })()
    const n = Number.isFinite(saved) ? saved : Math.round(window.innerWidth / 2) - 12
    return Math.max(320, Math.min(max, n))
  })
  // Keep the panel inside the viewport when the window is resized (e.g. the
  // app is moved from a large monitor to a small one while the panel is open).
  // The saved width is left untouched — it only clamps for the current window.
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const contentRef = useRef<HTMLDivElement>(null)

  // Esc closes the panel; ↑/↓ jump between sections.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowDown' || ((e.ctrlKey || e.metaKey) && physicalKey(e) === 'j'))
        setActive((a) => Math.min(a + 1, sections.length - 1))
      else if (e.key === 'ArrowUp' || ((e.ctrlKey || e.metaKey) && physicalKey(e) === 'k'))
        setActive((a) => Math.max(a - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, sections.length])

  // Jump to the top of the newly selected section.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [active])

  // Track reading progress through the current section.
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight
      setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [active])

  const section = sections[active]
  if (!section) return null

  // Track the per-drag listeners so we can clean them up if the component
  // unmounts mid-drag (e.g. user pressed Esc to close the panel while still
  // holding the resize handle — without this, the listeners would leak on
  // `window` and keep firing against a torn-down state).
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => {
      dragCleanup.current?.()
      dragCleanup.current = null
    }
  }, [])

  // Drag the panel's left edge to resize (right-anchored, so dragging left
  // grows the panel and dragging right shrinks it — the inverse of the
  // left-anchored sidebar).
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(320, Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)))
      setWidth(w)
      try {
        localStorage.setItem('coder:readingWidth', String(w))
      } catch {
        /* storage unavailable — the width just won't persist */
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragCleanup.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    dragCleanup.current = onUp
  }

  const panel = (
    <div
      className="reading-mode"
      dir={dir}
      style={{ '--reading-w': `${width}px` } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Soft scrim — blocks clicks behind the panel; closing is via the ✕
          button or Esc, never an outside click. */}
      <div className="reading-mode-scrim" aria-hidden="true" />
      <div
        className="reading-mode-panel"
        role="dialog"
        aria-modal="false"
        aria-label="Reading mode"
      >
        {/* Drag handle on the panel's left edge — resize like the sidebar.
            Kept inside the panel so it always straddles the left edge even
            while --reading-w updates during the drag. */}
        <div
          className="reading-mode-resize-handle"
          title="Drag to resize"
          onMouseDown={startResize}
        />
        <div className="reading-mode-head">
          <div className="reading-mode-title">
            <h2>Reading Mode</h2>
            <span className="reading-mode-tab">
              Section {active + 1} of {sections.length}
            </span>
          </div>
          <div className="reading-mode-head-actions">
            <button
              className="reading-mode-nav"
              onClick={() => setActive((a) => Math.max(a - 1, 0))}
              disabled={active === 0}
              title="Previous section (↑)"
              aria-label="Previous section"
            >
              <ChevronUpIcon />
            </button>
            <button
              className="reading-mode-nav"
              onClick={() => setActive((a) => Math.min(a + 1, sections.length - 1))}
              disabled={active === sections.length - 1}
              title="Next section (↓)"
              aria-label="Next section"
            >
              <ChevronDownIcon />
            </button>
            <button
              className="modal-close"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="reading-mode-progress" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </div>

        <div className="reading-mode-body">
          <div className="reading-mode-list">
            <div className="reading-mode-list-label">
              Contents
              <span className="reading-mode-list-count">{sections.length}</span>
            </div>
            {sections.map((s, i) => (
              <div
                key={s.id}
                className={`reading-mode-item${i === active ? ' active' : ''}`}
                style={{ '--i': i } as React.CSSProperties}
                aria-current={i === active ? 'true' : undefined}
              >
                <span className="reading-mode-item-num">{i + 1}</span>
                <button
                  className="reading-mode-item-title"
                  onClick={() => setActive(i)}
                  title={s.title}
                  dir={detectDir(s.title)}
                >
                  <span
                    className="reading-mode-item-level"
                    style={{ paddingInlineStart: (s.level - 1) * 12 }}
                  >
                    {s.title}
                  </span>
                </button>
                </div>
            ))}
          </div>

          <div className="reading-mode-content" ref={contentRef}>
            <div className="reading-mode-content-head">
              <div className="reading-mode-content-title">
                <span className="reading-mode-content-num">{active + 1}</span>
                <h3 dir={detectDir(section.title)}>{section.title}</h3>
              </div>
            </div>
            <div className="reading-mode-content-inner" key={active}>
              {/* ChatBubble = the SAME component as a chat message: full chat
                  markdown pipeline (tables, charts, mermaid, LTR islands) plus
                  the chat actions row (copy / speak) under the section. */}
              <ChatBubble
                id={`${message.id}:sec:${active}`}
                content={section.content}
                className="reading-mode-bubble"
              />
            </div>
          </div>
        </div>

        <div className="reading-mode-foot">
          <span className="reading-mode-foot-hint">
            <kbd>↑</kbd> <kbd>↓</kbd> navigate sections
          </span>
          <span className="reading-mode-foot-hint">
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )

  // Render via a portal to <body> so `position: fixed` is relative to the
  // viewport. A fixed panel left inside `.msg` would be positioned against any
  // contained/transformed transcript ancestor and clipped to the message box
  // instead of covering the full right side. In SSR (no document) render inline
  // so the sanity test still sees the markup.
  if (typeof document === 'undefined') return panel
  return createPortal(panel, document.body)
}