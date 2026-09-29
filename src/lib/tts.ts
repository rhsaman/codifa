import { useCallback, useEffect, useRef, useState } from 'react'
import { speakText, type SpeakProviderOpts } from './api'

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
 */
export async function playTts(
  text: string,
  opts: SpeakProviderOpts,
  owner: number,
): Promise<void> {
  stopTtsGlobal()
  const seq = ++seqCounter
  activeSeq = seq
  activeOwner = owner
  activeStatus = 'loading'
  notifyTts()
  let blob: Blob
  try {
    blob = await speakText(text, opts)
  } catch (err) {
    if (activeSeq === seq) stopTtsGlobal()
    throw err
  }
  if (activeSeq !== seq) return
  const url = URL.createObjectURL(blob)
  // بین resolve شدن fetch و ساخت Audio ممکن است پخش دیگری شروع شده باشد؛
  // دوباره بررسی کن تا دو Audio همزمان ساخته نشود.
  if (activeSeq !== seq) {
    URL.revokeObjectURL(url)
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
  audio.onended = () => {
    if (activeSeq === seq) stopTtsGlobal()
  }
  audio.onerror = () => {
    if (activeSeq === seq) stopTtsGlobal()
  }
  activeStatus = 'speaking'
  notifyTts()
  try {
    await audio.play()
  } catch (err) {
    if (activeSeq === seq) stopTtsGlobal()
    throw err
  }
  // حین audio.play استاپ زده شده؟ ویسی که تازه شروع شده را بخوابان.
  if (activeSeq !== seq) {
    audio.pause()
  }
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

  // unmount مالک، ویس خودش را قطع می‌کند؛ unmount غیرمالک اثری ندارد.
  useEffect(() => () => stopTts(idRef.current), [])

  return { status, play, stop }
}
