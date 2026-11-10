// Fits the window-strip cluster (Chat/Code switch + sidebar toggle + update)
// inside the narrowest legal sidebar. Settings is NOT in the cluster any more —
// it lives on the app bar's right end, next to the wallet chip.
//
// Run: node tests/sidebarClusterFit.test.ts
//
// The failure this locks: the cluster is pinned to the sidebar's drag strip,
// whose left gutter is 88px of macOS traffic lights, and the strip CLIPS
// (overflow: hidden). Once a fourth control joined it, a sidebar dragged to its
// old 180px floor left ~84px while the shrunk cluster needed ~100px — so the
// trailing icon was silently cut off. Neither number is reachable by a media
// query (they describe the SIDEBAR's width, not the viewport), so the fit is
// enforced here: the control sizes come from the CSS itself, so the CSS stays
// the single source of truth.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, clampSidebarWidth } from '../src/lib/sidebarLayout.ts'

const here = dirname(fileURLToPath(import.meta.url))
// The switching CSS lives in its own part file (19-run-mode-switch.css) so this
// area stays maintainable; the cluster's host rules stay in 01. Both are read,
// and the switch's rules WIN because 19 is imported after 01.
const css =
  readFileSync(join(here, '../src/styles/global/01-projects-list-folder-rows.css'), 'utf8') +
  '\n' +
  readFileSync(join(here, '../src/styles/global/19-run-mode-switch.css'), 'utf8')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

/** Last `width: Npx` declared in a rule whose selector is exactly `sel`. */
function widthOf(sel: string): number | null {
  const rule = new RegExp(
    `(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css)
  if (!rule) return null
  const widths = [...rule[2].matchAll(/width:\s*(\d+)px/g)].map((m) => Number(m[1]))
  return widths.length ? widths[widths.length - 1] : null
}

/** `padding` shorthand / longhands of one rule → {left, right} in px. */
function paddingSides(sel: string): { left: number; right: number } | null {
  const rule = new RegExp(
    `(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css)
  if (!rule) return null
  const body = rule[2]
  let left = 0
  let right = 0
  const pad = /padding:\s*([^;]+);/.exec(body)
  if (pad) {
    const parts = pad[1].trim().split(/\s+/)
    // 1 = all, 2 = vertical/horizontal, 3 = top/horizontal/bottom, 4 = TRBL
    const l = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : parts.length === 3 ? parts[1] : parts[3]
    const r = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : parts.length === 3 ? parts[1] : parts[1]
    left = parseInt(l, 10) || 0
    right = parseInt(r, 10) || 0
  }
  const long = /padding-left:\s*(\d+)px/.exec(body)
  if (long) left = Number(long[1])
  const longR = /padding-right:\s*(\d+)px/.exec(body)
  if (longR) right = Number(longR[1])
  return { left, right }
}

/** Last `border-radius: Npx` declared in a rule whose selector is exactly `sel`. */
function radiusOf(sel: string): number | null {
  const rule = new RegExp(
    `(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css)
  if (!rule) return null
  const radii = [...rule[2].matchAll(/border-radius:\s*(\d+)px/g)].map((m) => Number(m[1]))
  return radii.length ? radii[radii.length - 1] : null
}

console.log('1) عرض کنترل‌ها در باریک‌ترین حالت از خود CSS خوانده می‌شود:')
const compactChatCode = widthOf('.window-strip-cluster[data-compact] .run-mode-switch .run-mode-btn')
const compactIcon = widthOf('.window-strip-cluster[data-compact] .titlebar-icon-btn')
const compactUpdate = widthOf('.window-strip-cluster[data-compact] .update-btn')
check('عرض دکمه‌های چت/کد پیدا شد', compactChatCode !== null, compactChatCode)
check('عرض دکمه‌های آیکونی پیدا شد', compactIcon !== null, compactIcon)
check('عرض دکمه‌ی آپدیت پیدا شد', compactUpdate !== null, compactUpdate)

console.log('2) گاتر چراغ‌های مک از خود CSS خوانده می‌شود:')
const pad = paddingSides('.mac .sidebar-drag')
check('گاتر چپ/راست پیدا شد', pad !== null, pad)
// The traffic lights sit in the LEFT gutter; the right one keeps the last
// icon off the window edge. BOTH are subtracted from the room the cluster has.
const gutter = (pad?.left ?? 0) + (pad?.right ?? 0)
check('گاتر چپ برای چراغ‌ها ≥ ۸۰px است', (pad?.left ?? 0) >= 80, pad)

console.log('3) کلاستر تا شده در حداقل عرض سایدبار جا می‌شود:')
// The switch is ONE box now, not two free buttons: its own width has to be
// counted, and the two halves live inside it.
const compactSwitch = widthOf('.window-strip-cluster[data-compact] .run-mode-switch')
check('عرض کل سوییچ چت/کد پیدا شد', compactSwitch !== null, compactSwitch)
const needed =
  (compactSwitch ?? 0) + // Chat + Code, one segmented control
  (compactIcon ?? 0) + // sidebar toggle
  (compactUpdate ?? 0) // update (renders only when one exists — worst case)
const room = SIDEBAR_MIN_WIDTH - gutter
console.log(`     needed=${needed}px  room=${room}px  min=${SIDEBAR_MIN_WIDTH}px  gutter=${gutter}px`)
// `needed` sums control WIDTHS only, which is honest ONLY because the compact
// step zeroes the cluster's own gap (asserted right below). If that rule ever
// changes, this arithmetic silently under-counts and the fit check stops
// meaning anything.
const compactBlock = css.slice(css.indexOf('.window-strip-cluster[data-compact]'))
const firstCompactRule = compactBlock.slice(0, compactBlock.indexOf('}'))
check(
  'پله‌ی compact گپ کلاستر را صفر می‌کند (فرض محاسبه‌ی بالا)',
  /gap:\s*0/.test(firstCompactRule),
  firstCompactRule.slice(0, 80),
)
check('هیچ آیکونی بریده نمی‌شود', needed <= room, { needed, room })
check('حاشیه‌ی اطمینان حداقل ۴px است', room - needed >= 4, { slack: room - needed })

console.log('4) clamp عرض سایدبار:')
check('پایین‌تر از حداقل → حداقل', clampSidebarWidth(120) === SIDEBAR_MIN_WIDTH, clampSidebarWidth(120))
check('بالاتر از حداکثر → حداکثر', clampSidebarWidth(900) === SIDEBAR_MAX_WIDTH, clampSidebarWidth(900))
check('مقدار معتبر دست‌نخورده می‌ماند', clampSidebarWidth(300) === 300, clampSidebarWidth(300))
check('عدد نامعتبر → حداقل (نه NaN)', clampSidebarWidth(Number.NaN) === SIDEBAR_MIN_WIDTH, clampSidebarWidth(Number.NaN))

console.log('5) هیچ پله‌ای آیکون را مخفی نمی‌کند:')
const compactRules = compactBlock.slice(0, compactBlock.indexOf('.titlebar-divider'))
check('display:none در پله‌های compact نیست', !/display:\s*none/.test(compactRules))
check('سوییچ هرگز none نمی‌شود', !/\.run-mode-switch\s*\{[^}]*display:\s*none/.test(css))

console.log('6) چیپ انتخاب‌شده داخل ترک می‌ماند (شعاع‌های هم‌مرکز):')
{
  // The selected half is a pill INSIDE the track. The two rounded rects are
  // concentric by construction (the pill is positioned from the track's own
  // padding), so the ONE thing that can break is a radius step that lets the
  // pill's corners poke out of the track.
  const baseTrack = radiusOf('.run-mode-switch')
  const basePill = radiusOf('.run-mode-switch::after')
  const compactPill = radiusOf('.window-strip-cluster[data-compact] .run-mode-switch::after')
  const compactTrack = radiusOf('.window-strip-cluster[data-compact] .run-mode-switch')
  const xsPill = radiusOf('.window-strip-cluster[data-compact="xs"] .run-mode-switch::after')
  const xsTrack = radiusOf('.window-strip-cluster[data-compact="xs"] .run-mode-switch')
  check('شعاع ترک و چیپ حالت عادی پیدا شد', baseTrack !== null && basePill !== null, { baseTrack, basePill })
  // Inner radius = outer - padding keeps the two corners concentric; a pill at
  // or above the track's radius has square corners poking through.
  check('چیپ همیشه گردتر از ترک است', (basePill ?? 99) < (baseTrack ?? 0), { baseTrack, basePill })
  check('در پله‌ی compact شعاع ترک صفر نشده', (compactTrack ?? 0) > 0, compactTrack)
  check(
    'در پله‌ی compact چیپ همیشه گردتر از ترک می‌ماند',
    compactTrack !== null && compactPill !== null && compactPill < compactTrack,
    { compactTrack, compactPill },
  )
  check(
    'در کف (xs) هم چیپ گردتر از ترک است',
    xsTrack !== null && xsPill !== null && xsPill < xsTrack,
    { xsTrack, xsPill },
  )
}

console.log('7) پیپ با نصف عرض جابه‌جا می‌شود (به دکمه‌ی دوم می‌رسد، نه بیشتر):')
{
  // The pill is slid by a hard-coded translateX. A stale offset is invisible in
  // review and obvious on screen (the pill lands across both halves), so the
  // distance is checked against the halves it must cover.
  for (const [label, track, pill, half] of [
    ['حالت عادی', '.run-mode-switch', '.run-mode-switch::after', '.run-mode-switch .run-mode-btn'],
    ['compact', '.window-strip-cluster[data-compact] .run-mode-switch', '.window-strip-cluster[data-compact] .run-mode-switch::after', '.window-strip-cluster[data-compact] .run-mode-switch .run-mode-btn'],
    ['xs', '.window-strip-cluster[data-compact="xs"] .run-mode-switch', '.window-strip-cluster[data-compact="xs"] .run-mode-switch::after', '.window-strip-cluster[data-compact="xs"] .run-mode-switch .run-mode-btn'],
  ] as const) {
    const trackW = widthOf(track) ?? 0
    const pillW = widthOf(pill) ?? 0
    const halfW = widthOf(half) ?? 0
    const travel = /translateX\((\d+)px\)/.exec(
      new RegExp(`${track.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[data-mode="code"\\]::after\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '',
    )
    const dist = travel ? Number(travel[1]) : null
    // Landing on the second half means: travel == half width + inter-half gap,
    // and the pill still ends flush inside the track.
    check(`${label}: فاصله‌ی سفر تعریف شده`, dist !== null, { trackW, pillW, halfW, dist })
    check(`${label}: پیپ از دو نیمه بیشتر نمی‌رود`, dist !== null && dist + pillW <= trackW, { dist, pillW, trackW })
    check(`${label}: پیپ به نیمه‌ی دوم می‌رسد`, dist !== null && dist >= halfW, { dist, halfW })
    // Exact landing: track padding (2px in every step) + travel + pill + the
    // same padding must close the track. A travel 2px too far still passed the
    // two checks above while the pill visibly ate the track's right edge.
    check(
      `${label}: پیپ دقیقاً داخل track می‌نشیند`,
      dist !== null && 2 + dist + pillW + 2 === trackW,
      { dist, pillW, trackW, expected: trackW - pillW - 4 },
    )
  }
}

if (failed) {
  console.error(`\n  ${failed} check(s) failed`)
  process.exit(1)
}
console.log('\n  همه‌ی بررسی‌ها سبز')
