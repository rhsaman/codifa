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

const { useViewerTabs, visibleTabs } = await import("../src/lib/viewerTabs")
const { useStore } = await import("../src/lib/store")

console.log("۷) تب Plan — openPlan تب plan می‌سازد و فعال می‌کند:")
{
  for (const t of useViewerTabs.getState().tabs.filter((x) => x.kind === "plan")) useViewerTabs.getState().closeViewer(t.id)
  useViewerTabs.getState().openPlan()
  const s = useViewerTabs.getState()
  const tab = s.tabs.find((t) => t.kind === "plan")
  check("تب plan وجود دارد", !!tab)
  check("تب plan فعال است", !!tab && s.activeId === tab.id)
  check("عنوان Plan است", tab?.title === "Plan")
  check("تب به چت فعال منتسب است", tab?.chatId === useStore.getState().activeChatId, tab)
  // reopen فقط فوکوس می‌کند — تب تکراری ساخته نمی‌شود
  useViewerTabs.getState().openPlan()
  check("تب تکراری ساخته نمی‌شود", useViewerTabs.getState().tabs.filter((t) => t.kind === "plan").length === 1)
  if (tab) useViewerTabs.getState().closeViewer(tab.id)
  check("closeViewer حذف می‌کند", !useViewerTabs.getState().tabs.some((t) => t.kind === "plan"))
}

console.log("۷-ب) تب Browser — openBrowser تب browser را می‌سازد و فعال می‌کند:")
{
  for (const t of useViewerTabs.getState().tabs.filter((x) => x.kind === "browser")) useViewerTabs.getState().closeViewer(t.id)
  useViewerTabs.getState().openBrowser()
  const s = useViewerTabs.getState()
  const tab = s.tabs.find((t) => t.kind === "browser")
  check("تب browser وجود دارد", !!tab)
  check("تب browser فعال است", !!tab && s.activeId === tab.id)
  check("عنوان Browser است", tab?.title === "Browser")
  // Reopening only focuses the single tab — no duplicate is created.
  useViewerTabs.getState().openBrowser()
  check(
    "تب تکراری ساخته نمی‌شود",
    useViewerTabs.getState().tabs.filter((t) => t.kind === "browser").length === 1,
  )
  if (tab) useViewerTabs.getState().closeViewer(tab.id)
  check("closeViewer حذف می‌کند", !useViewerTabs.getState().tabs.some((t) => t.kind === "browser"))
}

console.log("۷-ه) تب‌های browser/git چت‌محورند — هر چت تب‌های خودش را دارد:")
{
  useViewerTabs.getState().openBrowser("chat-a")
  useViewerTabs.getState().openGitDiff("chat-a")
  useViewerTabs.getState().openBrowser("chat-b")
  const s = useViewerTabs.getState()
  check("دو تب browser جدا برای دو چت", s.tabs.filter((t) => t.kind === "browser").length === 2, s.tabs.map((t) => t.id))
  const visA = visibleTabs(s.tabs, "chat-a")
  const visB = visibleTabs(s.tabs, "chat-b")
  check("چت a تب browser خودش را می‌بیند", visA.some((t) => t.id === "browser:chat-a"))
  check("چت b تب browser چت a را نمی‌بیند", !visB.some((t) => t.id === "browser:chat-a"))
  check("چت a تب browser چت b را نمی‌بیند", !visA.some((t) => t.id === "browser:chat-b"))
  check("تب git هم چت‌محور است", visA.some((t) => t.id === "review:chat-a") && !visB.some((t) => t.id === "review:chat-a"))
  // پاک‌سازی تب‌های این تست
  for (const t of s.tabs.filter((t) => t.kind === "browser" || t.kind === "review")) useViewerTabs.getState().closeViewer(t.id)
}

console.log("۷-ج) browserViewport — سایز دستی مثل کروم (بدون نام دستگاه):")
{
  const { clampViewportSize, WIDTH_SLIDER_MIN, WIDTH_SLIDER_MAX, DEFAULT_VIEWPORT_SIZE, VIEWPORT_LIMITS } = await import("../src/lib/browserViewport")
  check("پیش‌فرض ۱۲۸۰×۸۰۰", DEFAULT_VIEWPORT_SIZE.width === 1280 && DEFAULT_VIEWPORT_SIZE.height === 800)
  check("اسلایدر افقی عرض دارد", WIDTH_SLIDER_MIN === 320 && WIDTH_SLIDER_MAX === 1920)
  check("سایز معتبر دست‌نخورده می‌ماند", JSON.stringify(clampViewportSize(1024, 700)) === JSON.stringify({ width: 1024, height: 700 }))
  const clamped = clampViewportSize(10, 999999)
  check("کلمپ پایین/بالا", clamped.width === VIEWPORT_LIMITS.minWidth && clamped.height === VIEWPORT_LIMITS.maxHeight, clamped)
  check("غیرعددی به پیش‌فرض برمی‌گردد", clampViewportSize(NaN, NaN).width === 1280)
}

console.log("۷-د) BrowserPanel — فقط یک اینپوت (بدون اینپوت پایینی):")
{
  const React = (await import("react")).default
  const { renderToString } = await import("react-dom/server")
  const { BrowserPanel } = await import("../src/components/BrowserPanel")
  const html = renderToString(React.createElement(BrowserPanel))
  const inputs = html.match(/<input/g) ?? []
  check("omnibox + دو اینپوت عددی عرض/ارتفاع + اسلایدر دارد", inputs.length === 4, inputs.length)
  check("اینپوت پایینی Type حذف شد", !html.includes("Type into the page"))
  check("اینپوت‌های دستی عرض/ارتفاع هست", html.includes('aria-label="Viewport width"') && html.includes('aria-label="Viewport height"'))
  check("اسلایدر افقی عرض هست و select دستگاه حذف شد", html.includes('aria-label="Viewport width slider"') && !html.includes("Device preset") && !html.includes("Common widths"))
  check("about:blank در آدرس‌بار نیست", !html.includes("about:blank"))
  check("نوار سایز یک‌تکه افقی است", html.includes('aria-label="Viewport size"'))
  check("آیکون Fit به‌جای تیک است", html.includes('aria-label="Fit width to pane"') && !html.includes('type="checkbox"'))
  check("استیج فوکوس‌پذیر است (کیبورد صفحه)", html.includes('tabindex="0"'))
  // موس مجازی: مختصات بک‌اند از جعبهٔ img، مکان آیکون از جعبهٔ wrapper —
  // هر دو از یک تابع خالص pctInBox می‌آیند تا letterbox جا‌به‌جا نشود.
  const { pctInBox, backendError } = await import("../src/components/BrowserPanel")
  const imgBox = { left: 20, top: 40, width: 600, height: 400 }
  check("pctInBox مختصات صفحه را درست می‌گیرد", JSON.stringify(pctInBox(imgBox, 320, 240)) === JSON.stringify({ x: 50, y: 50 }))
  const wrapperBox = { left: 0, top: 10, width: 800, height: 600 }
  check("pctInBox نسبت به wrapper فرق می‌کند (letterbox)", pctInBox(wrapperBox, 320, 240).y !== pctInBox(imgBox, 320, 240).y)
  // خطای کسب‌وکاری sidecar (HTTP 200 + ok:false) قبلاً بی‌صدا بلعیده می‌شد —
  // اینتر و دکمه‌های history اثر نداشتند چون خطا هرگز دیده نمی‌شد.
  check("ok:false به پیام خطا تبدیل می‌شود", backendError({ ok: false, error: "launch failed" }) === "launch failed")
  check("ok:false بدون error پیام پیش‌فرض می‌دهد", backendError({ ok: false }) === "request failed")
  check("ok:true یا null خطا نیست", backendError({ ok: true }) === null && backendError(null) === null)
  check("آیکون toggle موس مجازی در تولبار هست", html.includes('aria-label="Virtual mouse"'))
  check("موس مجازی پیش‌فرض خاموش است", html.includes('aria-pressed="false"'))
  check("دکمهٔ ✕ کنار Stop حذف شد (بستن از تب)", !html.includes("Close viewer"))
}

console.log("۷-و) isProbablyUrl — سرچ در برابر آدرس (مثل کروم، اول گوگل):")
{
  const { isProbablyUrl } = await import("../src/components/BrowserPanel")
  check("آدرس با scheme آدرس است", isProbablyUrl("https://example.com/x"))
  check("میزبان نقطه‌دار آدرس است", isProbablyUrl("example.com") && isProbablyUrl("localhost:3000"))
  check("عبارت فارسی سرچ است", !isProbablyUrl("پایتون چیست"))
  check("چند کلمه انگلیسی سرچ است", !isProbablyUrl("how to cook rice"))
  check("کلمهٔ تنها سرچ است", !isProbablyUrl("python"))
  check("ورودی خالی نه آدرس است نه سرچ", !isProbablyUrl("   "))
}

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
