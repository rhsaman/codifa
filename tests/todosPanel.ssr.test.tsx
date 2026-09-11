// SSR sanity test for TodosPanel pure functions (run via test/run-frontend.sh).
// Covers: latestTodos (last non-empty plan), loadTodoPanelUi (migration from
// legacy x-anchor and coder:sidebarUi), clampPos (right/y bounds clamping).
//
// Mock the Electron/browser bridge before importing the component (the store
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

const { latestTodos, loadTodoPanelUi, clampPos } = await import(
  "../src/components/TodosPanel"
)

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

console.log("۱) latestTodos — آخرین plan غیرخالی:")
{
  const messages = [
    { plan: [] },
    { plan: [{ content: "A", status: "pending" }] },
    { plan: [{ content: "B", status: "completed" }] },
  ] as any
  const res = latestTodos(messages)
  check("آخرین پیام با plan برگردانده می‌شود", res.length === 1 && res[0].content === "B")
}

console.log("۲) latestTodos — پیام بدون plan و plan خالی رد می‌شوند:")
{
  const messages = [
    { plan: [] },
    { other: "data" },
    { plan: [{ content: "C", status: "in_progress" }] },
  ] as any
  const res = latestTodos(messages)
  check("پیام وسط بدون plan نادیده گرفته می‌شود", res.length === 1 && res[0].content === "C")
}

console.log("۳) latestTodos — بدون plan → آرایه خالی:")
{
  const messages = [{ other: "x" }, { plan: [] }] as any
  const res = latestTodos(messages)
  check("خالی برمی‌گرداند", res.length === 0)
}

console.log("۴) loadTodoPanelUi — مهاجرت از x قدیمی (لنگر چپ) به right:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({ x: 884, y: 46, collapsed: false, height: 320 }),
  }
  const res = loadTodoPanelUi()
  // right = innerWidth(1200) - x(884) - PANEL_W(300) = 16
  check("x → right با کسر عرض پنل", res.right === 16, res)
  check("y دست نمی‌خورد و height ۳۲۰ ریست می‌شود", res.y === 46 && res.height === undefined, res)
}

console.log("۵) loadTodoPanelUi — کلید جدید با right مستقیم:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({ right: 100, y: 200, collapsed: true, height: 400 }),
  }
  const res = loadTodoPanelUi()
  check("مقادیر کلید جدید استفاده می‌شوند", res.right === 100 && res.y === 200 && res.collapsed === true && res.height === 400)
}

console.log("۶) loadTodoPanelUi — مهاجرت از coder:sidebarUi قدیمی:")
{
  localStorage._d = {
    "coder:sidebarUi": JSON.stringify({ todoCollapsed: true, todoHeight: 200 }),
  }
  const res = loadTodoPanelUi()
  check("todoCollapsed → collapsed", res.collapsed === true)
  check("todoHeight → height", res.height === 200)

  localStorage._d = {
    "coder:sidebarUi": JSON.stringify({ todoHeight: 320 }),
  }
  const res2 = loadTodoPanelUi()
  check("todoHeight ۳۲۰ (پیش‌فرض قدیمی) ریست می‌شود", res2.height === undefined, res2)
}

console.log("۷) loadTodoPanelUi — بدون ذخیره → آبجکت خالی:")
{
  localStorage._d = {}
  const res = loadTodoPanelUi()
  check("خالی برمی‌گرداند", Object.keys(res).length === 0)
}

console.log("۸) clampPos — مقادیر خارج از محدوده clamp می‌شوند:")
{
  // right منفیِ بزرگ (پنل کامل بیرونِ چپ) → حداقل -(300-40)
  const res = clampPos(-9999, 9999, 1200, 800)
  check("right حداقل -(PANEL_W-40)", res.right === -260)
  check("y حداکثر vh-40", res.y === 760)
  const res2 = clampPos(9999, -50, 1200, 800)
  check("right حداکثر vw-40", res2.right === 1160)
  check("y حداقل ۸", res2.y === 8)
}

console.log("۹) clampPos — مقادیر سالم دست نمی‌خورند:")
{
  const res = clampPos(16, 46, 1200, 800)
  check("بدون تغییر", res.right === 16 && res.y === 46)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
