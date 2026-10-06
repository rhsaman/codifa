import { useCallback, useEffect, useRef, useState } from 'react'
import { speakTextStream, splitTtsSentences, type SpeakProviderOpts } from './api'
import { planDisplay } from './planDoc'
import type { ChatMessage } from '../types'

export type TtsStatus = 'idle' | 'loading' | 'speaking' | 'paused'

// ── تک‌پخش سراسری ──────────────────────────────────────────────────────────
// هر پیام چت یک نمونه از useTtsPlayback می‌سازد؛ بدون حالت مشترک، پخش پیام
// دیگر (یا چت دیگر) از پخش فعلی خبر ندارد و چند ویس همزمان پخش می‌شود.
// این ماژول یک HTMLAudioElement واحد نگه می‌دارد: پخش جدید، ویس قبلی را قطع
// می‌کند و همه نمونه‌ها را به idle برمی‌گرداند. هسته فریم‌ورک‌فری است تا
// بدون DOM هم تست شود؛ هوک فقط یک لایه نازک روی آن است.

let activeAudio: HTMLAudioElement | null = null
let activeUrl: string | null = null
let activeOwner = -1
let activeStatus: TtsStatus = 'idle'
let nextOwnerId = 0
// توالی درخواست پخش: هر playTts یک شناسه یکتا می‌گیرد. fetch قبلیِ همان مالک
// (کلیک تند پلی/استاپ روی یک پیام) با همین شناسه کهنه تشخیص داده و دور ریخته
// می‌شود — وگرنه دو fetch همزمان هر دو به Audio می‌رسیدند و همزمان پخش می‌شدند.
let activeSeq = 0
let seqCounter = 0
// کنترلر لغو fetch در راه: استاپ/پخش جدید، دانلود قبلی را واقعاً قطع می‌کند
// (بدون این، fetch کهنه تا آخر دانلود می‌شد و فقط نتیجه‌اش دور ریخته می‌شد).
let activeAbort: AbortController | null = null

export type TtsListener = (status: TtsStatus, owner: number) => void
const listeners = new Set<TtsListener>()

function notifyTts() {
  for (const l of listeners) {
    try {
      l(activeStatus, activeOwner)
    } catch {
      // شنونده نباید پخش را خراب کند — نادیده بگیر
    }
  }
}

/** پیام خطای TTS را به فارسی قابل‌فهم برای کاربر تبدیل می‌کند. */
export function friendlyTtsError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const msg = raw.trim()
  if (!msg) return 'پخش صدا ناموفق بود — دوباره تلاش کنید'
  const lower = msg.toLowerCase()
  if (lower.includes('aborted') || lower.includes('aborterror')) return ''
  if (msg.includes('Python agent not ready')) return 'سرویس صوتی آماده نیست — برنامه را دوباره راه‌اندازی کنید'
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed'))
    return 'ارتباط با سرویس صوتی قطع شد — اتصال اینترنت/سرور محلی را بررسی کنید'
  if (lower.includes('timeout') || lower.includes('timed out'))
    return 'ساخت صدا طول کشید — دوباره تلاش کنید یا متن کوتاه‌تری بدهید'
  if (msg.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('bad key'))
    return 'کلید پروایدر TTS معتبر نیست — تنظیمات ← مدل‌ها را بررسی کنید'
  if (msg.includes('402') || msg.includes('429') || lower.includes('quota') || lower.includes('insufficient') || lower.includes('rate limit'))
    return 'سهمیه TTS تمام شده یا محدود شد — اعتبار/پلن پروایدر را بررسی کنید'
  if (msg.includes('remote speech synthesis failed') || msg.includes('speech synthesis failed'))
    return `ساخت صدا ناموفق بود — ${msg}`
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg
}

/** وضعیت فعلی پخش سراسری (برای تست و دیباگ). */
export function getTtsSnapshot(): { status: TtsStatus; owner: number } {
  return { status: activeStatus, owner: activeOwner }
}

/** اشتراک در تغییر وضعیت پخش سراسری؛ خروجی تابع لغو اشتراک است. */
export function subscribeTts(listener: TtsListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** قطع ویس فعال و برگرداندن همه نمونه‌ها به idle. */
function stopTtsGlobal() {
  // باطل‌کردن fetchهای در راه: نتیجه کهنه بعد از resolve پخش نمی‌شود.
  activeSeq = -1
  // لغو واقعی دانلود در راه — پاسخ لغوشده هرگز به Audio نمی‌رسد.
  if (activeAbort) {
    activeAbort.abort()
    activeAbort = null
  }
  if (activeAudio) {
    activeAudio.onended = null
    activeAudio.onerror = null
    activeAudio.pause()
    activeAudio = null
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl)
    activeUrl = null
  }
  activeOwner = -1
  if (activeStatus !== 'idle') {
    activeStatus = 'idle'
    notifyTts()
  }
}

/**
 * قطع ویس فعال.
 * با owner: فقط وقتی قطع می‌کند که همان مالک در حال پخش باشد — پس unmount
 * یا استاپ پیام غیرمالک، ویس فعال پیام دیگر را نمی‌کشد.
 * بدون owner: قطع بی‌قیدوشرط (مثلاً هنگام تعویض چت).
 */
export function stopTts(owner?: number) {
  if (owner === undefined || activeOwner === owner) stopTtsGlobal()
}

// ── پایداری صف پخش ──────────────────────────────────────────────────────────
// یک جمله کند/خراب نباید کل پاسخ را وسط پخش گیر بیندازد: هر جمله سقف زمانی
// خودش را دارد با یک تلاش مجدد، و جمله‌ای که باز هم نیامد رد می‌شود تا بقیه
// پاسخ پخش شود. نگهبان پخش هم Audioی گیرکرده (بدون end/error) را رد می‌کند.
const SENTENCE_FETCH_TIMEOUT_MS = 45_000
// Number of full rounds over the provider chain before giving up on a sentence.
// Delay between rounds (abort-aware). Exported as mutable `let` plus
// `setTtsRetryConfig` so tests can shrink the delay.
export let TTS_RETRY_ATTEMPTS = 5
export let TTS_RETRY_DELAY_MS = 5_000

/** Override retry tuning (mainly for tests to shrink the delay). */
export function setTtsRetryConfig(cfg: { attempts?: number; delayMs?: number }): void {
  if (cfg.attempts !== undefined) TTS_RETRY_ATTEMPTS = cfg.attempts
  if (cfg.delayMs !== undefined) TTS_RETRY_DELAY_MS = cfg.delayMs
}

/** Normalize a single provider opts or a primary+fallback chain into a chain. */
function toTtsChain(opts: SpeakProviderOpts | SpeakProviderOpts[]): SpeakProviderOpts[] {
  return Array.isArray(opts) ? opts : [opts]
}

/** Abort-aware sleep between retry rounds; throws immediately when aborted. */
function sleepAbortAware(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Download one sentence, trying each provider in the chain in order per round
 * and retrying the whole chain across rounds with an abort-aware delay.
 * Each individual fetch has its own timeout; abort throws immediately.
 * Throws the last error only when every provider in every round failed.
 */
export function fetchSentenceRobust(
  sentence: string,
  chain: SpeakProviderOpts | SpeakProviderOpts[],
  signal: AbortSignal,
): Promise<Blob> {
  const providers = toTtsChain(chain)
  const attemptOnce = (providerOpts: SpeakProviderOpts): Promise<Blob> =>
    new Promise<Blob>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(() => {
        reject(new Error(`TTS sentence timed out after ${SENTENCE_FETCH_TIMEOUT_MS / 1000}s`))
      }, SENTENCE_FETCH_TIMEOUT_MS)
      speakTextStream(sentence, providerOpts, undefined, signal).then(
        (blob) => {
          clearTimeout(timer)
          resolve(blob)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  const run = async (): Promise<Blob> => {
    let lastErr: unknown = new Error('TTS failed: empty provider chain')
    const rounds = Math.max(1, TTS_RETRY_ATTEMPTS)
    for (let round = 0; round < rounds; round++) {
      for (const providerOpts of providers) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        try {
          return await attemptOnce(providerOpts)
        } catch (err) {
          if (signal.aborted) throw err
          lastErr = err
          // Try the next fallback provider in this round.
        }
      }
      if (round < rounds - 1) {
        // Wait before the next round; abort throws immediately.
        await sleepAbortAware(TTS_RETRY_DELAY_MS, signal)
      }
    }
    throw lastErr
  }
  return run()
}

const PLAYBACK_WATCHDOG_MIN_MS = 20_000
const PLAYBACK_WATCHDOG_PER_BYTE_MS = 0.25
const PLAYBACK_WATCHDOG_MAX_MS = 180_000

/**
 * پخش متن با مالک مشخص. ویس قبلی (هر پیام/چت) اول قطع می‌شود؛ اگر حین fetch
 * ویس دیگری شروع شود (حتی از همان پیام با کلیک تند پلی/استاپ)، نتیجه کهنه
 * با شناسه توالی دور ریخته می‌شود و پخش نمی‌شود.
 *
 * متن‌های بلند جمله‌به‌جمله در صف پخش می‌شوند: جمله اول همین که رسید پخش
 * می‌شود و بقیه در پس‌زمینه دانلود و پشت سر هم پخش می‌شوند — حتی وقتی
 * پروایدر استریم بایت‌به‌بایت واقعی ندهد، شروع پخش سریع می‌ماند.
 */
export async function playTts(
  text: string,
  opts: SpeakProviderOpts | SpeakProviderOpts[],
  owner: number,
): Promise<void> {
  stopTtsGlobal()
  const controller = new AbortController()
  activeAbort = controller
  const seq = ++seqCounter
  activeSeq = seq
  activeOwner = owner
  activeStatus = 'loading'
  notifyTts()
  // Normalize single opts or primary+fallback chain into a chain.
  const chain = toTtsChain(opts)
  const sentences = splitTtsSentences(text)
  // متن خیلی کوتاه: همان مسیر تک‌فایل قبلی (بدون صف).
  const queue = sentences.length > 1 ? sentences : [text]
  // پیش‌واکشی دو جمله جلوتر حین پخش جمله فعلی تا مکث بین جمله‌ها حذف شود:
  // دانلود N+1 و N+2 موازی با پخش N انجام می‌شود، پس پایان N بلافاصله جمله
  // بعدی شروع می‌شود و پخش وسط صحبت گیر نمی‌کند.
  const pending = new Map<number, Promise<Blob>>()
  const ensureFetch = (idx: number) => {
    if (idx >= queue.length || pending.has(idx) || controller.signal.aborted) return
    const job = fetchSentenceRobust(queue[idx], chain, controller.signal)
    // رد پس‌زمینه تا await بعدی unhandled نماند.
    job.catch(() => {})
    pending.set(idx, job)
  }
  ensureFetch(0)
  ensureFetch(1)
  let playedAny = false
  let lastErr: unknown = null
  try {
    for (let i = 0; i < queue.length; i++) {
      if (activeSeq !== seq || controller.signal.aborted) return
      ensureFetch(i + 2)
      const job = pending.get(i)
      pending.delete(i)
      let blob: Blob
      try {
        blob = job ? await job : await fetchSentenceRobust(queue[i], chain, controller.signal)
      } catch (err) {
        if (activeSeq !== seq || controller.signal.aborted) return
        // جمله خراب رد می‌شود — بقیه پاسخ هنوز پخش می‌شود.
        lastErr = err
        continue
      }
      if (activeSeq !== seq || controller.signal.aborted) return
      // جمله خالی (پروایدر هیچ بایتی نداد): رد شو تا صف گیر نکند.
      if (blob.size === 0) continue
      await playBlobChunk(blob, seq, controller)
      playedAny = true
    }
  } catch (err) {
    if (activeAbort === controller) activeAbort = null
    // درخواست کهنه یا لغوشده (استاپ/پخش جدید حین لودینگ): بی‌صدا برگرد —
    // نه استاپ اضافه، نه خطا برای کاربر. فقط خطای واقعیِ درخواست جاری بالا می‌رود.
    if (activeSeq !== seq || controller.signal.aborted) return
    stopTtsGlobal()
    throw err
  }
  if (activeAbort === controller) activeAbort = null
  const stillMine = activeSeq === seq
  // پایان طبیعی صف: اگر هنوز همین درخواست فعال است، idle شو.
  if (stillMine) stopTtsGlobal()
  // هیچ جمله‌ای پخش نشد (همه fetchها خراب): خطای آخر بالا می‌رود تا دکمه
  // «تلاش مجدد» نمایش داده شود — نه سکوت بی‌دلیل.
  if (!playedAny && lastErr && stillMine) throw lastErr
}

/** پخش یک تکه صوتی (یک جمله) و انتظار تا پایان آن. */
function playBlobChunk(blob: Blob, seq: number, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeSeq !== seq || controller.signal.aborted) {
      resolve()
      return
    }
    const url = URL.createObjectURL(blob)
    // بین resolve شدن fetch و ساخت Audio ممکن است پخش دیگری شروع شده باشد؛
    // دوباره بررسی کن تا دو Audio همزمان ساخته نشود.
    if (activeSeq !== seq || controller.signal.aborted) {
      URL.revokeObjectURL(url)
      resolve()
      return
    }
    // اگر ویس قبلی هنوز در حال پخش است (مسابقه دو fetch همزمان)، قطعش کن.
    if (activeAudio) {
      activeAudio.onended = null
      activeAudio.onerror = null
      activeAudio.pause()
      activeAudio = null
    }
    if (activeUrl) {
      URL.revokeObjectURL(activeUrl)
      activeUrl = null
    }
    activeUrl = url
    const audio = new Audio(url)
    activeAudio = audio
    // Free this sentence's ObjectURL + audio element as soon as playback
    // finishes (end/error/abort). A finished Audio keeps its decoded buffer and
    // the blob URL keeps the whole clip alive, so holding both until the next
    // sentence (or the end of the queue) accumulates RAM on long reads.
    // stopTtsGlobal's later revoke is a safe no-op: the shared refs are cleared
    // here whenever they still point at this chunk.
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const clearWatchdog = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog)
        watchdog = null
      }
    }
    const release = () => {
      clearWatchdog()
      audio.onended = null
      audio.onerror = null
      if (activeAudio === audio) activeAudio = null
      if (activeUrl === url) activeUrl = null
      URL.revokeObjectURL(url)
    }
    // نگهبان پخش: Audioی گیرکرده (بدون end/error) صف را برای همیشه نگه
    // نمی‌دارد — به جمله بعدی رد می‌شود. حین pause تایمر تمدید می‌شود تا
    // ادامه پخش هیچ صدایی را از دست ندهد.
    const armWatchdog = () => {
      clearWatchdog()
      const budget = Math.min(
        PLAYBACK_WATCHDOG_MAX_MS,
        Math.max(PLAYBACK_WATCHDOG_MIN_MS, blob.size * PLAYBACK_WATCHDOG_PER_BYTE_MS),
      )
      watchdog = setTimeout(() => {
        if (settled) return
        try {
          if (audio.paused && activeSeq === seq && !controller.signal.aborted) {
            armWatchdog()
            return
          }
        } catch {
          // Fall through and skip the stuck chunk.
        }
        settled = true
        release()
        resolve()
      }, budget)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      release()
      try {
        audio.pause()
      } catch {
        // توقف روی Audioی نیمه‌ساخته نباید صف را خراب کند
      }
      resolve()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    audio.onended = () => {
      if (settled) return
      settled = true
      release()
      controller.signal.removeEventListener('abort', onAbort)
      resolve()
    }
    audio.onerror = () => {
      if (settled) return
      settled = true
      release()
      controller.signal.removeEventListener('abort', onAbort)
      // خطای پخش جمله میانی نباید کل صف را بکشد — فقط رد شو.
      resolve()
    }
    activeStatus = 'speaking'
    notifyTts()
    armWatchdog()
    audio.play().then(() => {
      // حین audio.play استاپ زده شده؟ ویسی که تازه شروع شده را بخوابان.
      if (activeSeq !== seq || controller.signal.aborted) {
        try {
          audio.pause()
        } catch {
          // نادیده بگیر — قطع همان هدف است
        }
      }
    }).catch((err: unknown) => {
      settled = true
      clearWatchdog()
      controller.signal.removeEventListener('abort', onAbort)
      // درخواست کهنه (حین پخش، ویس دیگری شروع/استاپ شده): خطا را قورت بده —
      // کاربر دیگر منتظر این ویس نیست.
      if (activeSeq !== seq || controller.signal.aborted) {
        resolve()
        return
      }
      reject(err)
    })
  })
}

/**
 * تغییر وضعیت پخش با تصمیم همگام و اتمیک: اگر همین مالک در حال پخش/لودینگ
 * است قطع می‌کند، وگرنه پخش می‌کند. تصمیم با وضعیت ماژول (همگام) گرفته
 * می‌شود، نه با state ناهمگام ری‌اکت — پس کلیک تند پلی/استاپ هرگز دو پخش
 * همزمان نمی‌سازد (مشکل خواندن ttsStatus کهنه در toggleSpeak).
 */
/** Pause the active voice in place — resume continues from the same spot. */
function pauseActive() {
  if (activeStatus !== 'speaking' || !activeAudio) return
  try {
    activeAudio.pause()
  } catch {
    // Ignore — the playback watchdog still guards a stuck element.
  }
  activeStatus = 'paused'
  notifyTts()
}

/**
 * Pause the active voice (owner-guarded like stopTts).
 * Pausing during loading (nothing audible yet) cancels instead — there is no
 * position to resume from.
 */
export function pauseTts(owner?: number) {
  if (owner !== undefined && activeOwner !== owner) return
  if (activeStatus === 'loading') {
    stopTtsGlobal()
    return
  }
  pauseActive()
}

/** Resume a paused voice from the same position (never restarts). */
export async function resumeTts(owner?: number): Promise<void> {
  if (owner !== undefined && activeOwner !== owner) return
  const audio = activeAudio
  if (activeStatus !== 'paused' || !audio) return
  activeStatus = 'speaking'
  notifyTts()
  try {
    await audio.play()
  } catch {
    // Resume lost the race (a stop/new playback replaced us): only idle when
    // this element is still the active one.
    if (activeAudio === audio) stopTtsGlobal()
  }
}

/**
 * تغییر وضعیت پخش با تصمیم همگام و اتمیک:
 * speaking → pause درجا، paused → resume از همان‌جا، loading → لغو، وگرنه پخش.
 * تصمیم با وضعیت ماژول (همگام) گرفته می‌شود، نه با state ناهمگام ری‌اکت — پس
 * کلیک تند هرگز دو پخش همزمان نمی‌سازد. resume هیچ Audio جدیدی نمی‌سازد، پس
 * برخلاف استاپ/پخش دوباره، از اول شروع نمی‌شود.
 */
export async function toggleTts(
  text: string,
  opts: SpeakProviderOpts | SpeakProviderOpts[],
  owner: number,
): Promise<void> {
  if (activeOwner === owner) {
    if (activeStatus === 'speaking') {
      pauseActive()
      return
    }
    if (activeStatus === 'paused') {
      await resumeTts(owner)
      return
    }
    if (activeStatus === 'loading') {
      stopTtsGlobal()
      return
    }
  }
  await playTts(text, opts, owner)
}

/** پخش‌کننده TTS هر پیام — همه نمونه‌ها روی یک پخش سراسری سوارند. */
export function useTtsPlayback() {
  const idRef = useRef<number>(-1)
  if (idRef.current === -1) idRef.current = nextOwnerId++
  const myId = idRef.current
  const [status, setStatus] = useState<TtsStatus>(() =>
    activeOwner === myId || activeOwner === -1 ? activeStatus : 'idle',
  )

  useEffect(() => {
    const listener: TtsListener = (s, owner) => {
      setStatus(owner === myId ? s : 'idle')
    }
    const unsubscribe = subscribeTts(listener)
    listener(activeStatus, activeOwner)
    return unsubscribe
  }, [myId])

  const stop = useCallback(() => {
    stopTts(myId)
    setStatus((prev) => (activeOwner === myId ? prev : 'idle'))
  }, [myId])

  const play = useCallback(
    async (text: string, opts: SpeakProviderOpts | SpeakProviderOpts[]) => {
      await playTts(text, opts, myId)
    },
    [myId],
  )

  const toggle = useCallback(
    async (text: string, opts: SpeakProviderOpts | SpeakProviderOpts[]) => {
      await toggleTts(text, opts, myId)
    },
    [myId],
  )

  const pause = useCallback(() => {
    pauseTts(myId)
  }, [myId])

  const resume = useCallback(async () => {
    await resumeTts(myId)
  }, [myId])

  // unmount مالک، ویس خودش را قطع می‌کند؛ unmount غیرمالک اثری ندارد.
  useEffect(() => () => stopTts(idRef.current), [])

  return { status, play, stop, toggle, pause, resume }
}

/**
 * Final-answer text for speech synthesis.
 *
 * The bubble shows the agent's working trace (tool narrations, status lines)
 * interleaved with the reply — reading all of `message.content` aloud would
 * speak the work log too. Only genuine prose counts: text segments that render
 * as standalone paragraphs. Narration lines attached to tool cards, tool
 * outputs and the plan body (rendered as the Plan card) are never spoken.
 */
export function speakableMessageText(message: ChatMessage): string {
  const display = planDisplay(message)
  const segments = display.segments
  if (segments && segments.length > 0) {
    const prose: string[] = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.kind !== 'text') continue
      if (!seg.text.trim()) continue
      // Narration for the NEXT tool call renders inside the tool card, not as
      // prose — it describes work in progress, not the answer.
      const next = segments[i + 1]
      if (next && next.kind === 'tool') continue
      prose.push(seg.text)
    }
    return stripMarkdownForTts(prose.join('\n\n'))
  }
  return stripMarkdownForTts(display.content ?? '')
}

/**
 * Strip markdown syntax for speech synthesis so the voice reads words, not
 * markup (headers, links, code fences, tables, HTML tags, bare URLs).
 */
export function stripMarkdownForTts(text: string): string {
  let out = text ?? ''
  // Fenced code blocks: keep the code, drop the fences + language tag.
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) => ` ${code} `)
  // Inline code, images, links → readable words.
  out = out.replace(/`([^`]*)`/g, '$1')
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Headings, quotes, list markers, rules, tables, HTML tags.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  out = out.replace(/^\s{0,3}>\s?/gm, '')
  out = out.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
  out = out.replace(/^\s{0,3}(?:-[-*]|\*[*-]|_[*_])\s*$/gm, '')
  out = out.replace(/\|/g, ' ')
  out = out.replace(/<[^>]+>/g, ' ')
  // Bold/italic/strike markers.
  out = out.replace(/(\*\*|__)/g, '')
  out = out.replace(/~~/g, '')
  // Bare URLs are unreadable aloud — name them instead of spelling them out.
  out = out.replace(/https?:\/\/\S+/g, 'link')
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}
