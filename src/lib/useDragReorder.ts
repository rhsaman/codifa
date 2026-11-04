import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  captureDragSlots,
  slotExtents,
  slotShifts,
  tabForPoint,
  type DragSlots,
} from './tabBar'

/** Shared HTML5 drag-to-reorder for the Settings lists (Tools fallback
 *  chains, Web Provider engines, Media Provider ladders, provider API keys).
 *
 *  Same drag feel as the chat tab bar, and the same correctness fix: the
 *  rows' boxes are captured ONCE at drag start (captureDragSlots) and every
 *  hit-test reads those captured extents (scroll-compensated) — never the
 *  live boxes, which carry the slide transforms and would feed the next
 *  hit-test back into itself (the preview oscillates and the drop lands one
 *  slot off). Slides are exact per-row pixel deltas (slotShifts), so variable
 *  row heights and the list gaps land precisely, and the preview equals the
 *  post-commit layout — the commit never visibly jumps.
 *
 *  Only the grip handle starts a drag — rows are drop targets — so inputs,
 *  selects and buttons inside a row keep working. A move that would land the
 *  row where it already is is swallowed as a no-op.
 *
 *  Tauri's native file drag-drop is unaffected: element drags never reach
 *  the window-level file drop handler (same mechanism the chat tab bar uses).
 *
 *  `listId` namespaces the dataTransfer payload so a drop from ANOTHER list
 *  is ignored (each list owns its hook instance; a foreign drag never sets
 *  this hook's dragIndex). */
export function useDragReorder(
  listId: string,
  length: number,
  onReorder: (from: number, insertAt: number) => void,
) {
  /** Index of the row being dragged, or null. */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** Insertion point in the ORIGINAL array: "above row j" → j, "below" → j+1. */
  const [target, setTarget] = useState<number | null>(null)
  /** Captured row boxes. Ids are the row indices as strings — the rows
   *  render in list order, so DOM order == index order for every list. */
  const slotsRef = useRef<DragSlots | null>(null)

  // A row added/removed mid-drag invalidates the held indices — reset rather
  // than guess (a committed drop right after is rarer than a stale index).
  useEffect(() => {
    setDragIndex(null)
    setTarget(null)
    slotsRef.current = null
  }, [listId, length])

  /** The insertion `target` expressed the way slotShifts/previewOrder want
   *  it: a neighbour id plus the side. Below row j == after row j; above
   *  row j == before row j; at the very end == after the last row. */
  const landingArgs = useCallback(
    (dragged: number, at: number): { toId: string; after: boolean } => {
      if (at > dragged) return { toId: `${Math.min(at - 1, length - 1)}`, after: true }
      return { toId: `${Math.min(at, length - 1)}`, after: false }
    },
    [length],
  )

  /** Per-row inline style that slides the row to its previewed slot. Rows
   *  already at their previewed position return undefined (no transform). */
  const shiftStyle = useCallback(
    (index: number): Record<string, string> | undefined => {
      if (dragIndex === null || target === null || !slotsRef.current) return undefined
      const { toId, after } = landingArgs(dragIndex, target)
      const px = slotShifts(slotsRef.current, `${dragIndex}`, toId, after).get(`${index}`)
      if (!px) return undefined
      return { transform: `translateY(${px}px)` }
    },
    [dragIndex, target, landingArgs],
  )

  /** Spread on the grip handle that starts the drag. */
  const handleProps = useCallback(
    (index: number) => ({
      draggable: true,
      onDragStart: (e: DragEvent) => {
        try {
          e.dataTransfer.setData(`application/x-codifa-reorder/${listId}`, String(index))
          e.dataTransfer.setData('text/plain', listId)
        } catch {
          /* drag unsupported */
        }
        e.dataTransfer.effectAllowed = 'move'
        // The default ghost is the tiny grip itself; drag the whole row's
        // image instead so the grabbed card looks like what moves.
        const row = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-drag-row]')
        if (row) {
          const list = row.parentElement
          if (list) {
            const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-drag-row]'))
            slotsRef.current = captureDragSlots(
              list,
              rows.map((_, i) => `${i}`),
              (_id, i) => rows[i],
              'y',
              1,
            )
          }
          e.dataTransfer.setDragImage(row, 24, 12)
        }
        setDragIndex(index)
      },
      onDragEnd: () => {
        setDragIndex(null)
        setTarget(null)
        slotsRef.current = null
      },
    }),
    [listId],
  )

  /** Spread on every row (the `[data-drag-row]` element): drop targeting
   *  against the CAPTURED geometry — the shifted rows moving under the
   *  cursor cannot flip the target back and forth. */
  const rowProps = useCallback(
    (index: number) => ({
      onDragOver: (e: DragEvent) => {
        if (dragIndex === null || dragIndex === index) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const slots = slotsRef.current
        if (!slots) return
        const at = tabForPoint(slotExtents(slots), e.clientY, 1, 'y')
        if (!at) return
        const j = Number(at.id)
        if (!Number.isFinite(j)) return
        const next = at.after ? j + 1 : j
        setTarget((prev) => (prev === next ? prev : next))
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        if (
          dragIndex === null ||
          target === null ||
          e.dataTransfer.types.every((t) => !t.startsWith(`application/x-codifa-reorder/${listId}`))
        ) {
          return
        }
        const landsAt = dragIndex < target ? target - 1 : target
        if (landsAt !== dragIndex) onReorder(dragIndex, target)
        setDragIndex(null)
        setTarget(null)
        slotsRef.current = null
      },
      // Children (inputs, selects) fire dragleave constantly — the preview is
      // cleared by drop/dragend, so leaves are ignored on purpose.
    }),
    [dragIndex, target, listId, onReorder],
  )

  return {
    /** Index currently being dragged, or null. */
    dragIndex,
    /** Insertion point of the live preview, or null. */
    target,
    /** Inline transform per row index during the drag (undefined = rest). */
    shiftStyle,
    handleProps,
    rowProps,
  }
}

/** Move `list[from]` to land at `insertAt` (a position in the ORIGINAL
 *  array), compensating for the dragged row's own removal. Returns the same
 *  array contents when the move is a no-op position swap. */
export function moveAt<T>(list: readonly T[], from: number, insertAt: number): T[] {
  if (from < 0 || from >= list.length) return [...list]
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(from < insertAt ? insertAt - 1 : insertAt, 0, row)
  return next
}
