// SSR test for Settings → Media Providers (the 'models' tab).
//
// Scope note: renderToString reads zustand's SERVER snapshot — the store's
// initial state — so fallback ROWS (whose lists start empty) are not exercised
// here; their internals run in the client. This test pins the tab's structure
// and, because the app's UI language is English, that no Persian hint text
// leaks back into it. The STT language dropdown legitimately shows native
// names ("Persian — فارسی"); those are allowlisted below.
const localStorageStub = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
;(globalThis as any).localStorage = localStorageStub
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  innerWidth: 1440,
  innerHeight: 900,
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => null
      },
    },
  ),
}
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { renderToString } = await import('react-dom/server')
const React = (await import('react')).default
const { SettingsModal } = await import('../src/components/SettingsModal')
const { useStore } = await import('../src/lib/store')

// The shared provider dropdown reads the store: give it one provider so the
// selects have an option to show.
const settings = useStore.getState().settings
useStore.setState({
  settings: {
    ...settings,
    providers: [
      { id: 'p1', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', enabled: true },
    ],
  },
})

const html = renderToString(
  React.createElement(SettingsModal, { onClose: () => {}, initialTab: 'models' }),
)
const flat = html.replace(/<!-- -->/g, '')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) all five capability cards render:')
check('intro names every feature', html.includes('voice input (STT)') && html.includes('video generation') && html.includes('live voice'))
check('STT card', html.includes('Speech to Text (STT)'))
check('TTS card', html.includes('Text to Speech (TTS)'))
check('Image card', html.includes('Image Generation'))
check('Video card', html.includes('Video Generation'))
check('Live voice card', html.includes('Live voice'))

console.log('2) fallback lists share one chrome:')
check('column captions on all four lists', (html.match(/voice-fallback-head/g) ?? []).length === 4)
check('captions say Provider / Model / Voice', html.includes('>Provider<') && html.includes('>Model<') && html.includes('>Voice<'))
check('ladder hint on all four lists', (flat.match(/Tried in order when the primary fails — top first\./g) ?? []).length === 4)
check('add buttons for every list', flat.includes('+ Add STT fallback') && flat.includes('+ Add TTS fallback') && flat.includes('+ Add image fallback') && flat.includes('+ Add video fallback'))

console.log('3) hints are English:')
check('STT language hint', flat.includes('mis-detects the language on short clips'))
check('image endpoints hint', flat.includes('OpenAI-compatible endpoints'))
check('media folder hint', flat.includes('~/.codifa/media'))
check('model override hint', (flat.match(/may request a different model/g) ?? []).length === 2)
check('video formats hint', flat.includes('Sora format') && flat.includes('ffmpeg (downloaded automatically'))
check('realtime vs chunked hint', flat.includes('full-duplex realtime'))

console.log('4) no Persian UI text outside the language picker:')
const persian = (html.match(/[\u0600-\u06FF]+/g) ?? []).filter(
  (w) => !['فارسی', 'العربية', 'اردو'].includes(w),
)
check('zero Persian characters', persian.length === 0, persian.slice(0, 5))

console.log('5) provider selects:')
check('five primary selects share one component', (html.match(/<select dir="ltr"/g) ?? []).length === 6)
check('live empty option explains chunked mode', flat.includes('Not selected — chunked STT + TTS'))

if (failed > 0) process.exit(1)
