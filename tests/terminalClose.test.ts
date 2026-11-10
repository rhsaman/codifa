// Ctrl+W / Cmd+W inside a terminal (src/lib/terminalClose.ts).
//
// Reported bug: in the RIGHT-pane terminal, Ctrl+W closed the WHOLE terminal
// (the pane fell back to the Todos page) instead of that one tab. The reason
// was that the handler only looked for the bottom panel's `.terminal-panel`,
// and a pane terminal lives in `.terminal-tab-panel` — so the press was read as
// "close the active viewer tab" and the pane lost its terminal entirely.

import { terminalCloseChord, terminalHostFor } from '../src/lib/terminalClose'

type Check = [name: string, ok: boolean]
const checks: Check[] = []
function ok(name: string, cond: boolean) {
  checks.push([name, cond])
}

/** Element double whose `closest` answers for the selectors it is asked about. */
function el(...classes: string[]) {
  return {
    closest(sel: string) {
      return classes.some((c) => sel.includes('.' + c)) ? this : null
    },
  }
}

console.log('۱) terminalHostFor — کدام میزبان ترمینال؟')
{
  const bottom = el('terminal-panel')
  const pane = el('terminal-tab-panel')
  ok('bottom panel → bottom', terminalHostFor(bottom) === 'bottom')
  ok('right-pane terminal → pane', terminalHostFor(pane) === 'pane')
  ok('caret outside every terminal → null', terminalHostFor(el('app')) === null)
  ok('null target → null', terminalHostFor(null) === null)
  // The xterm textarea itself carries no host class; its ANCESTOR does. The
  // real `closest` walks up, so the double above stands for that walk.
  ok('falls back to document.activeElement', terminalHostFor(el('app'), pane) === 'pane')
  ok('idle caret (<body>) with a pane picker → pane', terminalHostFor(null, pane) === 'pane')
  // Bottom wins when both could match (the panel wraps its own strip).
  ok('bottom beats pane', terminalHostFor(el('terminal-panel', 'terminal-tab-panel')) === 'bottom')
}

console.log('۲) closeFocusedTerminal — Ctrl+W در ترمینال سمت راست باید تب را ببندد، نه کل ترمینال')
{
  const apple = (ctrl = false, meta = false, shift = false) => ({
    key: 'w',
    ctrlKey: ctrl,
    metaKey: meta,
    shiftKey: shift,
    altKey: false,
  })
  // --- macOS ---
  ok('mac · bottom · Cmd+W closes', terminalCloseChord('bottom', apple(false, true), true))
  ok('mac · bottom · Ctrl+W closes too', terminalCloseChord('bottom', apple(true, false), true))
  ok('mac · pane · Cmd+W closes THAT tab', terminalCloseChord('pane', apple(false, true), true))
  ok(
    'mac · pane · Ctrl+W is SHELL input (^W), never a close',
    !terminalCloseChord('pane', apple(true, false), true),
  )
  ok('mac · pane · Cmd+Shift+W does not close', !terminalCloseChord('pane', apple(false, true, true), true))
  ok('mac · pane · Alt (Option) variant does not close', !terminalCloseChord('pane', { ...apple(false, true), altKey: true }, true))
  // --- Windows / Linux ---
  ok('win · bottom · Ctrl+W closes', terminalCloseChord('bottom', apple(true, false), false))
  ok('win · pane · Ctrl+Shift+W closes that tab', terminalCloseChord('pane', apple(true, false, true), false))
  ok(
    'win · pane · plain Ctrl+W is SHELL input, never a close',
    !terminalCloseChord('pane', apple(true, false), false),
  )
  ok('win · pane · Cmd+W does nothing', !terminalCloseChord('pane', apple(false, true), false))
  // --- shape guards ---
  ok('no modifier → never closes', !terminalCloseChord('bottom', apple(), true))
  ok('another key → never closes', !terminalCloseChord('pane', { ...apple(false, true), key: 'e' }, true))
  ok('uppercase W still reads as w', terminalCloseChord('pane', { ...apple(false, true), key: 'W' }, true))
}

let failed = 0
for (const [name, cond] of checks) {
  if (!cond) {
    failed++
    console.log('FAIL ' + name)
  }
}
console.log(`terminalClose: ${checks.length - failed}/${checks.length} passed`)
if (failed) process.exit(1)
