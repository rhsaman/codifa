// SSR sanity test for the UsageChip (titlebar total-tokens chip + hover popover).
// Run via: npx esbuild tests/usageChip.ssr.test.tsx --bundle --platform=node --format=esm --jsx=automatic --packages=external --outfile=tests/.tmp-ucp.mjs --external:electron && node tests/.tmp-ucp.mjs

import { renderToString } from "react-dom/server"
import type { ChatUsage, ProviderConfig } from "../src/types"

// Mock the Electron/browser bridge before importing the component (the store
// module touches `window.coder` at import time). Dynamic import so esbuild
// does NOT hoist the component (and its store dependency) above this mock.
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  confirm: () => true,
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

const { buildUsageView, UsagePopover } = await import("../src/components/UsageChip")

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

const providers: ProviderConfig[] = [
  {
    id: "p1",
    name: "Provider One",
    kind: "custom",
    apiKey: "",
    baseUrl: "",
    model: "m",
    pricingMap: {
      "model-a": { input: 1, output: 2 },
      "model-b": { input: 3, output: 4, cacheRead: 0.1 },
    },
  },
  {
    id: "p2",
    name: "Provider Two",
    kind: "custom",
    apiKey: "",
    baseUrl: "",
    model: "m",
  },
]

console.log("۱) buildUsageView: گروه‌بندی، مرتب‌سازی و جمع کل:")
{
  const usage: ChatUsage = {
    entries: [
      // p1 / model-a — 1000 tokens (heaviest in p1)
      { providerId: "p1", model: "model-a", input: 600, output: 400, lastUsed: 5 },
      // p1 / model-b — 300 tokens, cache-only portion kept
      { providerId: "p1", model: "model-b", input: 0, output: 0, cacheRead: 200, cacheWrite: 100, lastUsed: 9 },
      // p2 / model-c — 500 tokens (no pricingMap → cost null)
      { providerId: "p2", model: "model-c", input: 300, output: 200, lastUsed: 7 },
      // all-zero entry — dropped
      { providerId: "p2", model: "model-d", input: 0, output: 0, lastUsed: 1 },
    ],
  }
  const view = buildUsageView(usage, providers)

  check("دو گروه ساخته می‌شود", view.groups.length === 2, view.groups.length)
  check("گروه سنگین‌تر اول است (p1)", view.groups[0]?.providerId === "p1", view.groups[0]?.providerId)
  check("نام گروه از پروایدر می‌آید", view.groups[0]?.name === "Provider One")
  check("مدل‌ها سنگین‌ترین اول", view.groups[0]?.entries[0]?.model === "model-a")
  check("entry فقط-کش حذف نمی‌شود", view.groups[0]?.entries.some((e) => e.model === "model-b") === true)
  check("entry همه-صفر حذف می‌شود", view.groups[1]?.entries.every((e) => e.model !== "model-d") === true)
  // Tokens = input + output only; the cache-only entry (model-b) adds 0.
  check("جمع کل توکن درست است", view.totalTokens === 1000 + 500, view.totalTokens)
  check("جمع کش درست است", view.totalCached === 300, view.totalCached)
  check("fresh = کل − کش", view.totalFresh === view.totalTokens - view.totalCached)
  // Grand cost folds the KNOWN costs and skips nulls (same semantics as the
  // old sidebar panel): p1 is priced, p2 is not → partial sum, not null.
  // model-a: 600/1M·1 + 400/1M·2 = 0.0014 · model-b (cache-only): 200/1M·0.1 + 100/1M·3 = 0.00032
  check("هزینه کل، جمع هزینه‌های شناخته‌شده است", Math.abs((view.totalCost ?? -1) - 0.00172) < 1e-9, view.totalCost)
  check("هزینه مدل بدون قیمت null است", view.groups[1]?.entries[0]?.cost === null)
  // model-a cost: 600/1M*1 + 400/1M*2 = 0.0014
  check("هزینه مدل با قیمت محاسبه می‌شود", Math.abs((view.groups[0]?.entries[0]?.cost ?? -1) - 0.0014) < 1e-9)
}

console.log("۲) buildUsageView بدون مصرف (چیپ مخفی):")
{
  const view = buildUsageView(undefined, providers)
  check("گروهی وجود ندارد", view.groups.length === 0)
  check("جمع صفر است", view.totalTokens === 0)
}

console.log("۳) UsagePopover رندر SSR با view seed شده:")
{
  const usage: ChatUsage = {
    entries: [
      { providerId: "p1", model: "model-a", input: 600, output: 400, cacheRead: 100, cacheWrite: 50, lastUsed: 5 },
      { providerId: "p2", model: "model-c", input: 300, output: 200, lastUsed: 7 },
    ],
  }
  const view = buildUsageView(usage, providers)
  const html = renderToString(
    <UsagePopover view={view} />,
  )

  check("پاپ‌اور رندر می‌شود", html.includes("usage-popover"))
  check("هدر Model usage حذف شده است", !html.includes("Model usage") && !html.includes("usage-popover-head"))
  check("نشان کش (SVG رعد) وجود دارد", html.includes("M13 2 3 14h7l-1 8 10-12h-7l1-8z"))
  check("نام پروایدر نمایش داده می‌شود", html.includes("Provider One") && html.includes("Provider Two"))
  check("نام مدل نمایش داده می‌شود", html.includes("model-a") && html.includes("model-c"))
  check("هزینه مدل قیمت‌دار نمایش داده می‌شود", html.includes("$0.0014"), html)
  check("مدل بدون قیمت «—» نشان می‌دهد", html.includes("—"))
  check("دکمه reset داخل پاپ‌اور نیست", !html.includes("usage-reset"))
  check("dir=ltr روی پاپ‌اور", html.includes('dir="ltr"'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
