/**
 * Which TAB STRIP the Cmd/Ctrl+Shift+[ / ] chord steps (see App.tsx
 * `cycleFocusedTabs`, src/lib/paneFocus.ts `terminalTabHost`).
 *
 * The reported bug: with the caret in the RIGHT-pane terminal, the chord
 * changed the BOTTOM panel's shells instead of the terminal tabs the user was
 * looking at. `activePane()` reports 'terminal' for both hosts, so a single
 * 'terminal' branch sent every terminal focus to `coder:cycle-terminal` — which
 * only the bottom panel listens to. The strips are NOT interchangeable:
 *
 *   - bottom panel  → its own shells (`coder:cycle-terminal`)
 *   - right-pane tab → the viewer's strip, restricted to terminal tabs
 *
 * Plain node: the fake nodes duck-type the `element`/`matches`/`closest`
 * surface these modules read.
 */
import { activePane, terminalTabHost } from '../src/lib/paneFocus'
import { useViewerTabs } from '../src/lib/viewerTabs'

export {}

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

/** A DOM element double: `matches(selector)` is true when the selector list it
 *  is asked for names this element's tag — `tag` carries `.class` / `#id`
 *  decoration (`'div.terminal-panel'`), so the comparison is `div` against the
 *  bare tag AND the whole decorated tag against the selector. `closest` walks
 *  up to `parent`. */
function el(tag: string, parent: any = null): any {
  // `'div.terminal-panel'` → `div`; `'.terminal-panel'` (a class-only selector
  // in our own vocabulary) → ``. Only LEADING text up to the first decorator is
  // the tag name.
  const bare = tag.includes('.') || tag.includes('#') ? tag.slice(0, tag.search(/[.#]/)) : tag
  const options = tag
    .split(',')
    .map((s: string) => s.trim())
  const node: any = {
    tag,
    tagName: bare.toUpperCase(),
    parent,
    matches(sel: string): boolean {
      const wanted = sel
        .split(',')
        .map((s: string) => s.trim())
      // A selector names this element when it equals the decorated tag, or
      // equals the bare tag, or ends with the decorated tag's class part
      // (`'.terminal-panel'` vs `'div.terminal-panel'`).
      return wanted.some(
        (w: string) =>
          w === tag ||
          w === bare ||
          (tag.includes('.') && w === '.' + tag.split('.')[1]),
      ) || options.some((o: string) => wanted.includes(o))
    },
    closest(sel: string): any {
      let n: any = node
      while (n) {
        if (typeof n.matches === 'function' && n.matches(sel)) return n
        n = n.parent
      }
      return null
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  return node
}

const g = globalThis as any
/** The stub's mutable document slot (see tests/tabCycleFocus.stub.ts). */
const docs = g.__stubDoc as { doc: any }
const realGetState = (useViewerTabs as any).getState

/** Install a live caret; `body`/`html` are the "idle" sentinels. Written through
 *  the injected holder so the modules — which hold no snapshot — see it. */
function caret(active: any): void {
  docs.doc = { activeElement: active, body: el('body'), documentElement: el('html'), querySelector: () => null }
}

/** Make the idle fallback (`activePane`) see an open viewer rail showing one tab. */
function viewerRail(activeId: string): void {
  ;(useViewerTabs as any).getState = () => ({
    paneOpen: true,
    activeId,
    tabs: [{ id: activeId, kind: activeId.split(':')[0] }],
  })
}

console.log("1) caret in the BOTTOM panel's shell → the bottom host:")
{
  const panel = el('div.terminal-panel')
  caret(el('textarea.xterm-helper-textarea', el('div', panel)))
  check('bottom host owns the chord', terminalTabHost() === 'bottom')
  check('activePane agrees: terminal', activePane() === 'terminal')
}

console.log('2) caret in a RIGHT-pane terminal tab → the pane host (the reported bug):')
{
  const pane = el('div.viewer-split')
  const tabPanel = el('div.terminal-tab-panel', pane)
  caret(el('textarea.xterm-helper-textarea', el('div', tabPanel)))
  check('pane host, NOT bottom', terminalTabHost() === 'pane')
  check('activePane says terminal for both hosts (why a single branch was wrong)', activePane() === 'terminal')
}

console.log('3) idle caret (WebKit leaves <body>) still resolves to the right strip:')
{
  caret(null)
  viewerRail('terminal:1')
  check('idle caret + terminal tab in the rail → pane host', terminalTabHost() === 'pane')
  viewerRail('file:a.ts')
  check('idle caret + file tab in the rail → no terminal strip', terminalTabHost() === null)
  check('…and activePane reads the viewer', activePane() === 'viewer')
}

console.log('4) chat and sidebar carets own no terminal strip:')
{
  const chat = el('div.chat-group')
  caret(el('textarea.chat-input', chat))
  check('composer → not a terminal', terminalTabHost() === null)
  check('composer → chat pane', activePane() === 'chat')
  const sidebar = el('div.sidebar')
  caret(el('input.sidebar-search-input', sidebar))
  check('sidebar → not a terminal', terminalTabHost() === null)
  check('sidebar → sidebar pane', activePane() === 'sidebar')
}

;(useViewerTabs as any).getState = realGetState
docs.doc = undefined

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nAll host-routing cases pass ✅')
