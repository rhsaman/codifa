/**
 * The `Ctrl+X` prefix flag, as seen by the bare-key listeners.
 *
 * `App.tsx` owns the chord: `Ctrl+X` arms the prefix and the NEXT key runs it.
 * Both the bare scroll keys and the sidebar's bare `j`/`k` are CAPTURE
 * listeners, so they would see that second key before the chord handler does
 * and swallow it (a scroll, or a chat step). Subscribing here lets them stand
 * down for the one key that belongs to the chord.
 *
 * Kept in its own module so the two panes share one implementation instead of
 * each re-reading the event.
 */

let armed = false

/** Bind once per window: mirrors the `coder:prefix` broadcast of App.tsx. */
export function watchPrefixFlag(): () => void {
  const onPrefix = (e: Event) => {
    armed = !!(e as CustomEvent).detail
  }
  window.addEventListener('coder:prefix', onPrefix)
  return () => window.removeEventListener('coder:prefix', onPrefix)
}

/** Whether `Ctrl+X` is waiting for its second key right now. */
export function isPrefixArmed(): boolean {
  return armed
}

/** Test-only override: the unit tests drive the guard without a DOM window,
 *  so there is no `coder:prefix` broadcast to listen to. */
export function setPrefixArmedForTest(v: boolean): void {
  armed = v
}
