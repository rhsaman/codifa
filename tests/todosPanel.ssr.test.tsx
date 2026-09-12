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

const { latestTodos, loadTodoPanelUi, clampPos, defaultHeightFor } = await import(
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

console.log("۱۰) ارتفاع per-chat — خواندن از heights و fallback به height عمومی:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({
      right: 16,
      y: 46,
      heights: { "chat-a": 400 },
      height: 200,
    }),
  }
  const res = loadTodoPanelUi()
  check("heights برای chat-a خوانده می‌شود", res.heights?.["chat-a"] === 400, res)
  check("height عمومی به‌عنوان fallback حفظ می‌شود", res.height === 200, res)
}

console.log("۱۱) ارتفاع per-chat — چت بدون رکورد → fallback به height عمومی:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({
      right: 16,
      y: 46,
      heights: { "chat-a": 400 },
      height: 220,
    }),
  }
  const res = loadTodoPanelUi()
  // chat-b رکورد ندارد → کامپوننت باید height عمومی (۲۲۰) را بردارد
  check("heights بدون chat-b", res.heights?.["chat-b"] === undefined, res)
  check("height عمومی ۲۲۰ موجود است", res.height === 220, res)
}

console.log("۱۲) ارتفاع per-chat — بدون heights اصلاً (ذخیرهٔ قدیمی):")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({ right: 16, y: 46, height: 300 }),
  }
  const res = loadTodoPanelUi()
  check("heights تعریف نمی‌شود", res.heights === undefined, res)
  check("height عمومی ۳۰۰ خوانده می‌شود", res.height === 300, res)
}

console.log("۱۳) defaultHeightFor — ارتفاع پیش‌فرض بر اساس تعداد todoها:")
{
  check("صفر todo → حداقل ۶۰px", defaultHeightFor(0) === 60, defaultHeightFor(0))
  check("۵ todo → ۱۱۶px (۵×۲۲+۶)", defaultHeightFor(5) === 116, defaultHeightFor(5))
  check("۱۰ todo → ۲۲۶px (۱۰×۲۲+۶)", defaultHeightFor(10) === 226, defaultHeightFor(10))
  check("تعداد خیلی زیاد → حداکثر ۷۶۰px", defaultHeightFor(100) === 760, defaultHeightFor(100))
  check("مقدار گردشده صحیح است", Number.isInteger(defaultHeightFor(3)), defaultHeightFor(3))
}

console.log("۱۴) withChatHeight — ادغام ارتفاع بدون از دست دادن چت‌های دیگر:")
{
  const { withChatHeight } = await import("../src/components/TodosPanel")
  const h = withChatHeight({ "chat-a": 400 }, "chat-b", 250)
  check("ارتفاع chat-b اضافه شد", h["chat-b"] === 250, h)
  check("ارتفاع chat-a حفظ شد", h["chat-a"] === 400, h)
  const h2 = withChatHeight({ "chat-a": 400 }, "chat-a", 180)
  check("به‌روزرسانی chat-a مقدار قبلی را عوض می‌کند", h2["chat-a"] === 180, h2)
  const h3 = withChatHeight(undefined, "chat-c", 300)
  check("heights خالی → فقط چت جدید", Object.keys(h3).length === 1 && h3["chat-c"] === 300, h3)
  const h4 = withChatHeight({ "chat-a": 400 }, "", 300)
  check("chatId خالی → نقشه دست نمی‌خورد", h4["chat-a"] === 400 && Object.keys(h4).length === 1, h4)
}

console.log("۱۵) heightForChat — زنجیرهٔ fallback ارتفاع مؤثر یک چت:")
{
  const { heightForChat } = await import("../src/components/TodosPanel")
  check("ارتفاع صریح چت برنده می‌شود", heightForChat({ "chat-a": 400 }, 200, "chat-a", 5) === 400)
  check("چت بدون رکورد → ارتفاع قدیمی عمومی", heightForChat({ "chat-a": 400 }, 200, "chat-b", 5) === 200)
  check("بدون رکورد و بدون قدیمی → پیش‌فرضِ تعداد", heightForChat(undefined, undefined, "chat-b", 5) === 116)
  check("heights خالی → حداقل پیش‌فرض", heightForChat({}, undefined, "chat-x", 0) === 60)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
