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
const { ViewerTabBar, ViewerAddButton, openTerminalTab } = await import("../src/components/ViewerTabBar")
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

console.log("1) ViewerTabBar renders as a vertical icon rail:")
{
  const html = renderToStaticMarkup(React.createElement(ViewerTabBar))
  const tabCount = (html.match(/role="tab"/g) ?? []).length
  // The seed holds TWO tabs (an inbox page and a legacy global file tab). Pages
  // are ordinary tabs now, so BOTH are rows, each with its own ✕.
  check("every open tab gets a row", tabCount === 2, html)
  check("a page is drawn as a row like any other tab", html.includes('kind-inbox'), html)
  check("bar carries the rail class", html.includes("viewer-tabs-rail"), html.slice(0, 160))
  check("bar announces a vertical tablist", html.includes('aria-orientation="vertical"'))
  check("every tab shows an icon", (html.match(/viewer-tab-icon/g) ?? []).length === tabCount)
  check(
    "every tab keeps its name in the markup (shown beside the row on hover)",
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
  check(
    "many tabs scroll inside the rail instead of spilling over the icons",
    /overflow-y:\s*auto/.test(rail?.[0] ?? "") && /overflow-x:\s*hidden/.test(rail?.[0] ?? ""),
    rail?.[0],
  )
  check(
    "the rail is visually parted from the page icons above it",
    /border-top:\s*1px solid/.test(rail?.[0] ?? ""),
    rail?.[0],
  )

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

  // Regression: hovering must never widen the rail (squeezing the viewer) or
  // repaint the rail/head container. A row's own hover surface is fine: it
  // stays inside the row's box.
  const hoverHeadRules = railCss.match(/\.viewer-pane-body[^{}]*:hover[^{}]*\{[^}]*\}/g) ?? []
  const containerHoverRules = hoverHeadRules.filter(
    (r) => !/\.editor-tab/.test(r) && !/viewer-tab-hint/.test(r),
  )
  check(
    "hovering never widens the rail or repaints it",
    containerHoverRules.length === 0,
    containerHoverRules,
  )
  check(
    "the collapsed width is never overridden",
    !/--viewer-rail-width:\s*var\(--viewer-rail-open-width\)/.test(railCss),
  )
  check(
    "viewer content keeps a constant rail gutter",
    /\.viewer-pane-body > \.viewer-content\s*\{[^}]*padding-right:\s*var\(--viewer-rail-width\)/.test(railCss),
  )
  check(
    "no rail row is painted translucent",
    !/\.viewer-tabs-rail \.editor-tab[^{}]*\{[^}]*opacity:\s*0?\.\d/.test(railCss),
  )

  // Every row names itself while hovered (the rail is one icon wide, so the
  // name floats beside it); the ✕ swaps in for the icon on the same square.
  const label = railCss.match(/\.viewer-tabs-rail \.editor-tab-label\s*\{[^}]*\}/)
  check("tab labels stay icon-only at rest", /display:\s*none/.test(label?.[0] ?? ""), label?.[0])

  // The name floats beside the rail while hovered, so the rail's width never
  // changes and the viewer never jumps.
  const hint = railCss.match(
    /\.viewer-pane-body \.viewer-tabs-rail \.editor-tab:hover \.editor-tab-label[^{]*\{[^}]*\}/,
  )
  check("a hovered row shows its name", hint !== null, hint?.[0])
  check(
    "the name floats outside the rail's box",
    /position:\s*fixed/.test(hint?.[0] ?? "") &&
      /right:\s*var\(--viewer-tab-hint-right/.test(hint?.[0] ?? ""),
    hint?.[0],
  )
  check(
    "the name stays reachable (it never vanishes mid-move)",
    /pointer-events:\s*auto/.test(hint?.[0] ?? ""),
    hint?.[0],
  )
  // The card holds the name AND the ✕ on the row's own square: one surface,
  // two hit areas (name activates, ✕ closes).
  check(
    "the name card lands on the row and holds the ✕",
    /height:\s*30px/.test(hint?.[0] ?? "") &&
      /border-radius:\s*6px/.test(hint?.[0] ?? "") &&
      /display:\s*flex/.test(hint?.[0] ?? ""),
    hint?.[0],
  )
  // The ✕ is a bare glyph on the card's surface: a box behind it made it look
  // like a second control sitting next to the title.
  const closeHoverBox = railCss.match(
    /\.viewer-pane-body \.viewer-tabs-rail \.editor-tab \.editor-tab-close:hover[^{]*\{[^}]*\}/,
  )
  check(
    "a hovered ✕ only recolors its glyph",
    /background:\s*none/.test(closeHoverBox?.[0] ?? ""),
    closeHoverBox?.[0],
  )
  const closeBox = railCss.match(/\.editor-tab \.editor-tab-close\s*\{[^}]*\}/)
  check(
    "the ✕ sits inside the card instead of covering the row",
    /position:\s*static/.test(closeBox?.[0] ?? "") && /width:\s*26px/.test(closeBox?.[0] ?? ""),
    closeBox?.[0],
  )
  check(
    "the ✕ swaps with the tab's kind icon on hover",
    /\.editor-tab:hover \.viewer-tab-icon[^{]*\{[^}]*opacity:\s*0/.test(railCss),
  )
  check(
    "the rail keeps its one-icon width",
    /--viewer-rail-width:\s*42px/.test(railCss),
  )
  // Regression: the name/✕ card must be hover-only. `:focus-within` kept it
  // painted after a click, so a stale card floated over content and swallowed
  // the next click (it closed the OTHER row's tab, and the pane fell back to
  // the Schedule page).
  const railStateRules = railCss.match(/\.viewer-pane-body[^{}]*\.editor-tab[^{}]*\{[^}]*\}/g) ?? []
  check(
    "the name card is never painted from :focus-within",
    !railStateRules.some((r) => /:focus-within/.test(r) && /editor-tab-label|editor-tab-close|viewer-tab-icon/.test(r)),
    railStateRules.filter((r) => /:focus-within/.test(r)),
  )
  check(
    "keyboard focus can still reveal the card",
    /\.editor-tab:focus-visible \.editor-tab-label/.test(railCss),
  )

  const barSrc = readFileSync("src/components/ViewerTabBar.tsx", "utf8")
  // The ✕ lives INSIDE the name card: one surface, two behaviors.
  check(
    "the markup nests the ✕ in the name card",
    /<span className="editor-tab-label"[\s\S]{0,400}?className="editor-tab-close"/.test(barSrc),
  )
  check(
    "the row publishes its own center and right edge for the card",
    /--viewer-tab-hint-top/.test(barSrc) &&
      /--viewer-tab-hint-right/.test(barSrc) &&
      /onMouseEnter=/.test(barSrc),
  )
  check(
    "drag/keyboard reordering runs on the vertical axis",
    /dropSide\(e\.clientY, rect, "y"\)/.test(barSrc) && /tabMove\(.*"y"\)/.test(barSrc),
  )

  // Regression: a rail icon only ever OPENED/FOCUSED its page. It must never
  // carry a `close` prop, or a second press closed an open tab and the pane
  // fell back to whatever page was left (the reported "clicking trace closed
  // the file tab"). The page icons are gone, so the same rule now binds the
  // "+" menu entries: opening a page never closes any other tab.
  check(
    "the rail never carries a close-prop for a page",
    !/closeTitle=/.test(barSrc) && !/\n\s+close=\{/.test(barSrc),
    (barSrc.match(/closeTitle=|\n\s+close=\{/g) ?? []).slice(0, 4),
  )
  check(
    "opening a page from the \"+\" menu never closes a tab",
    /export function ViewerAddButton\(\)[\s\S]*?\n\}/.test(barSrc) &&
      !/onClose:/.test((barSrc.match(/export function ViewerAddButton\(\)[\s\S]*?\n\}/) ?? [""])[0]),
  )

  // Regression: the card's ✕ lands exactly on the row's icon square (hover
  // replaces the kind icon), so the click meant to SWITCH to a tab hit the ✕
  // and closed the tab the user wanted — the reported "clicking a file closed
  // the previous tab and showed Trace/Schedule". Only the SHOWN tab's ✕ closes;
  // an inactive row is activated instead.
  check(
    "the ✕ of an inactive row switches to it instead of closing it",
    /if \(!active\) \{[\s\S]{0,160}?setActiveViewer\(t\.id\)[\s\S]{0,80}?return/.test(barSrc) &&
      /closeViewer\(t\.id\)/.test(barSrc),
    (barSrc.match(/if \(!active\) \{[\s\S]{0,160}?setActiveViewer/g) ?? []).slice(0, 2),
  )

  // Regression: a file chip opens on POINTERDOWN. The chat window refocuses on
  // pointerdown, which re-renders the message list and replaces the chip node
  // before the browser fires `click` — that swallowed the open and the pane
  // kept the previous page (Trace/Schedule).
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
  // One entry point for every page: the rail's "+" menu. Fixed page icons are
  // gone, so no page owns a button of its own any more.
  check("the \"+\" menu trigger is in the rail", head.includes("<ViewerAddButton"))
  check(
    "no fixed page icon is mounted",
    !head.includes("ViewerFilesButton") && !head.includes("ViewerInboxButton"),
  )

  const css = readFileSync("src/styles/global.css", "utf8")
  const actions = css.match(/\.viewer-pane-body \.viewer-pane-actions\s*\{[^}]*\}/)
  check("the rail action container fills the rail width", /width:\s*100%/.test(actions?.[0] ?? ""), actions?.[0])
  check("rail icon buttons share one width", /\.viewer-pane-head \.titlebar-icon-btn/.test(css))
}

console.log("4) one \"+\" menu instead of fixed page icons:");
{
  const appSrc = readFileSync("src/App.tsx", "utf8")
  const headAt = appSrc.indexOf('className="viewer-pane-head"')
  const head = appSrc.slice(headAt, appSrc.indexOf("</section>", headAt))
  const listAt = head.indexOf("<ViewerTabListButton")
  const fullAt = head.indexOf("<ViewerPaneFullscreenButton")
  const addAt = head.indexOf("<ViewerAddButton")
  const barAt = head.indexOf("<ViewerTabBar")
  const spacerAt = head.indexOf("viewer-pane-spacer")

  check("the \"+\" menu renders in the rail", addAt !== -1, head.slice(0, 1200))
  check("fullscreen sits directly below the tab-list chevron", listAt !== -1 && fullAt > listAt)
  check("the \"+\" menu follows the fullscreen toggle", addAt > fullAt)
  check("the rail rows and the tabs come last", barAt > addAt && spacerAt > barAt)
  // The pane can be expanded with NO tab open (its body then falls back to the
  // todos page), so the toggle must never be gated on the tab count.
  check(
    "the fullscreen toggle is not gated on open tabs",
    /viewerFull && !chatFull/.test(appSrc),
    appSrc.match(/viewerFull &&[^?]*\?/)?.[0],
  )

  const barSrc = readFileSync("src/components/ViewerTabBar.tsx", "utf8")
  // Every page the menu offers must be a real tab kind, so the row it lands on
  // can be closed: nothing is icon-owned any more.
  for (const kind of ["files", "todos", "artifacts", "review", "trace", "browser", "schedule", "inbox"]) {
    check(`the "+" menu opens the ${kind} page`, barSrc.includes(`key: "${kind}"`), kind)
  }
  const addHtml = renderToStaticMarkup(React.createElement(ViewerAddButton))
  check("the trigger carries its own \"+\" glyph", addHtml.includes('class="tab-list-btn viewer-add-btn"'), addHtml)
  check("and announces itself as the page menu", addHtml.includes('aria-label="Open a page"'), addHtml)

  // Drive the real action behind the menu's terminal entry: it opens an
  // ORDINARY viewer tab in the pane (the old dock-into-the-pane mode is gone).
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] })
  useViewerTabs.getState().setPaneOpen(false)

  openTerminalTab()
  const v1 = useViewerTabs.getState()
  check("the menu opens a terminal TAB", v1.tabs.some((t) => t.kind === 'terminal'), v1.tabs)
  check("it reveals the side pane", v1.paneOpen === true)
  check(
    "the tab carries the workspace root as its cwd",
    v1.tabs.find((t) => t.kind === 'terminal')?.terminalCwd === useStore.getState().root,
  )
  check(
    "pressing it again focuses the same tab instead of stacking one",
    (() => {
      openTerminalTab()
      return useViewerTabs.getState().tabs.filter((t) => t.kind === 'terminal').length === 1
    })(),
  )
}

console.log("5) every page opened from the \"+\" menu is a closable tab:");
{
  // The rail renders ONE ROW PER TAB — pages included — and every row carries
  // the ✕: that is what makes a page opened from the menu deletable like a file.
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as never)
  const vt = useViewerTabs.getState()
  vt.openSchedule()
  vt.openInbox()
  const tabs = useViewerTabs.getState().tabs
  check("each page became its own tab", tabs.length === 2, tabs.map((t) => t.kind))
  check(
    "both pages are drawn as rail rows",
    viewerTabRows(tabs, useStore.getState().activeChatId).length === 2,
  )

  const html = renderToStaticMarkup(React.createElement(ViewerTabBar))
  check("both rows render", (html.match(/role="tab"/g) ?? []).length === 2, html)
  check(
    "every row carries a close button",
    (html.match(/editor-tab-close/g) ?? []).length === 2,
    html,
  )

  useViewerTabs.getState().closeViewer("schedule")
  const left = useViewerTabs.getState().tabs
  check("closing the row removes exactly that page", left.length === 1 && left[0].kind === "inbox", left)
}

if (failed) process.exit(1)
console.log("\nAll viewer tab rail checks passed")
