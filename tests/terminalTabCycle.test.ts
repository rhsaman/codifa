// Regression guard: the tab chord INSIDE a right-pane terminal looked dead.
//
// The step was handed `shownViewerTabId` as "which tab the strip is on", but
// that function only knows TAB_STRIP_KINDS — and a terminal is deliberately not
// one of them (dock pages draw no top-strip row). It answered `null`, so every
// step started at `list[0]`: pressing `]` on the second terminal jumped to the
// FIRST one and pressing again appeared to do nothing. The terminal strip's
// active tab is the store's activeId when it IS one of the scope's terminals.
//
// Pure module (no store at import): runs in plain node.
import { activeTerminalTabId, nextTerminalTabId, visibleTabs } from '../src/lib/viewerTabs'
import type { ViewerScope, ViewerTab } from '../src/lib/viewerTabs'

export {}
let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const scope: ViewerScope = { wsKey: 'ws1', chatId: 'c1' }
function term(id: string, ws: string = 'ws1'): ViewerTab {
  return { id, kind: 'terminal', title: id, wsKey: ws }
}

const tabs: ViewerTab[] = [
  { id: 'file:ws1:/a.ts', kind: 'file', title: 'a.ts', wsKey: 'ws1' },
  term('terminal:ws1:1'),
  term('terminal:ws1:2'),
  term('terminal:ws1:3'),
  term('terminal:other:9', 'other'),
]

console.log('1) the strip lists only this scope’s terminals:')
{
  const list = visibleTabs(tabs, scope).filter((t) => t.kind === 'terminal').map((t) => t.id)
  check('two-scope filter keeps ws1 terminals only', list.join(',') === 'terminal:ws1:1,terminal:ws1:2,terminal:ws1:3', list)
}

console.log('2) activeTerminalTabId answers what shownViewerTabId cannot:')
{
  check('active terminal is recognised', activeTerminalTabId(tabs, scope, 'terminal:ws1:2') === 'terminal:ws1:2')
  check('a file tab is not a terminal', activeTerminalTabId(tabs, scope, 'file:ws1:/a.ts') === null)
  check('another workspace’s terminal is out of scope', activeTerminalTabId(tabs, scope, 'terminal:other:9') === null)
  check('null active stays null', activeTerminalTabId(tabs, scope, null) === null)
}

console.log('3) the step moves from where the strip really is (the reported bug):')
{
  const start = activeTerminalTabId(tabs, scope, 'terminal:ws1:2')
  check('next from the middle → third', nextTerminalTabId(tabs, scope, start, 1) === 'terminal:ws1:3')
  check('prev from the middle → first', nextTerminalTabId(tabs, scope, start, -1) === 'terminal:ws1:1')
  check('next from the last wraps to the first', nextTerminalTabId(tabs, scope, 'terminal:ws1:3', 1) === 'terminal:ws1:1')
  check('a shell tab NOT in this scope starts at the first', nextTerminalTabId(tabs, scope, activeTerminalTabId(tabs, scope, 'terminal:other:9'), 1) === 'terminal:ws1:1')
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nTerminal tab cycle passes ✅')
