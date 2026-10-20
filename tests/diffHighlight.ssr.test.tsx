// تست SSR برای دیف: سینتکس‌هایلایت با پالت تم + کم‌رنگ‌شدن کامنت بلوکی.
// پوشش:
//  - DiffView برای .ts خط‌های کد را با کلاس‌های hljs رنگ می‌کند
//  - کامنت بلوکیِ چندخطی (/** ... */) در همهٔ خطوطش کم‌رنگ می‌شود
//  - پسوند بدون گرامر (بدون هایلایت) دست‌نخورده می‌ماند
// Mock پل الکترون قبل از import کامپوننت.
import "./_globals.ts";

const { renderToString } = await import("react-dom/server");
const { DiffView } = await import("../src/components/ToolCallView");
const { getHighlightedLines, hasHighlightLanguage } = await import(
  "../src/lib/highlight"
);

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`, extra ?? "");
  }
}

console.log("۱) لایهٔ هایلایت مشترک:");
{
  check("ts گرامر دارد", hasHighlightLanguage("ts") === true);
  check("tsx گرامر دارد", hasHighlightLanguage("tsx") === true);
  check("پسوند ناشناخته گرامر ندارد", hasHighlightLanguage("qqq") === false);
  const lines = getHighlightedLines("const a = 1", "ts");
  check("یک خط برگشت", lines.length === 1, lines);
  check("کلاس hljs دارد", lines[0].includes("hljs-"), lines[0]);
  check("متن حفظ شد", lines[0].includes("a"), lines[0]);
}

console.log("۲) DiffView با هایلایت سینتکس:");
{
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,1 +1,2 @@",
    "+const answer: number = 42",
    "+export function f() { return answer }",
  ].join("\n");
  const html = renderToString(
    <DiffView diff={diff} path="x.ts" layout="unified" />,
  );
  check("کلاس diff-code رندر شد", html.includes("diff-code"));
  check("توکن کلیدواژه رنگ گرفت", html.includes("hljs-keyword"), html.slice(0, 400));
  check("توکن عدد رنگ گرفت", html.includes("hljs-number"));
  check("متن کد حفظ شد", html.includes("answer"));
  check("wrapping در span هایلایت", html.includes("<span class=\"hljs-"));
}

console.log("۳) کامنت بلوکی چندخطی کم‌رنگ می‌شود:");
{
  const diff = [
    "--- a/store.ts",
    "+++ b/store.ts",
    "@@ -29,4 +29,6 @@",
    " /** Normalize persisted seen ids to a bounded list of",
    "  *  non-empty strings. Pure for test. */",
    "+export function normalizeSeen(ids: string[]) {",
    "+  return ids.filter(Boolean)",
    " }",
  ].join("\n");
  const html = renderToString(
    <DiffView diff={diff} path="store.ts" layout="unified" />,
  );
  check("کامنت کلاس hljs-comment دارد", html.includes("hljs-comment"), html.slice(0, 600));
  check("خط دوم کامنت هم رنگی است", (html.match(/hljs-comment/g) || []).length >= 2);
  check("متن کامنت حفظ شد", html.includes("Pure for test"));
  check("تابع صادرشده کلیدواژه است", html.includes("hljs-keyword"));
}

console.log("۴) زبان بدون گرامر: بدون هایلایت:");
{
  const diff = [
    "--- a/z.qqq",
    "+++ b/z.qqq",
    "@@ -1,1 +1,1 @@",
    "+plain text here // not highlighted",
  ].join("\n");
  const html = renderToString(
    <DiffView diff={diff} path="z.qqq" layout="unified" />,
  );
  check("کلاس diff-code ندارد", !html.includes("diff-code"));
  check("متن ساده حفظ شد", html.includes("plain text here"));
}

console.log("۵) نمای دوستونی هم هایلایت دارد:");
{
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,1 +1,1 @@",
    "-const a = 1",
    "+const a = 2",
  ].join("\n");
  const html = renderToString(
    <DiffView diff={diff} path="x.ts" layout="side-by-side" />,
  );
  check("دوستونی رندر شد", html.includes("diff-columns"));
  check("هایلایت در ستون‌ها هست", html.includes("hljs-keyword"), html.slice(0, 400));
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`);
  process.exit(1);
}
console.log("\nهمه تست‌ها پاس شدند ✅");
process.exit(0);
