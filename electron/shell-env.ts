/**
 * Load API-key style environment variables from the user's shell profile files
 * into `process.env`.
 *
 * A GUI app launched from Finder/Dock does NOT source the user's shell rc files,
 * so an `export GOOGLE_GENERATIVE_AI_API_KEY=...` that works in a terminal is
 * invisible to the app. Reading the plain `export NAME=value` assignments from
 * the common profile files makes key-based providers work for GUI launches too.
 *
 * Conservative on purpose: only plain assignments are captured (`export X=y`,
 * `X="y"`, `X='y'`). Anything that needs shell evaluation (command
 * substitution, backticks, `$OTHER` indirection, `unset`) is skipped, and a
 * variable already set in the real process environment always wins.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const PROFILE_FILES = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile']

const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/

function unquote(v: string): string {
  const s = v.trim()
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1)
    }
  }
  return s
}

export function loadShellEnv(): void {
  const home = os.homedir()
  for (const file of PROFILE_FILES) {
    let src: string
    try {
      src = fs.readFileSync(path.join(home, file), 'utf8')
    } catch {
      continue
    }
    for (const raw of src.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('unset ')) continue
      // Lines that would need shell evaluation are never trusted.
      if (line.includes('$(') || line.includes('`')) continue
      const m = ASSIGN_RE.exec(line)
      if (!m) continue
      const name = m[1]
      if (name in process.env) continue // real environment wins
      let value = unquote(m[2])
      if (!value || value.startsWith('$')) continue
      process.env[name] = value
    }
  }
}
