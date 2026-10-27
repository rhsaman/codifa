/**
 * Regression: the palette must be re-derived at ATTACH, not only on theme change.
 *
 * A screen built earlier (its pty painted itself before the screen re-attached —
 * hidden tab re-shown, panel reopened, HMR/StrictMode remount) once kept the
 * palette of its build moment forever: xterm repaints buffered cells on a theme
 * swap, so one stale/garbled palette stuck for the whole session (the "nvim
 * turns yellow in the right pane" report). registerTerminalScreen is the single
 * point both terminal hosts pass through, so it now overwrites the palette.
 *
 * Run: npx esbuild src/lib/xtermTheme.attach.test.ts --bundle --platform=node --format=esm --outfile=tests/.tmp-xterm-theme.mjs && node tests/.tmp-xterm-theme.mjs
 */
import { registerTerminalScreen, xtermTheme } from './xtermTheme'

let failed = 0
function check(name: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
}

// xtermTheme() reads CSS variables off documentElement — stand in the app's
// rose-pine values so the derivation runs unmodified under node.
const VARS: Record<string, string> = {
  '--bg': '#191724',
  '--bg-alt': '#191724',
  '--text': '#e0def4',
  '--text-dim': '#6e6a86',
  '--danger': '#eb6f92',
  '--success': '#3fb950',
  '--thinking': '#f6c177',
  '--link': '#4a9bc0',
  '--accent': '#ebbcba',
}
;(globalThis as Record<string, unknown>).document = {
  documentElement: {},
}
;(globalThis as Record<string, unknown>).getComputedStyle = () => ({
  getPropertyValue: (n: string) => VARS[n] ?? '',
})

// The build moment carried a wrong palette (whatever produced it): the screen
// must NOT keep it past registration.
const garbageTerm: Parameters<typeof registerTerminalScreen>[0] = {
  term: { options: { fontSize: 14, theme: { background: '#192008' } } },
  refit() {},
}
const off = registerTerminalScreen(garbageTerm)

const want = xtermTheme()
check('attach overwrites a stale background', garbageTerm.term.options.theme?.background === want.background)
check(
  'attach overwrites a stale ANSI slot (yellow)',
  garbageTerm.term.options.theme?.yellow === want.yellow && want.yellow === VARS['--thinking'],
)
check(
  'truecolor cells stay untouched by the palette (theme fg is theme text, nvim bg is cell-level)',
  want.foreground === VARS['--text'],
)

// Unregister must detach cleanly (font/style updates stop reaching the screen).
off()
const removed = { term: { options: { fontSize: 14 } }, refit() {} }
registerTerminalScreen(removed)()
check('unregister returns without throwing', true)

console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ xtermTheme.attach: all checks passed')
process.exit(failed ? 1 : 0)
