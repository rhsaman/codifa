// SSR sanity test for the Sidebar header refactor (run via test/run-frontend.sh).
// Covers the integrated header: search moved to the top, the old
// "New workspace" full-width button is gone, and a compact icon button remains.
// Mock the Electron bridge + useStore before importing the component.
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
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

const { renderToString } = await import("react-dom/server")
const { Sidebar } = await import("../src/components/Sidebar")
const { useStore } = await import("../src/lib/store")

// Seed the store state before rendering. Zustand reads the live state at
// render time, so setState() before renderToString drives the SSR output.
useStore.setState({
  workspaces: [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }],
  chats: [
    { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
    { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 },
  ],
  pinnedWorkspaces: [],
  pinnedChats: [],
})

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

console.log("۱) هدر یکپارچه سایدبار (سرچ بالا + دکمهٔ فشرده):")
{
  const html = renderToString(<Sidebar />)
  check("رندر شد", html.length > 0)
  check("کلاس .sidebar-head رندر می‌شود", html.includes("sidebar-head"))
  check("سرچ به بالا رفته (.sidebar-search-input هست)", html.includes("sidebar-search-input"))
  check("متن placeholder «Search chats…» هست", html.includes("Search chats"))
  check("دکمهٔ فشرده .sidebar-head-btn هست", html.includes("sidebar-head-btn"))
  check(
    "فقط یک دکمهٔ هدر هست (دکمهٔ + حذف شد)",
    (html.match(/sidebar-head-btn/g) || []).length === 1,
  )
  check(
    "دکمهٔ قدیمی .sidebar-new-btn دیگر رندر نمی‌شود",
    !html.includes("sidebar-new-btn"),
  )
}

console.log("۲) تیک‌زدن چندتایی چت‌ها و حذف یک‌جا:")
{
  const html = renderToString(<Sidebar />)
  // In the default (no selection) state, chat rows render the 3-dot kebab,
  // NOT the select checkbox — the checkbox only appears in bulk-select mode.
  const checkboxCount = (html.match(/chat-select-checkbox/g) || []).length
  const kebabCount = (html.match(/chat-item-kebab/g) || []).length
  const titleRowCount = (html.match(/chat-item-title-row/g) || []).length
  check("در حالت پیش‌فرض چک‌باکس روی چت رندر نمی‌شود", checkboxCount === 0)
  check("آیکون ۳ نقطه روی هر چت رندر می‌شود", kebabCount > 0)
  check("کلاس .chat-item-title-row روی هر چت هست", titleRowCount > 0)
  // The workspace header actions (⋯ + +) must always be visible (not hover-only).
  check("دکمهٔ ۳ نقطهٔ ورک‌اسپیس همیشه رندر می‌شود", html.includes("Workspace options"))
  // The bulk-delete button only appears once chats are selected, so it must
  // NOT render in the default (nothing selected) state.
  check(
    "دکمهٔ حذف یک‌جا در حالت پیش‌فرض رندر نمی‌شود",
    !html.includes("group-delete-selected"),
  )
  // The chat-count badge renders the group's chat count (2 for the seeded demo
  // workspace) and is NOT in the selected state by default.
  const countMatch = html.match(/sidebar-group-count[^>]*>(\d+)</)
  check("بج تعداد چت‌ها رندر می‌شود", html.includes("sidebar-group-count"))
  check(
    "بج تعداد چت‌ها برابر با تعداد چت‌های گروه است (۲)",
    countMatch ? countMatch[1] === "2" : false,
    countMatch?.[1],
  )
  check(
    "در حالت پیش‌فرض data-selected روی false است",
    html.includes('data-selected="false"'),
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
