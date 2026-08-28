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
