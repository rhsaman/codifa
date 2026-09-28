// تست تک‌پخش سراسری TTS در src/lib/tts.ts:
// - پخش ویس جدید، ویس قبلی (پیام/چت دیگر) را قطع می‌کند — چند ویس همزمان نه.
// - استاپ غیرمالک، ویس فعال را نمی‌کشد (unmount پیام دیگر بی‌اثر است).
// - نتیجه fetch کهنه (ویسی که حین لودینگ قطع شده) پخش نمی‌شود.
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

// fetch موک: /health همیشه زنده؛ /tts با تاخیر قابل‌کنترل برمی‌گردد.
let ttsCall = 0
let firstTtsSlow = false
;(globalThis as any).fetch = async (url: string) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/tts')) {
    ttsCall++
    const myCall = ttsCall
    if (firstTtsSlow && myCall === 1) await sleep(60)
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([`audio${myCall}`], { type: 'audio/mpeg' }),
    } as any
  }
  return new Response('', { status: 200 })
}

const { playTts, stopTts, getTtsSnapshot } = await import('./tts')

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
  await playTts('متن اول', opts, 1)
  check('بعد از پخش اول: speaking', getTtsSnapshot().status === 'speaking')
  const first = MockAudio.instances[0]
  await playTts('متن دوم', opts, 2)
  check('ویس اول pause شد', first?.paused === true, first)
  check('فقط ویس دوم فعال است', getTtsSnapshot().owner === 2, getTtsSnapshot())
  check('دو Audio ساخته شد (اولی قطع‌شده)', MockAudio.instances.length === 2)
  stopTts()
}

console.log('۲) استاپ غیرمالک، ویس فعال را نمی‌کشد:')
{
  MockAudio.instances = []
  await playTts('متن پیام دیگر', opts, 10)
  const active = MockAudio.instances[0]
  stopTts(99)
  check('بعد از استاپ غیرمالک هنوز speaking', getTtsSnapshot().status === 'speaking')
  check('ویس فعال pause نشد', active?.paused === false, active)
  stopTts(10)
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
  check('مالک فعال، ویس تازه است', getTtsSnapshot().owner === 21, getTtsSnapshot())
  stopTts()
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای تک‌پخش TTS پاس شدند')
