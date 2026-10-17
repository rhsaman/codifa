/**
 * WebKit (WKWebView) dead-key repair for xterm.js.
 *
 * Upstream bug: https://github.com/xtermjs/xterm.js/issues/5894 — "WKWebView:
 * dead-key cancellation duplicates the dead char and drops the next key".
 * It was reproduced on **xterm.js 6.0.0 — the exact version this app ships —
 * inside a Tauri 2 / WKWebView host**, and it does NOT reproduce on Chromium:
 * "its event sequence matches what xterm.js's input layer assumes — that's why
 * Tabby, Hyper, and VS Code (all Electron) work correctly with the same
 * keyboards on the same macOS." That is precisely why typing was clean in the
 * old Electron build and started injecting "extra characters" after the Tauri
 * migration.
 *
 * On macOS WKWebView, a dead key (US International `Option+N` → `~`, any
 * AZERTY `^`/`¨`, Spanish/Portuguese/Brazilian layouts, `AltGraph`…) followed
 * by a NON-combining key produces this sequence:
 *
 *   1. `compositionend` with data `"~"` → xterm's `CompositionHelper` reads
 *      the textarea and emits `"~"`. Correct.
 *   2. a synthetic `keypress` whose `charCode` is the DEAD char (126) rather
 *      than the physical key (47) → xterm's `_keyPress` reads `charCode`
 *      first and emits `"~"` a SECOND time.   ← the duplicated character
 *   3. a `keydown` whose `event.key` is the concatenation `"~/"` → xterm's
 *      keyboard service only accepts `key.length === 1`, so the keydown is
 *      ignored, and the `input` event carrying `"/"` is dropped by its
 *      `_keyDownSeen` guard.                  ← the swallowed character
 *
 * This module implements the repair the issue proposes: remember what the last
 * dead-key composition committed, suppress the synthetic keypress that repeats
 * it, and emit the trailing character of the collapsed keydown ourselves.
 *
 * Dead-key detection watches for a `keydown` with `key === "Dead"` (or
 * `"AltGraph"`) DURING the composition lifecycle — never the committed
 * character itself. Pattern-matching the commit against a set of "known dead
 * chars" is fundamentally wrong: many layouts type `~`, `^`, `` ` ``, `´`
 * directly without ever entering a dead state (see @jerch's analysis on the
 * issue). On Chromium the marker is wiped by `compositionstart` before
 * `compositionend`, so this repair self-disables there.
 *
 * The state machine below is intentionally free of DOM access so it can be
 * unit tested under plain node; `WebKitDeadKeyAddon` does the wiring.
 */

/** The minimal event shape the repair inspects — a `KeyboardEvent` satisfies
 *  it, and tests need no DOM. */
export interface DeadKeyEventLike {
  type: string
  key?: string
  /** Set on `keypress`; WebKit reports the DEAD char here, not the real key. */
  charCode?: number
}

/**
 * Tracks one dead-key composition and repairs the two WebKit event shapes.
 *
 * Both orders are handled: WebKit may deliver the synthetic `keypress` before
 * or after the collapsed `~/"` keydown, and either one alone must be enough to
 * rescue the character — so a handled branch never clears the state, only an
 * unrelated `keydown` (or the next `compositionstart`) does.
 */
export class WebKitDeadKeyRepair {
  /** A `Dead`/`AltGraph` keydown seen since the last composition started. */
  private deadKeyDownSeen = false
  /** What the last composition committed (the dead char, e.g. `~`). */
  private commit: string | null = null
  /** True when the composition that just ended came from a dead key. */
  private wasDead = false
  /** The synthetic keypress repeating `commit` was already suppressed. */
  private pressDone = false
  /** The collapsed keydown was already repaired. */
  private stolenDone = false
  private readonly emit: (data: string) => void

  constructor(emit: (data: string) => void) {
    this.emit = emit
  }

  /** Capture-phase `keydown`: flag the dead key that starts a composition. */
  noteKeyDown(e: DeadKeyEventLike): void {
    if (e.key === 'Dead' || e.key === 'AltGraph') this.deadKeyDownSeen = true
  }

  /** Capture-phase `compositionstart`: per-composition reset. */
  noteCompositionStart(): void {
    this.commit = null
    this.wasDead = false
    this.deadKeyDownSeen = false
    this.pressDone = false
    this.stolenDone = false
  }

  /** Capture-phase `compositionend`: record the commit and whether THIS
   *  composition came from a dead key. */
  noteCompositionEnd(data: string | undefined): void {
    this.commit = data || null
    this.wasDead = this.deadKeyDownSeen
    this.deadKeyDownSeen = false
    this.pressDone = false
    this.stolenDone = false
  }

  /**
   * Returns true when xterm must be suppressed for this event. Any rescued
   * character has already been handed to `emit` (the pty) by then.
   */
  handle(e: DeadKeyEventLike): boolean {
    // Also observe the dead key HERE, not only in the dedicated capture
    // listener: whichever runs first, the flag is set by the time
    // `compositionend` arrives. (xterm calls this from inside its own
    // `_keyDown`, whose capture listener is registered before ours.)
    if (e.type === 'keydown') this.noteKeyDown(e)

    if (!this.wasDead || this.commit === null) return false

    if (e.type === 'keypress') {
      if (!this.pressDone && e.charCode === this.commit.charCodeAt(0)) {
        // WebKit re-emits the committed dead char from `charCode`; the
        // composition already sent it, so this one is a pure duplicate.
        this.pressDone = true
        return true
      }
      return false
    }

    if (e.type === 'keydown') {
      const key = e.key ?? ''
      if (!this.stolenDone && key.length === 2 && key[0] === this.commit) {
        // WebKit collapsed "dead char + real key" into a single `key`; xterm
        // drops it, so send the real key ourselves before suppressing.
        this.emit(key.slice(1))
        this.stolenDone = true
        return true
      }
      // Neither shape: this is an ordinary keydown, so the dead-key sequence
      // is over. Clearing here is what keeps the repair from leaking into the
      // rest of the session.
      this.reset()
      return false
    }

    return false
  }

  private reset(): void {
    this.commit = null
    this.wasDead = false
    this.deadKeyDownSeen = false
    this.pressDone = false
    this.stolenDone = false
  }
}

import type { ITerminalAddon, Terminal } from '@xterm/xterm'

/**
 * Addon wrapper: binds the capture listeners and exposes the repair so the
 * host's `attachCustomKeyEventHandler` can call `repair.handle(event)` and
 * return `false` when it returns true.
 *
 * Using the addon interface means `term.dispose()` tears the listeners down —
 * no extra bookkeeping in the panel.
 */
export class WebKitDeadKeyAddon implements ITerminalAddon {
  /** The repair state machine — call `handle(event)` from the key handler. */
  public readonly repair: WebKitDeadKeyRepair
  private textarea: HTMLTextAreaElement | null = null
  private readonly bound: Array<[string, EventListener]> = []

  constructor(emit: (data: string) => void) {
    this.repair = new WebKitDeadKeyRepair(emit)
  }

  activate(term: Terminal): void {
    // `term.textarea` is only present once the terminal has been opened; the
    // host loads this addon after `term.open(el)`. Stay defensive anyway.
    let ta: HTMLTextAreaElement | undefined
    try {
      ta = term.textarea
    } catch {
      ta = undefined
    }
    if (!ta) return
    this.textarea = ta
    const add = (type: string, fn: EventListener) => {
      ta!.addEventListener(type, fn, true)
      this.bound.push([type, fn])
    }
    add('keydown', (e) => this.repair.noteKeyDown(e as KeyboardEvent))
    add('compositionstart', () => this.repair.noteCompositionStart())
    add('compositionend', (e) =>
      this.repair.noteCompositionEnd((e as CompositionEvent).data),
    )
  }

  dispose(): void {
    const ta = this.textarea
    if (ta) {
      for (const [type, fn] of this.bound) ta.removeEventListener(type, fn, true)
    }
    this.bound.length = 0
    this.textarea = null
  }
}
