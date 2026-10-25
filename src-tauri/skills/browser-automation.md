---
name: Browser Automation
description: Drive the built-in browser: snapshots and refs, clicking and typing, waiting, tabs, files, and debugging a page from its console and network log.
fa_keywords: مرورگر, مرور کردن, سایت باز کن, اسنپ‌شات, snapshot, ref, کلیک, فرم, تب مرورگر, دیباگ صفحه, chromium
---

# Browser Automation

How to drive the browser that ships with the app. Add new browser topics as
`##` sections below.

## What this browser is

The browser is part of the app: ONE shared headless Chromium, one session per
chat, driven in-process over CDP. Nothing to install and nothing to babysit:
**no `npx`, no sidecar, no helper port.** So a browser failure is a real page or
Chromium problem, never a connection hiccup — read the message instead of
retrying.

This is why the old `@playwright/mcp` connector is gone: the same automation is
all here, built in, without a Node process doing nothing useful. If you ever see
an error naming that connector, it is a stale leftover — say so instead of
trying to start it.

The tools only exist while the **Browser** switch is on in the composer. If
`browser_navigate` comes back unknown, that switch is what to check first.

## Tool selection

- Open or show a site: always `browser_navigate`, never web search alone.
- A fast fact that needs no page: `web_search`. A known URL as markdown:
  `fetch_url`.
- A page that needs JS or interaction: the browser tools below.
- Already on the page and want to know where: `browser_status` reports the
  current URL and title without touching the page.

## Snapshot first

- Snapshot after every navigation, before interacting. Refs expire when the
  document changes, so re-snapshot before each click or type instead of reusing
  old refs.
- A ref is the small integer in `[N]` form. It names the element (`role`,
  accessible name, occurrence), so it survives scrolling and layout shifts.
- A large snapshot: `browser_find` to reach the part you need instead of
  re-reading the whole page. An item inside a hover menu: hover the opener, then
  snapshot again.

## Interacting

- `browser_click`, `browser_type` and `browser_fill_form` take a `ref` from the
  newest snapshot (a `selector` also works). Never guess a ref.
- Multi-field forms: `browser_fill_form` with an array of fields beats separate
  `browser_type` calls.
- Dropdowns: `browser_select_option` with the option `value`.
- Keyboard: `browser_press_key` — a single key (`Enter`, `Tab`, `Escape`), a
  combo written as `Meta+A`, or a bare key plus a `modifiers` array.
- History: `browser_navigate_back` instead of a second navigate.
- Hover-only items: `browser_hover` the opener first.

## Waiting

- Never poll in a loop. `browser_wait_for` with `text` (appear), `text_gone`
  (disappear), or a small bounded `time`.
- After anything that triggers navigation or a load, wait for the expected text,
  then re-snapshot.

## Reading and verifying a page

- Structure and text: `browser_snapshot`.
- Somewhere specific in the text: `browser_find`.
- A computed answer (a count, a value, a state): `browser_evaluate` with a small
  read-only function returning a value you can quote back.
- The panel renders pixels, the tools report text — answer from
  `browser_snapshot` / `browser_evaluate`, not by trying to look at the page.
- Prove a change worked the same way: re-read the DOM after the action rather
  than assuming it landed.

## Debugging a page

- JS errors: `browser_console_messages` (level error/warning).
- Failed calls: `browser_network_requests` with a URL `filter` — it lists the
  requests the page made with their status codes, which is usually the fastest
  way to tell a UI bug from a backend one.
- Start from the symptom: console first for a broken interaction, network first
  for missing data.

## Tabs

- `browser_tabs` with action `list` first, and reuse the existing tab when it
  will do.
- Open with `new`, switch with `select`, and close with `close` the ones you
  opened — a tab you leave open is state the next step has to reason about.

## Files and dialogs

- Upload: `browser_file_upload` with a `ref` for the file input (or its
  `selector`) plus absolute `paths`.
- alert/confirm/prompt: `browser_handle_dialog` with the accept flag and the
  prompt text. A dialog left unhandled blocks the page.
- Drag and drop: `browser_drag` with `ref` and `to_ref` from the latest
  snapshot.

## Viewport and media

- `browser_scroll` with an optional `ref` and a `dx`/`dy` delta.
- `browser_resize` when the layout is responsive-dependent.
- `browser_emulate_media` for dark mode, reduced motion, or print checks.

## When a tool reports a failure

Each message names its own fix — read it instead of retrying blindly.

- `ref [N] is unknown`: the page changed under you. Snapshot again and use the
  new refs.
- `the element has no clickable box (it may be hidden)`: present but not visible
  yet. Wait for it, scroll to it, or hover its opener, then re-snapshot.
- `browser is not running`: the shared Chromium was reaped while idle. Any
  browser call starts it again, so retry once.
- `no Chromium available`: the machine has neither Google Chrome nor a
  Playwright-bundled Chromium. Report that instead of looping.
- A slow page is not a failed navigation: the driver reports the URL it actually
  reached, so snapshot to see where you landed.
