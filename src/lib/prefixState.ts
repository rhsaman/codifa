/**
 * The `Ctrl+X` prefix flag, as seen by the bare-key listeners.
 *
 * `App.tsx` owns the chord: `Ctrl+X` arms the prefix and the NEXT key runs it.
 * Both the bare scroll keys and the sidebar's bare `j`/`k` are CAPTURE
 * listeners, so they would see that second key before the chord handler does
 * — they consult this flag and bail while it is armed.
 *
 * This MUST live at module scope with its own listener: it used to be fed only
 * by `watchPrefixFlag()` from a mounted vim-scroll pane, so on a screen with no
 * such pane (an empty workspace, a chat that renders no pane) the flag read
 * `false` forever and every `Ctrl+X` chord behaved erratically — arming worked
 * but the second key was treated as ordinary typing.
 */

let armed = false

if (typeof window !== 'undefined') {
  // Bound at module load, exactly once per module instance — never tied to a
  // component's lifetime. A duplicate registration is harmless (it writes the
  // same boolean); a MISSING one breaks every chord, which is what this fixes.
  window.addEventListener('coder:prefix', (e) => {
    armed = !!(e as CustomEvent).detail
  })
}

export function isPrefixArmed(): boolean {
  return armed
}

/** Test hook: drive the flag without dispatching an event. */
export function setPrefixArmedForTest(v: boolean): void {
  armed = v
}

/** Kept for callers that still want an explicit subscription. The module-level
 *  listener above already mirrors every broadcast, so this only returns a
 *  no-op unsubscribe: registering another listener would be dead weight, and
 *  the call site is the safest place to keep documenting that. */
export function watchPrefixFlag(): () => void {
  return () => {}
}
