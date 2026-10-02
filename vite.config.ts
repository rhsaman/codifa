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
              },
              preload: {
                // Shortcut of `build.rolldownOptions.input` (vite 8+)
                input: 'electron/preload.ts',
                vite: {
                  build: {
                    // vite 8+ uses rolldown; vite < 8 uses rollup. The plugin adapts
                    // automatically — only `rolldownOptions` is needed for vite 8.
                    rolldownOptions: {
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
