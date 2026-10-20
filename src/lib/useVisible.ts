import { useEffect, useState, type RefObject } from 'react'

/**
 * True once the element has been on screen (and stays true afterwards).
 *
 * Used to defer expensive work — rendering a diagram, parsing a large body —
 * until the user actually looks at it. A transcript renders many messages at
 * once, so anything that mounts heavy work eagerly pays for nodes that are far
 * below the fold.
 *
 * `enabled` starts the observation; passing `false` keeps the result `false`
 * without registering anything (callers use it to wait for streaming to finish
 * so a half-written block is never parsed).
 */
export function useVisible<T extends Element>(
  ref: RefObject<T | null>,
  enabled = true,
): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (visible || !enabled) return
    const el = ref.current
    if (!el) return
    // No IntersectionObserver (SSR, a bare node test env): treat it as visible
    // so the content still renders instead of silently disappearing.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            io.disconnect()
            return
          }
        }
      },
      // Start a bit early so the block is ready by the time it is scrolled to.
      { rootMargin: '200px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, enabled, visible])

  return visible
}
