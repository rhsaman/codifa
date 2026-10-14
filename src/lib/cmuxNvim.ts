// Pure helpers for opening a file in nvim hosted inside cmux.
// No electron/node imports here so the renderer test runner can import this.
// Detects the cmux socket refusing an outside process. The cmux CLI exits 0
// even on refusal ("Access denied" on stdout), so the output text — not the
// exit code — is the only success signal for socket-backed commands.
export function isSocketDeniedOutput(output: string): boolean {
  return /access denied|broken pipe|only processes started inside cmux/i.test(output)
}

// Single-quote a path for POSIX shells: `a'b` -> `'a'"'"'b'`.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

// Shell command that opens a file in nvim (absolute path, safely quoted).
export function buildNvimCommand(nvimPath: string, abs: string): string {
  return `${nvimPath} ${shellQuote(abs)}`
}

// Escape a string for embedding in an AppleScript double-quoted string.
export function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// osascript args that focus cmux and type the nvim command + Return.
// Best-effort UI-scripting fallback for when the cmux socket refuses outside
// processes; needs Accessibility permission and may fail silently.
export function buildNvimKeystrokeArgs(cmd: string): string[] {
  const escaped = appleScriptEscape(cmd)
  return [
    '-e',
    'set oldClip to the clipboard',
    '-e',
    `set the clipboard to "${escaped}"`,
    '-e',
    'tell application "cmux" to activate',
    '-e',
    'delay 1.5',
    '-e',
    'tell application "System Events" to keystroke "v" using command down',
    '-e',
    'delay 0.5',
    '-e',
    'tell application "System Events" to key code 36',
    '-e',
    'delay 0.5',
    '-e',
    'set the clipboard to oldClip',
  ]
}
