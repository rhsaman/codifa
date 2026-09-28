// تست واحد برای پارسرهای دیف پنل Review (سبک کدکس):
//  - parseDiffRows: ردیف‌های یکپارچه با شماره خط (کارت ابزار).
//  - parseSideBySide: بلوک هانک + جداکنندهٔ «N unmodified lines» بین هانک‌ها.
// اجرا: npx esbuild tests/reviewDiff.test.ts --bundle --platform=node \
//        --format=esm --outfile=tests/.tmp-rd.mjs && node tests/.tmp-rd.mjs

import { mergeFileDiffs, parseDiffRows, parseSideBySide, splitUnifiedDiffByFile } from "../src/lib/reviewDiff"

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

console.log("۴) buildReviewTurn: ویرایش تکراری یک فایل ادغام می‌شود:")
{
  const { buildReviewTurn } = await import("../src/lib/reviewTurn")
  const d1 = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,1 +1,2 @@",
    " const a = 1",
    "+const b = 2",
  ].join("\n")
  const d2 = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -5,1 +6,2 @@",
    " const c = 3",
    "+const d = 4",
  ].join("\n")
  const mk = (path: string, diff: string): any =>
    ({ tool: "edit_file", args: { path }, diff, status: "done" })
  const turn = buildReviewTurn("m1", [mk("x.ts", d1), mk("x.ts", d2)])
  check("فقط یک ردیف فایل", turn?.files.length === 1, turn?.files.length)
  check("جمع adds = ۲", turn?.files[0]?.adds === 2, turn?.files[0])
  check("دیف‌ها الحاق شده‌اند", !!turn?.files[0]?.diff.includes("const b = 2") && !!turn?.files[0]?.diff.includes("const d = 4"))
}

console.log("۵) buildReviewTurn: filePath هم مثل path پشتیبانی می‌شود:")
{
  const { buildReviewTurn } = await import("../src/lib/reviewTurn")
  const d = [
    "--- a/y.ts",
    "+++ b/y.ts",
    "@@ -1,1 +1,2 @@",
    " const x = 1",
    "+const y = 2",
  ].join("\n")
  const turn = buildReviewTurn("m2", [
    ({ tool: "write_file", args: { filePath: "y.ts" }, diff: d, status: "done" }) as any,
  ])
  check("فایل با filePath پیدا شد", turn?.files.length === 1 && turn?.files[0]?.path === "y.ts", turn?.files)
}

console.log("۶) splitUnifiedDiffByFile: دیف چندفایلی گیت به تکه‌های تک‌فایلی:")
{
  const multi = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,1 +1,2 @@",
    " const a = 1",
    "+const b = 2",
    "diff --git a/b.css b/b.css",
    "--- a/b.css",
    "+++ b/b.css",
    "@@ -1,1 +1,1 @@",
    "-.x { color: red; }",
    "+.x { color: blue; }",
  ].join("\n")
  const parts = splitUnifiedDiffByFile(multi)
  check("دو تکه دارد", parts.length === 2, parts.length)
  check("مسیر اول a.ts", parts[0]?.path === "a.ts", parts[0]?.path)
  check("مسیر دوم b.css", parts[1]?.path === "b.css", parts[1]?.path)
  check("تکه اول سرفصل خودش را دارد", !!parts[0]?.diff.includes("diff --git a/a.ts"))
  check("تکه دوم خط آبی را دارد", !!parts[1]?.diff.includes("color: blue"))
}

console.log("۷) splitUnifiedDiffByFile: دیف خالی/بدون سرفصل:")
{
  check("دیف خالی → آرایه خالی", splitUnifiedDiffByFile("").length === 0)
  check("دیف تک‌فایل بدون سرفصل → آرایه خالی", splitUnifiedDiffByFile("@@ -1 +1 @@\n-x\n+y").length === 0)
}

console.log("۸) mergeFileDiffs: ترکیب staged و unstaged یک مسیر:")
{
  const unstaged = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,1 +1,2 @@",
    " const a = 1",
    "+const b = 2",
  ].join("\n")
  const staged = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,1 +10,2 @@",
    " const c = 3",
    "+const d = 4",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,1 +1,1 @@",
    "-const x = 1",
    "+const x = 2",
  ].join("\n")
  const merged = mergeFileDiffs([
    splitUnifiedDiffByFile(unstaged),
    splitUnifiedDiffByFile(staged),
  ])
  check("دو مسیر یکتا", merged.length === 2, merged.length)
  const a = merged.find((f) => f.path === "a.ts")
  check("دیف a.ts هر دو هانک را دارد", !!a?.diff.includes("const b = 2") && !!a?.diff.includes("const d = 4"), a?.diff)
  check("ترتیب حفظ می‌شود (unstaged اول)", merged[0]?.path === "a.ts", merged.map((f) => f.path))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log("\nهمه‌ی تست‌ها سبز شدند")
}