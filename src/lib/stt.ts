// Speech-to-text helpers shared by dictate and live voice.
//
// Two things used to make Persian (and every RTL language) transcribe badly:
//
//  1. No `language` hint in several paths — Whisper then auto-detects on a
//     short clip and returns transliterated/garbled words.
//  2. A FABRICATED `prompt` — Whisper does not read its prompt as an
//     instruction, it reads it as the text that came BEFORE this audio and
//     CONTINUES it. A polished sentence therefore comes back to the user as if
//     they had spoken it. See buildSttPrompt() below: there is no built-in
//     prompt any more, only the user's own glossary is ever sent.
//
// The WAV encoder is what makes chunk-by-chunk live transcription possible at
// all: raw PCM can be cut at any sample boundary and wrapped in a complete,
// valid WAV file, while a sliced webm/opus container cannot be decoded by the
// provider ("could not process file").

/** Sampling rate every STT request is normalised to. */
export const STT_SAMPLE_RATE = 16_000

/** Languages offered in Settings → Media Providers. '' means auto-detect. */
export const STT_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '', label: 'Auto (follow UI direction)' },
  { code: 'fa', label: 'Persian — فارسی' },
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'Arabic — العربية' },
  { code: 'tr', label: 'Turkish — Türkçe' },
  { code: 'az', label: 'Azerbaijani — Azərbaycanca' },
  { code: 'ur', label: 'Urdu — اردو' },
  { code: 'he', label: 'Hebrew — עברית' },
  { code: 'de', label: 'German — Deutsch' },
  { code: 'fr', label: 'French — Français' },
  { code: 'es', label: 'Spanish — Español' },
  { code: 'it', label: 'Italian — Italiano' },
  { code: 'ru', label: 'Russian — Русский' },
  { code: 'zh', label: 'Chinese — 中文' },
  { code: 'ja', label: 'Japanese — 日本語' },
  { code: 'hi', label: 'Hindi — हिन्दी' },
]

// There is deliberately NO built-in prompt. Until this fix every request
// carried a tidy sentence per language ("سلام، این یک پیام صوتی فارسی است.
// متن را با املای درست فارسی … بنویس."), on the theory that Whisper mirrors
// the style of its prompt. It does — by CONTINUING it. A two-second
// «سلام چطوری» came back as:
//
//   «چطوری؟ این یک پیام صوتی فارسی است. متن را با املای درست فارسی است.
//    نیمفاصله و علائم نگارشی بنویس. چطوری؟ خوبی»
//
// i.e. the model wrote our own sentence back to the user and dropped the
// audio. The same echo also explains "live voice sometimes types nothing":
// the echoed sentence deduped to nothing in mergeTranscripts(), so no new
// partial ever appeared. Removing the fabricated prompt is the fix; a word
// list (see buildSttPrompt) has no grammar to continue, so it biases spelling
// without giving the model a sentence it can keep writing.

/** Persian/Arabic script range — used to detect the language of typed text. */
const RTL_TEXT_RE = /[\u0600-\u06FF]/

/**
 * Resolve the STT `language` code.
 *
 * `explicit` (user setting) always wins. Otherwise Persian is assumed for an
 * RTL UI or when the composer already holds Persian script, because auto
 * detection on a 2-second clip is exactly what mangles short Persian turns.
 */
export function resolveSttLanguage(
  explicit: string | undefined,
  dir: string | undefined,
  typed?: string,
): string {
  const chosen = (explicit ?? '').trim().toLowerCase()
  if (chosen) return chosen
  if (typed && RTL_TEXT_RE.test(typed)) return 'fa'
  return dir === 'rtl' ? 'fa' : ''
}

/** Keep only the last `maxWords` words of a transcript (prompt context). */
function tailWords(text: string, maxWords: number, maxChars: number): string {
  const words = (text ?? '').trim().split(/\s+/).filter(Boolean)
  const tail = words.slice(Math.max(0, words.length - maxWords)).join(' ')
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail
}

/**
 * Build the Whisper `prompt` for a request.
 *
 * Whisper's prompt is BIASING CONTEXT, not an instruction: the model treats it
 * as text that preceded this audio and may continue it. That is why only the
 * user's own glossary is ever sent here — a word list has no sentence for the
 * model to keep writing, so it nudges spelling without being echoed back as
 * speech. When nothing is configured the prompt is omitted entirely; an absent
 * prompt is always safer than a fabricated one.
 *
 * `contextTail` is opt-in and must be REAL previously-transcribed speech. Live
 * voice deliberately does NOT pass it: chunk continuity is already handled by
 * the audio overlap plus mergeTranscripts(), and feeding the turn so far back
 * in made the model re-emit it instead of the new audio (a chunk that
 * re-recognized only old text merges to nothing, i.e. "it typed nothing").
 */
export function buildSttPrompt(
  lang: string,
  custom?: string,
  contextTail?: string,
): string {
  void lang
  const parts: string[] = []
  const own = (custom ?? '').trim()
  if (own) parts.push(tailWords(own, 60, 400))
  const tail = tailWords(contextTail ?? '', 25, 200)
  if (tail) parts.push(tail)
  return parts.join(' ').trim()
}

/** Minimum word run that counts as the prompt being echoed, not a coincidence. */
const MIN_ECHO_RUN = 5

/**
 * Comparison form of a word: punctuation, harakat, tatweel and the Arabic
 * look-alike letters are folded, so «فارسی،» and «فارسي» compare equal.
 */
function normalizeWord(word: string): string {
  return (word ?? '')
    .replace(/[\u064B-\u0652\u0670\u0640\u200c]/g, '')
    .replace(/[يىئ]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[\u060C\u061B\u061F«»"'`.,!?:;()\[\]{}…-]/g, '')
    .toLowerCase()
}

/**
 * Remove a prompt echo from a transcript.
 *
 * Even with the fabricated prompt gone, BIASING CONTEXT can still come back as
 * output: a provider may continue the glossary, or splice it into the middle of
 * the real words. Any run of at least MIN_ECHO_RUN consecutive words that also
 * occurs as a run inside the prompt is deleted. Requiring a 5-word run means a
 * short glossary (a name or two) can never eat a legitimate phrase by
 * coincidence, so this only ever fires on a real echo.
 */
export function stripSttPromptEcho(transcript: string, prompt?: string): string {
  const text = (transcript ?? '').trim()
  const ctx = (prompt ?? '').trim()
  if (!text || !ctx) return text
  const words = text.split(/\s+/).filter(Boolean)
  const echoed = ctx.split(/\s+/).map(normalizeWord).filter(Boolean)
  if (words.length < MIN_ECHO_RUN || echoed.length < MIN_ECHO_RUN) return text
  const norm = words.map(normalizeWord)
  const drop = new Array<boolean>(words.length).fill(false)
  for (let i = 0; i + MIN_ECHO_RUN <= words.length; i++) {
    if (drop[i]) continue
    let best = 0
    for (let j = 0; j < echoed.length; j++) {
      if (echoed[j] !== norm[i]) continue
      let n = 0
      while (
        i + n < words.length &&
        j + n < echoed.length &&
        echoed[j + n] === norm[i + n]
      ) {
        n++
      }
      if (n > best) best = n
    }
    if (best >= MIN_ECHO_RUN) {
      for (let n = 0; n < best; n++) drop[i + n] = true
      i += best - 1
    }
  }
  return words.filter((_, i) => !drop[i]).join(' ').trim()
}

/** Concatenate float PCM blocks into one contiguous buffer. */
export function concatFloat32(parts: ReadonlyArray<Float32Array>): Float32Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * Downsample mono float PCM to the STT rate with a box filter.
 *
 * Averaging the samples inside each output sample is a crude low-pass, but it
 * is exactly what a 48k → 16k speech feed needs and costs nothing. Never
 * upsamples: STT providers want 16 kHz, not more.
 */
export function downsampleFloat32(
  input: Float32Array,
  inRate: number,
  outRate: number = STT_SAMPLE_RATE,
): Float32Array {
  if (!input || input.length === 0) return input ?? new Float32Array(0)
  if (inRate <= 0 || outRate <= 0 || inRate === outRate || inRate < outRate) {
    return input
  }
  const ratio = inRate / outRate
  const kernel = decimationKernel(ratio)
  const half = (kernel.length - 1) >> 1
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLength)
  const total = input.length
  for (let i = 0; i < outLength; i++) {
    const centre = Math.round(i * ratio)
    let acc = 0
    let weight = 0
    for (let k = 0; k < kernel.length; k++) {
      const idx = centre + k - half
      if (idx < 0 || idx >= total) continue
      acc += kernel[k] * input[idx]
      weight += kernel[k]
    }
    // Edges see only part of the kernel: renormalise so a clip never fades in.
    out[i] = weight > 1e-6 ? acc / weight : (input[centre] ?? 0)
  }
  return out
}

/**
 * Low-pass FIR kernel applied before decimation.
 *
 * A box average (what this used to be) is a weak low-pass: everything above
 * the output Nyquist folds straight back into the speech band, and Persian
 * sibilants (/s/, /ʃ/) sit exactly in that folded band — the provider then
 * hears a lisping, hissing version of the word and returns a different word.
 * A Blackman-windowed sinc with its cutoff below the output Nyquist removes
 * that energy BEFORE any sample is dropped.
 */
export function decimationKernel(ratio: number): Float32Array {
  // Cutoff as a fraction of the INPUT rate: 0.45 of the output Nyquist leaves
  // a guard band for the filter's own transition.
  const fc = 0.45 / ratio
  const taps = Math.min(257, Math.max(9, Math.round(24 * ratio)) | 1)
  const half = (taps - 1) / 2
  const kernel = new Float32Array(taps)
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const n = i - half
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n)
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))
    kernel[i] = sinc * w
    sum += sinc * w
  }
  for (let i = 0; i < taps; i++) kernel[i] /= sum || 1
  return kernel
}

/** RMS below which a 20 ms window is treated as silence. */
export const SILENCE_RMS = 0.004

/** Result of {@link trimSilence}. */
export interface TrimmedPcm {
  pcm: Float32Array
  /** Milliseconds that actually contained signal (silence excluded). */
  speechMs: number
}

/**
 * Trim the silence around the speech in one chunk.
 *
 * Non-streaming ASR invents words when it is fed silence: a chunk that is 60%
 * pause regularly comes back with "thank you for watching" style filler, which
 * then merges into the user's sentence and reads as a wrong transcription.
 * Trimming also means the useful audio is not competing with dead air for the
 * model's attention.
 *
 * `padMs` is kept on both sides so the first and last phoneme is never clipped
 * — cutting exactly on the energy edge audibly truncates plosives.
 */
export function trimSilence(
  pcm: Float32Array,
  sampleRate: number = STT_SAMPLE_RATE,
  padMs = 120,
): TrimmedPcm {
  if (!pcm || pcm.length === 0) {
    return { pcm: pcm ?? new Float32Array(0), speechMs: 0 }
  }
  const win = Math.max(1, Math.floor((sampleRate * 20) / 1000))
  const total = pcm.length
  const windows = Math.floor(total / win)
  if (windows === 0) return { pcm, speechMs: 0 }
  const loud: boolean[] = []
  let speechWindows = 0
  for (let w = 0; w < windows; w++) {
    const start = w * win
    let sum = 0
    for (let i = start; i < start + win; i++) sum += pcm[i] * pcm[i]
    const voiced = Math.sqrt(sum / win) >= SILENCE_RMS
    loud.push(voiced)
    if (voiced) speechWindows++
  }
  if (speechWindows === 0) return { pcm: new Float32Array(0), speechMs: 0 }
  let first = 0
  while (first < windows && !loud[first]) first++
  let last = windows - 1
  while (last >= 0 && !loud[last]) last--
  const pad = Math.max(0, Math.floor((sampleRate * padMs) / 1000))
  const start = Math.max(0, first * win - pad)
  const end = Math.min(total, (last + 1) * win + pad)
  return { pcm: pcm.slice(start, end), speechMs: speechWindows * 20 }
}

/** Peak every clip is normalized to (≈ -1 dBFS, leaves int16 headroom). */
export const NORMALIZE_TARGET_PEAK = 0.89

/** Never amplify more than this: past ~18 dB the mic noise floor is speech. */
export const NORMALIZE_MAX_GAIN = 8

/**
 * Remove the DC offset and peak-normalize one PCM block.
 *
 * Provider accuracy is not level-independent: the same words recorded 20 dB
 * quieter come back with noticeably more word errors, and a quiet clip is the
 * one most likely to be mistaken for silence mid-sentence. Dictate and live
 * voice both hit microphones of wildly different gain (built-in array vs USB
 * interface, AGC on or off), so every clip is scaled to one fixed target peak
 * before it is sent.
 *
 * Gain is capped in both directions: a near-silent block (pure room noise) is
 * not blown up into something the model will try to transcribe, and an already
 * loud block is attenuated instead of clipping.
 */
export function normalizePeak(
  pcm: Float32Array,
  targetPeak: number = NORMALIZE_TARGET_PEAK,
  maxGain: number = NORMALIZE_MAX_GAIN,
): Float32Array {
  const n = pcm?.length ?? 0
  if (n === 0) return pcm ?? new Float32Array(0)
  let mean = 0
  for (let i = 0; i < n; i++) mean += pcm[i]
  mean /= n
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm[i] - mean)
    if (v > peak) peak = v
  }
  const out = new Float32Array(n)
  // A block that is flat after DC removal carries no signal at all: emitting
  // zeros is honest, and the silence gate upstream decides what to do with it.
  if (peak <= 0) return out
  const desired = targetPeak / peak
  const gain = desired < 1 ? desired : Math.min(desired, maxGain)
  for (let i = 0; i < n; i++) {
    const v = (pcm[i] - mean) * gain
    out[i] = v < -1 ? -1 : v > 1 ? 1 : v
  }
  return out
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/**
 * Mix decoded audio channels down to a single mono track.
 *
 * Dictate records with MediaRecorder, whose blob is webm/opus (or whatever the
 * platform offers) — a container some providers refuse to decode, which is how
 * a dictation can come back garbled or empty while the identical audio path in
 * live voice (which always sends 16 kHz mono WAV) works. `length` is the frame
 * count; it is passed explicitly because a multichannel buffer's channels are
 * all that long, and a channel shorter than the rest must not shift the mix.
 */
export function mixToMono(
  channels: ReadonlyArray<Float32Array>,
  length?: number,
): Float32Array {
  if (!channels || channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  let frames = length ?? 0
  if (!frames) {
    for (const ch of channels) frames = Math.max(frames, ch.length)
  }
  const out = new Float32Array(frames)
  for (const ch of channels) {
    const n = Math.min(frames, ch.length)
    for (let i = 0; i < n; i++) out[i] += ch[i]
  }
  const scale = 1 / channels.length
  for (let i = 0; i < frames; i++) out[i] *= scale
  return out
}

/**
 * Decode a recorded blob and re-encode it as 16 kHz mono WAV.
 *
 * Every STT request should carry the format providers decode most reliably.
 * Live voice already does (raw PCM -> WAV); dictate used to upload the raw
 * MediaRecorder container untouched, so the same voice could transcribe well
 * in one mode and badly in the other. Returns null when the blob cannot be
 * decoded, and the caller then sends the original bytes unchanged.
 */
export async function blobToWav16k(blob: Blob): Promise<Blob | null> {
  try {
    const Ctx =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    const raw = await blob.arrayBuffer()
    const ctx = new Ctx()
    try {
      const decoded = await ctx.decodeAudioData(raw)
      const channels: Float32Array[] = []
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        channels.push(decoded.getChannelData(c))
      }
      const mono = mixToMono(channels, decoded.length)
      const pcm = downsampleFloat32(mono, decoded.sampleRate, STT_SAMPLE_RATE)
      if (pcm.length === 0) return null
      // Same clean-up as a live chunk: dead air around the utterance is what
      // makes a non-streaming model invent filler words, and a quiet recording
      // is the single biggest accuracy loss for a non-streaming provider. When
      // nothing crosses the silence gate (a very quiet mic), the whole clip is
      // sent instead of an empty file.
      const trimmed = trimSilence(pcm, STT_SAMPLE_RATE)
      const voiced = trimmed.pcm.length > 0 ? trimmed.pcm : pcm
      return encodeWavPcm16(normalizePeak(voiced), STT_SAMPLE_RATE)
    } finally {
      try {
        void ctx.close()
      } catch {
        // Close is best-effort.
      }
    }
  } catch {
    // Undecodable container: the caller keeps the original blob.
    return null
  }
}

/**
 * Encode mono float PCM as a complete 16-bit WAV file.
 *
 * Every live chunk is a standalone, decodable file — that is the whole point:
 * the provider can transcribe chunk N without knowing about chunk N-1.
 */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number = STT_SAMPLE_RATE,
): Blob {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Stripped, lower-cased word used for overlap comparison. */
function compareWord(word: string): string {
  return word
    // Fold the Arabic look-alike letters and drop harakat/tatweel/ZWNJ before
    // comparing. Providers routinely return «ميروم» for one chunk and «میروم»
    // for the next (Arabic vs Persian yeh, with or without a half-space); the
    // raw strings differ, so the overlap is not recognised, both spellings are
    // kept and the user sees the same word twice — or, worse, a torn word that
    // failed to match is treated as new and appended.
    .replace(/[\u064B-\u0652\u0670\u0640\u200c]/g, '')
    .replace(/[يىئ]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[«»"'`،.,!؟?:;()\[\]{}…-]/g, '')
    .toLowerCase()
}

/**
 * Merge an incrementally transcribed chunk into the text committed so far.
 *
 * Chunks carry a small audio overlap so no word is ever cut in half, which
 * means consecutive transcripts repeat a few words. The overlap is matched
 * word-by-word (punctuation-insensitive) and only the new words are appended;
 * a chunk that re-recognized an already covered span adds nothing at all.
 */
export function mergeTranscripts(committed: string, next: string): string {
  const a = (committed ?? '').trim()
  const b = (next ?? '').trim()
  if (!b) return a
  if (!a) return b
  const aw = a.split(/\s+/).filter(Boolean)
  const bw = b.split(/\s+/).filter(Boolean)
  if (bw.length === 0) return a
  const maxOverlap = Math.min(aw.length, bw.length, 12)
  for (let n = maxOverlap; n > 0; n--) {
    let match = true
    for (let i = 0; i < n; i++) {
      if (compareWord(aw[aw.length - n + i]) !== compareWord(bw[i])) {
        match = false
        break
      }
    }
    if (match) {
      const rest = bw.slice(n).join(' ')
      return rest ? `${a} ${rest}` : a
    }
  }
  // The new chunk may be entirely inside what we already have (common when
  // the overlap covers the whole chunk on a slow reply).
  const aNorm = ` ${aw.map(compareWord).join(' ')} `
  const bNorm = bw.map(compareWord).join(' ')
  if (bNorm && aNorm.includes(` ${bNorm} `)) return a
  return `${a} ${b}`
}
