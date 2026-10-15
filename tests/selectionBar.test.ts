// Copy/Reply toolbar geometry: the bar sits under the highlight and stays
// inside the viewport, so a selection near an edge never hides the buttons.
import { SEL_BAR_H, SEL_BAR_W, selectionBarPos } from "../src/lib/selectionBar";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`, extra ?? "");
  }
}

console.log("۱) مکان پایه:");
{
  const p = selectionBarPos({ left: 200, bottom: 300 }, 1200, 800);
  check("x همان لبه‌ی چپ هایلایت", p.x === 200, p);
  check("y کمی زیر هایلایت", p.y === 306, p);
}

console.log("۲) کلمپ به لبه‌ی راست/پایین:");
{
  const p = selectionBarPos({ left: 1190, bottom: 795 }, 1200, 800);
  check("از لبه‌ی راست بیرون نمی‌زند", p.x === 1200 - SEL_BAR_W - 8, p);
  check("از لبه‌ی پایین بیرون نمی‌زند", p.y === 800 - SEL_BAR_H - 8, p);
}

console.log("۳) کلمپ به لبه‌ی چپ/بالا:");
{
  const p = selectionBarPos({ left: -40, bottom: -10 }, 1200, 800);
  check("حداقل x برابر ۸", p.x === 8, p);
  check("حداقل y برابر ۸", p.y === 8, p);
}

console.log("۴) پنجره‌ی بسیار کوچک:");
{
  const p = selectionBarPos({ left: 500, bottom: 500 }, 40, 30);
  check("x هرگز منفی نمی‌شود", p.x === 8, p);
  check("y هرگز منفی نمی‌شود", p.y === 8, p);
}

console.log("۵) ابعاد پیش‌فرض وقتی اندازه‌ی پنجره صفر است:");
{
  const p = selectionBarPos({ left: 100, bottom: 100 }, 0, 0);
  check("با vw=0 هم داخل کادر می‌ماند", p.x === 100 && p.y === 106, p);
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`);
  process.exit(1);
}
console.log("\nهمه تست‌ها پاس شدند ✅");
process.exit(0);
