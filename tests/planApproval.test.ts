// Plan approval + plan card tests (run via tests/run-frontend.sh).
// Covers: planDisplay (visible-text filtering around the plan card), the plan
// viewer tab (openPlan/closeViewer), setChatModeQuiet (silent mode sync after
// plan approval) and an SSR render of the docked PlanPanel.
//
// Mock the Electron/browser bridge before importing the store (it touches
// `window.coder` at import time).
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

const BODY = "## Plan\n1. do the thing\nFiles: backend/graph.py"
const BODY2 = "## Plan\n1. do the thing\n2. also write tests\nFiles: backend/graph.py"

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

const { planDisplay } = await import("../src/lib/planDoc")

console.log("۱) planDisplay — بدون planDoc دست نمی‌خورد:")
{
  const msg = {
    content: "hello world",
    segments: [{ kind: "text", text: "hello world" }],
  } as any
  const d = planDisplay(msg)
  check("content همان است", d.content === "hello world")
  check("segments همان است", d.segments === msg.segments)
}

console.log("۲) planDisplay — پیام سگمنتی: متن بعد از آخرین ابزار حذف می‌شود:")
{
  const msg = {
    planDoc: { title: "", body: BODY },
    content: "scouting… TOOL …" + BODY,
    segments: [
      { kind: "text", text: "scouting…" },
      { kind: "tool", index: 0 },
      { kind: "text", text: BODY },
    ],
  } as any
  const d = planDisplay(msg)
  check("متن پلن از نمایش حذف شد", !d.content?.includes("do the thing"), d.content)
  check("سگمنت ابزار ماند", d.segments?.length === 2 && d.segments[1].kind === "tool")
  check("محتوای اصلی دست نخورد", msg.content.includes(BODY))
}

console.log("۳) planDisplay — پیام ساده: برش با lastIndexOf بدنه پلن:")
{
  const msg = {
    planDoc: { title: "", body: BODY },
    content: "Here is my take:\n" + BODY,
  } as any
  const d = planDisplay(msg)
  check("فقط مقدمه می‌ماند", d.content === "Here is my take:", d.content)
}

console.log("۴) planDisplay — فال‌بک هدر ## Plan وقتی بدنه پیدا نشد:")
{
  const msg = {
    planDoc: { title: "", body: "## Plan\ntruncated" },
    content: "intro\n## Plan\nfull streamed body that never matched",
  } as any
  const d = planDisplay(msg)
  check("متن قبل از هدر می‌ماند", d.content === "intro", d.content)
}

console.log("۵) planDisplay — مقدمه وقتی فقط کارت ابزار مانده برگردانده می‌شود:")
{
  const msg = {
    planDoc: { title: "", body: BODY, preamble: "two lines of prose" },
    content: "two lines of prose" + BODY,
    segments: [{ kind: "tool", index: 0 }],
  } as any
  const d = planDisplay(msg)
  check(
    "مقدمه به‌صورت سگمنت متنی برمی‌گردد",
    d.segments?.length === 2 &&
      d.segments[0].kind === "text" &&
      (d.segments[0] as any).text === "two lines of prose",
    d.segments,
  )
}

console.log("۶) planDisplay — بدون مقدمه و بدون متن، حباب خالی می‌شود:")
{
  const msg = {
    planDoc: { title: "", body: BODY },
    content: BODY,
    segments: [{ kind: "tool", index: 0 }],
  } as any
  const d = planDisplay(msg)
  check("content خالی", d.content === "", d.content)
  check("فقط سگمنت ابزار", d.segments?.length === 1 && d.segments[0].kind === "tool")
}

console.log("۶-ب) planDisplay — متن پلن بین دو ابزار (update_plan بعد از پلن) حذف می‌شود:")
{
  // Plan mode writes the plan text and THEN calls update_plan, so the plan
  // segment sits between tool segments — it must not render in the tool group.
  const msg = {
    planDoc: { title: "", body: BODY },
    content: "scouting…" + BODY + "…",
    segments: [
      { kind: "tool", index: 0 },
      { kind: "text", text: "scouting…" + BODY },
      { kind: "tool", index: 1 },
    ],
  } as any
  const d = planDisplay(msg)
  check(
    "متن پلن از بین ابزارها حذف شد",
    !(d.segments ?? []).some((s) => s.kind === "text" && s.text.includes("do the thing")),
    d.segments,
  )
  check(
    "متنِ قبل از پلن و هر دو ردیف ابزار ماند",
    d.segments?.length === 3 &&
      d.segments[1].kind === "text" &&
      (d.segments[1] as any).text === "scouting…" &&
      d.segments[0].kind === "tool" &&
      d.segments[2].kind === "tool",
    d.segments,
  )
}

const { useViewerTabs } = await import("../src/lib/viewerTabs")

console.log("۷) تب Plan — openPlan تب plan می‌سازد و فعال می‌کند:")
{
  useViewerTabs.getState().closeViewer("plan")
  useViewerTabs.getState().openPlan()
  const s = useViewerTabs.getState()
  const tab = s.tabs.find((t) => t.kind === "plan")
  check("تب plan وجود دارد", !!tab)
  check("تب plan فعال است", s.activeId === "plan")
  check("عنوان Plan است", tab?.title === "Plan")
  // reopen فقط فوکوس می‌کند — تب تکراری ساخته نمی‌شود
  useViewerTabs.getState().openPlan()
  check("تب تکراری ساخته نمی‌شود", useViewerTabs.getState().tabs.filter((t) => t.kind === "plan").length === 1)
  useViewerTabs.getState().closeViewer("plan")
  check("closeViewer حذف می‌کند", !useViewerTabs.getState().tabs.some((t) => t.kind === "plan"))
}

console.log("۷-ب) تب Browser — openBrowser تب browser را می‌سازد و فعال می‌کند:")
{
  useViewerTabs.getState().closeViewer("browser")
  useViewerTabs.getState().openBrowser()
  const s = useViewerTabs.getState()
  const tab = s.tabs.find((t) => t.kind === "browser")
  check("تب browser وجود دارد", !!tab)
  check("تب browser فعال است", s.activeId === "browser")
  check("عنوان Browser است", tab?.title === "Browser")
  // Reopening only focuses the single tab — no duplicate is created.
  useViewerTabs.getState().openBrowser()
  check(
    "تب تکراری ساخته نمی‌شود",
    useViewerTabs.getState().tabs.filter((t) => t.kind === "browser").length === 1,
  )
  useViewerTabs.getState().closeViewer("browser")
  check("closeViewer حذف می‌کند", !useViewerTabs.getState().tabs.some((t) => t.kind === "browser"))
}

console.log("۷-ج) presetForViewport — پریست‌ها دقیقاً مثل لیست دستگاه‌های کروم:")
{
  const { VIEWPORT_PRESETS, PRESET_GROUP_ORDER, presetForViewport } = await import("../src/lib/browserViewport")
  check("۴۷ پریست دارد (۴۶ دستگاه کروم + دسکتاپ پیش‌فرض)", VIEWPORT_PRESETS.length === 47, VIEWPORT_PRESETS.length)
  check("دسکتاپ ۱۲۸۰×۸۰۰", presetForViewport(1280, 800)?.id === "desktop")
  check("iPhone 12 Pro دقیق کروم ۳۹۰×۸۴۴", presetForViewport(390, 844)?.id === "iphone-12-pro")
  check("Laptop HiDPI دقیق کروم ۱۴۴۰×۹۰۰", VIEWPORT_PRESETS.some((p) => p.id === "laptop-hidpi" && p.width === 1440 && p.height === 900))
  check("Nest Hub Max در گروه Smart Displays", VIEWPORT_PRESETS.some((p) => p.id === "nest-hub-max" && p.group === "smart_display" && p.width === 1280 && p.height === 800))
  check("Moto G4 دقیق کروم ۳۶۰×۶۴۰", VIEWPORT_PRESETS.some((p) => p.id === "moto-g4" && p.width === 360 && p.height === 640))
  check("ترتیب گروه‌ها مثل کروم است", JSON.stringify(PRESET_GROUP_ORDER) === JSON.stringify(["mobile", "foldable", "tablet_desktop", "smart_display"]))
  check("سایز دلخواه null برمی‌گرداند", presetForViewport(1024, 700) === null)
}

console.log("۷-د) BrowserPanel — فقط یک اینپوت (بدون اینپوت پایینی):")
{
  const React = (await import("react")).default
  const { renderToString } = await import("react-dom/server")
  const { BrowserPanel } = await import("../src/components/BrowserPanel")
  const html = renderToString(React.createElement(BrowserPanel))
  const inputs = html.match(/<input/g) ?? []
  check("فقط یک اینپوت (omnibox) دارد", inputs.length === 1, inputs)
  check("اینپوت پایینی Type حذف شد", !html.includes("Type into the page"))
  check("استیج فوکوس‌پذیر است (کیبورد صفحه)", html.includes('tabindex="0"'))
}

const { useStore } = await import("../src/lib/store")

console.log("۸) setChatModeQuiet — سوییچ بی‌صدا بدون پیام مارکر:")
{
  const id = useStore.getState().newChat("plan")
  const before = useStore.getState().chats.find((c) => c.id === id)!.messages.length
  useStore.getState().setChatModeQuiet(id, "coder")
  const chat = useStore.getState().chats.find((c) => c.id === id)!
  check("mode عوض شد", chat.mode === "coder")
  check("پیام مارکر اضافه نشد", chat.messages.length === before)
  // کنتراست: setChatMode مارکر می‌گذارد
  useStore.getState().setChatMode(id, "plan")
  const chat2 = useStore.getState().chats.find((c) => c.id === id)!
  check("setChatMode معمولی مارکر می‌گذارد", chat2.messages.length === before + 1 && chat2.mode === "plan")
}

console.log("۹) latestPlanDoc — آخرین planDoc چت فعال، جدیدترین اول:")
{
  const { latestPlanDoc } = await import("../src/lib/planDoc")
  const chats = [
    {
      id: "c1",
      messages: [
        { planDoc: { title: "old", body: "## Plan\nold" } },
        { planDoc: { title: "new", body: "## Plan\nnew" } },
      ],
    },
    { id: "c2", messages: [{ planDoc: { title: "other", body: "x" } }] },
  ] as any
  const d = latestPlanDoc(chats, "c1")
  check("جدیدترین planDoc برمی‌گردد", d?.title === "new", d)
  check("planDoc بدون body رد می‌شود", latestPlanDoc([{ id: "c3", messages: [{ planDoc: { title: "t", body: "" } }] }] as any, "c3") === null)
  check("چت ناموجود → null", latestPlanDoc(chats, "nope") === null)
  check("چت بدون planDoc → null", latestPlanDoc([{ id: "c4", messages: [{ content: "hi" }] }] as any, "c4") === null)
}

console.log("۱۰) PlanPanel — SSR رندر بدون کرش (زوستاند در SSR از initial state می‌خواند):")
{
  const React = (await import("react")).default
  const { renderToString } = await import("react-dom/server")
  const { PlanPanel } = await import("../src/components/PlanPanel")
  const html = renderToString(React.createElement(PlanPanel))
  check("کروم پنل رندر شد", html.includes("review-panel") && html.includes("Plan"))
  check("حالت خالی نشان داده می‌شود", html.includes("No plan yet"), html.slice(0, 200))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
