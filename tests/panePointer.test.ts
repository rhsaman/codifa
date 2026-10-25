// Bare-key ownership by interaction intent (src/lib/panePointer.ts).
//
// Regression guard for the WebKit focus trap: the Tauri webview keeps the
// caret in a stale input after the user clicks a diff line, so reading the
// pane from `activeElement` made `j` switch sidebar chats (or type into the
// composer) instead of scrolling. The decision must come from the LAST
// interaction. `decideVimOwner` is the exact call the scroll hook makes, and
// the module guards every document access, so these tests run in plain node
// with fake region objects.
import {
  decideVimOwner,
  handleInteractionTarget,
  snapshotIntent,
  registerVimRegion,
  unregisterVimRegion,
} from '../src/lib/panePointer'

export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

/** Minimal node double: `contains` is the only method the module uses
 *  (both for the target check and the region-containment test). The `token`
 *  is the identity a probe must carry to count as "inside" this node. */
function fakeNode(name: string): any {
  const token = { name }
  return {
    __name: name,
    token,
    contains: (el: any) => el?.__owner === token,
  }
}
/** A probe node living "inside" `owner`; it carries its own stubbed
 *  `contains` so `isNodeLike` (duck-typing) accepts it as a Node. */
function probe(owner: any): any {
  return {
    __owner: owner?.token,
    contains: (el: any) => el === null,
  }
}

/** The decision the hook hands its root and the event target to. */
function ownerOf(root: any, target: any): 'scroll' | 'typing' | null {
  return decideVimOwner(snapshotIntent(), root, target)
}

console.log('1) a press inside a pane region makes that pane own the keys:')
{
  const pane = fakeNode('viewer')
  registerVimRegion(pane)
  handleInteractionTarget(probe(pane))
  check('pane owns after press', ownerOf(pane, null) === 'scroll')
  const other = fakeNode('other')
  check('a second pane is NOT active', ownerOf(other, null) !== 'scroll')
}

console.log('2) an interaction outside every region hands the keys back:')
{
  const pane = fakeNode('viewer')
  registerVimRegion(pane)
  handleInteractionTarget(probe(pane))
  handleInteractionTarget(null)
  check('null press clears ownership', ownerOf(pane, null) !== 'scroll')
  handleInteractionTarget(probe(pane))
  handleInteractionTarget(fakeNode('somewhere-else'))
  check('press elsewhere clears ownership', ownerOf(pane, null) !== 'scroll')
}

console.log('3) unregistering the active region ends its ownership:')
{
  const pane = fakeNode('pane')
  registerVimRegion(pane)
  handleInteractionTarget(probe(pane))
  check('owns before unregister', ownerOf(pane, null) === 'scroll')
  unregisterVimRegion(pane)
  check('ownership gone after unregister', ownerOf(pane, null) !== 'scroll')
}

console.log('4) TYPING IS ABSOLUTE — a pane click never steals a text field:')
{
  // The WebKit sequence: type in the composer, then click a diff line. The
  // caret never left the composer. The letter must go to the COMPOSER: a
  // keydown that lands in a text field is text, whatever the click stamped —
  // the timestamp race is exactly what used to eat `j`/`k` while typing.
  const pane = fakeNode('diff')
  registerVimRegion(pane)
  // An editable stub: `matches` answers the module's EDITABLE selector, the
  // same method a real DOM element carries.
  const composer: any = {
    token: {},
    contains: () => false,
    matches: () => true,
  }
  handleInteractionTarget(composer) // typing intent, now
  handleInteractionTarget(probe(pane)) // pane click, later
  check(
    'a pane click does NOT steal the keys from a text field',
    ownerOf(pane, composer) === 'typing',
  )
  // And with no caret in a field at all, the pane click owns again — this is
  // the normal click-a-message-then-scroll case.
  check(
    'the pane still owns when no text field holds the caret',
    ownerOf(pane, null) === 'scroll',
  )
}

console.log('5) a region registered LATER must not inherit a stale pointer:')
{
  const a = fakeNode('a')
  const b = fakeNode('b')
  registerVimRegion(a)
  handleInteractionTarget(probe(a))
  registerVimRegion(b)
  check('registering alone activates nothing', ownerOf(b, null) !== 'scroll')
  handleInteractionTarget(probe(b))
  check('press on b activates b only', ownerOf(b, null) === 'scroll')
}

console.log('6) just registering a background pane never steals the keys:')
{
  handleInteractionTarget(null)
  const bg = fakeNode('background')
  registerVimRegion(bg)
  check('registration is inert', ownerOf(bg, null) !== 'scroll')
}

if (failures) {
  console.error(`panePointer: ${failures} failure(s)`)
  process.exit(1)
}
console.log('panePointer: all checks passed')
