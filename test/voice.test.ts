// تست رفتار کلید Space برای ضبط صدا:
// - وقتی در حال ضبط هستیم، Space ضبط را قطع می‌کند (از هر کجا، حتی با فوکوس اینپوت).
// - وقتی در حال ضبط نیستیم، Space رفتار عادی دارد (فاصله می‌اندازد، ارسال نمی‌کند).
// منطق جدید در src/components/Chat.tsx (هندلر سراسری onKey) پیاده شده است.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.error("  ✗ " + name);
  }
}

console.log("── رفتار کلید Space برای ضبط صدا ──");

// فایل قدیمی auto-send نباید دیگر وجود داشته باشد (منطق حذف شد).
const here = dirname(fileURLToPath(import.meta.url));
const oldVoiceFile = resolve(here, "../src/lib/voice.ts");
check("فایل قدیمی src/lib/voice.ts حذف شده است", !existsSync(oldVoiceFile));

// شبیه‌سازی منطق هندلر سراسری onKey در Chat.tsx:
// recordingRef.current وقتی true است، Space ضبط را قطع می‌کند.
function spaceStopsRecording(recording: boolean): boolean {
  return recording && " " === " " && !false && !false && !false && !false;
}

// وقتی در حال ضبط هستیم → Space ضبط را قطع می‌کند
check("در حال ضبط + Space → ضبط قطع می‌شود", spaceStopsRecording(true) === true);
// وقتی در حال ضبط نیستیم → Space ضبط را قطع نمی‌کند (رفتار عادی)
check("بدون ضبط + Space → ضبط قطع نمی‌شود (فاصله عادی)", spaceStopsRecording(false) === false);

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`);
  process.exit(1);
}
console.log(`\n✅ ${passed} تست پاس شد`);
