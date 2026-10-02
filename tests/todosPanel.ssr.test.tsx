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
  check("y دست نمی‌خورد و height قدیمی حذف می‌شود", res.y === 46 && res.height === undefined, res)
}

console.log("۵) loadTodoPanelUi — کلید جدید با right مستقیم (v2):")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({
      v: 2,
      right: 100,
      y: 200,
      collapsed: true,
      heights: { "chat-a": 400 },
    }),
  }
  const res = loadTodoPanelUi()
  check("مقادیر کلید جدید استفاده می‌شوند", res.right === 100 && res.y === 200 && res.collapsed === true, res)
  check("heights خوانده می‌شود", res.heights?.["chat-a"] === 400, res)
}

console.log("۶) loadTodoPanelUi — مهاجرت v2: ذخیرهٔ قدیمی بدون v → heights ریست:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({
      right: 16,
      y: 46,
      height: 300,
      heights: { "chat-a": 400, "chat-b": 250 },
    }),
  }
  const res = loadTodoPanelUi()
  // نسخهٔ باگ‌دار قبلی ارتفاع جاریِ چت فعال را هم در heights می‌نوشت؛
  // رکوردهای آلوده از ریسایز واقعی قابل تفکیک نیستند → همه ریست.
  check("heights آلوده حذف می‌شود", res.heights === undefined, res)
  check("height قدیمی حذف می‌شود", res.height === undefined, res)
  check("موقعیت و collapsed حفظ می‌شوند", res.right === 16 && res.y === 46, res)
}

console.log("۷) loadTodoPanelUi — مهاجرت از coder:sidebarUi قدیمی:")
{
  localStorage._d = {
    "coder:sidebarUi": JSON.stringify({ todoCollapsed: true, todoHeight: 200 }),
  }
  const res = loadTodoPanelUi()
  check("todoCollapsed → collapsed", res.collapsed === true)
  // todoHeight سراسری بود و زیر مدل per-chat جا نمی‌شود → نادیده گرفته
  // می‌شود تا پیش‌فرضِ بر اساس تعداد todo اعمال شود.
  check("todoHeight نادیده گرفته می‌شود", res.height === undefined && res.heights === undefined, res)
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

console.log("۱۰) ارتفاع per-chat — خواندن heights در ذخیرهٔ v2:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({
      v: 2,
      right: 16,
      y: 46,
      heights: { "chat-a": 400 },
    }),
  }
  const res = loadTodoPanelUi()
  check("heights برای chat-a خوانده می‌شود", res.heights?.["chat-a"] === 400, res)
}

console.log("۱۱) ارتفاع per-chat — چت بدون رکورد → پیش‌فرضِ تعداد (نه height عمومی):")
{
  const { heightForChat } = await import("../src/components/TodosPanel")
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({
      v: 2,
      right: 16,
      y: 46,
      heights: { "chat-a": 400 },
    }),
  }
  const res = loadTodoPanelUi()
  check("heights بدون chat-b", res.heights?.["chat-b"] === undefined, res)
  // chat-b رکورد ندارد → ارتفاع مؤثر از پیش‌فرضِ تعداد می‌آید
  check("ارتفاع مؤثر chat-b = پیش‌فرضِ تعداد", heightForChat(res.heights, "chat-b", 5) === 116)
}

console.log("۱۲) ارتفاع per-chat — ذخیرهٔ v2 بدون heights اصلاً:")
{
  localStorage._d = {
    "coder:todoPanel": JSON.stringify({ v: 2, right: 16, y: 46 }),
  }
  const res = loadTodoPanelUi()
  check("heights تعریف نمی‌شود", res.heights === undefined, res)
  const { heightForChat } = await import("../src/components/TodosPanel")
  check("ارتفاع مؤثر = پیش‌فرضِ تعداد", heightForChat(res.heights, "chat-x", 10) === 226)
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
  check("ارتفاع صریح چت برنده می‌شود", heightForChat({ "chat-a": 400 }, "chat-a", 5) === 400)
  check("چت بدون رکورد → پیش‌فرضِ تعداد", heightForChat({ "chat-a": 400 }, "chat-b", 5) === 116)
  check("بدون رکورد → پیش‌فرضِ تعداد", heightForChat(undefined, "chat-b", 5) === 116)
  check("heights خالی → حداقل پیش‌فرض", heightForChat({}, "chat-x", 0) === 60)
}

console.log("۱۶) پنل راست — تاگل استور و لایه‌بندی زدایندکس:")
{
  const { useStore } = await import("../src/lib/store")
  const s0 = useStore.getState()
  const initial = s0.rightPanelOpen
  s0.setRightPanelOpen(!initial)
  check("setRightPanelOpen مقدار را ست می‌کند", useStore.getState().rightPanelOpen === !initial)
  useStore.getState().toggleRightPanel()
  check("toggleRightPanel برمی‌گرداند", useStore.getState().rightPanelOpen === initial)
  // لایه‌بندی: پنل راست همیشه پشت مطالعه و گیت‌دیف
  const { readFileSync } = await import("node:fs")
  const css = readFileSync("src/styles/global.css", "utf8")
  const pick = (name: string) => {
    const m = css.match(new RegExp(`${name}:\\s*(\\d+)`))
    return m ? parseInt(m[1], 10) : NaN
  }
  const zRight = pick("--z-right-panel")
  const zReading = pick("--z-reading-mode")
  const zReview = pick("--z-review-overlay")
  check("زدایندکس پنل راست پشت مطالعه است", zRight < zReading, { zRight, zReading })
  check("زدایندکس پنل راست پشت اورلی دیف است", zRight < zReview, { zRight, zReview })
}

console.log("۱۷) پنل راست هرگز خودکار باز نمی‌شود:")
{
  const mod = await import("../src/components/TodosPanel") as Record<string, unknown>
  check("تابع بازشدن خودکار حذف شده است", mod["shouldAutoOpenTodosPanel"] === undefined)
  const { readFileSync } = await import("node:fs")
  const chatSrc = readFileSync("src/components/Chat.tsx", "utf8")
  check("Chat.tsx پنل را خودکار باز نمی‌کند", !chatSrc.includes("setRightPanelOpen(true)"))
}

console.log("۱۹) سکشن Laya — برچسب مسیر، لحن کارت و درصد اطمینان:")
{
  const { layaRouteLabel, layaCardTone, layaConfidencePct } = await import("../src/components/LayaLabels")
  check("مسیر computer فارسی می‌شود", layaRouteLabel("computer") === "کامپیوتر")
  check("مسیر browser فارسی می‌شود", layaRouteLabel("browser") === "مرورگر")
  check("مسیر normal فارسی می‌شود", layaRouteLabel("normal") === "معمولی")
  check("لوکال موفق لحن local می‌گیرد", layaCardTone({ route: "browser", confidence: 0.9, abstained: false, reason: "", handled: true, providerId: "local", model: "m", elapsedMs: 120, at: 1 } as any) === "local")
  check("خارجی موفق لحن external می‌گیرد", layaCardTone({ route: "browser", confidence: 0.9, abstained: false, reason: "", handled: true, providerId: "openrouter", model: "m", elapsedMs: 120, at: 1 } as any) === "external")
  check("واگذاری لحن fallback می‌گیرد", layaCardTone({ route: "normal", confidence: 0.1, abstained: true, reason: "", handled: false, providerId: "local", model: "m", elapsedMs: 5, at: 1 } as any) === "fallback")
  check("اطمینان ۰٫۹ می‌شود ۹۰", layaConfidencePct(0.9) === 90)
  check("اطمینان نامعتبر می‌شود ۰", layaConfidencePct(NaN) === 0)
  check("اطمینان بالای یک clamp می‌شود", layaConfidencePct(9) === 100)
}

console.log("۲۰) تاریخچه laya — per-chat با سقف ~۲۰ تا:")
{
  const { useStore, appendLayaRun } = await import("../src/lib/store")
  const chatId = useStore.getState().newChat("ask")
  const mk = (i: number) => ({ route: "browser", confidence: 0.8, abstained: false, reason: "r", handled: true, providerId: "local", model: "m", elapsedMs: 10 + i })
  for (let i = 0; i < 25; i++) useStore.getState().appendLayaRun(chatId, mk(i))
  const runs = useStore.getState().chats.find((c) => c.id === chatId)?.layaRuns ?? []
  check("سقف تاریخچه ۲۰ تاست", runs.length === 20, runs.length)
  check("تازه‌ترین آخر می‌ماند", runs[runs.length - 1].elapsedMs === 34, runs[runs.length - 1])
  const otherId = useStore.getState().newChat("ask")
  const otherRuns = useStore.getState().chats.find((c) => c.id === otherId)?.layaRuns ?? []
  check("تاریخچه چت دیگر قاطی نمی‌شود", otherRuns.length === 0)
  const capped = appendLayaRun(undefined, mk(0))
  check("append خالص روی undefined کار می‌کند", capped.length === 1 && capped[0].route === "browser")
}

console.log("۱۸) چت جدید — پنل راست دیفالت بسته است:")
{
  const { useStore } = await import("../src/lib/store")
  useStore.getState().setRightPanelOpen(true)
  useStore.getState().newChat("ask")
  check("newChat پنل باز را می‌بندد", useStore.getState().rightPanelOpen === false)
  useStore.getState().setRightPanelOpen(true)
  useStore.getState().newChatInRoot("", "ask")
  check("newChatInRoot پنل باز را می‌بندد", useStore.getState().rightPanelOpen === false)
}

console.log("۲۱) پنل Trace — عنوان ردیف و فیلتر جست‌وجو:")
{
  const { traceRowTitle, filterTraces } = await import("../src/components/TracePanel")
  check("summary خالی llm از مدل+توکن ساخته می‌شود", traceRowTitle({ id: "a", at: 1, kind: "llm", summary: "", model: "m", tokens: { total: 42 } } as any) === "m · 42 tokens")
  check("summary موجود دست نمی‌خورد", traceRowTitle({ id: "b", at: 1, kind: "laya", summary: "normal · 90٪" } as any) === "normal · 90٪")
  const rows = [
    { id: "1", at: 1, kind: "laya", summary: "browser · 90٪", prompt: "open site" },
    { id: "2", at: 2, kind: "llm", summary: "m · 10 tokens", model: "gpt" },
    { id: "3", at: 3, kind: "tool", summary: "read", prompt: '{"path": "secret-file"}', result: "file-ok" },
  ] as any
  check("جست‌وجو ردیف منطبق را نگه می‌دارد", filterTraces(rows, "browser").length === 1)
  check("جست‌وجو داخل پرامپت ابزار را پیدا می‌کند", filterTraces(rows, "secret-file").length === 1)
  check("جست‌وجو داخل نتیجه ابزار را پیدا می‌کند", filterTraces(rows, "file-ok").length === 1)
  check("جست‌وجوی خالی همه را برمی‌گرداند", filterTraces(rows, "").length === 3)
  check("عنوان ابزار از نام ابزار ساخته می‌شود", traceRowTitle({ id: "t", at: 1, kind: "tool", summary: "", detail: { name: "read" } } as any) === "read")
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
