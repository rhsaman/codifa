---
name: Playwrite
description: Playwright browser automation guide: navigate recovery, snapshots, and interaction patterns.
fa_keywords: مرورگر, پلی‌رایت, playwright, playwrite, navigate, ECONNREFUSED, websocket, تب‌ها, sidecar, اسنپ‌شات
---

# Playwrite

General guide for the Playwright browser tools. Add future Playwright topics as new `##` sections below.

## Tool selection

- Open/show/visit a site: always `browser_navigate`, never web search alone.
- Fast fact lookup: `web_search`. Known URL as markdown: `fetch_url`.
- Page needs JS rendering or interaction: browser tools (`browser_snapshot` to read, `browser_click` / `browser_type` / `browser_fill_form` to interact).

## Navigate recovery

Use this when `browser_navigate` fails with `connect ECONNREFUSED 127.0.0.1:<port>` while fetching the websocket url.

That error means the Playwright sidecar (the helper running the automated browser) was not reachable on its ephemeral port. It is an infrastructure hiccup, not an app bug. Do not edit `src/` or `backend/` for it.

1. Diagnose: confirm the error mentions `ECONNREFUSED` and `websocket url`. The app port (e.g. 5173) is irrelevant here; the refused port belongs to the sidecar.
2. Wake the connection: call one lightweight browser tool first (e.g. list tabs via `browser_tabs`), then retry `browser_navigate` once.
3. Retry once more after a few seconds if the first retry hits the same error. Do not loop more than twice.
4. Fall back: if navigate still fails, navigate from the already-open page with `browser_evaluate` using `window.location.href = "<url>"`, then verify with `browser_snapshot`.
5. Keep it tidy: close extra tabs you opened and continue the original task. Never leave dead tabs behind.

## Snapshot first

- After every navigation, call `browser_snapshot` before interacting; refs (`target`) expire after navigation, so re-snapshot before each click/type.
- Prefer accessibility snapshot over screenshots for reading state; use `browser_take_screenshot` only when layout/visuals matter.
- When the snapshot is large, narrow with `target` or `depth` instead of re-reading the whole page.

## Interacting

- Click/type/fill need a fresh `target` ref from the latest snapshot; never guess refs.
- Prefer `browser_fill_form` for multi-field forms (one call, array of fields) over separate `browser_type` calls.
- Dropdowns: `browser_select_option`. Hover menus before clicking hidden items: `browser_hover` then `browser_click`.
- Keyboard: `browser_press_key` (e.g. Enter/Escape) after typing when the app expects it.

## Waiting

- Never poll in a loop; use `browser_wait_for` with `text` (appear) or `textGone` (disappear), or a small bounded `time`.
- After actions that trigger navigation or async load, wait for the expected text first, then re-snapshot.

## Debugging a page

- JS errors: `browser_console_messages` (level error/warning).
- Failed API calls: `browser_network_requests` with a URL filter, then `browser_network_request` for headers/body of one index.
- Read or compute page state: `browser_evaluate` with a small function; keep it read-only except for the navigate fallback above.

## Tabs

- List tabs before opening a new one; reuse the existing tab when possible.
- Close tabs you opened (`browser_tabs` close) and select back to the task tab when done.

## Files and dialogs

- File upload: `browser_file_upload` with absolute paths; drag-drop upload: `browser_drop`.
- Dialogs (alert/confirm/prompt): `browser_handle_dialog` with accept flag and prompt text.
- Drag and drop between elements: `browser_drag` with start/end targets from the latest snapshot.

## Finding and viewport

- Search page text: `browser_find` with plain text or regex before scrolling blindly.
- Resize viewport: `browser_resize` when layout is responsive-dependent.
- Emulate media: `browser_emulate_media` for dark mode, reduced motion, or print checks.
