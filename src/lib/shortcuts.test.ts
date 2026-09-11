// تست رگرسیون برای کوردهای ناوبری پیکرها و گارد Ctrl+K سایدبار.
// باگ: Ctrl+K داخل پیکر @mention اسکیل (یا پالت فرمان /) رویدادش تا window
// حباب می‌کرد و هندلر سراسری سایدبار فوکوس را به سرچ چت می‌دزدید.
// اجرا: npx esbuild src/lib/shortcuts.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-shortcuts.mjs && node src/lib/.tmp-shortcuts.mjs

import { navChord, shouldFocusSearch } from "./shortcuts"

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

/** شبیه‌ساز keydown مینیمال — فقط فیلدهایی که navChord/shouldFocusSearch می‌خوانند. */
function key(
  k: string,
  opts: Partial<{ code: string; ctrl: boolean; meta: boolean; prevented: boolean }> = {},
) {
  return {
    key: k,
    code: opts.code ?? "",
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    defaultPrevented: !!opts.prevented,
  }
}

console.log('۱) navChord — کوردهای ناوبری لیست:')
{
  check('ArrowDown → +1', navChord(key("ArrowDown")) === 1)
  check('ArrowUp → -1', navChord(key("ArrowUp")) === -1)
  check('Ctrl+J → +1', navChord(key("j", { code: "KeyJ", ctrl: true })) === 1)
  check('Ctrl+K → -1', navChord(key("k", { code: "KeyK", ctrl: true })) === -1)
  check('Ctrl+N → +1', navChord(key("n", { code: "KeyN", ctrl: true })) === 1)
  check('Ctrl+P → -1', navChord(key("p", { code: "KeyP", ctrl: true })) === -1)
  check('⌘+K (مک) → -1', navChord(key("k", { code: "KeyK", meta: true })) === -1)
  check('حرف k بدون Ctrl → 0 (تایپ عادی)', navChord(key("k", { code: "KeyK" })) === 0)
  check('Enter → 0', navChord(key("Enter")) === 0)
  check('Escape → 0', navChord(key("Escape")) === 0)
}

console.log('۲) navChord — چیدمان فارسی (e.key محلی‌شده، e.code لاتین):')
{
  // روی چیدمان فارسی، کلید فیزیکی K حرف «س» تولید می‌کند؛ physicalKey باید
  // از e.code ریشه بگیرد تا Ctrl+K همچنان -1 بدهد.
  check('Ctrl+«س» (code=KeyK) → -1', navChord(key("س", { code: "KeyK", ctrl: true })) === -1)
  check('Ctrl+«ژ» (code=KeyJ) → +1', navChord(key("ژ", { code: "KeyJ", ctrl: true })) === 1)
}

console.log('۳) shouldFocusSearch — گارد Ctrl+K سایدبار:')
{
  // Ctrl+K آزاد (خارج از پیکر): سایدبار باید فوکوس بگیرد.
  check('Ctrl+K آزاد → true', shouldFocusSearch(key("k", { code: "KeyK", ctrl: true })) === true)
  check('⌘+K آزاد → true', shouldFocusSearch(key("k", { code: "KeyK", meta: true })) === true)
  // رگرسیون اصلی: پیکر @mention کورد را با preventDefault بلعیده؛ رویدادِ
  // defaultPrevented نباید فوکوس سایدبار را فعال کند.
  check('Ctrl+K بلعیده‌شده (defaultPrevented) → false', shouldFocusSearch(key("k", { code: "KeyK", ctrl: true, prevented: true })) === false)
  check('حرف k بدون Ctrl → false', shouldFocusSearch(key("k", { code: "KeyK" })) === false)
  check('Ctrl+J → false (کورد ناوبری است، نه سرچ)', shouldFocusSearch(key("j", { code: "KeyJ", ctrl: true })) === false)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
