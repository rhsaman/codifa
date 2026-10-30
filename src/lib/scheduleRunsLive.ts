import { create } from 'zustand'
import type { ScheduleRun } from '../types'

/**
 * The latest schedule run rows, as polled by `ScheduleRunsWatcher` (mounted
 * once in App). The dock's Inbox icon reads its unread badge from here, so the
 * count stays live even while the inbox page itself is closed.
 *
 * Kept out of the main store on purpose: it is never persisted, and the dock
 * must not pull the inbox's heavy chunk (markdown renderer) just to count.
 */
interface ScheduleRunsLive {
  runs: ScheduleRun[]
  setRuns: (runs: ScheduleRun[]) => void
}

export const useScheduleRunsLive = create<ScheduleRunsLive>((set, get) => ({
  runs: [],
  setRuns: (runs) => {
    // Every poll returns a fresh array; an unchanged payload must not
    // re-render the dock.
    if (JSON.stringify(get().runs) === JSON.stringify(runs)) return
    set({ runs })
  },
}))
