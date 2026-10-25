// The terminal chord guard (src/lib/terminalKeys.ts).
//
// Two regression classes:
//  1. App chords (Ctrl/Cmd+J/W/M/X) must never reach the shell as ^J/^M/^X.
//  2. The Ctrl+X prefix: the ARMING key is already reserved (x), but the SECOND
//     key arrives WITHOUT any modifier inside the terminal, and xterm would
//     send it to the shell exactly as typed — ^K kills the half-typed line,
//     which is why `Ctrl+X k` (hop to chat) looked broken while the caret was
//     in the terminal. The guard must suppress the second key while the prefix
//     is armed, and let the very same letters through as normal shell input
//     once it is not.
import { isReservedTerminalChord } from '../src/lib/terminalKeys'
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
  check('plain k NOT reserved', !isReservedTerminalChord(ev()))
  check('Shift+J not reserved (shift chords are shell input)', !isReservedTerminalChord(ev({ key: 'J', code: 'KeyJ', shiftKey: true })))
}

console.log('2) the Ctrl+X SECOND key while the prefix is armed:')
{
  setPrefixArmedForTest(true)
  try {
    for (const key of ['h', 'j', 'k', 'l', 'u', 'r', 'c', 'v']) {
      const ev2 = ev({ key, code: `Key${key.toUpperCase()}` })
      check(`bare ${key} suppressed while armed`, isReservedTerminalChord(ev2))
    }
    check('Space suppressed while armed (Ctrl+X Space = voice)', isReservedTerminalChord(ev({ key: ' ', code: 'Space' })))
    check('a non-prefix letter stays shell input', !isReservedTerminalChord(ev({ key: 'a', code: 'KeyA' })))
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
}

console.log('4) keypress path behaves like keydown:')
{
  setPrefixArmedForTest(true)
  try {
    check('keypress k suppressed (the ^K killer)', isReservedTerminalChord(ev({ type: 'keypress' })))
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
