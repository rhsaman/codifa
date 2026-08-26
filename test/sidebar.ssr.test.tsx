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
  // Seed the real zustand store with a workspace + chats so the chat rows
  // actually render in SSR (the component reads from useStore directly).
  const { useStore } = await import("../src/lib/store")
  useStore.setState({
    workspaces: [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }],
    chats: [
      { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
      { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 },
    ],
    pinnedWorkspaces: [],
    pinnedChats: [],
  } as any)
  const html = renderToString(<Sidebar />)
  // Every chat row should render a select checkbox + a title row wrapper.
  const checkboxCount = (html.match(/chat-select-checkbox/g) || []).length
  const titleRowCount = (html.match(/chat-item-title-row/g) || []).length
  check("چک‌باکس روی هر چت رندر می‌شود", checkboxCount > 0)
  check(
    "تعداد چک‌باکس برابر با تعداد ردیف عنوان چت‌هاست",
    checkboxCount === titleRowCount,
  )
  check("کلاس .chat-item-title-row روی هر چت هست", titleRowCount > 0)
  // The bulk-delete button only appears once chats are selected, so it must
  // NOT render in the default (nothing selected) state.
  check(
    "دکمهٔ حذف یک‌جا در حالت پیش‌فرض رندر نمی‌شود",
    !html.includes("group-delete-selected"),
  )
  // The chat-count badge should render with the group's chat total and not be
  // in the selected state by default.
  const countMatch = html.match(/sidebar-group-count[^>]*>([^<]*)</)
  check("بج تعداد چت‌ها رندر می‌شود", !!countMatch)
  check(
    "مقدار بج برابر با تعداد چت‌های گروه است (۲)",
    countMatch ? countMatch[1] === "2" : false,
    countMatch?.[1],
  )
  check(
    "بج در حالت پیش‌فرض data-selected=false دارد",
    html.includes('data-selected="false"'),
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
