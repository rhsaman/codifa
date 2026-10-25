/**
 * Which pane the user is WORKING in, decided by their latest interaction —
 * not by `document.activeElement`.
 *
 * The Tauri webview is WebKit: clicking non-focusable content — a diff line, a
 * code line — does NOT move focus to `<body>` the way Blink does. The caret
 * stays in the input that had it (the composer, the sidebar search), so the
 * next keydown arrives with an unrelated target and `activeElement`. Reading
 * the pane from focus misbehaves both ways: the scroll hook declines (nothing
 * ever scrolls) and the sidebar's `j`/`k` steps the chat list from a stale
 * caret — pressing `j` in a git diff switched chats.
 *
 * Ownership is therefore a RACE between two intents, each with a timestamp:
 *
 *  - pane intent  (`regionAt`): a pointer press inside a registered pane
 *    region — "scroll what I clicked".
 *  - typing intent (`typingAt`): focus or a press on an editable element
 *    OUTSIDE every region — "I am about to type here".
 *
 * The NEWER intent wins. Clicking the transcript after typing scrolls it;
 * clicking the composer afterwards hands the letters back. A caret that was
 * never re-focused (the WebKit stale caret) is NOT a typing intent, so a pane
 * click keeps the keys until the user really returns to an input.
 *
 * The decision itself (`decideVimOwner`) is PURE — it takes an intent
 * snapshot and the pane/target nodes — so the whole policy is unit-testable
 * without a browser.
 */

import { isPrefixArmed } from './prefixState'

/** Regions that consume the bare vim keys (file viewer, git diff, chat
 *  transcript, …). */
const regions = new Set<HTMLElement>()

/** The pane the latest interaction landed in, or `null` when it happened
 *  outside every registered region (sidebar, terminal, dialogs, …). */
let activeRegion: HTMLElement | null = null

/** Interaction stamp of the latest press inside a registered region (0 =
 *  never). Only updated for presses INSIDE a region — a press on other chrome
 *  must not outvote an older pane click. */
let regionAt = 0

/** Interaction stamp of the latest focus/press on an editable element outside
 *  every region (0 = never). This is the "user is typing" beat. */
let typingAt = 0

/** Monotonic interaction counter. Wall-clock stamps cannot order two
 *  events reliably (same millisecond is common), so each folded interaction
 *  takes the next number — the newer intent is always strictly greater. */
let intentStamp = 0
const nextIntent = (): number => ++intentStamp

/** Whether the global listeners are installed. */
let installed = false

/** Selector for anything that receives and edits text. */
const EDITABLE =
  'input, textarea, select, [contenteditable="true" i], [contenteditable="" i], [contenteditable="plaintext-only" i]'

function contains(root: HTMLElement, el: Node | null): boolean {
  if (!el) return false
  try {
    return root.contains(el)
  } catch {
    return false
  }
}

function isEditable(el: Element | null): boolean {
  // `matches` lives on the element itself — no document needed, so editable
  // detection works in every realm (and in the plain-node tests).
  if (!el || typeof el.matches !== 'function') return false
  try {
    return el.matches(EDITABLE)
  } catch {
    return false
  }
}

/** Public form for the key hooks: is this keydown target a text field the
 *  letter belongs to? Typed letters ALWAYS win over a scroll. Exported so
 *  every bare-key listener shares the ONE editable selector. */
export function isEditableTarget(t: Node | null): boolean {
  return isEditable(t as Element | null)
}

/** Everything the ownership decision needs, read from the live document. */
export interface IntentSnapshot {
  /** The region of the latest pane click, or `null`. */
  region: HTMLElement | null
  /** When that click happened (0 = never). */
  regionAt: number
  /** When the user last focused/pressed an input outside every region. */
  typingAt: number
  /** The active element when it sits INSIDE a registered region — a pane
   *  holding its own caret (e.g. the viewer's find box) decides directly.
   *  This is the REGION containing the caret, not the caret itself; see
   *  `caret` for the focused element. */
  caretInRegion: HTMLElement | null
  /** The live focused element, wherever it sits. Editability must be judged
   *  on THIS, never on the region: a chat panel region contains an editable
   *  composer while the panel div itself is not editable. */
  caret: HTMLElement | null
  /** The active element when it is editable (wherever it sits). */
  caretEditable: HTMLElement | null
}

/** Read the current intent state + live caret positions into a snapshot. */
export function snapshotIntent(): IntentSnapshot {
  if (typeof document === 'undefined') {
    return { region: activeRegion, regionAt, typingAt, caretInRegion: null, caret: null, caretEditable: null }
  }
  const el = document.activeElement as HTMLElement | null
  const body =
    !el || el === document.body || el === document.documentElement
  let caretInRegion: HTMLElement | null = null
  if (!body && el) {
    for (const r of regions) {
      if (contains(r, el)) {
        caretInRegion = r
        break
      }
    }
  }
  return {
    region: activeRegion,
    regionAt,
    typingAt,
    caretInRegion,
    caret: body ? null : el,
    caretEditable: !body && el && isEditable(el) ? el : null,
  }
}

/** What the bare keys should do for `root`, given the intent snapshot. */
export type VimDecision = 'scroll' | 'typing' | null

/**
 * Does `root` get the bare keys now, is the user TYPING, or does nobody own
 * them (`null` — the key does whatever its default would)?
 *
 * Order matters: a caret genuinely inside THIS pane decides on its own
 * (editing an input inside the pane is typing, any other focus there is the
 * pane). Otherwise the newest of the two intents wins, and the stale-caret
 * case is exactly the race the timestamps resolve.
 */
export function decideVimOwner(
  st: IntentSnapshot,
  root: HTMLElement,
  target: Node | null,
): VimDecision {
  // 0) TYPING WINS UNCONDITIONALLY. If the live caret sits in an editable
  //    field, the user is composing text and the letter must reach that field
  //    — never the scroll container. This is a hard rule, not a race: the
  //    timestamp comparison below cannot be trusted because a keydown that
  //    lands in a textarea must type even when a pane click was stamped later
  //    (WebKit keeps the caret parked, so the click and the caret disagree).
  if (st.caretEditable) return 'typing'
  // 0b) Same rule for the event target itself: a keydown whose target is an
  //     input/textarea/contenteditable is text, whatever the intents say.
  if (isEditable(target as Element | null)) return 'typing'
  // 0c) A stale caret must NOT veto the click: when the pane click is the
  //     NEWER intent, it owns the keys even though the caret never left the
  //     composer. This is the normal click-a-message-then-j scroll case.
  const paneNewest = st.region === root && st.regionAt >= st.typingAt
  if (paneNewest) return 'scroll'
  // 1) The pane's own caret decides: editable inside it is typing (the
  //    viewer's find box keeps its letters), any other focused node is the
  //    pane. Only reached when typing focus is at least as new as any pane
  //    click, so an OLD caret parked in the composer cannot eat the keys
  //    after a newer click on the transcript.
  if (st.caretInRegion && (st.caretInRegion === root || contains(root, st.caretInRegion)) && st.typingAt >= st.regionAt) {
    // Editing INSIDE the pane is typing; any other focused node there means
    // the pane holds the keys. The EDITABLE check is on the focused element,
    // never on the region (a panel div is not editable; its find box is).
    return isEditable(st.caret) ? 'typing' : 'scroll'
  }
  // 2) An editable target somewhere else: typing only when the typing intent
  //    is the newer one — a stale WebKit caret (unchanged since before the
  //    pane click) must not veto the scroll the click called for. A TIE goes
  //    to the pane: two intents stamped in the same millisecond mean an
  //    instant type-then-click, and the click is what the user aims at.
  if (st.caretEditable || isEditable(target as Element | null)) {
    if (st.typingAt > st.regionAt) return 'typing'
    return st.region === root ? 'scroll' : null
  }
  // 3) Caret on `body` or plain chrome: the last-clicked pane owns the keys.
  return st.region === root ? 'scroll' : null
}

/** Duck-typed Element check: `instanceof` fails for nodes from another
 *  REALM (iframes, webviews) and for the plain objects in tests. */
function isNodeLike(t: Node | null): t is Node {
  return !!t && typeof (t as Node).contains === 'function'
}

/** Fold one interaction target into the intent. Exposed for tests.
 *
 *  `null` or a non-node press counts as plain chrome: it hands the keys back
 *  by clearing the pane intent. */
export function handleInteractionTarget(t: Node | null): void {
  if (isNodeLike(t)) {
    // EDITABILITY FIRST, before the region loop: a chat pane's region spans the
    // whole panel (so a click on the transcript is "the pane"), and that region
    // CONTAINS the composer. Testing the region first stamped a focus in the
    // composer as a pane interaction — `typingAt` never advanced, the pane
    // stayed the newest intent and bare `j`/`k` were consumed as scroll
    // instead of being typed. An editable target is typing, wherever it sits.
    if (isEditable(t as Element | null)) {
      typingAt = nextIntent()
      return
    }
    for (const root of regions) {
      if (contains(root, t)) {
        activeRegion = root
        regionAt = nextIntent()
        return
      }
    }
  }
  // Press on other chrome: nobody owns the keys any more. `regionAt` is left
  // alone — a press outside never outvotes the pane click that came before.
  activeRegion = null
}

function onPointerDown(e: PointerEvent | MouseEvent): void {
  if (isPrefixArmed()) return
  handleInteractionTarget(e.target as Node | null)
}

function onFocusIn(e: FocusEvent): void {
  if (isPrefixArmed()) return
  handleInteractionTarget(e.target as Node | null)
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  // Capture: xterm stops hidden pointer events, and the press only READS its
  // target, so seeing it everywhere is safe.
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('mousedown', onPointerDown, true)
  window.addEventListener('focusin', onFocusIn, true)
}

/** Register a pane region (a scroll-pane root). Idempotent — re-mounts of the
 *  same node are no-ops. Registering does NOT make the pane active; an
 *  interaction does, so a freshly booted app never eats a keystroke. */
export function registerVimRegion(root: HTMLElement): void {
  install()
  regions.add(root)
}

/** Unregister on unmount; the active pointer must never dangle onto a dead
 *  node, so clear it when it pointed here. */
export function unregisterVimRegion(root: HTMLElement): void {
  regions.delete(root)
  if (activeRegion === root) activeRegion = null
}

/** Do any of the registered regions currently own the bare keys? The
 *  sidebar's chat list stands down while this is true — even though a stale
 *  caret may sit inside the sidebar, WebKit-style. */
export function isVimRegionActive(): boolean {
  const st = snapshotIntent()
  if (!st.region) return false
  // A newer typing intent beats the pane (the user went back to an input); a
  // stale caret does not.
  return st.regionAt >= st.typingAt
}

/** Programmatic arrival — `Ctrl+X l`, or the pane the user just opened from a
 *  store action. Treated like a press on that pane. `null` hands the keys
 *  back. */
export function markVimRegion(root: HTMLElement | null): void {
  activeRegion = root
  if (root) regionAt = Date.now()
}

/** The pane the user last interacted with (the pointer/keyboard intent), or
 *  `null` when no pane was ever clicked. `activePane()` reads this on the
 *  caret-on-`<body>` state: in WebKit a click on a transcript/code line does
 *  not move focus, so \u201cwhere is the user\u201d cannot come from
 *  `activeElement` there. */
export function paneOwner(): HTMLElement | null {
  return activeRegion
}
