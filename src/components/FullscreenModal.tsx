import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const MIN_ZOOM = 1
const MAX_ZOOM = 5
const ZOOM_STEP = 0.02

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100))
}

/** A reusable full-window overlay used to enlarge read-only content (mermaid
 *  diagrams, file diffs) without leaving the app. Closes on Esc or scrim click.
 *
 *  Zoom: drag a marquee box over the region you want — it zooms so that region
 *  fills the viewport and centers. Ctrl/⌘ + wheel also zooms. The ⟳ button
 *  resets to 100%.
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
  scrollable = false,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  bodyClass?: string
  /** When true, dragging scrolls the content (native overflow) instead of
   *  panning/marquee-zooming it. Used for file diffs so long code lines scroll
   *  horizontally/vertically. Mermaid keeps the default pan/zoom behavior. */
  scrollable?: boolean
}) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [sel, setSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [cursor, setCursor] = useState<'grab' | 'crosshair' | 'grabbing'>('grab')
  const dragRef = useRef<{
    mode: 'pan' | 'marquee' | 'scroll'
    sx: number
    sy: number
    panX: number
    panY: number
    scrollX: number
    scrollY: number
  } | null>(null)
  const selRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reset zoom/pan whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      setSel(null)
    }
  }, [open])

  // Keep refs in sync so the wheel handler reads fresh values.
  useEffect(() => {
    zoomRef.current = zoom
    panRef.current = pan
  }, [zoom, pan])

  // Ctrl/⌘ + wheel zoom. A native non-passive listener is required so the
  // browser's own page-zoom can be prevented. In `scrollable` mode we skip this
  // entirely and let the browser scroll the content natively.
  useEffect(() => {
    if (scrollable) return
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const el = viewportRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const vx = e.clientX - rect.left
      const vy = e.clientY - rect.top
      const z = zoomRef.current
      const nz = clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
      if (nz === z) return
      // Keep the content point under the cursor fixed while zooming.
      const p = panRef.current
      const cx = (vx - p.x) / z
      const cy = (vy - p.y) / z
      setZoom(nz)
      setPan({ x: vx - cx * nz, y: vy - cy * nz })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  if (!open) return null

  const reset = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Zoom so the marquee box (viewport px, relative to the viewport top-left)
  // fills the viewport and centers.
  const zoomTo = (sx: number, sy: number, sw: number, sh: number) => {
    const el = viewportRef.current
    if (!el || sw < 6 || sh < 6) return
    const rect = el.getBoundingClientRect()
    const W = rect.width
    const H = rect.height
    const nz = clampZoom(zoom * Math.min(W / sw, H / sh))
    // Content coordinates of the marquee center under the CURRENT transform.
    const ccx = (sx + sw / 2 - pan.x) / zoom
    const ccy = (sy + sh / 2 - pan.y) / zoom
    const nx = W / 2 - ccx * nz
    const ny = H / 2 - ccy * nz
    setZoom(nz)
    setPan({ x: nx, y: ny })
  }

  const onMouseDown = (e: React.MouseEvent) => {
    const el = viewportRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (scrollable) {
      // Cmd/Ctrl + drag scrolls the content natively (no pan/marquee/zoom).
      // A plain drag is left free for text selection, so we must NOT call
      // preventDefault here — doing so would stop the browser from starting a
      // text selection on mousedown.
      if (!(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      dragRef.current = {
        mode: 'scroll',
        sx: e.clientX,
        sy: e.clientY,
        panX: 0,
        panY: 0,
        scrollX: el.scrollLeft,
        scrollY: el.scrollTop,
      }
      // Only block text selection while actually drag-scrolling; a plain drag
      // stays free for selecting/copying text.
      el.style.userSelect = 'none'
      el.style.webkitUserSelect = 'none'
      setCursor('grabbing')
      return
    }
    const marquee = e.metaKey || e.ctrlKey
    // Mermaid: a drag pans/marquees the diagram, so prevent text selection.
    e.preventDefault()
    dragRef.current = {
      mode: marquee ? 'marquee' : 'pan',
      sx: x,
      sy: y,
      panX: panRef.current.x,
      panY: panRef.current.y,
      scrollX: 0,
      scrollY: 0,
    }
    if (marquee) {
      selRef.current = { x, y, w: 0, h: 0 }
      setSel({ x, y, w: 0, h: 0 })
      setCursor('crosshair')
    } else {
      setCursor('grabbing')
    }
  }
  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current
    const el = viewportRef.current
    if (!d || !el) return
    if (d.mode === 'scroll') {
      el.scrollLeft = d.scrollX - (e.clientX - d.sx)
      el.scrollTop = d.scrollY - (e.clientY - d.sy)
      return
    }
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (d.mode === 'marquee') {
      const next = {
        x: Math.min(d.sx, x),
        y: Math.min(d.sy, y),
        w: Math.abs(x - d.sx),
        h: Math.abs(y - d.sy),
      }
      selRef.current = next
      setSel(next)
    } else {
      setPan({ x: d.panX + (x - d.sx), y: d.panY + (y - d.sy) })
    }
  }
  const onMouseUp = () => {
    const d = dragRef.current
    const s = selRef.current
    dragRef.current = null
    selRef.current = null
    if (d?.mode === 'marquee' && s && s.w >= 6 && s.h >= 6) {
      zoomTo(s.x, s.y, s.w, s.h)
    }
    setSel(null)
    if (d?.mode === 'scroll') {
      const el = viewportRef.current
      if (el) {
        el.style.userSelect = ''
        el.style.webkitUserSelect = ''
      }
      setCursor('grab')
    }
  }

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
        <div className={`fullscreen-modal-body ${bodyClass ?? ''}`}>
          <div
            className={`fullscreen-pan-viewport${scrollable ? ' scrollable' : ''}`}
            ref={viewportRef}
            style={scrollable ? (cursor === 'grabbing' ? { cursor: 'grabbing' } : undefined) : { cursor }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            <div
              className="fullscreen-pan-content"
              style={scrollable ? undefined : { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
              {children}
            </div>
            {!scrollable && sel && (
              <div
                className="fullscreen-marquee"
                style={{
                  left: sel.x,
                  top: sel.y,
                  width: sel.w,
                  height: sel.h,
                }}
              />
            )}
          </div>
          {!scrollable && (
            <div className="fullscreen-zoom-bar">
              <button onClick={reset} aria-label="Reset zoom" title="Reset zoom (100%)">
                ⟳
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
