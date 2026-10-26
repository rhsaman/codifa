// Unit tests for the chat mode keys (src/lib/chatNormalMode.ts).
//
// The two decisions are pure, so the interesting cases are the guards: a bare
// `i` must never steal a keystroke from a field that already receives text, and
// `Ctrl+C` must never break a real COPY.
import { shouldEnterInsert, shouldLeaveInsert } from '../src/lib/chatNormalMode.ts'
import { physicalKey } from '../src/lib/shortcuts.ts'

let failures = 0
function check(name: string, ok: boolean) {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}`)
  }
}

const enter = (o: Partial<Parameters<typeof shouldEnterInsert>[0]> = {}) =>
  shouldEnterInsert({
    targetIsEditable: false,
    targetIsComposer: false,
    dialogOpen: false,
    chordActive: false,
    ...o,
  })

console.log('1) `i` enters the composer only from a non-typing chat:')
{
  check('plain chat → insert', enter())
  check('already in the composer → types an "i"', !enter({ targetIsComposer: true }))
  check('another text field → types', !enter({ targetIsEditable: true }))
  check('dialog open → untouched', !enter({ dialogOpen: true }))
  check('Ctrl+X prefix armed → untouched', !enter({ chordActive: true }))
}

const leave = (o: Partial<Parameters<typeof shouldLeaveInsert>[0]> = {}) =>
  shouldLeaveInsert({
    caretInComposer: true,
    selection: '',
    dialogOpen: false,
    ...o,
  })

console.log('2) `Ctrl+C` leaves insert only when there is nothing to copy:')
{
  check('empty selection → back to the transcript', leave())
  check('whitespace selection is still empty', leave({ selection: '   ' }))
  check('a real selection stays a COPY', !leave({ selection: 'hello' }))
  check('caret outside the composer → untouched', !leave({ caretInComposer: false }))
  check('dialog open → untouched', !leave({ dialogOpen: true }))
  // Ctrl+C only MOVES the caret, it never stops the turn — so a streaming chat
  // must not veto it (it used to: Ctrl+C did nothing while the model streamed).
  // The function takes no busy input any more; a stale caller still passing one
  // must be ignored, not honoured.
  const legacy = shouldLeaveInsert as (o: Record<string, unknown>) => boolean
  check(
    'streaming turn (legacy composerBusy) does NOT veto',
    legacy({ caretInComposer: true, selection: '', dialogOpen: false, composerBusy: true }),
  )
}

console.log('3) the strokes survive a non-Latin (Persian) layout:')
{
  // On an fa layout the SAME physical keys report Persian characters in
  // `e.key` (I → "ی", C → "ز"), so matching on `e.key` silently broke both
  // strokes. `physicalKey` reads `e.code` and stays Latin.
  const physical = (code: string, key: string) => physicalKey({ code, key })
  check('fa layout: KeyI → "i"', physical('KeyI', 'ی') === 'i')
  check('fa layout: KeyC → "c"', physical('KeyC', 'ز') === 'c')
  check('the fa character itself would NOT match', physical('KeyI', 'ی') !== 'ی')
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nchatNormalMode: all checks passed')
