import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A reusable full-window overlay used to enlarge read-only content (mermaid
 *  diagrams, file diffs) without leaving the app. Closes on Esc or scrim click.
 *
 *  Rendered through a portal into `document.body` on purpose: the trigger
 *  (a chat message or a tool card) lives inside the scrollable/transformed chat
 *  container, whose `overflow`/`transform` would otherwise clip a `position:
 *  fixed` overlay and make the modal invisible. Portaling to <body> escapes
 *  that and pins the overlay to the real viewport.
 */
export function FullscreenModal({
  open,
  onClose,
  title,
  children,
  bodyClass,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  bodyClass?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fullscreen-modal-scrim" onClick={onClose} role="presentation">
      <div
        className="fullscreen-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Full screen'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fullscreen-modal-head">
          <span className="fullscreen-modal-title">{title}</span>
          <button
            className="fullscreen-close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <div className={`fullscreen-modal-body ${bodyClass ?? ''}`}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}
