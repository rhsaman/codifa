import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// `npm run dev:web` (vite --mode webonly) serves ONLY the renderer, without
// building/launching the Electron app. Used for live UI testing: the harness
// page (tests/ui/harness.html) runs in a normal browser with a stubbed
// window.coder, so a browser driver (e.g. the playwright MCP tools) can
// exercise the real UI without the desktop shell or the Python sidecar.
export default defineConfig(({ mode }) => {
  const webOnly = mode === 'webonly'
  return {
    plugins: [
      react(),
      ...(webOnly
        ? []
        : [
            electron({
              main: {
                // Shortcut of `build.lib.entry`
                entry: 'electron/main.ts',
                vite: {
                  build: {
                    rollupOptions: {
                      // node-pty ships a native .node binary + a runtime
                      // `require()` of the prebuild — bundling it breaks the
                      // dynamic load, so keep it a plain runtime import
                      // resolved from node_modules at Electron startup.
                      external: ['node-pty'],
                    },
                  },
                },
              },
              preload: {
                // Shortcut of `build.rollupOptions.input`
                input: 'electron/preload.ts',
                vite: {
                  build: {
                    // This repo builds with vite 5 (rollup). The plugin reads
                    // `build.rollupOptions` — `rolldownOptions` is ignored here
                    // and produced a stale preload.cjs missing new IPC APIs.
                    rollupOptions: {
                      output: {
                        format: 'cjs',
                        entryFileNames: 'preload.cjs',
                      },
                    },
                  },
                },
              },
              // Optional: Use Node.js API in the Renderer process
              renderer: {},
            }),
          ]),
    ],
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: false,
    },
  }
})
