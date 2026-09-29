// تست تک‌پخش سراسری TTS در src/lib/tts.ts:
// - پخش ویس جدید، ویس قبلی (پیام/چت دیگر) را قطع می‌کند — چند ویس همزمان نه.
// - استاپ غیرمالک، ویس فعال را نمی‌کشد (unmount پیام دیگر بی‌اثر است).
// - نتیجه fetch کهنه (ویسی که حین لودینگ قطع شده) پخش نمی‌شود.
// - کلیک تند پلی/استاپ/پلی روی همان پیام، دو ویس همزمان نمی‌سازد.
// - استاپ/پخش جدید، fetch در راه را واقعاً abort می‌کند (سیگنال لغو می‌شود).
// - دو toggle همگام پشت سر هم روی همان پیام: دومی اولی را قطع می‌کند.
// اجرا: npx esbuild src/lib/tts.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=tests/.tmp-tts.mjs --external:electron \
//        && node tests/.tmp-tts.mjs

export {}

// موک سایدکار قبل از ایمپورت ماژول (api.ts هنگام لود به window.coder وصل می‌شود).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => 'http://127.0.0.1:8899',
    onSidecarChanged: () => () => {},
    onSidecarDead: () => () => {},
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

// موک Audio: نمونه‌ها را نگه می‌دارد تا pause شدن ویس قبلی بررسی شود.
class MockAudio {
  static instances: MockAudio[] = []
  paused = false
  played = false
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    MockAudio.instances.push(this)
  }
  async play() {
    this.played = true
    setTimeout(() => {
      if (!this.paused && this.onended) this.onended()
    }, 30)
  }
  pause() {
    this.paused = true
  }
}
;(globalThis as any).Audio = MockAudio

// موک URL شیء: هر blob یک یوآرال یکتا می‌گیرد.
let urlCounter = 0
let revoked = 0
;(globalThis.URL as any).createObjectURL = () => `blob:mock-${++urlCounter}`
;(globalThis.URL as any).revokeObjectURL = () => {
  revoked++
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// خواب قابل‌لغو: با abort شدن سیگنال، مثل fetch واقعی AbortError می‌دهد.
const sleepAbort = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

// fetch موک: /health همیشه زنده؛ /tts با تاخیر قابل‌کنترل برمی‌گردد و به
// سیگنال لغو احترام می‌گذارد. سیگنال‌ها نگه داشته می‌شوند تا abort شدنشان بررسی شود.
let ttsCall = 0
let firstTtsSlow = false
const seenSignals: AbortSignal[] = []
;(globalThis as any).fetch = async (url: string, init?: { signal?: AbortSignal }) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/tts')) {
    ttsCall++
    const myCall = ttsCall
    const signal = init?.signal
    if (signal) seenSignals.push(signal)
    if (firstTtsSlow && myCall === 1) await sleepAbort(60, signal)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([`audio${myCall}`], { type: 'audio/mpeg' }),
    } as any
  }
  return new Response('', { status: 200 })
}

const { playTts, stopTts, toggleTts, getTtsSnapshot, friendlyTtsError } = await import('./tts')
const { splitTtsSentences } = await import('./api')

const opts = { kind: 'openai', baseUrl: 'http://127.0.0.1:8899' }

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) پخش ویس جدید، ویس قبلی را قطع می‌کند:')
{
  MockAudio.instances = []
  const p1 = playTts('متن اول', opts, 1)
  await sleep(10)
  check('حین پخش اول: speaking', getTtsSnapshot().status === 'speaking')
  const first = MockAudio.instances[0]
  const p2 = playTts('متن دوم', opts, 2)
  await Promise.all([p1, p2])
  check('ویس اول pause شد', first?.paused === true, first)
  check('دو Audio ساخته شد (اولی قطع‌شده)', MockAudio.instances.length === 2)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  stopTts()
}

console.log('۲) استاپ غیرمالک، ویس فعال را نمی‌کشد:')
{
  MockAudio.instances = []
  const p = playTts('متن پیام دیگر', opts, 10)
  await sleep(10)
  const active = MockAudio.instances[0]
  stopTts(99)
  check('بعد از استاپ غیرمالک هنوز speaking', getTtsSnapshot().status === 'speaking')
  check('ویس فعال pause نشد', active?.paused === false, active)
  stopTts(10)
  await p
  check('بعد از استاپ مالک: idle', getTtsSnapshot().status === 'idle')
  check('ویس مالک pause شد', active?.paused === true, active)
}

console.log('۳) نتیجه fetch کهنه پخش نمی‌شود:')
{
  MockAudio.instances = []
  ttsCall = 0
  firstTtsSlow = true
  const p1 = playTts('متن کهنه', opts, 20)
  await sleep(10)
  const p2 = playTts('متن تازه', opts, 21)
  await Promise.all([p1, p2])
  firstTtsSlow = false
  check('فقط یک Audio (ویس تازه) ساخته شد', MockAudio.instances.length === 1, MockAudio.instances.length)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  stopTts()
}

console.log('۴) کلیک تند روی همان پیام، دو ویس همزمان نمی‌سازد:')
{
  MockAudio.instances = []
  ttsCall = 0
  firstTtsSlow = true
  const p1 = playTts('کلیک اول', opts, 30)
  await sleep(10)
  const p2 = playTts('کلیک دوم', opts, 30)
  await Promise.all([p1, p2])
  firstTtsSlow = false
  check('فقط یک Audio (کلیک آخر) ساخته شد', MockAudio.instances.length === 1, MockAudio.instances.length)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  stopTts()
}

console.log('۵) استاپ حین لودینگ، نتیجه fetch را دور می‌ریزد:')
{
  MockAudio.instances = []
  ttsCall = 0
  seenSignals.length = 0
  firstTtsSlow = true
  const p = playTts('متن در حال لود', opts, 40)
  await sleep(10)
  stopTts(40)
  await p
  firstTtsSlow = false
  check('هیچ Audio ساخته نشد', MockAudio.instances.length === 0, MockAudio.instances.length)
  check('وضعیت idle است', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  check('سیگنال fetch واقعاً abort شد', seenSignals.some((s) => s.aborted), seenSignals.length)
}

console.log('۶) دو toggle همگام روی همان پیام: دومی اولی را قطع می‌کند:')
{
  MockAudio.instances = []
  ttsCall = 0
  seenSignals.length = 0
  firstTtsSlow = true
  // شبیه‌سازی کلیک تند پلی/استاپ: هر دو تصمیم در یک تیک گرفته می‌شوند —
  // دومی باید همگام قطع کند، نه اینکه پخش دوم بسازد.
  const p1 = toggleTts('متن', opts, 50)
  const p2 = toggleTts('متن', opts, 50)
  await Promise.all([p1, p2])
  firstTtsSlow = false
  check('هیچ Audio ساخته نشد', MockAudio.instances.length === 0, MockAudio.instances.length)
  check('وضعیت idle است', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  check('fetch اول abort شد', seenSignals.some((s) => s.aborted), seenSignals.length)
}

console.log('۷) پخش جدید، fetch پیام دیگر را abort می‌کند:')
{
  MockAudio.instances = []
  ttsCall = 0
  seenSignals.length = 0
  firstTtsSlow = true
  const p1 = playTts('متن کهنه', opts, 60)
  await sleep(10)
  const p2 = playTts('متن تازه', opts, 61)
  await Promise.all([p1, p2])
  firstTtsSlow = false
  check('فقط یک Audio (ویس تازه) ساخته شد', MockAudio.instances.length === 1, MockAudio.instances.length)
  check('fetch اول abort شد', seenSignals.some((s) => s.aborted), seenSignals.length)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  stopTts()
}

console.log('۸) متن بلند جمله‌به‌جمله در صف پخش می‌شود:')
{
  MockAudio.instances = []
  ttsCall = 0
  await playTts('Hello world. Second sentence here.', opts, 70)
  check('دو جمله = دو فراخوانی /tts', ttsCall === 2, ttsCall)
  check('دو Audio پشت سر هم ساخته شد', MockAudio.instances.length === 2, MockAudio.instances.length)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  check('splitTtsSentences جمله‌ها را جدا می‌کند', splitTtsSentences('Hello world. Second sentence here.').length === 2)
  stopTts()
}

console.log('۹) کولن/سمی‌کالن وسط جمله را تکه نمی‌کند (پخش روان):')
{
  const parts = splitTtsSentences('Note: this is one idea; still one idea. Second here.')
  check('کولن باعث تکه اضافه نشد (۲ تکه)', parts.length === 2, parts)
  check('تکه اول کامل است', parts[0] === 'Note: this is one idea; still one idea.', parts[0])
}

console.log('۱۰) خطای TTS فارسی و قابل‌فهم است + دکمه تلاش مجدد دارد:')
{
  check('Abort خالی برمی‌گرداند (بی‌صدا)', friendlyTtsError(new DOMException('Aborted', 'AbortError')) === '')
  check(
    '401 → خطای کلید فارسی',
    friendlyTtsError(new Error('speech synthesis failed (401)')).includes('کلید'),
    friendlyTtsError(new Error('speech synthesis failed (401)')),
  )
  check(
    'قطعی شبکه → پیام اتصال فارسی',
    friendlyTtsError(new TypeError('Failed to fetch')).includes('ارتباط'),
    friendlyTtsError(new TypeError('Failed to fetch')),
  )
  check(
    'timeout → پیام تلاش مجدد فارسی',
    friendlyTtsError(new Error('timeout of 120000ms exceeded')).includes('دوباره تلاش'),
    friendlyTtsError(new Error('timeout of 120000ms exceeded')),
  )
  check(
    'پیام طولانی کوتاه می‌شود',
    friendlyTtsError(new Error('x'.repeat(500))).length <= 301,
    friendlyTtsError(new Error('x'.repeat(500))).length,
  )
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای تک‌پخش TTS پاس شدند')
