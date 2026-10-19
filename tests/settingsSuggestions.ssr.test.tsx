// SSR test for the Settings → General → "Keyboard suggestions" toggle and the
// persistence path behind it (run via tests/run-frontend.sh).
//
// The toggle is the user-facing switch for `settings.disableTextSuggestions`,
// which src/lib/inputSuppress.ts applies at the DOM level. A click cannot be
// simulated with renderToString, so this locks down the three things that can
// be: the row renders in the General tab, the store setter round-trips, and the
// new key actually reaches the persist payload (a nested settings key is
// invisible to disk unless it survives hydration + the payload spread).
export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

// Every bridge call is recorded so the persist payload can be inspected.
const storeWrites: Array<{ key: string; value: any }> = []
// Mock the Tauri bridge + localStorage before importing the store/component
// (same pattern as tests/settingsStorage.ssr.test.tsx).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async (...args: unknown[]) => {
          if (prop === 'storeSet') storeWrites.push({ key: String(args[0]), value: args[1] })
          return true
        }
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { SettingsModal } = await import('../src/components/SettingsModal')
const { useStore, flushStateNow } = await import('../src/lib/store')

const el = React.createElement
const lastSettingsWrite = () => [...storeWrites].reverse().find((w) => w.key === 'settings')?.value

console.log('1) the General tab renders the Keyboard suggestions toggle:')
{
  let html = ''
  try {
    html = renderToString(el(SettingsModal, { onClose: () => {}, initialTab: 'general' }))
    check('renders without throwing', html.length > 0)
  } catch (e) {
    check('renders without throwing', false, e)
  }
  check('shows the row label', html.includes('Keyboard suggestions'))
  check('exposes the switch to assistive tech', html.includes('aria-label="Suppress keyboard suggestions"'))
  check('uses the app switch markup', html.includes('plugin-switch') && html.includes('plugin-switch-track'))
  check('explains what it turns off', html.includes('autocorrect') && html.includes('inline predictions'))
  check('is on for a fresh install', /Suppress keyboard suggestions"[^>]*checked/.test(html))
  // The neighbouring General settings must survive the insertion.
  check('kept the auto-compaction threshold row', html.includes('Auto-compaction threshold'))
  check('kept the history turn limit row', html.includes('History turn limit'))
}

console.log('2) the setting round-trips through the store:')
{
  check('defaults to true (suggestions off)', useStore.getState().settings.disableTextSuggestions === true)

  useStore.getState().setDisableTextSuggestions(false)
  check('setter turns it off', useStore.getState().settings.disableTextSuggestions === false)

  // The toggle must read back through the same selector the component uses,
  // otherwise the switch would not follow its own click.
  check(
    'the component selector reads the new value',
    (useStore.getState().settings.disableTextSuggestions ?? true) === false,
  )

  useStore.getState().setDisableTextSuggestions(true)
  check('setter turns it back on', useStore.getState().settings.disableTextSuggestions === true)
}

console.log('3) the flag reaches the persisted settings payload:')
{
  // The settings write is gated on hydration, exactly as in a real boot after
  // the sidecar answered.
  useStore.setState({ settingsHydrated: true })

  useStore.getState().setDisableTextSuggestions(false)
  await flushStateNow()
  check('off is written to disk', lastSettingsWrite()?.disableTextSuggestions === false, lastSettingsWrite())

  useStore.getState().setDisableTextSuggestions(true)
  await flushStateNow()
  check('on is written to disk', lastSettingsWrite()?.disableTextSuggestions === true, lastSettingsWrite())

  // A nested settings key only comes back if hydration lists it explicitly.
  check(
    'hydration lists the key (nested keys are not spread back in)',
    (await import('node:fs')).readFileSync('src/lib/store.ts', 'utf8').includes('raw.disableTextSuggestions'),
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll keyboard-suggestion settings checks passed')
// persist() leaves a debounce timer behind; exit explicitly so node does not
// wait on it (same as tests/chatRenameInput.test.ts).
process.exit(0)
