// Runs BEFORE the bundled app modules (esbuild `--inject`): the store reads the
// Electron preload bridge (`window.coder.*`) and registers browser listeners at
// module load. None of that is exercised by these tests.
//
// `window` is a GETTER onto `globalThis`, and `globalThis.document` is a GETTER
// onto a mutable holder: the tests swap the caret per case, so the modules must
// read the CURRENT document, not a snapshot taken at import time (a snapshot is
// exactly how a stale-caret double passes locally and lies).
const g = globalThis as any
const state: { doc: any } = { doc: undefined }

if (!g.window) {
  Object.defineProperty(g, 'window', {
    configurable: true,
    get: () => g,
    set: () => undefined,
  })
}
if (!g.coder) {
  g.coder = new Proxy({}, { get: () => () => undefined })
}
for (const fn of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) {
  if (typeof g[fn] !== 'function') g[fn] = () => undefined
}

if (!Object.getOwnPropertyDescriptor(g, 'document')?.get) {
  Object.defineProperty(g, 'document', {
    configurable: true,
    get: () => state.doc,
    set: (v: any) => {
      state.doc = v
    },
  })
}

;(g as any).__stubDoc = state
export {}
