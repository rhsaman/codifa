import { useRef, type ReactNode } from 'react'

type DragState = { sx: number; sy: number; scrollX: number; scrollY: number }

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
    const el = ref.current
    if (!el) return
    e.preventDefault()
    drag.current = {
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
    const el = ref.current
    if (!d || !el) return
    el.scrollLeft = d.scrollX - (e.clientX - d.sx)
    el.scrollTop = d.scrollY - (e.clientY - d.sy)
  }

  const end = () => {
    const el = ref.current
    if (el) {
      el.style.cursor = ''
      el.style.userSelect = ''
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
