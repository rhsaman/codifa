// SSR sanity test for the side pane's vertical viewer-tab rail.
export {}
// Covers: the rail wrapper class on the tab bar (icons only, one per tab), the
// floating hover hint that reveals a tab's title, and the CSS/markup contract
// that keeps the rail pinned to the pane's right edge WITHOUT ever resizing the
// viewer content or repainting the rail's background on hover.
//
// Mock the Electron/browser bridge before importing any component (the store
// module touches `window.coder` at import time).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) {
      return this._d[k] ?? null
    },
    setItem(k: string, v: string) {
      this._d[k] = String(v)
    },
    removeItem(k: string) {
      delete this._d[k]
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

// zustand's server snapshot renders the store's INITIAL state, so seed the
// persisted payload the store reads at import time — a later setState would
// not reach the server render.
;(globalThis as any).localStorage.setItem(
  "coder:viewerTabs",
  JSON.stringify({
    tabs: [
      { id: "inbox", kind: "inbox", title: "Inbox", createdAt: 1 },
      // Legacy global file tab (no chatId): visible in every chat.
      { id: "file:src/App.tsx", kind: "file", title: "App.tsx", filePath: "src/App.tsx", createdAt: 2 },
    ],
    activeId: "inbox",
    closed: [],
  }),
)

const React = await import("react")
const { renderToStaticMarkup } = await import("react-dom/server")
const { readFileSync } = await import("node:fs")
const { ViewerTabBar, ViewerFilesButton, ViewerInboxButton, ViewerTerminalButton, toggleTerminalInSidePane } = await import("../src/components/ViewerTabBar")
const { resolveTerminalPlacement, useStore } = await import("../src/lib/store")
const { useViewerTabs } = await import("../src/lib/viewerTabs")

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? "")
  }
}

console.log("1) ViewerTabBar renders as a vertical icon rail:")
{
  const html = renderToStaticMarkup(React.createElement(ViewerTabBar))
  const tabCount = (html.match(/role="tab"/g) ?? []).length
  // The seed holds an inbox tab (icon-owned: represented by its rail icon, so
  // NO row) and a legacy global file tab (no icon: still a row).
  check("rail-owned pages get no row, plain tabs do", tabCount === 1, html)
  check("the inbox tab is not drawn as a row", !html.includes('kind-inbox'), html)
  check("bar carries the rail class", html.includes("viewer-tabs-rail"), html.slice(0, 160))
  check("bar announces a vertical tablist", html.includes('aria-orientation="vertical"'))
  check("every tab shows an icon", (html.match(/viewer-tab-icon/g) ?? []).length === tabCount)
  check(
    "every tab keeps its label in the DOM (hidden by CSS until hover)",
    (html.match(/editor-tab-label/g) ?? []).length === tabCount,
  )
  const railStart = html.indexOf("viewer-tabs-rail")
  check("the rail wraps the tabs, not the other way round", railStart !== -1 && railStart < html.indexOf('role="tab"'))
}

console.log("2) markup + CSS keep the rail fixed on the pane's right edge:")
{
  const appSrc = readFileSync("src/App.tsx", "utf8")
  const bodyAt = appSrc.indexOf('className="viewer-pane-body"')
  const headAt = appSrc.indexOf('className="viewer-pane-head"')
  check("the pane body wraps the header", bodyAt !== -1 && headAt > bodyAt)
  check(
    "the header (rail) comes after the content in the body",
    bodyAt !== -1 && headAt > appSrc.indexOf('className="viewer-content"'),
  )

  const css = readFileSync("src/styles/global.css", "utf8")
  const railCss = css.slice(css.indexOf("--- vertical viewer tab rail"))
  check("the rail block exists in the stylesheet", railCss.length > 0)

  const rail = railCss.match(/\.viewer-tabs-rail\s*\{[^}]*\}/)
  check("rail stacks its tabs vertically", /flex-direction:\s*column/.test(rail?.[0] ?? ""), rail?.[0])

  const head = railCss.match(/\.viewer-pane-body \.viewer-pane-head\s*\{[^}]*\}/)
  check(
    "rail is pinned to the pane's right edge at a fixed width",
    /right:\s*0/.test(head?.[0] ?? "") && /width:\s*var\(--viewer-rail-width/.test(head?.[0] ?? ""),
    head?.[0],
  )
  check(
    "the rail is never a window drag region",
    /-webkit-app-region:\s*no-drag/.test(head?.[0] ?? ""),
    head?.[0],
  )

  // Regression: hovering used to widen the rail (squeezing the viewer) and
  // repaint its background. Neither may come back. (`inherit` is fine: the
  // unfolded label reuses the tab's own surface.)
  const hoverHeadRules = railCss.match(/\.viewer-pane-body[^{}]*:hover[^{}]*\{[^}]*\}/g) ?? []
  check(
    "hovering never widens the rail or repaints it",
    hoverHeadRules.every(
      (r) =>
        !/--viewer-rail-width/.test(r) &&
        !/background:(?! *inherit)/.test(r) &&
        !/box-shadow:(?! *inherit)/.test(r),
    ),
    hoverHeadRules,
  )
  check(
    "the collapsed width is never overridden",
    !/--viewer-rail-width:\s*var\(--viewer-rail-open-width\)/.test(railCss),
  )
  check(
    "viewer content keeps a constant rail gutter",
    /\.viewer-pane-body > \.viewer-content\s*\{[^}]*padding-right:\s*var\(--viewer-rail-width\)/.test(railCss),
  )

  const hidden = railCss.match(/\.viewer-tabs-rail \.editor-tab-label\s*\{[^}]*\}/)
  check("tab labels stay hidden in the rail", /display:\s*none/.test(hidden?.[0] ?? ""), hidden?.[0])

  const unfold = railCss.match(
    /\.viewer-pane-body \.viewer-tabs-rail \.editor-tab:hover \.editor-tab-label[^{]*\{[^}]*\}/,
  )
  check("a hovered tab unfolds its title over the content", unfold !== null, unfold?.[0])
  check(
    "the unfolded title opens beside the tab, leaving its icon visible",
    /position:\s*absolute/.test(unfold?.[0] ?? "") && /right:\s*100%/.test(unfold?.[0] ?? ""),
    unfold?.[0],
  )
  check(
    "hovering never hides the tab's icon",
    !/\.editor-tab:hover \.viewer-tab-icon[^{]*\{[^}]*opacity:\s*0/.test(railCss),
  )

  const barSrc = readFileSync("src/components/ViewerTabBar.tsx", "utf8")
  check(
    "drag/keyboard reordering runs on the vertical axis",
    /dropSide\(e\.clientY, rect, "y"\)/.test(barSrc) && /tabMove\(.*"y"\)/.test(barSrc),
  )
}

console.log("3) panel icons lead the rail, tabs follow below them:");
{
  const appSrc = readFileSync("src/App.tsx", "utf8")
  const headAt = appSrc.indexOf('className="viewer-pane-head"')
  const head = appSrc.slice(headAt, appSrc.indexOf("</section>", headAt))
  const actionsAt = head.indexOf('className="viewer-pane-actions"')
  const listAt = head.indexOf("<ViewerTabListButton")
  const barAt = head.indexOf("<ViewerTabBar")
  const spacerAt = head.indexOf("viewer-pane-spacer")
  check("the panel action icons render inside the rail", actionsAt !== -1)
  check("panel icons come before the tab-list chevron", actionsAt !== -1 && actionsAt < listAt)
  check("panel icons come before the tabs", actionsAt !== -1 && actionsAt < barAt)
  check("nothing is stacked above the panel icons", !head.slice(headAt === -1 ? 0 : 0, actionsAt).includes("<button"))
  check("the spacer drops below the tabs", spacerAt > barAt)
  // Every page owns an icon now, so the "+" menu is gone: a page could
  // otherwise be reachable from two differently-worded entries.
  check("no \"+\" add button is left in the rail", !head.includes("ViewerAddButton"))
  check("the add button component is gone from the app", !appSrc.includes("ViewerAddButton"))

  const css = readFileSync("src/styles/global.css", "utf8")
  const actions = css.match(/\.viewer-pane-body \.viewer-pane-actions\s*\{[^}]*\}/)
  check("the rail action container fills the rail width", /width:\s*100%/.test(actions?.[0] ?? ""), actions?.[0])
  check("rail icon buttons share one width", /\.viewer-pane-head \.titlebar-icon-btn/.test(css))
}

console.log("4) every page owns one rail icon, in a fixed order:");
{
  const appSrc = readFileSync("src/App.tsx", "utf8")
  const headAt = appSrc.indexOf('className="viewer-pane-head"')
  const head = appSrc.slice(headAt, appSrc.indexOf("</section>", headAt))
  const listAt = head.indexOf("<ViewerTabListButton")
  const fullAt = head.indexOf("<ViewerPaneFullscreenButton")
  const filesAt = head.indexOf("<ViewerFilesButton")
  const todosAt = head.indexOf("<ViewerTodosButton")
  const termAt = head.indexOf("<ViewerTerminalButton")
  const schedAt = head.indexOf("<ViewerScheduleButton")
  const inboxAt = head.indexOf("<ViewerInboxButton")
  const reviewAt = head.indexOf("<ViewerReviewButton")
  const traceAt = head.indexOf("<ViewerTraceButton")
  const browserAt = head.indexOf("<ViewerBrowserButton")
  const barAt = head.indexOf("<ViewerTabBar")
  const spacerAt = head.indexOf("viewer-pane-spacer")

  check("the terminal toggle renders in the rail", termAt !== -1, head.slice(0, 1200))
  check("fill every page icon", [fullAt, filesAt, todosAt, schedAt, inboxAt, reviewAt, traceAt, browserAt].every((i) => i !== -1), head)
  check("fullscreen sits directly below the tab-list chevron", listAt !== -1 && fullAt > listAt)
  // The requested order: files, then todos, then the terminal dock.
  check("files leads the rest of the page icons", filesAt > fullAt && filesAt < todosAt)
  check("todos sits below files and above the terminal", todosAt > filesAt && todosAt < termAt)
  check("the terminal follows todos", termAt > todosAt)
  check("schedule follows the terminal, inbox follows schedule", schedAt > termAt && inboxAt > schedAt)
  check("review, trace and browser close the icon list", reviewAt > inboxAt && traceAt > reviewAt && browserAt > traceAt)
  check("the rail rows and the tabs come last", barAt > browserAt && spacerAt > barAt)
  // The todos page is the pane's fallback body, so its icon must be a real
  // toggle button, not a one-off <button> markup in App.
  check(
    "the todos page owns a rail icon (not raw markup in App)",
    !head.includes('className="titlebar-icon-btn panel-toggle"'),
  )

  // Nothing docked yet: unpressed, announcing the OPEN action.
  const html = renderToStaticMarkup(React.createElement(ViewerTerminalButton))
  check(
    "the rail button is a plain titlebar icon button",
    html.includes('class="titlebar-icon-btn viewer-terminal-btn"'),
    html,
  )
  check("it starts unpressed", html.includes('aria-pressed="false"'), html)
  check(
    "its label offers to open the terminal here",
    html.includes("Open the terminal in the side pane"),
    html,
  )
  check(
    "the tooltip and the label agree",
    (html.match(/Open the terminal in the side pane/g) ?? []).length === 2,
    html,
  )
  check(
    "it paints a stroke glyph instead of a filled app badge",
    html.includes('stroke="currentColor"') && !html.includes("mac-app-badge"),
    html,
  )

  // Drive the real action: the button is a thin wrapper around it.
  useViewerTabs.getState().setPaneOpen(false)
  useStore.getState().setTerminalPanelOpen(false)
  useStore.getState().setTerminalPlacement('bottom')

  toggleTerminalInSidePane()
  const v1 = useViewerTabs.getState()
  const a1 = useStore.getState()
  check("the first press reveals the side pane", v1.paneOpen === true)
  check("it requests the side dock", a1.terminalPlacement === 'right', a1.terminalPlacement)
  check("it opens the terminal", a1.terminalPanelOpen === true)
  check(
    "the effective dock really is the pane",
    resolveTerminalPlacement(a1.terminalPlacement, v1.paneOpen, a1.chatFullscreen) === 'right',
  )

  toggleTerminalInSidePane()
  check("pressing it again closes the terminal", useStore.getState().terminalPanelOpen === false)

  // A stale 'right' request left behind while the panel was closed must not
  // turn the first press into a no-op: the panel is shut, so it must OPEN.
  useStore.getState().setTerminalPlacement('right')
  useStore.getState().setTerminalPanelOpen(false)
  toggleTerminalInSidePane()
  check("a stale side request still opens the terminal", useStore.getState().terminalPanelOpen === true)

  // …and the pressed state needs the pane to be on screen, or the icon would
  // claim "docked here" for a terminal that fell back to the bottom dock.
  check(
    "a hidden pane degrades the dock (so the icon reads unpressed)",
    resolveTerminalPlacement('right', false, false) === 'bottom',
  )
}

console.log("5) a page icon is pressed only while its page is ON SCREEN:")
{
  // The seeded store has TWO tabs open (inbox + a legacy global file tab) with
  // the inbox active. The inbox icon must read pressed and offer to close…
  const inboxHtml = renderToStaticMarkup(React.createElement(ViewerInboxButton))
  check(
    "the icon of the shown page is pressed",
    inboxHtml.includes('aria-pressed="true"'),
    inboxHtml,
  )
  check("…and offers to close it", inboxHtml.includes("Close the inbox"), inboxHtml)

  // …while the files icon, whose tab is open too but NOT on screen, must read
  // unpressed and offer to OPEN (focus) it. Keying it off "a tab exists" made
  // this press look like a toggle and CLOSE the page instead.
  const filesHtml = renderToStaticMarkup(React.createElement(ViewerFilesButton))
  check(
    "the icon of an open-but-hidden page is not pressed",
    filesHtml.includes('aria-pressed="false"'),
    filesHtml,
  )
  check(
    "…and still offers to open it",
    filesHtml.includes("Open the file explorer") && !filesHtml.includes("Close the file explorer"),
    filesHtml,
  )
}

if (failed) process.exit(1)
console.log("\nAll viewer tab rail checks passed")
