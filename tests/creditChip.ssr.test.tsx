// SSR sanity test for the BalanceChip component.
// Run via: npx esbuild tests/creditChip.ssr.test.tsx --bundle --platform=node --format=esm --jsx=automatic --packages=external --outfile=tests/.tmp-credit.mjs --external:electron && node tests/.tmp-credit.mjs

// Mock the Electron/browser bridge before importing the component
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

import { renderToString } from "react-dom/server"
import { BalanceChip } from "../src/components/BalanceChip"

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

console.log("۱) BalanceChip رندر می‌شود (بدون موجودی):")
{
  const html = renderToString(
    <BalanceChip
      providerName="OpenAI"
      amount={null}
      busy={false}
      onRefresh={() => {}}
    />
  )
  check("دکمه وجود دارد", html.includes('<button'))
  check("کلاس‌های اصلی وجود دارد", html.includes('titlebar-balance') && html.includes('titlebar-balance-clickable'))
  check("placeholder «—» نمایش داده می‌شود", html.includes("—"))
  check("tooltip مناسب است", html.includes("کلیک برای دریافت موجودی"))
  check("data-testid وجود دارد", html.includes('data-testid="balance-chip"'))
  check("data-has-balance=false", html.includes('data-has-balance="false"'))
  check("data-busy=false", html.includes('data-busy="false"'))
  check("dir=ltr", html.includes('dir="ltr"'))
}

console.log("۲) BalanceChip رندر می‌شود (با موجودی):")
{
  const html = renderToString(
    <BalanceChip
      providerName="OpenAI"
      amount={12.34}
      busy={false}
      onRefresh={() => {}}
    />
  )
  check("مبلغ نمایش داده می‌شود", html.includes("$12.34"))
  check("tooltip مناسب است", html.includes("OpenAI balance — کلیک برای به‌روزرسانی"))
  check("data-has-balance=true", html.includes('data-has-balance="true"'))
}

console.log("۳) BalanceChip در حالت busy (refreshing):")
{
  const html = renderToString(
    <BalanceChip
      providerName="OpenAI"
      amount={12.34}
      busy={true}
      onRefresh={() => {}}
    />
  )
  check("کلاس refreshing اضافه شده", html.includes("refreshing"))
  check("data-busy=true", html.includes('data-busy="true"'))
}

console.log("۴) BalanceChip غیرفعال (disabled):")
{
  const html = renderToString(
    <BalanceChip
      providerName="OpenAI"
      amount={12.34}
      busy={false}
      disabled={true}
      onRefresh={() => {}}
    />
  )
  check("disabled attribute وجود دارد", html.includes("disabled"))
}

console.log("۵) BalanceChip بدون providerName:")
{
  const html = renderToString(
    <BalanceChip
      providerName={null}
      amount={null}
      busy={false}
      onRefresh={() => {}}
    />
  )
  check("tooltip پیش‌فرض نمایش داده می‌شود", html.includes("کلیک برای دریافت موجودی"))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)