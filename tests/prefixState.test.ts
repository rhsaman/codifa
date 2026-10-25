// The Ctrl+X prefix flag shared by the bare-key listeners (src/lib/prefixState.ts).
//
// Regression guard: both `useVimScroll` and the sidebar's bare j/k are CAPTURE
// listeners, so they see the chord's SECOND key before App.tsx does. When they
// treated it as their own key, `Ctrl+X h/k/l` silently did nothing while
// `Ctrl+X j` only appeared to work (it also scrolls down). They now stand down
// while the prefix is armed.
import { watchPrefixFlag, isPrefixArmed } from '../src/lib/prefixState'

export {}
let failures = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}`)
  }
}

// Minimal event target stand-in: prefixState only reads window + CustomEvent.
const listeners = new Map<string, Set<(e: Event) => void>>()
;(globalThis as any).window = {
  addEventListener(type: string, cb: (e: Event) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(cb)
  },
  removeEventListener(type: string, cb: (e: Event) => void) {
    listeners.get(type)?.delete(cb)
  },
}
function emitArmed(armed: boolean) {
  listeners.get('coder:prefix')?.forEach((cb) => cb({ detail: armed } as unknown as Event))
}

const unwatch = watchPrefixFlag()

check('idle by default', !isPrefixArmed())
emitArmed(true)
check('armed after Ctrl+X', isPrefixArmed())
emitArmed(false)
check('disarmed once the chord ran', !isPrefixArmed())

// A second subscriber must not reset the first one's view: the flag is module
// state, so a remount (StrictMode double-invoke) reports the same value.
const unwatch2 = watchPrefixFlag()
emitArmed(true)
check('armed for both subscribers', isPrefixArmed())
unwatch()
check('still armed after one unwatch', isPrefixArmed())
unwatch2()
check('unwatching the last listener keeps the last value', isPrefixArmed())

if (failures) {
  console.error(`\n${failures} prefixState assertion(s) failed`)
  process.exit(1)
}
console.log('\nprefixState: all assertions passed')
