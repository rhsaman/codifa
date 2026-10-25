/** Launching Neovim over the IN-APP terminal (the right side pane).
 *
 * "Edit in nvim" needs no editor widget: the terminal panel already runs a
 * program in a real pty (src-tauri/src/pty.rs), so the target just asks the
 * backend for `nvim +<line> <file>`. The user's own Neovim config, plugins and
 * keymaps apply, and the app gains no dependency.
 *
 * No node/electron/React imports here so node-based tests can import it. */

/** Binary the in-app target launches. A bare name is resolved on the
 *  LOGIN-shell PATH backend-side, so a Homebrew install is found even when the
 *  app was launched from Finder (see pty::resolve_program). */
export const NVIM_PROGRAM = 'nvim'

/** argv that opens `abs` at `line` (1-based). A missing or degenerate line is
 *  dropped rather than emitted as `+0`, which nvim reads as "last line" and
 *  would park a brand-new file at its end. */
export function nvimArgs(abs: string, line?: number): string[] {
  const target = abs.trim()
  const at = typeof line === 'number' && Number.isFinite(line) && line > 0 ? Math.floor(line) : null
  return at === null ? [target] : [`+${at}`, target]
}

/** Identity of a run request: the program plus its argv, order-sensitive.
 *
 *  An argv is compared as a LIST, never as one joined string: the backend
 *  reports the RESOLVED command line (absolute path, space-joined) and a path
 *  may itself contain spaces, so only the exact argv array identifies a request.
 *  NUL joins the parts because it cannot occur in a path. */
export function runTargetKey(argv: readonly string[]): string {
  return argv.join('\u0000')
}

/** The already-open tab running exactly this request, if any.
 *
 *  A run target is expensive to duplicate — the user's Neovim with its language
 *  servers measured ~600 MB for ONE instance — so re-requesting the same file
 *  must focus that tab rather than spawn a second editor. Pure, for tests. */
export function findOpenRunTarget<T extends { id: string; argv?: string[] }>(
  tabs: readonly T[],
  argv: readonly string[],
): T | null {
  const wanted = runTargetKey(argv)
  return tabs.find((t) => t.argv !== undefined && runTargetKey(t.argv) === wanted) ?? null
}
