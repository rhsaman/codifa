// Unit tests for webkitDeadKey: the WebKit dead-key repair that fixes
// "extra characters appear by themselves" while typing in the terminal.
// Run: npx esbuild src/lib/webkitDeadKey.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-webkitDeadKey.mjs && \
//        node src/lib/.tmp-webkitDeadKey.mjs
// (also registered in tests/run-frontend.sh)

import { WebKitDeadKeyRepair } from './webkitDeadKey'

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, extra ?? '')
  }
}

function fresh() {
  const emitted: string[] = []
  const repair = new WebKitDeadKeyRepair((data) => emitted.push(data))
  return { repair, emitted }
}

const keydown = (key: string) => ({ type: 'keydown', key })
const keypress = (charCode: number) => ({ type: 'keypress', charCode })

// ---------------------------------------------------------------------------
// The exact WKWebView sequence from xterm.js#5894:
//   compositionstart → Dead keydown → compositionend "~" → synthetic keypress
//   (charCode 126) → collapsed keydown "~/"
// ---------------------------------------------------------------------------
console.log('WKWebView dead-key sequence (~ then /)')
{
  const { repair, emitted } = fresh()
  repair.noteCompositionStart()
  repair.noteKeyDown(keydown('Dead'))
  repair.noteCompositionEnd('~')

  check(
    'the synthetic keypress repeating the dead char is suppressed',
    repair.handle(keypress(126)) === true,
  )
  check('suppressing it emits nothing extra', emitted.length === 0, emitted)
  check(
    'the collapsed keydown is repaired (not dropped)',
    repair.handle(keydown('~/')) === true,
  )
  check('the real key is sent to the pty exactly once', emitted.join('') === '/', emitted)
}

// ---------------------------------------------------------------------------
// WebKit may deliver the two offending events in either order; the repair must
// not depend on that (a handled branch never clears the state).
// ---------------------------------------------------------------------------
console.log('reverse order (keydown before keypress)')
{
  const { repair, emitted } = fresh()
  repair.noteCompositionStart()
  repair.noteKeyDown(keydown('Dead'))
  repair.noteCompositionEnd('~')

  check('collapsed keydown handled first', repair.handle(keydown('~/')) === true)
  check('rescued key sent once', emitted.join('') === '/', emitted)
  check(
    'the following synthetic keypress is still suppressed',
    repair.handle(keypress(126)) === true,
  )
  check('no further output', emitted.join('') === '/', emitted)
}

// ---------------------------------------------------------------------------
// Combining sequels (~ then a → ã) are NOT affected by the upstream bug and
// must stay untouched.
// ---------------------------------------------------------------------------
console.log('combining sequel stays untouched')
{
  const { repair, emitted } = fresh()
  repair.noteCompositionStart()
  repair.noteKeyDown(keydown('Dead'))
  repair.noteCompositionEnd('ã')

  check('an ordinary keydown is left to xterm', repair.handle(keydown('a')) === false)
  check('nothing was emitted', emitted.length === 0, emitted)
  check(
    'and a later press of the same charCode is not swallowed',
    repair.handle(keypress(227)) === false,
  )
}

// ---------------------------------------------------------------------------
// Chromium hosts (the removed Electron build, VS Code, a dev browser) never
// fire a Dead keydown inside the composition lifecycle, so the repair must
// self-disable instead of eating legitimate keypresses.
// ---------------------------------------------------------------------------
console.log('Chromium host self-disables')
{
  const { repair, emitted } = fresh()
  repair.noteCompositionStart()
  repair.noteCompositionEnd('~')
  check('keypress is not suppressed', repair.handle(keypress(126)) === false)
  check('keydown is not repaired', repair.handle(keydown('~/')) === false)
  check('nothing was emitted', emitted.length === 0, emitted)
}

// ---------------------------------------------------------------------------
// Plain typing with no composition at all must never be touched.
// ---------------------------------------------------------------------------
console.log('plain typing untouched')
{
  const { repair, emitted } = fresh()
  for (const ch of ['a', 'l', 's', 'Enter', 'Backspace', 'ArrowUp']) {
    check(`keydown ${ch} ignored`, repair.handle(keydown(ch)) === false)
  }
  check('keypress ignored', repair.handle(keypress(97)) === false)
  check('nothing was emitted', emitted.length === 0, emitted)
}

// ---------------------------------------------------------------------------
// State must not leak: a new composition starts clean, and the repair does not
// fire twice for the same dead-key event.
// ---------------------------------------------------------------------------
console.log('state does not leak between compositions')
{
  const { repair, emitted } = fresh()
  repair.noteCompositionStart()
  repair.noteKeyDown(keydown('Dead'))
  repair.noteCompositionEnd('~')
  check('first keypress suppressed', repair.handle(keypress(126)) === true)
  repair.noteCompositionStart()
  check(
    'a fresh composition is not still suppressed',
    repair.handle(keypress(126)) === false,
  )

  const second = fresh()
  second.repair.noteCompositionStart()
  second.repair.noteKeyDown(keydown('Dead'))
  second.repair.noteCompositionEnd('^')
  check('AltGraph-less dead caret handled', second.repair.handle(keydown('^d')) === true)
  check('trailing char rescued', second.emitted.join('') === 'd', second.emitted)
  check(
    'the same event is not repaired twice',
    second.repair.handle(keydown('^d')) === false,
  )

  const alt = fresh()
  alt.repair.noteCompositionStart()
  alt.repair.noteKeyDown(keydown('AltGraph'))
  alt.repair.noteCompositionEnd('´')
  check('AltGraph marks a dead composition too', alt.repair.handle(keydown('´e')) === true)
  check('trailing char rescued', alt.emitted.join('') === 'e', alt.emitted)
  check('unused', emitted.length === 0, emitted)
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall good')
