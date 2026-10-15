import React from 'react'
import { createRoot } from 'react-dom/client'
import { injectThemeStyles } from './lib/themes'
import { installTauriBridge, recordDroppedPaths } from './lib/tauriBridge'
import './styles/global.css'

injectThemeStyles()

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
  void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload
        // Physical -> logical CSS pixels so panels can hit-test their bounds.
        const dpr = window.devicePixelRatio || 1
        const pos =
          p.type === 'enter' || p.type === 'over' || p.type === 'drop'
            ? { x: p.position.x / dpr, y: p.position.y / dpr }
            : null
        if (p.type === 'drop') {
          const paths = p.paths
          recordDroppedPaths(
            paths.map((path) => ({
              name: path.split('/').pop() ?? path,
              path,
            })),
          )
        }
        // macOS broadcasts the native drag event to EVERY app window, so the
        // window-relative position cannot identify the hovered window. Resolve
        // the GLOBAL cursor position and let panels hit-test in screen space.
        void (async () => {
          let screen: { x: number; y: number } | null = null
          try {
            const [sx, sy] = await invoke<[number, number]>('cursor_position')
            screen = { x: sx / dpr, y: sy / dpr }
          } catch {
            // Fall back to the window-relative position (single-window case).
          }
          if (p.type === 'drop') {
            window.dispatchEvent(
              new CustomEvent('codifa:file-drop', {
                detail: { pos, screen, paths: p.paths },
              }),
            )
          }
          // Each chat panel listens for these events and hit-tests the cursor
          // in screen space (multi-window: only the panel under the cursor
          // shows the overlay and receives the dropped files).
          window.dispatchEvent(
            new CustomEvent('codifa:file-drag', {
              detail: { phase: p.type, pos, screen },
            }),
          )
        })()
      })
    }),
  )
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
