// Run an async job only when the previous one has finished.
//
// The live preview decodes the whole turn so far. A newer decode always covers
// more audio than an older one, so queueing jobs behind a running decode would
// only delay the text on screen: while one runs, new requests are dropped, and
// the caller simply asks again on its next tick.

export interface SingleFlight {
  /**
   * Start `job` unless one is already running. Returns the promise of the job
   * in flight — the new one, or the one that was already running (the new job
   * is then NOT run). The promise never rejects: a failing job must not wedge
   * the guard, so the error is the job's own business to report.
   */
  run(job: () => Promise<void>): Promise<void>
  /** The job in flight right now, or null when idle. */
  current(): Promise<void> | null
}

export function singleFlight(): SingleFlight {
  let inflight: Promise<void> | null = null
  return {
    run(job) {
      if (inflight) return inflight
      const started = (async () => {
        try {
          await job()
        } catch {
          // See the contract above.
        }
      })()
      const tracked = started.finally(() => {
        if (inflight === tracked) inflight = null
      })
      inflight = tracked
      return tracked
    },
    current: () => inflight,
  }
}
