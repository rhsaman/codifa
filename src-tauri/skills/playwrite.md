---
name: Playwrite
description: Browser automation guide: snapshots and refs, interaction patterns, waiting, and recovery.
fa_keywords: مرورگر, پلی‌رایت, playwright, playwrite, chromium, snapshot, ref, تب‌ها, اسنپ‌شات
---

# Playwrite

General guide for the built-in browser tools. Add future browser topics as new `##` sections below.

The browser is part of the app: ONE shared headless Chromium, one tab per chat, driven in-process over CDP. There is no sidecar, no `npx` helper and no helper port to babysit — so a browser tool that fails is reporting a real page or Chromium problem, not a connection hiccup.

## Tool selection

- Open/show/visit a site: always `browser_navigate`, never web search alone.
- Fast fact lookup: `web_search`. Known URL as markdown: `fetch_url`.
- Page needs JS rendering or interaction: browser tools (`browser_snapshot` to read, `browser_click` / `browser_type` / `browser_fill_form` to interact).
- `browser_status` reports the current URL and title without touching the page.

## Snapshot first

- After every navigation, call `browser_snapshot` before interacting. Refs expire when the document changes, so re-snapshot before each click/type instead of reusing old refs.
- A ref is the small integer in the snapshot's `[N]` form. It names the element (`role`, accessible name, occurrence), so it survives scrolling and layout shifts.
- When the snapshot is large, use `browser_find` to locate the part you need instead of re-reading the whole page. To reach an item inside a hover menu, `browser_hover` the opener and snapshot again.

## Interacting

- `browser_click`, `browser_type` and `browser_fill_form` take a `ref` from the newest snapshot (a `selector` also works). Never guess a ref.
- Prefer `browser_fill_form` for multi-field forms (one call, an array of fields) over separate `browser_type` calls.
- Dropdowns: `browser_select_option` with the option `value`.
- Keyboard: `browser_press_key` — a single key (`Enter`, `Tab`, `Escape`) or a combo written as `Meta+A`, or a bare key plus a `modifiers` array.
- `browser_navigate_back` walks the history back without a full navigate.
- `browser_hover` before clicking an item that only appears on hover.

## Waiting

- Never poll in a loop; use `browser_wait_for` with `text` (appear) or `text_gone` (disappear), or a small bounded `time`.
- After an action that triggers navigation or an async load, wait for the expected text first, then re-snapshot.

## Debugging a page

- JS errors: `browser_console_messages` (level error/warning).
- Failed API calls: `browser_network_requests` with a URL `filter` — it lists the requests the page made with their status codes.
- Read or compute page state: `browser_evaluate` with a small read-only function, returning a value you can quote back.
- Layout or visual questions: the panel renders the pixels, the tools report text. Answer from `browser_snapshot` / `browser_evaluate` rather than trying to look at the page.

## Tabs

- List tabs first (`browser_tabs` with action `list`) and reuse the existing tab when possible.
- Open with `new`, switch with `select`, and close the ones you opened with `close`.

## Files and dialogs

- File upload: `browser_file_upload` with a `ref` for the file input (or its `selector`) plus absolute `paths`.
- Dialogs (alert/confirm/prompt): `browser_handle_dialog` with the accept flag and the prompt text.
- Drag and drop between elements: `browser_drag` with `ref` and `to_ref` from the latest snapshot.

## Finding and viewport

- Search page text: `browser_find` with plain text or regex before scrolling blindly.
- Scroll a container or the page: `browser_scroll` with an optional `ref` and a `dx`/`dy` delta.
- Resize viewport: `browser_resize` when layout is responsive-dependent.
- Emulate media: `browser_emulate_media` for dark mode, reduced motion, or print checks.

## When a browser tool reports a failure

Read the message instead of retrying blindly — each one names its own fix.

- `ref [N] is unknown`: the page changed under you. Run `browser_snapshot` again and use the new refs.
- `the element has no clickable box (it may be hidden)`: the element is present but not visible yet. Wait for it, scroll, or hover its opener, then re-snapshot.
- `browser is not running`: the shared Chromium was reaped after sitting idle. Any browser tool call starts it again, so retry once.
- `no Chromium available`: the machine has neither Google Chrome nor a Playwright-bundled Chromium. Report that instead of looping.
- A slow page is not a failed navigation: the driver reports the URL it actually reached, so snapshot to see where you landed.
