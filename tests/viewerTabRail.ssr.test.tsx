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
const { ViewerTabBar } = await import("../src/components/ViewerTabBar")

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
  check("one tab rendered per persisted viewer", tabCount === 2, html)
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
  const addAt = head.indexOf("<ViewerAddButton")
  const barAt = head.indexOf("<ViewerTabBar")
  const spacerAt = head.indexOf("viewer-pane-spacer")
  check("the panel action icons render inside the rail", actionsAt !== -1)
  check("panel icons come before the tab-list chevron", actionsAt !== -1 && actionsAt < listAt)
  check("panel icons come before the tabs", actionsAt !== -1 && actionsAt < barAt)
  check("nothing is stacked above the panel icons", !head.slice(headAt === -1 ? 0 : 0, actionsAt).includes("<button"))
  check("the spacer drops below the tabs", spacerAt > barAt)
  check("the + opener sits right below the tabs", addAt > barAt && addAt < spacerAt)

  const css = readFileSync("src/styles/global.css", "utf8")
  const actions = css.match(/\.viewer-pane-body \.viewer-pane-actions\s*\{[^}]*\}/)
  check("the rail action container fills the rail width", /width:\s*100%/.test(actions?.[0] ?? ""), actions?.[0])
  check("rail icon buttons share one width", /\.viewer-pane-head \.titlebar-icon-btn/.test(css))
}

if (failed) process.exit(1)
console.log("\nAll viewer tab rail checks passed")
