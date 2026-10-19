// Regression test for the terminal ANSI palette (xtermTheme).
//
// The bug this locks: xtermTheme used to return only 6 keys, so every ANSI
// slot fell back to xterm's built-in palette — whose greys are green-tinted
// (`#555753` for `brightBlack`). zsh-autosuggestions paints its inline
// suggestion with `fg=8` (brightBlack), so the suggestion rendered GREEN
// instead of muted theme grey. A partial theme is not neutral: xterm fills
// each omitted slot from its own defaults, one by one.
//
// The function only needs `getComputedStyle` + `document.documentElement`, so
// the test drives a tiny stand-in DOM instead of jsdom.
export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

// Theme CSS variables the fake getComputedStyle serves. Empty = the
// pre-hydration / web-only case, which must use the fallbacks.
let vars: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).document = { documentElement: {} }
;(globalThis as any).getComputedStyle = () => ({
  getPropertyValue: (n: string) => vars[n] ?? '',
})

const { xtermTheme } = await import('../src/components/TerminalPanel')

/** The eight base ANSI slots and their bright counterparts. */
const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

/** xterm's built-in default for the slot zsh-autosuggestions uses. */
const XTERM_DEFAULT_BRIGHT_BLACK = '#555753'

console.log('1) every ANSI slot is defined (no xterm default can leak):')
{
  vars = {}
  const theme = xtermTheme() as Record<string, string | undefined>
  const missing = ANSI_SLOTS.filter((slot) => !theme[slot])
  check('all 16 ANSI slots are present', missing.length === 0, missing)
  check(
    'no slot is undefined',
    ANSI_SLOTS.every((slot) => typeof theme[slot] === 'string'),
  )
  check(
    'no slot is an empty string',
    ANSI_SLOTS.every((slot) => (theme[slot] ?? '').length > 0),
  )
}

console.log('2) the autosuggestion slot is theme grey, not xterm green-grey:')
{
  vars = {}
  const theme = xtermTheme() as Record<string, string>
  check(
    'brightBlack (fg=8) is NOT xterm default #555753',
    theme.brightBlack !== XTERM_DEFAULT_BRIGHT_BLACK,
    theme.brightBlack,
  )
  check('brightBlack falls back to --text-dim', theme.brightBlack === '#6e6a86', theme.brightBlack)
}

console.log('3) theme variables win when the theme is hydrated:')
{
  vars = {
    '--bg-alt': '#101014',
    '--text': '#f0f0f5',
    '--text-dim': '#8a86a0',
    '--accent': '#ff00aa',
    '--accent-dim': '#202030',
    '--danger': '#ff5555',
    '--success': '#00ff88',
    '--thinking': '#ffcc00',
    '--link': '#4488ff',
  }
  const theme = xtermTheme() as Record<string, string>
  check('background follows --bg-alt', theme.background === '#101014', theme.background)
  check('foreground follows --text', theme.foreground === '#f0f0f5', theme.foreground)
  check('brightBlack follows --text-dim', theme.brightBlack === '#8a86a0', theme.brightBlack)
  check('black reuses the background', theme.black === '#101014', theme.black)
  check('red follows --danger', theme.red === '#ff5555' && theme.brightRed === '#ff5555')
  check('green follows --success', theme.green === '#00ff88' && theme.brightGreen === '#00ff88')
  check('yellow follows --thinking', theme.yellow === '#ffcc00' && theme.brightYellow === '#ffcc00')
  check('blue follows --link', theme.blue === '#4488ff' && theme.brightBlue === '#4488ff')
  check('magenta follows --accent', theme.magenta === '#ff00aa' && theme.brightMagenta === '#ff00aa')
  check('white reuses the foreground', theme.white === '#f0f0f5' && theme.brightWhite === '#f0f0f5')
  check(
    'selection uses --accent-dim',
    theme.selectionBackground === '#202030',
    theme.selectionBackground,
  )
}

console.log('4) cyan has no dedicated app variable but is still resolved:')
{
  vars = { '--success': '#00ff88' }
  const theme = xtermTheme() as Record<string, string>
  check('cyan resolves to the success colour', theme.cyan === '#00ff88', theme.cyan)
  check('brightCyan resolves to the success colour', theme.brightCyan === '#00ff88', theme.brightCyan)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
