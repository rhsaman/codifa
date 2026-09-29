import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

export default defineConfig({
  plugins: [
    react(),
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
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})