// Track in-flight tool calls as a counter (not a boolean) so parallel tool
// calls don't prematurely clear the "a tool is still running" flag that gives
// the stall watchdog its longer leash. With a boolean, the first tool to finish
// would flip the flag off even while siblings are still running, causing the
// watchdog to wrongly treat the turn as stalled.

export function bumpToolRunning(ref: { current: number }): void {
  ref.current += 1
}

export function dropToolRunning(ref: { current: number }): void {
  ref.current = Math.max(0, ref.current - 1)
}

export function isToolRunning(ref: { current: number }): boolean {
  return ref.current > 0
}

/** Time since last real content (non-keepalive event). Pure for testing. */
export function contentElapsedMs(lastContentAtMs: number, nowMs: number): number {
  return nowMs - lastContentAtMs
}

/** Show "waiting for model" pill when content is stale but socket is alive. */
export function shouldShowWaitingForModel(
  contentElapsed: number,
  socketElapsed: number,
  limitMs: number,
  earlyMs = 25_000,
): boolean {
  return contentElapsed > earlyMs && socketElapsed <= limitMs
}

/** True when content is stale past the stall limit while the socket stays
 * alive (keepalives keep flowing): the stream is wedged, not merely slow —
 * the caller should abort and auto-resume from the checkpoint instead of
 * showing the "waiting for model" pill forever. */
export function shouldRecoverContentStall(
  contentElapsed: number,
  socketElapsed: number,
  limitMs: number,
): boolean {
  return contentElapsed > limitMs && socketElapsed <= limitMs
}
