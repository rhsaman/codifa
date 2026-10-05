// Browser-free stubs for the xterm.js packages in node-based tests.
// The Terminal panel only touches these inside effects (never during SSR).
export class Terminal {
  constructor(options) {
    this.options = options ?? {}
  }
  loadAddon() {}
  open() {}
  onData() {}
  onResize() {}
  attachCustomKeyEventHandler() {}
  focus() {}
  dispose() {}
}

export class FitAddon {
  fit() {}
}

export class WebLinksAddon {}

export default { Terminal, FitAddon, WebLinksAddon }
