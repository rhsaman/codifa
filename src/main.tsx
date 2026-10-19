import React from 'react'
import { createRoot } from 'react-dom/client'
import { injectThemeStyles } from './lib/themes'
import { installTauriBridge, recordDroppedPaths } from './lib/tauriBridge'
import { installInputSuppression } from './lib/inputSuppress'
import './styles/global.css'

injectThemeStyles()

// Stop macOS/WebKit autocomplete, autocorrect, inline predictions and
// spell-check from rewriting what is typed into the app (Settings → General →
// Keyboard suggestions drives the actual on/off sweep).
installInputSuppression()

// macOS frameless window: the traffic lights overlay the sidebar, so CSS
// needs a platform hook to reserve their drag strip (`.mac` selectors).
if (/Macintosh/.test(navigator.userAgent)) {
  document.documentElement.classList.add('mac')
}

const container = document.getElementById('root')
if (!container) throw new Error('root element missing')

// Tauri shell: expose the window.coder bridge BEFORE any store module runs —
// src/lib/store.ts touches window.coder at import time, and ES module imports
// are hoisted, so App must be imported dynamically after the bridge install.
// In web mode (vite dev without Tauri) installTauriBridge is a no-op and the
// page relies on the harness stub.
const tauri = installTauriBridge()

// Tauri drag-drop carries absolute file paths (Electron used webUtils in the
// preload); record them so api.getPathForFile(file) stays synchronous.
if (tauri) {
  void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
    const myLabel = getCurrentWebview().label
    // Panels read this to compare against the drag target label.
    ;(window as unknown as { __CODIFA_WINDOW_LABEL__?: string }).__CODIFA_WINDOW_LABEL__ = myLabel
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'drop') {
          recordDroppedPaths(
            p.paths.map((path) => ({
              name: path.split('/').pop() ?? path,
              path,
            })),
          )
        }
        // Two levels of hit-test: the Rust-resolved target label tells apart
        // separate OS windows; the window-relative cursor tells apart chat
        // PANELS that share one OS window (the app's multi-chat layout).
        // Tauri v2 emits the drag position in LOGICAL CSS px on macOS —
        // dividing by devicePixelRatio halved the coordinates and mapped a
        // drop on the lower chat panel onto the upper one (confirmed twice
        // in live testing). Only normalize when the point falls outside the
        // viewport, which indicates a platform reporting physical px.
        const rawPos =
          p.type === 'enter' || p.type === 'over' || p.type === 'drop'
            ? { x: p.position.x, y: p.position.y }
            : null
        const dpr = window.devicePixelRatio || 1
        const pos =
          rawPos && (rawPos.x > window.innerWidth || rawPos.y > window.innerHeight)
            ? { x: rawPos.x / dpr, y: rawPos.y / dpr }
            : rawPos
        void invoke<string | null>('window_under_cursor')
          .catch(() => null)
          .then((target) => {
            if (p.type === 'drop') {
              window.dispatchEvent(
                new CustomEvent('codifa:file-drop', {
                  detail: { target, pos, paths: p.paths },
                }),
              )
            }
            window.dispatchEvent(
              new CustomEvent('codifa:file-drag', {
                detail: { phase: p.type, target, pos },
              }),
            )
          })
      })
    })
  })
}

// Flush-on-quit is handled by the shell: it sends `flush-persist` to the
// renderer and waits for the `flush-persist-done` ACK (see src/lib/store.ts
// and src-tauri/src/main.rs), so no fire-and-forget flush is needed here.

void import('./App').then(({ default: App }) => {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
