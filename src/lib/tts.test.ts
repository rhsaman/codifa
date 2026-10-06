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
    this.paused = false
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
// NOTE: playTts prefetches sentence 0 and 1 up front in queue order, so
// /tts call 1 = sentence 1, call 2 = sentence 2. This flag delays call 2 =
// sentence 2's download, keeping the queue open while sentence 1 plays and ends.
let sentenceTwoSlow = false
// شماره فراخوانی‌های /tts که باید fail شوند — برای تست رد شدن جمله خراب.
const failTtsCalls = new Set<number>()
let failAllTts = false
// فالبک/retry: fail بر اساس body ارسالی (provider/base_url) یا N خطای اول.
// body ارسالی api.ts شامل provider (= opts.kind) و base_url (= opts.baseUrl) است.
const failBaseUrls = new Set<string>()
const failProviders = new Set<string>()
let ttsFailRemaining = 0
// Fail any /tts request whose body text includes this substring (sentence-targeted,
// immune to call numbering and retry rounds).
let failTextIncludes = ''
const seenBaseUrls: string[] = []
const seenSignals: AbortSignal[] = []
;(globalThis as any).fetch = async (url: string, init?: { signal?: AbortSignal; body?: unknown }) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/tts')) {
    ttsCall++
    const myCall = ttsCall
    // تفکیک opts از روی body ارسالی شامل provider و base_url (api.ts)
    let bodyBaseUrl = ''
    let bodyProvider = ''
    let bodyText = ''
    try {
      const raw = (init as any)?.body
      if (typeof raw === 'string' && raw) {
        const parsed = JSON.parse(raw)
        bodyBaseUrl = String(parsed?.base_url ?? '')
        bodyProvider = String(parsed?.provider ?? '')
        bodyText = String(parsed?.text ?? '')
      }
    } catch {
      // body غیر JSON: نادیده بگیر
    }
    if (failTextIncludes && bodyText.includes(failTextIncludes)) throw new Error('synthesis failed (500)')
    if (bodyBaseUrl) seenBaseUrls.push(bodyBaseUrl)
    if (bodyBaseUrl && failBaseUrls.has(bodyBaseUrl)) throw new Error('synthesis failed (500)')
    if (bodyProvider && failProviders.has(bodyProvider)) throw new Error('synthesis failed (500)')
    if (ttsFailRemaining > 0) {
      ttsFailRemaining--
      throw new Error('synthesis failed (500)')
    }
    if (failAllTts || failTtsCalls.has(myCall)) throw new Error('synthesis failed (500)')
    const signal = init?.signal
    if (signal) seenSignals.push(signal)
    if (firstTtsSlow && myCall === 1) await sleepAbort(60, signal)
    if (sentenceTwoSlow && myCall === 2) await sleepAbort(120, signal)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([`audio${myCall}`], { type: 'audio/mpeg' }),
    } as any
  }
  return new Response('', { status: 200 })
}

const ttsMod = await import('./tts')
const { playTts, stopTts, toggleTts, pauseTts, resumeTts, getTtsSnapshot, friendlyTtsError, stripMarkdownForTts, speakableMessageText } = ttsMod
// setter تاخیر retry (با فرض پیاده‌سازی setTtsRetryConfig در tts.ts توسط ساب‌ایجنت tts؛
// اگر هنوز اضافه نشده باشد undefined است و تست‌های ۲۰/۲۱ آن را گزارش می‌کنند).
const setTtsRetryConfig = (ttsMod as unknown as { setTtsRetryConfig?: (cfg: Record<string, unknown>) => void }).setTtsRetryConfig
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

console.log('۱۱) پایان هر جمله بلافاصله ObjectURL آن را آزاد می‌کند (قبل از پایان صف):')
{
  MockAudio.instances = []
  ttsCall = 0
  sentenceTwoSlow = true
  const before = revoked
  const p = playTts('Hello world. Second sentence here.', opts, 80)
  // جملهٔ اول سریع می‌آید و ~۳۰ms پخش و تمام می‌شود؛ دانلود جملهٔ دوم تا
  // ~۱۲۰ms طول می‌کشد. URL جملهٔ اول باید همین‌جا آزاد شود، نه تا پایان صف.
  await sleep(70)
  check('URL جملهٔ اول زودتر از پایان صف آزاد شد', revoked > before, { revoked, before })
  check('فقط جملهٔ اول پخش شده', MockAudio.instances.length === 1, MockAudio.instances.length)
  sentenceTwoSlow = false
  await p
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  stopTts()
}

console.log('۱۲) pause حین پخش، صدا را نگه می‌دارد و resume از همان‌جا ادامه می‌دهد:')
{
  MockAudio.instances = []
  ttsCall = 0
  const p = playTts('First sentence here. Second sentence here. Third sentence here.', opts, 90)
  await sleep(10)
  check('حین پخش: speaking', getTtsSnapshot().status === 'speaking')
  const first = MockAudio.instances[0]
  pauseTts(90)
  check('بعد از pause: paused', getTtsSnapshot().status === 'paused')
  check('ویس pause شد', first?.paused === true)
  await resumeTts(90)
  check('بعد از resume: speaking', getTtsSnapshot().status === 'speaking')
  await p
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle')
  stopTts()
}

console.log('۱۳) toggle حین پخش pause می‌کند و toggle دوباره resume می‌کند (بدون پخش از اول):')
{
  MockAudio.instances = []
  ttsCall = 0
  const p1 = toggleTts('First here. Second here. Third here.', opts, 91)
  await sleep(10)
  await toggleTts('ignored', opts, 91)
  check('toggle حین پخش → paused', getTtsSnapshot().status === 'paused')
  const countAtPause = MockAudio.instances.length
  await toggleTts('ignored', opts, 91)
  check('toggle دوباره → speaking', getTtsSnapshot().status === 'speaking')
  check('resume ویس جدید نساخت (از اول پخش نشد)', MockAudio.instances.length === countAtPause, MockAudio.instances.length)
  await p1
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle')
  stopTts()
}

console.log('۱۴) جمله ناموفق رد می‌شود و بقیه پاسخ پخش می‌شود (گیر نکردن وسط پخش):')
{
  MockAudio.instances = []
  ttsCall = 0
  // Sentence 2 always fails (matched by body text, immune to call numbering and
  // retry rounds) so it is skipped after all rounds; sentence 1 still plays.
  // Small retry delay keeps the test fast (default is 5s between rounds).
  setTtsRetryConfig?.({ delayMs: 10 } as any)
  failTextIncludes = 'Second sentence here'
  await playTts('First sentence here. Second sentence here.', opts, 92)
  failTextIncludes = ''
  setTtsRetryConfig?.({ delayMs: 5000 } as any)
  check('با وجود خطای یک جمله، صف resolve شد و جمله سالم پخش شد', MockAudio.instances.length === 1, MockAudio.instances.length)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle')
  stopTts()
}

console.log('۱۵) وقتی هیچ جمله‌ای موفق نیست، خطا بالا می‌آید (سکوت بی‌دلیل نه):')
{
  MockAudio.instances = []
  ttsCall = 0
  // Shrink retry delay: both sentences fail all rounds, default 5s gaps are slow.
  setTtsRetryConfig?.({ delayMs: 10 } as any)
  failAllTts = true
  let threw = false
  try {
    await playTts('First here. Second here.', opts, 93)
  } catch {
    threw = true
  }
  failAllTts = false
  setTtsRetryConfig?.({ delayMs: 5000 } as any)
  check('خطا throw شد', threw)
  check('هیچ Audio ساخته نشد', MockAudio.instances.length === 0, MockAudio.instances.length)
  check('وضعیت idle است', getTtsSnapshot().status === 'idle')
  stopTts()
}

console.log('۱۶) markdown برای گفتار تمیز می‌شود:')
{
  const md = stripMarkdownForTts('## Title\n\nSee [docs](https://x.test/page) and `code`.\n\n```ts\nconst a = 1\n```\n\n- item one\n> quote here\n\nVisit https://x.test/raw now')
  check('هدر/لینک/کدفنس/نقل‌قول خوانا شد', md.includes('Title') && md.includes('docs') && md.includes('const a = 1') && md.includes('item one') && md.includes('quote here'), md)
  check('نشانه‌گذاری و URL خام خوانده نمی‌شود', !md.includes('https://') && !md.includes('```') && !md.includes('##'), md)
}

console.log('۱۷) فقط prose نهایی خوانده می‌شود (narration ابزارها نه):')
{
  type Msg = Parameters<typeof speakableMessageText>[0]
  const msg = {
    id: 'm1',
    role: 'assistant',
    content: 'x',
    createdAt: 0,
    segments: [
      { kind: 'text', text: 'Let me check the file.' },
      { kind: 'tool', index: 0 },
      { kind: 'text', text: 'Done, here is the result.' },
    ],
  } as unknown as Msg
  const spoken = speakableMessageText(msg)
  check('فقط prose نهایی', spoken === 'Done, here is the result.', spoken)
  stopTts()
}

console.log('۱۸) بدنه پلن (کارت Plan) خوانده نمی‌شود:')
{
  type Msg = Parameters<typeof speakableMessageText>[0]
  const msg = {
    id: 'm2',
    role: 'assistant',
    content: 'Intro here.\n## Plan\nbody here',
    createdAt: 0,
    planDoc: { title: 'P', body: '## Plan\nbody here', preamble: 'Intro here.' },
  } as unknown as Msg
  const spoken = speakableMessageText(msg)
  check('فقط preamble خوانده می‌شود', spoken.includes('Intro here.') && !spoken.includes('body here'), spoken)
  stopTts()
}

console.log('۱۹) فالبک TTS: provider اول fail، دومی موفق (آرایه opts):')
{
  MockAudio.instances = []
  ttsCall = 0
  seenBaseUrls.length = 0
  failTtsCalls.clear()
  failAllTts = false
  failBaseUrls.clear()
  failProviders.clear()
  ttsFailRemaining = 0
  const badOpts = { kind: 'bad-provider', baseUrl: 'http://bad-provider:8899' }
  const goodOpts = { kind: 'openai', baseUrl: 'http://good-provider:8899' }
  // تفکیک opts از روی base_url متفاوت؛ موک fetch بادی را parse می‌کند.
  failBaseUrls.add('http://bad-provider:8899')
  const before = MockAudio.instances.length
  const startCalls = ttsCall
  let threw = false
  try {
    await (playTts as any)('متن فالبک', [badOpts, goodOpts], 100)
  } catch (err) {
    threw = true
    console.error('   fallback threw:', err)
  }
  failBaseUrls.clear()
  const usedCalls = ttsCall - startCalls
  check('فالبک throw نکرد', !threw)
  check('حداقل ۲ فراخوانی (bad + good)', usedCalls >= 2, usedCalls)
  check('provider سالم واقعاً صدا زده شد', seenBaseUrls.includes('http://good-provider:8899'), seenBaseUrls)
  check('یک Audio ساخته شد', MockAudio.instances.length === before + 1, MockAudio.instances.length)
  check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
  stopTts()
}

console.log('۲۰) retry خودکار: ۲ fail بعد success (delay کوچک):')
{
  MockAudio.instances = []
  ttsCall = 0
  seenBaseUrls.length = 0
  failTtsCalls.clear()
  failAllTts = false
  failBaseUrls.clear()
  failProviders.clear()
  if (typeof setTtsRetryConfig !== 'function') {
    check('setTtsRetryConfig وجود دارد (tts.ts باید setter بدهد)', false, typeof setTtsRetryConfig)
    stopTts()
  } else {
    // delay کوچک با setTimeout واقعی — بدون sleep چندثانیه‌ای.
    try {
      setTtsRetryConfig({ delayMs: 10, baseDelayMs: 10, retryDelayMs: 10, delay: 10, maxAttempts: 5 } as any)
    } catch (err) {
      console.error('   setTtsRetryConfig threw:', err)
    }
    ttsFailRemaining = 2
    const startCalls = ttsCall
    let threw = false
    try {
      await playTts('متن retry', opts, 101)
    } catch (err) {
      threw = true
      console.error('   retry threw:', err)
    }
    const usedCalls = ttsCall - startCalls
    ttsFailRemaining = 0
    // برگرداندن delay به مقدار اصلی (پیش‌فرض سالم).
    try {
      setTtsRetryConfig({ delayMs: 5000, maxAttempts: 5 } as any)
    } catch {}
    check('playTts موفق شد (throw نکرد)', !threw)
    check('تعداد فراخوانی‌ها ۳ است (۲ fail + ۱ success)', usedCalls === 3, usedCalls)
    check('یک Audio ساخته شد', MockAudio.instances.length === 1, MockAudio.instances.length)
    check('بعد از پایان صف: idle', getTtsSnapshot().status === 'idle', getTtsSnapshot())
    stopTts()
  }
}

console.log('۲۱) همه ۵ تلاش fail → throw:')
{
  MockAudio.instances = []
  ttsCall = 0
  seenBaseUrls.length = 0
  failTtsCalls.clear()
  failAllTts = false
  failBaseUrls.clear()
  failProviders.clear()
  if (typeof setTtsRetryConfig !== 'function') {
    check('setTtsRetryConfig وجود دارد (tts.ts باید setter بدهد)', false, typeof setTtsRetryConfig)
    stopTts()
  } else {
    try {
      setTtsRetryConfig({ delayMs: 10, baseDelayMs: 10, retryDelayMs: 10, delay: 10, maxAttempts: 5 } as any)
    } catch {}
    // بیشتر از ۵ fail تا هر ۵ تلاش قطعاً fail شود.
    ttsFailRemaining = 10
    const startCalls = ttsCall
    let threw = false
    try {
      await playTts('متن همیشه خراب', opts, 102)
    } catch {
      threw = true
    }
    const usedCalls = ttsCall - startCalls
    ttsFailRemaining = 0
    try {
      setTtsRetryConfig({ delayMs: 5000, maxAttempts: 5 } as any)
    } catch {}
    check('playTts throw کرد', threw)
    check('۵ بار تلاش شد', usedCalls === 5, usedCalls)
    check('هیچ Audio ساخته نشد', MockAudio.instances.length === 0, MockAudio.instances.length)
    check('وضعیت idle است', getTtsSnapshot().status === 'idle', getTtsSnapshot())
    stopTts()
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای تک‌پخش TTS پاس شدند')
