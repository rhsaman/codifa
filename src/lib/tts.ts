import { useCallback, useEffect, useRef, useState } from 'react'
import { speakTextStream, splitTtsSentences, type SpeakProviderOpts } from './api'

export type TtsStatus = 'idle' | 'loading' | 'speaking'

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
  opts: SpeakProviderOpts,
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
  const sentences = splitTtsSentences(text)
  // متن خیلی کوتاه: همان مسیر تک‌فایل قبلی (بدون صف).
  const queue = sentences.length > 1 ? sentences : [text]
  // پیش‌واکشی جمله بعدی حین پخش جمله فعلی تا مکث بین جمله‌ها حذف شود:
  // دانلود N+1 موازی با پخش N انجام می‌شود، پس پایان N بلافاصله N+1 شروع می‌شود.
  const fetchSentence = (sentence: string): Promise<Blob> =>
    speakTextStream(sentence, opts, undefined, controller.signal)
  let prefetched: Promise<Blob> | null = null
  try {
    for (let i = 0; i < queue.length; i++) {
      if (activeSeq !== seq || controller.signal.aborted) return
      let blob: Blob
      try {
        const pending = prefetched
        prefetched = null
        // دانلود جمله بعدی را همین حالا در پس‌زمینه شروع کن تا حین پخش فعلی آماده شود.
        if (i + 1 < queue.length && !controller.signal.aborted) {
          prefetched = fetchSentence(queue[i + 1])
          // رد غیرمنتظره پس‌زمینه نباید unhandled بماند تا await بعدی برسد.
          prefetched.catch(() => {})
        }
        blob = pending ? await pending : await fetchSentence(queue[i])
      } catch (err) {
        if (activeSeq !== seq || controller.signal.aborted) return
        throw err
      }
      if (activeSeq !== seq || controller.signal.aborted) return
      // جمله خالی (پروایدر هیچ بایتی نداد): رد شو تا صف گیر نکند.
      if (blob.size === 0) continue
      await playBlobChunk(blob, seq, controller)
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
  // پایان طبیعی صف: اگر هنوز همین درخواست فعال است، idle شو.
  if (activeSeq === seq) stopTtsGlobal()
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
    const onAbort = () => {
      audio.onended = null
      audio.onerror = null
      try {
        audio.pause()
      } catch {
        // توقف روی Audioی نیمه‌ساخته نباید صف را خراب کند
      }
      resolve()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    audio.onended = () => {
      controller.signal.removeEventListener('abort', onAbort)
      resolve()
    }
    audio.onerror = () => {
      controller.signal.removeEventListener('abort', onAbort)
      // خطای پخش جمله میانی نباید کل صف را بکشد — فقط رد شو.
      resolve()
    }
    activeStatus = 'speaking'
    notifyTts()
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
export async function toggleTts(
  text: string,
  opts: SpeakProviderOpts,
  owner: number,
): Promise<void> {
  if (activeOwner === owner && activeStatus !== 'idle') {
    stopTtsGlobal()
    return
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
    async (text: string, opts: SpeakProviderOpts) => {
      await playTts(text, opts, myId)
    },
    [myId],
  )

  const toggle = useCallback(
    async (text: string, opts: SpeakProviderOpts) => {
      await toggleTts(text, opts, myId)
    },
    [myId],
  )

  // unmount مالک، ویس خودش را قطع می‌کند؛ unmount غیرمالک اثری ندارد.
  useEffect(() => () => stopTts(idRef.current), [])

  return { status, play, stop, toggle }
}
