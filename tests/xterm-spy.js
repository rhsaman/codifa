// Spy stubs for the xterm.js packages, for tests that must OBSERVE what a
// session manager does (which grid it pushes to the pty, whether it disposes
// the screen). tests/xterm-stub.js stays a no-op for SSR-style tests; this
// module adds the bookkeeping those assertions need.
export const spies = {
  opened: 0,
  fits: 0,
  disposed: 0,
}

/** Everything written to any Terminal through `write` (pty output lands here). */
export const written = []

/** Cell metrics used to derive a grid from a box (real xterm measures glyphs). */
const CELL_W = 8
const CELL_H = 16

export class Terminal {
  constructor(options) {
    this.options = options ?? {}
    // xterm's default grid before any fit — the state the pane used to be stuck
    // in when the session was never found by its tab id.
    this.cols = 80
    this.rows = 24
    this.textarea = {
      addEventListener: () => {},
      removeEventListener: () => {},
      setAttribute: () => {},
    }
    this._el = null
    this._onResize = null
    /** Chunks THIS terminal received, in order (write() also feeds the shared
     *  `written` list, which older tests assert on — this adds per-instance
     *  capture so a test can tell SEVERAL terminals apart). */
    this.written = []
  }

  loadAddon(addon) {
    // xterm's real loader activates the addon with the terminal.
    addon?.activate?.(this)
  }

  open(el) {
    this._el = el
    // Real xterm builds its own DOM inside the element it is opened with and
    // exposes it as `element` — that node is what gets re-parented on a
    // re-mount, so the spy has to model it (the screen no longer rebuilds).
    if (el && typeof el.appendChild === 'function') {
      this.element = { owner: this._el, id: `xterm-node-${spies.opened}` }
      el.appendChild(this.element)
    }
    spies.opened++
  }

  onData() {}

  /** Every chunk the app pushes at the screen (an echo of pty output). */
  write(data) {
    this.written.push(data)
    written.push(data)
  }
  onResize(cb) {
    this._onResize = cb
  }
  attachCustomKeyEventHandler() {}
  focus() {}

  dispose() {
    spies.disposed++
  }

  /** Push the grid xterm would report after fitting `box`. */
  _reportResize(cols, rows) {
    this.cols = cols
    this.rows = rows
    this._onResize?.({ cols, rows })
  }

  /** Whether this terminal's DOM currently lives inside `el`. The real xterm
   *  writes its canvas into the element it was opened with, so a re-mount
   *  leaves that element EMPTY — which is exactly what the session manager
   *  probes for before calling open() again. */
  _owns(el) {
    return this._el === el
  }
}

export class FitAddon {
  activate(term) {
    this.term = term
  }

  fit() {
    spies.fits++
    const rect = this.term?._el?.getBoundingClientRect?.()
    if (!rect || rect.width < 40 || rect.height < 40) return
    this.term._reportResize(
      Math.max(2, Math.floor(rect.width / CELL_W)),
      Math.max(2, Math.floor(rect.height / CELL_H)),
    )
  }
}

export class WebLinksAddon {}

export default { Terminal, FitAddon, WebLinksAddon, spies, written }
