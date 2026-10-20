// تست SSR برای دیف واکنش‌گرا — تک‌ستونی در عرض کم، دوستونی در عرض زیاد.
// پوشش:
//  - shouldShowSideBySide: آستانه‌ی عرض (پیش‌فرض ۷۶۸)
//  - DiffView با layout اجباری unified → فقط .diff-unified
//  - DiffView با layout اجباری side-by-side → .diff-columns + هدر Before/After + گپ
//  - ReviewFileAccordion با wide → دوستونی، بدون wide → تک‌ستونی
// Mock پل الکترون قبل از import کامپوننت.
import "./_globals.ts";

const { renderToString } = await import("react-dom/server");
const { DiffView, shouldShowSideBySide } = await import(
  "../src/components/ToolCallView"
);
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

const DIFF = [
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,2 +1,3 @@",
  ' a = "1"',
  '-b = "2"',
  '+b = "2b"',
  '+c = "3"',
  "@@ -10,2 +11,2 @@",
  ' y = "9"',
  '-z = "0"',
  '+z = "1"',
].join("\n");

console.log("۱) shouldShowSideBySide: آستانه‌ی عرض:");
{
  check("عرض کم تک‌ستونی", shouldShowSideBySide(320) === false);
  check("زیر آستانه تک‌ستونی", shouldShowSideBySide(700) === false);
  check("عرض متوسط دوستونی", shouldShowSideBySide(900) === true);
  check("مرز آستانه دوستونی", shouldShowSideBySide(768) === true);
  check("آستانه‌ی سفارشی", shouldShowSideBySide(500, 400) === true);
}

console.log("۲) DiffView اجباری تک‌ستونی:");
{
  const html = renderToString(
    <DiffView diff={DIFF} path="x.ts" layout="unified" />,
  );
  check("تک‌ستونی رندر شد", html.includes("diff-unified"));
  check("دوستونی رندر نشد", !html.includes("diff-columns"));
  check("data-layout یکپارچه", html.includes('data-layout="unified"'));
}

console.log("۳) DiffView اجباری دوستونی:");
{
  const html = renderToString(
    <DiffView diff={DIFF} path="x.ts" layout="side-by-side" />,
  );
  check("دوستونی رندر شد", html.includes("diff-columns"));
  check("هدر Before دارد", html.includes("Before"));
  check("هدر After دارد", html.includes("After"));
  check("گپ unmodified lines دارد", html.includes("unmodified lines"));
  check("تک‌ستونی رندر نشد", !html.includes("diff-unified"));
  check("data-layout دوستونی", html.includes('data-layout="side-by-side"'));
  // نوار کناری ± در نمای دوستونی: قبلاً هیچ گاتر/علامتی نداشت و ستون هیچ سرنخی
  // برای خط اضافه/حذف‌شده نمی‌داد (پس‌زمینه طبق طراحی شفاف است).
  check("گاتر دوستونی دارد", (html.match(/diff-u-gutter/g) || []).length > 0);
  check("علامت منفی در ستون قبل است", html.includes(">-</span>"));
  check("علامت مثبت در ستون بعد است", html.includes(">+</span>"));
}

console.log("۴) ReviewFileAccordion با wide:");
{
  const files = [{ path: "x.ts", diff: DIFF, adds: 3, dels: 2 }];
  const noop = (_p: string) => {};
  const narrow = renderToString(
    <ReviewFileAccordion files={files} selectedPath="x.ts" onSelect={noop} />,
  );
  check("پیش‌فرض تک‌ستونی", narrow.includes("diff-unified"));
  const wideHtml = renderToString(
    <ReviewFileAccordion
      files={files}
      selectedPath="x.ts"
      onSelect={noop}
      wide
    />,
  );
  check("wide دوستونی", wideHtml.includes("diff-columns"));
}

console.log("۵) کامنت داخل دیف کم‌رنگ می‌شود:");
{
  const withComments = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    "+const a = 1 // توضیح فارسی",
    "+const url = \"http://x\" // not a comment",
    "+const b = 2",
  ].join("\n");
  const html = renderToString(
    <DiffView diff={withComments} path="x.ts" layout="unified" />,
  );
  // با هایلایت واقعیِ زبان (رنگ تم)، hljs خودش کامنت را کلاس می‌زند؛
  // diff-comment فقط fallback زبان‌هایی است که گرامر ندارند.
  check(
    "کامنت کم‌رنگ شد (diff-comment یا hljs-comment)",
    html.includes("diff-comment") || html.includes("hljs-comment"),
  );
  check("متن کامنت حفظ شد", html.includes("توضیح فارسی"));
  check("مارکر کامنت در تکهٔ کم‌رنگ است", html.includes(">// توضیح فارسی<"));

  // رشته‌ای که «//» دارد کامنت نیست: نباید هیچ diff-comment بسازد.
  const stringOnly = [
    "--- a/y.ts",
    "+++ b/y.ts",
    "@@ -1,1 +1,1 @@",
    '+const url = "http://example.com"',
  ].join("\n");
  const html2 = renderToString(
    <DiffView diff={stringOnly} path="y.ts" layout="unified" />,
  );
  check("اسلش داخل رشته کامنت شمرده نشد", !html2.includes("diff-comment"));

  // زبان بدون کامنت خطی (css) → هیچ کم‌رنگی اعمال نمی‌شود.
  const cssDiff = [
    "--- a/z.css",
    "+++ b/z.css",
    "@@ -1,1 +1,1 @@",
    "+body { color: red; }",
  ].join("\n");
  const html3 = renderToString(
    <DiffView diff={cssDiff} path="z.css" layout="unified" />,
  );
  check("css بدون کامنت خطی کم‌رنگ نشد", !html3.includes("diff-comment"));
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`);
  process.exit(1);
}
console.log("\nهمه تست‌ها پاس شدند ✅");
process.exit(0);
