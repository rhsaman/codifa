/**
 * Settings → Terminal: the Neovim target and the in-app shell.
 *
 * Neovim has exactly ONE target now — the app's own right-pane terminal tab.
 * There is no external-terminal picker, so what this locks is:
 *   * the registry offers the in-app pane and nothing else;
 *   * a stale/garbage `nvimTerminal` in settings.json still resolves to it
 *     (the key is persisted, so an old file must never strand the user);
 *   * the file menu ALWAYS routes "Open with → Neovim" into the app, never
 *     through the backend launcher;
 *   * the backend keeps no external launcher left to reach;
 *   * `nvimTerminal` / `terminalShell` survive a save + reload round trip
 *     (the load literal is an allowlist — a key that is not listed there is
 *     silently dropped on restart, which is exactly the bug this covers).
 *
 * Run: npx esbuild tests/nvimTerminals.test.ts --bundle --platform=node \
 *        --format=esm --outfile=tests/.fe-run/nvimTerminals.mjs && node …
 */
export {}

// Minimal DOM/storage stubs: the store hydrates from localStorage at import time.
const disk = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => disk.get(k) ?? null,
  setItem: (k: string, v: string) => void disk.set(k, v),
  removeItem: (k: string) => void disk.delete(k),
}
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: { setProperty: () => {} } },
  addEventListener: () => {},
  removeEventListener: () => {},
}
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  localStorage: (globalThis as any).localStorage,
  // A stubbed desktop bridge: the store hydrates through it at import time.
  // The Proxy answers ANY method with a harmless value, so a new call added to
  // the hydration path cannot break this test for an unrelated reason.
  coder: new Proxy(
    {
      getSidecarUrl: async () => 'http://127.0.0.1:8899',
      onSidecarChanged: () => () => {},
      onSidecarDead: () => () => {},
    },
    {
      get: (target: Record<string, unknown>, key: string) =>
        key in target ? target[key] : () => () => {},
    },
  ),
}

import { readFileSync } from 'node:fs'

// Dynamic imports: a STATIC import is hoisted above the stubs above, so the
// store would hydrate before `window` exists. `terminalTab.test.ts` does the
// same for the same reason.
const {
  DEFAULT_NVIM_TERMINAL,
  DEFAULT_TERMINAL_SHELL,
  NVIM_TERMINALS,
  SHELL_CHOICES,
  nvimTerminalHint,
  nvimTerminalLabel,
  opensInApp,
  resolveNvimTerminal,
  shellLabel,
} = await import('../src/lib/nvimTerminals')
const { useStore } = await import('../src/lib/store')

let failures = 0
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}`, extra === undefined ? '' : `→ ${JSON.stringify(extra)}`)
  }
}

console.log('1) the registry is the single source of the Neovim target:')
{
  check('the app pane is the only target', NVIM_TERMINALS.length === 1, NVIM_TERMINALS.map((t) => t.id))
  check('and it is the in-app one', NVIM_TERMINALS[0].id === 'inapp', NVIM_TERMINALS[0].id)
  check('every option carries a label and a hint',
    NVIM_TERMINALS.every((t) => t.label.length > 0 && t.hint.length > 0))
  check('the default is that target', DEFAULT_NVIM_TERMINAL === 'inapp', DEFAULT_NVIM_TERMINAL)
  check('the hint says it opens here, not elsewhere',
    /pane|panel|app/i.test(nvimTerminalHint(undefined)), nvimTerminalHint(undefined))
  check('the label names the panel rather than an external app',
    !/ghostty|warp|cmux|iterm|terminal\.app/i.test(nvimTerminalLabel(undefined)),
    nvimTerminalLabel(undefined))
}

console.log('2) unknown values degrade, they never strand:')
{
  for (const v of [undefined, null, '', 'ghostty', 'warp', 'cmux', 'iterm', 'system', 'konsole', 42, {}]) {
    check(`resolveNvimTerminal(${JSON.stringify(v)}) → inapp`,
      resolveNvimTerminal(v) === 'inapp')
  }
  check('every value reports as opening in the app', opensInApp('ghostty') && opensInApp(undefined))
}

console.log('3) the file menu always opens Neovim INSIDE the app:')
{
  const panel = readFileSync('src/components/FileViewerPanel.tsx', 'utf8')
  const at = panel.indexOf('const openExternalFile =')
  check('openExternalFile exists', at !== -1)
  const body = panel.slice(at, panel.indexOf('\n  };', at))
  // The in-app branch is the ONLY Neovim path now: `"nvim"` is no longer an
  // OpenTargetId at all, so the row must route straight to the terminal tab.
  check('the nvim row routes to the in-app terminal tab',
    /editor === "inapp"/.test(body) && body.includes('openTerminal(') && !/editor === "nvim"/.test(body), body.slice(0, 300))
  check('it no longer consults a "where does nvim open" setting',
    !/opensInApp\(/.test(body), body.slice(0, 300))
  check('VS Code stays a separate external target', body.includes('openFileExternal'))
}

console.log('4) the backend keeps no external terminal launcher:')
{
  const src = readFileSync('src-tauri/src/commands.rs', 'utf8')
  for (const fn of ['launch_terminal', 'launch_ghostty', 'launch_cmux', 'launch_iterm', 'launch_warp', 'launch_system_terminal', 'launch_portable']) {
    check(`${fn} is gone`, !src.includes(`fn ${fn}(`), fn)
  }
  check('no code reads a Neovim-terminal setting any more',
    !src.includes('NVIM_TERMINAL_KEY'))
  check('the workspace "open terminal" action no longer shells out',
    /pub fn open_workspace_terminal\(dir: String\)/.test(src))
  const prefs = readFileSync('src-tauri/src/prefs.rs', 'utf8')
  check('the retired prefs key is gone', !prefs.includes('NVIM_TERMINAL_KEY'))
  check('and the settings reader still defaults instead of failing',
    prefs.includes('unwrap_or(Value::Null)'))
}

console.log('5) the shell picker keeps its documented default:')
{
  check('shell choices start with the OS default',
    SHELL_CHOICES[0] === '' && shellLabel('').includes('SHELL') && shellLabel('fish') === 'fish')
  const modal = readFileSync('src/components/SettingsModal.tsx', 'utf8')
  check('the picker marks zsh as the out-of-the-box default',
    modal.includes('DEFAULT_TERMINAL_SHELL') && DEFAULT_TERMINAL_SHELL === 'zsh')
  check('Settings no longer renders a Neovim-target dropdown',
    !modal.includes('NVIM_TERMINALS') && !modal.includes('Neovim opens in'))
}

console.log('6) the settings keys survive a save + reload round trip:')
{
  // A junk value on write is normalised: the backend only knows one target, so
  // it must never read a value it cannot act on.
  useStore.getState().setNvimTerminal('konsole' as never)
  check('an unknown nvim target normalises on write',
    useStore.getState().settings.nvimTerminal === 'inapp',
    useStore.getState().settings.nvimTerminal)

  useStore.getState().setTerminalShell('fish')
  check('terminalShell is stored', useStore.getState().settings.terminalShell === 'fish')

  // The default IS zsh: a launched .app inherits no login shell at all, so
  // `$SHELL` alone would hand the user a bare /bin/sh prompt.
  useStore.getState().setTerminalShell('')
  check('an empty shell choice falls back to the documented default',
    useStore.getState().settings.terminalShell === DEFAULT_TERMINAL_SHELL,
    useStore.getState().settings.terminalShell)

  // The load literal is an allowlist: a key missing from it disappears on the
  // next boot. Read the source so a future edit cannot quietly drop these.
  const storeSrc = readFileSync('src/lib/store.ts', 'utf8')
  check('the load literal keeps nvimTerminal', /nvimTerminal[:=]/.test(storeSrc))
  check('the load literal keeps terminalShell', /terminalShell[:=]/.test(storeSrc))
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
