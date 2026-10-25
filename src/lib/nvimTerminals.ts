/**
 * Where THIS app launches Neovim.
 *
 * Neovim ALWAYS opens inside the app: "Open with → Neovim" (and the workspace
 * "open terminal here" action) spawn a terminal TAB in the side pane and run
 * `nvim +<line> <file>` in its own pty. There is no external-terminal picker —
 * a terminal outside the app was one more process to install, focus and keep in
 * step, and the in-app pane needs nothing but the app itself.
 *
 * The type stays a single-value union (rather than dropping it) because the id
 * is persisted in settings.json and read by the Rust side out of the same key;
 * collapsing it here is what retires every external target.
 */

export type NvimTerminal = 'inapp'

/** The only target Neovim opens in. Kept as a named default (not a bare string)
 *  so the store, the picker and the Rust reader share one spelling. */
export const DEFAULT_NVIM_TERMINAL: NvimTerminal = 'inapp'

export interface NvimTerminalOption {
  id: NvimTerminal
  label: string
  hint: string
}

/** Picker order = the order Settings renders. One entry: the in-app pane. */
export const NVIM_TERMINALS: readonly NvimTerminalOption[] = [
  {
    id: 'inapp',
    label: 'This app’s own panel',
    hint: 'A terminal tab in the right pane — no other app needed',
  },
] as const

/** Shell choices usable as the SHELL of the in-app terminal. `""` means "inherit
 *  the OS login shell" (`$SHELL`), which the backend uses when nothing is set. */
export const SHELL_CHOICES: readonly string[] = ['', 'zsh', 'bash', 'fish', 'nu', 'elvish'] as const

/** Shell the in-app terminal runs out of the box. zsh is the macOS login shell
 *  AND the one the user's config/plugins live in, so a fresh install gets the
 *  familiar prompt rather than whatever `$SHELL` the GUI process inherited
 *  (a launched .app inherits no login shell at all). Still changeable in
 *  Settings → Terminal. */
export const DEFAULT_TERMINAL_SHELL = 'zsh'

/** Is the picked target the in-app pane? Always true now — Neovim has no
 *  external target left. Kept as a function so call sites read as intent
 *  ("does this open in the app?") instead of a hard-coded comparison. */
export function opensInApp(_v?: unknown): boolean {
  return true
}

/** A stored/garbage value normalised to a target we can actually run. */
export function resolveNvimTerminal(_v?: unknown): NvimTerminal {
  return DEFAULT_NVIM_TERMINAL
}

/** Human label for a target, for the picker and the "Open with" hint. */
export function nvimTerminalLabel(_v?: unknown): string {
  return NVIM_TERMINALS[0].label
}

/** Hint shown under "Neovim" in the file menu, so the menu says WHERE it opens
 *  without the user opening Settings first. */
export function nvimTerminalHint(_v?: unknown): string {
  return NVIM_TERMINALS[0].hint
}

/** Label for a shell choice ("" = the OS login shell). */
export function shellLabel(shell: string): string {
  const s = shell.trim()
  return s ? s : 'System default ($SHELL)'
}
