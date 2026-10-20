// تست SSR برای پنل Review — رفتار آکاردئونی: دیف هر فایل دقیقاً زیر همان ردیف
// فایل باز می‌شود (نه لیست بالا و یک دیف مشترک پایین). پوشش:
//  - فایل باز → بلوک .review-file-block.open هم ردیف فایل و هم دیف را دارد
//  - فایل بسته → هیچ دیفی زیر ردیفش رندر نمی‌شود
//  - فقط یک فایل هم‌زمان باز است (selectedPath)
// نکته: استور zustand در SSR اسنپ‌شات لحظه‌ی ساخت را می‌خواند و setState قبل از
// renderToString روی خروجی اثر ندارد (مثل تست سایدبار)؛ پس آکاردئون خالص
// (بدون استور) مستقیم رندر می‌شود.
// Mock پل الکترون قبل از import کامپوننت.
import "./_globals.ts";

const { renderToString } = await import("react-dom/server");
const { ReviewFileAccordion } = await import("../src/components/ReviewPanel");

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`, extra ?? "");
  }
}

const DIFF_A = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " const a = 1",
  "+const b = 2",
].join("\n");
const DIFF_B = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,1 +1,2 @@",
  " const x = 1",
  "+const y = 2",
].join("\n");

const FILES = [
  { path: "src/a.ts", diff: DIFF_A, adds: 1, dels: 0 },
  { path: "src/b.ts", diff: DIFF_B, adds: 1, dels: 0 },
];
const noop = (_p: string) => {};
/** متنِ خروجیِ رندرشده بدون تگ‌ها: دیف با سینتکس‌هایلایت رندر می‌شود، پس
 *  یک عبارت مثل `const y` بین چند <span> تکه می‌شود و includes خام نمی‌گیرد. */
const plain = (html: string) => html.replace(/<[^>]*>/g, "");

console.log("۱) فایل باز → دیف زیر همان ردیف فایل (آکاردئون):");
{
  const html = renderToString(
    <ReviewFileAccordion files={FILES} selectedPath="src/a.ts" onSelect={noop} />,
  );
  check("بلوک فایل باز رندر شد", html.includes("review-file-block open"));
  check("دیف داخل بلوک رندر شد", html.includes("diff-unified"));
  // ترتیب: ردیف فایل قبل از دیفِ همان فایل است (دیف زیر ردیف، نه پایین لیست).
  const rowIdx = html.indexOf("review-file-row");
  const diffIdx = html.indexOf("diff-unified");
  check("دیف بعد از ردیف فایل است", rowIdx >= 0 && diffIdx > rowIdx);
  // فایل دوم بسته است → فقط یک دیف در کل خروجی.
  check("فقط یک دیف رندر شد", (html.match(/diff-unified/g) || []).length === 1);
}

console.log("۲) همه بسته → هیچ دیفی رندر نمی‌شود:");
{
  const html = renderToString(
    <ReviewFileAccordion files={FILES} selectedPath="" onSelect={noop} />,
  );
  check("هیچ دیفی رندر نشد", !html.includes("diff-unified"));
  check("ردیف‌های فایل هنوز هستند", (html.match(/review-file-row/g) || []).length === 2);
}

console.log("۳) فایل دوم باز → دیف همان فایل، نه فایل اول:");
{
  const html = renderToString(
    <ReviewFileAccordion files={FILES} selectedPath="src/b.ts" onSelect={noop} />,
  );
  check("فقط یک دیف رندر شد", (html.match(/diff-unified/g) || []).length === 1);
  // محتوای دیف باید مال b.ts باشد (const y) نه a.ts (const b).
  const text = plain(html);
  check("دیف فایل انتخاب‌شده رندر شد", text.includes("const y"));
  check("دیف فایل دیگر رندر نشد", !text.includes("const b = 2"));
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`);
  process.exit(1);
}
console.log("\nهمه تست‌ها پاس شدند ✅");
process.exit(0);
