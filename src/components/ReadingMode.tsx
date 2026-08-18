import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../types'
import { splitSections, type Section } from '../lib/sections'
import { useStore } from '../lib/store'
import { detectDir, prepareContent } from '../lib/bidi'
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

/**
 * Reading mode — a right-side panel (like Claude Code's docs viewer) for a
 * long agent answer: section titles on the left, the selected section's full
 * content on the right. The chat stays visible and interactive behind it — no
 * fullscreen dark overlay. Each section has a "سوال از این بخش" button that
 * forks the section into its own new chat (see store.forkSection), so the user
 * can ask follow-up questions without scrolling the whole answer or mixing
 * sections.
 */
export function ReadingMode({
  message,
  onClose,
}: {
  message: ChatMessage
  onClose: () => void
}) {
  const dir = useStore((s) => s.dir)
  // Direction of the message itself — the panel's texts must line up with the
  // content, not just the app-wide toggle (a Persian app can hold an English
  // answer, and vice versa).
  const contentDir = useMemo(() => detectDir(message.content), [message.content])
  const sections = useMemo(() => splitSections(message.content), [message.content])
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <div className="reading-mode" onClick={(e) => e.stopPropagation()}>
      <div className="reading-mode-panel">
        <div className="reading-mode-head">
          <div className="reading-mode-title">
            <span className="reading-mode-title-icon">
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
            </span>
            <h2>حالت مطالعه</h2>
            <span className="reading-mode-tab">
              بخش {active + 1} از {sections.length}
            </span>
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

        <div className="reading-mode-body">
          <div className="reading-mode-list" dir={contentDir}>
            <div className="reading-mode-list-label">فهرست مطالب</div>
            {sections.map((s, i) => (
              <div
                key={s.id}
                className={`reading-mode-item${i === active ? ' active' : ''}`}
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
                  title="سوال از این بخش — چت جدید"
                  aria-label="سوال از این بخش"
                >
                  <AskIcon />
                </button>
              </div>
            ))}
          </div>

          <div className="reading-mode-content">
            <div className="reading-mode-content-head">
              <h3 dir="auto">{section.title}</h3>
              <div className="reading-mode-content-actions">
                <button
                  className={`reading-mode-copy${copied ? ' copied' : ''}`}
                  onClick={copy}
                  title="کپی متن بخش"
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
                      کپی شد
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
                      کپی
                    </>
                  )}
                </button>
                <button
                  className="reading-mode-ask-btn"
                  onClick={() => askFor(section)}
                  title="چت جدید با زمینه این بخش"
                >
                  <AskIcon /> سوال از این بخش
                </button>
              </div>
            </div>
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