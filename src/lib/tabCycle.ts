/**
 * Ring math for the VS Code tab chord (Cmd+Shift+[ / ] on Apple platforms,
 * Ctrl+Shift+[ / ] elsewhere — the chord itself is detected in
 * src/lib/shortcuts.ts `tabCycleChord`).
 *
 * Every tab strip in the app is an ordered list of ids plus one active id, so
 * one rule steps all of them: the chat column's chat tabs, the right pane's
 * tabs (a terminal tab shown there included) and the bottom terminal's shells.
 *
 * The step WRAPS at both ends, exactly like VS Code. A single tab therefore
 * stays put (never "activates nothing", which would read as a dead chord), and
 * an active id that is no longer in the list — a tab closed a frame ago, a
 * strip the chord reached before its active one was set — enters the ring at
 * its first tab for `next` and its last for `prev`, so a forward press is
 * never a jump to the end of the strip. Pure: no store, no DOM, for tests.
 */
export function cycleId(
  ids: readonly string[],
  activeId: string | null | undefined,
  dir: 1 | -1,
): string | null {
  const n = ids.length;
  if (n === 0) return null;
  const i = activeId ? ids.indexOf(activeId) : -1;
  if (i === -1) return dir > 0 ? ids[0] : ids[n - 1];
  return ids[(i + dir + n) % n];
}
