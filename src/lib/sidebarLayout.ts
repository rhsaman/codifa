/* Sidebar width limits (px), shared by the shell's drag handle and its
 * persistence load.
 *
 * MIN is NOT cosmetic. On macOS the strip under the traffic lights keeps an
 * 88px gutter for the OS window buttons (`.sidebar-drag` padding-left) and 8px
 * for its own trailing edge, and the window-strip cluster (persona switch +
 * hamburger + settings + update) is pinned to that same strip. The cluster
 * steps down to `data-compact="xs"` as it gets tight, and below that width the
 * strip CLIPS (`overflow: hidden`) — the trailing icon would simply be cut, and
 * a control the user cannot reach is worse than a wider sidebar.
 *
 * The numbers that matter are asserted in tests/sidebarClusterFit.test.ts,
 * which reads them out of 01-projects-list-folder-rows.css so the CSS stays the
 * single source of the sizes and this limit cannot silently drift under them.
 */
export const SIDEBAR_MIN_WIDTH = 220

/** Nothing wider is useful: past this the chat column starves. */
export const SIDEBAR_MAX_WIDTH = 480

/** Clamp any width (a drag step, a stored value) into the legal range. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_MIN_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width))
}
