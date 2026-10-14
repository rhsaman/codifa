import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run dev:web` (vite --mode webonly) serves ONLY the renderer, without
// the Tauri shell. Used for live UI testing: the harness page
// (tests/ui/harness.html) runs in a normal browser with a stubbed
// window.coder, so a browser driver (e.g. the playwright MCP tools) can
// exercise the real UI without the desktop shell or the Python sidecar.
// `npm run tauri dev` / `tauri build` drive the same config for the desktop
// app (see src-tauri/tauri.conf.json).
export default defineConfig(({ mode }) => {
  const webOnly = mode === 'webonly'
  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: false,
      // The Rust build tree changes constantly during `tauri dev`; watching
      // it triggers endless page reloads.
      watch: {
        ignored: ['**/src-tauri/target/**', '**/backend/.venv/**'],
      },
    },
    // webOnly is kept as a named flag so harness scripts can detect the mode.
    define: {
      __CODIFA_WEBONLY__: JSON.stringify(webOnly),
    },
  }
})
