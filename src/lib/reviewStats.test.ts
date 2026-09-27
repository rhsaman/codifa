// تست واحد برای aggregateTurnStats و diffStatsFromUnified:
// جمع +N -M چند فایل (مثل oc.config.toml +2 -0 و openai.config.toml +4 -0)
// باید به +N -M سطح ترن تجمیع شود.
// اجرا: npx esbuild src/lib/reviewStats.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-reviewStats.mjs \
//        && node src/lib/.tmp-reviewStats.mjs

import type { ToolActivity } from "../types"
import { aggregateTurnStats, diffStatsFromUnified } from "./toolActivity"

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

// یک unified diff نمونه با ۲ افزودن و ۰ حذف (مثل oc.config.toml).
const diffOc = [
  "--- a/oc.config.toml",
  "+++ b/oc.config.toml",
  "@@ -1,1 +1,3 @@",
  ' model_provider = "openai"',
  '+# کامنت',
  '+model = "gpt-6-sol"',
].join("\n")

// یک unified diff نمونه با ۴ افزودن و ۰ حذف (مثل openai.config.toml).
const diffOpenai = [
  "--- a/openai.config.toml",
  "+++ b/openai.config.toml",
  "@@ -0,0 +1,4 @@",
  '+a = "1"',
  '+b = "2"',
  '+c = "3"',
  '+d = "4"',
].join("\n")

console.log('۱) diffStatsFromUnified روی یک فایل:')
{
  const s = diffStatsFromUnified(diffOc)
  check('adds = 2', s.adds === 2, s)
  check('dels = 0', s.dels === 0, s)
}

console.log('۲) diffStatsFromUnified خطوط +++/--- را نمی‌شمارد:')
{
  const s = diffStatsFromUnified(diffOpenai)
  check('adds = 4', s.adds === 4, s)
  check('dels = 0', s.dels === 0, s)
}

console.log('۳) aggregateTurnStats جمع چند فایل را به +10 -0 می‌رساند:')
{
  const mk = (path: string, diff: string): ToolActivity =>
    ({ tool: "edit_file", args: { path }, diff, status: "done" }) as any
  const acts: ToolActivity[] = [mk("oc.config.toml", diffOc), mk("openai.config.toml", diffOpenai)]
  const t = aggregateTurnStats(acts)
  check('adds = 6', t.adds === 6, t)
  check('dels = 0', t.dels === 0, t)
}

console.log('۴) aggregateTurnStats فعالیت‌های بدون diff را نادیده می‌گیرد:')
{
  const acts: ToolActivity[] = [
    ({ tool: "grep", args: {}, status: "done" }) as any,
    ({ tool: "edit_file", args: { path: "x" }, diff: diffOc, status: "done" }) as any,
  ]
  const t = aggregateTurnStats(acts)
  check('adds = 2', t.adds === 2, t)
}

console.log('۵) aggregateTurnStats داخل children را هم می‌خواند:')
{
  const child: ToolActivity = ({ tool: "write_file", args: { path: "y" }, diff: diffOpenai, status: "done" }) as any
  const parent: ToolActivity = ({ tool: "task", args: {}, status: "done", children: [child] }) as any
  const t = aggregateTurnStats([parent])
  check('adds = 4', t.adds === 4, t)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log('\nهمه‌ی تست‌ها سبز شدند')
}
