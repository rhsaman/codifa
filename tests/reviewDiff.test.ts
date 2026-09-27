// تست واحد برای پارسرهای دیف پنل Review (سبک کدکس):
//  - parseDiffRows: ردیف‌های یکپارچه با شماره خط (کارت ابزار).
//  - parseSideBySide: بلوک هانک + جداکنندهٔ «N unmodified lines» بین هانک‌ها.
// اجرا: npx esbuild tests/reviewDiff.test.ts --bundle --platform=node \
//        --format=esm --outfile=tests/.tmp-rd.mjs && node tests/.tmp-rd.mjs

import { parseDiffRows, parseSideBySide } from "../src/lib/reviewDiff"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// دو هانک با فاصله بین آن‌ها (باید به جداکنندهٔ «N unmodified lines» تبدیل شود).
const diff = [
  "--- a/x.toml",
  "+++ b/x.toml",
  "@@ -1,2 +1,3 @@",
  ' a = "1"',
  '-b = "2"',
  '+b = "2b"',
  '+c = "3"',
  "@@ -10,2 +11,2 @@",
  ' y = "9"',
  '-z = "0"',
  '+z = "1"',
].join("\n")

console.log("۱) parseDiffRows: هدر هانک + ردیف‌های add/del/mod/ctx:")
{
  const rows = parseDiffRows(diff)
  check("دو هدر hunk دارد", rows.filter((r) => r.type === "hunk").length === 2)
  // جفت delete+add پشت‌سرهم به یک ردیف «mod» ادغام می‌شود (نمای هم‌تراز).
  check("دو ردیف mod دارد", rows.filter((r) => r.type === "mod").length === 2)
  check("یک ردیف add خالص دارد", rows.filter((r) => r.type === "add").length === 1)
  check("هیچ del خالصی ندارد", rows.filter((r) => r.type === "del").length === 0)
  const mod = rows.find((r) => r.type === "mod")
  check(
    "ردیف mod هر دو سو + شماره خط دارد",
    !!mod &&
      "aLine" in mod &&
      mod.aLine > 0 &&
      "bLine" in mod &&
      mod.bLine > 0,
    mod,
  )
}

console.log("۲) parseSideBySide: هانک‌ها + گپ خطوط دست‌نخورده:")
{
  const items = parseSideBySide(diff)
  check("دو بلوک rows دارد", items.filter((i) => i.kind === "rows").length === 2)
  const gaps = items.filter((i) => i.kind === "gap")
  check("یک گپ دارد", gaps.length === 1, gaps)
  // هانک ۱ خطوط جدید ۱..۳ را پوشش می‌دهد، هانک ۲ از ۱۱ شروع می‌شود → ۷ خط گپ.
  check("گپ = ۷ خط", gaps[0] && gaps[0].kind === "gap" && gaps[0].count === 7, gaps[0])
  check("ترتیب rows→gap→rows", items.map((i) => i.kind).join(",") === "rows,gap,rows")
}

console.log("۳) unified خالص (بدون دهانش) گپی تولید نمی‌کند:")
{
  const single = [
    "--- a/y.ts",
    "+++ b/y.ts",
    "@@ -1,1 +1,2 @@",
    " const x = 1",
    "+const y = 2",
  ].join("\n")
  const items = parseSideBySide(single)
  check("فقط یک بلوک rows", items.length === 1 && items[0].kind === "rows")
  const rows = parseDiffRows(single)
  check("یک ردیف add دارد", rows.filter((r) => r.type === "add").length === 1)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log("\nهمه‌ی تست‌ها سبز شدند")
}