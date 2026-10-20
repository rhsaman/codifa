// Colour audit for the terminal surface (src/styles/global.css).
//
// The rule this locks: every colour the terminal paints must come from the app
// theme. Two classes of leak are checked here —
//   1. no hex literal may survive anywhere in the terminal region of the
//      stylesheet (xterm's own imported sheet is out of scope, so its literals
//      must be OVERRIDDEN here instead of edited),
//   2. the specific overrides for xterm's hard-coded values must exist:
//      --vscode-scrollbar-shadow (its `#000` fallback on the scroll-area inset
//      shadows), the `.composition-view` IME popup, and the viewport surface.
// `--bg-raised` is also checked, because no theme defines it — a literal there
// stayed Rose Pine under every palette.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

// The terminal region: from its banner comment to the next unrelated section.
const START = 'Bottom terminal panel (Cmd/Ctrl+J)'
const END = 'Live voice composer controls'
const from = css.indexOf(START)
const to = css.indexOf(END, from + START.length)
const region = from === -1 || to === -1 ? '' : css.slice(from, to)
// Comments carry prose (and the words "dark strip"), never a paint colour.
const stripped = region.replace(/\/\*[\s\S]*?\*\//g, '')

console.log('1) the terminal region exists and paints no literal colour:')
{
  check('the region was found in the stylesheet', region.length > 0, { from, to })
  const hexes = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  check('no hex literal anywhere in the terminal region', hexes.length === 0, hexes)
  const funcs = stripped.match(/\b(?:rgb|rgba|hsl|hsla)\(/g) ?? []
  check('no rgb()/hsl() literal either', funcs.length === 0, funcs)
}

console.log("2) xterm's hard-coded values are overridden with theme vars:")
{
  const panel = region.match(/\.terminal-panel\s*\{[^}]*\}/)
  check(
    '--vscode-scrollbar-shadow is scoped to the terminal (was xterm #000)',
    /--vscode-scrollbar-shadow:\s*var\(--bg-alt\)/.test(panel?.[0] ?? ''),
    panel?.[0],
  )

  const composition = region.match(/\.terminal-screen \.xterm \.composition-view\s*\{[^}]*\}/)
  check('the IME composition popup is overridden', composition !== null, composition?.[0])
  check(
    'the popup uses theme surfaces, not #000/#FFF',
    /background:\s*var\(--bg-panel\)/.test(composition?.[0] ?? '') &&
      /color:\s*var\(--text\)/.test(composition?.[0] ?? ''),
    composition?.[0],
  )

  const viewport = region.match(/\.terminal-screen \.xterm-viewport\s*\{[^}]*\}/)
  check(
    'the scroll viewport surface follows the theme (xterm sets #000)',
    /background-color:\s*var\(--bg-alt\)/.test(viewport?.[0] ?? ''),
    viewport?.[0],
  )
  check(
    'the scrollbar thumb follows the theme',
    /\.terminal-screen \.xterm-viewport::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--bg-raised\)/.test(
      region,
    ),
  )
}

console.log('3) --bg-raised is derived from the theme, not frozen at Rose Pine:')
{
  const root = css.slice(0, css.indexOf('.app {'))
  const decl = root.match(/--bg-raised:\s*([^;]+);/)
  check('--bg-raised is declared in :root', decl !== null, decl?.[0])
  check(
    '--bg-raised derives from other theme vars',
    /color-mix\(/.test(decl?.[1] ?? '') && /var\(--bg-hover\)/.test(decl?.[1] ?? ''),
    decl?.[1],
  )
}

console.log('4) the side-pane dock reuses the same themed surfaces:')
{
  const right = region.match(/\.terminal-panel\.terminal-right\s*\{[^}]*\}/)
  check('a terminal-right dock rule exists', right !== null, right?.[0])
  check(
    'the side dock keeps the themed panel background and border',
    right !== null && !/#[0-9a-fA-F]{3,8}/.test(right[0]),
    right?.[0],
  )
  const full = region.match(/\.terminal-panel\.terminal-full\.terminal-right\s*\{[^}]*\}/)
  check('fullscreen keeps winning over the side dock', full !== null, full?.[0])
  // The dock is a strip along the pane's bottom edge, so its top border is what
  // separates it from the viewer content the pane reserves room for above it.
  check(
    'the side dock draws a separator against the pane content above it',
    /border-top:\s*1px solid var\(--border\)/.test(right?.[0] ?? ''),
    right?.[0],
  )
  check(
    'the dock never paints a literal colour',
    full !== null && !/#[0-9a-fA-F]{3,8}/.test(full[0]),
    full?.[0],
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
