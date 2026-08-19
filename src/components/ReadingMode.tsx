import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../types'
import { splitSections, type Section } from '../lib/sections'
import { useStore } from '../lib/store'
import { prepareContent } from '../lib/bidi'
import { copyToClipboard } from '../lib/clipboard'
import 'highlight.js/styles/github-dark.min.css'

/** Clean reply icon (corner-down-left) — no chat-bubble/Telegram look. */
const AskIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 10 4 15l5 5" />
    <path d="M20 4v7a4 4 0 0 1-4 4H4" />
  </svg>
)

/** Book icon for the panel header. */
const BookIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)

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
 * Reading mode — a right-side panel (like Claude Code's docs viewer) for a
 * long agent answer: section titles on the left, the selected section's full
 * content on the right. The chat stays visible behind it — a soft scrim
 * focuses the panel without fully blocking the conversation. Each section has
 * an "Ask about this section" button that forks the section into its own new
 * chat (see store.forkSection), so the user can ask follow-up questions
 * without scrolling the whole answer or mixing sections.
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
  // header/footer flow right-to-left. The section content itself still renders
  // with dir="auto", so an English answer inside an RTL app keeps its own LTR
  // flow.
  const dir = useStore((s) => s.dir)
  const sections = useMemo(() => splitSections(message.content), [message.content])
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  // Esc closes the panel; ↑/↓ jump between sections.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, sections.length - 1))
      else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
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

  const askFor = (s: Section) => {
    useStore.getState().forkSection(message.id, s.title, s.content)
    onClose()
  }

  const copy = async () => {
    try {
      await copyToClipboard(section.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('copy failed', err)
    }
  }

  const panel = (
    <div className="reading-mode" dir={dir} onClick={(e) => e.stopPropagation()}>
      {/* Soft scrim — click anywhere outside the panel to close. */}
      <div className="reading-mode-scrim" aria-hidden="true" onClick={onClose} />
      <div
        className="reading-mode-panel"
        role="dialog"
        aria-modal="false"
        aria-label="Reading mode"
      >
        <div className="reading-mode-head">
          <div className="reading-mode-title">
            <span className="reading-mode-title-icon">
              <BookIcon />
            </span>
            <div className="reading-mode-title-text">
              <h2>Reading Mode</h2>
              <span className="reading-mode-tab">
                Section {active + 1} of {sections.length}
              </span>
            </div>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ✕
          </button>
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
                  dir="auto"
                >
                  <span
                    className="reading-mode-item-level"
                    style={{ paddingInlineStart: (s.level - 1) * 12 }}
                  >
                    {s.title}
                  </span>
                </button>
                <button
                  className="reading-mode-ask"
                  onClick={() => askFor(s)}
                  title="Ask about this section — new chat"
                  aria-label="Ask about this section"
                >
                  <AskIcon />
                </button>
              </div>
            ))}
          </div>

          <div className="reading-mode-content" ref={contentRef}>
            <div className="reading-mode-content-head">
              <div className="reading-mode-content-title">
                <span className="reading-mode-content-num">{active + 1}</span>
                <h3 dir="auto">{section.title}</h3>
              </div>
              <div className="reading-mode-content-actions">
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
                  className={`reading-mode-copy${copied ? ' copied' : ''}`}
                  onClick={copy}
                  title="Copy section text"
                >
                  {copied ? (
                    <>
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Copied
                    </>
                  ) : (
                    <>
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
                <button
                  className="reading-mode-ask-btn"
                  onClick={() => askFor(section)}
                  title="New chat with this section's context"
                >
                  <AskIcon /> Ask about this section
                </button>
              </div>
            </div>
            <div className="reading-mode-content-inner" key={active}>
              <div className="chat-message markdown-body" dir="auto">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                >
                  {prepareContent(section.content, dir)}
                </ReactMarkdown>
              </div>
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
  // viewport. The panel is mounted inside `.msg` (content-visibility: auto),
  // which implicitly applies `contain: layout` — that would make the fixed
  // panel a containing block of the message and clip it to the message's
  // height instead of the full right side. In SSR (no document) render inline
  // so the sanity test still sees the markup.
  if (typeof document === 'undefined') return panel
  return createPortal(panel, document.body)
}