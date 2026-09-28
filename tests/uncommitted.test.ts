// تست واحد برای ساخت لیست uncommitted (ترکیب staged/unstaged + untracked).
// اجرا: npx esbuild tests/uncommitted.test.ts --bundle --platform=node --format=esm --outfile=tests/.tmp-uc2.mjs && node tests/.tmp-uc2.mjs
import { buildUncommittedFiles, sumDiffStats } from "../src/lib/uncommitted"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

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

console.log("۱) ترکیب staged و unstaged یک مسیر:")
{
  const files = buildUncommittedFiles(["a.ts", "b.ts"], unstaged, staged)
  check("دو فایل یکتا", files.length === 2, files.length)
  const a = files.find((f) => f.path === "a.ts")
  check("دیف a.ts هر دو هانک را دارد", !!a?.diff.includes("const b = 2") && !!a?.diff.includes("const d = 4"), a?.diff)
  check("آمار a.ts جمع هر دو هانک است", a?.adds === 2 && a?.dels === 0, a)
}

console.log("۲) فایل untracked از status اضافه می‌شود:")
{
  const files = buildUncommittedFiles(["new.ts"], "", "")
  check("یک فایل", files.length === 1, files.length)
  check("دیف خالی + آمار صفر", files[0]?.diff === "" && files[0]?.adds === 0 && files[0]?.dels === 0, files[0])
}

console.log("۳) sumDiffStats: جمع +N -M:")
{
  const t = sumDiffStats([
    { adds: 2, dels: 1 },
    { adds: 3, dels: 0 },
  ])
  check("جمع درست است", t.adds === 5 && t.dels === 1, t)
  check("لیست خالی صفر است", sumDiffStats([]).adds === 0 && sumDiffStats([]).dels === 0)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log("\nهمه‌ی تست‌ها سبز شدند")
}
