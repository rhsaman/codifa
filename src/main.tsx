import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { injectThemeStyles } from './lib/themes'
import './styles/global.css'

injectThemeStyles()

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