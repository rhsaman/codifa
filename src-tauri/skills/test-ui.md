---
name: Test UI
description: Live-test codifa's own renderer UI in a browser — mounts the real ChatPanel with a stubbed backend, seeds store scenarios, simulates events and takes screenshots via the browser tools.
fa_keywords: تست رابط کاربری, تست UI, live test UI
---

# Test UI (live renderer harness)

Drive codifa's real UI in a plain browser and verify behavior visually and via
the DOM — without the desktop shell. Use this whenever
the task is to verify or debug a frontend change (composer behavior, message
bubbles, panels, CSS/layout) on the actual rendered component tree.

## How the harness works

- `npm run dev:web` starts vite in web-only mode (`--mode webonly`): the
  renderer is served on http://localhost:5173 (or the next free port — read the
  printed URL) WITHOUT building/launching the Tauri app.
- `tests/ui/harness.html` stubs `window.coder` (the Tauri bridge,
  `src/lib/tauriBridge.ts`) before any module loads, so the real React app
  boots in the browser. Every
  unknown coder method resolves to `null`; backend-dependent flows (real
  streaming, file reads) are out of scope.
- `tests/ui/harness.tsx` mounts the real `ChatPanel` and seeds the zustand
  store from a `?scenario=` query param:
  - `composer` — one empty chat (composer / paste / chips tests)
  - `queue` — a long steer-pending user message plus long and short queued +
    steer bubbles (fold/clamp tests)
  - `empty` — no active chat (shell / empty-state tests)

## Steps

1. Start the server in the background: `npm run dev:web`. Parse the actual
   `Local:` URL from its output (port 5173 may be taken).
2. Navigate the browser to `<url>/tests/ui/harness.html?scenario=<name>`.
3. Seed or inspect state through the exposed handle:
   `window.__ui.store.getState()` and `window.__ui.store.setState(patch)`
   (zustand) — e.g. push messages into
   `state.chats.find(c => c.id === state.activeChatId).messages`.
4. Simulate input with the helpers: `window.__ui.dispatchPaste(text)` returns
   `{ defaultPrevented }`; type into `.composer-input` via normal browser
   typing; click real buttons via the snapshot-driven click tool.
5. Assert on the DOM (e.g. `.paste-card`, `.queued-bubble-text.clamped`,
   `.msg-expand`) and take a screenshot whenever layout/visuals matter.
6. Report a verdict per behavior with evidence; save/attach screenshots.
7. Stop the dev server when finished.

## Gotchas

- React re-renders asynchronously: after any state-changing evaluate or event,
  wait ~300–500ms (or re-evaluate) before asserting on the DOM.
- Synthetic (untrusted) paste events never trigger the browser's native text
  insertion. A SHORT paste is correct when `__ui.dispatchPaste(text)` returns
  `defaultPrevented: false` — do NOT expect the textarea value to change. A
  LONG paste is correct when it returns `defaultPrevented: true` and a
  `.paste-card` appears while the textarea stays empty.
- Adding a new scenario = a new `case` in `initialState()` in
  `tests/ui/harness.tsx`. Keep harness data English-only, like the codebase.
