import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { flushStateNow } from './lib/store'
import { injectThemeStyles } from './lib/themes'
import './styles/global.css'

injectThemeStyles()

const container = document.getElementById('root')
if (!container) throw new Error('root element missing')

// Flush any deferred store writes (e.g. a subagent model / setting changed
// while a reply was streaming, whose persistSoon() timer never fired) before
// the window tears down. Electron's main process flushes its own queue in
// will-quit, so the renderer just needs to hand its state over via IPC.
window.addEventListener('beforeunload', () => {
  flushStateNow()
})

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)