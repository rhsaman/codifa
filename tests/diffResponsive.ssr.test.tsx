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

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`);
  process.exit(1);
}
console.log("\nهمه تست‌ها پاس شدند ✅");
process.exit(0);
