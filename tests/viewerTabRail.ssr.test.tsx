// SSR sanity test for the side pane's viewer surfaces: the titled TOP tab
// strip and the fixed BOTTOM launcher dock.
export {}
// Covers: the strip renders one titled tab per open TAB (files/browser/trace/…),
// dock pages never leak into it, the "+" menu opens only the chat-owned
// Browser/Trace, and the CSS/markup contract keeps the strip at the pane's top
// and the dock along its bottom edge.
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
      // A DOCK page: the bottom dock's fixed icon owns it, never the strip.
      { id: "inbox", kind: "inbox", title: "Inbox", createdAt: 1 },
      // Legacy global file tab (no chatId, no workspace): visible everywhere,
      // and a real TAB — so it IS drawn in the strip.
      { id: "file:src/App.tsx", kind: "file", title: "App.tsx", filePath: "src/App.tsx", createdAt: 2 },
    ],
    activeId: "inbox",
    closed: [],
  }),
)

const React = await import("react")
const { renderToStaticMarkup } = await import("react-dom/server")
const { readFileSync } = await import("node:fs")
const {
  ViewerTabBar,
  ViewerAddButton,
  ViewerDockBar,
  ViewerPaneToggleButton,
  openTerminalTab,
} = await import("../src/components/ViewerTabBar")
const { useStore } = await import("../src/lib/store")
const { useViewerTabs, viewerTabRows } = await import("../src/lib/viewerTabs")

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
    } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? "")
  }
}

console.log("1) ViewerTabBar renders as the pane's TOP tab strip:")
{
  const html = renderToStaticMarkup(React.createElement(ViewerTabBar))
  const tabCount = (html.match(/role="tab"/g) ?? []).length
  // The seed holds a dock page (inbox) and a real file tab. Only the FILE is a
  // strip tab — the dock page must not leak into the strip.
  check("only real tabs get a row", tabCount === 1, html)
  check("a dock page never renders as a strip row", !html.includes("kind-inbox"), html)
  check("bar carries the strip class", html.includes("viewer-tabs-top"), html.slice(0, 160))
  check("bar announces a horizontal tablist", html.includes('aria-orientation="horizontal"'))
  check("every tab shows an icon", (html.match(/viewer-tab-icon/g) ?? []).length === tabCount)
  check(
    "every tab keeps its name in the markup (the strip is titled, not icon-only)",
    (html.match(/editor-tab-label/g) ?? []).length === tabCount,
  )
  check("the tab row carries a close button", html.includes("editor-tab-close"))
}

console.log("2) markup + CSS keep the strip on top and the dock at the bottom:")
{
  const appSrc = readFileSync("src/App.tsx", "utf8")
  const bodyAt = appSrc.indexOf('className="viewer-pane-body"')
  const headAt = appSrc.indexOf('className="viewer-pane-head"')
  const contentAt = appSrc.indexOf('className="viewer-content"')
  const dockAt = appSrc.indexOf("<ViewerDockBar")
  check("the pane body wraps the header", bodyAt !== -1 && headAt > bodyAt)
  check("the strip comes BEFORE the content", headAt !== -1 && headAt < contentAt)
  check("the dock comes AFTER the content", dockAt !== -1 && dockAt > contentAt)

  const css = readFileSync("src/styles/global.css", "utf8")
  const stripCss = css.slice(css.indexOf("--- side pane chrome"))
  check("the pane chrome block exists in the stylesheet", stripCss.length > 0)

  const head = stripCss.match(/\.viewer-pane-body \.viewer-pane-head\s*\{[^}]*\}/)
  check("the strip is a static top row (not an overlay)", /flex-direction:\s*row/.test(head?.[0] ?? "") && !/position:\s*absolute/.test(head?.[0] ?? ""), head?.[0])
  check("the strip parts from the content with a bottom hairline", /border-bottom:\s*1px solid/.test(head?.[0] ?? ""), head?.[0])

  const strip = stripCss.match(/\.viewer-pane-body \.viewer-tabs-top\s*\{[^}]*\}/)
  check("strip tabs squeeze instead of scrolling", /overflow-x:\s*hidden/.test(strip?.[0] ?? ""), strip?.[0])

  // The old icon rail is really gone: no fixed rail width, no gutter, no
  // hover-name card.
  check("the vertical rail geometry is gone", !css.includes("--viewer-rail-width") && !css.includes("--viewer-tab-hint"), undefined)
  check(
    "the dock block exists and is pinned to the bottom edge",
    /border-top:\s*1px solid/.test(css.match(/\.viewer-dock\s*\{[^}]*\}/)?.[0] ?? ""),
    css.match(/\.viewer-dock\s*\{[^}]*\}/)?.[0],
  )
  check(
    "dock icons share one uniform glyph size",
    /\.viewer-dock-btn svg\s*\{[^}]*width:\s*19px/.test(css),
    css.match(/\.viewer-dock-btn svg\s*\{[^}]*\}/)?.[0],
  )
  check(
    "the dock's active page owns an accent pill",
    /\.viewer-dock-btn\.active\s*\{[^}]*var\(--accent\)/.test(css),
  )

  const barSrc = readFileSync("src/components/ViewerTabBar.tsx", "utf8")
  check(
    "drag/keyboard reordering runs on the horizontal axis",
    // Pointer reorder goes through the geometric tabForPoint (clientX against
    // tab extents); keyboard reorder stays Alt+Arrow on the "x" axis.
    /tabForPoint\(/.test(barSrc) && /tabMove\(.*"x"\)/.test(barSrc),
  )
  // Every strip tab shows one ✕ of its own: closing a tab never switches to it.
  check(
    "each row's ✕ closes its own tab",
    /onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*useViewerTabs\.getState\(\)\.closeViewer\(t\.id\);\s*\}\}/.test(barSrc),
  )
  check(
    "the strip never publishes a hover-name card",
    !/viewer-tab-hint/.test(barSrc),
  )

  // Regression: a file chip opens on POINTERDOWN. The chat window refocuses on
  // pointerdown, which re-renders the message list and replaces the chip node
  // before the browser fires `click` — that swallowed the open and the pane
  // kept the previous page.
  const fileIconSrc = readFileSync("src/components/FileIcon.tsx", "utf8")
  check(
    "file chips open on pointerdown (a focus re-render cannot swallow it)",
    /<button[\s\S]{0,600}?onPointerDown=\{handle\}/.test(fileIconSrc),
  )
  check(
    "click stays as the backup path for a swapped node",
    /onPointerDown=\{handle\}[\s\S]{0,400}?onClick=\{handle\}/.test(fileIconSrc),
  )
  const chatSrc = readFileSync("src/components/Chat.tsx", "utf8")
  check(
    "the chat panel focuses on the CAPTURE phase so the file is scoped right",
    /onPointerDownCapture=\{/.test(chatSrc),
  )
}

console.log("3) the strip ends with [+ | spacer | fullscreen | pane toggle]:")
{
  const appSrc = readFileSync("src/App.tsx", "utf8")
  const headAt = appSrc.indexOf('className="viewer-pane-head"')
  const head = appSrc.slice(headAt, appSrc.indexOf("</div>", headAt))
  const listAt = head.indexOf("<ViewerTabListButton")
  const barAt = head.indexOf("<ViewerTabBar")
  const addAt = head.indexOf("<ViewerAddButton")
  const spacerAt = head.indexOf("viewer-pane-spacer")
  const fullAt = head.indexOf("<ViewerPaneFullscreenButton")
  const toggleAt = head.indexOf("<ViewerPaneToggleButton")
  check("the tab-list chevron leads the strip", listAt !== -1 && listAt < barAt)
  check("the tabs follow the chevron", barAt !== -1 && barAt > listAt)
  check("the \"+\" menu follows the tabs (a new-tab button)", addAt > barAt)
  check("the spacer sits between the tabs and the action icons", spacerAt > addAt)
  check("the fullscreen toggle sits in the action group", fullAt > spacerAt)
  check("the pane toggle sits to the RIGHT of the fullscreen toggle", toggleAt > fullAt)
  check("the dock renders after the content (no toggle inside it)", !appSrc.slice(appSrc.indexOf("<ViewerDockBar")).includes("viewer-dock-toggle"))

  const css = readFileSync("src/styles/global.css", "utf8")
  check("strip icon buttons share one geometry", /\.viewer-pane-head \.titlebar-icon-btn/.test(css))
}

console.log("4) the \"+\" menu opens ONLY the chat-owned pages; the dock owns the rest:")
{
  const barSrc = readFileSync("src/components/ViewerTabBar.tsx", "utf8")
  const addBody = (barSrc.match(/export function ViewerAddButton\(\)[\s\S]*?\n\}/) ?? [""])[0]
  for (const kind of ["browser", "trace"]) {
    check(`the "+" menu opens the ${kind} page`, addBody.includes(`key: "${kind}"`), kind)
  }
  for (const kind of ["files", "todos", "artifacts", "review", "schedule", "inbox"]) {
    check(`the "+" menu does NOT offer the ${kind} dock page`, !addBody.includes(`key: "${kind}"`), kind)
  }
  const addHtml = renderToStaticMarkup(React.createElement(ViewerAddButton))
  check("the trigger carries its own \"+\" glyph", addHtml.includes('class="tab-list-btn viewer-add-btn"'), addHtml)
  check("and announces itself as the page menu", addHtml.includes('aria-label="Open a page"'), addHtml)

  // The dock carries a FIXED icon per page (T3-Code-style launcher row).
  const dockHtml = renderToStaticMarkup(React.createElement(ViewerDockBar))
  const dockButtons = (dockHtml.match(/viewer-dock-btn/g) ?? []).length
  check("the dock renders one button per page (7)", dockButtons === 7, dockHtml)
  for (const title of ["Files", "Todos", "Git diff", "Artifacts", "Schedule", "Inbox", "Terminal"]) {
    check(`the dock carries the ${title} page`, dockHtml.includes(`aria-label="${title}"`), title)
  }
  check("the dock announces itself as a toolbar", dockHtml.includes('aria-label="Pane pages"'))

  // Drive the real action behind the dock's terminal entry: it opens an
  // ORDINARY viewer tab in the pane.
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] } as never)
  useViewerTabs.getState().setPaneOpen(false)

  openTerminalTab()
  const v1 = useViewerTabs.getState()
  check("the dock opens a terminal TAB", v1.tabs.some((t) => t.kind === "terminal"), v1.tabs)
  check("it reveals the side pane", v1.paneOpen === true)
  check(
    "the tab carries the workspace root as its cwd",
    v1.tabs.find((t) => t.kind === "terminal")?.terminalCwd === useStore.getState().root,
  )
  check(
    "pressing it again focuses the same tab instead of stacking one",
    (() => {
      openTerminalTab()
      return useViewerTabs.getState().tabs.filter((t) => t.kind === "terminal").length === 1
    })(),
  )
}

console.log("5) dock pages never become strip rows (the surfaces stay separate):");
{
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as never)
  const vt = useViewerTabs.getState()
  vt.openSchedule()
  vt.openInbox()
  const tabs = useViewerTabs.getState().tabs
  check("each page became its own store entry", tabs.length === 2, tabs.map((t) => t.kind))
  check(
    "neither page is drawn as a strip row",
    viewerTabRows(tabs, { wsKey: "", chatId: useStore.getState().activeChatId ?? "" }).length === 0,
    tabs.map((t) => t.kind),
  )

  // The SSR render reads the store's SEEDED initial state (an inbox dock page
  // + a legacy global file tab), not the setState above — so the strip shows
  // exactly the file tab, and the dock page stays out of it.
  const html = renderToStaticMarkup(React.createElement(ViewerTabBar))
  check("the strip renders only the real tab of the seed", (html.match(/role="tab"/g) ?? []).length === 1 && html.includes("kind-file"), html)
  // The pane toggle is exported for the strip's action group.
  const toggleHtml = renderToStaticMarkup(React.createElement(ViewerPaneToggleButton))
  check("the pane toggle announces itself", toggleHtml.includes('aria-label="Hide side pane"'), toggleHtml)

  useViewerTabs.getState().closeViewer("schedule")
  const left = useViewerTabs.getState().tabs
  check("closing removes exactly that page", left.length === 1 && left[0].kind === "inbox", left)
}

if (failed) process.exit(1)
console.log("\nAll viewer pane strip/dock checks passed")
