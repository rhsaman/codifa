// Ctrl+X pane navigation (src/lib/paneCycle.ts) — the pure direction logic.
//
// Movement mirrors the screen layout, not a linear ring:
//   h/l  sideways — sidebar ↔ chat ↔ viewer pane
//   k/j  vertical — any pane → terminal (the terminal sits BELOW the content)
// A closed pane is still a valid destination: the caller opens it on arrival.
import { APP_PANES, cyclePane } from '../src/lib/paneCycle'

let failures = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (ok) {
    console.log('  ok  ', label)
  } else {
    failures++
    console.log('  FAIL', label, extra !== undefined ? extra : '')
  }
}

console.log('1) the panes are the four visible regions:')
{
  check('sidebar, chat, viewer, terminal', APP_PANES.join() === 'sidebar,chat,viewer,terminal', APP_PANES)
}

console.log('2) l moves right, h moves left:')
{
  check('l from sidebar → chat', cyclePane('sidebar', 'l') === 'chat')
  check('l from chat → viewer', cyclePane('chat', 'l') === 'viewer')
  check('h from viewer → chat', cyclePane('viewer', 'h') === 'chat')
  check('h from chat → sidebar', cyclePane('chat', 'h') === 'sidebar')
}

console.log('3) j/k reach the terminal below the chat column:')
{
  check('j from chat → terminal', cyclePane('chat', 'j') === 'terminal')
  check('k from chat → terminal', cyclePane('chat', 'k') === 'terminal')
  check('k from terminal → chat', cyclePane('terminal', 'k') === 'chat')
  check('j from terminal stays on terminal (nothing below it)', cyclePane('terminal', 'j') === 'terminal')
}

console.log('4) a closed pane is still a valid target (the caller opens it):')
{
  // Nothing to check about flags here — the signature has none. This locks the
  // DECISION that closed panes are not filtered out of the mapping.
  check('j from chat is the terminal even if it is closed', cyclePane('chat', 'j') === 'terminal')
  check('l from chat is the viewer even if it is closed', cyclePane('chat', 'l') === 'viewer')
}

console.log('5) j/k reach the terminal from the full-height panes too:')
{
  // The sidebar and the right pane span the full window height, so their
  // "below" is the bottom panel — the same hop the chat column makes.
  check('j from sidebar → terminal', cyclePane('sidebar', 'j') === 'terminal')
  check('k from sidebar → terminal', cyclePane('sidebar', 'k') === 'terminal')
  check('j from viewer → terminal', cyclePane('viewer', 'j') === 'terminal')
  check('k from viewer → terminal', cyclePane('viewer', 'k') === 'terminal')
}

console.log('6) a direction with no neighbour stays put (key falls through):')
{
  check('h from sidebar stays on sidebar', cyclePane('sidebar', 'h') === 'sidebar')
  check('l from viewer stays on viewer', cyclePane('viewer', 'l') === 'viewer')
  check('j from terminal stays on terminal', cyclePane('terminal', 'j') === 'terminal')
}

console.log('7) the terminal always leads back to the chat:')
{
  check('h from terminal → chat', cyclePane('terminal', 'h') === 'chat')
  check('l from terminal → chat', cyclePane('terminal', 'l') === 'chat')
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall paneCycle checks passed')
