// تست جهت متن اینباکس: متن فارسی با شروع لاتین (مثل EUR/USD) در حالت rtl
// باید راست‌چین بماند، نه چپ‌چین (رگرسیون dir="auto").
// Run: npx esbuild tests/scheduleInboxDir.ssr.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external \
//        --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
//        --outfile=tests/.tmp-sid.mjs --external:electron && node tests/.tmp-sid.mjs
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
;(globalThis as any).document = { addEventListener: () => {}, removeEventListener: () => {} }

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

const { useStore } = await import("../src/lib/store")

// استور در حالت rtl + اینباکس باز با یک ران فارسی که با کلمه لاتین شروع می‌شود
useStore.setState({
  dir: "rtl",
  scheduleInboxOpen: true,
  schedules: [
    { id: "s1", name: "task", prompt: "p", cron: "", enabled: true, root: "", mode: "coder" },
  ] as any,
  scheduleInboxSelected: "s1",
  scheduleRunsSeen: [],
})
// ران‌ها از API می‌آیند؛ برای SSR فقط سورس و CSS را قفل می‌کنیم
const fs = await import("node:fs")
const inboxSrc = fs.readFileSync("src/components/ScheduleInbox.tsx", "utf8")
const css = fs.readFileSync("src/styles/global.css", "utf8")

console.log("۱) InboxMarkdown از dir استور استفاده می‌کند (نه auto):")
{
  check(
    "dir={dir} روی schedule-inbox-markdown",
    inboxSrc.includes("schedule-inbox-markdown") && inboxSrc.includes("dir={dir}"),
    "dir={dir} missing",
  )
  check(
    'dir="auto" روی schedule-inbox-markdown نمانده',
    !inboxSrc.includes('schedule-inbox-markdown" dir="auto"'),
    "still auto",
  )
}

console.log("۲) قانون CSS جهت اینباکس در global.css:")
{
  check(
    "قانون rtl برای schedule-inbox-markdown هست",
    css.includes(".schedule-inbox-markdown") && css.includes("direction: rtl"),
  )
}

console.log("۳) اورلی اینباکس dir استور را حمل می‌کند:")
{
  check(
    "اورلی dir={dir} دارد",
    inboxSrc.includes('className="schedule-inbox-overlay" dir={dir}'),
  )
  check(
    "قانون ltr هم برای اینباکس هست",
    css.includes('.schedule-inbox-overlay[dir="ltr"] .schedule-inbox-markdown'),
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log("\nهمه بررسی‌ها موفق بود")
}
