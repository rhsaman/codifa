import { useRef, type ReactNode } from 'react'

type DragState = {
  el: HTMLElement
  sx: number
  sy: number
  scrollX: number
  scrollY: number
}

/**
 * What a drag should scroll: the element itself when it has its own overflow,
 * otherwise (a diff whose scrolling lives on the pane around it) the nearest
 * ancestor that actually scrolls.
 */
function scrollTarget(el: HTMLElement): HTMLElement {
  const own = getComputedStyle(el)
  if (own.overflowX !== 'visible' || own.overflowY !== 'visible') return el
  for (let n = el.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    const sx =
      (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
      n.scrollWidth > n.clientWidth
    const sy =
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
      n.scrollHeight > n.clientHeight
    if (sx || sy) return n
  }
  return el
}

/**
 * Drag-to-scroll (horizontal + vertical) for an `overflow: auto` element.
 *
 * Scrolling only starts while Cmd (macOS) or Ctrl is held — a plain drag is
 * left free for normal text selection. Returns the props to spread onto the
 * scrollable element.
 */
export function useDragScroll<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  const drag = useRef<DragState | null>(null)

  const onMouseDown = (e: React.MouseEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const own = ref.current
    if (!own) return
    const el = scrollTarget(own)
    e.preventDefault()
    drag.current = {
      el,
      sx: e.clientX,
      sy: e.clientY,
      scrollX: el.scrollLeft,
      scrollY: el.scrollTop,
    }
    el.style.cursor = 'grabbing'
    el.style.userSelect = 'none'
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    d.el.scrollLeft = d.scrollX - (e.clientX - d.sx)
    d.el.scrollTop = d.scrollY - (e.clientY - d.sy)
  }

  const end = () => {
    const d = drag.current
    if (d) {
      d.el.style.cursor = ''
      d.el.style.userSelect = ''
    }
    drag.current = null
  }

  const handlers = {
    ref,
    onMouseDown,
    onMouseMove,
    onMouseUp: end,
    onMouseLeave: end,
  } as const

  return handlers
}

/** Convenience wrapper that applies {@link useDragScroll} to a div. */
export function DragScroll({
  children,
  className,
  style,
}: {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  const h = useDragScroll<HTMLDivElement>()
  return (
    <div {...h} className={className} style={style}>
      {children}
    </div>
  )
}
