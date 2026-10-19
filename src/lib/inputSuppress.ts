/**
 * Keyboard-suggestion suppression (Settings → General → Keyboard suggestions).
 *
 * macOS/WebKit and Chromium help by default: they autocorrect words, capitalise
 * sentences, underline "misspellings" and (macOS 14.2+) predict the next words
 * inline. Inside a coding tool that rewrites identifiers, file paths and shell
 * commands mid-keystroke — exactly the "the keyboard changes what I type"
 * complaint — so the app opts out per field by stamping the explicit
 * "no suggestions" attributes:
 *
 *   autocomplete="off"   no autofill / completion dropdown
 *   autocorrect="off"    no WebKit text replacement
 *   autocapitalize="off" no automatic capitalisation
 *   spellcheck="false"   no red squiggles + suggestion menu
 *
 * The attributes are applied to the live DOM instead of through JSX props for
 * three reasons: React props only reach elements the renderer owns, while
 * xterm's hidden input and the clipboard sink are created imperatively; the
 * attribute set lives in one place instead of ~40 call sites; and switching the
 * setting back on can restore the exact values that were there before (see
 * `restore`), which props alone cannot do after the fact.
 *
 * Coverage is eager on install / setting change (one full sweep) plus lazy on
 * focus (a capture-phase `focusin` listener), which catches every field mounted
 * later. Imperative widgets that own their input should call `suppressField()`
 * right after creating it — `TerminalPanel` does that for xterm's textarea,
 * which ships `autocorrect/autocapitalize/spellcheck` off but NOT
 * `autocomplete` (that gap is where macOS inline predictions come from).
 *
 * Turning the setting OFF restores each touched field to its original
 * attributes, so the toggle is fully reversible and never fights React: a prop
 * like `spellCheck={false}` is re-applied by the next re-render, and attributes
 * that were absent are removed again rather than left as `"off"`.
 *
 * Note: macOS's system-wide "Show inline predictive text" (System Settings →
 * Keyboard → Text Input → Edit…) is an OS feature outside the webview; no DOM
 * attribute reaches it. Everything WebKit/Chromium drives inside the webview is
 * covered here.
 */

/**
 * The attributes we stamp, in the order they are applied. Declared as a list
 * (not an object) so the `WeakMap` bookkeeping below can reuse the same keys.
 */
const SUPPRESS_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ['autocomplete', 'off'],
  ['autocorrect', 'off'],
  ['autocapitalize', 'off'],
  ['spellcheck', 'false'],
]

/**
 * Input types that never take free text, so suggestions are meaningless (and
 * `autocapitalize` on a checkbox would be nonsense).
 *
 * `password` is skipped on purpose: the only password fields in the app are API
 * keys / OAuth secrets, which already opt out in JSX, and leaving them alone
 * keeps platform password managers working for them.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'hidden',
  'password',
  'file',
  'checkbox',
  'radio',
  'range',
  'color',
  'button',
  'submit',
  'reset',
  'image',
])

/** The fields worth stamping: text containers only. */
const FIELD_SELECTOR = 'textarea, input, [contenteditable]'

/**
 * Original attribute values per stamped element, so disabling the setting is
 * lossless. `null` records "the attribute was not there at all". A `WeakMap`
 * keeps this from pinning detached panels in memory while the app streams.
 */
const originals = new WeakMap<Element, Record<string, string | null>>()

let installed = false
let enabled = false

/** True for elements the user can type free text into. */
function isTextField(el: Element | null | undefined): boolean {
  if (!el || el.nodeType !== 1) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') {
    // `readonly` covers the off-screen clipboard sink (src/lib/clipboard.ts).
    return (el as HTMLTextAreaElement).readOnly !== true
  }
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement
    if (input.readOnly === true || input.disabled === true) return false
    const type = (input.type || el.getAttribute('type') || 'text').toLowerCase()
    return !NON_TEXT_INPUT_TYPES.has(type)
  }
  // Rich-text hosts: none in the app today, but an imperative editor mounted
  // later would otherwise keep autocorrect.
  return (el as HTMLElement).isContentEditable === true
}

/** Apply the suppression attributes, remembering what was there before. */
function stamp(el: Element): void {
  if (!originals.has(el)) {
    const prev: Record<string, string | null> = {}
    for (const [name] of SUPPRESS_ATTRS) prev[name] = el.getAttribute(name)
    originals.set(el, prev)
  }
  for (const [name, value] of SUPPRESS_ATTRS) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
}

/** Put back exactly what was there before this module touched the element. */
function restore(el: Element): void {
  const prev = originals.get(el)
  if (!prev) return
  for (const [name] of SUPPRESS_ATTRS) {
    const value = prev[name]
    if (value === null) {
      if (el.hasAttribute(name)) el.removeAttribute(name)
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value)
    }
  }
  originals.delete(el)
}

/**
 * Stamp a field the app just focused. Capture phase so it runs before React's
 * own handlers, and before the browser can offer a suggestion for the keystroke
 * that follows.
 */
function onFocusIn(event: Event): void {
  if (!enabled) return
  const target = event.target
  if (isTextField(target as Element | null)) stamp(target as Element)
}

/**
 * Wire the global listener. Idempotent, and a no-op without a DOM (the unit
 * tests import this module on plain node).
 *
 * Call this once at boot — see `src/main.tsx`. It deliberately does NOT change
 * the current state: the setting arrives from the store a moment later and
 * `applyInputSuppression()` does the first sweep.
 */
export function installInputSuppression(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('focusin', onFocusIn, true)
}

/**
 * Turn suppression on/off and re-sweep every field currently in the document.
 *
 * Called by `App` whenever the setting (or the hydrated state) changes. Safe to
 * call repeatedly: a sweep only touches fields whose attributes differ, and only
 * already-stamped fields have a recorded original to restore.
 */
export function applyInputSuppression(next: boolean): void {
  enabled = next
  if (typeof document === 'undefined') return
  for (const el of Array.from(document.querySelectorAll(FIELD_SELECTOR))) {
    if (isTextField(el)) {
      if (next) stamp(el)
      else restore(el)
    }
  }
}

/**
 * Stamp one element now — for inputs the renderer does not own, which the sweep
 * cannot reach deterministically (xterm's hidden textarea is created by
 * `term.open()` and only becomes focusable after the terminal is live).
 * A no-op while the user has the setting switched off.
 */
export function suppressField(el: Element | null | undefined): void {
  if (!enabled || !isTextField(el)) return
  stamp(el as Element)
}
