// The terminal chord guard (src/lib/terminalKeys.ts).
//
// Two regression classes:
//  1. App chords (Ctrl/Cmd+J/W/M/X) must never reach the shell as ^J/^M/^X.
//  2. The Ctrl+X prefix: the ARMING key is already reserved (x), but the SECOND
//     key arrives WITHOUT any modifier inside the terminal, and xterm would
//     send it to the shell exactly as typed — ^J is newline and ^K kills the
//     half-typed line, which is why `Ctrl+X j` (toggle the terminal) looked
//     broken while the caret was in the terminal. The guard must suppress the
//     second key while the prefix is armed, and let the very same letters
//     through as normal shell input once it is not. `h`/`k`/`l` are NOT prefix
//     keys any more: window navigation is the direct Ctrl+H/J/K/L chord, so
//     once the prefix is armed they must reach the shell untouched.
import { isReservedTerminalChord } from '../src/lib/terminalKeys'
import { isApplePlatform } from '../src/lib/shortcuts'
import { setPrefixArmedForTest } from '../src/lib/prefixState'

export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

/** Minimal keydown double, shaped like the KeyboardEvent xterm forwards. */
function ev(over: Partial<{
  type: string
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}> = {}): Parameters<typeof isReservedTerminalChord>[0] {
  return {
    type: 'keydown',
    key: 'k',
    code: 'KeyK',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }
}

console.log('1) app chords stay reserved (never shell input):')
{
  check('Ctrl+J reserved', isReservedTerminalChord(ev({ key: 'j', code: 'KeyJ', ctrlKey: true })))
  check('Cmd+M reserved', isReservedTerminalChord(ev({ key: 'm', code: 'KeyM', metaKey: true })))
  check('Ctrl+X reserved', isReservedTerminalChord(ev({ key: 'x', code: 'KeyX', ctrlKey: true })))
  // W is split by platform — exactly ONE half is the app's close chord (Cmd
  // on Apple, Ctrl elsewhere) and the other half must pass through as the
  // shell's delete-previous-word (^W). Node on this host reports the host
  // platform (navigator.platform = 'MacIntel' on a Mac), so assert the
  // invariant instead of pinning a platform here.
  const ctrlW = isReservedTerminalChord(ev({ key: 'w', code: 'KeyW', ctrlKey: true }))
  const cmdW = isReservedTerminalChord(ev({ key: 'w', code: 'KeyW', metaKey: true }))
  check('exactly one half of W is reserved', ctrlW !== cmdW, { ctrlW, cmdW })
  check('reserved half = the platform close half', cmdW === isApplePlatform() && ctrlW === !isApplePlatform(), { apple: isApplePlatform(), ctrlW, cmdW })
  check('plain k NOT reserved', !isReservedTerminalChord(ev()))
  check('Shift+J not reserved (shift chords are shell input)', !isReservedTerminalChord(ev({ key: 'J', code: 'KeyJ', shiftKey: true })))
}

console.log('2) the Ctrl+X SECOND key while the prefix is armed:')
{
  setPrefixArmedForTest(true)
  try {
    for (const key of ['j', 'u', 'r', 'c', 'v']) {
      const ev2 = ev({ key, code: `Key${key.toUpperCase()}` })
      check(`bare ${key} suppressed while armed`, isReservedTerminalChord(ev2))
    }
    check('Space suppressed while armed (Ctrl+X Space = voice)', isReservedTerminalChord(ev({ key: ' ', code: 'Space' })))
    check('a non-prefix letter stays shell input', !isReservedTerminalChord(ev({ key: 'a', code: 'KeyA' })))
    for (const key of ['h', 'k', 'l']) {
      const ev2 = ev({ key, code: `Key${key.toUpperCase()}` })
      check(`bare ${key} NOT a prefix key — reaches the shell while armed`, !isReservedTerminalChord(ev2))
    }
  } finally {
    setPrefixArmedForTest(false)
  }
}

console.log('3) the same letters are ORDINARY shell input once disarmed:')
{
  for (const key of ['h', 'j', 'k', 'l', 'u', 'r', 'c', 'v']) {
    const ev2 = ev({ key, code: `Key${key.toUpperCase()}` })
    check(`bare ${key} reaches the shell`, !isReservedTerminalChord(ev2))
  }
  check('Ctrl+J stays reserved when not armed (newline chord)', isReservedTerminalChord(ev({ key: 'j', code: 'KeyJ', ctrlKey: true })))
}

console.log('4) keypress path behaves like keydown:')
{
  setPrefixArmedForTest(true)
  try {
    check('keypress j suppressed (the ^J newline killer)', isReservedTerminalChord(ev({ type: 'keypress', key: 'j', code: 'KeyJ' })))
  } finally {
    setPrefixArmedForTest(false)
  }
  check('keyup never suppressed', !isReservedTerminalChord(ev({ type: 'keyup' })))
}

if (failures) {
  console.error(`terminalKeys: ${failures} failure(s)`)
  process.exit(1)
}
console.log('terminalKeys: all checks passed')
