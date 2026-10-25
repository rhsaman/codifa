import { useCallback, useEffect, useRef, useState } from 'react'

/** How many cards one "batch" of the infinite list adds per load. */
export const CARD_BATCH = 24

/** Progressive rendering for a long, filtered list of CARDS in a grid.
 *
 *  Why a hook instead of a component: the item renderer is the caller's (each
 *  page's cards differ), while the growing-count, the IntersectionObserver and
 *  its cleanup are identical everywhere — one place, tested once.
 *
 *  The sentinel ref is attached INSIDE the scroll container (the settings
 *  modal's own scrolling pane), so observe it directly; the modal never scrolls
 *  `window`. Returns `visible`/`hasMore` for slicing plus a `sentinelRef` for
 *  the marker node. */
export function useInfiniteGrid(count: number, resetKey: string) {
  const [visible, setVisible] = useState(CARD_BATCH)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // A new search / tab / data source restarts the window; the transient
  // ref is safe to write during the effect that owns it.
  useEffect(() => {
    setVisible(CARD_BATCH)
  }, [resetKey])

  const loadMore = useCallback(() => {
    setVisible((v) => (v >= count ? v : v + CARD_BATCH))
  }, [count])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || visible >= count) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      // The scroll ancestor is the settings pane, not the window.
      { root: el.closest('.settings-body, .modal-body, body') ?? null, rootMargin: '400px' },
      )
    io.observe(el)
    return () => io.disconnect()
  }, [visible, count, loadMore])

  return {
    visible: Math.min(visible, Math.max(count, CARD_BATCH)),
    hasMore: visible < count,
    remaining: Math.max(0, count - visible),
    loadMore,
    sentinelRef,
  }
}
