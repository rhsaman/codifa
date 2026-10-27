/** Map the app's active theme CSS variables onto the xterm palette so the
 *  terminal never looks bolted-on. Falls back to the Rose Pine defaults
 *  (DEFAULT_THEME) for the pre-hydration paint.
 *
 *  Shared by every terminal host (the bottom panel and the right-pane terminal
 *  TAB), so both screens are painted from one palette.
 *
 *  The ANSI slots below are deliberately spelled out instead of left to xterm:
 *  any slot the caller omits falls back to xterm's built-in Tango palette, whose
 *  greys are GREEN-TINTED (`#2e3436` for `black`, `#555753` for `brightBlack`).
 *  Both zsh-autosuggestions and zsh-syntax-highlighting paint their overlay text
 *  with `fg=8` (brightBlack), so an unset slot made every shell suggestion read
 *  as green instead of muted grey on these dark themes. Deriving the greys from
 *  the theme (`--bg-alt` / `--text-dim` / `--text`) fixes that, and mapping red /
 *  green / yellow onto `--danger` / `--success` / `--thinking` makes the
 *  terminal's git + ls output match the diff colours the app paints elsewhere. */
import type { ITheme } from '@xterm/xterm'

/** Font stack every terminal host renders with.
 *
 *  JetBrains Mono first: it is the family the desktop's own terminal is
 *  configured with, so a file opened inside the app and the same file opened in
 *  an external terminal read identically. The generic stack behind it keeps the
 *  terminal usable on a machine that does not have the font installed. */
export const TERMINAL_FONT_FAMILY =
  "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace"

/** Point size for terminal screens when the user has not chosen one.
 *  The live size is `state.terminalFontSize` (Settings → Appearance); this is
 *  only the seed used before settings hydrate. */
export const TERMINAL_FONT_SIZE = 14

/** Seed sizes for the two code surfaces (Settings → Appearance). The live
 *  values are `state.viewerFontSize` / `state.terminalFontSize`. */
export const DEFAULT_VIEWER_FONT_SIZE = 14
export const DEFAULT_TERMINAL_FONT_SIZE = 14

/** Clamp a code-surface point size (file viewer / terminal) to what the
 *  sliders offer, so a hand-edited settings.json cannot paint a 4px file or a
 *  40px terminal. `fallback` is returned for anything that is not a number. */
export function clampCodeFontSize(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(24, Math.max(9, Math.round(raw)))
}

/** Every live terminal screen, so a size change reaches the RUNNING ones.
 *
 *  xterm reads `fontSize` when the screen is built, not from CSS, so changing
 *  the setting must re-apply the size AND re-fit each screen (the grid changes
 *  with the point size). Hosts add their screen here on mount and remove it on
 *  dispose; the store calls `applyTerminalFontSize` when the setting changes. */
const liveScreens = new Set<{
  term: { options: { fontSize?: number; theme?: ITheme } }
  refit: () => void
}>()

export function registerTerminalScreen(
  screen: { term: { options: { fontSize?: number; theme?: ITheme } }; refit: () => void },
): () => void {
  // Re-derive the palette at ATTACH, not only on theme change (both hosts also
  // listen for that). A screen that was built hours ago and is re-attached now
  // — hidden tab re-shown, panel reopened, StrictMode remount — would keep the
  // palette of its build moment forever: xterm never refreshes colors on its
  // own, so one paint pass with a stale/garbled palette sticks for the whole
  // session. This is the single point every terminal host passes through.
  screen.term.options.theme = xtermTheme()
  liveScreens.add(screen)
  return () => {
    liveScreens.delete(screen)
  }
}

export function applyTerminalFontSize(px: number): void {
  for (const s of liveScreens) {
    s.term.options.fontSize = px
    s.refit()
  }
}

export function xtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  const bg = v('--bg-alt', '#191724')
  const fg = v('--text', '#e0def4')
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: v('--accent-dim', '#403d52'),
    selectionForeground: fg,
    // Inactive selection (terminal unfocused): xterm's default is the same
    // bright selection colour at half opacity, which still reads as "selected"
    // — the theme's hover surface is the honest unfocused state.
    selectionInactiveBackground: v('--bg-hover', '#403d52'),
    // Scrollbar slider + overview-ruler border. Left unset, xterm derives the
    // slider from the FOREGROUND at 20/40/50% alpha, which ties the scrollbar
    // to the text colour instead of the theme's own structure colours. Only
    // plain CSS vars may be used here — xterm parses these as colour values and
    // cannot read a `color-mix()` expression.
    scrollbarSliderBackground: v('--border', '#524f67'),
    // Same var as `brightBlack` above, so it must carry the same fallback —
    // one CSS variable with two different fallbacks is how a palette drifts.
    scrollbarSliderHoverBackground: v('--text-dim', '#6e6a86'),
    scrollbarSliderActiveBackground: v('--text', '#e0def4'),
    overviewRulerBorder: v('--border', '#524f67'),
    // The whole 16-slot ANSI palette, every slot derived from the app theme, so
    // no xterm default leaks through and shell output matches the UI. Leaving a
    // slot out is not neutral: xterm falls back to its own GitHub-ish default
    // for that slot alone.
    //
    // `brightBlack` (slot 8) is the one that matters most here — it is what
    // zsh-autosuggestions asks for by default (`ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE
    // ='fg=8'`), so the inline suggestion renders as muted theme text rather
    // than the bright default grey. It only gets used this way once the pty has
    // a real TERM (see shell env in src-tauri/src/pty.rs); before that the shell
    // could not even resolve slot 8.
    black: bg,
    brightBlack: v('--text-dim', '#6e6a86'),
    red: v('--danger', '#eb6f92'),
    brightRed: v('--danger', '#eb6f92'),
    green: v('--success', '#3fb950'),
    brightGreen: v('--success', '#3fb950'),
    yellow: v('--thinking', '#f6c177'),
    brightYellow: v('--thinking', '#f6c177'),
    // Directories and prompt paths are the most common blue output; the app
    // links its own clickable paths with --link, so the shell agrees with them.
    blue: v('--link', '#4a9bc0'),
    brightBlue: v('--link', '#4a9bc0'),
    magenta: v('--accent', '#ebbcba'),
    brightMagenta: v('--accent', '#ebbcba'),
    // The app palette has no separate cyan tone, so cyan shares the success
    // colour rather than falling back to an unrelated xterm default.
    cyan: v('--success', '#3fb950'),
    brightCyan: v('--success', '#3fb950'),
    white: fg,
    brightWhite: fg,
  }
}
