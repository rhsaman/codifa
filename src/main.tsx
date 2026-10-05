import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { injectThemeStyles } from './lib/themes'
import './styles/global.css'

injectThemeStyles()

// macOS frameless window: the traffic lights overlay the sidebar, so CSS
// needs a platform hook to reserve their drag strip (`.mac` selectors).
if (/Macintosh/.test(navigator.userAgent)) {
  document.documentElement.classList.add('mac')
}

const container = document.getElementById('root')
if (!container) throw new Error('root element missing')

// Flush-on-quit is handled by the main process: it sends `flush-persist` to
// the renderer and waits for the `flush-persist-done` ACK (see src/lib/store.ts
// and electron/main.ts), so no fire-and-forget flush is needed here.

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)