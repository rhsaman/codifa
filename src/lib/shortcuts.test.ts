// تست رگرسیون برای کوردهای ناوبری پیکرها و گارد Ctrl+K سایدبار.
// باگ: Ctrl+K داخل پیکر @mention اسکیل (یا پالت فرمان /) رویدادش تا window
// حباب می‌کرد و هندلر سراسری سایدبار فوکوس را به سرچ چت می‌دزدید.
// اجرا: npx esbuild src/lib/shortcuts.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-shortcuts.mjs && node src/lib/.tmp-shortcuts.mjs

import { navChord, panelToggleTarget, physicalKey, prefixMoveDir, isWindowMoveChord, shouldFocusSearch, PREFIX_KEY, PREFIX_SHORTCUTS } from "./shortcuts"
import { PREFIX_SECOND_KEYS } from "./terminalKeys"
import { pickNeighborByRect } from "./chatTree"
import type { PrefixMoveDir } from "./shortcuts"

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

console.log('۴) panelToggleTarget — تفکیک سایدبار و پنل راست:')
{
  const chord = (shift: boolean, code = 'KeyB', key = 'b') => ({
    code,
    key,
    ctrlKey: true,
    metaKey: false,
    shiftKey: shift,
  })
  check('Ctrl+B → sidebar', panelToggleTarget(chord(false)) === 'sidebar')
  check('Ctrl+Shift+B → right', panelToggleTarget(chord(true)) === 'right')
  check('⌘+Shift+B (مک) → right', panelToggleTarget({ code: 'KeyB', key: 'b', ctrlKey: false, metaKey: true, shiftKey: true }) === 'right')
  // چیدمان فارسی: کلید فیزیکی B حرف «ذ» می‌دهد ولی code همان KeyB است.
  check('Ctrl+Shift+«ذ» (code=KeyB) → right', panelToggleTarget(chord(true, 'KeyB', 'ذ')) === 'right')
  check('بدون Ctrl → null', panelToggleTarget({ code: 'KeyB', key: 'b', ctrlKey: false, metaKey: false, shiftKey: true }) === null)
  check('کلید دیگر → null', panelToggleTarget({ code: 'KeyC', key: 'c', ctrlKey: true, metaKey: false, shiftKey: true }) === null)
}

console.log('۵) prefixMoveDir — جابه‌جایی پنجره با H/J/K/L:')
{
  check('h → left', prefixMoveDir('h') === 'left')
  check('j → down', prefixMoveDir('j') === 'down')
  check('k → up', prefixMoveDir('k') === 'up')
  check('l → right', prefixMoveDir('l') === 'right')
  check('H بزرگ → left', prefixMoveDir('H') === 'left')
  check('u → null (undo می‌ماند)', prefixMoveDir('u') === null)
  check('خالی → null', prefixMoveDir('') === null)
  check('null → null', prefixMoveDir(null) === null)
}

console.log('۶) isWindowMoveChord — کورد مستقیم Cmd/Ctrl + H/J/K/L:')
{
  const chord = (k: string, code: string, opts: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({
    key: k,
    code,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    altKey: !!opts.alt,
    shiftKey: !!opts.shift,
  })
  check('Ctrl+H → left', isWindowMoveChord(chord('h', 'KeyH', { ctrl: true })) === 'left')
  check('Ctrl+J → down', isWindowMoveChord(chord('j', 'KeyJ', { ctrl: true })) === 'down')
  check('Ctrl+K → up', isWindowMoveChord(chord('k', 'KeyK', { ctrl: true })) === 'up')
  check('Ctrl+L → right', isWindowMoveChord(chord('l', 'KeyL', { ctrl: true })) === 'right')
  check('⌘+H (مک) → left', isWindowMoveChord(chord('h', 'KeyH', { meta: true })) === 'left')
  // چیدمان فارسی: کلید فیزیکی H حرف «ا» می‌دهد ولی code همان KeyH است.
  check('Ctrl+«ا» (code=KeyH) → left', isWindowMoveChord(chord('ا', 'KeyH', { ctrl: true })) === 'left')
  check('Ctrl+Shift+H → null (سواپ Shift+Alt جدا است)', isWindowMoveChord(chord('h', 'KeyH', { ctrl: true, shift: true })) === null)
  check('Ctrl+Alt+H → null', isWindowMoveChord(chord('h', 'KeyH', { ctrl: true, alt: true })) === null)
  check('بدون مودیفایر → null (تایپ/اسکرول)', isWindowMoveChord(chord('h', 'KeyH')) === null)
  check('Ctrl+X → null (پیشوند جدا)', isWindowMoveChord(chord('x', 'KeyX', { ctrl: true })) === null)
}

console.log('۷) کلید دوم پیشوند — j=ترمینال، h/l=پرش سکشن، براکت‌ها=تب ترمینال:')
{
  // حرکت بین پنجره‌های چت فقط با کورد مستقیم Ctrl+H/J/K/L است؛ در پیشوند،
  // h/l پرش بین سه سکشن‌اند (سایدبار ↔ چت‌ها ↔ پنل راست) و j ترمینال را
  // می‌زند. k هیچ کاری در پیشوند ندارد.
  check('j → terminal', PREFIX_SHORTCUTS['j']?.action === 'terminal')
  check('k کلید دوم دستور نیست', PREFIX_SHORTCUTS['k'] === undefined)
  check('h → پرش سکشن چپ', PREFIX_SHORTCUTS['h']?.action === 'pane-left')
  check('l → پرش سکشن راست', PREFIX_SHORTCUTS['l']?.action === 'pane-right')
  // ترمینال هم نباید h/k/l را به‌عنوان کلید دوم پیشوند بلعد؛ فقط j و براکت‌ها
  // و کلیدهای صوتی/undo می‌مانند.
  const second: readonly string[] = PREFIX_SECOND_KEYS
  check('ترمینال: j کلید دوم پیشوند است', second.includes('j'))
  check('ترمینال: h/k/l کلید دوم پیشوند نیستند', !second.includes('h') && !second.includes('k') && !second.includes('l'))
}

console.log('۸) جهت هر کلید — همان جهت ویم، مستقل از چیدمان:')
{
  // مستقیم: هر کلید همیشه همان جهت ویم را می‌دهد.
  check('h → left', prefixMoveDir('h') === 'left')
  check('j → down', prefixMoveDir('j') === 'down')
  check('k → up', prefixMoveDir('k') === 'up')
  check('l → right', prefixMoveDir('l') === 'right')

  // مسیر واقعی App.moveChatWindow: همسایه از روی مستطیل‌های واقعی انتخاب می‌شود
  // و فقط پنجره‌ای که واقعاً در آن جهت است هدف می‌شود. باگ قبلی: پیمایش به‌ترتیب
  // صفحه باعث می‌شد Ctrl+H پایین برود و Ctrl+J/K به راست.
  const R = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })
  const step = (k: string, rects: Record<string, ReturnType<typeof R>>, active: string) =>
    pickNeighborByRect(rects, active, prefixMoveDir(k) as PrefixMoveDir)

  // کنار هم و روی هم.
  const side = { A: R(0, 0, 500, 800), B: R(500, 0, 1000, 800) }
  const stack = { A: R(0, 0, 1000, 400), B: R(0, 400, 1000, 800) }
  check('کنار هم A: l → B', step('l', side, 'A') === 'B')
  check('کنار هم B: h → A', step('h', side, 'B') === 'A')
  check('کنار هم A: j → null (پایین پنجره‌ای نیست)', step('j', side, 'A') === null)
  check('کنار هم B: k → null', step('k', side, 'B') === null)
  check('کنار هم A: h → null (لبه)', step('h', side, 'A') === null)
  check('روی هم A: j → B', step('j', stack, 'A') === 'B')
  check('روی هم B: k → A', step('k', stack, 'B') === 'A')
  check('روی هم A: l → null', step('l', stack, 'A') === null)

  // چیدمان مختلط: A بلند در چپ، B بالا-راست، C پایین-راست.
  const mixed = { A: R(0, 0, 500, 800), B: R(500, 0, 1000, 400), C: R(500, 400, 1000, 800) }
  check('مختلط B: h → A (نه پایین)', step('h', mixed, 'B') === 'A')
  check('مختلط C: h → A', step('h', mixed, 'C') === 'A')
  check('مختلط B: j → C', step('j', mixed, 'B') === 'C')
  check('مختلط C: k → B', step('k', mixed, 'C') === 'B')
  check('مختلط B: k → null', step('k', mixed, 'B') === null)
  check('مختلط B: l → null', step('l', mixed, 'B') === null)
  check('مختلط A: l → یکی از B/C', ['B', 'C'].includes(step('l', mixed, 'A') ?? ''))
  check('مختلط A: j → null', step('j', mixed, 'A') === null)

  // شبکهٔ ۲×۲.
  const grid = { TL: R(0, 0, 500, 400), TR: R(500, 0, 1000, 400), BL: R(0, 400, 500, 800), BR: R(500, 400, 1000, 800) }
  check('شبکه TL: j → BL', step('j', grid, 'TL') === 'BL')
  check('شبکه TL: l → TR', step('l', grid, 'TL') === 'TR')
  check('شبکه BR: k → TR', step('k', grid, 'BR') === 'TR')
  check('شبکه BR: h → BL', step('h', grid, 'BR') === 'BL')
  check('شبکه TR: h → TL', step('h', grid, 'TR') === 'TL')
  check('شبکه BL: k → TL', step('k', grid, 'BL') === 'TL')
}

console.log('۹) کلیدهای فیزیکی براکت — چرخه تب ترمینال با Ctrl+X [ / ]:')
{
  // physicalKey باید براکت‌ها را از `e.code` بسازد تا کورد روی چیدمان‌های
  // غیرلاتین (فارسی و…) هم کار کند — e.key روی آن‌ها نویسهٔ بومی می‌دهد.
  check('BracketLeft → [', physicalKey({ code: 'BracketLeft', key: 'ﮊ' }) === '[')
  check('BracketRight → ]', physicalKey({ code: 'BracketRight', key: 'ﮈ' }) === ']')
  check('latin key هم‌خوان است', physicalKey({ code: 'BracketLeft', key: '[' }) === '[')
  check('کلید پیشوند دست‌نخورده', physicalKey({ code: 'KeyX', key: 'خ' }) === 'x' && PREFIX_KEY === 'x')
  // ثبت کورد در جدول پیشوند + گارد ترمینال.
  check('[ → terminal-prev', PREFIX_SHORTCUTS['[']?.action === 'terminal-prev')
  check('] → terminal-next', PREFIX_SHORTCUTS[']']?.action === 'terminal-next')
  const second: readonly string[] = PREFIX_SECOND_KEYS
  check('براکت‌ها کلید دوم پیشوند داخل ترمینال‌اند', second.includes('[') && second.includes(']'))
  // هر action باید در اپ وایر شده باشد — یک تایپو بی‌صدا کورد را می‌بلعد.
  const known = new Set(['voice', 'live', 'terminal', 'pane-left', 'pane-right', 'terminal-focus', 'terminal-next', 'terminal-prev'])
  const unknown = Object.values(PREFIX_SHORTCUTS).filter((s) => s.action && !known.has(s.action))
  check('همهٔ actionها وایر شده‌اند', unknown.length === 0, unknown)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
