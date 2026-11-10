// The Ctrl+X prefix flag shared by the bare-key listeners (src/lib/prefixState.ts).
//
// Regression guard: both `useVimScroll` and the sidebar's bare j/k are CAPTURE
// listeners, so they see the chord's SECOND key before App.tsx does. When they
// treated it as their own key, `Ctrl+X h/k/l` silently scrolled instead of
// running the chord.
//
// The bug this locks in: the flag used to be set ONLY while some component had
// called `watchPrefixFlag()`. When no vim-scroll pane was mounted the flag was
// stuck at `false`, so the bare-key listeners stole the second key and the
// chord became INTERMITTENT — the "I have to press Ctrl+X J several times"
// report. The module now registers its own listener on import, which is why
// this test must install `window` BEFORE importing it.

// Minimal `window` so the module-level listener has somewhere to bind (this runs
// in Node, where the real app has a DOM). The import below is dynamic on
// purpose: a static one would be hoisted above this stub.
const listeners = new Map<string, Set<(e: Event) => void>>()
;(globalThis as any).window = {
  addEventListener(type: string, cb: (e: Event) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(cb)
  },
  removeEventListener(type: string, cb: (e: Event) => void) {
    listeners.get(type)?.delete(cb)
  },
  dispatchEvent(e: Event) {
    listeners.get(e.type)?.forEach((cb) => cb(e))
    return true
  },
}

const { isPrefixArmed, setPrefixArmedForTest, watchPrefixFlag } = await import(
  '../src/lib/prefixState'
)

let failed = 0
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed++
}

function broadcast(detail: unknown) {
  ;(globalThis as any).window.dispatchEvent({ type: 'coder:prefix', detail } as unknown as Event)
}

// The module installs its own listener, so a real event must move the flag
// with NO `watchPrefixFlag()` call anywhere — that absence IS the fix.
console.log('1) the flag follows the coder:prefix event with no component mounted:')
{
  setPrefixArmedForTest(false)
  check('idle by default', !isPrefixArmed())
  broadcast(true)
  check('armed after Ctrl+X', isPrefixArmed())
  broadcast(false)
  check('disarmed after the chord ran', !isPrefixArmed())
}

console.log('2) test hook (drives the flag without an event):')
{
  setPrefixArmedForTest(true)
  check('setPrefixArmedForTest(true) arms', isPrefixArmed())
  setPrefixArmedForTest(false)
  check('setPrefixArmedForTest(false) disarms', !isPrefixArmed())
}

console.log('3) watchPrefixFlag() is still callable and its unsubscribe is safe:')
{
  setPrefixArmedForTest(false)
  const off = watchPrefixFlag()
  broadcast(true)
  check('module listener still arms with watchPrefixFlag active', isPrefixArmed())
  off()
  broadcast(false)
  check('unsubscribe does not break the module listener', !isPrefixArmed())
}

console.log('4) the flag is a plain boolean (truthiness coercion is deliberate):')
{
  // Listeners only care "is a chord in progress". App.tsx always broadcasts a
  // real boolean, so coercing through `!!` keeps a stray `CustomEvent` written
  // elsewhere (a test, a browser extension) from arming on the string 'yes' —
  // which WOULD arm, and that is the honest behaviour: `!!'yes'` is true.
  setPrefixArmedForTest(false)
  broadcast('yes')
  check('truthy detail coerces to armed', isPrefixArmed())
  broadcast(undefined)
  check('undefined detail disarms', !isPrefixArmed())
}

if (failed > 0) {
  console.error(`\n❌ ${failed} prefixState check(s) failed`)
  process.exit(1)
}
console.log('\nprefixState: all checks passed')
